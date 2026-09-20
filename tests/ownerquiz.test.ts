import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { addQuestion, answerQuestion, askQuestion, clearVerification, isVerified, listQuestions, normaliseAnswer } from "../src/core/ownerQuiz.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { tempDir, testConfig } from "./helpers.js";

const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

test("owner quiz: the answer is never stored, and small differences still pass", () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  try {
    addQuestion("我最喜歡的飲料是什麼？", "珍珠奶茶", ["珍奶"]);
    const raw = readFileSync(path.join(t.dir, "owner-quiz.json"), "utf8");
    assert.ok(!raw.includes("珍珠奶茶") && !raw.includes("珍奶"), "the answer must not be on disk in any readable form");

    assert.ok(askQuestion());
    // Spacing, case and punctuation are levelled out: the owner is typing from memory, in a chat.
    assert.equal(answerQuestion(" 珍珠奶茶！").ok, true);
    assert.equal(isVerified(), true);

    clearVerification();
    assert.equal(isVerified(), false);
    askQuestion();
    assert.equal(answerQuestion("珍奶").ok, true, "an accepted alternative also passes");
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    t.cleanup();
  }
});

test("owner quiz: wrong answers run out of tries and never verify", () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  try {
    addQuestion("我養的貓叫什麼？", "黑糖");
    askQuestion();
    assert.deepEqual(answerQuestion("布丁"), { ok: false, reason: "that is not it", triesLeft: 2 });
    const second = answerQuestion("奶茶");
    assert.equal(second.ok, false);
    assert.equal(second.ok === false ? second.triesLeft : -1, 1);
    const last = answerQuestion("咖啡");
    assert.equal(last.ok, false);
    assert.equal(last.ok === false ? last.triesLeft : -1, 0);
    assert.equal(isVerified(), false);
    // With no question waiting, a lucky guess cannot unlock anything either.
    assert.equal(answerQuestion("黑糖").ok, false);
    assert.equal(isVerified(), false);
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    t.cleanup();
  }
});

test("owner quiz: normalisation levels out width, case and spacing", () => {
  assert.equal(normaliseAnswer("Ｂｕｂｂｌｅ Tea"), normaliseAnswer("bubbletea"));
  assert.equal(normaliseAnswer("台北 101。"), normaliseAnswer("台北101"));
});

test("owner quiz: protected actions wait for the owner, and the quiz tools stay reachable", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  const rt = await createRuntime({
    dataDir: t.dir,
    config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir }, policy: { askOwnerFor: ["execute"] } }),
    logger: silentLogger,
  });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    addQuestion("我住的城市？", "台北");

    const blocked = (await client.callTool({ name: "shell_run", arguments: { command: "echo hi" } })) as any;
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /owner_challenge/);
    // Reads are not in askOwnerFor, so they still work.
    assert.equal(((await client.callTool({ name: "computer_info", arguments: {} })) as any).isError, undefined);

    const challenge = (await client.callTool({ name: "owner_challenge", arguments: {} })) as any;
    assert.match(textOf(challenge), /我住的城市/);
    assert.match(textOf((await client.callTool({ name: "owner_answer", arguments: { answer: "台南" } })) as any), /not the answer/);
    assert.match(textOf((await client.callTool({ name: "owner_answer", arguments: { answer: "台北" } })) as any), /Correct/);

    const allowed = (await client.callTool({ name: "shell_run", arguments: { command: "echo hi" } })) as any;
    assert.equal(allowed.isError, undefined, textOf(allowed));
    // The answer itself must not end up in the audit log.
    assert.ok(!JSON.stringify(rt.audit.tail(20)).includes("台北"));
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});

// The owner may want the check on the two tools that physically drive the PC, and nowhere else.
test("owner quiz: a single tool can be gated without gating its whole effect", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  const rt = await createRuntime({
    dataDir: t.dir,
    config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir }, policy: { askOwnerForTools: ["mouse", "keyboard"] } }),
    logger: silentLogger,
  });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    addQuestion("我小時候的綽號？", "北鼻");
    const blocked = (await client.callTool({ name: "mouse", arguments: { action: "move", x: 10, y: 10 } })) as any;
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /owner_challenge/);
    // screen_capture is also a desktop tool, but it was not named, so it is not behind the check.
    assert.ok(!/identify themselves/.test(textOf((await client.callTool({ name: "shell_run", arguments: { command: "echo hi" } })) as any)));
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});

test("owner quiz: with no questions set up, nothing is blocked", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  const rt = await createRuntime({
    dataDir: t.dir,
    config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir }, policy: { askOwnerFor: ["execute"] } }),
    logger: silentLogger,
  });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.equal(listQuestions().length, 0);
    const r = (await client.callTool({ name: "shell_run", arguments: { command: "echo hi" } })) as any;
    assert.equal(r.isError, undefined, "a gate with no questions would lock the owner out of their own PC");
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
