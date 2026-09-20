import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRuntime, type Runtime } from "../src/core/runtime.js";
import { saveConfig } from "../src/core/config.js";
import { silentLogger } from "../src/core/logger.js";
import { startHttpBridge, type HttpBridge } from "../src/bridge/http.js";
import { hashPassword, generateTotpSecret, totp } from "../src/bridge/secrets.js";
import { sha256 } from "../src/core/util.js";
import { freePort, hasCodex, tempDir, testConfig } from "./helpers.js";

const PASS = "TEST-PASS-PHRASE-1234";
const ADMIN = "admin-token-for-tests";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const textOf = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");

describe("bridge over HTTP with OAuth", () => {
  const t = tempDir();
  let rt: Runtime;
  let bridge: HttpBridge;
  let base: string;
  let totpSecret: string;

  before(async () => {
    const port = await freePort();
    totpSecret = generateTotpSecret();
    const cfg = testConfig({
      server: { port },
      auth: { mode: "oauth", ownerPasswordHash: hashPassword(PASS), totpSecret, adminTokenHash: sha256(ADMIN) },
      executor: { kind: hasCodex ? "codex" : "node" },
      shell: { cwd: t.dir },
    });
    rt = await createRuntime({ dataDir: t.dir, config: cfg, logger: silentLogger });
    bridge = await startHttpBridge(rt);
    base = `http://localhost:${port}`;
  });

  after(async () => {
    await bridge.close();
    await rt.close();
    t.cleanup();
  });

  const register = async (redirect: string) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT test", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });

  let accessToken = "";
  let refreshToken = "";
  let clientId = "";

  test("metadata endpoints and 401 challenge", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.code_challenge_methods_supported[0], "S256");
    assert.ok(as.registration_endpoint);
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  test("DCR rejects redirect hosts outside the allowlist", async () => {
    const r = await register("https://evil.example.com/callback");
    assert.equal(r.status, 400);
  });

  test("full authorization code + PKCE flow with owner passphrase and TOTP", async () => {
    const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const reg = await register(redirect);
    assert.equal(reg.status, 201);
    clientId = (await reg.json()).client_id;
    const { verifier, challenge } = pkce();
    const authUrl = `${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "computer" })}`;
    const page = await fetch(authUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /ChatGPT test/);
    const request = html.match(/name="request" value="([^"]+)"/)![1]!;
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;

    const post = (body: Record<string, string>) =>
      fetch(`${base}/oauth/consent`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

    const wrong = await post({ request, csrf, password: "wrong", totp: totp(totpSecret), decision: "approve" });
    assert.equal(wrong.status, 401);
    const badCsrf = await post({ request, csrf: "nope", password: PASS, totp: totp(totpSecret), decision: "approve" });
    assert.equal(badCsrf.status, 400);
    const ok = await post({ request, csrf, password: PASS, totp: totp(totpSecret), decision: "approve" });
    assert.equal(ok.status, 302);
    const loc = new URL(ok.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, redirect);
    assert.equal(loc.searchParams.get("state"), "xyz");
    const code = loc.searchParams.get("code")!;

    const tokenReq = (body: Record<string, string>) => fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const badVerifier = await tokenReq({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: redirect });
    assert.equal(badVerifier.status, 400);
    const tok = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect });
    assert.equal(tok.status, 200);
    const tokens = await tok.json();
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    assert.match(accessToken, /^cba_/);
    const reuse = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect });
    assert.equal(reuse.status, 400, "authorization codes are single-use");
  });

  test("MCP tools over authenticated streamable HTTP", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    const tools = (await client.listTools()).tools.map((x) => x.name);
    for (const name of ["shell_run", "shell_read", "fs_read", "fs_write", "fs_edit", "apply_patch", "fs_search", "screen_capture", "mouse", "keyboard", "computer_info"]) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    const run = await client.callTool({ name: "shell_run", arguments: { command: "Write-Output bridge-works" } });
    assert.match(textOf(run), /exit 0[\s\S]*bridge-works/);

    await client.callTool({ name: "fs_write", arguments: { path: "notes/hello.md", content: "# hi\nsecond\n" } });
    const read = await client.callTool({ name: "fs_read", arguments: { path: "notes/hello.md" } });
    assert.match(textOf(read), /1\t# hi\n2\tsecond/);
    const edit = await client.callTool({ name: "fs_edit", arguments: { path: "notes/hello.md", old_string: "second", new_string: "2nd" } });
    assert.ok(!edit.isError);
    const cps = await client.callTool({ name: "fs_checkpoints", arguments: { action: "undo" } });
    assert.ok(!cps.isError, textOf(cps));
    // Only the last call (the edit) is reverted; the earlier write stays.
    const afterUndo = await client.callTool({ name: "fs_read", arguments: { path: "notes/hello.md" } });
    assert.match(textOf(afterUndo), /2\tsecond/);
    const list = await client.callTool({ name: "fs_checkpoints", arguments: { action: "list" } });
    assert.equal(JSON.parse(textOf(list)).checkpoints.length, 1);

    const err = await client.callTool({ name: "fs_read", arguments: { path: "missing/file.txt" } });
    assert.equal(err.isError, true);

    const info = await client.callTool({ name: "computer_info", arguments: {} });
    assert.match(textOf(info), /"executor"/);
    await client.close();
  });

  test("kill switch refuses tool calls and is audited", async () => {
    rt.state.setPaused(true, "test pause");
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    const r = await client.callTool({ name: "shell_run", arguments: { command: "Write-Output nope" } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /paused/);
    rt.state.setPaused(false);
    await client.close();
    const tail = rt.audit.tail(20);
    assert.ok(tail.some((x) => x.outcome === "paused" && x.action === "shell_run"));
    assert.ok(tail.some((x) => x.actor === clientId && x.action === "shell_run" && x.outcome === "ok"));
    assert.equal(rt.audit.verify().ok, true);
  });

  test("refresh token rotation and reuse detection", async () => {
    const tokenReq = (body: Record<string, string>) => fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const r1 = await tokenReq({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    assert.equal(r1.status, 200);
    const t1 = await r1.json();
    assert.notEqual(t1.refresh_token, refreshToken);
    const replay = await tokenReq({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    assert.equal(replay.status, 400);
    // The whole family is revoked after reuse, including the new access token.
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t1.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(mcp.status, 401);
  });

  test("admin API requires token and rejects forwarded requests; host validation", async () => {
    assert.equal((await fetch(`${base}/admin/api/status`)).status, 401);
    const ok = await fetch(`${base}/admin/api/status`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).authMode, "oauth");
    const fwd = await fetch(`${base}/admin/api/status`, { headers: { Authorization: `Bearer ${ADMIN}`, "X-Forwarded-For": "1.2.3.4" } });
    assert.equal(fwd.status, 404);
    const page = await fetch(`${base}/admin/`);
    assert.equal(page.status, 200);
    // fetch() cannot override Host, so use node:http for the DNS-rebinding check.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/healthz`, { headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe("bridge over stdio (tunnel-client / Claude Desktop mode)", () => {
  const t = tempDir();
  test("lists tools and runs a command", async () => {
    saveConfig(testConfig({ auth: { mode: "none" }, executor: { kind: hasCodex ? "codex" : "node" }, shell: { cwd: t.dir }, features: { agent: false } }), t.dir);
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "bridge", "cli.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", cli, "stdio"],
      env: { ...(process.env as Record<string, string>), CHATBRIDGE_HOME: t.dir, LOG_LEVEL: "error" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 15);
    const r = await client.callTool({ name: "shell_run", arguments: { command: "Write-Output stdio-ok" } });
    assert.match(textOf(r), /stdio-ok/);
    await client.close();
    t.cleanup();
  });
});
