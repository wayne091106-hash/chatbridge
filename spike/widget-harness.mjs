// Renders ChatBridge cards in a normal browser with a mock window.openai that forwards tool
// calls to a real ChatBridge MCP server. Usage: node spike/widget-harness.mjs [port]
import http from "node:http";
import { createReadStream, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime } from "../dist/src/core/runtime.js";
import { BridgeConfigSchema } from "../dist/src/core/config.js";
import { createLogger } from "../dist/src/core/logger.js";
import { createMcpServer } from "../dist/src/bridge/tools.js";

const port = Number(process.argv[2] ?? 18990);
const home = mkdtempSync(path.join(os.tmpdir(), "widget-harness-"));
process.env.CHATBRIDGE_HOME = home;
const rt = await createRuntime({ dataDir: home, config: BridgeConfigSchema.parse({ executor: { kind: "codex" }, logLevel: "warn", shell: { cwd: os.homedir() } }), logger: createLogger("warn") });
const server = createMcpServer({ rt });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "harness", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools;
const log = [];

function mock(output, meta) {
  return `<script>
window.__log=[];window.openai={theme:new URLSearchParams(location.search).get('theme')||'light',displayMode:'inline',toolOutput:${JSON.stringify(output)},toolResponseMetadata:${JSON.stringify(meta ?? null)},widgetState:null,setWidgetState(s){this.widgetState=s},
callTool:async(n,a)=>{const r=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,arguments:a})});return r.json()},
sendFollowUpMessage:async(p)=>{window.__log.push('followup:'+p.prompt);await fetch('/log',{method:'POST',body:'followup: '+p.prompt})},
requestDisplayMode:async(m)=>{window.__log.push('display:'+m.mode);await fetch('/log',{method:'POST',body:'display: '+m.mode})},
uploadFile:async(f)=>{const buf=await f.arrayBuffer();await fetch('/log',{method:'POST',body:'uploadFile '+f.name+' '+buf.byteLength});return{fileId:'file_mock_'+buf.byteLength}},
getFileDownloadUrl:async({fileId})=>({downloadUrl:location.origin+'/download?fileId='+fileId})};
</script>`;
}

let lastOfferPath = null;
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === "/call" && req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const { name, arguments: args } = JSON.parse(body);
        const r = await client.callTool({ name, arguments: args });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(r));
      }
      if (url.pathname === "/log") {
        let body = "";
        for await (const c of req) body += c;
        log.push(body);
        return res.end("ok");
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(log));
      }
      if (url.pathname === "/download") {
        // Simulates ChatGPT's file storage: serves the file that was offered.
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(lastOfferPath).size });
        return createReadStream(lastOfferPath).pipe(res);
      }
      if (url.pathname === "/card") {
        const name = url.searchParams.get("tool");
        const args = JSON.parse(url.searchParams.get("args") ?? "{}");
        if (name === "xfer_offer") lastOfferPath = rt.files.resolve(args.path);
        const tool = tools.find((t) => t.name === name);
        const uri = tool?._meta?.["openai/outputTemplate"];
        if (!uri) throw new Error(`${name} has no card`);
        const r = await client.callTool({ name, arguments: args });
        const html = String((await client.readResource({ uri })).contents[0].text);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html.replace("<head>", `<head>${mock({ structuredContent: r.structuredContent }, r._meta)}`));
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err?.stack ?? err));
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`harness http://127.0.0.1:${port}/card?tool=...&args=...  (home ${home})`));
