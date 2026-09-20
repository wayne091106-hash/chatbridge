import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCodexBinary } from "../core/execServer.js";

/**
 * Mainstream coding agents installed on this PC, driven in their non-interactive modes.
 * ChatGPT stays the "main brain"; these are workers it can hand whole tasks to.
 */

export type AgentId = "codex" | "claude" | "gemini" | "kilo" | "opencode" | "cline";
export type Access = "read" | "workspace" | "full";

export type HubEventKind = "message" | "thinking" | "command" | "tool" | "file" | "error" | "info" | "done";
export interface HubEvent {
  kind: HubEventKind;
  text: string;
  /** Files touched by this event (file-change events). */
  paths?: string[];
  ts?: number;
}

export interface Launch {
  command: string;
  prefix: string[];
}

export interface AgentDef {
  id: AgentId;
  label: string;
  strengths: string;
  defaultModel?: string;
  /** Other models worth offering in model pickers (the agent accepts any id it knows). */
  suggestedModels?: string[];
  /** Hidden agents still work when asked for by name but are not offered or picked automatically. */
  hidden?: boolean;
  /** How to find the executable; null when not installed. */
  resolve(): Launch | null;
  args(task: string, o: { cwd: string; access: Access; model?: string }): string[];
  parse(obj: any): HubEvent[];
  /** The agent's own conversation id, read from its event stream (used to continue the conversation). */
  sessionFrom?(obj: any): string | undefined;
  /** Arguments that continue an earlier conversation with a new message. */
  resumeArgs?(session: string, task: string, o: { cwd: string; access: Access; model?: string }): string[];
}

/** The owner's preference order: Kilo first, then Cline, then Codex. OpenCode and Gemini are kept but not offered. */
export const PREFERENCE: AgentId[] = ["kilo", "cline", "codex", "claude", "gemini", "opencode"];

const NPM_ROOT = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm");

/** Resolve an npm cmd-shim ("%dp0%\node_modules\...\cli.js") to `node <script>` so no shell quoting is involved. */
export function resolveNpmShim(name: string): Launch | null {
  const cmd = path.join(NPM_ROOT, `${name}.cmd`);
  if (!existsSync(cmd)) return null;
  const m = readFileSync(cmd, "utf8").match(/"%dp0%\\([^"]+)"/g);
  const target = m?.map((s) => s.slice(7, -1)).find((p) => p.startsWith("node_modules"));
  if (!target) return null;
  const script = path.join(NPM_ROOT, target);
  return existsSync(script) ? { command: process.execPath, prefix: [script] } : null;
}

function which(name: string): string | null {
  try {
    const out = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => s.trim()).find((s) => /\.exe$/i.test(s)) ?? null;
  } catch {
    return null;
  }
}

const exe = (p: string | null): Launch | null => (p && existsSync(p) ? { command: p, prefix: [] } : null);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "…" : s);

export const AGENTS: Record<AgentId, AgentDef> = {
  codex: {
    id: "codex",
    label: "Codex CLI",
    strengths: "OpenAI's coding agent; strong at multi-file code changes and running tests. Uses the ChatGPT Codex quota.",
    defaultModel: "gpt-5.6-sol",
    suggestedModels: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    resolve: () => exe(findCodexBinary()),
    sessionFrom: (e) => (e.type === "thread.started" ? str(e.thread_id) || undefined : undefined),
    resumeArgs: (session, task, o) => [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      // `resume` has no -s flag; the sandbox is set through config instead.
      ...(o.access === "full" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", `sandbox_mode="${o.access === "read" ? "read-only" : "workspace-write"}"`]),
      ...(o.model ? ["-m", o.model] : []),
      session,
      task,
    ],
    args: (task, o) => [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-C",
      o.cwd,
      ...(o.access === "full" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", o.access === "read" ? "read-only" : "workspace-write"]),
      ...(o.model ? ["-m", o.model] : []),
      task,
    ],
    parse(e) {
      const item = e.item ?? {};
      if (e.type === "item.completed") {
        switch (item.type) {
          case "agent_message":
            return [{ kind: "message", text: str(item.text) }];
          case "reasoning":
            return [{ kind: "thinking", text: clip(str(item.text), 300) }];
          case "command_execution":
            return [{ kind: "command", text: `${str(item.command)}${item.exit_code !== undefined ? `  → exit ${item.exit_code}` : ""}` }];
          case "file_change": {
            const paths = (item.changes ?? []).map((c: any) => str(c.path));
            return [{ kind: "file", text: (item.changes ?? []).map((c: any) => `${c.kind ?? "edit"} ${c.path}`).join(", "), paths }];
          }
          case "mcp_tool_call":
          case "web_search":
            return [{ kind: "tool", text: `${item.type} ${clip(str(item.tool ?? item.query ?? ""), 200)}` }];
          case "error":
            return [{ kind: "error", text: str(item.message) }];
        }
      }
      if (e.type === "error" || e.type === "turn.failed") return [{ kind: "error", text: str(e.message ?? e.error?.message) }];
      return [];
    },
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    strengths: "Anthropic's coding agent; strong at large refactors, careful reasoning and repository-wide changes.",
    suggestedModels: ["opus", "sonnet", "haiku"],
    resolve: () => exe(which("claude") ?? path.join(os.homedir(), ".local", "bin", "claude.exe")),
    sessionFrom: (e) => (typeof e.session_id === "string" ? e.session_id : undefined),
    resumeArgs(session, task, o) {
      return ["--resume", session, ...this.args(task, o)];
    },
    args: (task, o) => [
      "-p",
      task,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(o.access === "full" ? ["--dangerously-skip-permissions"] : ["--permission-mode", o.access === "read" ? "plan" : "acceptEdits"]),
      ...(o.model ? ["--model", o.model] : []),
    ],
    parse(e) {
      if (e.type === "assistant") {
        return (e.message?.content ?? []).flatMap((c: any): HubEvent[] => {
          if (c.type === "text" && c.text) return [{ kind: "message", text: c.text }];
          if (c.type === "tool_use") {
            const input = c.input ?? {};
            const file = input.file_path ?? input.path;
            if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.name) && file) return [{ kind: "file", text: `${c.name} ${file}`, paths: [str(file)] }];
            if (c.name === "Bash" || c.name === "PowerShell") return [{ kind: "command", text: str(input.command) }];
            return [{ kind: "tool", text: `${c.name} ${clip(str(input.pattern ?? input.file_path ?? input.url ?? input.description ?? ""), 200)}` }];
          }
          return [];
        });
      }
      if (e.type === "result") return [{ kind: e.is_error ? "error" : "done", text: str(e.result) }];
      return [];
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    strengths: "Google's agent; very long context. Currently unusable on this PC (Google dropped the free tier for this CLI).",
    hidden: true,
    resolve: () => resolveNpmShim("gemini"),
    args: (task, o) => ["-p", task, "-o", "stream-json", "--approval-mode", o.access === "read" ? "plan" : o.access === "workspace" ? "auto_edit" : "yolo", ...(o.model ? ["-m", o.model] : [])],
    parse(e) {
      if (e.type === "message" && e.role === "assistant" && e.content) return [{ kind: "message", text: str(e.content) }];
      if (e.type === "tool_use") return [{ kind: "tool", text: `${str(e.tool_name)} ${clip(str(e.parameters), 200)}` }];
      if (e.type === "error") return [{ kind: "error", text: str(e.message ?? e.error) }];
      if (e.type === "result") return [{ kind: e.status === "error" ? "error" : "info", text: `result: ${str(e.status)}` }];
      return [];
    },
  },
  kilo: {
    id: "kilo",
    label: "Kilo Code CLI",
    strengths: "The owner's default worker: open-source agent with 900+ models (Gemini 3.8 Flash via Vertex by default). Supports long conversations you can pause, resume and steer.",
    defaultModel: "google-vertex/gemini-3.8-flash",
    suggestedModels: ["google-vertex/gemini-3.8-flash", "google-vertex/gemini-3.1-pro-preview", "kilo/deepseek/deepseek-v4-flash-0731:free", "kilo/qwen/qwen3.8-27b:free", "nvidia/z-ai/glm-5.3-flash"],
    resolve: () => resolveNpmShim("kilo") ?? resolveNpmShim("kilocode"),
    args: (task, o) => ["run", task, "--format", "json", "--dir", o.cwd, ...(o.access !== "read" ? ["--auto"] : []), ...(o.model ? ["-m", o.model] : [])],
    parse: parseOpencode,
    sessionFrom: (e) => (typeof e.sessionID === "string" ? e.sessionID : undefined),
    resumeArgs(session, task, o) {
      return [...this.args(task, o), "--session", session];
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    strengths: "Fast open-source agent with free built-in models. Kept installed but not offered (owner's choice); use only when asked for by name.",
    defaultModel: "opencode/nemotron-3.5-lightning-free",
    hidden: true,
    resolve: () => exe(which("opencode") ?? path.join(os.homedir(), ".opencode", "bin", "opencode.exe")),
    args: (task, o) => ["run", task, "--format", "json", "--dir", o.cwd, ...(o.access !== "read" ? ["--auto"] : []), ...(o.model ? ["-m", o.model] : [])],
    parse: parseOpencode,
    sessionFrom: (e) => (typeof e.sessionID === "string" ? e.sessionID : undefined),
    resumeArgs(session, task, o) {
      return [...this.args(task, o), "--session", session];
    },
  },
  cline: {
    id: "cline",
    label: "Cline CLI",
    strengths: "Second choice: open-source agent with its own free models (DeepSeek V4.1 Flash by default); fast and reliable plan/act workflow.",
    defaultModel: "cline-free/deepseek-v4.1-flash",
    suggestedModels: ["cline-free/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "cline-free/solar-pro4", "cline-free/muse-spark-1.3-contributor", "poolside/laguna-s-2.1:free"],
    resolve: () => resolveNpmShim("cline"),
    args: (task, o) => ["--json", "-c", o.cwd, ...(o.access === "read" ? ["--plan", "-y"] : ["--act", "-y"]), ...(o.model ? ["-m", o.model] : []), task],
    // No resumeArgs: `cline --id <session>` only works interactively (JSON mode says it needs a prompt even when
    // one is given; checked with Cline 3.0.62), so follow-ups start a fresh run with a handover of the last report.
    parse(e) {
      // Cline ≥ 2.x: {"type":"agent_event","event":{...}}
      if (e.type === "agent_event") {
        const ev = e.event ?? {};
        // The final report comes as "Submission recorded (verified): <report>".
        if (ev.type === "done") return [{ kind: "done", text: str(ev.text).replace(/^Submission recorded(?: \(verified\))?:\s*/, "") }];
        if (ev.type === "content_end" && ev.contentType === "text" && ev.text) return [{ kind: "message", text: str(ev.text) }];
        if (ev.type === "content_end" && ev.contentType === "reasoning" && ev.reasoning) return [{ kind: "thinking", text: clip(str(ev.reasoning), 300) }];
        if (ev.type === "content_start" && ev.contentType === "tool") {
          const input = ev.input ?? {};
          const name = str(ev.toolName);
          if (name === "run_commands") return [{ kind: "command", text: Array.isArray(input.commands) ? input.commands.join(" && ") : str(input.commands) }];
          if (input.path && /editor|write|edit|replace/i.test(name)) return [{ kind: "file", text: `${name} ${input.path}`, paths: [str(input.path)] }];
          return [{ kind: "tool", text: `${name} ${clip(str(input.path ?? input.query ?? input.url ?? ""), 200)}` }];
        }
        if (ev.type === "content_end" && ev.contentType === "tool") {
          const outs = Array.isArray(ev.output) ? ev.output : [ev.output];
          const failed = outs.filter((o: any) => o && o.success === false);
          return failed.map((o: any) => ({ kind: "error" as const, text: `${str(ev.toolName)} failed: ${clip(str(o.result ?? o.error), 300)}` }));
        }
        if (ev.type === "error") return [{ kind: "error", text: str(ev.message ?? ev.error) }];
        return [];
      }
      if (e.type === "run_result") return e.finishReason && e.finishReason !== "completed" ? [{ kind: "error", text: `finished: ${str(e.finishReason)}` }] : [];
      if (e.type === "error") return [{ kind: "error", text: str(e.message ?? e.error) }];
      if (e.type !== "say") return e.type === "ask" && e.text ? [{ kind: "info", text: `asks: ${clip(str(e.text), 300)}` }] : [];
      switch (e.say) {
        case "text":
          return e.text ? [{ kind: "message", text: str(e.text) }] : [];
        case "reasoning":
          return [{ kind: "thinking", text: clip(str(e.text), 300) }];
        case "completion_result":
          return [{ kind: "done", text: str(e.text) }];
        case "command":
          return [{ kind: "command", text: str(e.text) }];
        case "tool": {
          let t: any = {};
          try {
            t = JSON.parse(e.text);
          } catch {
            /* plain text */
          }
          const file = t.path;
          if (file && /edit|write|new|replace/i.test(str(t.tool))) return [{ kind: "file", text: `${t.tool} ${file}`, paths: [str(file)] }];
          return [{ kind: "tool", text: clip(str(t.tool ? `${t.tool} ${file ?? ""}` : e.text), 200) }];
        }
        case "error":
        case "api_req_failed":
          return [{ kind: "error", text: str(e.text) }];
      }
      return [];
    },
  },
};

function parseOpencode(e: any): HubEvent[] {
  const p = e.part ?? {};
  if (e.type === "text" && p.text) return [{ kind: "message", text: str(p.text) }];
  if (e.type === "reasoning" && p.text) return [{ kind: "thinking", text: clip(str(p.text), 300) }];
  if (e.type === "tool_use") {
    const input = p.state?.input ?? {};
    const tool = str(p.tool);
    const file = input.filePath ?? input.path ?? input.file_path;
    if (/edit|write|patch/i.test(tool) && file) return [{ kind: "file", text: `${tool} ${file}`, paths: [str(file)] }];
    if (tool === "bash") return [{ kind: "command", text: `${str(input.command)}${p.state?.metadata?.exit !== undefined ? `  → exit ${p.state.metadata.exit}` : ""}` }];
    return [{ kind: "tool", text: `${tool} ${clip(str(p.state?.title ?? file ?? ""), 200)}` }];
  }
  if (e.type === "error") return [{ kind: "error", text: str(e.error?.data?.message ?? e.error?.message ?? e.error) }];
  return [];
}

/** Agents in the owner's preference order. */
export function agentIds(): AgentId[] {
  return PREFERENCE.filter((id) => id in AGENTS);
}

/** Agents offered in lists and pickers (hidden ones still run when asked for by name). */
export function offeredAgentIds(): AgentId[] {
  return agentIds().filter((id) => !AGENTS[id].hidden);
}
