// Health-checks every installed agent in parallel through the real server and prints the results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "x", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["bin/chatbridge.mjs", "stdio"], env: process.env }), { timeout: 300000 });
const list = JSON.parse((await c.callTool({ name: "agents_list", arguments: {} })).content[0].text);
const ids = list.agents.filter((a) => a.installed).map((a) => a.agent);
const res = await Promise.all(ids.map((agent) => c.callTool({ name: "agents_check", arguments: { agent } }, undefined, { timeout: 300000 }).then((r) => r.content[0].text, (e) => `${agent}: ${e.message}`)));
console.log(res.join("\n"));
await c.close();
