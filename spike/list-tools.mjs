import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "x", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["bin/chatbridge.mjs", "stdio"], env: process.env }));
const t = (await c.listTools()).tools.map(x => x.name);
console.log(t.length, t.join(" "));
const r = await c.callTool({ name: "agents_list", arguments: {} });
console.log(r.content[0].text.slice(0, 1500));
await c.close();
