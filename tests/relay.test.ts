import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { queueRelay } from "../src/bridge/relay.js";
import { cardOf, tempDir, testConfig } from "./helpers.js";

// The workbench page and the ChatGPT card run in different processes, so the queue lives in a file.
test("relay: the workbench queues a message, the card takes it once", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    // Nothing queued yet.
    assert.deepEqual(cardOf(await client.callTool({ name: "relay_poll", arguments: {} })).messages, []);

    queueRelay("把 hello.py 改成命令列工具");
    queueRelay("順便加測試");
    // Peeking does not consume.
    const peek = (await client.callTool({ name: "relay_poll", arguments: { take: false } })) as any;
    assert.equal(peek.structuredContent.pending, 2);

    const got = cardOf(await client.callTool({ name: "relay_poll", arguments: {} }));
    assert.deepEqual(got.messages, ["把 hello.py 改成命令列工具", "順便加測試"]);
    // Delivered once.
    assert.deepEqual(cardOf(await client.callTool({ name: "relay_poll", arguments: {} })).messages, []);
    // The card-only payload keeps the text out of the conversation.
    const after = (await client.callTool({ name: "relay_poll", arguments: {} })) as any;
    assert.equal(after.structuredContent.messages, undefined);
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
