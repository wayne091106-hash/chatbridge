import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./providers/types.js";
import { randomId } from "../core/util.js";

export type MemoryKind = "fact" | "preference" | "project" | "lesson" | "person" | "environment";

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  tags: string;
  importance: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface SessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  status: string;
  summary: string | null;
  parentId: string | null;
  source: string;
  reflectedAt: string | null;
}

export interface Job {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  deliver: string;
  conditions: string;
  profile: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  importance REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TABLE IF NOT EXISTS profile(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', summary TEXT, parent_id TEXT, source TEXT NOT NULL DEFAULT 'cli', reflected_at TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  data TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  compacted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  deliver TEXT NOT NULL DEFAULT 'inbox', conditions TEXT NOT NULL DEFAULT '{}', profile TEXT,
  last_run_at TEXT, next_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, output TEXT
);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

/** Split a query into FTS-safe trigram phrases and short terms that need LIKE. */
export function queryTerms(q: string): { fts: string[]; like: string[] } {
  const raw = q
    .toLowerCase()
    .split(/[\s,.;:!?，。；：！？、()（）[\]{}"'`<>/\\|+*=~^$#@%&-]+/)
    .filter(Boolean);
  const fts: string[] = [];
  const like: string[] = [];
  const stop = new Set(["the", "and", "for", "you", "with", "that", "this", "what", "how", "are", "can", "was", "have", "from"]);
  const cjk = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;
  const add = (t: string) => {
    if (stop.has(t)) return;
    const n = [...t].length;
    if (n >= 3) fts.push(`"${t.replace(/"/g, '""')}"`);
    else if (n === 2) like.push(t);
  };
  for (const token of raw) {
    // CJK text has no spaces: index it as overlapping trigrams (plus bigrams for short runs).
    for (const run of token.match(cjk) ?? []) {
      const chars = [...run];
      if (chars.length <= 3) add(run);
      else for (let i = 0; i + 3 <= chars.length && i < 30; i++) fts.push(`"${chars.slice(i, i + 3).join("")}"`);
      if (chars.length >= 2 && chars.length <= 4) like.push(chars.slice(0, 2).join(""));
    }
    for (const rest of token.split(cjk)) if (rest) add(rest);
  }
  return { fts: [...new Set(fts)].slice(0, 40), like: [...new Set(like)].slice(0, 12) };
}

/** Persistent state of the Kestrel agent: long-term memory, sessions/transcripts, jobs, usage. */
export class KestrelStore {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------------ memories
  addMemory(m: { kind?: MemoryKind; content: string; tags?: string[] | string; importance?: number; source?: string }): Memory {
    const tags = Array.isArray(m.tags) ? m.tags.join(",") : (m.tags ?? "");
    const ts = now();
    const r = this.q(`INSERT INTO memories(kind, content, tags, importance, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run(
      m.kind ?? "fact",
      m.content.trim(),
      tags,
      Math.min(1, Math.max(0, m.importance ?? 0.5)),
      m.source ?? "",
      ts,
      ts,
    );
    return this.getMemory(Number(r.lastInsertRowid))!;
  }

  getMemory(id: number): Memory | null {
    const r = this.q(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
    return r ? mapMemory(r) : null;
  }

  updateMemory(id: number, patch: { content?: string; tags?: string; importance?: number; kind?: MemoryKind }) {
    const cur = this.getMemory(id);
    if (!cur) throw new Error(`memory ${id} not found`);
    this.q(`UPDATE memories SET content=?, tags=?, importance=?, kind=?, updated_at=? WHERE id=?`).run(
      patch.content ?? cur.content,
      patch.tags ?? cur.tags,
      patch.importance ?? cur.importance,
      patch.kind ?? cur.kind,
      now(),
      id,
    );
    return this.getMemory(id)!;
  }

  archiveMemory(id: number): boolean {
    return Number(this.q(`UPDATE memories SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0`).run(now(), id).changes) > 0;
  }

  listMemories(opts: { kind?: string; limit?: number; offset?: number } = {}): Memory[] {
    const rows = opts.kind
      ? this.q(`SELECT * FROM memories WHERE archived = 0 AND kind = ? ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`).all(opts.kind, opts.limit ?? 100, opts.offset ?? 0)
      : this.q(`SELECT * FROM memories WHERE archived = 0 ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`).all(opts.limit ?? 100, opts.offset ?? 0);
    return (rows as any[]).map(mapMemory);
  }

  countMemories(): number {
    return Number((this.q(`SELECT COUNT(*) c FROM memories WHERE archived = 0`).get() as any).c);
  }

  /**
   * Hybrid relevance: BM25 over trigram FTS (handles CJK and substrings) + LIKE for 2-char terms,
   * blended with importance, recency and usage so frequently useful memories surface first.
   */
  searchMemories(query: string, limit = 8, opts: { touch?: boolean; kind?: string } = {}): Array<Memory & { score: number }> {
    const { fts, like } = queryTerms(query);
    const scores = new Map<number, number>();
    if (fts.length) {
      try {
        const rows = this.q(`SELECT rowid AS id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`).all(fts.join(" OR ")) as any[];
        for (const r of rows) {
          const strength = Math.max(0, -Number(r.rank));
          scores.set(Number(r.id), (scores.get(Number(r.id)) ?? 0) + strength / (1 + strength));
        }
      } catch {
        /* malformed query: fall through to LIKE */
      }
    }
    for (const t of [...like, ...(fts.length ? [] : [query.trim().toLowerCase()])].filter(Boolean)) {
      const rows = this.q(`SELECT id FROM memories WHERE archived = 0 AND (lower(content) LIKE ? OR lower(tags) LIKE ?) LIMIT 200`).all(`%${t}%`, `%${t}%`) as any[];
      for (const r of rows) scores.set(Number(r.id), (scores.get(Number(r.id)) ?? 0) + 0.35);
    }
    const results: Array<Memory & { score: number }> = [];
    for (const [id, base] of scores) {
      const m = this.getMemory(id);
      if (!m || this.isArchived(id) || (opts.kind && m.kind !== opts.kind)) continue;
      const ageDays = (Date.now() - Date.parse(m.lastUsedAt ?? m.updatedAt)) / 86_400_000;
      const recency = Math.exp(-ageDays / 90);
      const score = base * 0.6 + m.importance * 0.25 + recency * 0.1 + Math.min(m.useCount, 20) * 0.0025;
      results.push({ ...m, score });
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    if (opts.touch) for (const m of top) this.q(`UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`).run(now(), m.id);
    return top;
  }

  isArchived(id: number): boolean {
    const r = this.q(`SELECT archived FROM memories WHERE id = ?`).get(id) as any;
    return !r || r.archived === 1;
  }

  /** Finds a near-duplicate memory (for dedupe during reflection). */
  findSimilarMemory(content: string, threshold = 0.6): Memory | null {
    const cand = this.searchMemories(content, 5);
    const a = trigramSet(content);
    let best: Memory | null = null;
    let bestSim = 0;
    for (const m of cand) {
      const b = trigramSet(m.content);
      let inter = 0;
      for (const g of a) if (b.has(g)) inter++;
      const sim = inter / Math.max(1, Math.min(a.size, b.size));
      if (sim > bestSim) {
        bestSim = sim;
        best = m;
      }
    }
    return bestSim >= threshold ? best : null;
  }

  // ------------------------------------------------------------------ profile
  setProfile(key: string, value: string) {
    this.q(`INSERT INTO profile(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, now());
  }
  deleteProfile(key: string) {
    this.q(`DELETE FROM profile WHERE key = ?`).run(key);
  }
  getProfile(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.q(`SELECT key, value FROM profile ORDER BY key`).all() as any[]) out[r.key] = r.value;
    return out;
  }

  // ------------------------------------------------------------------ sessions
  createSession(opts: { title?: string; model?: string; parentId?: string | null; source?: string; id?: string } = {}): SessionRow {
    const id = opts.id ?? `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomId("", 4)}`;
    const ts = now();
    this.q(`INSERT INTO sessions(id, title, created_at, updated_at, model, parent_id, source) VALUES (?,?,?,?,?,?,?)`).run(id, opts.title ?? "", ts, ts, opts.model ?? "", opts.parentId ?? null, opts.source ?? "cli");
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | null {
    const r = this.q(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    return r ? mapSession(r) : null;
  }

  findSession(prefix: string): SessionRow | null {
    const exact = this.getSession(prefix);
    if (exact) return exact;
    const rows = this.q(`SELECT * FROM sessions WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2`).all(`${prefix}%`) as any[];
    return rows.length === 1 ? mapSession(rows[0]) : null;
  }

  updateSession(id: string, patch: Partial<Pick<SessionRow, "title" | "model" | "status" | "summary" | "reflectedAt">>) {
    const cur = this.getSession(id);
    if (!cur) return;
    this.q(`UPDATE sessions SET title=?, model=?, status=?, summary=?, reflected_at=?, updated_at=? WHERE id=?`).run(
      patch.title ?? cur.title,
      patch.model ?? cur.model,
      patch.status ?? cur.status,
      patch.summary ?? cur.summary,
      patch.reflectedAt ?? cur.reflectedAt,
      now(),
      id,
    );
  }

  listSessions(opts: { limit?: number; source?: string; includeChildren?: boolean } = {}): Array<SessionRow & { messages: number }> {
    const rows = this.q(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s
       WHERE (? IS NULL OR s.source = ?) AND (? = 1 OR s.parent_id IS NULL)
       ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(opts.source ?? null, opts.source ?? null, opts.includeChildren ? 1 : 0, opts.limit ?? 30) as any[];
    return rows.map((r) => ({ ...mapSession(r), messages: Number(r.n) }));
  }

  deleteSession(id: string) {
    this.q(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.q(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  appendMessage(sessionId: string, msg: ChatMessage): number {
    const seq = Number((this.q(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE session_id = ?`).get(sessionId) as any).s);
    const text = messageSearchText(msg);
    this.q(`INSERT INTO messages(session_id, seq, role, data, text, created_at) VALUES (?,?,?,?,?,?)`).run(sessionId, seq, msg.role, JSON.stringify(stripImages(msg)), text, now());
    this.q(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now(), sessionId);
    return seq;
  }

  /** Messages still in the live context (not replaced by a compaction summary). */
  loadMessages(sessionId: string, includeCompacted = false): Array<ChatMessage & { seq: number }> {
    const rows = this.q(`SELECT seq, data, compacted FROM messages WHERE session_id = ? ORDER BY seq`).all(sessionId) as any[];
    return rows.filter((r) => includeCompacted || r.compacted === 0).map((r) => ({ ...(JSON.parse(r.data) as ChatMessage), seq: Number(r.seq) }));
  }

  markCompacted(sessionId: string, uptoSeq: number) {
    this.q(`UPDATE messages SET compacted = 1 WHERE session_id = ? AND seq <= ?`).run(sessionId, uptoSeq);
  }

  searchMessages(query: string, limit = 10): Array<{ sessionId: string; title: string; seq: number; role: string; snippet: string; createdAt: string }> {
    const { fts, like } = queryTerms(query);
    let rows: any[] = [];
    if (fts.length) {
      try {
        rows = this.q(
          `SELECT m.session_id, m.seq, m.role, m.created_at, s.title, snippet(messages_fts, 0, '[', ']', '…', 24) AS snip
           FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
        ).all(fts.join(" OR "), limit) as any[];
      } catch {
        rows = [];
      }
    }
    if (!rows.length && (like.length || query.trim())) {
      const term = like[0] ?? query.trim().toLowerCase();
      rows = (
        this.q(
          `SELECT m.session_id, m.seq, m.role, m.created_at, s.title, substr(m.text, max(1, instr(lower(m.text), ?) - 60), 160) AS snip
           FROM messages m JOIN sessions s ON s.id = m.session_id WHERE lower(m.text) LIKE ? ORDER BY m.id DESC LIMIT ?`,
        ).all(term, `%${term}%`, limit) as any[]
      );
    }
    return rows.map((r) => ({ sessionId: r.session_id, title: r.title, seq: Number(r.seq), role: r.role, snippet: String(r.snip ?? ""), createdAt: r.created_at }));
  }

  // ------------------------------------------------------------------ usage
  recordUsage(sessionId: string, provider: string, model: string, input: number, output: number) {
    this.q(`INSERT INTO usage(session_id, provider, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?)`).run(sessionId, provider, model, input, output, now());
  }

  usageSummary(sessionId?: string) {
    const rows = (sessionId
      ? this.q(`SELECT provider, model, SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) calls FROM usage WHERE session_id = ? GROUP BY provider, model`).all(sessionId)
      : this.q(`SELECT provider, model, SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) calls FROM usage WHERE created_at >= ? GROUP BY provider, model`).all(new Date(Date.now() - 30 * 86_400_000).toISOString())) as any[];
    return rows.map((r) => ({ provider: r.provider, model: r.model, inputTokens: Number(r.i), outputTokens: Number(r.o), calls: Number(r.calls) }));
  }

  // ------------------------------------------------------------------ jobs
  addJob(j: { name: string; schedule: string; prompt: string; deliver?: string; conditions?: Record<string, unknown>; profile?: string | null; nextRunAt: string | null }): Job {
    const id = randomId("job_", 4);
    this.q(`INSERT INTO jobs(id, name, schedule, prompt, deliver, conditions, profile, next_run_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id,
      j.name,
      j.schedule,
      j.prompt,
      j.deliver ?? "inbox",
      JSON.stringify(j.conditions ?? {}),
      j.profile ?? null,
      j.nextRunAt,
      now(),
    );
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const r = this.q(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
    return r ? mapJob(r) : null;
  }

  listJobs(): Job[] {
    return (this.q(`SELECT * FROM jobs ORDER BY created_at`).all() as any[]).map(mapJob);
  }

  updateJob(id: string, patch: Partial<Pick<Job, "enabled" | "nextRunAt" | "lastRunAt" | "lastStatus" | "schedule" | "prompt" | "name">>) {
    const cur = this.getJob(id);
    if (!cur) throw new Error(`job ${id} not found`);
    this.q(`UPDATE jobs SET name=?, schedule=?, prompt=?, enabled=?, next_run_at=?, last_run_at=?, last_status=? WHERE id=?`).run(
      patch.name ?? cur.name,
      patch.schedule ?? cur.schedule,
      patch.prompt ?? cur.prompt,
      (patch.enabled ?? cur.enabled) ? 1 : 0,
      patch.nextRunAt === undefined ? cur.nextRunAt : patch.nextRunAt,
      patch.lastRunAt ?? cur.lastRunAt,
      patch.lastStatus ?? cur.lastStatus,
      id,
    );
  }

  deleteJob(id: string): boolean {
    return Number(this.q(`DELETE FROM jobs WHERE id = ?`).run(id).changes) > 0;
  }

  dueJobs(at = new Date()): Job[] {
    return (this.q(`SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`).all(at.toISOString()) as any[]).map(mapJob);
  }

  startJobRun(jobId: string, sessionId: string | null): number {
    return Number(this.q(`INSERT INTO job_runs(job_id, session_id, started_at, status) VALUES (?,?,?,?)`).run(jobId, sessionId, now(), "running").lastInsertRowid);
  }

  finishJobRun(runId: number, status: string, output: string) {
    this.q(`UPDATE job_runs SET ended_at = ?, status = ?, output = ? WHERE id = ?`).run(now(), status, output.slice(0, 20000), runId);
  }

  jobRuns(jobId: string, limit = 10) {
    return this.q(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`).all(jobId, limit) as any[];
  }

  // ------------------------------------------------------------------ inbox
  addInbox(title: string, body: string, source: string) {
    this.q(`INSERT INTO inbox(title, body, source, created_at) VALUES (?,?,?,?)`).run(title, body, source, now());
  }
  listInbox(unreadOnly = false, limit = 50) {
    return this.q(`SELECT * FROM inbox WHERE (? = 0 OR read = 0) ORDER BY id DESC LIMIT ?`).all(unreadOnly ? 1 : 0, limit) as any[];
  }
  markInboxRead(id?: number) {
    if (id === undefined) this.q(`UPDATE inbox SET read = 1`).run();
    else this.q(`UPDATE inbox SET read = 1 WHERE id = ?`).run(id);
  }
}

function trigramSet(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, " ");
  const set = new Set<string>();
  const chars = [...t];
  for (let i = 0; i + 3 <= chars.length; i++) set.add(chars.slice(i, i + 3).join(""));
  return set;
}

function stripImages(msg: ChatMessage): ChatMessage {
  if (!Array.isArray(msg.content)) return msg;
  return { ...msg, content: msg.content.map((p) => (p.type === "image" ? { type: "text" as const, text: `[image ${p.mimeType} omitted from transcript]` } : p)) };
}

function messageSearchText(msg: ChatMessage): string {
  const base = typeof msg.content === "string" ? msg.content : msg.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  const calls = (msg.toolCalls ?? []).map((c) => `${c.name} ${c.arguments}`).join("\n");
  return (base + (calls ? `\n${calls}` : "")).slice(0, 20000);
}

function mapMemory(r: any): Memory {
  return {
    id: Number(r.id),
    kind: r.kind,
    content: r.content,
    tags: r.tags,
    importance: Number(r.importance),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at ?? null,
    useCount: Number(r.use_count),
  };
}

function mapSession(r: any): SessionRow {
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, model: r.model, status: r.status, summary: r.summary ?? null, parentId: r.parent_id ?? null, source: r.source, reflectedAt: r.reflected_at ?? null };
}

function mapJob(r: any): Job {
  return {
    id: r.id,
    name: r.name,
    schedule: r.schedule,
    prompt: r.prompt,
    enabled: r.enabled === 1,
    deliver: r.deliver,
    conditions: r.conditions,
    profile: r.profile ?? null,
    lastRunAt: r.last_run_at ?? null,
    nextRunAt: r.next_run_at ?? null,
    lastStatus: r.last_status ?? null,
    createdAt: r.created_at,
  };
}
