import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "../core/runtime.js";
import { dataDir } from "../core/config.js";
import { errorMessage, randomId, sleep, truncateMiddle } from "../core/util.js";
import { AGENTS, agentIds, type Access, type AgentId, type HubEvent } from "./agents.js";

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "paused";

export interface ChangedFile {
  path: string;
  status: string; // M modified, A added, D deleted, ?? untracked
  diff?: string;
}

export interface HubJob {
  id: string;
  agent: AgentId;
  task: string;
  cwd: string;
  access: Access;
  model?: string;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  sessionId: string | null;
  events: HubEvent[];
  final: string;
  changed: ChangedFile[];
  gitRepo: boolean;
  /** HEAD when the job started (changes are measured against it). */
  baseCommit?: string;
  /** Paths that already had uncommitted changes before the job. */
  baseDirty?: string[];
  logFile: string;
  note?: string;
  /** Id of the first run of this conversation; follow-up runs share it. */
  thread: string;
  /** When the conversation started (changes are attributed from here). */
  threadStartedAt: number;
  /** The agent's own session id, used to continue the conversation. */
  agentSession?: string;
  /** The message that started this run when it continues a conversation. */
  followUp?: string;
  /** Messages to send when the current run finishes. */
  queued: string[];
  /** Files earlier runs of this conversation changed (kept in this run's change list). */
  carried?: string[];
}

export interface AgentHealth {
  ok: boolean;
  detail: string;
  seconds: number;
  checkedAt: string;
  model?: string;
}

export interface HubConfig {
  models: Partial<Record<AgentId, string>>;
  maxConcurrent: number;
}

const MAX_EVENTS = 600;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const hubDir = () => path.join(dataDir(), "hub");

/**
 * Runs agent CLIs as background jobs through the ChatBridge executor, parses their JSON event
 * streams into a common timeline, and records which files each job changed.
 */
export class HubJobs {
  private jobs = new Map<string, HubJob>();
  private partial = new Map<string, string>();
  private rawTail = new Map<string, string[]>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly rt: Runtime) {
    mkdirSync(path.join(hubDir(), "jobs"), { recursive: true });
    mkdirSync(path.join(hubDir(), "logs"), { recursive: true });
    this.loadRecent();
  }

  config(): HubConfig {
    const f = path.join(hubDir(), "config.json");
    const defaults: HubConfig = { models: {}, maxConcurrent: 3 };
    if (!existsSync(f)) return defaults;
    try {
      return { ...defaults, ...JSON.parse(readFileSync(f, "utf8")) };
    } catch {
      return defaults;
    }
  }

  saveConfig(c: HubConfig) {
    writeFileSync(path.join(hubDir(), "config.json"), JSON.stringify(c, null, 2));
  }

  health(): Partial<Record<AgentId, AgentHealth>> {
    const f = path.join(hubDir(), "health.json");
    if (!existsSync(f)) return {};
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return {};
    }
  }

  private saveHealth(h: Partial<Record<AgentId, AgentHealth>>) {
    writeFileSync(path.join(hubDir(), "health.json"), JSON.stringify(h, null, 2));
  }

  modelFor(agent: AgentId, override?: string): string | undefined {
    return override || this.config().models[agent] || AGENTS[agent].defaultModel;
  }

  private loadRecent() {
    const dir = path.join(hubDir(), "jobs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-50);
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as HubJob;
        // Jobs saved before conversations existed are single-run conversations.
        j.thread ??= j.id;
        j.threadStartedAt ??= j.startedAt;
        j.queued ??= [];
        // A job that was running when the process died is no longer tracked.
        if (j.status === "running") {
          j.status = "failed";
          j.note = "ChatBridge restarted while this job was running";
          j.endedAt ??= Date.now();
        }
        this.jobs.set(j.id, j);
      } catch {
        /* skip corrupt */
      }
    }
  }

  private persist(j: HubJob) {
    writeFileSync(path.join(hubDir(), "jobs", `${j.id}.json`), JSON.stringify(j));
  }

  list(): HubJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): HubJob {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job ${id} (see agent_jobs)`);
    return j;
  }

  running(): HubJob[] {
    return this.list().filter((j) => j.status === "running");
  }

  async start(o: { agent: AgentId; task: string; cwd: string; access: Access; model?: string; timeoutMinutes?: number; continueFrom?: HubJob }): Promise<HubJob> {
    const def = AGENTS[o.agent];
    const prev = o.continueFrom;
    if (!def) throw new Error(`unknown agent ${o.agent}; choose one of ${agentIds().join(", ")}`);
    const launch = def.resolve();
    if (!launch) throw new Error(`${def.label} is not installed on this PC`);
    if (this.running().length >= this.config().maxConcurrent) throw new Error(`already ${this.running().length} agent jobs running (limit ${this.config().maxConcurrent}); wait or cancel one`);
    const st = await this.rt.executor.stat(o.cwd);
    if (!st?.isDirectory) throw new Error(`working directory not found: ${o.cwd}`);

    const id = `${new Date().toISOString().slice(5, 19).replace(/[-:T]/g, "")}-${o.agent}-${randomId("", 2)}`;
    const model = this.modelFor(o.agent, o.model);
    // Very long tasks go through a file so the command line stays short.
    let task = o.task;
    if (task.length > 6000) {
      const taskFile = path.join(hubDir(), "logs", `${id}-task.md`);
      writeFileSync(taskFile, task);
      task = `Your full task description is in the file ${taskFile}. Read it first, then complete the task.`;
    }
    const job: HubJob = {
      id,
      agent: o.agent,
      task: o.task,
      cwd: o.cwd,
      access: o.access,
      model,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      sessionId: null,
      events: [],
      final: "",
      changed: [],
      gitRepo: await this.isGitRepo(o.cwd),
      logFile: path.join(hubDir(), "logs", `${id}.log`),
      thread: prev?.thread ?? id,
      threadStartedAt: prev?.threadStartedAt ?? Date.now(),
      agentSession: prev?.agentSession,
      followUp: prev ? o.task : undefined,
      queued: [],
    };
    if (prev) {
      // Diffs of a follow-up are against the start of the whole conversation; its own window decides
      // which new files it touched, and files earlier runs changed are carried over.
      job.baseCommit = prev.baseCommit;
      job.carried = prev.changed.map((c) => c.path);
    } else if (job.gitRepo) {
      const head = await this.git(o.cwd, ["rev-parse", "HEAD"], 20, 0);
      if (head.code === 0) job.baseCommit = head.out.trim();
    }
    if (job.gitRepo) {
      const dirty = await this.git(o.cwd, ["diff", "--name-only", "HEAD"], 20, 0);
      if (dirty.code === 0) job.baseDirty = dirty.out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    this.jobs.set(id, job);
    this.persist(job);
    const runOpts = { cwd: o.cwd, access: o.access, model };
    let agentArgs: string[];
    if (prev && prev.agentSession && def.resumeArgs) agentArgs = def.resumeArgs(prev.agentSession, task, runOpts);
    else if (prev) {
      // No resumable session: start fresh but hand over what happened so far.
      agentArgs = def.args(`Earlier in this task you reported:\n${truncateMiddle(prev.final || "(no report)", 3000)}\n\nNew instruction from the user:\n${task}`, runOpts);
    } else agentArgs = def.args(task, runOpts);
    const argv = [launch.command, ...launch.prefix, ...agentArgs];
    appendFileSync(job.logFile, `# ${def.label} ${new Date().toISOString()}\n# cwd ${o.cwd}\n# argv ${JSON.stringify(argv.slice(0, -1))} <task>\n\n`);
    try {
      const snap = await this.rt.shells.run({ command: `${def.label}: ${o.task.slice(0, 80)}`, argv, cwd: o.cwd, yieldSeconds: 0, maxOutputChars: 5_000_000, label: `agent:${id}`, env: { NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" } });
      job.sessionId = snap.sessionId;
      this.feed(job, snap.output);
    } catch (err) {
      job.status = "failed";
      job.endedAt = Date.now();
      job.final = `failed to start: ${errorMessage(err)}`;
      this.persist(job);
      return job;
    }
    void this.pump(job);
    const limit = (o.timeoutMinutes ?? 60) * 60_000;
    this.timers.set(
      id,
      setTimeout(() => {
        if (job.status === "running") {
          job.note = `stopped after ${o.timeoutMinutes ?? 60} minutes (time limit)`;
          void this.cancel(id);
        }
      }, limit),
    );
    return job;
  }

  private feed(job: HubJob, text: string) {
    if (!text) return;
    appendFileSync(job.logFile, text);
    const buf = (this.partial.get(job.id) ?? "") + text;
    const lines = buf.split("\n");
    this.partial.set(job.id, lines.pop() ?? "");
    for (const line of lines) this.parseLine(job, line);
  }

  private parseLine(job: HubJob, line: string) {
    const t = line.trim();
    if (!t) return;
    let obj: any = null;
    // Agents sometimes print plain text and a JSON event on the same line ("Error: …{"type":"error",…}").
    const at = t.startsWith("{") ? 0 : t.indexOf('{"type"');
    if (at >= 0) {
      try {
        obj = JSON.parse(t.slice(at));
      } catch {
        obj = null;
      }
    }
    if (at > 0 && obj) this.parseLine(job, t.slice(0, at));
    if (!obj) {
      const tail = this.rawTail.get(job.id) ?? [];
      tail.push(t.slice(0, 500));
      if (tail.length > 40) tail.shift();
      this.rawTail.set(job.id, tail);
      return;
    }
    if (!job.agentSession) job.agentSession = AGENTS[job.agent].sessionFrom?.(obj);
    for (const ev of AGENTS[job.agent].parse(obj)) {
      if (!ev.text && !ev.paths?.length) continue;
      ev.ts = Date.now();
      job.events.push(ev);
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    }
  }

  private async pump(job: HubJob) {
    let lastPersist = 0;
    try {
      for (;;) {
        const snap = await this.rt.shells.read(job.sessionId!, 5, 5_000_000);
        this.feed(job, snap.output);
        if (Date.now() - lastPersist > 3000) {
          this.persist(job);
          lastPersist = Date.now();
        }
        if (!snap.running) {
          job.exitCode = snap.exitCode;
          break;
        }
      }
    } catch (err) {
      job.note = `lost track of the process: ${errorMessage(err)}`;
    }
    const rest = this.partial.get(job.id);
    if (rest) this.parseLine(job, rest);
    this.partial.delete(job.id);
    clearTimeout(this.timers.get(job.id));
    await this.finish(job);
  }

  private async finish(job: HubJob) {
    job.endedAt = Date.now();
    const done = [...job.events].reverse().find((e) => e.kind === "done");
    const lastMsg = [...job.events].reverse().find((e) => e.kind === "message");
    const errors = job.events.filter((e) => e.kind === "error");
    job.final = done?.text || lastMsg?.text || "";
    let status = job.status;
    if (job.status !== "cancelled" && job.status !== "paused") {
      const failed = (job.exitCode !== null && job.exitCode !== 0) || (errors.length > 0 && !job.final);
      status = failed ? "failed" : "done";
      if (failed && !job.final) {
        const raw = this.rawTail.get(job.id) ?? [];
        job.final = errors.at(-1)?.text || raw.slice(-8).join("\n") || `exited with code ${job.exitCode}`;
      }
    }
    this.rawTail.delete(job.id);
    try {
      job.changed = await this.changes(job);
    } catch (err) {
      job.note = `${job.note ? job.note + "; " : ""}could not compute changes: ${errorMessage(err)}`;
    }
    // Only now report the job as finished: anyone waiting on the status must also see its changed files.
    job.status = status;
    this.persist(job);
    // Instructions sent while the agent was busy go out as the next turn of the conversation.
    if (job.queued.length && (status === "done" || status === "failed")) {
      const text = job.queued.splice(0).join("\n\n");
      this.persist(job);
      await this.start({ agent: job.agent, task: text, cwd: job.cwd, access: job.access, model: job.model, continueFrom: job }).catch((err) => {
        job.note = `${job.note ? job.note + "; " : ""}could not send the queued instruction: ${errorMessage(err)}`;
        this.persist(job);
      });
    }
  }

  /** All runs of a conversation, oldest first. */
  threadRuns(thread: string): HubJob[] {
    return [...this.jobs.values()].filter((j) => (j.thread ?? j.id) === thread).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The newest run of the conversation a job belongs to. */
  latest(id: string): HubJob {
    const j = this.get(id);
    return this.threadRuns(j.thread ?? j.id).at(-1) ?? j;
  }

  /**
   * Sends the user's instruction into a conversation: continues it right away when the agent is idle,
   * queues it for the end of the current run, or (interrupt) stops the run and continues with it.
   */
  async message(id: string, text: string, interrupt = false): Promise<{ job: HubJob; delivered: "started" | "queued" }> {
    const last = this.latest(id);
    if (last.status === "running" && !interrupt) {
      last.queued.push(text);
      this.persist(last);
      return { job: last, delivered: "queued" };
    }
    if (last.status === "running") await this.cancel(last.id, true);
    const job = await this.start({ agent: last.agent, task: text, cwd: last.cwd, access: last.access, model: last.model, continueFrom: last });
    return { job, delivered: "started" };
  }

  /** Stops a run. pause=true keeps the conversation resumable (agent_message / agent_resume). */
  async cancel(id: string, pause = false): Promise<HubJob> {
    const job = this.latest(id);
    if (job.status !== "running") return job;
    job.status = pause ? "paused" : "cancelled";
    if (!pause) job.queued = [];
    if (job.sessionId) await this.rt.shells.kill(job.sessionId).catch(() => {});
    this.persist(job);
    return job;
  }

  // ------------------------------------------------------------------ change tracking
  private async git(cwd: string, args: string[], timeoutSeconds = 60, retries = 3): Promise<{ code: number | null; out: string }> {
    // --no-optional-locks: never contend with an agent that is still using the repository.
    const argv = ["git", "--no-optional-locks", "-c", "core.quotepath=false", "-c", "core.safecrlf=false", "-C", cwd, ...args];
    for (let attempt = 0; ; attempt++) {
      const r = await this.rt.shells.exec(`git ${args.join(" ")}`, { argv, cwd, timeoutSeconds, maxOutputChars: 2_000_000 });
      if (r.exitCode === 0 || attempt >= retries) return { code: r.exitCode, out: r.output };
      await sleep(1500 * (attempt + 1));
    }
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      const r = await this.git(cwd, ["rev-parse", "--is-inside-work-tree"], 20, 0);
      return r.code === 0 && r.out.trim() === "true";
    } catch {
      return false;
    }
  }

  private mtime(p: string): number {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async changes(job: HubJob): Promise<ChangedFile[]> {
    const since = job.startedAt - 2000;
    const reported = new Set(job.events.flatMap((e) => e.paths ?? []).map((p) => path.resolve(job.cwd, p)));
    const carried = new Set((job.carried ?? []).map((p) => path.resolve(job.cwd, p).toLowerCase()));
    const out: ChangedFile[] = [];
    if (job.gitRepo) {
      const root = path.resolve((await this.git(job.cwd, ["rev-parse", "--show-toplevel"], 20)).out.trim());
      // Compare against the commit recorded when the job started, so changes the agent committed itself still show.
      const base = job.baseCommit ?? EMPTY_TREE;
      const collect = async () => {
        const tracked = await this.git(root, ["diff", "--name-status", "--no-renames", base]);
        if (tracked.code !== 0) throw new Error(`git diff failed: ${tracked.out.trim().slice(0, 300)}`);
        const untracked = await this.git(root, ["ls-files", "--others", "--exclude-standard"]);
        const entries: Array<{ code: string; rel: string }> = [];
        for (const line of tracked.out.split("\n")) {
          const m = line.match(/^([A-Z])\t(.+)$/);
          if (m) entries.push({ code: m[1]!, rel: m[2]! });
        }
        for (const line of untracked.out.split("\n")) if (line.trim()) entries.push({ code: "??", rel: line.trim() });
        return entries;
      };
      let entries = await collect();
      // Some agents touch the repository while exiting; if nothing shows but the agent reported edits, look again.
      if (!entries.length && reported.size) {
        await sleep(2000);
        entries = await collect();
      }
      const seen = new Set<string>();
      for (const { code, rel } of entries) {
        const abs = path.resolve(root, rel);
        // Only attribute files touched during the job (pre-existing uncommitted edits are left out).
        const touched = carried.has(abs.toLowerCase()) || (code === "D" ? reported.has(abs) || !job.baseDirty?.includes(rel) : this.mtime(abs) >= since || reported.has(abs));
        if (!touched) continue;
        seen.add(abs.toLowerCase());
        const diff = code === "??" ? this.newFilePreview(abs) : (await this.git(root, ["diff", "--no-color", base, "--", rel])).out;
        out.push({ path: abs, status: code === "??" ? "??" : code, diff: truncateMiddle(diff, 60_000) });
        if (out.length >= 200) break;
      }
      if (!out.length && entries.length) {
        job.note = `${job.note ? job.note + "; " : ""}${entries.length} changed file(s) in git look older than this job (base ${base.slice(0, 8)}): ${entries.slice(0, 5).map((e) => `${e.code} ${e.rel} mtime ${new Date(this.mtime(path.resolve(root, e.rel))).toISOString()}`).join(", ")}; job started ${new Date(job.startedAt).toISOString()}`;
      } else if (!out.length) job.note = `${job.note ? job.note + "; " : ""}git shows no changes against ${base.slice(0, 8)}`;
      // Files the agent said it edited are always listed, even if git did not show them.
      for (const abs of reported) {
        if (seen.has(abs.toLowerCase()) || out.length >= 200) continue;
        if (!existsSync(abs)) out.push({ path: abs, status: "D" });
        else out.push({ path: abs, status: "M", diff: this.newFilePreview(abs) });
      }
      return out;
    }
    // Not a git repo: report files modified during the job.
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || out.length >= 200) return;
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (["node_modules", ".git", "__pycache__", ".venv", "dist", "build"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (this.mtime(p) >= since) out.push({ path: p, status: "M", diff: this.newFilePreview(p) });
      }
    };
    walk(job.cwd, 0);
    return out;
  }

  private newFilePreview(p: string): string {
    try {
      const buf = readFileSync(p);
      if (buf.includes(0)) return `(binary file, ${buf.length} bytes)`;
      const lines = buf.toString("utf8").split("\n").slice(0, 400);
      return lines.map((l) => `+${l}`).join("\n");
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------------ health checks
  async check(agent: AgentId, timeoutSeconds = 150): Promise<AgentHealth> {
    const def = AGENTS[agent];
    const started = Date.now();
    const record = (h: Omit<AgentHealth, "checkedAt" | "seconds">): AgentHealth => {
      const full = { ...h, seconds: Math.round((Date.now() - started) / 1000), checkedAt: new Date().toISOString() };
      const all = this.health();
      all[agent] = full;
      this.saveHealth(all);
      return full;
    };
    const launch = def.resolve();
    if (!launch) return record({ ok: false, detail: "not installed" });
    const model = this.modelFor(agent);
    const dir = path.join(hubDir(), "check");
    mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + timeoutSeconds * 1000;
    const attempt = async () => {
      const j = await this.start({ agent, task: "Reply with exactly: HUB-OK", cwd: dir, access: "read", model, timeoutMinutes: Math.ceil(timeoutSeconds / 60) });
      while (j.status === "running" && Date.now() < deadline) await sleep(1000);
      if (j.status === "running") await this.cancel(j.id);
      return j;
    };
    let job = await attempt();
    // Quick failures are often transient (e.g. Kilo's model catalog not loaded yet): try once more.
    if (job.status === "failed" && (job.endedAt ?? 0) - job.startedAt < 45_000 && !/usage limit|not logged in|login|Ineligible/i.test(job.final)) job = await attempt();
    const text = [job.final, ...job.events.map((e) => e.text)].join("\n");
    const ok = /HUB-OK/.test(job.final) || job.events.some((e) => (e.kind === "message" || e.kind === "done") && /HUB-OK/.test(e.text));
    const failText = job.final || text || "no response";
    // Lead with the line that explains the failure (CLIs often print a stack or JSON around it).
    const reason = failText.split("\n").find((l) => /error|limit|log ?in|not found|denied|quota|ineligible/i.test(l))?.trim();
    return record({ ok, model, detail: ok ? "responded correctly" : truncateMiddle(reason && reason !== failText.trim() ? `${reason}\n${failText}` : failText, 400) });
  }

  /** Short human summary of a job for tool results. */
  summarize(j: HubJob, lastEvents = 12): string {
    const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
    const lines = [
      `job ${j.id} · ${AGENTS[j.agent].label}${j.model ? ` (${j.model})` : ""} · ${j.status} · ${secs}s · cwd ${j.cwd}`,
      ...(j.note ? [`note: ${j.note}`] : []),
    ];
    const evs = j.events.filter((e) => e.kind !== "thinking").slice(-lastEvents);
    if (evs.length) lines.push("", "recent activity:", ...evs.map((e) => `  ${ICON[e.kind]} ${truncateMiddle(e.text.replace(/\s+/g, " "), 240)}`));
    if (j.status !== "running") {
      lines.push("", `result:\n${truncateMiddle(j.final || "(no final message)", 6000)}`);
      if (j.changed.length) lines.push("", `changed files (${j.changed.length}):`, ...j.changed.slice(0, 40).map((c) => `  ${c.status.padEnd(2)} ${c.path}`));
      else lines.push("", "no file changes detected");
    }
    return lines.join("\n");
  }
}

export const ICON: Record<HubEvent["kind"], string> = { message: "💬", thinking: "·", command: "$", tool: "⚙", file: "✎", error: "✗", info: "ℹ", done: "✓" };
