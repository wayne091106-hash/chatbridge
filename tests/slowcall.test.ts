import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { tempDir, testConfig } from "./helpers.js";

// ChatGPT abandons a tool call after ~60 s, so ChatBridge answers earlier with a ticket and keeps working.
test("slow calls answer with a ticket and op_status picks the result up", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_SLOW_CALL_SECONDS = "1";
  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
  try {
    const parked = text(await client.callTool({ name: "shell_run", arguments: { command: "Start-Sleep -Seconds 4; Write-Output slow-done", yield_seconds: 10 } }));
    assert.match(parked, /still running on the PC \(ticket op/);
    assert.doesNotMatch(parked, /slow-done/);
    const id = parked.match(/ticket (op\w+)/)![1]!;

    // Still busy right away…
    assert.match(text(await client.callTool({ name: "op_status", arguments: { id } })), /still running/);
    // …and the real result arrives when the work finishes.
    const done = text(await client.callTool({ name: "op_status", arguments: { id, wait_seconds: 20 } }));
    assert.match(done, /shell_run finished after \d+s/);
    assert.match(done, /slow-done/);
    // A ticket is collected once.
    const gone = await client.callTool({ name: "op_status", arguments: { id } });
    assert.equal(gone.isError, true);
  } finally {
    delete process.env.CHATBRIDGE_SLOW_CALL_SECONDS;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
