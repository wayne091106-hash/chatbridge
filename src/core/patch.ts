/**
 * Parser/applier for the Codex `apply_patch` format, which models are heavily trained on:
 *
 *   *** Begin Patch
 *   *** Add File: path          (+lines)
 *   *** Delete File: path
 *   *** Update File: path
 *   *** Move to: new/path       (optional)
 *   @@ optional anchor line
 *    context / -removed / +added
 *   *** End of File             (optional: hunk must match at EOF)
 *   *** End Patch
 */
import path from "node:path";

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export interface Hunk {
  anchor?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export class PatchError extends Error {}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Tolerate heredoc wrappers like `apply_patch <<'EOF'`.
  let start = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  if (start < 0) throw new PatchError("patch must start with '*** Begin Patch'");
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (lines[i]!.trim() === "*** End Patch") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new PatchError("patch must end with '*** End Patch'");

  const ops: PatchOp[] = [];
  let i = start + 1;
  const header = (l: string, prefix: string) => (l.startsWith(prefix) ? l.slice(prefix.length).trim() : null);

  while (i < end) {
    const line = lines[i]!;
    let p: string | null;
    if ((p = header(line, "*** Add File: ")) !== null) {
      i++;
      const content: string[] = [];
      while (i < end && !lines[i]!.startsWith("*** ")) {
        const l = lines[i]!;
        if (!l.startsWith("+")) throw new PatchError(`Add File ${p}: every line must start with '+', got: ${l.slice(0, 60)}`);
        content.push(l.slice(1));
        i++;
      }
      ops.push({ type: "add", path: p, content: content.length ? content.join("\n") + "\n" : "" });
    } else if ((p = header(line, "*** Delete File: ")) !== null) {
      ops.push({ type: "delete", path: p });
      i++;
    } else if ((p = header(line, "*** Update File: ")) !== null) {
      i++;
      let moveTo: string | undefined;
      const mv = i < end ? header(lines[i]!, "*** Move to: ") : null;
      if (mv !== null) {
        moveTo = mv;
        i++;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < end && !(lines[i]!.startsWith("*** ") && !lines[i]!.startsWith("*** End of File"))) {
        const l = lines[i]!;
        if (l.startsWith("@@")) {
          if (current && (current.oldLines.length || current.newLines.length)) hunks.push(current);
          const anchor = l.slice(2).trim();
          current = { anchor: anchor || undefined, oldLines: [], newLines: [], endOfFile: false };
        } else if (l.startsWith("*** End of File")) {
          if (current) current.endOfFile = true;
        } else {
          current ??= { oldLines: [], newLines: [], endOfFile: false };
          const tag = l[0];
          const body = l.slice(1);
          if (tag === " " || l === "") {
            current.oldLines.push(body);
            current.newLines.push(body);
          } else if (tag === "-") current.oldLines.push(body);
          else if (tag === "+") current.newLines.push(body);
          else throw new PatchError(`Update File ${p}: unexpected line (must start with ' ', '-', '+' or '@@'): ${l.slice(0, 60)}`);
        }
        i++;
      }
      if (current && (current.oldLines.length || current.newLines.length)) hunks.push(current);
      if (!hunks.length && !moveTo) throw new PatchError(`Update File ${p}: no hunks`);
      ops.push({ type: "update", path: p, moveTo, hunks });
    } else if (line.trim() === "") {
      i++;
    } else {
      throw new PatchError(`unexpected line in patch: ${line.slice(0, 80)}`);
    }
  }
  if (!ops.length) throw new PatchError("patch contains no operations");
  return ops;
}

const normalizers: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) =>
    s
      .trim()
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, " "),
];

function findSequence(haystack: string[], needle: string[], from: number, eof: boolean): number {
  if (needle.length === 0) return eof ? haystack.length : -1;
  for (const norm of normalizers) {
    const target = needle.map(norm);
    const matches = (at: number) => target.every((t, k) => norm(haystack[at + k]!) === t);
    if (eof) {
      const at = haystack.length - needle.length;
      if (at >= from && matches(at)) return at;
      continue;
    }
    for (let at = from; at <= haystack.length - needle.length; at++) if (matches(at)) return at;
  }
  return -1;
}

/** Apply hunks to file content. Preserves CRLF vs LF and trailing newline. */
export function applyHunks(original: string, hunks: Hunk[], filePath = "file"): string {
  const crlf = original.includes("\r\n");
  const hadTrailingNewline = original.endsWith("\n");
  let lines = original.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();

  const replacements: Array<{ at: number; remove: number; insert: string[] }> = [];
  let cursor = 0;
  for (const [idx, h] of hunks.entries()) {
    if (h.anchor) {
      const a = findSequence(lines, [h.anchor], cursor, false);
      if (a >= 0) cursor = a + 1;
      else if (h.oldLines.length === 0) throw new PatchError(`${filePath}: hunk ${idx + 1} anchor not found: ${h.anchor}`);
    }
    let at: number;
    if (h.oldLines.length === 0) {
      at = h.anchor ? cursor : lines.length;
    } else {
      at = findSequence(lines, h.oldLines, cursor, h.endOfFile);
      if (at < 0 && cursor > 0) at = findSequence(lines, h.oldLines, 0, h.endOfFile);
      if (at < 0) {
        const preview = h.oldLines.slice(0, 6).join("\n");
        throw new PatchError(`${filePath}: hunk ${idx + 1} context not found. Expected lines:\n${preview}`);
      }
    }
    replacements.push({ at, remove: h.oldLines.length, insert: h.newLines });
    cursor = at + h.oldLines.length;
  }
  replacements.sort((a, b) => b.at - a.at);
  for (const r of replacements) lines.splice(r.at, r.remove, ...r.insert);
  let out = lines.join("\n");
  if (hadTrailingNewline || (original === "" && out !== "")) out += "\n";
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

export interface PatchFs {
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
}

export interface PatchResult {
  added: string[];
  updated: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
}

/**
 * Validates every operation first (reads + applies in memory), then writes. A failing hunk
 * therefore leaves the filesystem untouched.
 */
export async function applyPatch(
  patchText: string,
  baseDir: string,
  fs: PatchFs,
  beforeWrite?: (absPath: string) => Promise<void>,
): Promise<PatchResult> {
  const ops = parsePatch(patchText);
  const resolve = (p: string) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(baseDir, p));
  const plan: Array<{ kind: "write"; path: string; content: string } | { kind: "remove"; path: string }> = [];
  const result: PatchResult = { added: [], updated: [], deleted: [], moved: [] };

  for (const op of ops) {
    const abs = resolve(op.path);
    if (op.type === "add") {
      plan.push({ kind: "write", path: abs, content: op.content });
      result.added.push(abs);
    } else if (op.type === "delete") {
      if (!(await fs.exists(abs))) throw new PatchError(`Delete File: ${abs} does not exist`);
      plan.push({ kind: "remove", path: abs });
      result.deleted.push(abs);
    } else {
      if (!(await fs.exists(abs))) throw new PatchError(`Update File: ${abs} does not exist`);
      const original = (await fs.readFile(abs)).toString("utf8");
      const updated = applyHunks(original, op.hunks, op.path);
      if (op.moveTo) {
        const dest = resolve(op.moveTo);
        plan.push({ kind: "write", path: dest, content: updated }, { kind: "remove", path: abs });
        result.moved.push({ from: abs, to: dest });
      } else {
        plan.push({ kind: "write", path: abs, content: updated });
        result.updated.push(abs);
      }
    }
  }

  for (const step of plan) {
    await beforeWrite?.(step.path);
    if (step.kind === "write") {
      await fs.mkdirp(path.dirname(step.path));
      await fs.writeFile(step.path, step.content);
    } else {
      await fs.remove(step.path);
    }
  }
  return result;
}
