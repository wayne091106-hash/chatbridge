/**
 * The result card. A chat model writing out "what changed" by hand gets it wrong, so the model only
 * supplies the words (what it did, what it asks) and the PC supplies the facts: the real changed files
 * with line counts and diffs, and one-tap follow-ups. Built to be readable on a phone.
 */
import path from "node:path";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import type { DefineTool } from "./tools.js";
import { AGENT_PANEL_URI, cardResult } from "./widgets.js";
import { hubFor } from "../hub/tools.js";
import { diffStats, fileDiff, projectInfo } from "../hub/project.js";

export function registerSummary(define: DefineTool, rt: Runtime) {
  const hub = hubFor(rt);

  define(
    "show_summary",
    {
      title: "Show a result card",
      description:
        "End a piece of work with a result card instead of typing the details out. You write `notes` (what you did, in your own words, a few short lines) and optional `questions` / `next_steps`; the PC fills in the facts — the real changed files, line counts and diffs the user can open, plus buttons (undo, send to Drive, open the workbench). Use it whenever you finish something that touched files: after an agent conversation (pass job_id), after your own edits in a project (pass cwd), or for a plain status card (neither). Never hand-write a list of changed files or line counts; this tool measures them.",
      input: {
        title: z.string().min(2).max(120).describe("Short headline, e.g. 「計算機功能完成」"),
        notes: z.string().min(2).max(4000).describe("What you did / found, in a few short lines (Markdown, the user's language)"),
        job_id: z.string().optional().describe("Agent conversation whose changes to show"),
        cwd: z.string().optional().describe("Project folder: shows its uncommitted changes (use when you edited files yourself)"),
        status: z.enum(["done", "running", "failed", "question"]).optional(),
        questions: z.array(z.string().max(300)).max(5).optional().describe("Questions for the user, shown as text"),
        next_steps: z.array(z.string().max(80)).max(5).optional().describe("Suggested next actions, shown as one-tap buttons that send that text back to you"),
      },
      effect: "read",
      meta: {
        ui: { resourceUri: AGENT_PANEL_URI },
        "openai/outputTemplate": AGENT_PANEL_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "整理結果…",
        "openai/toolInvocation/invoked": "結果卡片",
      },
    },
    async (a) => {
      const job = a.job_id ? hub.latest(a.job_id) : null;
      const cwd = job?.cwd ?? (a.cwd ? rt.files.resolve(a.cwd) : "");
      let changed: Array<{ path: string; status: string; added: number; removed: number }> = [];
      let source = "";
      if (job) {
        changed = job.changed.map((c) => ({ path: c.path, status: c.status, ...diffStats(c.diff) }));
        source = "job";
      } else if (cwd) {
        const p = await projectInfo(rt, cwd);
        changed = p.changes.map((c) => ({ path: path.resolve(cwd, c.path), status: c.status, added: c.added, removed: c.removed }));
        source = p.git ? "project" : "";
      }
      const totals = changed.reduce((t, c) => ({ a: t.a + c.added, r: t.r + c.removed }), { a: 0, r: 0 });
      const data = {
        mode: "summary",
        title: a.title,
        notes: a.notes,
        status: a.status ?? (job ? (job.status === "done" ? "done" : job.status) : "done"),
        questions: a.questions ?? [],
        nextSteps: a.next_steps ?? [],
        cwd,
        job: job ? { id: job.id, agentLabel: job.agent, cwd: job.cwd } : null,
        diffSource: source,
        changed,
      };
      const summary = changed.length ? `${changed.length} file(s), +${totals.a} -${totals.r}` : "no file changes";
      return cardResult({ mode: "summary", files: changed.length }, data, [
        { type: "text", text: `Result card shown to the user: "${a.title}" (${summary}). The user sees the real file list and can open each diff, so do not repeat it in your reply — add only what the card does not say.` },
      ]);
    },
  );

  define(
    "summary_diff",
    {
      title: "Diff for the result card",
      description: "Internal: the diff of one file shown on a result card.",
      input: { cwd: z.string(), path: z.string() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const cwd = rt.files.resolve(a.cwd);
      const rel = path.isAbsolute(a.path) ? path.relative(cwd, a.path) : a.path;
      return cardResult({ path: a.path }, { diff: await fileDiff(rt, cwd, rel.split(path.sep).join("/")) }, [{ type: "text", text: a.path }]);
    },
  );
}
