#!/usr/bin/env node
import { isEntryPoint } from "../core/entry.js";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { flagNumber, flagString, parseArgs, type ParsedArgs } from "../core/args.js";
import { createLogger } from "../core/logger.js";
import { errorMessage, randomToken, sha256, truncateMiddle } from "../core/util.js";
import { findCodexBinary } from "../core/execServer.js";
import type { Agent, AgentEvent } from "./agent.js";
import { KestrelConfigSchema, kestrelHome, loadKestrelConfig, resolveProfile, saveKestrelConfig, type KestrelConfig } from "./config.js";
import { createProvider, PRESETS } from "./providers/index.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import { KestrelService } from "./service.js";

const HELP = `kestrel — autonomous agent that lives on this PC

  kestrel                          Interactive chat (same as \`kestrel chat\`)
  kestrel chat [--session ID] [--profile NAME]
  kestrel run "task" [--profile NAME] [--session ID] [--json]
  kestrel daemon [--no-web] [--no-telegram] [--no-scheduler]
                                   Scheduler + web UI (http://127.0.0.1:8787) + Telegram gateway
  kestrel setup [--default NAME]   Detect model backends (Codex login, NVIDIA NIM, Anthropic, OpenAI, Ollama)
  kestrel doctor                   Test every configured model profile and the executor
  kestrel web-url                  Print a login URL for the web UI

  kestrel memory list|search <q>|add <text> [--kind K] [--importance 0.8]|forget <id>
  kestrel profile [set <key> <value> | delete <key>]
  kestrel skills list|show <name>|delete <name>|rollback <name>
  kestrel sessions list|show <id>|delete <id>|export [--out file.jsonl]
  kestrel jobs list|add --name N --schedule S --prompt P|remove <id>|pause <id>|resume <id>|run <id>
  kestrel inbox [--all]

Chat commands: /help /new /sessions /resume ID /model NAME /memory [q] /skills [q] /todo
               /undo [ID] /checkpoints /reflect /compact /usage /jobs /inbox /cwd PATH /exit`;

const tty = process.stdout.isTTY;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[39m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[39m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[39m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[39m` : s),
};
const out = (s = "") => process.stdout.write(s + "\n");
const err = (s = "") => process.stderr.write(s + "\n");

function argPreview(name: string, raw: string): string {
  try {
    const a = JSON.parse(raw);
    const main = a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.name ?? a.goal ?? a.task ?? a.action ?? "";
    if (name === "delegate_tasks") return `${a.tasks?.length ?? 0} sub-task(s)`;
    return truncateMiddle(String(main).replace(/\s+/g, " "), 100);
  } catch {
    return truncateMiddle(raw, 100);
  }
}

/** Renders agent events for a terminal. Streaming text goes to `write`, activity to stderr-style lines. */
export function terminalRenderer(write: (s: string) => void = (s) => process.stdout.write(s)) {
  let midLine = false;
  const line = (s: string) => {
    if (midLine) write("\n");
    midLine = false;
    write(s + "\n");
  };
  return (e: AgentEvent) => {
    switch (e.type) {
      case "text":
        write(e.delta);
        midLine = !e.delta.endsWith("\n");
        break;
      case "tool_start":
        line(c.dim(`  ⚙ ${e.name} ${argPreview(e.name, e.args)}`));
        break;
      case "tool_end":
        line(c.dim(`    ${e.ok ? c.green("✓") : c.red("✗")} ${(e.durationMs / 1000).toFixed(1)}s${e.ok ? "" : ` ${e.preview.split("\n")[0]!.slice(0, 160)}`}`));
        break;
      case "compaction":
        line(c.yellow(`  ⟲ context compacted (${e.beforeTokens} → ${e.afterTokens} tokens)`));
        break;
      case "reflection":
        line(c.cyan(`  ✦ learned: ${e.memories} memor${e.memories === 1 ? "y" : "ies"}${e.skill ? `, new skill "${e.skill}"` : ""}`));
        break;
      case "info":
        line(c.dim(`  ℹ ${e.message}`));
        break;
      case "error":
        line(c.red(`  ✗ ${e.message}`));
        break;
      case "turn_end":
        if (midLine) write("\n");
        midLine = false;
        if (e.stopped !== "completed") line(c.yellow(`  (${e.stopped})`));
        break;
    }
  };
}

async function service(a: ParsedArgs, logLevel: "warn" | "info" = "warn") {
  return KestrelService.create({ profile: flagString(a, "profile"), logger: createLogger((process.env.LOG_LEVEL as any) ?? logLevel, "kestrel") });
}

async function cmdChat(a: ParsedArgs) {
  const s = await service(a);
  let agent: Agent = s.createAgent({ sessionId: flagString(a, "session"), source: "cli" });
  out(c.bold(`${s.config.agent.name}`) + c.dim(` · model ${s.provider.name}/${s.provider.model} · session ${agent.sessionId} · ${s.store.countMemories()} memories · ${s.skills.list().length} skills`));
  out(c.dim("Type /help for commands. Ctrl+C interrupts a running turn."));
  const unread = s.store.listInbox(true, 5);
  if (unread.length) out(c.cyan(`📬 ${unread.length} unread inbox item(s) — /inbox`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 500 });
  let controller: AbortController | null = null;
  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (controller) {
      controller.abort();
      out(c.yellow("\n  interrupting…"));
      return;
    }
    if (Date.now() - lastSigint < 1500) {
      rl.close();
      return;
    }
    lastSigint = Date.now();
    out(c.dim("\n(press Ctrl+C again to exit)"));
    rl.prompt();
  });

  const render = terminalRenderer();
  const prompt = () => {
    rl.setPrompt(c.bold(c.cyan("› ")));
    rl.prompt();
  };
  let buffer: string[] = [];

  const handleSlash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        out(HELP.split("Chat commands:")[1] ? `Chat commands:${HELP.split("Chat commands:")[1]}` : HELP);
        return true;
      case "exit":
      case "quit":
        rl.close();
        return true;
      case "new":
        if (s.config.agent.autoReflect) void agent.reflect().catch(() => {});
        agent = s.createAgent({ source: "cli" });
        out(c.dim(`new session ${agent.sessionId}`));
        return true;
      case "sessions":
        for (const x of s.store.listSessions({ limit: 15 })) out(`${c.cyan(x.id)} ${x.updatedAt.slice(0, 16)} ${c.dim(`[${x.source}, ${x.messages} msgs]`)} ${x.title}`);
        return true;
      case "resume": {
        const found = s.store.findSession(arg);
        if (!found) out(c.red(`no unique session matching "${arg}"`));
        else {
          agent = s.createAgent({ sessionId: found.id, source: "cli" });
          out(c.dim(`resumed ${found.id}: ${found.title} (${agent.history.length} messages in context)`));
        }
        return true;
      }
      case "model":
        if (!arg) out(`current: ${s.provider.name}/${s.provider.model}; profiles: ${[...new Set([...Object.keys(s.config.profiles), ...Object.keys(PRESETS)])].join(", ")}`);
        else {
          s.setProfile(arg);
          agent = s.createAgent({ sessionId: agent.sessionId, source: "cli" });
          out(c.dim(`model → ${s.provider.name}/${s.provider.model}`));
        }
        return true;
      case "memory": {
        const list = arg ? s.store.searchMemories(arg, 20) : s.store.listMemories({ limit: 30 });
        for (const m of list) out(`${c.dim(`#${m.id}`)} ${c.yellow(m.kind.padEnd(11))} ${m.content}`);
        if (!list.length) out(c.dim("(no memories)"));
        return true;
      }
      case "skills": {
        const list = arg ? s.skills.search(arg, 20) : s.skills.list();
        for (const k of list) out(`${c.cyan(k.name)} ${c.dim(`v${k.version} ${k.uses ? `${k.successes}/${k.uses}` : ""}`)} — ${k.description}`);
        if (!list.length) out(c.dim("(no skills)"));
        return true;
      }
      case "todo":
        out(agent.renderTodos());
        return true;
      case "checkpoints":
        for (const cp of agent.checkpoints.list()) out(`${c.cyan(String(cp.id))} ${cp.createdAt.slice(11, 19)} ${cp.label} ${c.dim(`(${cp.files.length} files)`)}`);
        return true;
      case "undo": {
        try {
          const r = await agent.checkpoints.undo(s.rt.executor, arg ? Number(arg) : undefined);
          out(c.green(`restored ${r.restored.length} file(s):`) + "\n" + r.restored.map((f) => `  ${f}`).join("\n"));
        } catch (e) {
          out(c.red(errorMessage(e)));
        }
        return true;
      }
      case "reflect": {
        const r = await agent.reflect({ force: true });
        out(c.cyan(`learned ${r.memories} memories, ${r.profile} profile facts${r.skill ? `, skill "${r.skill}"` : ""}`));
        return true;
      }
      case "compact":
        out((await agent.compact("", true)) ? c.dim("compacted") : c.dim("nothing to compact"));
        return true;
      case "usage":
        for (const u of s.store.usageSummary(agent.sessionId)) out(`${u.provider}/${u.model}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens`);
        return true;
      case "jobs":
        for (const j of s.store.listJobs()) out(`${c.cyan(j.id)} ${j.enabled ? "▶" : "⏸"} ${j.name} — ${describeSchedule(j.schedule)} ${c.dim(`next ${j.nextRunAt ?? "-"} last ${j.lastStatus ?? "-"}`)}`);
        return true;
      case "inbox":
        for (const i of s.store.listInbox(false, 10)) out(`${i.read ? " " : c.cyan("●")} ${i.created_at.slice(0, 16)} ${c.bold(i.title)}\n${truncateMiddle(i.body, 800)}\n`);
        s.store.markInboxRead();
        return true;
      case "cwd":
        if (arg) agent.cwd = agent.resolvePath(arg);
        out(agent.cwd);
        return true;
      default:
        out(c.red(`unknown command /${cmd}`));
        return true;
    }
  };

  rl.on("line", async (raw) => {
    if (controller) return; // ignore typing while running
    if (raw.endsWith("\\")) {
      buffer.push(raw.slice(0, -1));
      rl.setPrompt(c.dim("… "));
      rl.prompt();
      return;
    }
    const input = [...buffer, raw].join("\n").trim();
    buffer = [];
    if (!input) return prompt();
    if (input.startsWith("/")) {
      await handleSlash(input).catch((e) => out(c.red(errorMessage(e))));
      return prompt();
    }
    controller = new AbortController();
    rl.pause();
    try {
      await agent.runTurn(input, { signal: controller.signal, onEvent: render });
    } catch (e) {
      out(c.red(errorMessage(e)));
    } finally {
      controller = null;
      rl.resume();
      out();
      prompt();
    }
  });
  rl.on("close", async () => {
    out(c.dim("bye"));
    if (s.config.agent.autoReflect && agent.history.length > 2) {
      out(c.dim("saving what I learned…"));
      await agent.reflect().catch(() => {});
    }
    await s.close();
    process.exit(0);
  });
  prompt();
}

async function cmdRun(a: ParsedArgs) {
  const task = a._.slice(1).join(" ").trim() || (!process.stdin.isTTY ? await readStdin() : "");
  if (!task) throw new Error('usage: kestrel run "task"');
  const s = await service(a);
  const agent = s.createAgent({ sessionId: flagString(a, "session"), source: "cli-run", maxIterations: flagNumber(a, "max-iterations") });
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const json = !!a.flags.json;
  const render = terminalRenderer((x) => process.stderr.write(x));
  const r = await agent.runTurn(task, { signal: controller.signal, onEvent: json ? undefined : render });
  if (json) out(JSON.stringify({ sessionId: r.sessionId, stopped: r.stopped, iterations: r.iterations, toolCalls: r.toolCalls, text: r.text }, null, 2));
  else if (!process.stderr.isTTY || !process.stdout.isTTY) out(r.text);
  if (s.config.agent.autoReflect) await agent.reflect().catch(() => {});
  await s.close();
  process.exitCode = r.stopped === "completed" ? 0 : 1;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

async function cmdDaemon(a: ParsedArgs) {
  const s = await service(a, "info");
  const log = s.rt.logger;
  const cfg = s.config;
  if (a.flags.scheduler !== false && cfg.scheduler.enabled) {
    s.startScheduler();
    log.info(`scheduler running (${s.store.listJobs().filter((j) => j.enabled).length} active jobs)`);
  }
  let web: { close(): Promise<void>; url: string } | null = null;
  if (a.flags.web !== false) {
    const { startWebUi } = await import("./web.js");
    web = await startWebUi(s);
    log.info(`web UI ${web.url} (run \`kestrel web-url\` for a login link)`);
  }
  let tg: { stop(): void } | null = null;
  if (a.flags.telegram !== false && cfg.telegram.enabled) {
    const { startTelegram } = await import("./telegram.js");
    try {
      tg = startTelegram(s);
    } catch (e) {
      log.warn(`Telegram gateway not started: ${errorMessage(e)}`);
    }
  }
  const shutdown = async () => {
    log.info("stopping");
    tg?.stop();
    await web?.close();
    await s.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function detectOllama(): Promise<string | null> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    const data: any = await r.json();
    return data.models?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function cmdSetup(a: ParsedArgs) {
  const home = kestrelHome();
  const cfg: KestrelConfig = existsSync(path.join(home, "config.json")) ? loadKestrelConfig(home) : KestrelConfigSchema.parse({});
  const found: string[] = [];
  if (findCodexBinary()) {
    cfg.profiles.codex ??= { ...PRESETS.codex! } as any;
    found.push("codex (ChatGPT subscription via Codex CLI)");
  }
  if (process.env.NVIDIA_API_KEY) {
    cfg.profiles.nim ??= { ...PRESETS.nim! } as any;
    found.push(`nim (NVIDIA NIM, ${PRESETS.nim!.model})`);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    cfg.profiles.anthropic ??= { ...PRESETS.anthropic! } as any;
    found.push("anthropic (claude-opus-5)");
  }
  if (process.env.OPENAI_API_KEY && flagString(a, "openai-model")) {
    cfg.profiles.openai ??= { ...PRESETS.openai!, model: flagString(a, "openai-model")! } as any;
    found.push(`openai (${flagString(a, "openai-model")})`);
  }
  const ollamaModel = await detectOllama();
  if (ollamaModel) {
    cfg.profiles.ollama ??= { ...PRESETS.ollama!, model: ollamaModel } as any;
    found.push(`ollama (${ollamaModel})`);
  }
  if (!found.length) throw new Error("no model backend found. Log in to Codex (`codex login`), or set NVIDIA_API_KEY / ANTHROPIC_API_KEY, or run Ollama.");
  const preferred = flagString(a, "default") ?? ["anthropic", "codex", "nim", "openai", "ollama"].find((n) => cfg.profiles[n]);
  cfg.defaultProfile = preferred!;
  cfg.fallbackProfiles = ["nim", "codex", "anthropic", "ollama"].filter((n) => n !== preferred && cfg.profiles[n]);
  if (!cfg.auxiliaryProfile && cfg.profiles.nim && preferred !== "nim") cfg.auxiliaryProfile = "nim";
  saveKestrelConfig(cfg, home);
  out(`✓ wrote ${path.join(home, "config.json")}`);
  for (const f of found) out(`  • ${f}`);
  out(`  default: ${cfg.defaultProfile}; fallbacks: ${cfg.fallbackProfiles.join(", ") || "none"}; auxiliary: ${cfg.auxiliaryProfile ?? cfg.defaultProfile}`);
}

async function cmdDoctor() {
  const cfg = loadKestrelConfig();
  const names = [...new Set([cfg.defaultProfile, ...cfg.fallbackProfiles, ...(cfg.auxiliaryProfile ? [cfg.auxiliaryProfile] : []), ...Object.keys(cfg.profiles)])];
  let failed = 0;
  for (const n of names) {
    const t0 = Date.now();
    try {
      const p = createProvider(resolveProfile(cfg, n), n);
      const r = await p.complete({
        messages: [{ role: "user", content: "Call the ping tool with value 42." }],
        tools: [{ name: "ping", description: "Connectivity check", parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }],
        maxTokens: 512,
      });
      const ok = r.toolCalls.some((x) => x.name === "ping");
      out(`${ok ? "✓" : "~"} ${n} (${p.name}/${p.model}) ${Date.now() - t0}ms ${ok ? "tool calling OK" : `answered without tool call: ${r.content.slice(0, 80)}`}`);
    } catch (e) {
      failed++;
      out(`✗ ${n}: ${errorMessage(e).slice(0, 300)}`);
    }
  }
  const s = await KestrelService.create({ logger: createLogger("warn") });
  const info = await s.rt.executor.info();
  out(`✓ executor ${info.kind} ${info.version}`);
  out(`✓ store ${path.join(s.home, "kestrel.db")}: ${s.store.countMemories()} memories, ${s.store.listSessions({ limit: 10000 }).length} sessions, ${s.skills.list().length} skills, ${s.store.listJobs().length} jobs`);
  await s.close();
  process.exitCode = failed ? 1 : 0;
}

function cmdWebUrl() {
  const cfg = loadKestrelConfig();
  const token = randomToken(24);
  cfg.web.tokenHash = sha256(token);
  saveKestrelConfig(cfg);
  out(`http://127.0.0.1:${cfg.web.port}/#token=${token}`);
  out(c.dim("(restart `kestrel daemon` if it is running so the new token is loaded)"));
}

async function cmdMemory(a: ParsedArgs) {
  const s = await service(a);
  const sub = a._[1] ?? "list";
  try {
    if (sub === "list") for (const m of s.store.listMemories({ limit: flagNumber(a, "limit") ?? 50, kind: flagString(a, "kind") })) out(`#${m.id} [${m.kind} ${m.importance.toFixed(2)}] ${m.content}`);
    else if (sub === "search") for (const m of s.store.searchMemories(a._.slice(2).join(" "), 20)) out(`#${m.id} (${m.score.toFixed(2)}) [${m.kind}] ${m.content}`);
    else if (sub === "add") out(`saved #${s.store.addMemory({ content: a._.slice(2).join(" "), kind: (flagString(a, "kind") as any) ?? "fact", importance: flagNumber(a, "importance"), source: "cli" }).id}`);
    else if (sub === "forget") out(s.store.archiveMemory(Number(a._[2])) ? "archived" : "not found");
    else throw new Error(`unknown memory subcommand ${sub}`);
  } finally {
    await s.close();
  }
}

async function cmdProfile(a: ParsedArgs) {
  const s = await service(a);
  try {
    if (a._[1] === "set") s.store.setProfile(a._[2]!, a._.slice(3).join(" "));
    else if (a._[1] === "delete") s.store.deleteProfile(a._[2]!);
    for (const [k, v] of Object.entries(s.store.getProfile())) out(`${k}: ${v}`);
  } finally {
    await s.close();
  }
}

async function cmdSkills(a: ParsedArgs) {
  const s = await service(a);
  const sub = a._[1] ?? "list";
  const name = a._.slice(2).join(" ");
  try {
    if (sub === "list") for (const k of s.skills.list()) out(`${k.name} (v${k.version}, ${k.origin}, ${k.successes}/${k.uses}) — ${k.description}`);
    else if (sub === "show") {
      const k = s.skills.get(name);
      out(k ? `# ${k.name} v${k.version}\n${k.description}\n\n${k.body}` : "not found");
    } else if (sub === "delete") out(s.skills.delete(name) ? "deleted" : "not found");
    else if (sub === "rollback") out(`rolled back to content of previous version, now v${s.skills.rollback(name).version}`);
    else throw new Error(`unknown skills subcommand ${sub}`);
  } finally {
    await s.close();
  }
}

async function cmdSessions(a: ParsedArgs) {
  const s = await service(a);
  const sub = a._[1] ?? "list";
  try {
    if (sub === "list") for (const x of s.store.listSessions({ limit: flagNumber(a, "limit") ?? 30 })) out(`${x.id} ${x.updatedAt.slice(0, 16)} [${x.source}, ${x.messages}] ${x.title}`);
    else if (sub === "show") {
      const found = s.store.findSession(a._[2] ?? "");
      if (!found) throw new Error("session not found");
      out(`# ${found.title} (${found.id})${found.summary ? `\n\nSummary:\n${found.summary}` : ""}\n`);
      for (const m of s.store.loadMessages(found.id, true)) {
        const body = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
        out(`--- ${m.role}${m.name ? ` (${m.name})` : ""}\n${truncateMiddle(body, 3000)}${(m.toolCalls ?? []).map((t) => `\n→ ${t.name}(${truncateMiddle(t.arguments, 300)})`).join("")}`);
      }
    } else if (sub === "delete") {
      s.store.deleteSession(a._[2] ?? "");
      out("deleted");
    } else if (sub === "export") {
      // ShareGPT-style trajectories (one session per line) for analysis or fine-tuning.
      const file = flagString(a, "out") ?? path.join(s.home, `trajectories-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const lines: string[] = [];
      for (const x of s.store.listSessions({ limit: 100000, includeChildren: true })) {
        const conversations = s.store.loadMessages(x.id, true).map((m) => ({
          from: m.role === "user" ? "human" : m.role === "assistant" ? "gpt" : m.role,
          value: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"),
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls } : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId, name: m.name } : {}),
        }));
        lines.push(JSON.stringify({ id: x.id, title: x.title, source: x.source, model: x.model, parent: x.parentId, conversations }));
      }
      writeFileSync(file, lines.join("\n") + "\n");
      out(`exported ${lines.length} sessions to ${file}`);
    } else throw new Error(`unknown sessions subcommand ${sub}`);
  } finally {
    await s.close();
  }
}

async function cmdJobs(a: ParsedArgs) {
  const s = await service(a);
  const sub = a._[1] ?? "list";
  const id = a._[2];
  try {
    if (sub === "list") {
      const jobs = s.store.listJobs();
      if (!jobs.length) out("no jobs");
      for (const j of jobs) out(`${j.id} ${j.enabled ? "on " : "off"} "${j.name}" ${describeSchedule(j.schedule)} next=${j.nextRunAt ?? "-"} last=${j.lastStatus ?? "-"}\n    ${truncateMiddle(j.prompt, 160)}`);
    } else if (sub === "add") {
      const name = flagString(a, "name");
      const sched = flagString(a, "schedule");
      const prompt = flagString(a, "prompt");
      if (!name || !sched || !prompt) throw new Error('usage: kestrel jobs add --name "x" --schedule "daily 09:00" --prompt "..."');
      const schedule = normalizeSchedule(sched);
      const next = nextRun(schedule, new Date());
      const job = s.store.addJob({ name, schedule, prompt, deliver: flagString(a, "deliver") ?? "both", profile: flagString(a, "profile") ?? null, conditions: flagNumber(a, "gpu-idle-below") ? { gpuIdleBelow: flagNumber(a, "gpu-idle-below") } : {}, nextRunAt: next?.toISOString() ?? null });
      out(`added ${job.id}: ${describeSchedule(schedule)}, next ${next?.toLocaleString() ?? "never"}`);
    } else if (sub === "remove") out(id && s.store.deleteJob(id) ? "removed" : "not found");
    else if (sub === "pause") s.store.updateJob(id!, { enabled: false });
    else if (sub === "resume") {
      const job = s.store.getJob(id!);
      if (!job) throw new Error("job not found");
      s.store.updateJob(id!, { enabled: true, nextRunAt: nextRun(job.schedule, new Date())?.toISOString() ?? null });
    } else if (sub === "run") {
      const job = s.store.getJob(id!);
      if (!job) throw new Error("job not found");
      const r = await s.runJob(job);
      out(r?.text ?? "(failed — see inbox)");
    } else throw new Error(`unknown jobs subcommand ${sub}`);
  } finally {
    await s.close();
  }
}

async function cmdInbox(a: ParsedArgs) {
  const s = await service(a);
  try {
    const items = s.store.listInbox(!a.flags.all, 50);
    if (!items.length) out("inbox empty");
    for (const i of items) out(`${i.read ? " " : "●"} #${i.id} ${i.created_at.slice(0, 16)} ${i.title}\n${truncateMiddle(i.body, 1500)}\n`);
    s.store.markInboxRead();
  } finally {
    await s.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv, ["json", "all", "web", "telegram", "scheduler"]);
  switch (a._[0]) {
    case undefined:
    case "chat":
      return cmdChat(a);
    case "run":
      return cmdRun(a);
    case "daemon":
      return cmdDaemon(a);
    case "setup":
      return cmdSetup(a);
    case "doctor":
      return cmdDoctor();
    case "web-url":
      return cmdWebUrl();
    case "memory":
      return cmdMemory(a);
    case "profile":
      return cmdProfile(a);
    case "skills":
      return cmdSkills(a);
    case "sessions":
      return cmdSessions(a);
    case "jobs":
      return cmdJobs(a);
    case "inbox":
      return cmdInbox(a);
    case "help":
    case "--help":
    case "-h":
      return out(HELP);
    default:
      throw new Error(`unknown command "${a._[0]}"\n\n${HELP}`);
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((e) => {
    err(`error: ${errorMessage(e)}`);
    process.exit(1);
  });
}
