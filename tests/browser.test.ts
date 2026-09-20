import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findChrome } from "../src/core/chrome.js";
import { closeBrowser } from "../src/bridge/browser.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { freePort, tempDir, testConfig } from "./helpers.js";

// The browser tools need a real Chrome. Everything is served from this process, so no network is involved.
const chrome = findChrome();
const skip = !chrome || process.env.SKIP_BROWSER === "1" ? "no Chrome on this machine" : false;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test shop</title></head><body>
<main>
  <h1>Test shop</h1>
  <p>Welcome to the shop. We sell exactly one thing.</p>
  <form action="/results" method="get">
    <input name="q" placeholder="What are you looking for?">
    <button type="submit">Search</button>
  </form>
  <a href="/about">About us</a>
  <button id="counter" onclick="document.getElementById('out').textContent='clicked ' + (++window.n||1)">Press me</button>
  <div id="out">not clicked</div>
</main></body></html>`;

let server: http.Server;
let base = "";
let rt: Awaited<ReturnType<typeof createRuntime>>;
let client: Client;
let t: { dir: string; cleanup: () => void };

before(async () => {
  if (skip) return;
  const port = await freePort();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/results") res.end(`<!doctype html><title>Results</title><main><h1>Results for ${url.searchParams.get("q")}</h1></main>`);
    else if (url.pathname === "/about") res.end("<!doctype html><title>About</title><main><h1>About us</h1><p>We are a test.</p></main>");
    else res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;

  t = tempDir();
  process.env.CHATBRIDGE_HOME = t.dir;
  rt = await createRuntime({
    dataDir: t.dir,
    config: testConfig({ executor: { kind: "node" }, shell: { cwd: t.dir }, browser: { port: await freePort(), headless: true } }),
    logger: silentLogger,
  });
  const mcp = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "1" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
});

after(async () => {
  if (skip) return;
  // The browser socket keeps the event loop alive, so the run would never end without this.
  await closeBrowser(true);
  await client?.close();
  await rt?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  delete process.env.CHATBRIDGE_HOME;
  t?.cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as any;
  const text = (r.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  if (r.isError) throw new Error(text);
  return text;
};

test("browser: open a page and list what can be acted on", { skip }, async () => {
  const out = await call("browser_open", { url: base });
  assert.match(out, /Test shop/);
  assert.match(out, /Press me/, "a button should show up with its label");
  assert.match(out, /What are you looking for\?/, "an input should show up by its placeholder");
  assert.match(out, /We sell exactly one thing/, "the page text comes back too");
});

test("browser: click by visible text, without needing a ref", { skip }, async () => {
  await call("browser_navigate", { to: base });
  const out = await call("browser_click", { text: "Press me" });
  assert.match(out, /clicked 1/, "the page reacted to the click");
});

test("browser: a link takes you to the new page", { skip }, async () => {
  await call("browser_navigate", { to: base });
  const out = await call("browser_click", { text: "About us" });
  assert.match(out, /\/about/);
  assert.match(out, /We are a test/);
});

test("browser: type into a field and submit it", { skip }, async () => {
  await call("browser_navigate", { to: base });
  const snapshot = await call("browser_snapshot", {});
  const ref = /\s(e\d+)\s+input/.exec(snapshot)?.[1];
  assert.ok(ref, `expected an input in:\n${snapshot}`);
  const out = await call("browser_type", { ref, text: "a teapot", submit: true });
  assert.match(out, /Results for a teapot/, "the form went somewhere");
});

test("browser: refs point at the element, so a stale one is refused rather than clicking the wrong thing", { skip }, async () => {
  await call("browser_navigate", { to: base });
  await call("browser_snapshot", {});
  await call("browser_navigate", { to: `${base}/about` });
  await assert.rejects(() => call("browser_click", { ref: "e99" }), /not on the page/);
});

test("browser: reading the page and running an expression", { skip }, async () => {
  await call("browser_navigate", { to: base });
  assert.equal((await call("browser_eval", { expression: "document.title" })).trim(), "Test shop");
  const tabs = await call("browser_tabs", {});
  assert.match(tabs, /127\.0\.0\.1/);
});
