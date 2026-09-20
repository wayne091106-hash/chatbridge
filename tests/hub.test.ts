import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { AGENT_PANEL_URI, VIEWER_URI } from "../src/bridge/widgets.js";
import { AGENTS } from "../src/hub/agents.js";
import { cardOf, tempDir, testConfig } from "./helpers.js";

// A fake agent speaking OpenCode's JSON event format: edits a tracked file, creates a new one.
const FAKE_AGENT = `
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2); const dir = args[args.indexOf("--dir") + 1]; const task = args[1];
const emit = (o) => process.stdout.write(JSON.stringify({ sessionID: "ses_fake", ...o }) + "\\n");
const resumed = args.includes("--session") ? args[args.indexOf("--session") + 1] : "";
if (task.includes("FOLLOW")) {
  fs.writeFileSync(path.join(dir, "notes.txt"), "follow-up in " + resumed + "\\n");
  emit({ type: "text", part: { text: "follow-up done in " + resumed } });
  return;
}
if (task.includes("SLOW")) { emit({ type: "text", part: { text: "working slowly" } }); setTimeout(() => {}, 60000); return; }
if (task.includes("COMMIT")) {
  fs.writeFileSync(path.join(dir, "lib.js"), "module.exports = 42;\\n");
  const cp = require("child_process");
  cp.execFileSync("git", ["-C", dir, "add", "lib.js"]); cp.execFileSync("git", ["-C", dir, "commit", "-qm", "agent commit"]);
  emit({ type: "text", part: { text: "committed lib.js" } });
  return;
}
emit({ type: "step_start", part: {} });
emit({ type: "tool_use", part: { tool: "bash", state: { input: { command: "npm test" }, metadata: { exit: 0 } } } });
fs.writeFileSync(path.join(dir, "app.js"), "console.log('v2');\\n");
emit({ type: "tool_use", part: { tool: "edit", state: { input: { filePath: path.join(dir, "app.js") } } } });
fs.writeFileSync(path.join(dir, "NEW.md"), "# added by agent\\n");
emit({ type: "tool_use", part: { tool: "write", state: { input: { filePath: path.join(dir, "NEW.md") } } } });
process.stdout.write("not json noise line\\n");
emit({ type: "text", part: { text: "Done: updated app.js and added NEW.md" } });
emit({ type: "step_finish", part: { reason: "stop" } });
`;

test("agent hub: run, live status, changes/diffs, cancel, cards, extras", async () => {
  const t = tempDir();
  const project = path.join(t.dir, "proj");
  mkdirSync(project);
  const git = (...a: string[]) => execFileSync("git", ["-C", project, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(project, "app.js"), "console.log('v1');\n");
  writeFileSync(path.join(project, "untouched.txt"), "same\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const fake = path.join(t.dir, "fake-agent.cjs");
  writeFileSync(fake, FAKE_AGENT);
  const origResolve = AGENTS.opencode.resolve;
  AGENTS.opencode.resolve = () => ({ command: process.execPath, prefix: [fake] });
  process.env.CHATBRIDGE_HOME = t.dir;

  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: project } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
  try {
    const tools = (await client.listTools()).tools;
    const run = tools.find((x) => x.name === "agent_run")!;
    assert.equal((run._meta as any)["openai/outputTemplate"], AGENT_PANEL_URI);
    assert.equal((run.inputSchema as any).properties.task.minLength, 1);
    assert.equal((tools.find((x) => x.name === "agent_status")!._meta as any)["openai/widgetAccessible"], true);
    for (const uri of [AGENT_PANEL_URI, VIEWER_URI]) {
      const r = await client.readResource({ uri });
      assert.match(String((r.contents[0] as any).text), /bridge\.call/);
    }
    // Every card's inline scripts must be valid JavaScript (escaping inside template strings is easy to get wrong).
    for (const res of (await client.listResources()).resources) {
      const html = String(((await client.readResource({ uri: res.uri })).contents[0] as any).text);
      for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]!), `script in ${res.uri}`);
    }
    const list = JSON.parse(text(await client.callTool({ name: "agents_list", arguments: {} })));
    assert.equal(list.agents.find((x: any) => x.agent === "opencode").installed, true);

    // Run a job and follow it like the progress card does.
    const started = (await client.callTool({ name: "agent_run", arguments: { agent: "opencode", task: "update app.js", cwd: project } })) as any;
    const jobId = cardOf(started).job.id;
    assert.equal(cardOf(started).job.agentLabel, "OpenCode");
    const status = (await client.callTool({ name: "agent_status", arguments: { job_id: jobId, wait_seconds: 30 } })) as any;
    assert.equal(cardOf(status).job.status, "done");
    const kinds = cardOf(status).events.map((e: any) => e.kind);
    assert.deepEqual(kinds, ["command", "file", "file", "message"]);
    assert.equal(cardOf(status).job.final, "Done: updated app.js and added NEW.md");
    const changed = cardOf(status).job.changed.map((c: any) => `${c.status} ${path.basename(c.path)}`).sort();
    assert.deepEqual(changed, ["?? NEW.md", "M app.js"]);
    // Incremental polling returns only new events.
    const tail = (await client.callTool({ name: "agent_status", arguments: { job_id: jobId, since: 3 } })) as any;
    assert.equal(cardOf(tail).events.length, 1);

    const result = text(await client.callTool({ name: "agent_result", arguments: { job_id: jobId } }));
    assert.match(result, /-console\.log\('v1'\);\n\+console\.log\('v2'\);/);
    assert.match(result, /\+# added by agent/);
    assert.doesNotMatch(result, /untouched/);
    const diff = (await client.callTool({ name: "agent_diff", arguments: { job_id: jobId, path: "app.js" } })) as any;
    assert.match(cardOf(diff).diff, /\+console\.log\('v2'\)/);
    assert.match(readFileSync(path.join(t.dir, "hub", "logs", `${jobId}.log`), "utf8"), /not json noise line/);

    // An agent that commits its own work still shows its changes; edits made before the job are not attributed to it.
    writeFileSync(path.join(project, "untouched.txt"), "edited by the user before the job\n");
    await new Promise((r) => setTimeout(r, 2500));
    const c = (await client.callTool({ name: "agent_run", arguments: { agent: "opencode", task: "COMMIT work", cwd: project } })) as any;
    const cs = (await client.callTool({ name: "agent_status", arguments: { job_id: cardOf(c).job.id, wait_seconds: 30 } })) as any;
    const csJob = cardOf(cs).job;
    assert.deepEqual(csJob.changed.map((x: any) => `${x.status} ${path.basename(x.path)}`), ["A lib.js"], JSON.stringify({ status: csJob.status, final: csJob.final, note: csJob.note, log: readFileSync(path.join(t.dir, "hub", "logs", `${csJob.id}.log`), "utf8").slice(-1500) }));
    const cr = text(await client.callTool({ name: "agent_result", arguments: { job_id: cardOf(c).job.id } }));
    assert.match(cr, /\+module\.exports = 42;/);

    // A follow-up continues the same agent session; changes accumulate over the conversation.
    // (Files touched by other jobs just before it — lib.js — stay out, given the 2 s mtime grace.)
    await new Promise((r) => setTimeout(r, 2500));
    const follow = (await client.callTool({ name: "agent_message", arguments: { job_id: jobId, message: "FOLLOW: add notes" } })) as any;
    assert.equal(follow.structuredContent.delivered, "started");
    const fs2 = (await client.callTool({ name: "agent_status", arguments: { job_id: jobId, wait_seconds: 30 } })) as any;
    const conv = cardOf(fs2);
    assert.equal(conv.job.status, "done");
    assert.equal(conv.job.runs.length, 2);
    assert.equal(conv.job.final, "follow-up done in ses_fake");
    assert.ok(conv.events.some((e: any) => e.kind === "user" && /FOLLOW/.test(e.text)));
    assert.deepEqual(conv.job.changed.map((c: any) => path.basename(c.path)).sort(), ["NEW.md", "app.js", "notes.txt"]);
    assert.ok(conv.job.changed.find((c: any) => path.basename(c.path) === "app.js").added >= 1);

    // Busy agent: a message is queued, pause keeps the conversation, resume continues it.
    const busy = (await client.callTool({ name: "agent_run", arguments: { agent: "opencode", task: "SLOW job", cwd: project } })) as any;
    const busyId = cardOf(busy).job.id;
    await new Promise((r) => setTimeout(r, 1500));
    const q = (await client.callTool({ name: "agent_message", arguments: { job_id: busyId, message: "also FOLLOW up" } })) as any;
    assert.equal(q.structuredContent.delivered, "queued");
    const paused = (await client.callTool({ name: "agent_pause", arguments: { job_id: busyId } })) as any;
    assert.equal(cardOf(paused).job.status, "paused");
    assert.deepEqual(cardOf(paused).job.queued, ["also FOLLOW up"]);
    await client.callTool({ name: "agent_resume", arguments: { job_id: busyId, message: "FOLLOW: finish" } });
    const rs = (await client.callTool({ name: "agent_status", arguments: { job_id: busyId, wait_seconds: 30 } })) as any;
    assert.equal(cardOf(rs).job.status, "done");
    assert.equal(cardOf(rs).job.runs.length, 2);

    // Undo the whole first conversation.
    const undo = text(await client.callTool({ name: "agent_revert", arguments: { job_id: jobId } }));
    assert.match(undo, /restored app\.js/);
    assert.equal(readFileSync(path.join(project, "app.js"), "utf8").replace(/\r/g, ""), "console.log('v1');\n");
    assert.ok(!existsSync(path.join(project, "NEW.md")));

    // Workbench: project state, working-tree diff, commit.
    writeFileSync(path.join(project, "app.js"), "console.log('v3');\n");
    const wb = cardOf(await client.callTool({ name: "workbench_open", arguments: { cwd: project } }));
    assert.equal(wb.mode, "workbench");
    assert.equal(wb.project.git, true);
    assert.ok(wb.project.changes.some((c: any) => c.path === "app.js" && c.added === 1 && c.removed === 1));
    assert.ok(wb.agents.find((x: any) => x.id === "kilo").models.includes("google-vertex/gemini-3.8-flash"));
    assert.ok(wb.threads.length >= 2);
    const wd = cardOf(await client.callTool({ name: "workbench_diff", arguments: { cwd: project, path: "app.js" } }));
    assert.match(wd.diff, /\+console\.log\('v3'\)/);
    const committed = cardOf(await client.callTool({ name: "workbench_git", arguments: { cwd: project, action: "commit", message: "v3 from workbench" } }));
    assert.equal(committed.project.changes.length, 0);
    assert.match(committed.project.lastCommit, /v3 from workbench/);

    // Cancel a long-running job.
    const slow = (await client.callTool({ name: "agent_run", arguments: { agent: "opencode", task: "SLOW task", cwd: project } })) as any;
    const slowId = cardOf(slow).job.id;
    await new Promise((r) => setTimeout(r, 1500));
    const cancelled = (await client.callTool({ name: "agent_cancel", arguments: { job_id: slowId } })) as any;
    assert.equal(cardOf(cancelled).job.status, "cancelled");
    assert.match(text(await client.callTool({ name: "agent_jobs", arguments: {} })), new RegExp(slowId));

    // Unknown / uninstalled agents fail cleanly.
    const orig = AGENTS.gemini.resolve;
    AGENTS.gemini.resolve = () => null;
    const bad = await client.callTool({ name: "agent_run", arguments: { agent: "gemini", task: "x y z", cwd: project } });
    assert.equal(bad.isError, true);
    AGENTS.gemini.resolve = orig;

    // Model configuration.
    await client.callTool({ name: "agents_configure", arguments: { agent: "kilo", model: "groq/openai/gpt-oss-120b" } });
    const l2 = JSON.parse(text(await client.callTool({ name: "agents_list", arguments: {} })));
    assert.equal(l2.agents.find((x: any) => x.agent === "kilo").model, "groq/openai/gpt-oss-120b");

    // Extras: guide, viewer, handoffs, live terminal.
    assert.match(text(await client.callTool({ name: "chatbridge_guide", arguments: {} })), /agent_run/);
    // Long conversations lose ChatGPT's app tools, so the model is reminded to hand over in time.
    let reminded = 0;
    for (let i = 1; i <= 45; i++) if (/tool calls in this conversation/.test(text(await client.callTool({ name: "computer_info", arguments: {} })))) reminded = i;
    assert.equal(reminded, 45);
    const v = (await client.callTool({ name: "view", arguments: { path: path.join(project, "app.js") } })) as any;
    assert.equal(cardOf(v).kind, "text");
    assert.match(cardOf(v).text, /v3/); // committed from the workbench above
    const d = (await client.callTool({ name: "view", arguments: { path: project } })) as any;
    assert.equal(cardOf(d).kind, "dir");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(path.join(project, "dot.png"), png);
    const img = (await client.callTool({ name: "view", arguments: { path: path.join(project, "dot.png") } })) as any;
    assert.equal(cardOf(img).kind, "image");
    assert.equal(cardOf(img).data, png.toString("base64"));
    // Heavy card data must not reach the model through structuredContent.
    assert.equal(img.structuredContent.data, undefined);
    assert.equal(v.structuredContent.text, undefined);
    assert.equal(tail.structuredContent.events, undefined);
    await client.callTool({ name: "handoff_save", arguments: { title: "Test project", content: "Goal: ship v2. Next: run the release script." } });
    assert.match(text(await client.callTool({ name: "handoff_load", arguments: {} })), /ship v2/);
    const sh = text(await client.callTool({ name: "shell_run", arguments: { command: "Start-Sleep -Seconds 2; Write-Output watch-me", yield_seconds: 0.2 } }));
    assert.doesNotMatch(sh, /watch-me/);
    const sid = sh.match(/session (sh\d+)/)![1]!;
    const watch = (await client.callTool({ name: "shell_watch", arguments: { session_id: sid } })) as any;
    assert.equal(cardOf(watch).kind, "terminal");
    assert.equal(cardOf(watch).refreshTool, "shell_peek");
    await new Promise((r) => setTimeout(r, 3000));
    const peek = (await client.callTool({ name: "shell_peek", arguments: { session_id: sid } })) as any;
    assert.match(cardOf(peek).text, /watch-me/);
    assert.equal(cardOf(peek).live, false);
    // peek did not consume the output: shell_read still sees it.
    assert.match(text(await client.callTool({ name: "shell_read", arguments: { session_id: sid } })), /watch-me/);
  } finally {
    AGENTS.opencode.resolve = origResolve;
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});

// If the process dies mid-job (crash, reboot, the owner closing the window), the record has to survive and
// say how to pick the work up — otherwise the work is simply lost.
test("interrupted work is recorded and can be looked up afterwards", async () => {
  const t = tempDir();
  const home = path.join(t.dir, "home");
  mkdirSync(path.join(home, "hub", "jobs"), { recursive: true });
  writeFileSync(
    path.join(home, "hub", "jobs", "j-crash.json"),
    JSON.stringify({
      id: "j-crash",
      thread: "j-crash",
      threadStartedAt: Date.now() - 60_000,
      agent: "kilo",
      status: "running",
      cwd: t.dir,
      task: "把登入頁改成深色模式",
      startedAt: Date.now() - 60_000,
      agentSession: "sess-abc",
      events: [{ seq: 1, kind: "file", text: "edited src/login.tsx", at: Date.now(), paths: ["src/login.tsx"] }],
      changed: [{ path: path.join(t.dir, "src/login.tsx"), status: "M" }],
      queued: [],
    }),
  );
  process.env.CHATBRIDGE_HOME = home;
  const rt = await createRuntime({ dataDir: home, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const card = cardOf(await client.callTool({ name: "work_recover", arguments: {} }));
    assert.equal(card.items.length, 1);
    const [item] = card.items;
    assert.equal(item.status, "interrupted");
    assert.equal(item.resumable, true, "the agent session id is still there, so it can carry on");
    assert.match(item.lastStep, /login\.tsx/);
    assert.deepEqual(item.changedSoFar, [path.join(t.dir, "src/login.tsx")]);

    // The new status is written back, so the next start still knows what happened.
    const onDisk = JSON.parse(readFileSync(path.join(home, "hub", "jobs", "j-crash.json"), "utf8"));
    assert.equal(onDisk.status, "interrupted");
    assert.ok(onDisk.interruptedAt > 0);
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
