/**
 * Project grants: time-limited permission to work inside one folder.
 *
 * The bridge normally runs with the whole machine available (policy.scope = "machine"), which is what the
 * owner chose. Switching to policy.scope = "projects" flips that around: nothing is reachable except the
 * folders granted here, and each grant can expire on its own.
 *
 * Grants live in a file rather than in config.json because they come and go while the bridge is running,
 * and because `chatbridge grant --hours 8` should stop working on its own without anyone editing config.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { expandHome, pathKey, randomId } from "./util.js";

export interface Grant {
  id: string;
  /** Absolute, resolved folder. */
  path: string;
  note?: string;
  createdAt: string;
  /** Epoch ms; absent means it lasts until revoked. */
  expiresAt?: number;
}

const file = (dir = dataDir()) => path.join(dir, "grants.json");

function readAll(dir?: string): Grant[] {
  const f = file(dir);
  if (!existsSync(f)) return [];
  try {
    const list = JSON.parse(readFileSync(f, "utf8")) as Grant[];
    return Array.isArray(list) ? list.filter((g) => g && typeof g.path === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(list: Grant[], dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

/** Grants that have not expired, newest first. Expired ones are dropped from the file as we go. */
export function activeGrants(dir?: string): Grant[] {
  const now = Date.now();
  const all = readAll(dir);
  const live = all.filter((g) => !g.expiresAt || g.expiresAt > now);
  if (live.length !== all.length) writeAll(live, dir);
  return live;
}

export function addGrant(target: string, opts: { hours?: number; note?: string } = {}, dir?: string): Grant {
  const resolved = path.resolve(expandHome(target));
  const grant: Grant = {
    id: randomId("g", 4),
    path: resolved,
    note: opts.note,
    createdAt: new Date().toISOString(),
    expiresAt: opts.hours ? Date.now() + opts.hours * 3600_000 : undefined,
  };
  // One grant per folder: re-granting extends it instead of stacking duplicates.
  const list = activeGrants(dir).filter((g) => !samePath(g.path, resolved));
  list.unshift(grant);
  writeAll(list, dir);
  return grant;
}

/** Revokes by id or by folder; "all" clears everything. Returns how many went away. */
export function revokeGrant(idOrPath: string, dir?: string): number {
  const list = activeGrants(dir);
  if (idOrPath === "all") {
    writeAll([], dir);
    return list.length;
  }
  const resolved = path.resolve(expandHome(idOrPath));
  const kept = list.filter((g) => g.id !== idOrPath && !samePath(g.path, resolved));
  writeAll(kept, dir);
  return list.length - kept.length;
}

const normalise = pathKey;

export function samePath(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

/**
 * True when `child` is `parent` or sits underneath it. Uses path.relative rather than a prefix test so
 * that C:\work does not swallow C:\work-secrets.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalise(parent), normalise(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The folder granting access to `target`, or undefined when nothing does. */
export function grantFor(target: string, dir?: string): Grant | undefined {
  return activeGrants(dir).find((g) => isInside(g.path, target));
}

export function describeGrant(g: Grant): string {
  const left = g.expiresAt ? `${Math.max(0, Math.round((g.expiresAt - Date.now()) / 60_000))} 分鐘後到期` : "沒有期限";
  return `${g.id}  ${g.path}  (${left})${g.note ? `  — ${g.note}` : ""}`;
}
