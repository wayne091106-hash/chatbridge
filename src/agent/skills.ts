import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { queryTerms } from "./store.js";

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  version: number;
  created: string;
  updated: string;
  uses: number;
  successes: number;
  origin: "learned" | "bundled" | "user";
}

export interface Skill extends SkillMeta {
  slug: string;
  body: string;
  dir: string;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "skill";
}

/** Minimal YAML-subset frontmatter (key: value, arrays as [a, b]). */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v: unknown = kv[2]!.trim();
    const s = v as string;
    if (/^\[.*\]$/.test(s)) v = s.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else if (/^-?\d+(\.\d+)?$/.test(s)) v = Number(s);
    else if (/^["'].*["']$/.test(s)) v = s.slice(1, -1);
    meta[kv[1]!] = v;
  }
  return { meta, body: m[2]! };
}

function renderSkill(meta: SkillMeta, body: string): string {
  const q = (s: string) => (/[:#\[\]{}]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);
  return [
    "---",
    `name: ${q(meta.name)}`,
    `description: ${q(meta.description)}`,
    `tags: [${meta.tags.join(", ")}]`,
    `version: ${meta.version}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `uses: ${meta.uses}`,
    `successes: ${meta.successes}`,
    `origin: ${meta.origin}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

/**
 * Procedural memory: reusable how-to documents (SKILL.md, compatible with the agentskills layout).
 * Kestrel distils new skills from successful sessions, versions every edit and tracks outcomes so
 * proven procedures rank first.
 */
export class SkillLibrary {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private file(slug: string) {
    return path.join(this.root, slug, "SKILL.md");
  }

  list(): Skill[] {
    const out: Skill[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const s = this.get(entry.name);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(slugOrName: string): Skill | null {
    const slug = existsSync(this.file(slugOrName)) ? slugOrName : slugify(slugOrName);
    const f = this.file(slug);
    if (!existsSync(f)) return null;
    const { meta, body } = parseFrontmatter(readFileSync(f, "utf8"));
    const ts = new Date().toISOString();
    return {
      slug,
      dir: path.dirname(f),
      body,
      name: String(meta.name ?? slug),
      description: String(meta.description ?? ""),
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
      version: Number(meta.version ?? 1),
      created: String(meta.created ?? ts),
      updated: String(meta.updated ?? ts),
      uses: Number(meta.uses ?? 0),
      successes: Number(meta.successes ?? 0),
      origin: (meta.origin as SkillMeta["origin"]) ?? "user",
    };
  }

  save(input: { name: string; description: string; body: string; tags?: string[]; origin?: SkillMeta["origin"] }): Skill {
    const slug = slugify(input.name);
    const existing = this.get(slug);
    const ts = new Date().toISOString();
    if (existing) {
      // Keep previous version for rollback.
      const hist = path.join(existing.dir, ".history");
      mkdirSync(hist, { recursive: true });
      copyFileSync(this.file(slug), path.join(hist, `v${existing.version}.md`));
    }
    const meta: SkillMeta = {
      name: input.name.trim(),
      description: input.description.trim().replace(/\s+/g, " "),
      tags: (input.tags ?? existing?.tags ?? []).map((t) => t.trim()).filter(Boolean),
      version: (existing?.version ?? 0) + 1,
      created: existing?.created ?? ts,
      updated: ts,
      uses: existing?.uses ?? 0,
      successes: existing?.successes ?? 0,
      origin: existing?.origin ?? input.origin ?? "user",
    };
    mkdirSync(path.join(this.root, slug), { recursive: true });
    writeFileSync(this.file(slug), renderSkill(meta, input.body));
    return this.get(slug)!;
  }

  recordOutcome(slugOrName: string, success: boolean) {
    const s = this.get(slugOrName);
    if (!s) return;
    const meta: SkillMeta = { ...s, uses: s.uses + 1, successes: s.successes + (success ? 1 : 0) };
    writeFileSync(this.file(s.slug), renderSkill(meta, s.body));
  }

  delete(slugOrName: string): boolean {
    const s = this.get(slugOrName);
    if (!s) return false;
    rmSync(s.dir, { recursive: true, force: true });
    return true;
  }

  rollback(slugOrName: string): Skill {
    const s = this.get(slugOrName);
    if (!s) throw new Error(`skill ${slugOrName} not found`);
    const prev = path.join(s.dir, ".history", `v${s.version - 1}.md`);
    if (!existsSync(prev)) throw new Error(`no previous version of ${s.name}`);
    const { meta, body } = parseFrontmatter(readFileSync(prev, "utf8"));
    return this.save({ name: s.name, description: String(meta.description ?? s.description), body, tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : s.tags });
  }

  /** Relevance = keyword overlap on name/description/tags/body, boosted by proven success rate. */
  search(query: string, limit = 5): Array<Skill & { score: number }> {
    const { fts, like } = queryTerms(query);
    const terms = [...fts.map((t) => t.slice(1, -1)), ...like];
    if (!terms.length) return [];
    const scored = this.list().map((s) => {
      const head = `${s.name} ${s.description} ${s.tags.join(" ")}`.toLowerCase();
      const body = s.body.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (head.includes(t)) score += 2;
        else if (body.includes(t)) score += 0.5;
      }
      const rate = s.uses ? s.successes / s.uses : 0.5;
      return { ...s, score: score ? score * (0.75 + rate * 0.5) : 0 };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  installBundled(bundledDir: string) {
    if (!existsSync(bundledDir)) return 0;
    let n = 0;
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(this.root, entry.name, "SKILL.md");
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(bundledDir, entry.name, "SKILL.md"), target);
      n++;
    }
    return n;
  }
}
