export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Tool name for role=tool. */
  name?: string;
  /** Provider reasoning text, kept for transcripts only. */
  reasoning?: string;
  /** Provider-native content blocks to replay unchanged (e.g. Anthropic thinking blocks). */
  providerBlocks?: any[];
  /** Which provider produced providerBlocks; other providers ignore them. */
  providerName?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Streaming callback for visible assistant text. */
  onText?: (delta: string) => void;
  /** JSON-only response requested (reflection, compaction helpers). */
  json?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: "stop" | "tool_calls" | "length" | "error" | "other";
  reasoning?: string;
  providerBlocks?: any[];
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly supportsImages: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : `[image ${p.mimeType}]`)).join("\n");
}

/** Retry wrapper with exponential backoff + jitter for retryable provider errors. */
export async function withRetries<T>(fn: () => Promise<T>, opts: { retries?: number; signal?: AbortSignal; onRetry?: (err: unknown, attempt: number, delayMs: number) => void } = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : err instanceof TypeError; // fetch network errors are TypeErrors
      if (!retryable || attempt >= retries || opts.signal?.aborted) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
      opts.onRetry?.(err, attempt + 1, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Parse Server-Sent Events from a fetch Response body. */
export async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
        let event: string | undefined;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
