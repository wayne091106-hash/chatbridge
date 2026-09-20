import { pathToFileURL } from "node:url";
const ws = new WebSocket("ws://127.0.0.1:47101");
let id = 1; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
console.log(JSON.stringify((await call("initialize", { clientName: "fs-probe" })).result?.environmentInfo?.executorVersion));
ws.send(JSON.stringify({ method: "initialized", params: {} }));
import path from "node:path"; const base = path.join(process.cwd(), "spike", "tmpfs"); const J = (...a) => path.join(base, ...a);
const u = (p) => pathToFileURL(p).href;
const tries = [
  ["fs/createDirectory", { path: u(J("a","b")) }],
  ["fs/createDirectory", { path: u(J("a","b")), recursive: true }],
  ["fs/writeFile", { path: u(J("a","b","x.txt")), dataBase64: Buffer.from("hi").toString("base64") }],
  ["fs/copy", { sourcePath: u(J("a","b","x.txt")), destinationPath: u(J("a","y.txt")) }],
  ["fs/copy", { source: u(J("a","b","x.txt")), destination: u(J("a","y.txt")) }],
  ["fs/copy", { from: u(J("a","b","x.txt")), to: u(J("a","y.txt")) }],
  ["fs/canonicalize", { path: u(J("a","..","a")) }],
  ["fs/readDirectory", { path: u(J("a")) }],
  ["fs/remove", { path: u(J("a")) }],
  ["fs/remove", { path: u(J("a")), recursive: true }],
  ["fs/remove", { path: u(base), recursive: true, force: true }],
  ["fs/open", { path: u(path.join(process.cwd(),"package.json")) }],
  ["process/start", { processId: "bad", argv: ["nonexistent-cmd-xyz"], cwd: u(process.cwd()), env: {}, tty: false, pipeStdin: false, arg0: null }],
  ["process/read", { processId: "nope", afterSeq: null, maxBytes: 10, waitMs: 0 }],
  ["fs/readFile", { path: "C:/Windows/win.ini" }],
];
for (const [m, p] of tries) console.log(m, JSON.stringify(p).slice(0, 80), "=>", JSON.stringify(await call(m, p)).slice(0, 400));
ws.close();
