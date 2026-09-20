/**
 * The Drive lane: a folder that Google Drive for desktop (or any sync client) keeps in the cloud. Files move
 * between the PC and the owner's phone/laptop at the sync client's full speed and never pass through
 * ChatGPT or the tunnel; the tools here are ordinary local file operations.
 *
 *   <folder>/收件  owner → PC   (dropped in from the Drive app or web)
 *   <folder>/寄件  PC → owner   (drive_send copies files here)
 */
import { existsSync, mkdirSync, promises as fsp } from "node:fs";
import path from "node:path";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { formatBytes } from "../core/util.js";
import type { DefineTool } from "./tools.js";

export const INBOX = "收件";
export const OUTBOX = "寄件";

/** The Google account the synced folder belongs to, when the owner told us (used only in the guide text). */
export function driveAccount(rt: Runtime): string | undefined {
  return rt.config.drive.account?.trim() || undefined;
}

export function driveFolders(rt: Runtime): { root: string; inbox: string; outbox: string } | null {
  const root = rt.config.drive.folder;
  if (!root || !existsSync(root)) return null;
  const inbox = path.join(root, INBOX);
  const outbox = path.join(root, OUTBOX);
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  return { root, inbox, outbox };
}

function uniqueIn(dir: string, name: string): string {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

async function copyRecursive(src: string, dest: string): Promise<number> {
  const st = await fsp.stat(src);
  if (!st.isDirectory()) {
    await fsp.copyFile(src, dest);
    return st.size;
  }
  await fsp.mkdir(dest, { recursive: true });
  let total = 0;
  for (const e of await fsp.readdir(src)) total += await copyRecursive(path.join(src, e), path.join(dest, e));
  return total;
}

/** Deletes items in 寄件 older than keepDays; returns how many were removed. */
async function cleanOutbox(outbox: string, keepDays: number): Promise<number> {
  const cutoff = Date.now() - keepDays * 86_400_000;
  let removed = 0;
  for (const e of await fsp.readdir(outbox)) {
    const p = path.join(outbox, e);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fsp.rm(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

export function registerDrive(define: DefineTool, rt: Runtime) {
  const need = () => {
    const f = driveFolders(rt);
    if (!f) throw new Error("the Drive folder is not set up on this PC (owner: chatbridge drive set <folder>)");
    return f;
  };

  define(
    "drive_send",
    {
      title: "Send files to the owner's Drive",
      description:
        "Fastest way to hand PC files to the user: copies files or folders into the synced Drive folder (ChatBridge/寄件). Google Drive uploads them at full network speed and the user gets them in the Drive app on any device — nothing goes through this chat. Use this for anything large (videos, renders, builds, datasets) or when the user wants a file on their phone. Old items in 寄件 are cleaned up automatically.",
      input: {
        paths: z.array(z.string()).min(1).max(50).describe("Files or folders on the PC"),
        subfolder: z.string().optional().describe("Optional folder name inside 寄件 to group the items"),
      },
      effect: "write",
      destructive: false,
    },
    async (a) => {
      const f = need();
      const target = a.subfolder ? path.join(f.outbox, a.subfolder.replace(/[<>:"/\\|?*]/g, "_")) : f.outbox;
      await fsp.mkdir(target, { recursive: true });
      const removed = await cleanOutbox(f.outbox, rt.config.drive.keepDays);
      const sent: string[] = [];
      let bytes = 0;
      for (const p of a.paths) {
        const src = rt.files.resolve(p);
        const dest = uniqueIn(target, path.basename(src));
        bytes += await copyRecursive(src, dest);
        sent.push(dest);
      }
      const rel = path.relative(f.root, target) || OUTBOX;
      return [
        `copied ${sent.length} item(s), ${formatBytes(bytes)}, into the Drive folder "ChatBridge/${rel.replace(/\\/g, "/")}".`,
        ...sent.map((s) => `  ${s}`),
        "",
        "Google Drive is uploading them now at the PC's full network speed (usually seconds; large videos may take a few minutes). Tell the user to open the Drive app → ChatBridge → 寄件.",
        ...(removed ? [`(cleaned up ${removed} item(s) older than ${rt.config.drive.keepDays} days)`] : []),
      ].join("\n");
    },
  );

  define(
    "drive_inbox",
    {
      title: "Files the owner dropped into Drive",
      description:
        "List files the user put into the Drive folder ChatBridge/收件 (from their phone or another computer), newest first, with local PC paths you can open directly with the other tools. Use it when the user says they uploaded or dropped something into Drive.",
      input: { limit: z.number().int().min(1).max(200).optional() },
      effect: "read",
    },
    async (a) => {
      const f = need();
      const rows: { name: string; path: string; size: number; mtime: number; dir: boolean }[] = [];
      for (const e of await fsp.readdir(f.inbox)) {
        const p = path.join(f.inbox, e);
        const st = await fsp.stat(p).catch(() => null);
        if (st) rows.push({ name: e, path: p, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
      }
      rows.sort((x, y) => y.mtime - x.mtime);
      if (!rows.length) return `ChatBridge/收件 is empty (${f.inbox}). If the user just added files, Drive may still be syncing — try again in a few seconds.`;
      return [
        `ChatBridge/收件 (${f.inbox}), newest first:`,
        ...rows.slice(0, a.limit ?? 50).map((r) => `  ${new Date(r.mtime).toLocaleString()}  ${r.dir ? "[folder]" : formatBytes(r.size).padStart(9)}  ${r.path}`),
        "",
        "Open these paths directly (fs_read, view, shell_run …). Files that live only in the cloud are downloaded when first opened.",
      ].join("\n");
    },
  );
}
