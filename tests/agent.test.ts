import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, type Runtime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { KestrelStore, queryTerms } from "../src/agent/store.js";
import { SkillLibrary, parseFrontmatter, slugify } from "../src/agent/skills.js";
import { cronNext, nextRun, normalizeSchedule, parseCron } from "../src/agent/schedule.js";
import { KestrelConfigSchema, saveKestrelConfig } from "../src/agent/config.js";
import { KestrelService } from "../src/agent/service.js";
import { MockProvider, call, say } from "../src/agent/providers/mock.js";
import { toAnthropicMessages } from "../src/agent/providers/anthropic.js";
import { htmlToText, toolSpec, builtinTools } from "../src/agent/tools.js";
import { parseJsonLoose, type AgentEvent } from "../src/agent/agent.js";
import { FallbackProvider } from "../src/agent/providers/index.js";
import { ProviderError } from "../src/agent/providers/types.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { kestrelBridgeExtension } from "../src/agent/bridgeExtension.js";
import { tempDir, testConfig } from "./helpers.js";

describe("store", () => {
  const store = new KestrelStore(":memory:");
  after(() => store.close());

  test("memory search works for Chinese and English, ranks by relevance and importance", () => {
    store.addMemory({ kind: "preference", content: "使用者偏好用繁體中文回覆，程式碼註解用英文", importance: 0.9 });
    store.addMemory({ kind: "environment", content: "The RTX 4090 GPU runs CUDA 12.4; use conda env 'ml' for training", importance: 0.7, tags: ["gpu", "cuda"] });
    store.addMemory({ kind: "project", content: "demo 專案位於 C:\\projects\\demo，用 pnpm 建置", importance: 0.6 });
    const zh = store.searchMemories("請用繁體中文回答");
    assert.equal(zh[0]?.kind, "preference");
    const en = store.searchMemories("which conda env for cuda training?");
    assert.match(en[0]!.content, /RTX 4090/);
    const short = store.searchMemories("專案");
    assert.match(short[0]!.content, /demo 專案/);
    assert.ok(store.findSimilarMemory("使用者偏好用繁體中文回覆，程式碼註解使用英文"));
    assert.equal(store.findSimilarMemory("completely unrelated statement about bananas"), null);
    const id = en[0]!.id;
    assert.ok(store.archiveMemory(id));
    assert.ok(!store.searchMemories("cuda training").some((m) => m.id === id));
    assert.deepEqual(queryTerms("a 中文 hello"), { fts: ['"hello"'], like: ["中文"] });
  });

  test("sessions, messages, full-text search, compaction flags", () => {
    const s = store.createSession({ title: "debug build", source: "cli" });
    store.appendMessage(s.id, { role: "user", content: "the webpack build fails with ENOSPC" });
    store.appendMessage(s.id, { role: "assistant", content: "", toolCalls: [{ id: "1", name: "shell_run", arguments: '{"command":"npm run build"}' }] });
    store.appendMessage(s.id, { role: "tool", toolCallId: "1", name: "shell_run", content: "Error: ENOSPC: no space left on device" });
    assert.equal(store.loadMessages(s.id).length, 3);
    const hits = store.searchMessages("ENOSPC");
    assert.ok(hits.length >= 2);
    assert.equal(hits[0]!.sessionId, s.id);
    store.markCompacted(s.id, 2);
    assert.equal(store.loadMessages(s.id).length, 1);
    assert.equal(store.loadMessages(s.id, true).length, 3);
    assert.equal(store.findSession(s.id.slice(0, 12))?.id, s.id);
  });

  test("jobs and inbox", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const j = store.addJob({ name: "x", schedule: "every 5m", prompt: "do", nextRunAt: past });
    assert.equal(store.dueJobs().length, 1);
    store.updateJob(j.id, { enabled: false });
    assert.equal(store.dueJobs().length, 0);
    store.addInbox("t", "b", "test");
    assert.equal(store.listInbox(true).length, 1);
    store.markInboxRead();
    assert.equal(store.listInbox(true).length, 0);
  });
});

describe("schedule", () => {
  test("cron parsing and next occurrence", () => {
    const f = parseCron("*/15 9-17 * * 1-5");
    const mon = new Date(2026, 8, 14, 8, 50); // Monday 08:50
    assert.deepEqual(cronNext(f, mon), new Date(2026, 8, 14, 9, 0));
    const fri = new Date(2026, 8, 18, 17, 50); // Friday 17:50
    assert.deepEqual(cronNext(f, fri), new Date(2026, 8, 21, 9, 0), "skips the weekend");
    assert.deepEqual(cronNext(parseCron("@monthly"), new Date(2026, 8, 17, 10, 0)), new Date(2026, 9, 1, 0, 0));
    assert.deepEqual(cronNext(parseCron("0 12 * * sun"), new Date(2026, 8, 17, 10, 0)), new Date(2026, 8, 20, 12, 0));
    assert.throws(() => parseCron("61 * * * *"));
    assert.throws(() => parseCron("* * *"));
  });

  test("friendly forms", () => {
    const now = new Date(2026, 8, 17, 10, 0, 0);
    assert.equal(normalizeSchedule("daily 9:30"), "30 9 * * *");
    assert.equal(normalizeSchedule("weekdays 08:00"), "0 8 * * 1-5");
    assert.equal(normalizeSchedule("weekly Friday 18:00"), "0 18 * * 5");
    assert.equal(normalizeSchedule("every 2h"), "every 2h");
    const inTwenty = normalizeSchedule("in 20m", now);
    assert.equal(nextRun(inTwenty, now)!.getTime(), now.getTime() + 20 * 60_000);
    assert.equal(nextRun(inTwenty, now, now), null, "one-shot does not repeat");
    const last = new Date(now.getTime() - 60_000);
    assert.equal(nextRun("every 5m", now, last)!.getTime(), last.getTime() + 5 * 60_000);
    assert.throws(() => normalizeSchedule("sometimes"));
  });
});

describe("skills", () => {
  const t = tempDir();
  after(() => t.cleanup());
  test("save, version history, rollback, search ranking, outcomes", () => {
    const lib = new SkillLibrary(t.dir);
    lib.save({ name: "Deploy Python service", description: "Build and deploy the FastAPI service with uvicorn behind nssm", body: "## Steps\n1. pip install -r requirements.txt\n2. nssm restart api", tags: ["python", "deploy"] });
    const v2 = lib.save({ name: "Deploy Python service", description: "Build and deploy the FastAPI service", body: "## Steps\n1. uv sync\n2. nssm restart api" });
    assert.equal(v2.version, 2);
    assert.ok(existsSync(path.join(v2.dir, ".history", "v1.md")));
    lib.save({ name: "GPU training run", description: "Launch a long PyTorch training job and monitor VRAM", body: "Use nvidia-smi and tmux-like background shells" });
    assert.equal(lib.search("deploy the api service")[0]!.slug, "deploy-python-service");
    lib.recordOutcome("deploy-python-service", true);
    lib.recordOutcome("deploy-python-service", false);
    const s = lib.get("Deploy Python service")!;
    assert.equal(s.uses, 2);
    assert.equal(s.successes, 1);
    const rolled = lib.rollback("deploy-python-service");
    assert.match(rolled.body, /pip install/);
    assert.equal(rolled.version, 3);
    assert.equal(slugify("中文 技能！"), "中文-技能");
    assert.deepEqual(parseFrontmatter("---\nname: a\ntags: [x, y]\nversion: 2\n---\nbody").meta, { name: "a", tags: ["x", "y"], version: 2 });
    assert.ok(lib.delete("gpu-training-run"));
  });
});

describe("providers & helpers", () => {
  test("anthropic message conversion groups tool results and replays native blocks", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", arguments: '{"q":1}' }, { id: "b", name: "y", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "ra" },
      { role: "tool", toolCallId: "b", content: [{ type: "text", text: "rb" }, { type: "image", data: "AAA", mimeType: "image/png" }] },
      { role: "assistant", content: "done", providerName: "anthropic", providerBlocks: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "done" }] },
    ]);
    assert.equal(system, "sys");
    assert.equal(messages.length, 4);
    assert.deepEqual(messages[1].content[0], { type: "tool_use", id: "a", name: "x", input: { q: 1 } });
    assert.equal(messages[2].content.length, 2);
    assert.equal(messages[2].content[1].content[1].type, "image");
    assert.equal(messages[3].content[0].type, "thinking");
  });

  test("fallback provider switches on retryable failure", async () => {
    const bad = new MockProvider([() => Promise.reject(new ProviderError("429", 429, true))]);
    const good = new MockProvider([say("ok from backup")]);
    let switched = "";
    const fb = new FallbackProvider([bad, good], (from, to) => (switched = `${from.name}->${to.name}`));
    const r = await fb.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.content, "ok from backup");
    assert.equal(switched, "mock->mock");
  });

  test("html to text, tool schemas, loose json", () => {
    const { title, text } = htmlToText("<html><head><title>T</title><style>x{}</style></head><body><h1>Hello</h1><p>a &amp; b</p><a href='/x'>no</a><a href=\"https://e.com\">link</a><script>bad()</script></body></html>");
    assert.equal(title, "T");
    assert.match(text, /# Hello\na & b/);
    assert.match(text, /link \(https:\/\/e\.com\)/);
    assert.ok(!text.includes("bad()"));
    for (const t of builtinTools()) {
      const spec = toolSpec(t);
      assert.equal((spec.parameters as any).type, "object", t.name);
      assert.ok(!("$schema" in spec.parameters));
    }
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Sure! {"a":2} hope that helps'), { a: 2 });
  });
});

describe("agent loop (mock model, node executor)", () => {
  const t = tempDir();
  let rt: Runtime;
  let service: KestrelService;
  const mock = new MockProvider();

  before(async () => {
    rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger, scope: "test" });
    const config = KestrelConfigSchema.parse({ agent: { autoReflect: false, maxIterations: 6, keepRecentMessages: 4 } });
    service = await KestrelService.create({ home: path.join(t.dir, "kestrel"), config, runtime: rt, provider: mock });
  });

  after(async () => {
    await service.close();
    await rt.close();
    t.cleanup();
  });

  test("tool loop: write, parallel reads, final answer, persistence, events", async () => {
    const file = path.join(t.dir, "hello.txt");
    mock.push(
      call("write_file", { path: "hello.txt", content: "hi there\n" }, "Creating the file."),
      { content: "", stopReason: "tool_calls", toolCalls: [
        { id: "r1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) },
        { id: "r2", name: "list_dir", arguments: "{}" },
        { id: "r3", name: "nope_tool", arguments: "{}" },
        { id: "r4", name: "read_file", arguments: "{not json" },
      ] },
      (req) => {
        const tools = req.messages.filter((m) => m.role === "tool");
        const last4 = tools.slice(-4).map((m) => String(m.content));
        assert.match(last4[0]!, /1\thi there/);
        assert.match(last4[1]!, /hello\.txt/);
        assert.match(last4[2]!, /unknown tool/);
        assert.match(last4[3]!, /not valid JSON/);
        assert.match(String(req.messages[0]!.content), /You are Kestrel/);
        return say("Done: created hello.txt");
      },
    );
    const agent = service.createAgent({ source: "test" });
    const events: AgentEvent[] = [];
    const r = await agent.runTurn("create hello.txt", { onEvent: (e) => events.push(e) });
    assert.equal(r.stopped, "completed");
    assert.equal(r.text, "Done: created hello.txt");
    assert.equal(r.toolCalls, 5);
    assert.equal(readFileSync(file, "utf8"), "hi there\n");
    assert.ok(events.some((e) => e.type === "tool_end" && e.name === "write_file" && e.ok));
    assert.ok(events.some((e) => e.type === "text"));
    const stored = service.store.loadMessages(agent.sessionId);
    assert.equal(stored[0]!.role, "user");
    assert.equal(stored.filter((m) => m.role === "tool").length, 5);
    assert.ok(rt.audit.tail(10).some((x) => x.action === "agent.write_file"));

    // Resume the same session in a new Agent: history is loaded.
    mock.push((req) => {
      assert.ok(req.messages.some((m) => m.role === "assistant" && m.content === "Done: created hello.txt"));
      return say("still here");
    });
    const resumed = service.createAgent({ sessionId: agent.sessionId });
    assert.equal((await resumed.runTurn("are you there?")).text, "still here");

    // Undo restores the pre-turn state (file did not exist).
    const undone = await resumed.checkpoints.undo(rt.executor, 1);
    assert.equal(undone.restored.length, 1);
    assert.equal(existsSync(file), false);
  });

  test("iteration budget produces a wrap-up report", async () => {
    for (let i = 0; i < 6; i++) mock.push(call("system_info", {}));
    mock.push((req) => {
      assert.match(String(req.messages.at(-1)!.content), /Iteration budget/);
      assert.equal(req.tools, undefined);
      return say("Status: partially done");
    });
    // system_info shells out to PowerShell; stub it for speed.
    const orig = rt.desktop.systemInfo.bind(rt.desktop);
    rt.desktop.systemInfo = async () => ({ stub: true });
    try {
      const r = await service.createAgent().runTurn("loop forever");
      assert.equal(r.stopped, "max_iterations");
      assert.equal(r.text, "Status: partially done");
    } finally {
      rt.desktop.systemInfo = orig;
    }
  });

  test("abort stops the turn", async () => {
    const ctl = new AbortController();
    mock.push(() => {
      ctl.abort();
      return call("list_dir", {});
    });
    const r = await service.createAgent().runTurn("abort me", { signal: ctl.signal });
    assert.equal(r.stopped, "aborted");
  });

  test("compaction summarises old context and keeps tool pairs intact", async () => {
    // The agent talks to `small`; the shared `mock` is the auxiliary model, so any call to it here is a compaction.
    const small = new MockProvider([], { contextWindow: 12_000 });
    let summaries = 0;
    mock.push((req) => {
      assert.match(String(req.messages[0]!.content), /Summarise the earlier part/);
      summaries++;
      return say("SUMMARY: user asked numbered questions");
    });
    const agent = service.createAgent({ provider: small });
    const big = "x".repeat(4000);
    const events: AgentEvent[] = [];
    let sawSummaryInRequest = false;
    for (let i = 0; i < 6; i++) {
      small.push((req) => {
        if (req.messages.some((m) => String(m.content).startsWith("[Summary of the earlier conversation]"))) sawSummaryInRequest = true;
        // Every tool/assistant pairing must remain valid: no tool message without its assistant call.
        const ids = new Set(req.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
        assert.ok(req.messages.filter((m) => m.role === "tool").every((m) => ids.has(m.toolCallId!)));
        return say(`answer ${i} ${big}`);
      });
      await agent.runTurn(`question ${i}`, { onEvent: (e) => events.push(e) });
    }
    assert.equal(summaries, 1);
    assert.ok(events.some((e) => e.type === "compaction"));
    assert.ok(sawSummaryInRequest);
    assert.match(service.store.getSession(agent.sessionId)!.summary!, /SUMMARY/);
    // A fresh Agent on the same session starts from the summary, not the compacted messages.
    const reloaded = service.createAgent({ sessionId: agent.sessionId, provider: small });
    assert.match(String(reloaded.history[0]!.content), /SUMMARY/);
    assert.ok(reloaded.history.length < 12);
  });

  test("reflection stores memories, profile, skill and skill feedback", async () => {
    const agent = service.createAgent();
    mock.push(
      call("shell_run", { command: "Write-Output a" }),
      call("shell_run", { command: "Write-Output b" }),
      call("shell_run", { command: "Write-Output c" }),
      call("shell_run", { command: "Write-Output d" }),
      call("shell_run", { command: "Write-Output e" }),
      say("Set up done"),
    );
    await agent.runTurn("set up the nightly backup");
    mock.push((req) => {
      assert.equal(req.json, true);
      return say(
        JSON.stringify({
          title: "Nightly backup setup",
          memories: [
            { kind: "project", content: "Backups go to D:\\Backups via robocopy /MIR every night", importance: 0.8, tags: ["backup"] },
            { kind: "fact", content: "x" },
          ],
          profile: [{ key: "preferred_language", value: "zh-TW" }],
          skill: { name: "Nightly robocopy backup", description: "Configure a scheduled robocopy mirror backup on Windows", tags: ["backup", "windows"], body: "## Steps\n1. robocopy SRC DST /MIR /R:1 /W:1 /LOG:backup.log\n2. Register a scheduled task\n## Verification\nCheck the log tail." },
          skill_feedback: [],
        }),
      );
    });
    const r = await agent.reflect();
    assert.equal(r.memories, 1);
    assert.equal(r.skill, "Nightly robocopy backup");
    assert.equal(service.store.getProfile().preferred_language, "zh-TW");
    assert.equal(service.store.getSession(agent.sessionId)!.title, "Nightly backup setup");
    assert.ok(service.skills.get("nightly-robocopy-backup"));
    // Memories surface in the next system prompt.
    mock.push((req) => {
      assert.match(String(req.messages[0]!.content), /D:\\Backups/);
      assert.match(String(req.messages[0]!.content), /preferred_language: zh-TW/);
      assert.match(String(req.messages[0]!.content), /Nightly robocopy backup/);
      return say("I remember the backup setup");
    });
    await service.createAgent().runTurn("how do my backups work?");
    // Nothing new since last reflection → no model call.
    const again = await agent.reflect();
    assert.equal(again.memories, 0);
  });

  test("sub-agents run in parallel with isolated sessions", async () => {
    let concurrent = 0;
    let peak = 0;
    const slow = (label: string) => async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 150));
      concurrent--;
      return say(`report ${label}`);
    };
    mock.push(
      call("delegate_tasks", { tasks: [{ goal: "investigate subsystem A in depth" }, { goal: "investigate subsystem B in depth" }, { goal: "investigate subsystem C in depth" }] }),
      slow("1"),
      slow("2"),
      slow("3"),
      (req) => {
        const res = String(req.messages.at(-1)!.content);
        assert.match(res, /Sub-agent 1[\s\S]*report/);
        assert.match(res, /Sub-agent 3/);
        return say("combined");
      },
    );
    const parent = service.createAgent();
    const r = await parent.runTurn("research A, B and C");
    assert.equal(r.text, "combined");
    assert.ok(peak >= 2, `expected parallel sub-agents, peak=${peak}`);
    const children = service.store.listSessions({ includeChildren: true, limit: 100 }).filter((s) => s.parentId === parent.sessionId);
    assert.equal(children.length, 3);
  });

  test("scheduler runs due jobs, delivers to inbox and advances schedule", async () => {
    const job = service.store.addJob({ name: "disk report", schedule: "every 1h", prompt: "report disk usage", deliver: "inbox", nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const once = service.store.addJob({ name: "reminder", schedule: `at ${new Date(Date.now() - 500).toISOString()}`, prompt: "remind me", deliver: "inbox", nextRunAt: new Date(Date.now() - 500).toISOString() });
    mock.push((req) => {
      assert.match(String(req.messages[0]!.content), /Scheduled run/);
      return say("Disk C: 40% used");
    }, say("Reminder delivered"));
    await service.runJob(service.store.getJob(job.id)!);
    await service.runJob(service.store.getJob(once.id)!);
    const j = service.store.getJob(job.id)!;
    assert.equal(j.lastStatus, "ok");
    assert.ok(Date.parse(j.nextRunAt!) > Date.now() + 50 * 60_000);
    assert.equal(service.store.getJob(once.id)!.enabled, false);
    const inbox = service.store.listInbox(false, 10);
    assert.ok(inbox.some((i: any) => i.title.includes("disk report") && i.body.includes("40%")));
    assert.equal(service.store.jobRuns(job.id)[0].status, "ok");
  });
});

describe("Kestrel through the MCP bridge", () => {
  const t = tempDir();
  test("task start/status, memory and skills tools", async () => {
    const home = path.join(t.dir, "kestrel");
    saveKestrelConfig(KestrelConfigSchema.parse({ defaultProfile: "scripted", profiles: { scripted: { provider: "mock", model: "m" } }, agent: { autoReflect: false } }), home);
    process.env.KESTREL_HOME = home;
    const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
    const server = createMcpServer({ rt, extensions: [await kestrelBridgeExtension()] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
    try {
      const names = (await client.listTools()).tools.map((x) => x.name);
      assert.ok(names.includes("kestrel_task_start") && names.includes("kestrel_memory"));
      const started = text(await client.callTool({ name: "kestrel_task_start", arguments: { task: "say hello please" } }));
      const id = started.match(/task_[0-9a-f]+/)![0];
      const status = text(await client.callTool({ name: "kestrel_task_status", arguments: { task_id: id, wait_seconds: 20 } }));
      assert.match(status, /completed/);
      assert.match(status, /mock: no more scripted responses/);
      await client.callTool({ name: "kestrel_memory", arguments: { action: "save", content: "Owner's main GPU box is called ATLAS", kind: "environment" } });
      assert.match(text(await client.callTool({ name: "kestrel_memory", arguments: { action: "search", query: "GPU box" } })), /ATLAS/);
      await client.callTool({ name: "kestrel_skills", arguments: { action: "save", name: "Check GPU", description: "Check GPU health with nvidia-smi", body: "Run nvidia-smi and read temperature and utilisation columns." } });
      assert.match(text(await client.callTool({ name: "kestrel_skills", arguments: { action: "get", name: "check-gpu" } })), /nvidia-smi/);
      const sched = text(await client.callTool({ name: "kestrel_schedule", arguments: { action: "create", name: "morning", schedule: "daily 08:00", prompt: "summarise news" } }));
      assert.match(sched, /created job_/);
    } finally {
      await client.close();
      await rt.close();
      delete process.env.KESTREL_HOME;
      t.cleanup();
    }
  });
});

// Keep a reference so unused-import linting stays quiet when editing tests.
void writeFileSync;
