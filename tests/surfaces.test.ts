import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRuntime, type Runtime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { sha256 } from "../src/core/util.js";
import { KestrelConfigSchema } from "../src/agent/config.js";
import { KestrelService } from "../src/agent/service.js";
import { MockProvider, call, say } from "../src/agent/providers/mock.js";
import { startWebUi } from "../src/agent/web.js";
import { TelegramGateway, splitMessage, type TelegramApi } from "../src/agent/telegram.js";
import { main as kestrelMain } from "../src/agent/cli.js";
import { tempDir, testConfig } from "./helpers.js";

const TOKEN = "web-test-token";

describe("web UI API", () => {
  const t = tempDir();
  let rt: Runtime;
  let s: KestrelService;
  let web: Awaited<ReturnType<typeof startWebUi>>;
  const mock = new MockProvider();

  before(async () => {
    rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
    const config = KestrelConfigSchema.parse({ agent: { autoReflect: false }, web: { tokenHash: sha256(TOKEN) } });
    s = await KestrelService.create({ home: path.join(t.dir, "k"), config, runtime: rt, provider: mock });
    web = await startWebUi(s, { port: 0 });
  });
  after(async () => {
    await web.close();
    await s.close();
    await rt.close();
    t.cleanup();
  });

  const api = (p: string, init: RequestInit = {}) => fetch(`${web.url}api/${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

  test("auth, page, state", async () => {
    assert.equal((await fetch(`${web.url}api/state`)).status, 401);
    const page = await fetch(web.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Kestrel/);
    const st = await (await api("state")).json();
    assert.equal(st.model, "mock/mock-1");
  });

  test("streaming chat turn with tool call, then session detail", async () => {
    mock.push(call("write_file", { path: "web.txt", content: "from web" }), say("wrote it"));
    const res = await api("chat", { method: "POST", body: JSON.stringify({ message: "write web.txt" }) });
    assert.equal(res.status, 200);
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const sessionId = events.find((e) => e.type === "session").sessionId;
    assert.ok(events.some((e) => e.type === "tool_end" && e.name === "write_file" && e.ok));
    assert.equal(events.find((e) => e.type === "turn_end").text, "wrote it");
    const detail = await (await api(`sessions/${sessionId}`)).json();
    assert.equal(detail.messages.length, 4);
    const list = await (await api("sessions")).json();
    assert.ok(list.sessions.some((x: any) => x.id === sessionId && x.source === "web"));
    const undo = await (await api(`sessions/${sessionId}/undo`, { method: "POST", body: "{}" })).json();
    assert.equal(undo.restored.length, 1);
  });

  test("memory, skills, jobs, inbox endpoints", async () => {
    const m = await (await api("memories", { method: "POST", body: JSON.stringify({ content: "Owner prefers dark mode everywhere", kind: "preference" }) })).json();
    const found = await (await api("memories?q=dark%20mode")).json();
    assert.equal(found.memories[0].id, m.id);
    assert.equal((await (await api(`memories/${m.id}`, { method: "DELETE" })).json()).archived, true);
    await api("skills/x", { method: "PUT", body: JSON.stringify({ name: "Web skill", description: "A skill created from the web UI", body: "Step one, step two, step three and verify." }) });
    const skills = (await (await api("skills")).json()).skills;
    assert.ok(skills.some((k: any) => k.name === "Web skill"));
    assert.ok(skills.some((k: any) => k.origin === "bundled"), "bundled skills are installed on first start");
    const job = await (await api("jobs", { method: "POST", body: JSON.stringify({ name: "j", schedule: "every 10m", prompt: "check things" }) })).json();
    const bad = await api("jobs", { method: "POST", body: JSON.stringify({ name: "j", schedule: "whenever", prompt: "x" }) });
    assert.equal(bad.status, 400);
    const toggled = await (await api(`jobs/${job.id}/toggle`, { method: "POST", body: "{}" })).json();
    assert.equal(toggled.enabled, false);
    s.store.addInbox("hello", "world", "test");
    assert.equal((await (await api("inbox")).json()).items[0].title, "hello");
  });
});

describe("telegram gateway", () => {
  const t = tempDir();
  test("allowlist, commands, conversation and notifications", async () => {
    const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
    const mock = new MockProvider([say("hi from Kestrel"), say("second turn"), say("fresh start")]);
    const s = await KestrelService.create({ home: path.join(t.dir, "k"), config: KestrelConfigSchema.parse({ agent: { autoReflect: false } }), runtime: rt, provider: mock });
    const sent: Array<{ method: string; body: any }> = [];
    const api: TelegramApi = { call: async (method, body) => void sent.push({ method, body }) };
    const gw = new TelegramGateway(s, api, new Set([42]));
    const msg = (from: number, text: string) => ({ update_id: 1, message: { chat: { id: from }, from: { id: from }, text } });
    const texts = () => sent.filter((x) => x.method === "sendMessage").map((x) => x.body.text);
    try {
      await gw.handle(msg(7, "hack the planet"));
      assert.equal(texts().length, 0, "strangers are ignored");
      assert.ok(rt.audit.tail(5).some((r) => r.actor === "telegram:7" && r.outcome === "denied"));
      await gw.handle(msg(42, "/help"));
      assert.match(texts().at(-1)!, /\/new/);
      await gw.handle(msg(42, "hello"));
      assert.equal(texts().at(-1), "hi from Kestrel");
      await gw.handle(msg(42, "again"));
      const second = mock.requests.at(-1)!;
      assert.ok(second.messages.some((m) => m.content === "hi from Kestrel"), "same conversation continues");
      await gw.handle(msg(42, "/new"));
      await gw.handle(msg(42, "new topic"));
      assert.ok(!mock.requests.at(-1)!.messages.some((m) => m.content === "hi from Kestrel"), "/new starts fresh");
      await gw.notifyOwners("⏰ report", "all good");
      assert.equal(sent.at(-1)!.body.chat_id, 42);
      assert.match(texts().at(-1)!, /report\n\nall good/);
      const parts = splitMessage("a".repeat(5000) + "\n\n" + "b".repeat(100));
      assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 3900));
    } finally {
      await s.close();
      await rt.close();
      t.cleanup();
    }
  });
});

describe("kestrel CLI", () => {
  const t = tempDir();
  test("jobs add/list, memory add/search, profile, sessions export", async () => {
    process.env.KESTREL_HOME = path.join(t.dir, "k");
    process.env.CHATBRIDGE_HOME = t.dir;
    const { saveConfig } = await import("../src/core/config.js");
    saveConfig(testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), t.dir);
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await kestrelMain(["jobs", "add", "--name", "news", "--schedule", "weekdays 08:30", "--prompt", "summarise tech news"]);
      await kestrelMain(["jobs", "list"]);
      await kestrelMain(["memory", "add", "The", "NAS", "is", "at", "192.168.1.20", "--kind", "environment"]);
      await kestrelMain(["memory", "search", "NAS", "address"]);
      await kestrelMain(["profile", "set", "name", "Tester"]);
      await kestrelMain(["sessions", "export", "--out", path.join(t.dir, "x.jsonl")]);
    } finally {
      (process.stdout as any).write = origWrite;
      delete process.env.KESTREL_HOME;
      delete process.env.CHATBRIDGE_HOME;
    }
    const outText = lines.join("");
    assert.match(outText, /added job_/);
    assert.match(outText, /cron "30 8 \* \* 1-5"/);
    assert.match(outText, /192\.168\.1\.20/);
    assert.match(outText, /name: Tester/);
    assert.match(outText, /exported 0 sessions/);
    t.cleanup();
  });
});
