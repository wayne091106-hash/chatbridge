import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { createRuntime } from "../dist/src/core/runtime.js";
import { BridgeConfigSchema } from "../dist/src/core/config.js";
import { createLogger } from "../dist/src/core/logger.js";
import { HubJobs } from "../dist/src/hub/jobs.js";
const agents = process.argv.slice(2);
const home = mkdtempSync(path.join(os.tmpdir(), "hub-real-")); process.env.CHATBRIDGE_HOME = home;
const rt = await createRuntime({ dataDir: home, config: BridgeConfigSchema.parse({ executor: { kind: "codex" }, logLevel: "warn" }), logger: createLogger("warn") });
const hub = new HubJobs(rt);
for (const agent of agents) {
  const proj = path.join(home, `proj-${agent}`); execFileSync("cmd", ["/c", "mkdir", proj]);
  const g = (...a) => execFileSync("git", ["-C", proj, ...a], { stdio: "pipe" });
  g("init", "-q"); g("config", "user.email", "t@e.com"); g("config", "user.name", "t");
  writeFileSync(path.join(proj, "README.md"), "# demo\n"); g("add", "."); g("commit", "-qm", "init");
  const t0 = Date.now();
  const job = await hub.start({ agent, task: "Create a file hello.py that prints the sum of 1..100, run it with python, and also append a line 'Usage: python hello.py' to README.md. Report the printed number.", cwd: proj, access: "workspace", timeoutMinutes: 6 });
  while (job.status === "running") await new Promise((r) => setTimeout(r, 1000));
  console.log(`\n===== ${agent} (${job.model}) ${job.status} in ${Math.round((Date.now() - t0) / 1000)}s exit=${job.exitCode}`);
  for (const e of job.events.filter((e) => e.kind !== "thinking").slice(-10)) console.log(`  ${e.kind.padEnd(8)} ${e.text.replace(/\s+/g, " ").slice(0, 160)}`);
  console.log("  final:", job.final.replace(/\s+/g, " ").slice(0, 200));
  console.log("  changed:", job.changed.map((c) => `${c.status} ${path.basename(c.path)}`).join(", ") || "(none)");
}
await rt.close();
