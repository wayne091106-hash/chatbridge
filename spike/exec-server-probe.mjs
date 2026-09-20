// Phase 0 probe: talk to `codex exec-server` over WebSocket JSON-RPC without any model.
// Usage: node spike/exec-server-probe.mjs [ws://127.0.0.1:47100]
import { pathToFileURL } from "node:url";

const url = process.argv[2] ?? "ws://127.0.0.1:47100";
const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else {
    console.log("[notify]", JSON.stringify(msg).slice(0, 300));
  }
});

function call(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
const notify = (method, params) => ws.send(JSON.stringify({ method, params }));
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
const show = (label, res) => console.log(`\n== ${label}\n${JSON.stringify(res, null, 2).slice(0, 1500)}`);

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

const cwd = pathToFileURL(process.cwd()).href;
show("initialize", await call("initialize", { clientName: "chat-bridge-probe" }));
notify("initialized", {});

// 1) Run a shell command (non-tty, piped) and read its output.
show("process/start", await call("process/start", {
  processId: "p1",
  argv: ["cmd.exe", "/c", "echo hello from exec-server && ver"],
  cwd,
  env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
  tty: false,
  pipeStdin: false,
  arg0: null,
}));
let afterSeq = null;
for (let i = 0; i < 5; i++) {
  const r = await call("process/read", { processId: "p1", afterSeq, maxBytes: 65536, waitMs: 1000 });
  for (const c of r.result?.chunks ?? []) console.log(`[p1 ${c.stream}]`, b64(c.chunk).trim());
  if (r.error) { show("process/read error", r); break; }
  afterSeq = r.result.nextSeq - 1;
  if (r.result.exited || r.result.closed) { show("process/read final", r); break; }
}

// 2) Interactive process: write to stdin, then terminate.
show("process/start interactive", await call("process/start", {
  processId: "p2",
  argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "-"],
  cwd,
  env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
  tty: false,
  pipeStdin: true,
  arg0: null,
}));
await call("process/write", { processId: "p2", chunk: Buffer.from("Write-Output (2+3)\r\nexit\r\n").toString("base64") });
{
  let seq = null;
  for (let i = 0; i < 10; i++) {
    const r = await call("process/read", { processId: "p2", afterSeq: seq, maxBytes: 65536, waitMs: 1000 });
    for (const c of r.result?.chunks ?? []) console.log(`[p2 ${c.stream}]`, b64(c.chunk).trim());
    seq = r.result.nextSeq - 1;
    if (r.result.exited) { show("p2 final", r); break; }
  }
}
show("process/terminate", await call("process/terminate", { processId: "p2" }));

// 3) Filesystem: probe param names (errors tell us the real schema).
const probeFile = pathToFileURL(`${process.cwd()}\\spike\\probe-output.txt`).href;
for (const [method, params] of [
  ["fs/writeFile", { path: probeFile, dataBase64: Buffer.from("written via exec-server\n").toString("base64") }],
  ["fs/readFile", { path: probeFile }],
  ["fs/readDirectory", { path: cwd }],
  ["fs/getMetadata", { path: probeFile }],
]) {
  show(method, await call(method, params));
}

ws.close();
