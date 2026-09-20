import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import type {
  DirEntry,
  Executor,
  ExecutorInfo,
  FileStat,
  ReadProcessResult,
  StartProcessOptions,
} from "./executor.js";
import { childEnv } from "./executor.js";
import { errorMessage, fromFileUri, randomId, sleep, toFileUri } from "./util.js";
import type { Logger } from "./logger.js";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON-RPC 2.0 over a single WebSocket, one message per frame (exec-server wire format). */
export class JsonRpcWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly url: string,
    private readonly requestTimeoutMs = 60_000,
  ) {
    super();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timeout connecting to ${this.url}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${this.url}`));
      });
      ws.addEventListener("close", () => {
        if (this.ws === ws) {
          this.ws = null;
          this.failAll(new Error("exec-server connection closed"));
          this.emit("close");
        }
      });
      ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  call<T = any>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("exec-server not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`exec-server request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params: unknown) {
    this.ws?.send(JSON.stringify({ method, params }));
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.failAll(new Error("closed"));
  }
}

export interface CodexExecServerOptions {
  /** Path to codex.exe / codex binary; auto-detected when omitted. */
  codexPath?: string;
  /** Connect to an already running exec-server instead of spawning one. */
  url?: string;
  /** Expected executor version; mismatch is logged because the protocol is experimental. */
  pinnedVersion?: string;
  logger: Logger;
}

export function findCodexBinary(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CODEX_PATH) candidates.push(process.env.CODEX_PATH);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const vendor = path.join(appData, "npm", "node_modules", "@openai", "codex", "node_modules");
    candidates.push(path.join(vendor, "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"));
    candidates.push(path.join(vendor, "@openai", "codex-win32-arm64", "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"));
  }
  for (const c of candidates) if (c && existsSync(c)) return c;
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(cmd, ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && (process.platform !== "win32" || /\.(exe|cmd)$/i.test(s)));
    return first ?? null;
  } catch {
    return null;
  }
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Executor backed by `codex exec-server` — Codex's execution layer without any model.
 * Spawns and supervises the server on a random loopback port and reconnects if it dies.
 */
export class CodexExecServerExecutor implements Executor {
  readonly kind = "codex-exec-server" as const;
  private rpc: JsonRpcWebSocket | null = null;
  private child: ChildProcess | null = null;
  private envInfo: any = null;
  private connecting: Promise<JsonRpcWebSocket> | null = null;
  private closed = false;
  private restarts = 0;

  constructor(private readonly opts: CodexExecServerOptions) {}

  private async spawnServer(): Promise<string> {
    const bin = findCodexBinary(this.opts.codexPath);
    if (!bin) throw new Error("codex binary not found (install with `npm i -g @openai/codex` or set codexPath)");
    const port = await freeLoopbackPort();
    const url = `ws://127.0.0.1:${port}`;
    const useShell = /\.cmd$/i.test(bin);
    const child = spawn(bin, ["exec-server", "--listen", url], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    this.child = child;
    child.stdout?.on("data", (d) => this.opts.logger.debug(`[exec-server] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => this.opts.logger.debug(`[exec-server] ${String(d).trim()}`));
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        if (!this.closed) this.opts.logger.warn(`exec-server exited (code ${code}); will respawn on next call`);
      }
    });
    return url;
  }

  private async ensure(): Promise<JsonRpcWebSocket> {
    if (this.closed) throw new Error("executor closed");
    if (this.rpc?.connected) return this.rpc;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = this.opts.url ?? (await this.spawnServer());
      const rpc = new JsonRpcWebSocket(url);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await rpc.connect(2000);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(200);
        }
      }
      if (lastErr) throw new Error(`exec-server did not become ready: ${errorMessage(lastErr)}`);
      const init = await rpc.call("initialize", { clientName: "chatbridge" });
      rpc.notify("initialized", {});
      this.envInfo = init.environmentInfo;
      const version = this.envInfo?.executorVersion;
      if (this.opts.pinnedVersion && version !== this.opts.pinnedVersion) {
        this.opts.logger.warn(`exec-server version ${version} differs from pinned ${this.opts.pinnedVersion}; run \`chatbridge doctor\``);
      }
      rpc.on("close", () => {
        if (this.rpc === rpc) this.rpc = null;
      });
      this.rpc = rpc;
      if (this.restarts++ > 0) this.opts.logger.info(`exec-server reconnected (${url})`);
      return rpc;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async info(): Promise<ExecutorInfo> {
    await this.ensure();
    const e = this.envInfo ?? {};
    return {
      kind: this.kind,
      version: e.executorVersion ?? "unknown",
      platform: e.platformOs ?? process.platform,
      shell: e.shell?.path ?? e.shell?.name ?? "",
      cwd: e.cwd ? fromFileUri(e.cwd) : process.cwd(),
      homeDir: e.userHomeDir ? fromFileUri(e.userHomeDir) : "",
    };
  }

  async startProcess(o: StartProcessOptions): Promise<string> {
    const rpc = await this.ensure();
    const processId = randomId("p", 6);
    await rpc.call("process/start", {
      processId,
      argv: o.argv,
      cwd: toFileUri(o.cwd),
      env: o.env ?? childEnv(),
      tty: o.tty ?? false,
      pipeStdin: o.pipeStdin ?? false,
      arg0: null,
    });
    return processId;
  }

  async readProcess(id: string, afterSeq: number | null, maxBytes: number, waitMs: number): Promise<ReadProcessResult> {
    const rpc = await this.ensure();
    const r = await rpc.call("process/read", { processId: id, afterSeq, maxBytes, waitMs }, waitMs + 30_000);
    return {
      chunks: (r.chunks ?? []).map((c: any) => ({ seq: c.seq, stream: c.stream, data: Buffer.from(c.chunk, "base64") })),
      nextSeq: r.nextSeq,
      exited: !!r.exited,
      exitCode: r.exitCode ?? null,
      closed: !!r.closed,
      failure: r.failure ? String(r.failure) : null,
    };
  }

  async writeProcess(id: string, data: string | Buffer): Promise<void> {
    const rpc = await this.ensure();
    const chunk = (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64");
    await rpc.call("process/write", { processId: id, writeId: randomId("w", 6), chunk });
  }

  async terminateProcess(id: string): Promise<void> {
    const rpc = await this.ensure();
    await rpc.call("process/terminate", { processId: id });
  }

  async readFile(filePath: string): Promise<Buffer> {
    const rpc = await this.ensure();
    const r = await rpc.call("fs/readFile", { path: toFileUri(filePath) });
    return Buffer.from(r.dataBase64 ?? "", "base64");
  }

  async writeFile(filePath: string, data: string | Buffer): Promise<void> {
    const rpc = await this.ensure();
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await rpc.call("fs/writeFile", { path: toFileUri(filePath), dataBase64: buf.toString("base64") });
  }

  async readDirectory(dirPath: string): Promise<DirEntry[]> {
    const rpc = await this.ensure();
    const r = await rpc.call("fs/readDirectory", { path: toFileUri(dirPath) });
    return (r.entries ?? []).map((e: any) => ({ name: e.fileName, isDirectory: !!e.isDirectory, isFile: !!e.isFile }));
  }

  async stat(filePath: string): Promise<FileStat | null> {
    const rpc = await this.ensure();
    try {
      const r = await rpc.call("fs/getMetadata", { path: toFileUri(filePath) });
      return { isFile: !!r.isFile, isDirectory: !!r.isDirectory, isSymlink: !!r.isSymlink, size: r.size ?? 0, modifiedAtMs: r.modifiedAtMs ?? 0 };
    } catch (err) {
      if (err instanceof RpcError && err.code === -32004) return null;
      throw err;
    }
  }

  async createDirectory(dirPath: string): Promise<void> {
    const rpc = await this.ensure();
    await rpc.call("fs/createDirectory", { path: toFileUri(dirPath), recursive: true });
  }

  async remove(targetPath: string): Promise<void> {
    const rpc = await this.ensure();
    await rpc.call("fs/remove", { path: toFileUri(targetPath), recursive: true, force: true });
  }

  async copy(source: string, destination: string): Promise<void> {
    const rpc = await this.ensure();
    await rpc.call("fs/copy", { sourcePath: toFileUri(source), destinationPath: toFileUri(destination), recursive: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rpc?.close();
    this.rpc = null;
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      } else {
        child.kill("SIGTERM");
      }
    }
  }
}
