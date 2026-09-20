import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCodexBinary } from "../../core/execServer.js";
import { randomId } from "../../core/util.js";
import { ProviderError, textOf, type ChatMessage, type CompletionRequest, type CompletionResponse, type ModelProvider } from "./types.js";

export interface CodexProviderOptions {
  model?: string;
  codexPath?: string;
  contextWindow?: number;
  timeoutMs?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "tool_calls"],
  properties: {
    message: { type: "string", description: "Text for the user. Leave empty when calling tools mid-task." },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments_json"],
        properties: { name: { type: "string" }, arguments_json: { type: "string", description: "JSON object with the tool arguments" } },
      },
    },
  },
};

function renderTranscript(messages: ChatMessage[], imageFiles: string[], dir: string): { system: string; transcript: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "image") {
          const f = path.join(dir, `img-${imageFiles.length}.${p.mimeType.includes("jpeg") ? "jpg" : "png"}`);
          writeFileSync(f, Buffer.from(p.data, "base64"));
          imageFiles.push(f);
        }
      }
    }
    const body = textOf(m.content);
    if (m.role === "user") lines.push(`<user>\n${body}\n</user>`);
    else if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => `<tool_call id="${c.id}" name="${c.name}">${c.arguments}</tool_call>`).join("\n");
      lines.push(`<assistant>\n${body}${calls ? `\n${calls}` : ""}\n</assistant>`);
    } else if (m.role === "tool") lines.push(`<tool_result id="${m.toolCallId}" name="${m.name ?? ""}">\n${body}\n</tool_result>`);
  }
  return { system, transcript: lines.join("\n\n") };
}

/**
 * Uses the locally logged-in Codex CLI (ChatGPT subscription) as a reasoning engine. Codex runs
 * read-only and returns a structured decision (message + tool calls) that Kestrel executes with
 * its own tools, so the agent loop, memory and policies stay in Kestrel.
 */
export class CodexProvider implements ModelProvider {
  readonly name = "codex";
  readonly model: string;
  readonly contextWindow: number;
  readonly supportsImages = true;

  constructor(private readonly o: CodexProviderOptions = {}) {
    this.model = o.model ?? "codex-default";
    this.contextWindow = o.contextWindow ?? 200_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const bin = findCodexBinary(this.o.codexPath);
    if (!bin) throw new ProviderError("codex CLI not found; install @openai/codex and run `codex login`");
    const dir = mkdtempSync(path.join(os.tmpdir(), "kestrel-codex-"));
    try {
      const images: string[] = [];
      const { system, transcript } = renderTranscript(req.messages, images, dir);
      const toolList = (req.tools ?? []).map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join("\n");
      const prompt = [
        "You are acting as the reasoning engine (the model) for an external agent called Kestrel.",
        "IMPORTANT: Do not run shell commands, read files or edit anything yourself in this environment. Only decide the next step and answer with the required JSON.",
        "",
        "# Agent system prompt",
        system,
        "",
        req.tools?.length ? `# Tools Kestrel can execute for you\n${toolList}\n\nTo use tools, put them in tool_calls (arguments_json must be a JSON object string). When the task is complete or you need the user, return tool_calls: [] and write the reply in message.` : "# No tools are available. Reply in message with tool_calls: [].",
        req.json ? "\nThe message field itself must contain valid JSON as requested by the system prompt." : "",
        "",
        "# Conversation so far",
        transcript,
        "",
        "Decide the assistant's next turn now.",
      ].join("\n");
      const schemaFile = path.join(dir, "schema.json");
      const outFile = path.join(dir, "last.json");
      writeFileSync(schemaFile, JSON.stringify(SCHEMA));
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "--output-schema", schemaFile, "-o", outFile, "-C", dir];
      if (this.o.model) args.push("-m", this.o.model);
      if (this.o.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.o.reasoningEffort}"`);
      for (const img of images) args.push("-i", img);
      args.push("-");

      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { cwd: dir, windowsHide: true, shell: /\.cmd$/i.test(bin), stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.stdout.on("data", () => {});
        const timer = setTimeout(() => {
          child.kill();
          reject(new ProviderError("codex exec timed out", undefined, true));
        }, this.o.timeoutMs ?? 600_000);
        const onAbort = () => child.kill();
        req.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => reject(new ProviderError(`codex exec failed to start: ${err.message}`)));
        child.on("close", (code) => {
          clearTimeout(timer);
          req.signal?.removeEventListener("abort", onAbort);
          if (code === 0) return resolve();
          // Codex echoes the prompt on stderr; keep only its error lines.
          const errors = stderr.split(/\r?\n/).filter((l) => /^ERROR:|error:/i.test(l.trim()));
          const detail = [...new Set(errors)].join("\n") || stderr.slice(-600);
          if (/usage limit|rate limit|too many requests|429/i.test(detail)) reject(new ProviderError(`codex: ${detail}`, 429, false));
          else if (/not logged in|login|unauthorized|401/i.test(detail)) reject(new ProviderError(`codex: ${detail} (run \`codex login\`)`, 401, false));
          else reject(new ProviderError(`codex exec exited ${code}: ${detail}`, undefined, /timeout|network|5\d\d|stream disconnected/i.test(detail)));
        });
        child.stdin.end(prompt);
      });

      let parsed: { message: string; tool_calls: Array<{ name: string; arguments_json: string }> };
      try {
        parsed = JSON.parse(readFileSync(outFile, "utf8"));
      } catch (err) {
        throw new ProviderError(`codex returned unparseable output: ${(err as Error).message}`, undefined, true);
      }
      const toolCalls = (parsed.tool_calls ?? []).map((c) => ({ id: randomId("call_", 6), name: c.name, arguments: c.arguments_json || "{}" }));
      if (parsed.message) req.onText?.(parsed.message);
      return { content: parsed.message ?? "", toolCalls, stopReason: toolCalls.length ? "tool_calls" : "stop", usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(JSON.stringify(parsed).length / 4) } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
