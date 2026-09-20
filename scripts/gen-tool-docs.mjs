#!/usr/bin/env node
/**
 * Writes docs/TOOLS.md from the server itself, so the tool list cannot drift away from the code.
 * A test (tests/docs.test.ts) fails if the file is out of date.
 *
 *   npm run docs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeConfigSchema } from "../dist/src/core/config.js";
import { createRuntime } from "../dist/src/core/runtime.js";
import { silentLogger } from "../dist/src/core/logger.js";
import { createMcpServer, SERVER_VERSION } from "../dist/src/bridge/tools.js";

const GROUPS = [
  ["說明與狀態", (n) => ["chatbridge_guide", "computer_info", "bridge_status", "bridge_version", "op_status", "relay_poll"].includes(n)],
  ["Shell", (n) => n.startsWith("shell_")],
  ["檔案", (n) => n.startsWith("fs_") || n === "apply_patch" || n === "set_working_directory"],
  ["桌面", (n) => ["screen_capture", "view_screen", "mouse", "keyboard", "clipboard", "windows_list", "window_focus"].includes(n)],
  ["卡片與結果", (n) => ["view", "show_summary", "summary_diff"].includes(n)],
  ["檔案傳輸", (n) => n.startsWith("xfer_") || n.startsWith("drive_")],
  ["Agent hub", (n) => n.startsWith("agent") || n.startsWith("workbench_")],
  ["交接", (n) => n.startsWith("handoff_")],
];

export async function listTools() {
  const config = BridgeConfigSchema.parse({ logLevel: "error", executor: { kind: "node" } });
  const rt = await createRuntime({ config, logger: silentLogger });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  await rt.close();
  return tools.map((t) => ({ name: t.name, title: t.annotations?.title ?? t.name, description: String(t.description ?? "").split(/(?<=\.)\s/)[0] }));
}

export function renderToolDocs(tools) {
  const used = new Set();
  const lines = [
    "# 工具清單",
    "",
    `ChatBridge ${SERVER_VERSION} 對 ChatGPT／Claude 公開 **${tools.length} 個工具**。`,
    "",
    "> 這份檔案由 `npm run docs` 從伺服器本身產生，不要手動編輯。",
    "",
  ];
  for (const [title, match] of GROUPS) {
    const group = tools.filter((t) => !used.has(t.name) && match(t.name));
    if (!group.length) continue;
    for (const t of group) used.add(t.name);
    lines.push(`## ${title}`, "", "| 工具 | 做什麼 |", "|---|---|");
    for (const t of group) lines.push(`| \`${t.name}\` | ${t.description.replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  const rest = tools.filter((t) => !used.has(t.name));
  if (rest.length) {
    lines.push("## 其他", "", "| 工具 | 做什麼 |", "|---|---|");
    for (const t of rest) lines.push(`| \`${t.name}\` | ${t.description.replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const tools = await listTools();
  const file = path.join(root, "docs", "TOOLS.md");
  writeFileSync(file, renderToolDocs(tools) + "\n");
  process.stdout.write(`wrote ${file} (${tools.length} tools)\n`);
}
