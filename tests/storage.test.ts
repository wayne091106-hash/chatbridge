import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { objectStore, saveStoreConfig } from "../src/core/objectStore.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { XFER_WIDGET_URI } from "../src/bridge/xfer.js";
import { cardOf, tempDir, testConfig } from "./helpers.js";

test("object storage fast path: staged upload, presigned download, bucket setup, card CSP", async () => {
  const t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  // A tiny S3 stand-in: stores PUT objects, serves presigned GETs, accepts bucket config.
  const objects = new Map<string, Buffer>();
  const seen: string[] = [];
  const s3 = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://x");
    seen.push(`${req.method} ${url.pathname}${url.search.includes("cors") ? "?cors" : url.search.includes("lifecycle") ? "?lifecycle" : ""}`);
    if (req.method === "PUT" && url.search) return res.writeHead(200).end();
    if (req.method === "PUT") {
      assert.match(String(req.headers.authorization), /^AWS4-HMAC-SHA256 /);
      objects.set(url.pathname, Buffer.concat(chunks));
      return res.writeHead(200).end();
    }
    if (req.method === "GET") {
      assert.ok(url.searchParams.get("X-Amz-Signature"), "download link must be presigned");
      const body = objects.get(url.pathname);
      return body ? res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end(body) : res.writeHead(404).end();
    }
    if (req.method === "DELETE") {
      objects.delete(url.pathname);
      return res.writeHead(204).end();
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(s3.address() as any).port}`;
  saveStoreConfig({ endpoint, bucket: "xfer", accessKeyId: "AKTEST", secretAccessKey: "secret", region: "auto" });

  const rt = await createRuntime({ dataDir: t.dir, config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir } }), logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const store = objectStore()!;
    assert.deepEqual((await store.setupBucket()).length, 2);
    assert.ok(seen.includes("PUT /xfer?cors") && seen.includes("PUT /xfer?lifecycle"));

    // The card declares the store origin so the browser may download from it.
    const card = await client.readResource({ uri: XFER_WIDGET_URI });
    assert.deepEqual((card.contents[0] as any)._meta["openai/widgetCSP"].connect_domains, [endpoint]);
    // Apps built against an older card version still get the current card.
    const old = await client.readResource({ uri: "ui://chatbridge/xfer-upload-0000000000.html" });
    assert.match(String((old.contents[0] as any).text), /xfer_stage/);

    const payload = randomBytes(5 * 1024 * 1024 + 7);
    const file = path.join(t.dir, "report.pdf");
    writeFileSync(file, payload);
    const offer = (await client.callTool({ name: "xfer_offer", arguments: { path: file } })) as any;
    assert.ok(offer.structuredContent.stage, "offer starts a staged upload");
    assert.equal(offer.structuredContent.typeWarning, "");
    let st: any;
    for (let i = 0; i < 50; i++) {
      st = await client.callTool({ name: "xfer_stage", arguments: { id: offer.structuredContent.stage } });
      if (st.structuredContent.state !== "uploading") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st.structuredContent.state, "ready");
    assert.equal(st.structuredContent.url, undefined, "the link only goes to the card");
    const got = Buffer.from(await (await fetch(cardOf(st).url)).arrayBuffer());
    assert.ok(got.equals(payload));

    // Unknown binary types carry a warning for the card.
    const bin = path.join(t.dir, "blob.bin");
    writeFileSync(bin, "x");
    const w = (await client.callTool({ name: "xfer_offer", arguments: { path: bin } })) as any;
    assert.match(w.structuredContent.typeWarning, /\.bin/);

    // Built-in round-trip check used by `chatbridge storage test`.
    const r = await store.selfTest(file);
    assert.equal(r.ok, true);
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    s3.close();
    t.cleanup();
  }
});
