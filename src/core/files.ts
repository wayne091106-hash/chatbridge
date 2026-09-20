import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { Executor } from "./executor.js";
import { applyPatch, type PatchResult } from "./patch.js";
import { formatBytes, looksBinary, truncateMiddle } from "./util.js";
import type { ShellManager } from "./shell.js";
import type { Checkpoints } from "./checkpoints.js";

export interface ReadOptions {
  offset?: number; // 1-based line
  limit?: number;
  maxChars?: number;
}

export const checkpointScope = new AsyncLocalStorage<Checkpoints>();

const IGNORED_DIRS =new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache", "target", ".idea", ".vs"]);

/**
 * High-level file operations used by both the MCP bridge and the Kestrel agent. Every mutation
 * goes through `beforeMutate` so the agent can snapshot files for undo.
 */
export class FileService {
  constructor(
    private readonly executor: Executor,
    private readonly shells: ShellManager,
    private readonly baseDir: () => string,
    private readonly checkpoints?: Checkpoints,
    private readonly rgPath?: string | null,
  ) {}

  resolve(p: string): string {
    const expanded = p.startsWith("~") ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", p.slice(1)) : p;
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(this.baseDir(), expanded);
  }

  private async beforeMutate(abs: string) {
    // Concurrent agents each record into their own checkpoint set (see checkpointScope).
    const cps = checkpointScope.getStore() ?? this.checkpoints;
    if (!cps) return;
    const st = await this.executor.stat(abs);
    const previous = st?.isFile ? await this.executor.readFile(abs) : null;
    cps.record(abs, previous);
  }

  async read(p: string, o: ReadOptions = {}) {
    const abs = this.resolve(p);
    const st = await this.executor.stat(abs);
    if (!st) throw new Error(`file not found: ${abs}`);
    if (st.isDirectory) throw new Error(`${abs} is a directory; use fs_list`);
    if (st.size > 50 * 1024 * 1024) throw new Error(`${abs} is ${formatBytes(st.size)}; read a slice with the shell instead`);
    const buf = await this.executor.readFile(abs);
    if (looksBinary(buf)) {
      return { path: abs, binary: true, size: st.size, text: `[binary file, ${formatBytes(st.size)}]`, totalLines: 0, truncated: false };
    }
    const all = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (all.at(-1) === "") all.pop();
    const offset = Math.max(1, o.offset ?? 1);
    const limit = o.limit ?? 2000;
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line.length > 2000 ? line.slice(0, 2000) + "…" : line}`).join("\n");
    const maxChars = o.maxChars ?? 100_000;
    const text = truncateMiddle(numbered, maxChars);
    return {
      path: abs,
      binary: false,
      size: st.size,
      totalLines: all.length,
      fromLine: offset,
      toLine: offset + slice.length - 1,
      truncated: offset - 1 + slice.length < all.length || text.length < numbered.length,
      text,
    };
  }

  async write(p: string, content: string) {
    const abs = this.resolve(p);
    await this.beforeMutate(abs);
    await this.executor.createDirectory(path.dirname(abs));
    await this.executor.writeFile(abs, content);
    return { path: abs, bytes: Buffer.byteLength(content) };
  }

  async edit(p: string, oldString: string, newString: string, replaceAll = false) {
    const abs = this.resolve(p);
    const original = (await this.executor.readFile(abs)).toString("utf8");
    const crlf = original.includes("\r\n");
    // Models usually send LF; match against LF-normalised text, then restore CRLF.
    const text = crlf ? original.replace(/\r\n/g, "\n") : original;
    const needle = oldString.replace(/\r\n/g, "\n");
    const replacement = newString.replace(/\r\n/g, "\n");
    if (!needle) throw new Error("old_string must not be empty");
    const count = text.split(needle).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${abs}. Re-read the file and copy the exact text (including indentation).`);
    if (count > 1 && !replaceAll) throw new Error(`old_string occurs ${count} times in ${abs}; add surrounding context or set replace_all`);
    let updated = replaceAll ? text.split(needle).join(replacement) : text.replace(needle, () => replacement);
    if (crlf) updated = updated.replace(/\n/g, "\r\n");
    await this.beforeMutate(abs);
    await this.executor.writeFile(abs, updated);
    return { path: abs, replacements: replaceAll ? count : 1 };
  }

  async patch(patchText: string, cwd?: string): Promise<PatchResult> {
    const ex = this.executor;
    return applyPatch(
      patchText,
      cwd ? this.resolve(cwd) : this.baseDir(),
      {
        readFile: (f) => ex.readFile(f),
        writeFile: (f, d) => ex.writeFile(f, d),
        remove: (f) => ex.remove(f),
        exists: async (f) => (await ex.stat(f)) !== null,
        mkdirp: (d) => ex.createDirectory(d),
      },
      (abs) => this.beforeMutate(abs),
    );
  }

  async list(p: string, depth = 1, maxEntries = 500) {
    const root = this.resolve(p);
    const st = await this.executor.stat(root);
    if (!st) throw new Error(`not found: ${root}`);
    if (!st.isDirectory) throw new Error(`${root} is not a directory`);
    const lines: string[] = [];
    let count = 0;
    let truncated = false;
    const walk = async (dir: string, level: number, prefix: string) => {
      let entries;
      try {
        entries = await this.executor.readDirectory(dir);
      } catch (err) {
        lines.push(`${prefix}[unreadable]`);
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= maxEntries) {
          truncated = true;
          return;
        }
        count++;
        if (e.isDirectory) {
          const skip = IGNORED_DIRS.has(e.name);
          lines.push(`${prefix}${e.name}/${skip && level < depth ? "  (skipped)" : ""}`);
          if (level < depth && !skip) await walk(path.join(dir, e.name), level + 1, prefix + "  ");
        } else {
          lines.push(`${prefix}${e.name}`);
        }
      }
    };
    await walk(root, 1, "");
    return { path: root, entries: count, truncated, tree: lines.join("\n") || "(empty)" };
  }

  async stat(p: string) {
    const abs = this.resolve(p);
    return { path: abs, ...(await this.executor.stat(abs)) };
  }

  async manage(action: "mkdir" | "delete" | "copy" | "move", p: string, destination?: string) {
    const abs = this.resolve(p);
    switch (action) {
      case "mkdir":
        await this.executor.createDirectory(abs);
        return { action, path: abs };
      case "delete": {
        const st = await this.executor.stat(abs);
        if (!st) throw new Error(`not found: ${abs}`);
        if (st.isFile) await this.beforeMutate(abs);
        await this.executor.remove(abs);
        return { action, path: abs };
      }
      case "copy":
      case "move": {
        if (!destination) throw new Error(`${action} requires destination`);
        const dest = this.resolve(destination);
        await this.executor.createDirectory(path.dirname(dest));
        await this.executor.copy(abs, dest);
        if (action === "move") {
          const st = await this.executor.stat(abs);
          if (st?.isFile) await this.beforeMutate(abs);
          await this.executor.remove(abs);
        }
        return { action, path: abs, destination: dest };
      }
    }
  }

  /** Content search via ripgrep (bundled with Codex) with a pure fallback. */
  async search(pattern: string, p = ".", opts: { glob?: string; ignoreCase?: boolean; maxResults?: number; filesOnly?: boolean } = {}) {
    const root = this.resolve(p);
    const max = opts.maxResults ?? 200;
    if (this.rgPath) {
      const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview"];
      if (opts.ignoreCase) args.push("--ignore-case");
      if (opts.filesOnly) args.push("--files-with-matches");
      if (opts.glob) args.push("--glob", opts.glob);
      args.push("--", pattern, root);
      const r = await this.shells.exec(`rg ${pattern}`, { argv: [this.rgPath, ...args], timeoutSeconds: 60, cwd: root });
      const lines = r.output.split("\n").filter(Boolean);
      return { engine: "ripgrep", matches: lines.length, truncated: lines.length > max, results: lines.slice(0, max).join("\n") || "(no matches)" };
    }
    const re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
    const globRe = opts.glob ? globToRegExp(opts.glob) : null;
    const results: string[] = [];
    const walk = async (dir: string, level: number) => {
      if (results.length >= max || level > 12) return;
      for (const e of await this.executor.readDirectory(dir).catch(() => [])) {
        if (results.length >= max) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory) {
          if (!IGNORED_DIRS.has(e.name)) await walk(full, level + 1);
        } else if (!globRe || globRe.test(e.name) || globRe.test(path.relative(root, full).replace(/\\/g, "/"))) {
          const buf = await this.executor.readFile(full).catch(() => null);
          if (!buf || buf.length > 5_000_000 || looksBinary(buf)) continue;
          const fileLines = buf.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < fileLines.length && results.length < max; i++) {
            if (re.test(fileLines[i]!)) {
              results.push(opts.filesOnly ? full : `${full}:${i + 1}:${fileLines[i]!.slice(0, 300)}`);
              if (opts.filesOnly) break;
            }
          }
        }
      }
    };
    await walk(root, 0);
    return { engine: "builtin", matches: results.length, truncated: results.length >= max, results: results.join("\n") || "(no matches)" };
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        re += "(?:" + glob.slice(i + 1, close).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = close;
      } else re += "\\{";
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
