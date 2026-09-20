import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { Executor } from "./executor.js";
import { childEnv } from "./executor.js";
import { cleanTerminalOutput, errorMessage, sleep, truncateMiddle } from "./util.js";
import type { Logger } from "./logger.js";

export type ShellKind = "powershell" | "pwsh" | "cmd" | "bash" | "sh" | "direct";

export interface RunOptions {
  command: string;
  /** Run this exact argv instead of wrapping `command` in a shell. */
  argv?: string[];
  cwd?: string;
  shell?: ShellKind;
  /** Seconds to wait before returning. The process keeps running afterwards. */
  yieldSeconds?: number;
  /** Keep stdin open so shell_write can feed input. */
  interactive?: boolean;
  tty?: boolean;
  env?: Record<string, string>;
  /** Max characters returned in this response. */
  maxOutputChars?: number;
  label?: string;
}

export interface ShellSnapshot {
  sessionId: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  totalOutputChars: number;
}

interface Session {
  id: string;
  processId: string;
  command: string;
  cwd: string;
  label?: string;
  buffer: string;
  droppedChars: number;
  readCursor: number;
  running: boolean;
  exitCode: number | null;
  failure: string | null;
  startedAt: number;
  endedAt: number | null;
  events: EventEmitter;
  decoders: Map<string, TextDecoder>;
}

const MAX_BUFFER_CHARS = 2_000_000;
const DEFAULT_OUTPUT_CHARS = 30_000;

function legacyEncoding(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith("zh-tw") || locale.startsWith("zh-hk") || locale.includes("hant")) return "big5";
  if (locale.startsWith("zh")) return "gbk";
  if (locale.startsWith("ja")) return "shift_jis";
  if (locale.startsWith("ko")) return "euc-kr";
  return "windows-1252";
}

/**
 * Long-running shell sessions on top of an Executor. Commands return after `yieldSeconds`
 * even if still running, so chat connectors never hit their tool-call timeout; the model
 * polls with read()/write() using the session id.
 */
export class ShellManager {
  private sessions = new Map<string, Session>();
  private counter = 0;
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly executor: Executor,
    private readonly logger: Logger,
    private readonly defaults: { cwd: string; shell?: ShellKind; retentionMs?: number; maxSessions?: number } = { cwd: os.homedir() },
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  defaultShell(): ShellKind {
    if (this.defaults.shell) return this.defaults.shell;
    return process.platform === "win32" ? "powershell" : "bash";
  }

  buildArgv(command: string, shell: ShellKind): string[] {
    switch (shell) {
      case "powershell":
      case "pwsh": {
        const exe = process.platform === "win32" ? (shell === "pwsh" ? "pwsh.exe" : "powershell.exe") : "pwsh";
        // chcp too: where the console code page is not UTF-8, PowerShell 5.1 turns non-ASCII output into "?"
        // before the encoding settings below can help.
        const prelude = "$null = & chcp 65001;" + "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';";
        return [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", prelude + command];
      }
      case "cmd":
        return ["cmd.exe", "/d", "/s", "/c", `chcp 65001>nul & ${command}`];
      case "bash":
        return [process.platform === "win32" ? "bash.exe" : "bash", "-lc", command];
      case "sh":
        return ["sh", "-c", command];
      case "direct":
        return splitArgs(command);
    }
  }

  async run(opts: RunOptions): Promise<ShellSnapshot> {
    this.enforceCapacity();
    const shell = opts.shell ?? this.defaultShell();
    const cwd = path.resolve(opts.cwd ?? this.defaults.cwd);
    const argv = opts.argv ?? this.buildArgv(opts.command, shell);
    const processId = await this.executor.startProcess({
      argv,
      cwd,
      env: childEnv(opts.env),
      tty: opts.tty ?? false,
      pipeStdin: opts.interactive ?? false,
    });
    const id = `sh${++this.counter}`;
    const session: Session = {
      id,
      processId,
      command: opts.command,
      cwd,
      label: opts.label,
      buffer: "",
      droppedChars: 0,
      readCursor: 0,
      running: true,
      exitCode: null,
      failure: null,
      startedAt: Date.now(),
      endedAt: null,
      events: new EventEmitter(),
      decoders: new Map(),
    };
    this.sessions.set(id, session);
    void this.pump(session);
    await this.waitFor(session, (opts.yieldSeconds ?? 20) * 1000);
    return this.snapshot(session, opts.maxOutputChars ?? DEFAULT_OUTPUT_CHARS);
  }

  private decode(session: Session, stream: string, data: Buffer): string {
    let decoder = session.decoders.get(stream);
    if (!decoder) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: true });
        decoder = new TextDecoder("utf-8");
      } catch {
        decoder = new TextDecoder(legacyEncoding());
      }
      session.decoders.set(stream, decoder);
    }
    return decoder.decode(data, { stream: true });
  }

  private async pump(session: Session) {
    let afterSeq: number | null = null;
    try {
      for (;;) {
        const r = await this.executor.readProcess(session.processId, afterSeq, 1 << 20, 1000);
        let text = "";
        for (const c of r.chunks) text += this.decode(session, c.stream, c.data);
        if (text) this.append(session, text);
        afterSeq = r.nextSeq - 1;
        if (r.exited && session.exitCode === null) session.exitCode = r.exitCode;
        if (r.failure) session.failure = r.failure;
        if (r.closed || (r.exited && r.chunks.length === 0)) break;
      }
    } catch (err) {
      session.failure = errorMessage(err);
      this.logger.debug(`shell ${session.id} pump ended: ${session.failure}`);
    }
    session.running = false;
    session.endedAt = Date.now();
    session.events.emit("change");
  }

  private append(session: Session, text: string) {
    session.buffer += text;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      const drop = session.buffer.length - MAX_BUFFER_CHARS;
      session.buffer = session.buffer.slice(drop);
      session.droppedChars += drop;
      session.readCursor = Math.max(0, session.readCursor - drop);
    }
    session.events.emit("change");
  }

  private async waitFor(session: Session, ms: number) {
    if (!session.running || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        session.events.off("change", onChange);
        resolve();
      }
      const onChange = () => {
        if (!session.running) done();
      };
      session.events.on("change", onChange);
    });
  }

  private snapshot(session: Session, maxChars: number): ShellSnapshot {
    const fresh = cleanTerminalOutput(session.buffer.slice(session.readCursor));
    session.readCursor = session.buffer.length;
    const output = truncateMiddle(fresh, maxChars);
    return {
      sessionId: session.id,
      command: session.command,
      cwd: session.cwd,
      running: session.running,
      exitCode: session.exitCode,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      durationMs: (session.endedAt ?? Date.now()) - session.startedAt,
      output: session.failure && !session.running && !output ? `[process failure] ${session.failure}` : output,
      truncated: output.length < fresh.length,
      totalOutputChars: session.droppedChars + session.buffer.length,
    };
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown shell session ${id} (it may have expired; use shell_list)`);
    return s;
  }

  async read(id: string, waitSeconds = 5, maxOutputChars = DEFAULT_OUTPUT_CHARS): Promise<ShellSnapshot> {
    const s = this.get(id);
    if (s.running && s.readCursor >= s.buffer.length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitSeconds * 1000);
        function done() {
          clearTimeout(timer);
          s.events.off("change", done);
          resolve();
        }
        s.events.on("change", done);
      });
      // Give bursty output a moment to accumulate.
      if (s.running) await sleep(150);
    }
    return this.snapshot(s, maxOutputChars);
  }

  async write(id: string, input: string, waitSeconds = 2, maxOutputChars = DEFAULT_OUTPUT_CHARS): Promise<ShellSnapshot> {
    const s = this.get(id);
    if (!s.running) throw new Error(`shell session ${id} has already exited`);
    await this.executor.writeProcess(s.processId, input);
    await sleep(Math.min(waitSeconds, 60) * 1000);
    return this.snapshot(s, maxOutputChars);
  }

  async kill(id: string): Promise<ShellSnapshot> {
    const s = this.get(id);
    if (s.running) {
      await this.executor.terminateProcess(s.processId).catch((err) => this.logger.warn(`terminate ${id}: ${errorMessage(err)}`));
      await this.waitFor(s, 5000);
    }
    return this.snapshot(s, DEFAULT_OUTPUT_CHARS);
  }

  /** Last output of a session without consuming it (for live viewers). */
  peek(id: string, tailChars = 20_000) {
    const s = this.get(id);
    return {
      sessionId: s.id,
      command: s.command,
      running: s.running,
      exitCode: s.exitCode,
      durationMs: (s.endedAt ?? Date.now()) - s.startedAt,
      text: cleanTerminalOutput(s.buffer.slice(-tailChars)),
    };
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      command: truncateMiddle(s.command, 200),
      label: s.label,
      cwd: s.cwd,
      running: s.running,
      exitCode: s.exitCode,
      startedAt: new Date(s.startedAt).toISOString(),
      unreadChars: s.buffer.length - s.readCursor,
    }));
  }

  /** Convenience for internal callers: run to completion (or timeout) and return full output. */
  async exec(command: string, opts: Omit<RunOptions, "command"> & { timeoutSeconds?: number } = {}) {
    const first = await this.run({ ...opts, command, yieldSeconds: opts.timeoutSeconds ?? 120, maxOutputChars: opts.maxOutputChars ?? 200_000 });
    if (first.running) {
      await this.kill(first.sessionId);
      return { ...first, timedOut: true };
    }
    return { ...first, timedOut: false };
  }

  private enforceCapacity() {
    const max = this.defaults.maxSessions ?? 64;
    if (this.sessions.size < max) return;
    const finished = [...this.sessions.values()].filter((s) => !s.running).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const s of finished) {
      if (this.sessions.size < max) break;
      this.sessions.delete(s.id);
    }
    if (this.sessions.size >= max) throw new Error(`too many running shell sessions (${max}); kill some with shell_kill`);
  }

  private sweep() {
    const retention = this.defaults.retentionMs ?? 30 * 60_000;
    for (const s of this.sessions.values()) {
      if (!s.running && s.endedAt && Date.now() - s.endedAt > retention) this.sessions.delete(s.id);
    }
  }

  async closeAll() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) if (s.running) await this.executor.terminateProcess(s.processId).catch(() => {});
  }
}

/** Minimal shell-like argument splitter supporting single/double quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && input[i + 1] === '"') cur += input[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
