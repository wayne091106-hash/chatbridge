import os from "node:os";
import path from "node:path";
import { dataDir, type BridgeConfig } from "./config.js";
import { activeGrants, grantFor, isInside } from "./grants.js";
import { expandHome } from "./util.js";

export type ToolEffect = "read" | "write" | "execute" | "desktop" | "admin";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface PolicySubject {
  command?: string;
  paths?: string[];
}

/** Argument names that always carry a filesystem path. */
const PATH_KEYS = new Set(["path", "paths", "file", "files", "dir", "directory", "folder", "cwd", "destination", "dest", "save_to", "save_path", "project", "repo"]);

/**
 * Argument names that sometimes carry a path and sometimes do not (`from`/`to` are just as likely to be
 * line numbers or a model name). These only count when the value actually looks like a path, so that
 * project scope does not refuse calls over an argument that was never a filename.
 */
const MAYBE_PATH_KEYS = new Set(["source", "src", "target", "to", "from", "out", "output"]);

const LOOKS_LIKE_PATH = /[\\/]|^~|^[A-Za-z]:|^\.\.?$/;

/**
 * Pulls the paths and the command out of a tool's arguments without every tool having to declare them.
 * Tools can still add their own subject when the path is buried somewhere unusual.
 */
export function subjectFromArgs(args: unknown): PolicySubject {
  const out: PolicySubject = {};
  const paths: string[] = [];
  if (args && typeof args === "object") {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (key === "command" && typeof value === "string") out.command = value;
      const always = PATH_KEYS.has(key);
      if (!always && !MAYBE_PATH_KEYS.has(key)) continue;
      const take = (v: unknown) => {
        if (typeof v === "string" && v && (always || LOOKS_LIKE_PATH.test(v))) paths.push(v);
      };
      if (Array.isArray(value)) value.forEach(take);
      else take(value);
    }
  }
  if (paths.length) out.paths = paths;
  return out;
}

/** Absolute paths mentioned inside a shell command (best effort: Windows drive paths, UNC, POSIX roots). */
export function absolutePathsIn(command: string): string[] {
  const found = new Set<string>();
  for (const m of command.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? "").replace(/[,;]+$/, "");
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue; // URLs
    if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\")) found.add(token);
    else if (process.platform !== "win32" && token.startsWith("/") && token.length > 1 && !/^\/\//.test(token)) found.add(token);
  }
  return [...found];
}

/**
 * Owner-defined guard rails.
 *
 * `scope: "machine"` (the default) is the owner's explicit choice: the whole computer is available and only
 * the deny patterns and readonly mode hold anything back. `scope: "projects"` inverts it — nothing outside a
 * live grant (see grants.ts) can be read, written or used as a working directory.
 *
 * Projects scope is a guard rail, not a sandbox: a shell command is checked for the absolute paths it names,
 * but a command can still reach elsewhere through indirection. Treat it as "stop the model wandering", not
 * "contain an attacker".
 */
export class Policy {
  private commandDeny: RegExp[];
  private pathDeny: RegExp[];

  constructor(
    private readonly cfg: BridgeConfig["policy"],
    /** Where relative paths resolve from (the bridge's working directory). */
    private readonly baseDir: () => string = () => process.cwd(),
    /** Overridden in tests so grants do not touch the real home directory. */
    private readonly grantsDir?: string,
  ) {
    this.commandDeny = cfg.denyCommandPatterns.map((p) => new RegExp(p, "i"));
    this.pathDeny = cfg.denyPathPatterns.map((p) => new RegExp(p, "i"));
  }

  get mode() {
    return this.cfg.mode;
  }

  get scope() {
    return this.cfg.scope;
  }

  /**
   * Folders the bridge always needs whatever the scope: its own state directory and the transfer folder.
   * Deliberately narrow — the system temp directory is not on this list, because half the machine's
   * scratch data passes through it.
   */
  private alwaysAllowed(): string[] {
    return [dataDir(), path.join(os.homedir(), "ChatBridge"), ...this.cfg.alwaysAllow.map((p) => path.resolve(expandHome(p)))];
  }

  private resolve(p: string): string {
    const expanded = expandHome(p);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(this.baseDir(), expanded);
  }

  private outsideGrants(p: string): boolean {
    const abs = this.resolve(p);
    if (this.alwaysAllowed().some((root) => isInside(root, abs))) return false;
    return !grantFor(abs, this.grantsDir);
  }

  check(effect: ToolEffect, subject: PolicySubject = {}): PolicyDecision {
    if (this.cfg.mode === "readonly" && effect !== "read") {
      return { allowed: false, reason: "bridge is in readonly policy mode" };
    }
    if (subject.command) {
      const hit = this.commandDeny.find((re) => re.test(subject.command!));
      if (hit) return { allowed: false, reason: `command matches deny pattern ${hit}` };
    }
    for (const p of subject.paths ?? []) {
      const hit = this.pathDeny.find((re) => re.test(p.replace(/\\/g, "/")));
      if (hit) return { allowed: false, reason: `path ${p} matches deny pattern ${hit}` };
    }
    if (this.cfg.scope !== "projects" || effect === "admin") return { allowed: true };

    if (effect === "desktop" && !this.cfg.projectsAllowDesktop) {
      return { allowed: false, reason: "project scope is on: screen, mouse and window tools are off (policy.projectsAllowDesktop enables them)" };
    }
    const granted = activeGrants(this.grantsDir);
    if (!granted.length) {
      return { allowed: false, reason: "project scope is on but nothing is granted; run: chatbridge grant \"<folder>\"" };
    }
    for (const p of subject.paths ?? []) {
      if (this.outsideGrants(p)) return { allowed: false, reason: `${p} is outside the granted project folders (${granted.map((g) => g.path).join(", ")})` };
    }
    if (subject.command) {
      const stray = absolutePathsIn(subject.command).find((p) => this.outsideGrants(p));
      if (stray) return { allowed: false, reason: `the command names ${stray}, which is outside the granted project folders` };
    }
    // A command with no cwd of its own runs in the bridge's working directory, so that has to be granted too.
    if (effect === "execute" && !subject.paths?.length && this.outsideGrants(this.baseDir())) {
      return { allowed: false, reason: `the working directory ${this.baseDir()} is outside the granted project folders; pass an explicit cwd inside a granted folder` };
    }
    return { allowed: true };
  }
}
