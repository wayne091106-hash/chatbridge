/**
 * Project (working folder) facts for the coding workbench: git branch, uncommitted changes with line
 * counts, per-file diffs, commit/push, and undoing what an agent conversation changed.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Runtime } from "../core/runtime.js";
import { dataDir } from "../core/config.js";
import { truncateMiddle } from "../core/util.js";
import type { ChangedFile } from "./jobs.js";

export interface ProjectChange {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface ProjectInfo {
  cwd: string;
  name: string;
  git: boolean;
  branch?: string;
  branches?: string[];
  remote?: string;
  ahead?: number;
  behind?: number;
  changes: ProjectChange[];
  lastCommit?: string;
}

async function git(rt: Runtime, cwd: string, args: string[], timeoutSeconds = 60) {
  const r = await rt.shells.exec(`git ${args[0]}`, {
    argv: ["git", "--no-optional-locks", "-c", "core.quotepath=false", "-c", "core.safecrlf=false", "-C", cwd, ...args],
    cwd,
    timeoutSeconds,
    maxOutputChars: 2_000_000,
  });
  return { ok: r.exitCode === 0, out: r.output };
}

/** Counts added/removed lines in a unified diff (ignoring the file headers). */
export function diffStats(diff = ""): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
}

export async function projectInfo(rt: Runtime, cwd: string): Promise<ProjectInfo> {
  const info: ProjectInfo = { cwd, name: path.basename(cwd) || cwd, git: false, changes: [] };
  const inside = await git(rt, cwd, ["rev-parse", "--is-inside-work-tree"], 20);
  if (!inside.ok || !/true/.test(inside.out)) return info;
  info.git = true;
  const [branch, branches, remote, counts, numstat, status, last] = await Promise.all([
    git(rt, cwd, ["branch", "--show-current"], 20),
    git(rt, cwd, ["branch", "--format=%(refname:short)"], 20),
    git(rt, cwd, ["remote", "get-url", "origin"], 20),
    git(rt, cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], 20),
    git(rt, cwd, ["diff", "--numstat", "HEAD"], 30),
    git(rt, cwd, ["status", "--porcelain=v1", "-uall"], 30),
    git(rt, cwd, ["log", "-1", "--format=%h %s"], 20),
  ]);
  info.branch = branch.out.trim() || "(detached)";
  info.branches = branches.out.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (remote.ok) info.remote = remote.out.trim();
  if (counts.ok) {
    const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
    info.behind = behind;
    info.ahead = ahead;
  }
  if (last.ok) info.lastCommit = last.out.trim();
  const lines = new Map<string, { added: number; removed: number }>();
  for (const l of numstat.out.split("\n")) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) lines.set(m[3]!, { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
  }
  for (const l of status.out.split("\n")) {
    const m = l.match(/^(.)(.) (.+)$/);
    if (!m) continue;
    const rel = m[3]!.replace(/^"|"$/g, "").split(" -> ").pop()!;
    const code = m[1] === "?" ? "??" : (m[1]!.trim() || m[2]!.trim());
    info.changes.push({ path: rel, status: code, ...(lines.get(rel) ?? { added: 0, removed: 0 }) });
  }
  return info;
}

/** Diff of one working-tree file against HEAD (new files are shown in full). */
export async function fileDiff(rt: Runtime, cwd: string, rel: string): Promise<string> {
  const tracked = await git(rt, cwd, ["ls-files", "--error-unmatch", "--", rel], 20);
  if (!tracked.ok) {
    const r = await git(rt, cwd, ["diff", "--no-index", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", rel]);
    return truncateMiddle(r.out, 80_000);
  }
  return truncateMiddle((await git(rt, cwd, ["diff", "--no-color", "HEAD", "--", rel])).out, 80_000);
}

export async function commitAll(rt: Runtime, cwd: string, message: string): Promise<string> {
  const add = await git(rt, cwd, ["add", "-A"]);
  if (!add.ok) throw new Error(add.out.trim());
  const c = await git(rt, cwd, ["commit", "-m", message]);
  if (!c.ok) throw new Error(c.out.trim().slice(0, 500) || "commit failed");
  return c.out.trim().split("\n")[0] ?? "committed";
}

export async function push(rt: Runtime, cwd: string): Promise<string> {
  const r = await git(rt, cwd, ["push", "-u", "origin", "HEAD"], 180);
  if (!r.ok) throw new Error(r.out.trim().slice(0, 800));
  return r.out.trim().slice(-500) || "pushed";
}

export async function switchBranch(rt: Runtime, cwd: string, branch: string, create: boolean): Promise<string> {
  const r = await git(rt, cwd, create ? ["switch", "-c", branch] : ["switch", branch]);
  if (!r.ok) throw new Error(r.out.trim().slice(0, 500));
  return `on ${branch}`;
}

/**
 * Undoes what an agent conversation changed: modified/deleted files are restored from the commit the
 * conversation started at; files it created are moved to ~/.chatbridge/hub/trash (not deleted).
 */
export async function revertChanges(rt: Runtime, cwd: string, base: string | undefined, changed: ChangedFile[]): Promise<string[]> {
  const root = (await git(rt, cwd, ["rev-parse", "--show-toplevel"], 20)).out.trim() || cwd;
  const trash = path.join(dataDir(), "hub", "trash", new Date().toISOString().replace(/[:.]/g, "-"));
  const done: string[] = [];
  for (const c of changed) {
    const abs = path.resolve(root, c.path);
    const rel = path.relative(path.resolve(root), abs);
    const isNew = c.status === "??" || c.status === "A";
    if (isNew || !base) {
      if (!existsSync(abs)) continue;
      const dest = path.join(trash, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(abs, dest);
      done.push(`moved new file to trash: ${rel}`);
    } else {
      const r = await git(rt, root, ["checkout", base, "--", rel]);
      done.push(r.ok ? `restored ${rel}` : `could not restore ${rel}: ${r.out.trim().slice(0, 200)}`);
    }
  }
  return done;
}
