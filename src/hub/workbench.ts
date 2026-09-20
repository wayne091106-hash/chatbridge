/**
 * "Serious coding" workbench: a fullscreen card that works like a coding app (conversation with the agent,
 * changes, branch, commit/push, agent/model/access settings). These tools feed it; the conversation itself
 * uses the agent_* tools.
 */
import { existsSync } from "node:fs";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import type { DefineTool } from "../bridge/tools.js";
import { AGENT_PANEL_URI, cardResult } from "../bridge/widgets.js";
import { AGENTS, agentIds } from "./agents.js";
import { commitAll, fileDiff, projectInfo, push, switchBranch } from "./project.js";
import { hubFor, pickAgent, snapshot } from "./tools.js";

export function registerWorkbench(define: DefineTool, rt: Runtime) {
  const hub = hubFor(rt);

  const agentRows = () => {
    const health = hub.health();
    return agentIds().map((id) => ({
      id,
      label: AGENTS[id].label,
      offered: !AGENTS[id].hidden,
      installed: !!AGENTS[id].resolve(),
      ok: health[id]?.ok ?? null,
      model: hub.modelFor(id) ?? "",
      models: [...new Set([hub.modelFor(id) ?? "", ...(AGENTS[id].suggestedModels ?? [])].filter(Boolean))],
    }));
  };

  const threadsIn = (cwd: string) => {
    const seen = new Set<string>();
    const out: Array<{ id: string; agent: string; status: string; task: string; startedAt: number }> = [];
    for (const j of hub.list()) {
      const t = j.thread ?? j.id;
      if (seen.has(t) || j.cwd.toLowerCase() !== cwd.toLowerCase()) continue;
      seen.add(t);
      const first = hub.threadRuns(t)[0] ?? j;
      out.push({ id: j.id, agent: AGENTS[j.agent].label, status: j.status, task: first.task.slice(0, 140), startedAt: first.startedAt });
      if (out.length >= 20) break;
    }
    return out;
  };

  define(
    "workbench_open",
    {
      title: "Open the coding workbench",
      description:
        "Serious coding mode: opens a fullscreen workbench for a project folder where the user works with the coding agents like in a coding app — conversation with the agent, live activity, changed files with diffs, undo, branch, commit/push, agent/model/access settings and past conversations. Use when the user wants to focus on coding (\"認真寫程式\", \"開工作台\"). Pass job_id to reopen an existing agent conversation.",
      input: { cwd: z.string().optional().describe("Project folder (default: current working directory)"), job_id: z.string().optional() },
      effect: "read",
      meta: {
        ui: { resourceUri: AGENT_PANEL_URI },
        "openai/outputTemplate": AGENT_PANEL_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "開啟工作台…",
        "openai/toolInvocation/invoked": "工作台已開啟",
      },
    },
    async (a) => {
      const job = a.job_id ? hub.latest(a.job_id) : null;
      const cwd = job?.cwd ?? (a.cwd ? rt.files.resolve(a.cwd) : rt.cwd.value);
      if (!existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);
      let preferred = "";
      try {
        preferred = pickAgent(hub);
      } catch {
        /* none working */
      }
      const data = {
        mode: "workbench",
        cwd,
        project: await projectInfo(rt, cwd),
        agents: agentRows(),
        preferred,
        threads: threadsIn(cwd),
        ...(job ? snapshot(hub, job.id) : { job: null, events: [] }),
      };
      return cardResult({ mode: "workbench", cwd }, data, [
        { type: "text", text: `Workbench opened for ${cwd}${job ? ` (conversation ${job.thread ?? job.id})` : ""}. The user works in the card; you can follow along with agent_status.` },
      ]);
    },
  );

  define(
    "workbench_state",
    {
      title: "Workbench project state (for cards)",
      description: "Internal: git branch, uncommitted changes, agents and past conversations of a project folder.",
      input: { cwd: z.string() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const cwd = rt.files.resolve(a.cwd);
      return cardResult({ cwd }, { project: await projectInfo(rt, cwd), agents: agentRows(), threads: threadsIn(cwd) }, [{ type: "text", text: "ok" }]);
    },
  );

  define(
    "workbench_diff",
    {
      title: "Working-tree diff of one file (for cards)",
      description: "Internal: diff of one uncommitted file in a project against HEAD.",
      input: { cwd: z.string(), path: z.string() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => cardResult({ path: a.path }, { diff: await fileDiff(rt, rt.files.resolve(a.cwd), a.path) }, [{ type: "text", text: a.path }]),
  );

  define(
    "workbench_git",
    {
      title: "Commit, push or switch branch",
      description: "Git actions for a project folder: commit (all changes, with a message), push (current branch to origin), switch (to an existing branch) or create_branch. Only when the user asks for it.",
      input: {
        cwd: z.string(),
        action: z.enum(["commit", "push", "switch", "create_branch"]),
        message: z.string().optional().describe("Commit message (commit)"),
        branch: z.string().optional().describe("Branch name (switch / create_branch)"),
      },
      effect: "write",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const cwd = rt.files.resolve(a.cwd);
      let result: string;
      if (a.action === "commit") {
        if (!a.message?.trim()) throw new Error("a commit message is needed");
        result = await commitAll(rt, cwd, a.message.trim());
      } else if (a.action === "push") result = await push(rt, cwd);
      else {
        if (!a.branch?.trim()) throw new Error("a branch name is needed");
        result = await switchBranch(rt, cwd, a.branch.trim(), a.action === "create_branch");
      }
      return cardResult({ ok: true, result }, { project: await projectInfo(rt, cwd) }, [{ type: "text", text: result }]);
    },
  );
}
