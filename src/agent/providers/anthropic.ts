import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ChatMessage, type CompletionRequest, type CompletionResponse, type ContentPart, type ModelProvider, type ToolCall } from "./types.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallbacks (on by default for Opus 5 / Fable 5.1). */
  fallbacks?: boolean;
}

type Block = Record<string, any>;

function partsToBlocks(content: string | ContentPart[]): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } }));
}

/** Convert provider-neutral history into Messages API params. Tool results are grouped in one user turn. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Block[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")))
    .join("\n\n");
  const out: Block[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: partsToBlocks(m.content).length ? partsToBlocks(m.content) : [{ type: "text", text: "(empty)" }] };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b: Block) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant") {
      // Echo the exact blocks (incl. thinking) the model produced when we have them.
      const raw = m.providerName === "anthropic" ? m.providerBlocks : undefined;
      if (raw?.length) {
        out.push({ role: "assistant", content: raw });
        continue;
      }
      const blocks = partsToBlocks(m.content);
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments || "{}");
        } catch {
          input = { _raw: c.arguments };
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no content)" }] });
      continue;
    }
    out.push({ role: "user", content: partsToBlocks(m.content).length ? partsToBlocks(m.content) : [{ type: "text", text: "(empty)" }] });
  }
  return { system, messages: out };
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly contextWindow: number;
  readonly supportsImages = true;
  private client: Anthropic;
  private fallbacksEnabled: boolean;

  constructor(private readonly o: AnthropicOptions = {}) {
    this.model = o.model ?? "claude-opus-5";
    this.contextWindow = o.contextWindow ?? 1_000_000;
    this.client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseUrl, maxRetries: 4 });
    this.fallbacksEnabled = o.fallbacks ?? /^claude-(opus-5|fable-5-1)/.test(this.model);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.o.maxOutputTokens ?? 64000,
      system: system || undefined,
      messages,
      thinking: { type: "adaptive" },
      ...(this.o.effort ? { output_config: { effort: this.o.effort } } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    };
    if (this.fallbacksEnabled) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    let message: any;
    try {
      const stream = this.client.beta.messages.stream(params as any, { signal: req.signal });
      if (req.onText) stream.on("text", (delta: string) => req.onText!(delta));
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && this.fallbacksEnabled && /fallback/i.test(err.message)) {
        // Account/platform without server-side fallbacks: retry plainly and stop sending them.
        this.fallbacksEnabled = false;
        return this.complete(req);
      }
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError(`anthropic rate limited: ${err.message}`, 429, true);
      if (err instanceof Anthropic.APIError) throw new ProviderError(`anthropic ${err.status}: ${err.message}`, err.status, (err.status ?? 0) >= 500);
      throw err;
    }

    const blocks: Block[] = message.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls: ToolCall[] = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    const reasoning = blocks.filter((b) => b.type === "thinking" && b.thinking).map((b) => b.thinking).join("\n") || undefined;
    const stop: CompletionResponse["stopReason"] =
      message.stop_reason === "tool_use" ? "tool_calls" : message.stop_reason === "max_tokens" ? "length" : message.stop_reason === "refusal" ? "error" : "stop";
    const response: CompletionResponse & { providerBlocks?: Block[] } = {
      content: message.stop_reason === "refusal" && !text ? "[the model declined this request]" : text,
      toolCalls,
      reasoning,
      usage: { inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 },
      stopReason: stop,
    };
    // Keep only replayable blocks (drop fallback markers) so the next request echoes them unchanged.
    response.providerBlocks = blocks.filter((b) => b.type !== "fallback");
    return response;
  }
}
