#!/usr/bin/env node
// Thin launcher: silence node:sqlite's ExperimentalWarning before any module loads it.
const emit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(String(text))) return;
  return emit(warning, ...rest);
};
const { main } = await import("../dist/src/agent/cli.js");
main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
