export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Logs to stderr so stdio MCP transports keep stdout clean. */
export function createLogger(level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info", scope = ""): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] < threshold) return;
    const ts = new Date().toISOString().slice(11, 19);
    process.stderr.write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}${msg}\n`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
