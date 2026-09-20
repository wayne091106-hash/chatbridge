// Sends a small file through the real server into the Drive folder and lists the inbox.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "drive-check", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["bin/chatbridge.mjs", "stdio"], env: process.env }));
const file = process.argv[2];
console.log((await c.callTool({ name: "drive_send", arguments: { paths: [file] } })).content[0].text);
console.log((await c.callTool({ name: "drive_inbox", arguments: {} })).content[0].text);
await c.close();
