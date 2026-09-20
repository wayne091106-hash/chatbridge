import type { CompletionRequest, CompletionResponse, ModelProvider } from "./types.js";

export type MockStep = CompletionResponse | ((req: CompletionRequest) => CompletionResponse | Promise<CompletionResponse>);

/** Deterministic scripted provider for tests and offline demos. */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock-1";
  readonly contextWindow: number;
  readonly supportsImages = true;
  readonly requests: CompletionRequest[] = [];
  private queue: MockStep[];

  constructor(steps: MockStep[] = [], opts: { contextWindow?: number; fallback?: MockStep } = {}) {
    this.queue = [...steps];
    this.contextWindow = opts.contextWindow ?? 100_000;
    this.fallback = opts.fallback ?? { content: "(mock: no more scripted responses)", toolCalls: [], stopReason: "stop" };
  }
  private fallback: MockStep;

  push(...steps: MockStep[]) {
    this.queue.push(...steps);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.queue.shift() ?? this.fallback;
    const res = typeof step === "function" ? await step(req) : step;
    if (res.content) req.onText?.(res.content);
    return { usage: { inputTokens: 10, outputTokens: 5 }, ...res };
  }
}

export const say = (content: string): CompletionResponse => ({ content, toolCalls: [], stopReason: "stop" });
export const call = (name: string, args: Record<string, unknown>, content = ""): CompletionResponse => ({
  content,
  toolCalls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }],
  stopReason: "tool_calls",
});
