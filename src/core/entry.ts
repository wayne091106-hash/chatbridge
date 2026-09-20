import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite prints an ExperimentalWarning on import; it is expected and noisy for CLI users.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(String(text))) return;
  return (originalEmitWarning as any)(warning, ...rest);
}) as typeof process.emitWarning;

/** True when the module is the process entry point (also through npm-link symlinks and .cmd shims). */
export function isEntryPoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(argv1).toLowerCase() === real(fileURLToPath(moduleUrl)).toLowerCase();
}
