import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { subjectFromArgs, type ToolEffect } from "../core/policy.js";
import { isVerified, questionCount } from "../core/ownerQuiz.js";
import type { ShellSnapshot } from "../core/shell.js";
import { errorMessage } from "../core/util.js";
import { registerFileTransfer } from "./xfer.js";
import { registerDrive } from "./drive.js";
import { registerSummary } from "./summary.js";
import { registerRelay } from "./relay.js";
import { registerOwnerCheck } from "./ownerCheck.js";
import { registerBrowser } from "./browser.js";
import { registerExtras, machineName } from "./extras.js";
import { registerHub } from "../hub/tools.js";
import { registerWorkbench } from "../hub/workbench.js";

export const SERVER_NAME = "chatbridge";
export const SERVER_VERSION = "1.3.0";

export const INSTRUCTIONS = `ChatBridge gives you hands on the owner's Windows PC (their own machine, full access granted by the owner).

Working style:
- Start with computer_info when you need to know the environment (OS, GPU, disks, default working directory).
- shell_run executes a command (PowerShell by default). It returns after yield_seconds even if the command is still running; then poll with shell_read (or feed input with shell_write). Long builds/trainings are fine this way.
- Prefer fs_read / fs_edit / apply_patch / fs_write for files over echo/sed in the shell. fs_edit needs an exact unique old_string. apply_patch uses the Codex patch format.
- Every file mutation is checkpointed; fs_checkpoints can undo the last change set.
- For GUI work: screen_capture, then mouse/keyboard using coordinates from that screenshot.
- If a tool says the bridge is paused, stop and tell the user; the owner paused it deliberately.
- Report what you changed. Do not exfiltrate secrets (keys, passwords, tokens) into the chat unless the user explicitly asks for that specific value.

Staying alive (ChatGPT's own limits, not the PC's):
- Never block: a call that needs more than ~50 s answers "still running" with a ticket id — keep working on something else and pick the result up with op_status. Long jobs belong in shell_run (small yield_seconds) or agent_run plus polling.
- ChatGPT cuts off a single answer that runs too many steps, and drops these tools from long conversations. So: report progress to the user in stages instead of doing everything in one silent answer, and around 50–80 tool calls call handoff_save and continue in a new chat.
- If tool calls stop working or you are unsure which tools exist, call chatbridge_guide (and bridge_version) again — that re-reads this PC's tool list. Never invent a tool result; if a call did not run, say so.`;

export interface ToolContext {
  rt: Runtime;
  /** Who is calling when the transport carries no identity (the local workbench marks itself). */
  actor?: string;
  /** Extra tool groups (e.g. the Kestrel agent) can register here. */
  extensions?: Array<(server: McpServer, define: DefineTool, rt: Runtime) => void>;
}

export type DefineTool = <S extends z.ZodRawShape>(
  name: string,
  spec: {
    title: string;
    description: string;
    input: S;
    effect: ToolEffect;
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    meta?: Record<string, unknown>;
    /** The arguments are a secret of the owner's (e.g. the answer to a personal question): never audit them. */
    privateArgs?: boolean;
  },
  handler: (args: z.infer<z.ZodObject<S>>, actor: string) => Promise<CallToolResult | string | object>,
  subject?: (args: z.infer<z.ZodObject<S>>) => { command?: string; paths?: string[] },
) => void;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

/** These lift the owner check, so they can never be behind it. */
const QUIZ_TOOLS = new Set(["owner_challenge", "owner_answer", "chatbridge_guide", "bridge_version", "op_status"]);

export function formatShell(s: ShellSnapshot): string {
  const status = s.running ? "still running — poll with shell_read" : `exit ${s.exitCode ?? "?"}`;
  const secs = (s.durationMs / 1000).toFixed(1);
  const header = `[session ${s.sessionId} | ${status} | ${secs}s | cwd ${s.cwd}]${s.truncated ? " (output truncated in the middle)" : ""}`;
  return `${header}\n${s.output || "(no output yet)"}`;
}

/**
 * ChatGPT quietly drops an app's tools from long conversations (context compression), so work stops
 * mid-task with no error on this side. Counting calls since the guide (which the model calls when a
 * conversation starts) lets us remind it to hand over and continue in a fresh chat before that happens.
 */
const REMIND_AT = [45, 70, 95];
function makeHandoffReminder() {
  let calls = 0;
  return (name: string, result: CallToolResult) => {
    if (name === "chatbridge_guide") {
      calls = 0;
      return;
    }
    calls++;
    if (!REMIND_AT.includes(calls) || result.isError) return;
    result.content.push({
      type: "text",
      text: `[ChatBridge] ${calls} tool calls in this conversation. ChatGPT silently drops app tools from long conversations — when you notice tools missing, or around 100 calls, call handoff_save with the current state and next steps and tell the user to continue in a new chat (handoff_load there).`,
    });
  };
}

/**
 * ChatGPT gives up on a tool call after ~60 s (and silently retries it once), so no call may block
 * longer. A call that is still working at 50 s answers "still running" with a ticket; the work keeps
 * going here and its result is collected later with op_status.
 */
const slowCallSeconds = () => Number(process.env.CHATBRIDGE_SLOW_CALL_SECONDS ?? 50);
interface PendingOp {
  tool: string;
  startedAt: number;
  result?: CallToolResult;
  error?: string;
}
const pendingOps = new Map<string, PendingOp>();

function parkSlowCall(tool: string, work: Promise<CallToolResult>): CallToolResult {
  const id = `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const op: PendingOp = { tool, startedAt: Date.now() };
  pendingOps.set(id, op);
  for (const [k, v] of pendingOps) if (v.result && Date.now() - v.startedAt > 3600_000) pendingOps.delete(k);
  void work.then(
    (r) => (op.result = r),
    (e) => (op.error = errorMessage(e)),
  );
  return text(
    `${tool} is taking longer than ${slowCallSeconds()}s and is still running on the PC (ticket ${id}). Nothing failed. Do something else or answer the user now, and pick the result up later with op_status (id "${id}"). Do not repeat this call.`,
  );
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const { rt } = ctx;
  const handoffReminder = makeHandoffReminder();
  const instructions = `Computer: "${machineName(rt)}". Call chatbridge_guide first in a new conversation.\n\n${INSTRUCTIONS}`;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions, capabilities: { logging: {} } });

  const define: DefineTool = (name, spec, handler, subject) => {
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly ?? spec.effect === "read",
          destructiveHint: spec.destructive ?? spec.effect !== "read",
          openWorldHint: spec.openWorld ?? false,
          idempotentHint: spec.effect === "read",
        },
        ...(spec.meta ? { _meta: spec.meta } : {}),
      },
      (async (args: any, extra: any) => {
        const actor = extra?.authInfo?.clientId ? String(extra.authInfo.clientId) : (ctx.actor ?? "local");
        // What goes in the audit log. Some tools carry a secret the owner typed, and the log is meant to be
        // readable later — including by the model — so those never record their arguments.
        const logArgs = spec.privateArgs ? {} : args;
        const started = Date.now();
        rt.state.reload();
        if (rt.state.paused) {
          rt.audit.write({ actor, action: name, args: logArgs, outcome: "paused" });
          return { isError: true, content: [{ type: "text", text: `ChatBridge is paused by the owner${rt.state.pausedReason ? ` (${rt.state.pausedReason})` : ""}. Do not retry; tell the user.` }] };
        }
        // Paths and commands are read straight out of the arguments, so every tool is covered without
        // each one having to declare them; a tool may still add more through `subject`.
        const declared = subject?.(args) ?? {};
        const derived = subjectFromArgs(args);
        // "Is this really you?" — a chat that has been talked into something drastic by a web page or a
        // README cannot answer a question only the owner knows. The two quiz tools are exempt, or there
        // would be no way to lift the gate.
        const asksOwner = rt.config.policy.askOwnerFor.includes(spec.effect as any) || rt.config.policy.askOwnerForTools.includes(name);
        if (!QUIZ_TOOLS.has(name) && asksOwner && questionCount() > 0 && !isVerified()) {
          rt.audit.write({ actor, action: name, args: logArgs, outcome: "denied", detail: "owner not verified" });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `This PC asks the owner to identify themselves before ${rt.config.policy.askOwnerForTools.includes(name) ? name : `${spec.effect} actions`}. Call owner_challenge, show the question to the user exactly as written, then pass their reply to owner_answer. Do not guess the answer yourself and do not retry this call until they have answered.`,
              },
            ],
          };
        }
        const decision = rt.policy.check(spec.effect, {
          command: declared.command ?? derived.command,
          paths: [...(derived.paths ?? []), ...(declared.paths ?? [])],
        });
        if (!decision.allowed) {
          rt.audit.write({ actor, action: name, args: logArgs, outcome: "denied", detail: decision.reason });
          return { isError: true, content: [{ type: "text", text: `Denied by owner policy: ${decision.reason}` }] };
        }
        // Each mutating call is its own undoable checkpoint.
        const checkpointed = spec.effect === "write" && name !== "fs_checkpoints";
        if (checkpointed) rt.checkpoints.beginTurn(`${actor}: ${name} ${JSON.stringify(args).slice(0, 120)}`);
        try {
          const work = (async () => {
            const out = await handler(args, actor);
            const result: CallToolResult = typeof out === "string" ? text(out) : "content" in (out as any) ? (out as CallToolResult) : text(JSON.stringify(out, null, 2));
            rt.audit.write({ actor, action: name, args: logArgs, outcome: result.isError ? "error" : "ok", durationMs: Date.now() - started });
            return result;
          })();
          // op_status is the way to collect a parked call, so it never parks itself.
          if (name === "op_status") {
            const r = await work;
            handoffReminder(name, r);
            return r;
          }
          let timer: NodeJS.Timeout | undefined;
          const slow = new Promise<"slow">((resolve) => (timer = setTimeout(() => resolve("slow"), slowCallSeconds() * 1000)));
          const raced = await Promise.race([work, slow]);
          clearTimeout(timer);
          if (raced === "slow") return parkSlowCall(name, work);
          handoffReminder(name, raced);
          return raced;
        } catch (err) {
          const msg = errorMessage(err);
          rt.audit.write({ actor, action: name, args: logArgs, outcome: "error", detail: msg, durationMs: Date.now() - started });
          return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
        } finally {
          if (checkpointed) rt.checkpoints.endTurn();
        }
      }) as any,
    );
  };

  // ---------------------------------------------------------------- environment
  define(
    "bridge_version",
    {
      title: "Bridge version",
      description: "Version of the ChatBridge server on this PC and the names of every tool it offers right now. Compare with the tools you can see to tell whether your tool list is up to date.",
      input: {},
      effect: "read",
    },
    async () => {
      const names = Object.keys((server as any)._registeredTools ?? {}).sort();
      return { computer: machineName(rt), version: SERVER_VERSION, toolCount: names.length, tools: names };
    },
  );

  define(
    "op_status",
    {
      title: "Pick up a slow call's result",
      description:
        "Collect the result of a tool call that was still running when it answered with a ticket id. wait_seconds waits up to that long for it to finish; if it is still running, do something else and ask again later.",
      input: { id: z.string(), wait_seconds: z.number().min(0).max(45).optional() },
      effect: "read",
    },
    async (a) => {
      const op = pendingOps.get(a.id);
      if (!op) throw new Error(`unknown ticket ${a.id} (it may be older than an hour)`);
      const deadline = Date.now() + (a.wait_seconds ?? 0) * 1000;
      while (!op.result && !op.error && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      const secs = Math.round((Date.now() - op.startedAt) / 1000);
      if (op.error) {
        pendingOps.delete(a.id);
        return { isError: true, content: [{ type: "text", text: `${op.tool} failed after ${secs}s: ${op.error}` }] };
      }
      if (!op.result) return `${op.tool} is still running (${secs}s so far). Do something else and call op_status again later.`;
      pendingOps.delete(a.id);
      return { ...op.result, content: [{ type: "text", text: `${op.tool} finished after ${secs}s:` }, ...op.result.content] };
    },
  );

  define(
    "computer_info",
    { title: "Computer info", description: "OS, CPU, RAM, GPUs (nvidia-smi), disks, executor version and the current default working directory.", input: {}, effect: "read" },
    async () => ({ computer: machineName(rt), ...(await rt.desktop.systemInfo()), workingDirectory: rt.cwd.value, policy: rt.policy.mode }),
  );

  define(
    "set_working_directory",
    { title: "Set working directory", description: "Change the default directory used by shell_run and relative file paths.", input: { path: z.string().describe("Absolute path, or relative to the current working directory") }, effect: "read", readOnly: true, destructive: false },
    async ({ path: p }) => {
      const abs = rt.files.resolve(p);
      const st = await rt.executor.stat(abs);
      if (!st?.isDirectory) throw new Error(`not a directory: ${abs}`);
      rt.cwd.value = abs;
      return `working directory is now ${abs}`;
    },
  );

  // ---------------------------------------------------------------- shell
  define(
    "shell_run",
    {
      title: "Run command",
      description:
        "Run a shell command on the PC. Returns combined stdout/stderr. If it is still running after yield_seconds the session keeps running in the background — continue with shell_read/shell_write/shell_kill using the session id.",
      input: {
        command: z.string().min(1).describe("Command line. PowerShell syntax by default."),
        cwd: z.string().optional().describe("Working directory (default: current working directory)"),
        shell: z.enum(["powershell", "pwsh", "cmd", "bash"]).optional().describe("Shell to use (default powershell on Windows)"),
        yield_seconds: z.number().min(0).max(45).optional().describe("How long to wait before returning (default 25)"),
        interactive: z.boolean().optional().describe("Keep stdin open for shell_write (e.g. REPLs, prompts)"),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal (for programs that require a TTY)"),
      },
      effect: "execute",
      openWorld: true,
    },
    async (a) =>
      formatShell(
        await rt.shells.run({
          command: a.command,
          cwd: a.cwd ? rt.files.resolve(a.cwd) : rt.cwd.value,
          shell: a.shell,
          yieldSeconds: a.yield_seconds ?? rt.config.shell.defaultYieldSeconds,
          interactive: a.interactive,
          tty: a.tty,
        }),
      ),
    (a) => ({ command: a.command, paths: a.cwd ? [a.cwd] : [] }),
  );

  define(
    "shell_read",
    { title: "Read command output", description: "Get new output from a running or finished shell session, waiting up to wait_seconds for more.", input: { session_id: z.string(), wait_seconds: z.number().min(0).max(45).optional() }, effect: "read" },
    async (a) => formatShell(await rt.shells.read(a.session_id, a.wait_seconds ?? 10)),
  );

  define(
    "shell_write",
    {
      title: "Send input to command",
      description: "Write to the stdin of an interactive shell session (started with interactive=true or tty=true) and return the output produced afterwards.",
      input: {
        session_id: z.string(),
        input: z.string().describe("Text to send. Use \\u0003 for Ctrl+C in tty sessions."),
        append_newline: z.boolean().optional().describe("Append Enter (default true)"),
        wait_seconds: z.number().min(0).max(45).optional(),
      },
      effect: "execute",
    },
    async (a) => formatShell(await rt.shells.write(a.session_id, a.input + (a.append_newline === false ? "" : "\r\n"), a.wait_seconds ?? 2)),
    (a) => ({ command: a.input }),
  );

  define(
    "shell_kill",
    { title: "Stop command", description: "Terminate a shell session and its child processes.", input: { session_id: z.string() }, effect: "execute" },
    async (a) => formatShell(await rt.shells.kill(a.session_id)),
  );

  define("shell_list", { title: "List command sessions", description: "List shell sessions with status and unread output size.", input: {}, effect: "read" }, async () => ({ sessions: rt.shells.list() }));

  // ---------------------------------------------------------------- files
  define(
    "fs_read",
    {
      title: "Read file",
      description: "Read a text file with line numbers. Use offset/limit for large files.",
      input: { path: z.string(), offset: z.number().int().min(1).optional().describe("1-based start line"), limit: z.number().int().min(1).max(5000).optional() },
      effect: "read",
    },
    async (a) => {
      const r = await rt.files.read(a.path, { offset: a.offset, limit: a.limit });
      if (r.binary) return r.text;
      const more = r.truncated ? `\n[showing lines ${r.fromLine}-${r.toLine} of ${r.totalLines}; use offset to read more]` : "";
      return `${r.path} (${r.totalLines} lines)\n${r.text}${more}`;
    },
    (a) => ({ paths: [a.path] }),
  );

  define(
    "fs_write",
    { title: "Write file", description: "Create or overwrite a file with the given content (parent directories are created).", input: { path: z.string(), content: z.string() }, effect: "write" },
    async (a) => {
      const r = await rt.files.write(a.path, a.content);
      return `wrote ${r.bytes} bytes to ${r.path}`;
    },
    (a) => ({ paths: [a.path] }),
  );

  define(
    "fs_edit",
    {
      title: "Edit file",
      description: "Replace an exact string in a file. old_string must match exactly (including indentation) and be unique unless replace_all is true.",
      input: { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
      effect: "write",
    },
    async (a) => {
      const r = await rt.files.edit(a.path, a.old_string, a.new_string, a.replace_all);
      return `edited ${r.path} (${r.replacements} replacement${r.replacements === 1 ? "" : "s"})`;
    },
    (a) => ({ paths: [a.path] }),
  );

  define(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply a multi-file patch in Codex format:\n*** Begin Patch\n*** Update File: path\n@@ optional anchor\n context\n-old\n+new\n*** Add File: path\n+content\n*** Delete File: path\n*** End Patch\nAll hunks are validated before anything is written.",
      input: { patch: z.string(), cwd: z.string().optional().describe("Base directory for relative paths") },
      effect: "write",
    },
    async (a) => {
      const r = await rt.files.patch(a.patch, a.cwd);
      const lines = [
        ...r.added.map((p) => `A ${p}`),
        ...r.updated.map((p) => `M ${p}`),
        ...r.deleted.map((p) => `D ${p}`),
        ...r.moved.map((m) => `R ${m.from} -> ${m.to}`),
      ];
      return `patch applied:\n${lines.join("\n")}`;
    },
  );

  define(
    "fs_list",
    { title: "List directory", description: "Tree listing of a directory (dependency/build folders are skipped when recursing).", input: { path: z.string().optional(), depth: z.number().int().min(1).max(6).optional() }, effect: "read" },
    async (a) => {
      const r = await rt.files.list(a.path ?? ".", a.depth ?? 1);
      return `${r.path}${r.truncated ? " (truncated)" : ""}\n${r.tree}`;
    },
    (a) => ({ paths: a.path ? [a.path] : [] }),
  );

  define(
    "fs_search",
    {
      title: "Search files",
      description: "Regex search in file contents (ripgrep). Returns path:line:text.",
      input: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().describe("e.g. *.py or src/**/*.ts"),
        ignore_case: z.boolean().optional(),
        files_only: z.boolean().optional(),
        max_results: z.number().int().min(1).max(2000).optional(),
      },
      effect: "read",
    },
    async (a) => {
      const r = await rt.files.search(a.pattern, a.path ?? ".", { glob: a.glob, ignoreCase: a.ignore_case, filesOnly: a.files_only, maxResults: a.max_results });
      return `${r.matches} result(s)${r.truncated ? " (truncated)" : ""} [${r.engine}]\n${r.results}`;
    },
  );

  define(
    "fs_manage",
    { title: "Manage files", description: "mkdir, delete (recursive), copy or move a file/directory.", input: { action: z.enum(["mkdir", "delete", "copy", "move"]), path: z.string(), destination: z.string().optional() }, effect: "write" },
    async (a) => rt.files.manage(a.action, a.path, a.destination),
    (a) => ({ paths: [a.path, ...(a.destination ? [a.destination] : [])] }),
  );

  define(
    "fs_checkpoints",
    {
      title: "File checkpoints",
      description: "List file-change checkpoints or undo one (restores every file changed in that checkpoint; default is the latest).",
      input: { action: z.enum(["list", "undo"]), id: z.number().int().optional() },
      effect: "write",
      destructive: false,
    },
    async (a) => {
      if (a.action === "list") return { checkpoints: rt.checkpoints.list().slice(-30) };
      rt.checkpoints.endTurn();
      return rt.checkpoints.undo(rt.executor, a.id);
    },
  );

  // ---------------------------------------------------------------- desktop
  if (rt.config.features.gui) {
    define(
      "screen_capture",
      {
        title: "Screenshot",
        description:
          "Capture the screen, or one window. Coordinates for mouse are in this image's pixel space. For clicking, always pass `window` (a title substring, from windows_list): the target comes out bigger and the coordinates cannot drift between monitors. Capture again after anything moves.",
        input: {
          max_width: z.number().int().min(320).max(3840).optional(),
          display: z.enum(["all", "primary"]).optional(),
          window: z.union([z.string(), z.number().int()]).optional().describe("Window title substring or pid — capture just that window"),
        },
        effect: "desktop",
        readOnly: true,
        destructive: false,
      },
      async (a) => {
        const { png, meta } = await rt.desktop.screenshot({ maxWidth: a.max_width, display: a.display, window: a.window });
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            {
              type: "text",
              text:
                `screenshot ${meta.outWidth}x${meta.outHeight} of ${a.window ? `window "${a.window}"` : "the screen"} at ${meta.x},${meta.y} ${meta.width}x${meta.height}` +
                `, scale ${Number(meta.scale).toFixed(3)}; cursor at screen ${meta.cursorX},${meta.cursorY}.` +
                ` Give mouse the x,y you read off THIS image.${Number(meta.scale) < 1 ? " It is scaled down, so a few pixels of error here become more on screen — capture a single window for precision." : ""}`,
            },
          ],
        };
      },
    );

    define(
      "mouse",
      {
        title: "Mouse",
        description:
          "Move/click/double_click/right_click/middle_click/scroll/drag. x,y are in the LAST screenshot's pixel space unless space='screen'; take a fresh screen_capture first, and again after the screen changes. The result says where the pointer ended up and which window is in front — check it matches what you aimed at before carrying on. scroll amount: negative = down.",
        input: {
          action: z.enum(["move", "click", "double_click", "right_click", "middle_click", "scroll", "drag"]),
          x: z.number().optional(),
          y: z.number().optional(),
          to_x: z.number().optional(),
          to_y: z.number().optional(),
          amount: z.number().optional(),
          space: z.enum(["screenshot", "screen"]).optional(),
        },
        effect: "desktop",
      },
      async (a) => rt.desktop.mouse({ action: a.action, x: a.x, y: a.y, toX: a.to_x, toY: a.to_y, amount: a.amount, space: a.space }),
    );

    define(
      "keyboard",
      { title: "Keyboard", description: "Type literal text, or send key combos with SendKeys syntax in `keys` (^=Ctrl, %=Alt, +=Shift, {ENTER}, {TAB}, {F5}, ^{ESC}).", input: { text: z.string().optional(), keys: z.string().optional() }, effect: "desktop" },
      async (a) => rt.desktop.keyboard(a),
    );

    define(
      "clipboard",
      { title: "Clipboard", description: "Get or set the clipboard text.", input: { action: z.enum(["get", "set"]), text: z.string().optional() }, effect: "desktop" },
      async (a) => rt.desktop.clipboard(a),
    );

    define("windows_list", { title: "List windows", description: "Top-level windows with process id and title.", input: {}, effect: "read" }, async () => ({ windows: await rt.desktop.windows() }));

    define(
      "window_focus",
      { title: "Focus window", description: "Bring a window to the foreground by pid or title substring.", input: { pid: z.number().int().optional(), title: z.string().optional() }, effect: "desktop" },
      async (a) => rt.desktop.focusWindow(a),
    );
  }

  define(
    "bridge_status",
    { title: "Bridge status", description: "Pause state, policy, executor and recent audit entries.", input: { audit_entries: z.number().int().min(0).max(100).optional() }, effect: "read" },
    async (a) => ({
      paused: rt.state.paused,
      policy: rt.policy.mode,
      executor: await rt.executor.info(),
      workingDirectory: rt.cwd.value,
      shellSessions: rt.shells.list().length,
      recentAudit: rt.audit.tail(a.audit_entries ?? 10).map((r) => ({ ts: r.ts, actor: r.actor, action: r.action, outcome: r.outcome })),
    }),
  );

  registerFileTransfer(server, define, rt);
  registerDrive(define, rt);
  registerExtras(server, define, rt);
  if (rt.config.features.hub) {
    registerHub(server, define, rt);
    registerWorkbench(define, rt);
    registerSummary(define, rt);
  }
  registerRelay(define, rt);
  registerOwnerCheck(define, rt);
  if (rt.config.features.browser) registerBrowser(define, rt);
  {
  }
  for (const ext of ctx.extensions ?? []) ext(server, define, rt);
  auditToolListFetches(server, rt);
  return server;
}

/**
 * Records every time a client (ChatGPT's Refresh, a new session) fetches the tool list, so the owner can
 * check whether ChatGPT has picked up a new version. Wraps the SDK's registered tools/list handler.
 */
function auditToolListFetches(server: McpServer, rt: ToolContext["rt"]) {
  const handlers: Map<string, (req: any, extra: any) => Promise<any>> | undefined = (server.server as any)._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!handlers || !original) return;
  handlers.set("tools/list", async (req, extra) => {
    const result = await original(req, extra);
    const client = server.server.getClientVersion();
    rt.audit.write({
      actor: extra?.authInfo?.clientId ? String(extra.authInfo.clientId) : "local",
      action: "tools/list",
      args: { client: client ? `${client.name} ${client.version}` : "unknown", tools: result?.tools?.length ?? 0, version: SERVER_VERSION },
      outcome: "ok",
    });
    return result;
  });
}
