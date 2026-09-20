import { existsSync, mkdirSync, promises as fsp, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { formatBytes, looksBinary } from "../core/util.js";
import type { DefineTool } from "./tools.js";
import { driveAccount, driveFolders } from "./drive.js";
import { AGENT_PANEL_HTML, AGENT_PANEL_URI, cardResourceMeta, cardResult, VIEWER_HTML, VIEWER_URI, WIDGET_MIME } from "./widgets.js";

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml" };
const viewerMeta = (invoking: string, invoked: string) => ({
  ui: { resourceUri: VIEWER_URI },
  "openai/outputTemplate": VIEWER_URI,
  "openai/toolInvocation/invoking": invoking,
  "openai/toolInvocation/invoked": invoked,
});

export function machineName(rt: Runtime): string {
  return rt.config.server.displayName || os.hostname();
}

function handoffDir() {
  const d = path.join(os.homedir(), "ChatBridge", "handoffs");
  mkdirSync(d, { recursive: true });
  return d;
}

export function registerExtras(server: McpServer, define: DefineTool, rt: Runtime) {
  // ------------------------------------------------------------------ cards
  const panel = async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: WIDGET_MIME, text: AGENT_PANEL_HTML, _meta: cardResourceMeta("Coding with the PC's agents: live conversation, changes and the fullscreen workbench") }],
  });
  const viewer = async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: WIDGET_MIME, text: VIEWER_HTML, _meta: cardResourceMeta("Shows an image, file, folder, terminal or the screen from the PC") }],
  });
  server.registerResource("agent-panel", AGENT_PANEL_URI, { mimeType: WIDGET_MIME, description: "Coding card and workbench" }, panel);
  server.registerResource("viewer", VIEWER_URI, { mimeType: WIDGET_MIME, description: "File, image, folder and terminal viewer" }, viewer);
  // Apps created earlier keep asking for older fingerprinted card URIs; serve them the current cards.
  server.registerResource("agent-panel-any", new ResourceTemplate("ui://chatbridge/agent-panel-{version}.html", { list: undefined }), { mimeType: WIDGET_MIME }, panel);
  server.registerResource("viewer-any", new ResourceTemplate("ui://chatbridge/viewer-{version}.html", { list: undefined }), { mimeType: WIDGET_MIME }, viewer);

  // ------------------------------------------------------------------ guide
  define(
    "chatbridge_guide",
    {
      title: "How to use this computer",
      description: "Call this first in a new conversation: explains which computer this is, the available capabilities and the recommended workflows.",
      input: {},
      effect: "read",
    },
    async () => {
      const handoffs = readdirSync(handoffDir()).filter((f) => f.endsWith(".md")).sort().slice(-5);
      return [
        `You are connected to the owner's Windows PC "${machineName(rt)}" through ChatBridge (full access granted by the owner). Working directory: ${rt.cwd.value}.`,
        "",
        "Capabilities:",
        "- Shell: shell_run (PowerShell by default; long commands keep running — poll with shell_read). shell_watch shows the user a live terminal card.",
        "- Files: fs_read, fs_edit, apply_patch, fs_write, fs_list, fs_search, fs_manage; every change is undoable with fs_checkpoints.",
        "- Show things to the user: view (image / code / folder), view_screen (live screenshot card). Prefer these over pasting large content.",
        "- Finishing a piece of work: call show_summary (title + a few lines in your own words + optional questions / next_steps). It measures the real changed files, line counts and diffs and renders them as a card the user can tap — on the phone too. Never type a list of changed files or +/- counts yourself; you will get them wrong.",
        "- Desktop: screen_capture, mouse, keyboard, clipboard, windows_list, window_focus.",
        "- Coding agents (owner's order: Kilo Code → Cline → Codex → Claude Code; OpenCode/Gemini only when asked by name): two modes —",
        "  · chat coding: agent_run starts a conversation with a live card in the chat; steer it with agent_message (queued, or interrupt=true), agent_pause / agent_resume / agent_cancel, agent_revert to undo its file changes.",
        "  · serious coding: workbench_open opens a fullscreen workbench (conversation, changes and diffs, branch, commit/push, agent/model/access settings, past conversations). Offer it when the user wants to focus on a coding project.",
        "  Review with agent_result before telling the user work is done.",
        ...(driveFolders(rt)
          ? [
              "- Files between the PC and the user's devices (fast, bypasses this chat): drive_send puts PC files into the synced Google Drive folder ChatBridge/寄件; drive_inbox lists what the user dropped into ChatBridge/收件 (ordinary local files — open them with the file tools). Prefer these for anything big or when the user is away from the PC.",
              `  To read a PC file yourself (e.g. analyse it in your Python sandbox): drive_send it, wait a few seconds for Drive to sync, then fetch it with your Google Drive connector (search the file name in ChatBridge/寄件). If the connector is not connected, tell the user to connect Google Drive${driveAccount(rt) ? ` (the ${driveAccount(rt)} account)` : ""} in ChatGPT settings.`,
              `  IMPORTANT: the Google Drive connector may be signed in to a different Google account than the one this folder belongs to. Before reading anything through it, confirm ${driveAccount(rt) ? `it is ${driveAccount(rt)} — ` : ""}the ChatBridge folder with 收件/寄件 must exist there. If it is a different account, stop and tell the user — never browse or read files from another person's Drive.`,
            ]
          : []),
        "- Files between chat and PC: xfer_receive (chat attachment or a file from your Python sandbox → PC), xfer_offer (PC file → upload card; the user clicks the button; best for large files), xfer_send (small file ≤ 20 MB for your Python sandbox; the user must click 允許 once). Never move file contents through shell output or base64 in chat — it fills the conversation.",
        "- Long projects: handoff_save writes a handoff note (goal, state, next steps, key paths); handoff_load restores it in a new conversation.",
        "",
        "Limits of this setup (ChatGPT's side, nothing to debug on the PC):",
        "- A tool call must finish within ~60 s or ChatGPT gives up and silently retries it once. ChatBridge answers at 50 s with a ticket id instead: the work keeps running on the PC and you collect it with op_status. For anything long, prefer shell_run (small yield_seconds) or agent_run and poll — never block.",
        "- Recovery: if tools seem to have disappeared, or you lost track of what this PC offers, call chatbridge_guide and bridge_version again before doing anything else. Never invent a result for a call that did not run.",
        "- In long conversations ChatGPT drops these tools without saying so: calls stop happening and answers may be invented. Work in stretches of roughly 50–80 tool calls: before that, call handoff_save and tell the user to continue in a new chat (handoff_load there). Never guess a tool result — if a call did not run, say so.",
        "",
        "Working style: do quick lookups, web research and analysis in ChatGPT itself; use the PC for anything that needs the real project, real files, GPU or long-running processes. Keep the user informed and report exactly what changed.",
        ...(handoffs.length ? ["", `Recent handoff notes: ${handoffs.join(", ")} (handoff_load to read).`] : []),
      ].join("\n");
    },
  );

  // ------------------------------------------------------------------ viewer
  async function viewData(p: string, maxLines = 1500) {
    const abs = rt.files.resolve(p);
    const st = statSync(abs);
    if (st.isDirectory()) {
      const r = await rt.files.list(abs, 2, 400);
      return { kind: "dir", title: abs, meta: `${r.entries} 項${r.truncated ? "（已截斷）" : ""}`, text: r.tree };
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_MIME[ext]) {
      if (st.size > 8 * 1024 * 1024) return { kind: "note", title: abs, meta: formatBytes(st.size), text: "圖片太大（上限 8 MB），請用 xfer_offer 傳到對話" };
      const buf = await fsp.readFile(abs);
      return { kind: "image", title: path.basename(abs), meta: formatBytes(st.size), mime: IMAGE_MIME[ext], data: buf.toString("base64") };
    }
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) return { kind: "note", title: path.basename(abs), meta: formatBytes(st.size), text: "二進位檔案，無法預覽；可以用 xfer_offer 傳到對話。" };
    const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    return {
      kind: ext === ".diff" || ext === ".patch" ? "diff" : "text",
      title: abs,
      meta: `${lines.length} 行 · ${formatBytes(st.size)}${lines.length > maxLines ? `（顯示前 ${maxLines} 行）` : ""}`,
      text: lines.slice(0, maxLines).join("\n"),
    };
  }

  define(
    "view",
    {
      title: "Show a file or folder",
      description: "Show the user a card with an image, a text/code file (line numbers) or a folder tree from the PC. Use this to let the user see things instead of pasting them into the chat.",
      input: { path: z.string(), max_lines: z.number().int().min(10).max(5000).optional() },
      effect: "read",
      meta: viewerMeta("開啟檢視…", "已顯示"),
    },
    async (a) => {
      const data = await viewData(a.path, a.max_lines);
      const summary = data.kind === "image" ? `showing image ${data.title} (${data.meta})` : `showing ${data.kind} ${data.title} (${data.meta})`;
      const { data: _img, text: body, ...light } = data as any;
      return cardResult(light, data, [{ type: "text", text: `${summary} to the user.${data.kind === "text" || data.kind === "dir" ? `\n\n${String(body).slice(0, 4000)}` : ""}` }]);
    },
  );

  define(
    "view_screen",
    {
      title: "Live screen card",
      description: "Show the user a card with the PC screen. live_seconds > 0 keeps it refreshing (e.g. to watch a server, a browser or a long job).",
      input: { max_width: z.number().int().min(320).max(1920).optional(), live_seconds: z.number().int().min(0).max(30).optional() },
      effect: "desktop",
      readOnly: true,
      destructive: false,
      meta: { ...viewerMeta("擷取螢幕…", "已顯示螢幕"), "openai/widgetAccessible": true },
    },
    async (a) => {
      const { data, width, height } = await screenCard(a.max_width, a.live_seconds);
      const { data: _png, ...light } = data;
      // The model sees this first frame; later refreshes (view_screen_frame) only go to the card.
      return cardResult(light, data, [
        { type: "text", text: `showing the screen (${width}x${height}) to the user${a.live_seconds ? `, refreshing every ${a.live_seconds}s` : ""}.` },
        { type: "image", data: data.data, mimeType: "image/png" },
      ]);
    },
  );

  define(
    "view_screen_frame",
    {
      title: "Screen frame (for cards)",
      description: "Internal: next frame for the live screen card.",
      input: { max_width: z.number().int().min(320).max(1920).optional(), live_seconds: z.number().int().min(0).max(30).optional() },
      effect: "desktop",
      readOnly: true,
      destructive: false,
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => cardResult({ kind: "image" }, (await screenCard(a.max_width, a.live_seconds)).data, [{ type: "text", text: "frame" }]),
  );

  async function screenCard(maxWidth = 1280, liveSeconds = 0) {
    const { png, meta } = await rt.desktop.screenshot({ maxWidth });
    const data = {
      kind: "image",
      title: `${machineName(rt)} 螢幕`,
      meta: `${meta.width}×${meta.height} · ${new Date().toLocaleTimeString()}`,
      mime: "image/png",
      data: png.toString("base64"),
      refreshTool: "view_screen_frame",
      refreshArgs: { max_width: maxWidth, live_seconds: liveSeconds },
      liveMs: liveSeconds * 1000,
    };
    return { data, width: meta.width, height: meta.height };
  }

  define(
    "shell_watch",
    {
      title: "Live terminal card",
      description: "Show the user a live-updating terminal card for a running shell session (from shell_run). It does not consume output, so you can still use shell_read.",
      input: { session_id: z.string() },
      effect: "read",
      meta: viewerMeta("開啟終端機…", "終端機已顯示"),
    },
    async (a) => {
      const p = rt.shells.peek(a.session_id);
      const { text: _t, ...light } = terminalData(p);
      return cardResult(light, terminalData(p), [{ type: "text", text: `live terminal card for ${a.session_id} shown to the user.` }]);
    },
  );

  define(
    "shell_peek",
    { title: "Terminal tail (for cards)", description: "Internal: latest output of a shell session for the live terminal card.", input: { session_id: z.string() }, effect: "read", meta: { "openai/widgetAccessible": true, "openai/visibility": "private" } },
    async (a) => {
      const d = terminalData(rt.shells.peek(a.session_id));
      return cardResult({ kind: d.kind, live: d.live }, d, [{ type: "text", text: "ok" }]);
    },
  );

  // ------------------------------------------------------------------ handoffs
  define(
    "handoff_save",
    {
      title: "Save a handoff note",
      description:
        "Save a handoff note so work can continue in a new conversation (long chats get slow). Include: goal, decisions, current state, files/paths, commands to run, open problems, exact next steps.",
      input: { title: z.string().min(3).max(120), content: z.string().min(20), project: z.string().optional().describe("Project folder this handoff belongs to") },
      effect: "write",
      destructive: false,
    },
    async (a) => {
      const slug = a.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "handoff";
      const file = path.join(handoffDir(), `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${slug}.md`);
      const body = `# ${a.title}\n\n- 電腦：${machineName(rt)}\n- 時間：${new Date().toLocaleString()}\n${a.project ? `- 專案：${rt.files.resolve(a.project)}\n` : ""}\n${a.content.trim()}\n`;
      await fsp.writeFile(file, body, "utf8");
      // The same note also goes back as a file so the user can keep it in ChatGPT's Library, which
      // survives even when this conversation (or the PC) is not available.
      return {
        content: [
          { type: "text", text: `handoff saved on the PC: ${file}\nIn a new conversation, call handoff_load to continue. The note is also attached here — tell the user they can save it to ChatGPT's Library (檔案庫) as a backup.` },
          { type: "resource", resource: { uri: `file:///${encodeURIComponent(path.basename(file))}`, mimeType: "text/markdown", text: body } },
        ],
      };
    },
  );

  define(
    "handoff_load",
    {
      title: "Load a handoff note",
      description: "Load the latest handoff note (or one by name) to continue earlier work.",
      input: { name: z.string().optional().describe("File name or part of it; default = latest") },
      effect: "read",
    },
    async (a) => {
      const files = readdirSync(handoffDir()).filter((f) => f.endsWith(".md")).sort();
      if (!files.length) return "no handoff notes yet";
      const pick = a.name ? files.filter((f) => f.includes(a.name!)).pop() : files.at(-1);
      if (!pick) return `no handoff matching "${a.name}". Available:\n${files.slice(-20).join("\n")}`;
      const text = await fsp.readFile(path.join(handoffDir(), pick), "utf8");
      return `${pick}\n\n${text}${files.length > 1 ? `\n\n(other notes: ${files.filter((f) => f !== pick).slice(-10).join(", ")})` : ""}`;
    },
  );
  void existsSync;
}

function terminalData(p: { sessionId: string; command: string; running: boolean; exitCode: number | null; durationMs: number; text: string }) {
  return {
    kind: "terminal",
    title: p.command.slice(0, 120),
    meta: `${p.running ? "執行中" : `結束（exit ${p.exitCode}）`} · ${Math.round(p.durationMs / 1000)}s`,
    text: p.text || "（尚無輸出）",
    refreshTool: "shell_peek",
    refreshArgs: { session_id: p.sessionId },
    liveMs: 1500,
    live: p.running,
  };
}
