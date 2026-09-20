import {
  ProviderError,
  sseEvents,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type ModelProvider,
  type ToolCall,
} from "./types.js";

export interface OpenAICompatibleOptions {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  supportsImages?: boolean;
  stream?: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

function toWire(messages: ChatMessage[], supportsImages: boolean) {
  return messages.map((m) => {
    if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image omitted]")).join("\n");
      return { role: "tool", tool_call_id: m.toolCallId, content: text };
    }
    let content: unknown = m.content;
    if (Array.isArray(m.content)) {
      content = m.content.map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : supportsImages
            ? { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
            : { type: "text", text: "[image omitted: model has no vision]" },
      );
    }
    const wire: Record<string, unknown> = { role: m.role, content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } }));
      if (!m.content) wire.content = null;
    }
    return wire;
  });
}

/**
 * OpenAI Chat Completions wire format. Covers OpenAI, NVIDIA NIM, OpenRouter, Groq, Together,
 * DeepSeek, vLLM, LM Studio and Ollama (/v1).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly supportsImages: boolean;

  constructor(private readonly o: OpenAICompatibleOptions) {
    this.name = o.name ?? "openai";
    this.model = o.model;
    this.contextWindow = o.contextWindow ?? 128_000;
    this.supportsImages = o.supportsImages ?? false;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return withRetries(() => this.once(req), { signal: req.signal });
  }

  private async once(req: CompletionRequest): Promise<CompletionResponse> {
    const stream = this.o.stream !== false && !!req.onText;
    const body: Record<string, unknown> = {
      model: this.o.model,
      messages: toWire(req.messages, this.supportsImages),
      max_tokens: req.maxTokens ?? this.o.maxOutputTokens ?? 8192,
      stream,
      ...(req.temperature ?? this.o.temperature) !== undefined ? { temperature: req.temperature ?? this.o.temperature } : {},
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...this.o.extraBody,
    };
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 300_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}),
          ...this.o.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ProviderError(`${this.name}: network error: ${(err as Error).message}`, undefined, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Some servers reject response_format; retry once without it.
      if (req.json && res.status === 400 && /response_format/i.test(text)) return this.once({ ...req, json: false });
      throw new ProviderError(`${this.name} ${res.status}: ${text.slice(0, 800)}`, res.status, res.status === 429 || res.status >= 500);
    }
    return stream ? this.readStream(res, req) : this.readJson(await res.json());
  }

  private readJson(data: any): CompletionResponse {
    const choice = data.choices?.[0];
    if (!choice) throw new ProviderError(`${this.name}: empty response ${JSON.stringify(data).slice(0, 300)}`, undefined, true);
    const msg = choice.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({ id: c.id || `call_${i}`, name: c.function?.name, arguments: c.function?.arguments ?? "{}" }));
    return {
      content: typeof msg.content === "string" ? msg.content : "",
      reasoning: msg.reasoning_content ?? msg.reasoning ?? undefined,
      toolCalls,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined,
      stopReason: mapFinish(choice.finish_reason, toolCalls.length),
    };
  }

  private async readStream(res: Response, req: CompletionRequest): Promise<CompletionResponse> {
    let content = "";
    let reasoning = "";
    let finish: string | undefined;
    let usage: CompletionResponse["usage"];
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const ev of sseEvents(res, req.signal)) {
      if (ev.data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.name}: ${JSON.stringify(chunk.error).slice(0, 500)}`, undefined, true);
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        req.onText?.(d.content);
      }
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string") reasoning += r;
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || "{}" }));
    return { content, reasoning: reasoning || undefined, toolCalls, usage, stopReason: mapFinish(finish, toolCalls.length) };
  }
}

function mapFinish(reason: string | undefined, calls: number): CompletionResponse["stopReason"] {
  if (calls > 0) return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "stop" || reason === "eos" || reason === undefined || reason === null) return "stop";
  return "other";
}
