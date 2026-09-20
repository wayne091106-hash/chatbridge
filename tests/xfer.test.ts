import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { XFER_WIDGET_URI } from "../src/bridge/xfer.js";
import { cardOf, tempDir, testConfig } from "./helpers.js";

test("file transfer tools: fileParams download, chunks, embedded resource, upload card", async () => {
  const t = tempDir();
  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
  const payload = randomBytes(3 * 1024 * 1024 + 123);
  const sha = createHash("sha256").update(payload).digest("hex");
  // Stand-in for ChatGPT's file storage: serves the payload at a download URL.
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/file`;
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const json = (r: any) => JSON.parse(r.content[0].text);
  const created: string[] = [];
  try {
    const tools = (await client.listTools()).tools;
    const recv = tools.find((x) => x.name === "xfer_receive")!;
    assert.deepEqual((recv._meta as any)["openai/fileParams"], ["file"]);
    assert.deepEqual((recv.inputSchema as any).properties.file.required, ["download_url", "file_id"]);
    const offer = tools.find((x) => x.name === "xfer_offer")!;
    assert.equal((offer._meta as any)["openai/outputTemplate"], XFER_WIDGET_URI);
    assert.equal((tools.find((x) => x.name === "xfer_read_chunk")!._meta as any)["openai/widgetAccessible"], true);
    const res = await client.readResource({ uri: XFER_WIDGET_URI });
    assert.equal(res.contents[0]!.mimeType, "text/html;profile=mcp-app");
    assert.match(String((res.contents[0] as any).text), /uploadFile/);

    // GPT → PC via download URL
    const r1 = json(await client.callTool({ name: "xfer_receive", arguments: { file: { download_url: url, file_id: "file_123", file_name: "data.bin" }, folder: t.dir } }));
    created.push(r1.saved_to);
    assert.equal(r1.bytes, payload.length);
    assert.equal(r1.sha256, sha);
    assert.deepEqual(readFileSync(r1.saved_to), payload);

    // GPT → PC via base64 chunks (out of order)
    const small = randomBytes(300_000);
    const parts = [small.subarray(0, 100_000), small.subarray(100_000, 200_000), small.subarray(200_000)];
    for (const i of [2, 0, 1]) {
      const r = await client.callTool({ name: "xfer_receive_chunk", arguments: { transfer_id: "tx1", name: "chunked.bin", index: i, total: 3, data_base64: parts[i]!.toString("base64") } });
      if (i !== 1) assert.match((r.content as any)[0].text, /received/);
      else {
        const done = json(r);
        created.push(done.saved_to);
        assert.equal(done.sha256, createHash("sha256").update(small).digest("hex"));
      }
    }

    // PC → GPT via embedded resource
    const local = path.join(t.dir, "hello.txt");
    writeFileSync(local, "hello from the PC");
    const r3 = await client.callTool({ name: "xfer_send", arguments: { path: local } });
    const blob = (r3.content as any)[1].resource.blob;
    assert.equal(Buffer.from(blob, "base64").toString(), "hello from the PC");

    // PC → GPT upload card: metadata + chunk reads reassemble the file
    const bigLocal = path.join(t.dir, "big.bin");
    writeFileSync(bigLocal, payload);
    const card = await client.callTool({ name: "xfer_offer", arguments: { path: bigLocal } });
    const meta = (card as any).structuredContent;
    assert.equal(meta.size, payload.length);
    assert.equal(meta.sha256, sha);
    const chunks: Buffer[] = [];
    for (let off = 0; off < meta.size; ) {
      const c = (await client.callTool({ name: "xfer_read_chunk", arguments: { path: bigLocal, offset: off, length: meta.chunk } })) as any;
      assert.equal(c.structuredContent.data_base64, undefined, "file bytes must stay out of the conversation");
      const buf = Buffer.from(cardOf(c).data_base64, "base64");
      chunks.push(buf);
      off += buf.length;
    }
    assert.deepEqual(Buffer.concat(chunks), payload);
    const v = (await client.callTool({ name: "xfer_verify_url", arguments: { download_url: url, expected_sha256: sha } })) as any;
    assert.equal(cardOf(v).match, true);

    // tool result size probe
    const echo = await client.callTool({ name: "xfer_echo", arguments: { kb: 64, card_only: false } });
    assert.match((echo.content as any)[0].text, /\[k000064\]/);
    // Default: the payload rides in card-only _meta and the conversation gets a short receipt.
    const probe = (await client.callTool({ name: "xfer_echo", arguments: { kb: 2048 } })) as any;
    assert.ok(probe.content[0].text.length < 400);
    assert.match(cardOf(probe).payload, /\[k002048\]/);
  } finally {
    await client.close();
    srv.close();
    await rt.close();
    t.cleanup();
    void os;
  }
});
