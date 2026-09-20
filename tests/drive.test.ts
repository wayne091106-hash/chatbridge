import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { tempDir, testConfig } from "./helpers.js";

test("drive lane: send to 寄件 (files, folders, cleanup), list 收件, guide mentions it", async () => {
  const t = tempDir();
  const drive = path.join(t.dir, "Drive", "ChatBridge");
  mkdirSync(drive, { recursive: true });
  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir }, drive: { folder: drive, keepDays: 7 } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
  try {
    const outbox = path.join(drive, "寄件");
    const inbox = path.join(drive, "收件");
    // An old leftover in 寄件 gets cleaned up on the next send.
    mkdirSync(outbox, { recursive: true });
    const stale = path.join(outbox, "old.txt");
    writeFileSync(stale, "old");
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(stale, tenDaysAgo, tenDaysAgo);

    writeFileSync(path.join(t.dir, "render.mp4"), "video-bytes");
    mkdirSync(path.join(t.dir, "build", "assets"), { recursive: true });
    writeFileSync(path.join(t.dir, "build", "assets", "a.png"), "png");
    const sent = text(await client.callTool({ name: "drive_send", arguments: { paths: ["render.mp4", "build"], subfolder: "今天的成果" } }));
    assert.match(sent, /copied 2 item/);
    assert.match(sent, /cleaned up 1 item/);
    assert.equal(readFileSync(path.join(outbox, "今天的成果", "render.mp4"), "utf8"), "video-bytes");
    assert.ok(existsSync(path.join(outbox, "今天的成果", "build", "assets", "a.png")));
    assert.ok(!existsSync(stale));
    // Same name again → numbered copy, nothing overwritten.
    await client.callTool({ name: "drive_send", arguments: { paths: ["render.mp4"], subfolder: "今天的成果" } });
    assert.ok(existsSync(path.join(outbox, "今天的成果", "render (2).mp4")));

    assert.match(text(await client.callTool({ name: "drive_inbox", arguments: {} })), /is empty/);
    writeFileSync(path.join(inbox, "手機拍的.jpg"), "jpg");
    assert.match(text(await client.callTool({ name: "drive_inbox", arguments: {} })), /手機拍的\.jpg/);

    assert.match(text(await client.callTool({ name: "chatbridge_guide", arguments: {} })), /drive_send/);
  } finally {
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
