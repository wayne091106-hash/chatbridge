import path from "node:path";
import type { KestrelService } from "./service.js";
import type { ChatMessage, CompletionResponse, ContentPart, ModelProvider, ToolCall } from "./providers/types.js";
import { textOf } from "./providers/types.js";
import { buildSystemPrompt, COMPACTION_PROMPT, REFLECTION_PROMPT } from "./prompt.js";
import { filterTools, runTool, toolSpec, type AgentTool, type ToolImage } from "./tools.js";
import { errorMessage, estimateTokens, truncateMiddle } from "../core/util.js";
import type { SessionRow } from "./store.js";
import { Checkpoints } from "../core/checkpoints.js";
import { checkpointScope } from "../core/files.js";

export type AgentEvent =
  | { type: "turn_start"; sessionId: string; input: string }
  | { type: "text"; delta: string }
  | { type: "assistant"; text: string; toolCalls: ToolCall[]; iteration: number }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; preview: string; durationMs: number }
  | { type: "info"; message: string }
  | { type: "compaction"; beforeTokens: number; afterTokens: number }
  | { type: "reflection"; memories: number; skill: string | null; title: string }
  | { type: "turn_end"; text: string; iterations: number; toolCalls: number; stopped: TurnStop }
  | { type: "error"; message: string };

export type TurnStop = "completed" | "max_iterations" | "aborted" | "error";

export interface TurnResult {
  text: string;
  iterations: number;
  toolCalls: number;
  stopped: TurnStop;
  sessionId: string;
}

export interface AgentOptions {
  sessionId?: string;
  title?: string;
  source?: string;
  parentId?: string | null;
  toolsets?: string[];
  maxIterations?: number;
  depth?: number;
  cwd?: string;
  provider?: ModelProvider;
  extraSystem?: string;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

const READ_ONLY_PARALLEL_LIMIT = 6;

/** One conversation with the agent: context management, tool loop, persistence, reflection. */
export class Agent {
  readonly session: SessionRow;
  readonly checkpoints: Checkpoints;
  readonly depth: number;
  readonly source: string;
  cwd: string;
  todos: Todo[] = [];
  private messages: ChatMessage[] = [];
  private tools: AgentTool[];
  private readonly provider: ModelProvider;
  private turnsSinceReflection = 0;
  private toolCallsSinceReflection = 0;
  private changedFiles = new Set<string>();
  private usedSkills = new Set<string>();
  private readonly maxIterations: number;
  private busy = false;

  constructor(
    readonly service: KestrelService,
    private readonly opts: AgentOptions = {},
  ) {
    const store = service.store;
    this.provider = opts.provider ?? service.provider;
    this.depth = opts.depth ?? 0;
    this.source = opts.source ?? "cli";
    const existing = opts.sessionId ? store.findSession(opts.sessionId) : null;
    if (opts.sessionId && !existing) throw new Error(`session ${opts.sessionId} not found`);
    this.session = existing ?? store.createSession({ title: opts.title, model: `${this.provider.name}:${this.provider.model}`, parentId: opts.parentId ?? null, source: this.source });
    if (existing) {
      if (existing.summary) this.messages.push({ role: "user", content: `[Summary of the earlier conversation]\n${existing.summary}` });
      this.messages.push(...store.loadMessages(existing.id).map(({ seq: _seq, ...m }) => m));
    }
    this.cwd = opts.cwd ?? service.rt.cwd.value;
    this.checkpoints = new Checkpoints(path.join(service.home, "checkpoints"), this.session.id);
    const toolsets = opts.toolsets ?? service.config.agent.toolsets;
    this.tools = filterTools(service.tools, toolsets);
    this.maxIterations = opts.maxIterations ?? service.config.agent.maxIterations;
  }

  get sessionId() {
    return this.session.id;
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  get isBusy() {
    return this.busy;
  }

  resolvePath(p: string): string {
    const expanded = p.startsWith("~") ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", p.slice(1)) : p;
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(this.cwd, expanded);
  }

  noteChangedFile(p: string) {
    this.changedFiles.add(p);
  }

  noteSkillUsed(slug: string) {
    this.usedSkills.add(slug);
  }

  renderTodos(): string {
    if (!this.todos.length) return "(plan is empty)";
    const mark = { pending: "[ ]", in_progress: "[>]", done: "[x]", cancelled: "[-]" } as const;
    return this.todos.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join("\n");
  }

  private persist(msg: ChatMessage) {
    this.messages.push(msg);
    this.service.store.appendMessage(this.session.id, msg);
  }

  private async systemPrompt(latestInput: string, countUse = false): Promise<string> {
    const s = this.service;
    const query = `${this.session.title} ${latestInput}`.slice(0, 2000);
    // Usage stats are bumped once per turn, not on every loop iteration.
    const memories = s.config.agent.memoriesInPrompt ? s.store.searchMemories(query, s.config.agent.memoriesInPrompt, { touch: countUse }) : [];
    // Always surface the most important memories even if the query does not match them.
    if (memories.length < s.config.agent.memoriesInPrompt) {
      for (const m of s.store.listMemories({ limit: 30 })) {
        if (memories.length >= s.config.agent.memoriesInPrompt) break;
        if (m.importance >= 0.8 && !memories.some((x) => x.id === m.id)) memories.push({ ...m, score: 0 });
      }
    }
    const skills = this.tools.some((t) => t.toolset === "skills") ? s.skills.search(query, s.config.agent.skillsInPrompt) : [];
    return buildSystemPrompt({
      config: s.config,
      cwd: this.cwd,
      environment: await s.environment(),
      profile: s.store.getProfile(),
      memories,
      relevantSkills: skills,
      totalSkills: this.tools.some((t) => t.toolset === "skills") ? s.skills.list().length : 0,
      todos: this.todos.length ? this.renderTodos() : "",
      toolsets: [...new Set(this.tools.map((t) => t.toolset))],
      isSubagent: this.depth > 0,
      channel: this.source,
      extra: this.opts.extraSystem,
    });
  }

  private contextTokens(system: string): number {
    let n = estimateTokens(system);
    for (const m of this.messages) n += estimateTokens(textOf(m.content)) + (m.toolCalls ?? []).reduce((a, c) => a + estimateTokens(c.arguments) + 10, 0) + 4;
    n += this.tools.length * 120;
    return n;
  }

  /** Summarise older context when it approaches the model's window. */
  async compact(system: string, force = false, signal?: AbortSignal): Promise<boolean> {
    const s = this.service;
    const before = this.contextTokens(system);
    const limit = this.provider.contextWindow * s.config.agent.compactAtRatio;
    if (!force && before < limit) return false;
    const keep = s.config.agent.keepRecentMessages;
    if (this.messages.length <= keep + 2) return false;
    // Split at a real user message so assistant tool_calls stay with their results.
    let split = this.messages.length - keep;
    while (split > 1 && !(this.messages[split]!.role === "user")) split--;
    if (split <= 1) return false;
    const old = this.messages.slice(0, split);
    const transcript = old
      .map((m) => {
        const calls = (m.toolCalls ?? []).map((c) => `  → ${c.name}(${truncateMiddle(c.arguments, 400)})`).join("\n");
        return `## ${m.role}${m.name ? ` (${m.name})` : ""}\n${truncateMiddle(textOf(m.content), m.role === "tool" ? 1500 : 6000)}${calls ? `\n${calls}` : ""}`;
      })
      .join("\n\n");
    const aux = s.auxProvider;
    const res = await aux.complete({
      messages: [
        { role: "system", content: COMPACTION_PROMPT },
        { role: "user", content: truncateMiddle(transcript, Math.floor(aux.contextWindow * 2.5)) },
      ],
      maxTokens: 3000,
      signal,
    });
    const summary = res.content.trim();
    if (!summary) return false;
    const prevSummary = this.session.summary;
    const merged = prevSummary && old[0] && textOf(old[0].content).startsWith("[Summary of the earlier conversation]") ? summary : prevSummary ? `${prevSummary}\n\n---\n${summary}` : summary;
    // Persist: mark stored messages up to the split as compacted.
    const stored = s.store.loadMessages(this.session.id);
    const offset = this.messages.length - stored.length; // leading synthetic summary message(s)
    const lastOldStored = stored[split - offset - 1];
    if (lastOldStored) s.store.markCompacted(this.session.id, lastOldStored.seq);
    s.store.updateSession(this.session.id, { summary: merged });
    this.session.summary = merged;
    // Replayed provider blocks (e.g. thinking) are only valid on an unedited history; drop them.
    this.messages = [{ role: "user", content: `[Summary of the earlier conversation]\n${merged}` }, ...this.messages.slice(split).map(({ providerBlocks: _pb, providerName: _pn, ...m }) => m)];
    const after = this.contextTokens(system);
    this.emit({ type: "compaction", beforeTokens: before, afterTokens: after });
    return true;
  }

  private onEvent?: (e: AgentEvent) => void;
  private emit(e: AgentEvent) {
    try {
      this.onEvent?.(e);
    } catch {
      /* UI errors never break the loop */
    }
  }

  runTurn(input: string | ContentPart[], opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {}): Promise<TurnResult> {
    return checkpointScope.run(this.checkpoints, () => this.runTurnInner(input, opts));
  }

  private async runTurnInner(input: string | ContentPart[], opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void }): Promise<TurnResult> {
    if (this.busy) throw new Error("agent is already running a turn");
    this.busy = true;
    this.onEvent = opts.onEvent;
    const signal = opts.signal ?? new AbortController().signal;
    const s = this.service;
    const inputText = typeof input === "string" ? input : textOf(input);
    this.emit({ type: "turn_start", sessionId: this.session.id, input: inputText });
    this.checkpoints.beginTurn(`${this.session.id}: ${inputText.slice(0, 120)}`);
    if (!this.session.title) {
      const title = inputText.replace(/\s+/g, " ").trim().slice(0, 60);
      s.store.updateSession(this.session.id, { title });
      this.session.title = title;
    }
    this.persist({ role: "user", content: input });

    let iterations = 0;
    let toolCallCount = 0;
    let finalText = "";
    let stopped: TurnStop = "completed";
    const seen = new Map<string, number>();
    const specs = this.tools.map(toolSpec);
    const byName = new Map(this.tools.map((t) => [t.name, t]));

    try {
      for (;;) {
        if (signal.aborted) {
          stopped = "aborted";
          break;
        }
        if (iterations >= this.maxIterations) {
          stopped = "max_iterations";
          this.persist({ role: "user", content: `[system] Iteration budget (${this.maxIterations}) reached. Stop calling tools and give the owner a concise status report: what is done, what remains, and how to continue.` });
          const wrap = await this.provider.complete({ messages: [{ role: "system", content: await this.systemPrompt(inputText) }, ...this.messages], signal, onText: (d) => this.emit({ type: "text", delta: d }) });
          finalText = wrap.content;
          this.persist({ role: "assistant", content: wrap.content });
          this.recordUsage(wrap);
          break;
        }
        iterations++;
        const system = await this.systemPrompt(inputText, iterations === 1);
        await this.compact(system, false, signal).catch((err) => this.emit({ type: "info", message: `compaction skipped: ${errorMessage(err)}` }));

        const res = await this.provider.complete({
          messages: [{ role: "system", content: system }, ...this.messages],
          tools: specs,
          signal,
          onText: (d) => this.emit({ type: "text", delta: d }),
        });
        this.recordUsage(res);
        const assistant: ChatMessage = { role: "assistant", content: res.content, toolCalls: res.toolCalls.length ? res.toolCalls : undefined, reasoning: res.reasoning };
        if (res.providerBlocks) {
          assistant.providerBlocks = res.providerBlocks;
          assistant.providerName = this.provider.name;
        }
        this.persist(assistant);
        this.emit({ type: "assistant", text: res.content, toolCalls: res.toolCalls, iteration: iterations });

        if (!res.toolCalls.length) {
          if (res.stopReason === "length" && iterations < this.maxIterations) {
            this.persist({ role: "user", content: "[system] Your previous reply was cut off by the output limit. Continue exactly where you stopped." });
            finalText += res.content;
            continue;
          }
          finalText += res.content;
          break;
        }

        // Execute tool calls: read-only ones in parallel, others sequentially in order.
        const results = new Map<string, { ok: boolean; text: string; images: ToolImage[] }>();
        const runOne = async (call: ToolCall) => {
          const t = byName.get(call.name);
          const started = Date.now();
          this.emit({ type: "tool_start", id: call.id, name: call.name, args: call.arguments });
          let ok = false;
          let text: string;
          let images: ToolImage[] = [];
          if (!t) {
            text = `Error: unknown tool "${call.name}". Available: ${[...byName.keys()].join(", ")}`;
          } else {
            const sig = `${call.name}:${call.arguments}`;
            const count = (seen.get(sig) ?? 0) + 1;
            seen.set(sig, count);
            const r = await runTool(t, call.arguments, { agent: this, service: s, signal });
            ok = r.ok;
            text = typeof r.output === "string" ? r.output : r.output.text;
            images = typeof r.output === "string" ? [] : (r.output.images ?? []);
            if (count >= 3 && !t.readOnly) text += `\n\n[loop guard] You have made this identical call ${count} times. Step back, re-check your assumptions and try a different approach.`;
          }
          s.rt.audit.write({ actor: `kestrel:${this.session.id}`, action: `agent.${call.name}`, args: safeArgs(call.arguments), outcome: ok ? "ok" : "error", durationMs: Date.now() - started, detail: ok ? undefined : text.slice(0, 300) });
          const limited = truncateMiddle(text, s.config.agent.toolOutputChars);
          results.set(call.id, { ok, text: limited, images });
          this.emit({ type: "tool_end", id: call.id, name: call.name, ok, preview: limited.slice(0, 400), durationMs: Date.now() - started });
        };

        const calls = res.toolCalls;
        let i = 0;
        while (i < calls.length) {
          if (signal.aborted) break;
          const t = byName.get(calls[i]!.name);
          if (t?.readOnly) {
            const batch: ToolCall[] = [];
            while (i < calls.length && byName.get(calls[i]!.name)?.readOnly && batch.length < READ_ONLY_PARALLEL_LIMIT) batch.push(calls[i++]!);
            await Promise.all(batch.map(runOne));
          } else {
            await runOne(calls[i++]!);
          }
        }
        toolCallCount += calls.length;

        const pendingImages: ToolImage[] = [];
        for (const call of calls) {
          const r = results.get(call.id) ?? { ok: false, text: "Error: tool call was cancelled", images: [] };
          const content: string | ContentPart[] =
            r.images.length && this.provider.supportsImages && this.provider.name === "anthropic"
              ? [{ type: "text", text: r.text }, ...r.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))]
              : r.text;
          if (r.images.length && this.provider.supportsImages && this.provider.name !== "anthropic") pendingImages.push(...r.images);
          this.persist({ role: "tool", toolCallId: call.id, name: call.name, content });
        }
        if (pendingImages.length) {
          this.persist({ role: "user", content: [{ type: "text", text: "[images returned by the previous tool calls]" }, ...pendingImages.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))] });
        } else if (calls.some((c) => (results.get(c.id)?.images.length ?? 0) > 0) && !this.provider.supportsImages) {
          this.persist({ role: "user", content: "[system] The screenshot could not be shown because the current model has no vision. Use windows/clipboard/UI-automation via PowerShell instead." });
        }
        if (signal.aborted) {
          stopped = "aborted";
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) stopped = "aborted";
      else {
        stopped = "error";
        const msg = errorMessage(err);
        this.emit({ type: "error", message: msg });
        finalText = finalText || `Error: ${msg}`;
      }
    } finally {
      this.checkpoints.endTurn();
      this.busy = false;
    }

    this.turnsSinceReflection++;
    this.toolCallsSinceReflection += toolCallCount;
    this.emit({ type: "turn_end", text: finalText, iterations, toolCalls: toolCallCount, stopped });
    if (s.config.agent.autoReflect && this.depth === 0 && stopped === "completed" && this.turnsSinceReflection >= s.config.agent.reflectEveryTurns) {
      void this.reflect().catch((err) => this.emit({ type: "info", message: `reflection failed: ${errorMessage(err)}` }));
    }
    this.onEvent = undefined;
    return { text: finalText, iterations, toolCalls: toolCallCount, stopped, sessionId: this.session.id };
  }

  private recordUsage(res: CompletionResponse) {
    if (res.usage) this.service.store.recordUsage(this.session.id, this.provider.name, this.provider.model, res.usage.inputTokens, res.usage.outputTokens);
  }

  /**
   * Learning loop: extract durable memories, owner profile facts, skill feedback and possibly a new
   * skill from the part of the conversation not yet reflected on.
   */
  async reflect(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<{ memories: number; profile: number; skill: string | null; title: string }> {
    const s = this.service;
    const all = s.store.loadMessages(this.session.id, true);
    const sinceSeq = Number((s.store.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`reflected:${this.session.id}`) as any)?.value ?? 0);
    const fresh = all.filter((m) => m.seq > sinceSeq);
    if (!fresh.length || (!opts.force && fresh.filter((m) => m.role === "user").length === 0)) return { memories: 0, profile: 0, skill: null, title: this.session.title };
    const toolCalls = fresh.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
    const excerpt = fresh
      .map((m) => {
        const calls = (m.toolCalls ?? []).map((c) => `  → ${c.name}(${truncateMiddle(c.arguments, 300)})`).join("\n");
        return `## ${m.role}${m.name ? ` ${m.name}` : ""}\n${truncateMiddle(textOf(m.content), m.role === "tool" ? 800 : 4000)}${calls ? `\n${calls}` : ""}`;
      })
      .join("\n\n");
    const existingSkills = s.skills.list().map((k) => `- ${k.name}: ${k.description}`).join("\n") || "(none)";
    const allowSkill = toolCalls >= s.config.agent.skillMinToolCalls;
    const res = await s.auxProvider.complete({
      messages: [
        { role: "system", content: `${REFLECTION_PROMPT}\n\nExisting skills:\n${existingSkills}\n${allowSkill ? "" : "\nThis excerpt is too short for a new skill: set skill to null."}` },
        { role: "user", content: truncateMiddle(excerpt, Math.floor(s.auxProvider.contextWindow * 2)) },
      ],
      json: true,
      maxTokens: 4000,
      signal: opts.signal,
    });
    const data = parseJsonLoose(res.content);
    let memories = 0;
    let profile = 0;
    let skill: string | null = null;
    for (const m of Array.isArray(data?.memories) ? data.memories : []) {
      if (typeof m?.content !== "string" || m.content.length < 8) continue;
      const kind = ["fact", "preference", "project", "lesson", "person", "environment"].includes(m.kind) ? m.kind : "fact";
      const dup = s.store.findSimilarMemory(m.content, 0.7);
      if (dup) s.store.updateMemory(dup.id, { content: m.content, importance: Math.max(dup.importance, Number(m.importance) || 0.5) });
      else s.store.addMemory({ kind, content: m.content, importance: Number(m.importance) || 0.5, tags: Array.isArray(m.tags) ? m.tags : [], source: `reflection:${this.session.id}` });
      memories++;
    }
    for (const p of Array.isArray(data?.profile) ? data.profile : []) {
      if (typeof p?.key === "string" && typeof p?.value === "string" && p.key.length <= 60) {
        s.store.setProfile(p.key, p.value);
        profile++;
      }
    }
    for (const f of Array.isArray(data?.skill_feedback) ? data.skill_feedback : []) {
      if (typeof f?.name === "string") s.skills.recordOutcome(f.name, !!f.success);
    }
    if (allowSkill && data?.skill && typeof data.skill.name === "string" && typeof data.skill.body === "string" && data.skill.body.length > 80) {
      const saved = s.skills.save({ name: data.skill.name, description: String(data.skill.description ?? ""), body: data.skill.body, tags: Array.isArray(data.skill.tags) ? data.skill.tags : [], origin: "learned" });
      skill = saved.name;
    }
    const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim().slice(0, 80) : this.session.title;
    s.store.updateSession(this.session.id, { title, reflectedAt: new Date().toISOString() });
    this.session.title = title;
    const lastSeq = all.at(-1)?.seq ?? sinceSeq;
    s.store.db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`reflected:${this.session.id}`, String(lastSeq));
    this.turnsSinceReflection = 0;
    this.toolCallsSinceReflection = 0;
    this.emit({ type: "reflection", memories, skill, title });
    return { memories, profile, skill, title };
  }
}

function safeArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 500);
  }
}

export function parseJsonLoose(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
