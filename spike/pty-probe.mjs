// Probe interactive stdin: pipe mode vs PTY mode.
import { pathToFileURL } from "node:url";
const ws = new WebSocket("ws://127.0.0.1:47100");
let id = 1; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
await call("initialize", { clientName: "pty-probe" });
ws.send(JSON.stringify({ method: "initialized", params: {} }));
const cwd = pathToFileURL(process.cwd()).href;
const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };

for (const [name, tty, argv] of [
  ["pipe-cmd", false, ["cmd.exe", "/q", "/k"]],
  ["pty-cmd", true, ["cmd.exe", "/q", "/k"]],
  ["pty-pwsh", true, ["powershell.exe", "-NoLogo", "-NoProfile"]],
]) {
  const start = await call("process/start", { processId: name, argv, cwd, env, tty, pipeStdin: !tty, arg0: null });
  if (start.error) { console.log(name, "start error", start.error); continue; }
  await new Promise((r) => setTimeout(r, 1500));
  const w = await call("process/write", { processId: name, writeId: `${name}-w1`, chunk: Buffer.from("echo MARK-%CD% & echo 7*6\r\n").toString("base64") });
  let seq = null, out = "";
  for (let i = 0; i < 5; i++) {
    const r = await call("process/read", { processId: name, afterSeq: seq, maxBytes: 65536, waitMs: 1000 });
    for (const c of r.result.chunks) out += Buffer.from(c.chunk, "base64").toString("utf8");
    seq = r.result.nextSeq - 1;
  }
  console.log(`\n=== ${name} write=${JSON.stringify(w.result ?? w.error)}\n${JSON.stringify(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).slice(0, 600)}`);
  await call("process/terminate", { processId: name });
}
ws.close();
