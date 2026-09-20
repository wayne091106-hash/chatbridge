/**
 * Executor = the "hands" of the system. Everything that touches the machine goes through this
 * interface so the bridge and the agent share one audited path. The primary implementation talks
 * to `codex exec-server`; NodeExecutor is a dependency-free fallback used when Codex is missing
 * and in tests.
 */
export interface ExecutorInfo {
  kind: "codex-exec-server" | "node";
  version: string;
  platform: string;
  shell: string;
  cwd: string;
  homeDir: string;
}

export interface StartProcessOptions {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  tty?: boolean;
  pipeStdin?: boolean;
}

export interface OutputChunk {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  data: Buffer;
}

export interface ReadProcessResult {
  chunks: OutputChunk[];
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAtMs: number;
}

export interface Executor {
  readonly kind: ExecutorInfo["kind"];
  info(): Promise<ExecutorInfo>;
  startProcess(opts: StartProcessOptions): Promise<string>;
  readProcess(id: string, afterSeq: number | null, maxBytes: number, waitMs: number): Promise<ReadProcessResult>;
  writeProcess(id: string, data: string | Buffer): Promise<void>;
  terminateProcess(id: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, data: string | Buffer): Promise<void>;
  readDirectory(dirPath: string): Promise<DirEntry[]>;
  stat(filePath: string): Promise<FileStat | null>;
  createDirectory(dirPath: string): Promise<void>;
  remove(targetPath: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  close(): Promise<void>;
}

/** Environment passed to child processes. exec-server only forwards what we send. */
export function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Never leak the bridge's own secrets into commands the model runs.
    if (/^(CHATBRIDGE_|KESTREL_).*(TOKEN|SECRET|PASSWORD|KEY)/i.test(k)) continue;
    env[k] = v;
  }
  env.PYTHONIOENCODING ??= "utf-8";
  env.PYTHONUTF8 ??= "1";
  return { ...env, ...extra };
}
