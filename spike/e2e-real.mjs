// Real-model end-to-end: Kestrel + codex exec-server executor + a live model profile.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/src/core/runtime.js";
import { BridgeConfigSchema } from "../dist/src/core/config.js";
import { createLogger } from "../dist/src/core/logger.js";
import { KestrelConfigSchema } from "../dist/src/agent/config.js";
import { KestrelService } from "../dist/src/agent/service.js";
import { terminalRenderer } from "../dist/src/agent/cli.js";

const profile = process.argv[2] ?? "nim";
const dir = mkdtempSync(path.join(os.tmpdir(), `kestrel-e2e-${profile}-`));
const rt = await createRuntime({ dataDir: dir, config: BridgeConfigSchema.parse({ executor: { kind: "codex" }, shell: { cwd: dir }, logLevel: "warn" }), logger: createLogger("warn"), scope: "e2e" });
const config = KestrelConfigSchema.parse({ defaultProfile: profile, fallbackProfiles: process.argv[3] ? [process.argv[3]] : [], agent: { autoReflect: false, maxIterations: 20 } });
const s = await KestrelService.create({ home: path.join(dir, "kestrel"), config, runtime: rt });
console.log(`profile=${profile} provider=${s.provider.name}/${s.provider.model} dir=${dir}`);
const t0 = Date.now();
const agent = s.createAgent({ source: "e2e" });
const r = await agent.runTurn(
  "In the current working directory create fib.py that prints the first 12 Fibonacci numbers separated by spaces (starting 0 1). Run it with python and tell me the exact output. Then save a memory that this machine has python available.",
  { onEvent: terminalRenderer((x) => process.stdout.write(x)) },
);
console.log(`\n--- stopped=${r.stopped} iterations=${r.iterations} toolCalls=${r.toolCalls} ${(Date.now() - t0) / 1000}s`);
const fib = path.join(dir, "fib.py");
console.log("fib.py exists:", existsSync(fib));
if (existsSync(fib)) console.log(readFileSync(fib, "utf8"));
console.log("memories:", s.store.listMemories().map((m) => m.content));
console.log("usage:", JSON.stringify(s.store.usageSummary(agent.sessionId)));
await s.close();
await rt.close();
