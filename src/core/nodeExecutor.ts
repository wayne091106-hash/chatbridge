import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import type {
  DirEntry,
  Executor,
  ExecutorInfo,
  FileStat,
  OutputChunk,
  ReadProcessResult,
  StartProcessOptions,
} from "./executor.js";
import { childEnv } from "./executor.js";
import { randomId } from "./util.js";

interface Proc {
  child: ChildProcess;
  chunks: OutputChunk[];
  seq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
  waiters: Array<() => void>;
}

/**
 * Fallback executor using Node's child_process/fs. Same semantics as the exec-server executor
 * (sequence-numbered output, long-poll reads) so higher layers cannot tell the difference.
 * TTY mode is emulated with pipes.
 */
export class NodeExecutor implements Executor {
  readonly kind = "node" as const;
  private procs = new Map<string, Proc>();

  async info(): Promise<ExecutorInfo> {
    return {
      kind: this.kind,
      version: process.version,
      platform: process.platform === "win32" ? "windows" : process.platform,
      shell: process.platform === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/sh",
      cwd: process.cwd(),
      homeDir: os.homedir(),
    };
  }

  async startProcess(o: StartProcessOptions): Promise<string> {
    const [cmd, ...args] = o.argv;
    if (!cmd) throw new Error("argv is empty");
    const id = randomId("n", 6);
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? childEnv(),
      stdio: [o.pipeStdin || o.tty ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const proc: Proc = { child, chunks: [], seq: 0, exited: false, exitCode: null, closed: false, failure: null, waiters: [] };
    const wake = () => proc.waiters.splice(0).forEach((w) => w());
    const push = (stream: OutputChunk["stream"]) => (data: Buffer) => {
      proc.chunks.push({ seq: ++proc.seq, stream, data });
      wake();
    };
    child.stdout?.on("data", push("stdout"));
    child.stderr?.on("data", push("stderr"));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new Error(`program not found: ${err.message}`)));
    });
    child.on("error", (err) => {
      proc.failure = err.message;
      wake();
    });
    child.on("exit", (code) => {
      proc.exited = true;
      proc.exitCode = code ?? -1;
      proc.seq++;
      wake();
    });
    child.on("close", () => {
      proc.closed = true;
      proc.seq++;
      wake();
    });
    this.procs.set(id, proc);
    return id;
  }

  async readProcess(id: string, afterSeq: number | null, maxBytes: number, waitMs: number): Promise<ReadProcessResult> {
    const proc = this.procs.get(id);
    if (!proc) throw new Error(`unknown process id ${id}`);
    const after = afterSeq ?? 0;
    const pending = () => proc.chunks.filter((c) => c.seq > after);
    if (pending().length === 0 && !proc.closed && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        proc.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const out: OutputChunk[] = [];
    let bytes = 0;
    for (const c of pending()) {
      if (bytes > 0 && bytes + c.data.length > maxBytes) break;
      out.push(c);
      bytes += c.data.length;
    }
    const last = out.at(-1);
    const drained = out.length === pending().length;
    // Drop delivered chunks so memory stays bounded for long-running processes.
    if (last) proc.chunks = proc.chunks.filter((c) => c.seq > last.seq);
    return {
      chunks: out,
      nextSeq: (drained ? proc.seq : (last?.seq ?? after)) + 1,
      exited: proc.exited && drained,
      exitCode: proc.exited && drained ? proc.exitCode : null,
      closed: proc.closed && drained,
      failure: proc.failure,
    };
  }

  async writeProcess(id: string, data: string | Buffer): Promise<void> {
    const proc = this.procs.get(id);
    if (!proc) throw new Error(`unknown process id ${id}`);
    if (!proc.child.stdin) throw new Error("process stdin is not piped");
    await new Promise<void>((resolve, reject) => proc.child.stdin!.write(data, (err) => (err ? reject(err) : resolve())));
  }

  async terminateProcess(id: string): Promise<void> {
    const proc = this.procs.get(id);
    if (!proc || proc.exited || !proc.child.pid) return;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(proc.child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    } else {
      proc.child.kill("SIGTERM");
    }
  }

  readFile(p: string): Promise<Buffer> {
    return fsp.readFile(p);
  }

  async writeFile(p: string, data: string | Buffer): Promise<void> {
    await fsp.writeFile(p, data);
  }

  async readDirectory(p: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  }

  async stat(p: string): Promise<FileStat | null> {
    try {
      const s = await fsp.lstat(p);
      const followed = s.isSymbolicLink() ? await fsp.stat(p).catch(() => s) : s;
      return { isFile: followed.isFile(), isDirectory: followed.isDirectory(), isSymlink: s.isSymbolicLink(), size: followed.size, modifiedAtMs: followed.mtimeMs };
    } catch (err: any) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    }
  }

  async createDirectory(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true });
  }

  async remove(p: string): Promise<void> {
    await fsp.rm(p, { recursive: true, force: true });
  }

  async copy(src: string, dst: string): Promise<void> {
    await fsp.cp(src, dst, { recursive: true });
  }

  async close(): Promise<void> {
    for (const id of this.procs.keys()) await this.terminateProcess(id);
    this.procs.clear();
  }
}
