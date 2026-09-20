import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent, type AgentOptions, type TurnResult } from "./agent.js";
import { kestrelHome, loadKestrelConfig, resolveProfile, type KestrelConfig } from "./config.js";
import { createProvider, FallbackProvider } from "./providers/index.js";
import type { ModelProvider } from "./providers/types.js";
import { environmentSummary } from "./prompt.js";
import { nextRun } from "./schedule.js";
import { SkillLibrary } from "./skills.js";
import { KestrelStore, type Job } from "./store.js";
import { builtinTools, type AgentTool } from "./tools.js";
import { createRuntime, type Runtime } from "../core/runtime.js";
import { findCodexBinary } from "../core/execServer.js";
import type { Logger } from "../core/logger.js";
import { AsyncQueue, errorMessage, randomId, truncateMiddle } from "../core/util.js";

export interface BackgroundTask {
  id: string;
  prompt: string;
  sessionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  events: Array<{ ts: string; kind: string; text: string }>;
  controller: AbortController;
}

export type Notifier = (title: string, body: string, source: string) => Promise<void>;

export interface ServiceOptions {
  home?: string;
  config?: KestrelConfig;
  runtime?: Runtime;
  provider?: ModelProvider;
  auxProvider?: ModelProvider;
  profile?: string;
  logger?: Logger;
}

/**
 * Process-wide Kestrel services shared by every surface (CLI, web UI, Telegram, MCP bridge,
 * scheduler): runtime/executor, store, skills, model providers, background tasks, notifications.
 */
export class KestrelService {
  readonly home: string;
  readonly config: KestrelConfig;
  readonly store: KestrelStore;
  readonly skills: SkillLibrary;
  readonly tools: AgentTool[];
  provider: ModelProvider;
  auxProvider: ModelProvider;
  schedulerRunning = false;
  private notifiers: Notifier[] = [];
  private tasks = new Map<string, BackgroundTask>();
  private envCache: string | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private runningJobs = new Set<string>();
  private ownsRuntime: boolean;

  private constructor(
    readonly rt: Runtime,
    opts: ServiceOptions,
    home: string,
    config: KestrelConfig,
  ) {
    this.home = home;
    this.config = config;
    this.ownsRuntime = !opts.runtime;
    this.store = new KestrelStore(path.join(home, "kestrel.db"));
    this.skills = new SkillLibrary(path.join(home, "skills"));
    const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
    this.skills.installBundled(bundled);
    this.tools = builtinTools();
    // Memory/skills/jobs stay usable even when no model is configured yet.
    this.provider = opts.provider ?? safeProvider(() => this.buildProvider(opts.profile ?? config.defaultProfile));
    this.auxProvider =
      opts.auxProvider ??
      (opts.provider ? opts.provider : config.auxiliaryProfile ? safeProvider(() => createProvider(resolveProfile(config, config.auxiliaryProfile!), config.auxiliaryProfile)) : this.provider);
  }

  static async create(opts: ServiceOptions = {}): Promise<KestrelService> {
    const home = opts.home ?? kestrelHome();
    const config = opts.config ?? loadKestrelConfig(home);
    const rt = opts.runtime ?? (await createRuntime({ logger: opts.logger, scope: "kestrel" }));
    return new KestrelService(rt, opts, home, config);
  }

  buildProvider(profileName: string): ModelProvider {
    const names = [profileName, ...this.config.fallbackProfiles.filter((n) => n !== profileName)];
    const chain: ModelProvider[] = [];
    const errors: string[] = [];
    for (const n of names) {
      try {
        chain.push(createProvider(resolveProfile(this.config, n), n));
      } catch (err) {
        errors.push(`${n}: ${errorMessage(err)}`);
      }
    }
    if (!chain.length) throw new Error(`no usable model profile:\n  ${errors.join("\n  ")}`);
    if (chain.length === 1) return chain[0]!;
    return new FallbackProvider(chain, (from, to, err) => this.rt.logger.warn(`model ${from.name} failed (${errorMessage(err).slice(0, 200)}); switching to ${to.name}`));
  }

  setProfile(name: string) {
    this.provider = this.buildProvider(name);
    if (!this.config.auxiliaryProfile) this.auxProvider = this.provider;
  }

  async environment(): Promise<string> {
    if (!this.envCache) {
      try {
        this.envCache = environmentSummary(await this.rt.desktop.systemInfo());
      } catch {
        this.envCache = environmentSummary({ executor: await this.rt.executor.info().catch(() => ({})) });
      }
    }
    return this.envCache;
  }

  createAgent(opts: AgentOptions = {}): Agent {
    return new Agent(this, opts);
  }

  // ------------------------------------------------------------------ notifications
  addNotifier(n: Notifier) {
    this.notifiers.push(n);
  }

  async notify(title: string, body: string, source: string, channels: "inbox" | "telegram" | "both" = "both") {
    if (channels !== "telegram") this.store.addInbox(title, body, source);
    if (channels !== "inbox") {
      for (const n of this.notifiers) await n(title, body, source).catch((err) => this.rt.logger.warn(`notifier failed: ${errorMessage(err)}`));
    }
  }

  // ------------------------------------------------------------------ sub-agents
  async runSubagents(parent: Agent, tasks: Array<{ goal: string; context?: string; toolsets?: string[] }>, signal: AbortSignal): Promise<string> {
    if (parent.depth >= 2) return "Error: maximum delegation depth reached; do the work directly.";
    const queue = new AsyncQueue(this.config.agent.maxParallelSubagents);
    const defaultSets = this.config.agent.toolsets.filter((t) => t !== "schedule" && (parent.depth + 1 < 2 || t !== "delegation"));
    const reports = await Promise.all(
      tasks.map((t, i) =>
        queue.run(async () => {
          const child = this.createAgent({
            parentId: parent.sessionId,
            source: "subagent",
            depth: parent.depth + 1,
            cwd: parent.cwd,
            toolsets: t.toolsets ? t.toolsets.filter((x) => defaultSets.includes(x as any)) : defaultSets,
            maxIterations: this.config.agent.subagentMaxIterations,
            title: `sub ${i + 1}: ${t.goal.slice(0, 50)}`,
          });
          const prompt = `${t.goal}${t.context ? `\n\nContext from the parent agent:\n${t.context}` : ""}\n\nWhen finished, reply with a concise report: outcome, key findings/changes (with paths), and anything left undone.`;
          try {
            const r = await child.runTurn(prompt, { signal });
            return `### Sub-agent ${i + 1} (${child.sessionId}, ${r.stopped}, ${r.toolCalls} tool calls)\n${truncateMiddle(r.text || "(no report)", 6000)}`;
          } catch (err) {
            return `### Sub-agent ${i + 1} failed\n${errorMessage(err)}`;
          }
        }),
      ),
    );
    return reports.join("\n\n");
  }

  // ------------------------------------------------------------------ codex delegation
  async codexDelegate(task: string, cwd: string, sandbox: string, timeoutSeconds: number): Promise<string> {
    const bin = findCodexBinary(this.rt.config.executor.codexPath);
    if (!bin) throw new Error("codex CLI not installed");
    const outFile = path.join(this.home, "tmp", `codex-${randomId("", 5)}.md`);
    await this.rt.executor.createDirectory(path.dirname(outFile));
    let prompt = task;
    if (task.length > 12_000) {
      const taskFile = outFile.replace(/\.md$/, "-task.md");
      writeFileSync(taskFile, task);
      prompt = `Read the full task description from ${taskFile} and complete it.`;
    }
    const r = await this.rt.shells.exec("codex exec", {
      argv: [bin, "exec", "--skip-git-repo-check", "--sandbox", sandbox, "--color", "never", "-C", cwd, "-o", outFile, prompt],
      cwd,
      timeoutSeconds,
      maxOutputChars: 8000,
    });
    const last = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    if (r.timedOut) return `Codex timed out after ${timeoutSeconds}s. Partial log:\n${truncateMiddle(r.output, 4000)}`;
    return `Codex finished (exit ${r.exitCode}).\n\nFinal report:\n${last || "(none)"}\n\nLog tail:\n${truncateMiddle(r.output, 3000)}`;
  }

  // ------------------------------------------------------------------ background tasks (MCP / web)
  startTask(prompt: string, opts: { sessionId?: string; source?: string; toolsets?: string[] } = {}): BackgroundTask {
    const task: BackgroundTask = {
      id: randomId("task_", 5),
      prompt,
      sessionId: null,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      result: null,
      events: [],
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    const push = (kind: string, text: string) => {
      task.events.push({ ts: new Date().toISOString(), kind, text });
      if (task.events.length > 400) task.events.splice(0, task.events.length - 400);
    };
    void (async () => {
      try {
        const agent = this.createAgent({ sessionId: opts.sessionId, source: opts.source ?? "mcp", toolsets: opts.toolsets });
        task.sessionId = agent.sessionId;
        const r = await agent.runTurn(prompt, {
          signal: task.controller.signal,
          onEvent: (e) => {
            if (e.type === "tool_start") push("tool", `${e.name} ${truncateMiddle(e.args, 200)}`);
            else if (e.type === "tool_end") push(e.ok ? "tool_ok" : "tool_error", `${e.name}: ${e.preview.slice(0, 200)}`);
            else if (e.type === "assistant" && e.text) push("assistant", truncateMiddle(e.text, 600));
            else if (e.type === "info" || e.type === "error") push(e.type, e.message);
          },
        });
        task.result = r.text;
        task.status = r.stopped === "aborted" ? "cancelled" : r.stopped === "error" ? "failed" : "completed";
      } catch (err) {
        task.result = errorMessage(err);
        task.status = "failed";
      } finally {
        task.endedAt = new Date().toISOString();
      }
    })();
    return task;
  }

  getTask(id: string) {
    return this.tasks.get(id) ?? null;
  }

  listTasks() {
    return [...this.tasks.values()].map(({ controller: _c, events, ...t }) => ({ ...t, eventCount: events.length }));
  }

  cancelTask(id: string) {
    const t = this.tasks.get(id);
    if (!t) return false;
    t.controller.abort();
    return true;
  }

  // ------------------------------------------------------------------ scheduler
  startScheduler() {
    if (this.schedulerTimer) return;
    this.schedulerRunning = true;
    // Jobs missed while offline run once at startup, then follow their schedule.
    const tick = () => void this.tick().catch((err) => this.rt.logger.error(`scheduler: ${errorMessage(err)}`));
    this.schedulerTimer = setInterval(tick, this.config.scheduler.tickSeconds * 1000);
    tick();
  }

  stopScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    this.schedulerRunning = false;
  }

  async tick(now = new Date()) {
    for (const job of this.store.dueJobs(now)) {
      if (this.runningJobs.has(job.id)) continue;
      const conditions = safeJson(job.conditions);
      if (conditions.gpuIdleBelow && !(await this.gpuIdle(Number(conditions.gpuIdleBelow)))) {
        this.store.updateJob(job.id, { nextRunAt: new Date(now.getTime() + 5 * 60_000).toISOString(), lastStatus: "deferred: GPU busy" });
        continue;
      }
      void this.runJob(job);
    }
  }

  private async gpuIdle(threshold: number): Promise<boolean> {
    const info = await this.rt.desktop.systemInfo().catch(() => ({}) as any);
    const gpus: any[] = info.gpus ?? [];
    if (!gpus.length) return true;
    return gpus.every((g) => Number(String(g.util).replace(/[^\d.]/g, "")) < threshold);
  }

  async runJob(job: Job): Promise<TurnResult | null> {
    this.runningJobs.add(job.id);
    const started = new Date();
    const next = nextRun(job.schedule, started, started);
    this.store.updateJob(job.id, { lastRunAt: started.toISOString(), nextRunAt: next?.toISOString() ?? null, lastStatus: "running", enabled: next ? job.enabled : false });
    let runId = 0;
    try {
      const agent = this.createAgent({
        source: `job:${job.id}`,
        title: `⏰ ${job.name}`,
        provider: job.profile ? this.buildProvider(job.profile) : undefined,
        extraSystem: `# Scheduled run\nThis is an unattended scheduled task "${job.name}" (${job.schedule}). Nobody is watching live: do the work, then end with a concise result report (it is delivered to the owner). Use notify_user only for urgent extra alerts.`,
      });
      runId = this.store.startJobRun(job.id, agent.sessionId);
      const r = await agent.runTurn(job.prompt);
      const status = r.stopped === "completed" ? "ok" : r.stopped;
      this.store.finishJobRun(runId, status, r.text);
      this.store.updateJob(job.id, { lastStatus: status });
      await this.notify(`⏰ ${job.name}`, r.text || "(no output)", `job:${job.id}`, job.deliver as any);
      if (this.config.agent.autoReflect) await agent.reflect().catch(() => {});
      return r;
    } catch (err) {
      const msg = errorMessage(err);
      if (runId) this.store.finishJobRun(runId, "error", msg);
      this.store.updateJob(job.id, { lastStatus: `error: ${msg.slice(0, 200)}` });
      await this.notify(`⏰ ${job.name} failed`, msg, `job:${job.id}`, job.deliver as any);
      return null;
    } finally {
      this.runningJobs.delete(job.id);
    }
  }

  async close() {
    this.stopScheduler();
    for (const t of this.tasks.values()) t.controller.abort();
    this.store.close();
    if (this.ownsRuntime) await this.rt.close();
  }
}

class UnavailableProvider implements ModelProvider {
  readonly name = "unavailable";
  readonly model = "none";
  readonly contextWindow = 100_000;
  readonly supportsImages = false;
  constructor(private readonly reason: string) {}
  async complete(): Promise<never> {
    throw new Error(`no model available: ${this.reason}. Configure a profile with \`kestrel setup\` or edit ${path.join(kestrelHome(), "config.json")}`);
  }
}

function safeProvider(make: () => ModelProvider): ModelProvider {
  try {
    return make();
  } catch (err) {
    return new UnavailableProvider(errorMessage(err));
  }
}

function safeJson(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export type { AgentEvent };
