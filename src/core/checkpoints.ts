import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Executor } from "./executor.js";
import { sha256 } from "./util.js";

interface Entry {
  file: string;
  existed: boolean;
  blob: string | null;
}

interface Turn {
  id: number;
  label: string;
  createdAt: string;
  entries: Entry[];
}

/**
 * Per-turn file snapshots ("time travel"). The first time a file is mutated inside a turn its
 * previous content is stored; undo restores every file touched by that turn.
 */
export class Checkpoints {
  private turns: Turn[] = [];
  private current: Turn | null = null;
  private readonly dir: string;

  constructor(rootDir: string, readonly scope: string) {
    this.dir = path.join(rootDir, scope.replace(/[^a-zA-Z0-9_-]/g, "_"));
    mkdirSync(path.join(this.dir, "blobs"), { recursive: true });
    const manifest = path.join(this.dir, "manifest.json");
    if (existsSync(manifest)) {
      try {
        this.turns = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        this.turns = [];
      }
    }
  }

  beginTurn(label: string): number {
    const id = (this.turns.at(-1)?.id ?? 0) + 1;
    this.current = { id, label: label.slice(0, 200), createdAt: new Date().toISOString(), entries: [] };
    return id;
  }

  endTurn() {
    if (this.current && this.current.entries.length && !this.turns.includes(this.current)) {
      this.turns.push(this.current);
      this.save();
    }
    this.current = null;
  }

  record(file: string, previous: Buffer | null) {
    if (!this.current) this.beginTurn("(implicit)");
    const turn = this.current!;
    if (turn.entries.some((e) => e.file.toLowerCase() === file.toLowerCase())) return;
    let blob: string | null = null;
    if (previous) {
      blob = sha256(previous);
      const blobPath = path.join(this.dir, "blobs", blob);
      if (!existsSync(blobPath)) writeFileSync(blobPath, previous);
    }
    turn.entries.push({ file, existed: previous !== null, blob });
    // Persist eagerly so a crash mid-turn is still undoable.
    if (!this.turns.includes(turn)) {
      this.turns.push(turn);
    }
    this.save();
  }

  list() {
    return this.turns.map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, files: t.entries.map((e) => e.file) }));
  }

  /** Restore files changed in the given turn (default: most recent). */
  async undo(executor: Executor, turnId?: number) {
    const idx = turnId === undefined ? this.turns.length - 1 : this.turns.findIndex((t) => t.id === turnId);
    const turn = this.turns[idx];
    if (!turn) throw new Error(turnId === undefined ? "nothing to undo" : `checkpoint ${turnId} not found`);
    const restored: string[] = [];
    for (const e of [...turn.entries].reverse()) {
      if (e.existed && e.blob) {
        await executor.createDirectory(path.dirname(e.file));
        await executor.writeFile(e.file, readFileSync(path.join(this.dir, "blobs", e.blob)));
      } else {
        await executor.remove(e.file);
      }
      restored.push(e.file);
    }
    this.turns.splice(idx, 1);
    if (this.current === turn) this.current = null;
    this.save();
    return { turn: turn.id, label: turn.label, restored };
  }

  private save() {
    writeFileSync(path.join(this.dir, "manifest.json"), JSON.stringify(this.turns.slice(-200), null, 1));
  }

  /** Drop blobs no longer referenced by any manifest entry. */
  gc() {
    const live = new Set(this.turns.flatMap((t) => t.entries.map((e) => e.blob).filter(Boolean) as string[]));
    for (const f of readdirSync(path.join(this.dir, "blobs"))) if (!live.has(f)) rmSync(path.join(this.dir, "blobs", f), { force: true });
  }
}
