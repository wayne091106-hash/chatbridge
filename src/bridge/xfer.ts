import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, promises as fsp, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { objectStore } from "../core/objectStore.js";
import { errorMessage, formatBytes, randomToken } from "../core/util.js";
import type { DefineTool } from "./tools.js";
import { cardResourceMeta, cardResult, versionedUri, WIDGET_MIME } from "./widgets.js";

/**
 * File-transfer experiments between ChatGPT (and its sandbox) and this PC.
 *
 *   GPT → PC : xfer_receive (openai/fileParams download URL)  | xfer_receive_chunk (base64 fallback)
 *   PC → GPT : xfer_send (embedded resource in the tool result) | xfer_offer (widget + window.openai.uploadFile)
 *   limits   : xfer_echo (how much text a tool result can carry through the tunnel)
 */

// Each chunk is one tool call through the tunnel, and ChatGPT gives up on a tool call after ~60 s (then retries
// it once). Measured 2026-09-19 over the OpenAI tunnel: model calls carry 8 MiB in ~10 s, but card calls time out
// at 8 MiB and 4 MiB while 2 MiB takes ~4 s each. So this slow fallback uses 2 MiB; with an object store set up
// (`chatbridge storage set`) the card downloads from a presigned link instead.
const CHUNK_BYTES = 2 * 1024 * 1024;

const OpenAIFile = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

function inboxDir(): string {
  const dir = path.join(os.homedir(), "ChatBridge", "inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180) || "file";
}

function uniquePath(dir: string, name: string): string {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".html": "text/html",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".zip": "application/zip", ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const mimeOf = (p: string) => MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";

async function downloadTo(url: string, dest: string) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), meter, createWriteStream(dest));
  const ms = Date.now() - started;
  return { bytes, ms, sha256: hash.digest("hex"), contentType: res.headers.get("content-type") ?? "", host: new URL(res.url || url).host };
}

const speed = (bytes: number, ms: number) => `${((bytes / 1024 / 1024) / Math.max(ms / 1000, 0.001)).toFixed(2)} MB/s`;

// Partially received base64 transfers, keyed by transfer id.
const pending = new Map<string, { name: string; total: number; parts: Map<number, Buffer>; started: number }>();

export function registerFileTransfer(server: McpServer, define: DefineTool, rt: Runtime) {
  // ------------------------------------------------------------------ GPT → PC
  define(
    "xfer_receive",
    {
      title: "Receive file from chat",
      description:
        "Save a file from this conversation onto the PC. Pass the file (an attachment the user uploaded, or a file you created in your own Python sandbox) as the `file` parameter; ChatGPT hands the PC a download link and the PC downloads it directly. Reports size, speed and SHA-256.",
      input: { file: OpenAIFile, save_as: z.string().optional().describe("File name to save as"), folder: z.string().optional().describe("Target folder (default ~/ChatBridge/inbox)") },
      effect: "write",
      meta: { "openai/fileParams": ["file"], "openai/toolInvocation/invoking": "傳送檔案到電腦…", "openai/toolInvocation/invoked": "檔案已存到電腦" },
    },
    async (a) => {
      const dir = a.folder ? rt.files.resolve(a.folder) : inboxDir();
      mkdirSync(dir, { recursive: true });
      const dest = uniquePath(dir, safeName(a.save_as ?? a.file.file_name ?? `${a.file.file_id}.bin`));
      const r = await downloadTo(a.file.download_url, dest);
      return {
        saved_to: dest,
        size: formatBytes(r.bytes),
        bytes: r.bytes,
        seconds: +(r.ms / 1000).toFixed(2),
        speed: speed(r.bytes, r.ms),
        sha256: r.sha256,
        content_type: r.contentType,
        served_from: r.host,
        file_id: a.file.file_id,
      };
    },
  );

  define(
    "xfer_receive_chunk",
    {
      title: "Receive file in chunks",
      description:
        "Fallback when a file cannot be passed as a file parameter: send it as base64 chunks (≤ 200 KB of base64 per call) with the same transfer_id. When the last chunk arrives the PC assembles and saves the file and returns its SHA-256 so you can compare it with the original.",
      input: {
        transfer_id: z.string().min(1).max(64),
        name: z.string().min(1),
        index: z.number().int().min(0),
        total: z.number().int().min(1).max(10_000),
        data_base64: z.string(),
      },
      effect: "write",
    },
    async (a) => {
      let t = pending.get(a.transfer_id);
      if (!t) {
        t = { name: safeName(a.name), total: a.total, parts: new Map(), started: Date.now() };
        pending.set(a.transfer_id, t);
      }
      t.parts.set(a.index, Buffer.from(a.data_base64, "base64"));
      if (t.parts.size < t.total) return `chunk ${a.index + 1}/${t.total} received (${t.parts.size}/${t.total})`;
      const missing = [...Array(t.total).keys()].filter((i) => !t!.parts.has(i));
      if (missing.length) return `waiting for chunks: ${missing.join(", ")}`;
      const buf = Buffer.concat([...Array(t.total).keys()].map((i) => t!.parts.get(i)!));
      const dest = uniquePath(inboxDir(), t.name);
      await fsp.writeFile(dest, buf);
      pending.delete(a.transfer_id);
      const ms = Date.now() - t.started;
      return { saved_to: dest, size: formatBytes(buf.length), bytes: buf.length, seconds: +(ms / 1000).toFixed(2), speed: speed(buf.length, ms), sha256: createHash("sha256").update(buf).digest("hex") };
    },
  );

  // ------------------------------------------------------------------ PC → GPT
  define(
    "xfer_send",
    {
      title: "Send file to chat (tool result)",
      description:
        "Return a small PC file (max 20 MB) inside the tool result so you can use it in your Python sandbox. ChatGPT asks the user once to allow turning it into a file (「允許將檔案實體化」) — tell the user to click 允許. Call it once per file; for files the user wants in the chat, or anything large, use xfer_offer instead.",
      input: { path: z.string() },
      effect: "read",
    },
    async (a) => {
      const abs = rt.files.resolve(a.path);
      const st = await fsp.stat(abs);
      if (st.size > 20 * 1024 * 1024) throw new Error(`file is ${formatBytes(st.size)}; limit for this experiment is 20 MB`);
      const buf = await fsp.readFile(abs);
      const sha = createHash("sha256").update(buf).digest("hex");
      return {
        content: [
          { type: "text", text: `file ${path.basename(abs)} (${formatBytes(buf.length)}, sha256 ${sha}) attached as an embedded resource.` },
          { type: "resource", resource: { uri: `file:///${encodeURIComponent(path.basename(abs))}`, mimeType: mimeOf(abs), blob: buf.toString("base64") } },
        ],
      };
    },
  );

  define(
    "xfer_offer",
    {
      title: "Send file to chat (upload card)",
      description:
        "Show an upload card for a PC file. The card pulls the file through the tunnel and uploads it into this conversation (window.openai.uploadFile), then verifies the round trip. Use for files the user wants to hand to you. When the PC has object storage set up, the card downloads the file from a short-lived link (fast); otherwise it pulls it through the tunnel in chunks (slow, ~0.5 MB/s). chunk_mb only affects the tunnel path (default 2; the card halves it automatically when a trip fails). ChatGPT may refuse some file types when the card adds the file (e.g. .bin); images, PDF, Office and text files work best.",
      input: { path: z.string(), chunk_mb: z.number().min(0.25).max(128).optional() },
      effect: "read",
      meta: {
        ui: { resourceUri: XFER_WIDGET_URI },
        "openai/outputTemplate": XFER_WIDGET_URI,
        "openai/toolInvocation/invoking": "準備檔案…",
        "openai/toolInvocation/invoked": "檔案已準備好",
      },
    },
    async (a) => {
      const abs = rt.files.resolve(a.path);
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw new Error(`${abs} is not a file`);
      const hash = createHash("sha256").update(await fsp.readFile(abs)).digest("hex");
      const mime = mimeOf(abs);
      // Fast path: start uploading to the object store right away; the card downloads from a presigned link.
      const stage = startStaging(abs, mime);
      const data = {
        path: abs,
        name: path.basename(abs),
        size: st.size,
        mime,
        sha256: hash,
        chunk: a.chunk_mb ? Math.round(a.chunk_mb * 1024 * 1024) : CHUNK_BYTES,
        stage,
        // ChatGPT rejects some types when the card puts the file into the chat (seen: .bin → "Unsupported file type").
        typeWarning: mime === "application/octet-stream" ? "ChatGPT 可能不接受這種檔案類型（例如 .bin）；圖片、PDF、Office、文字檔最穩。" : "",
      };
      return { structuredContent: data, content: [{ type: "text", text: `Upload card ready for ${data.name} (${formatBytes(st.size)}${stage ? ", fast path via object storage" : ", via the tunnel in chunks"}). The user clicks the button to upload it into the chat.` }] };
    },
  );

  define(
    "xfer_read_chunk",
    {
      title: "Read file chunk (for upload card)",
      description: "Internal: used by the upload card to read a file in chunks.",
      input: { path: z.string(), offset: z.number().int().min(0), length: z.number().int().min(1).max(128 * 1024 * 1024) },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const fh = await fsp.open(rt.files.resolve(a.path), "r");
      try {
        const buf = Buffer.alloc(a.length);
        const { bytesRead } = await fh.read(buf, 0, a.length, a.offset);
        const st = await fh.stat();
        // The bytes travel only in card-only _meta: putting them in content/structuredContent adds them to the
        // conversation, and a 32 MB file then hits ChatGPT's conversation length limit (seen 2026-09-19).
        return cardResult(
          { offset: a.offset, length: bytesRead, eof: a.offset + bytesRead >= st.size },
          { data_base64: buf.subarray(0, bytesRead).toString("base64") },
          [{ type: "text", text: `chunk @${a.offset} (${bytesRead} bytes)` }],
        );
      } finally {
        await fh.close();
      }
    },
  );

  define(
    "xfer_verify_url",
    {
      title: "Verify uploaded file",
      description: "Internal: the upload card downloads the uploaded copy back to the PC and compares SHA-256 with the original.",
      input: { download_url: z.string(), expected_sha256: z.string() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const tmp = path.join(os.tmpdir(), `chatbridge-verify-${Date.now()}`);
      try {
        const r = await downloadTo(a.download_url, tmp);
        return { structuredContent: { match: r.sha256 === a.expected_sha256, bytes: r.bytes, speed: speed(r.bytes, r.ms), host: r.host }, content: [{ type: "text", text: r.sha256 === a.expected_sha256 ? "round trip verified" : "hash mismatch" }] };
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    },
  );

  // ------------------------------------------------------------------ limits
  define(
    "xfer_echo",
    {
      title: "Tool result size test",
      description:
        "Tunnel size probe: returns kb kilobytes of marked text ([k000001]…). Default (card_only=true) sends the payload in card-only _meta — the conversation only gets a short receipt, so large tests don't fill it; success means the tunnel carried that much in one trip. card_only=false puts the text in the result itself to see where the model's view gets cut off (keep that small).",
      input: { kb: z.number().int().min(1).max(256 * 1024), card_only: z.boolean().optional() },
      effect: "read",
    },
    async (a) => {
      const lines: string[] = [];
      for (let k = 1; k <= a.kb; k++) lines.push(`[k${String(k).padStart(6, "0")}]` + "x".repeat(1024 - 10 - 1));
      const body = `BEGIN ${a.kb}KB\n${lines.join("\n")}\nEND ${a.kb}KB (last marker k${String(a.kb).padStart(6, "0")})`;
      if (a.card_only === false) return body;
      const sha = createHash("sha256").update(body).digest("hex");
      return cardResult({ kb: a.kb, bytes: Buffer.byteLength(body), sha256: sha }, { payload: body }, [
        { type: "text", text: `sent ${a.kb} KB (${formatBytes(Buffer.byteLength(body))}) in one tool result via card-only _meta; sha256 ${sha.slice(0, 16)}. If you are reading this, the tunnel carried it.` },
      ]);
    },
  );

  // ------------------------------------------------------------------ upload card UI
  define(
    "xfer_stage",
    {
      title: "Upload staging status (for upload card)",
      description: "Internal: progress of the PC → object storage upload and, when ready, the short-lived download link for the upload card.",
      input: { id: z.string() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const s = stages.get(a.id);
      if (!s) return cardResult({ state: "missing" }, {}, [{ type: "text", text: "unknown or expired upload" }]);
      const light = { state: s.state, sent: s.sent, total: s.total, error: s.error ?? "" };
      // The link is a credential for the file, so it only goes to the card.
      return cardResult(light, s.url ? { url: s.url } : {}, [{ type: "text", text: s.state }]);
    },
  );

  // Card-only data may need the store's origin in the CSP, so the resource metadata is built on each read.
  const readCard = async (uri: URL) => {
    const store = objectStore();
    return { contents: [{ uri: uri.href, mimeType: WIDGET_MIME, text: UPLOAD_WIDGET_HTML, _meta: cardResourceMeta("Uploads a file from the PC into this conversation", store ? [store.origin] : []) }] };
  };
  server.registerResource("xfer-upload-card", XFER_WIDGET_URI, { mimeType: WIDGET_MIME, description: "ChatBridge upload card" }, readCard);
  // Apps created earlier keep asking for older fingerprinted URIs; serve them the current card.
  server.registerResource("xfer-upload-card-any", new ResourceTemplate("ui://chatbridge/xfer-upload-{version}.html", { list: undefined }), { mimeType: WIDGET_MIME }, readCard);
}

// ------------------------------------------------------------------ object-store staging
interface Stage {
  state: "uploading" | "ready" | "failed";
  sent: number;
  total: number;
  url?: string;
  error?: string;
  createdAt: number;
}
const stages = new Map<string, Stage>();

/** Starts a background upload to the object store; returns the stage id, or "" when no store is set up. */
function startStaging(file: string, mime: string): string {
  const store = objectStore();
  if (!store) return "";
  for (const [k, s] of stages) if (Date.now() - s.createdAt > 3600_000) stages.delete(k);
  const id = randomToken(12);
  const stage: Stage = { state: "uploading", sent: 0, total: statSync(file).size, createdAt: Date.now() };
  stages.set(id, stage);
  const key = store.newKey(path.basename(file));
  void store
    .putFile(key, file, mime, (sent) => (stage.sent = sent))
    .then(async () => {
      stage.url = await store.presignGet(key, 1800);
      stage.state = "ready";
    })
    .catch((err) => {
      stage.state = "failed";
      stage.error = errorMessage(err);
    });
  return id;
}

const UPLOAD_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--fg:#1d1d1b;--muted:#6b6a66;--line:#e2e0da;--accent:#1f6f5c;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe6;--muted:#9c9a93;--line:#34332f;--accent:#5cc2a6;--bad:#f2b8b5}}
body{margin:0;font:14px/1.5 system-ui,"Segoe UI","Noto Sans TC",sans-serif;color:var(--fg);background:transparent}
.card{border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.name{font-weight:600;word-break:break-all}.muted{color:var(--muted);font-size:12.5px}
button{margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.bar{height:6px;background:var(--line);border-radius:3px;margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--accent)}
pre{white-space:pre-wrap;font:12px/1.45 ui-monospace,Consolas,monospace;margin:10px 0 0;color:var(--muted)}
.bad{color:var(--bad)}
</style></head><body><div class="card">
<div class="name" id="name">載入中…</div><div class="muted" id="meta"></div>
<button id="go" disabled>上傳到對話</button>
<div class="bar"><i id="bar"></i></div><pre id="log"></pre></div>
<script>
const $=id=>document.getElementById(id);const o=window.openai;const log=s=>{$('log').textContent+=s+'\\n'};
const fmt=n=>n>1048576?(n/1048576).toFixed(2)+' MB':n>1024?(n/1024).toFixed(1)+' KB':n+' B';
function data(){const t=o&&o.toolOutput;return t&&(t.structuredContent||t)}
function render(){const d=data();if(!d||!d.name)return false;$('name').textContent=d.name;$('meta').textContent=fmt(d.size)+' · '+d.mime+(d.stage?' · 快速通道':' · 經通道（較慢）');if(d.typeWarning)log('⚠ '+d.typeWarning);$('go').disabled=false;return true}
if(!render()){window.addEventListener('openai:set_globals',render);let n=0;const t=setInterval(()=>{if(render()||++n>50)clearInterval(t)},200)}
function b64(s){const bin=atob(s);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u}
$('go').onclick=async()=>{const d=data();$('go').disabled=true;$('log').textContent='';
 try{
  if(!o||!o.callTool||!o.uploadFile){log('✗ 這個環境沒有 window.openai.callTool / uploadFile');return}
  const t0=performance.now();const parts=[];let off=0,size=d.chunk,fails=0,fast=false;
  if(d.stage){
   // Fast path: the PC uploads to object storage; this card downloads the file from a short-lived link.
   let c=null;
   for(;;){let r;try{r=await o.callTool('xfer_stage',{id:d.stage})}catch(e){log('（快速通道無法使用：'+(e&&e.message||e)+'，改走通道）');c=null;break}
    const x=r&&r.result&&typeof r.result==='object'?r.result:r;
    const sc=(x&&x.structuredContent)||{};const m=x&&(x._meta||x.meta);c=(m&&m['chatbridge/card'])||{};
    if(sc.state==='ready'&&c.url)break;
    if(sc.state==='failed'||sc.state==='missing'){log('✗ 電腦上傳到雲端失敗：'+(sc.error||sc.state)+'，改走通道');c=null;break}
    $('meta').textContent='① 電腦上傳到雲端：'+fmt(sc.sent||0)+' / '+fmt(d.size);$('bar').style.width=Math.round((sc.sent||0)/d.size*50)+'%';
    await new Promise(res=>setTimeout(res,800))}
   if(c){const ta=performance.now();log('① 電腦上傳到雲端：'+fmt(d.size)+'，'+((ta-t0)/1000).toFixed(1)+' 秒');
    const res=await fetch(c.url);if(!res.ok)throw new Error('從雲端下載失敗：HTTP '+res.status);
    const rd=res.body.getReader();
    for(;;){const s=await rd.read();if(s.done)break;parts.push(s.value);off+=s.value.length;$('bar').style.width=(50+Math.round(off/d.size*50))+'%';$('meta').textContent='② 從雲端下載：'+fmt(off)+' / '+fmt(d.size)}
    log('② 從雲端下載到瀏覽器：'+fmt(off)+'，'+((performance.now()-ta)/1000).toFixed(1)+' 秒');fast=true}}
  while(off<d.size){let r;try{r=await o.callTool('xfer_read_chunk',{path:d.path,offset:off,length:size})}catch(e){if(++fails>8||size<=262144)throw e;size=Math.max(262144,size>>1);log('（分塊縮小為 '+fmt(size)+' 重試）');continue}
   const x=r&&r.result&&typeof r.result==='object'?r.result:r;const m=x&&(x._meta||x.meta);const c=m&&m['chatbridge/card'];
   if(!c||typeof c.data_base64!=='string'){log('✗ ChatGPT 沒有把卡片專用資料（_meta）交給卡片，停止以免塞爆對話。回傳欄位：'+Object.keys(x||{}).join(','));return}
   const u=b64(c.data_base64);parts.push(u);off+=u.length;$('bar').style.width=Math.round(off/d.size*100)+'%';$('meta').textContent=fmt(off)+' / '+fmt(d.size);if(!u.length)break}
  const t1=performance.now();log((fast?'✓ 快速通道合計：':'① 經通道從電腦讀取：')+fmt(off)+'，'+((t1-t0)/1000).toFixed(1)+' 秒（'+(off/1048576/((t1-t0)/1000)).toFixed(2)+' MB/s）');
  const file=new File(parts,d.name,{type:d.mime});
  const up=await o.uploadFile(file);const fileId=up&&(up.fileId||up.file_id||up.id);const t2=performance.now();
  log('② 上傳進對話：'+(fileId?'fileId '+fileId:'回傳 '+JSON.stringify(up))+'，'+((t2-t1)/1000).toFixed(1)+' 秒');
  let verified='';
  if(fileId&&o.getFileDownloadUrl){const g=await o.getFileDownloadUrl({fileId});const url=g&&(g.downloadUrl||g.download_url||g.url||g);
   if(typeof url==='string'){const v=await o.callTool('xfer_verify_url',{download_url:url,expected_sha256:d.sha256});const vs=(v&&(v.structuredContent||v.result&&v.result.structuredContent))||v;
    verified=vs.match?'✓ 來回比對 SHA-256 完全相同':'✗ SHA-256 不符';log('③ '+verified+'（再下載速度 '+vs.speed+'）')}else{log('③ getFileDownloadUrl 回傳：'+JSON.stringify(g))}}
  if(o.setWidgetState)o.setWidgetState({fileId,name:d.name});
  if(o.sendFollowUpMessage&&fileId)await o.sendFollowUpMessage({prompt:'[上傳卡片] 已把 '+d.name+'（'+fmt(d.size)+'，sha256 '+d.sha256.slice(0,16)+'…）上傳到對話，fileId: '+fileId+'。'+verified+'。請試著在你的 Python 環境找到並讀取這個檔案，回報檔名、大小和 sha256 前 16 碼是否一致。'});
 }catch(e){log('✗ '+(e&&e.message||e));$('go').disabled=false}};
</script></body></html>`;

export const XFER_WIDGET_URI = versionedUri("xfer-upload", UPLOAD_WIDGET_HTML);
