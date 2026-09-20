/**
 * The workbench as a local web page (http://127.0.0.1:<port>/workbench). Same UI as the card in ChatGPT,
 * but in a window you control: full size, no host limits, and a live feed of everything ChatGPT does on
 * this PC. The page talks to the very same MCP tools through a loopback-only endpoint.
 */
import type { Express, Request, Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, type BridgeConfig } from "../core/config.js";
import type { Runtime } from "../core/runtime.js";
import { errorMessage, randomToken, safeEqual, sha256 } from "../core/util.js";
import { AGENT_PANEL_HTML } from "./widgets.js";
import { createMcpServer, type ToolContext } from "./tools.js";
import { takeRelay, queueRelay } from "./relay.js";

/** One long-lived in-process MCP client, so the page uses exactly the tools ChatGPT uses. */
async function localClient(rt: Runtime, extensions: ToolContext["extensions"]) {
  const server = createMcpServer({ rt, extensions, actor: "workbench" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chatbridge-workbench", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const shim = (token: string, boot: unknown) => `<script>
window.WB_LOCAL=true;
const WB_TOKEN=${JSON.stringify(token)};
const BOOT=${JSON.stringify(boot)};
const post=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+WB_TOKEN},body:JSON.stringify(b)}).then(r=>r.json());
window.openai={
 theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',
 displayMode:'fullscreen',
 toolOutput:{structuredContent:BOOT.structuredContent},
 toolResponseMetadata:BOOT._meta,
 widgetState:(()=>{try{return JSON.parse(localStorage.getItem('wb')||'null')}catch(e){return null}})(),
 setWidgetState(s){try{localStorage.setItem('wb',JSON.stringify(s))}catch(e){}this.widgetState=s},
 async callTool(name,args){const r=await post('/workbench/api/tool',{name,arguments:args});if(r&&r.error)throw new Error(r.error);return r},
 async requestDisplayMode(){return{mode:'fullscreen'}},
 async sendFollowUpMessage(p){await post('/workbench/api/relay',{text:p.prompt});window.dispatchEvent(new CustomEvent('wb:relayed',{detail:p.prompt}))}
};
</script>`;

/** Small panel (local page only) showing what ChatGPT is doing on the PC right now. */
const FEED = `<script>
(function(){const el=document.createElement('div');el.id='feed';
 el.innerHTML='<div class="fh"><b>ChatGPT 在這台電腦上的動作</b><button class="ib" id="feedx" title="收合">–</button></div><div class="fl" id="feedlist"></div>';
 const css=document.createElement('style');css.textContent='#feed{position:fixed;right:14px;bottom:14px;width:330px;max-height:42vh;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.28);z-index:50;overflow:hidden;font-size:12.5px}'+
  '#feed.min .fl{display:none}#feed .fh{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line)}#feed .fh b{flex:1;font-size:12.5px}'+
  '#feed .fl{overflow:auto;padding:6px}#feed .fi{display:flex;gap:8px;padding:4px 6px;border-radius:8px}#feed .fi:hover{background:var(--hover)}'+
  '#feed .t{color:var(--faint);font-variant-numeric:tabular-nums}#feed .n{font-family:var(--mono)}#feed .a{flex:1;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
 document.head.appendChild(css);document.body.appendChild(el);
 document.getElementById('feedx').onclick=()=>el.classList.toggle('min');
 const list=document.getElementById('feedlist');
 const es=new EventSource('/workbench/api/events?t='+encodeURIComponent(WB_TOKEN));
 es.onmessage=e=>{try{const a=JSON.parse(e.data);const d=document.createElement('div');d.className='fi';
  d.innerHTML='<span class="t">'+new Date(a.ts).toLocaleTimeString()+'</span><span class="n">'+a.action+'</span><span class="a">'+(a.detail||'')+'</span>';
  list.insertBefore(d,list.firstChild);while(list.children.length>120)list.removeChild(list.lastChild)}catch(err){}};
})();
</script>`;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Where `chatbridge workbench` finds the token of the server that is currently running. */
export const workbenchTokenFile = () => path.join(dataDir(), "workbench-token");

export function registerWorkbenchWeb(app: Express, rt: Runtime, cfg: BridgeConfig, extensions: ToolContext["extensions"]) {
  let client: Client | null = null;
  const getClient = async () => (client ??= await localClient(rt, extensions));
  // A fresh token per server start, handed to the CLI through a private file.
  const sessionToken = randomToken(24);
  try {
    writeFileSync(workbenchTokenFile(), sessionToken, { mode: 0o600 });
  } catch {
    /* the page can still be opened with the admin token */
  }

  /** Loopback only, and the admin token either in the header (fetch) or in the URL (opening the page). */
  const guard = (req: Request, res: Response, next: () => void) => {
    if (!LOOPBACK.has(req.hostname) || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) return void res.status(404).end();
    const token = (req.headers.authorization ?? "").replace(/^Bearer /i, "") || String(req.query.t ?? "");
    const ok = token && (safeEqual(token, sessionToken) || (cfg.auth.adminTokenHash && safeEqual(sha256(token), cfg.auth.adminTokenHash)));
    if (!ok) {
      return void res.status(401).type("text/plain").send("admin token required — run: chatbridge workbench");
    }
    next();
  };
  const body = express.json({ limit: "2mb" });

  app.get("/workbench", guard, async (req: Request, res: Response) => {
    try {
      const c = await getClient();
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
      const boot = (await c.callTool({ name: "workbench_open", arguments: cwd ? { cwd } : {} })) as any;
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || String(req.query.t ?? "");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'");
      res.type("html").send(AGENT_PANEL_HTML.replace("<head>", `<head>${shim(token, boot)}`).replace("</body>", `${FEED}</body>`));
    } catch (err) {
      res.status(500).type("text/plain").send(errorMessage(err));
    }
  });

  app.post("/workbench/api/tool", guard, body, async (req: Request, res: Response) => {
    try {
      const c = await getClient();
      const { name, arguments: args } = req.body ?? {};
      res.json(await c.callTool({ name: String(name), arguments: args ?? {} }));
    } catch (err) {
      res.json({ error: errorMessage(err) });
    }
  });

  // Text the user typed in the workbench for ChatGPT; the card in the conversation picks it up.
  app.post("/workbench/api/relay", guard, body, (req: Request, res: Response) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return void res.json({ error: "empty" });
    res.json({ queued: queueRelay(text) });
  });

  // Live feed of what ChatGPT does on this PC (server-sent events, loopback only).
  app.get("/workbench/api/events", guard, (req: Request, res: Response) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let seen = rt.audit.tail(1)[0]?.seq ?? 0;
    const timer = setInterval(() => {
      for (const e of rt.audit.tail(40).filter((x) => x.seq > seen)) {
        seen = e.seq;
        const a: any = e.args ?? {};
        const detail = a.command ?? a.path ?? a.task ?? a.message ?? a.id ?? "";
        res.write(`data: ${JSON.stringify({ ts: e.ts, action: e.action, outcome: e.outcome, detail: String(detail).slice(0, 120) })}\n\n`);
      }
      res.write(": ping\n\n");
    }, 1000);
    req.on("close", () => clearInterval(timer));
  });

  // The card in ChatGPT asks here (through an MCP tool) for queued workbench messages.
  void takeRelay;
}
