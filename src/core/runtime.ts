import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { AuditLog } from "./audit.js";
import { Checkpoints } from "./checkpoints.js";
import { dataDir as defaultDataDir, loadConfig, RuntimeState, type BridgeConfig } from "./config.js";
import { DesktopService } from "./desktop.js";
import type { Executor } from "./executor.js";
import { CodexExecServerExecutor, findCodexBinary } from "./execServer.js";
import { FileService } from "./files.js";
import { createLogger, type Logger } from "./logger.js";
import { NodeExecutor } from "./nodeExecutor.js";
import { ShellManager } from "./shell.js";
import { Policy } from "./policy.js";
import { errorMessage } from "./util.js";

export interface Runtime {
  dataDir: string;
  config: BridgeConfig;
  logger: Logger;
  executor: Executor;
  shells: ShellManager;
  files: FileService;
  desktop: DesktopService;
  audit: AuditLog;
  state: RuntimeState;
  checkpoints: Checkpoints;
  policy: Policy;
  cwd: { value: string };
  close(): Promise<void>;
}

export function findRipgrep(codexPath?: string | null): string | null {
  const bin = codexPath ?? findCodexBinary();
  if (bin && /codex\.exe$/i.test(bin)) {
    const rg = path.join(path.dirname(bin), "..", "codex-path", "rg.exe");
    if (existsSync(rg)) return path.resolve(rg);
  }
  return null;
}

export async function createExecutor(config: BridgeConfig, logger: Logger): Promise<Executor> {
  const kind = config.executor.kind;
  if (kind === "node") return new NodeExecutor();
  const codex = config.executor.url ? null : findCodexBinary(config.executor.codexPath);
  if (!codex && !config.executor.url) {
    if (kind === "codex") throw new Error("executor.kind=codex but no codex binary was found");
    logger.warn("codex not found; falling back to the built-in Node executor");
    return new NodeExecutor();
  }
  const ex = new CodexExecServerExecutor({
    codexPath: codex ?? undefined,
    url: config.executor.url,
    pinnedVersion: config.executor.pinnedVersion,
    logger,
  });
  try {
    const info = await ex.info();
    logger.info(`executor: codex exec-server ${info.version} (${info.platform}, ${info.shell})`);
    return ex;
  } catch (err) {
    await ex.close();
    if (kind === "codex") throw err;
    logger.warn(`codex exec-server unavailable (${errorMessage(err)}); using Node executor`);
    return new NodeExecutor();
  }
}

export async function createRuntime(opts: { dataDir?: string; config?: BridgeConfig; logger?: Logger; scope?: string } = {}): Promise<Runtime> {
  const dir = opts.dataDir ?? defaultDataDir();
  const config = opts.config ?? loadConfig(dir);
  const logger = opts.logger ?? createLogger(config.logLevel, "chatbridge");
  const executor = await createExecutor(config, logger);
  const cwd = { value: config.shell.cwd ?? os.homedir() };
  const shells = new ShellManager(executor, logger, { cwd: cwd.value, shell: config.shell.default });
  const checkpoints = new Checkpoints(path.join(dir, "checkpoints"), opts.scope ?? "bridge");
  const rg = executor.kind === "codex-exec-server" ? findRipgrep(config.executor.codexPath) : null;
  const files = new FileService(executor, shells, () => cwd.value, checkpoints, rg);
  const desktop = new DesktopService(executor, shells);
  const audit = new AuditLog(path.join(dir, "audit", "audit.jsonl"));
  const state = new RuntimeState(dir);
  const policy = new Policy(config.policy, () => cwd.value, dir === defaultDataDir() ? undefined : dir);
  return {
    dataDir: dir,
    config,
    logger,
    executor,
    shells,
    files,
    desktop,
    audit,
    state,
    checkpoints,
    policy,
    cwd,
    async close() {
      await shells.closeAll();
      await executor.close();
    },
  };
}
