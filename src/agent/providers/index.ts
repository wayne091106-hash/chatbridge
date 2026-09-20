import { AnthropicProvider } from "./anthropic.js";
import { CodexProvider } from "./codex.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { ProviderError, type CompletionRequest, type CompletionResponse, type ModelProvider } from "./types.js";

export interface ModelProfile {
  provider: "openai" | "anthropic" | "codex" | "mock";
  model: string;
  baseUrl?: string;
  /** Name of the environment variable that holds the API key (never store keys in config). */
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  supportsImages?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  extraBody?: Record<string, unknown>;
}

export const PRESETS: Record<string, ModelProfile> = {
  codex: { provider: "codex", model: "", contextWindow: 200_000, supportsImages: true },
  nim: { provider: "openai", model: "z-ai/glm-5.3-flash", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", contextWindow: 128_000, maxOutputTokens: 16_000 },
  openai: { provider: "openai", model: "", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", contextWindow: 400_000, supportsImages: true },
  anthropic: { provider: "anthropic", model: "claude-opus-5", apiKeyEnv: "ANTHROPIC_API_KEY", contextWindow: 1_000_000, supportsImages: true },
  openrouter: { provider: "openai", model: "", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", contextWindow: 200_000, supportsImages: true },
  ollama: { provider: "openai", model: "qwen3:14b", baseUrl: "http://127.0.0.1:11434/v1", contextWindow: 32_000 },
};

export function createProvider(profile: ModelProfile, name: string = profile.provider): ModelProvider {
  const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  switch (profile.provider) {
    case "openai":
      if (!profile.baseUrl) throw new Error(`profile ${name}: baseUrl is required`);
      if (!profile.model) throw new Error(`profile ${name}: set a model id in the Kestrel config`);
      if (profile.apiKeyEnv && !key) throw new Error(`profile ${name}: environment variable ${profile.apiKeyEnv} is not set`);
      return new OpenAICompatibleProvider({
        name,
        baseUrl: profile.baseUrl,
        apiKey: key,
        model: profile.model,
        contextWindow: profile.contextWindow,
        maxOutputTokens: profile.maxOutputTokens,
        temperature: profile.temperature,
        supportsImages: profile.supportsImages,
        extraBody: profile.extraBody,
      });
    case "anthropic":
      return new AnthropicProvider({ apiKey: key, baseUrl: profile.baseUrl, model: profile.model || undefined, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens, effort: profile.effort });
    case "codex":
      return new CodexProvider({ model: profile.model || undefined, contextWindow: profile.contextWindow });
    case "mock":
      return new MockProvider();
  }
}

/**
 * Tries providers in order; on non-retryable-by-now failures (rate limits, outages, auth) moves to
 * the next profile so a long autonomous run survives one backend going down.
 */
export class FallbackProvider implements ModelProvider {
  private active = 0;
  constructor(
    private readonly chain: ModelProvider[],
    private readonly onSwitch?: (from: ModelProvider, to: ModelProvider, err: unknown) => void,
  ) {
    if (!chain.length) throw new Error("FallbackProvider needs at least one provider");
  }
  get name() {
    return this.chain[this.active]!.name;
  }
  get model() {
    return this.chain[this.active]!.model;
  }
  get contextWindow() {
    return Math.min(...this.chain.map((p) => p.contextWindow));
  }
  get supportsImages() {
    return this.chain[this.active]!.supportsImages;
  }
  get current() {
    return this.chain[this.active]!;
  }
  private switchedAt = 0;
  /** After falling back, the primary is retried once this much time has passed. */
  retryPrimaryAfterMs = 30 * 60_000;

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let lastErr: unknown;
    if (this.active > 0 && Date.now() - this.switchedAt > this.retryPrimaryAfterMs) this.active = 0;
    for (let i = this.active; i < this.chain.length; i++) {
      try {
        const r = await this.chain[i]!.complete(req);
        if (i !== this.active) this.switchedAt = Date.now();
        this.active = i;
        return r;
      } catch (err) {
        lastErr = err;
        if (req.signal?.aborted) throw err;
        const status = err instanceof ProviderError ? err.status : undefined;
        const switchable = !(err instanceof ProviderError) || err.retryable || status === 401 || status === 403 || status === 404 || status === 429 || (status ?? 0) >= 500;
        if (!switchable || i === this.chain.length - 1) throw err;
        this.onSwitch?.(this.chain[i]!, this.chain[i + 1]!, err);
      }
    }
    throw lastErr;
  }
}
