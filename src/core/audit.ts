import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./util.js";

export interface AuditRecord {
  seq: number;
  ts: string;
  actor: string; // e.g. "oauth:chatgpt-client-id", "token:owner", "agent:session-id"
  action: string; // tool name or admin action
  args?: unknown;
  outcome: "ok" | "error" | "denied" | "paused";
  detail?: string;
  durationMs?: number;
  prev: string;
  hash: string;
}

const SECRET_KEYS = /(password|passphrase|secret|token|api[_-]?key|authorization|cookie)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) + `…[+${value.length - 2000}]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Append-only JSONL audit log with a SHA-256 hash chain: editing or deleting any earlier line
 * breaks verification of everything after it.
 */
export class AuditLog {
  private seq = 0;
  private prev = "genesis";

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.syncFromTail();
  }

  /**
   * Several processes append to the same log (server, CLI, stdio bridge), so the chain head is
   * re-read from the file before every write instead of trusting in-memory state.
   */
  private syncFromTail() {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (!size) return;
    const fd = openSync(this.file, "r");
    try {
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const last = buf.toString("utf8").trimEnd().split("\n").at(-1);
      if (!last) return;
      const rec = JSON.parse(last) as AuditRecord;
      this.seq = rec.seq;
      this.prev = rec.hash;
    } catch {
      /* corrupted tail is surfaced by verify() */
    } finally {
      closeSync(fd);
    }
  }

  write(entry: Omit<AuditRecord, "seq" | "ts" | "prev" | "hash">): AuditRecord {
    this.syncFromTail();
    const base = { seq: this.seq + 1, ts: new Date().toISOString(), ...entry, args: redact(entry.args), prev: this.prev };
    const hash = sha256(JSON.stringify(base));
    const rec = { ...base, hash } as AuditRecord;
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.seq = rec.seq;
    this.prev = hash;
    return rec;
  }

  tail(n = 50): AuditRecord[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l));
  }

  verify(): { ok: boolean; records: number; brokenAt?: number; reason?: string } {
    if (!existsSync(this.file)) return { ok: true, records: 0 };
    const lines = readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    let prev = "genesis";
    // After the log is archived (audit-<date>.jsonl), processes that were already running keep chaining onto the
    // archive's last record. That is a valid continuation, so the first record may link to an archive's tail.
    try {
      const first = JSON.parse(lines[0] ?? "{}") as Partial<AuditRecord>;
      if (first.prev && first.prev !== "genesis" && this.archiveTails().has(first.prev)) prev = first.prev;
    } catch {
      /* reported below */
    }
    for (let i = 0; i < lines.length; i++) {
      let rec: AuditRecord;
      try {
        rec = JSON.parse(lines[i]!);
      } catch {
        return { ok: false, records: lines.length, brokenAt: i + 1, reason: "unparseable line" };
      }
      const { hash, ...rest } = rec;
      if (rec.prev !== prev) return { ok: false, records: lines.length, brokenAt: i + 1, reason: "chain link mismatch" };
      if (sha256(JSON.stringify(rest)) !== hash) return { ok: false, records: lines.length, brokenAt: i + 1, reason: "hash mismatch (record modified)" };
      prev = hash;
    }
    return { ok: true, records: lines.length };
  }

  /** Hashes of the last record of every archived log next to this one. */
  private archiveTails(): Set<string> {
    const dir = path.dirname(this.file);
    const tails = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!/^audit-.+\.jsonl$/.test(f)) continue;
      const last = readFileSync(path.join(dir, f), "utf8").trim().split("\n").pop();
      try {
        if (last) tails.add(JSON.parse(last).hash);
      } catch {
        /* ignore */
      }
    }
    return tails;
  }
}
