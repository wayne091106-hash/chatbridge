import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import type { DefineTool } from "../bridge/tools.js";
import { AGENT_PANEL_URI, cardResult } from "../bridge/widgets.js";
import { truncateMiddle } from "../core/util.js";
import { AGENTS, agentIds, offeredAgentIds, type AgentId } from "./agents.js";
import { HubJobs, type HubJob } from "./jobs.js";
import { diffStats, revertChanges } from "./project.js";

// One job manager per runtime (HTTP mode builds a fresh McpServer per request).
const hubs = new WeakMap<Runtime, HubJobs>();
export function hubFor(rt: Runtime): HubJobs {
  let h = hubs.get(rt);
  if (!h) {
    h = new HubJobs(rt);
    hubs.set(rt, h);
  }
  return h;
}

const AgentEnum = z.enum(agentIds() as [AgentId, ...AgentId[]]);

/** The first agent in the owner's order that is installed and not known to be broken. */
export function pickAgent(hub: HubJobs): AgentId {
  const health = hub.health();
  const ok = offeredAgentIds().find((id) => AGENTS[id].resolve() && health[id]?.ok !== false);
  if (!ok) throw new Error("no working coding agent found (see agents_list)");
  return ok;
}

/**
 * A conversation as the cards show it: every run's events in order, with the user's follow-up
 * instructions in between, and the latest run's status, result and (cumulative) changed files.
 */
export function snapshot(hub: HubJobs, id: string, since = 0) {
  const last = hub.latest(id);
  const runs = hub.threadRuns(last.thread ?? last.id);
  const first = runs[0] ?? last;
  const events = runs.flatMap((r, i) => [
    ...(i > 0 && r.followUp ? [{ kind: "user", text: r.followUp }] : []),
    ...r.events.map((e) => ({ kind: e.kind as string, text: e.text })),
  ]);
  return {
    job: {
      id: last.id,
      thread: last.thread ?? last.id,
      agent: last.agent,
      agentLabel: AGENTS[last.agent].label,
      task: first.task,
      cwd: last.cwd,
      model: last.model ?? null,
      access: last.access,
      status: last.status,
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      final: last.status === "running" ? "" : truncateMiddle(last.final, 12_000),
      note: last.note ?? null,
      queued: last.queued ?? [],
      resumable: !!last.agentSession || !!AGENTS[last.agent].resumeArgs,
      runs: runs.map((r) => ({ id: r.id, status: r.status })),
      changed: last.changed.map((c) => ({ path: c.path, status: c.status, ...diffStats(c.diff) })),
    },
    events: events.slice(since).map((e) => ({ kind: e.kind, text: truncateMiddle(e.text, 2000) })),
  };
}

const light = (j: HubJob) => ({ job: { id: j.id, thread: j.thread ?? j.id, status: j.status } });

export function registerHub(_server: McpServer, define: DefineTool, rt: Runtime) {
  const hub = hubFor(rt);

  define(
    "agents_list",
    {
      title: "List coding agents",
      description:
        "Coding agents on this PC in the owner's order of preference (Kilo Code first, then Cline, then Codex, then Claude Code) with their default model, suggested models and last health check. OpenCode and Gemini CLI are kept installed but not offered.",
      input: {},
      effect: "read",
      meta: { "openai/widgetAccessible": true },
    },
    async () => {
      const health = hub.health();
      const rows = agentIds().map((id) => {
        const d = AGENTS[id];
        const h = health[id];
        return {
          agent: id,
          name: d.label,
          offered: !d.hidden,
          installed: !!d.resolve(),
          model: hub.modelFor(id) ?? "(agent default)",
          suggestedModels: d.suggestedModels ?? [],
          health: h ? `${h.ok ? "OK" : "NOT WORKING"} (${h.detail.split("\n")[0]}; checked ${h.checkedAt.slice(0, 16)})` : "not checked yet (agents_check)",
          ok: h?.ok ?? null,
          strengths: d.strengths,
        };
      });
      let preferred: string | null = null;
      try {
        preferred = pickAgent(hub);
      } catch {
        /* none */
      }
      return cardResult({ preferred }, { agents: rows }, [{ type: "text", text: JSON.stringify({ preferred, agents: rows, running: hub.running().map((j) => j.id) }, null, 2) }]);
    },
  );

  define(
    "agents_check",
    {
      title: "Check coding agents",
      description: "Health-check agents by sending each a tiny prompt (read-only). One agent takes up to ~2 minutes; with agent=all the checks run in the background — read the results with agents_list afterwards.",
      input: { agent: z.union([AgentEnum, z.literal("all")]).optional() },
      effect: "execute",
    },
    async (a) => {
      if (!a.agent || a.agent === "all") {
        const ids = agentIds().filter((id) => AGENTS[id].resolve());
        // Checks are tiny read-only prompts, so they run side by side.
        void Promise.all(ids.map((id) => hub.check(id).catch(() => {})));
        return `checking ${ids.join(", ")} in the background (≈ 1–2 minutes). Call agents_list later for results.`;
      }
      const h = await hub.check(a.agent, 100);
      return `${AGENTS[a.agent].label}: ${h.ok ? "OK" : "NOT WORKING"} in ${h.seconds}s — ${h.detail}`;
    },
  );

  define(
    "agent_run",
    {
      title: "Hand a task to a coding agent",
      description:
        "Start a coding agent on this PC as a background worker for a whole task (e.g. 'implement X and run the tests'). Leave `agent` out to use the owner's preferred agent (Kilo Code, then Cline, then Codex). Returns immediately with a live progress card. The run starts a conversation: steer it later with agent_message (queued or interrupting), pause with agent_pause, continue with agent_resume. Write the task self-contained: goal, relevant paths, constraints, how to verify, what to report. access: read (no edits), workspace (default: edits in cwd and commands), full (no restrictions).",
      input: {
        agent: AgentEnum.optional(),
        task: z.string().min(5),
        cwd: z.string().optional().describe("Project folder (default: current working directory)"),
        access: z.enum(["read", "workspace", "full"]).optional(),
        model: z.string().optional().describe("Override the agent's model (see agents_list for suggestions)"),
        timeout_minutes: z.number().int().min(1).max(600).optional(),
      },
      effect: "execute",
      openWorld: true,
      meta: {
        ui: { resourceUri: AGENT_PANEL_URI },
        "openai/outputTemplate": AGENT_PANEL_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "啟動 agent…",
        "openai/toolInvocation/invoked": "agent 已開始工作",
      },
    },
    async (a) => {
      const cwd = a.cwd ? rt.files.resolve(a.cwd) : rt.cwd.value;
      const agent = a.agent ?? pickAgent(hub);
      const job = await hub.start({ agent, task: a.task, cwd, access: a.access ?? "workspace", model: a.model, timeoutMinutes: a.timeout_minutes });
      return cardResult(light(job), snapshot(hub, job.id), [
        { type: "text", text: `${job.status === "failed" ? "could not start" : "started"} job ${job.id} (${AGENTS[job.agent].label}${job.model ? `, ${job.model}` : ""}) in ${cwd}. ${job.status === "failed" ? job.final : "A live progress card is shown to the user. Check progress with agent_status (use wait_seconds to wait), steer with agent_message, then review with agent_result."}` },
      ]);
    },
  );

  define(
    "agent_status",
    {
      title: "Agent conversation status",
      description: "Progress of an agent conversation (any job id of it): status of the latest run, activity, queued instructions and (when finished) the result. wait_seconds waits up to that long for the run to finish.",
      input: { job_id: z.string(), wait_seconds: z.number().min(0).max(45).optional(), since: z.number().int().min(0).optional().describe("Only return events after this index (used by the cards)") },
      effect: "read",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const deadline = Date.now() + (a.wait_seconds ?? 0) * 1000;
      let j = hub.latest(a.job_id);
      while (j.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        j = hub.latest(a.job_id);
      }
      // The cards poll with `since`; their snapshots stay out of the conversation (card-only _meta).
      return cardResult(light(j), snapshot(hub, j.id, a.since ?? 0), [{ type: "text", text: a.since !== undefined ? j.status : hub.summarize(j) }]);
    },
  );

  define(
    "agent_message",
    {
      title: "Send an instruction to a working agent",
      description:
        "Steer an agent conversation (any job id of it) in plain language: add a requirement, correct its direction, answer its question. If the agent is busy the message is queued and sent as soon as its current step finishes; interrupt=true stops the current step and continues right away with this message. If the agent is idle, paused or finished, it continues the same conversation (same agent session, full context).",
      input: { job_id: z.string(), message: z.string().min(1), interrupt: z.boolean().optional() },
      effect: "execute",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const r = await hub.message(a.job_id, a.message, a.interrupt ?? false);
      const text = r.delivered === "queued" ? `queued for ${AGENTS[r.job.agent].label}: it will get the message when its current step finishes (job ${r.job.id}).` : `sent; ${AGENTS[r.job.agent].label} continues the conversation as job ${r.job.id}.`;
      return cardResult({ ...light(r.job), delivered: r.delivered }, snapshot(hub, r.job.id), [{ type: "text", text }]);
    },
  );

  define(
    "agent_pause",
    {
      title: "Pause an agent",
      description: "Stop the agent's current step but keep the conversation, so it can continue later with agent_resume or agent_message.",
      input: { job_id: z.string() },
      effect: "execute",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const j = await hub.cancel(a.job_id, true);
      return cardResult(light(j), snapshot(hub, j.id), [{ type: "text", text: `job ${j.id}: ${j.status}` }]);
    },
  );

  define(
    "agent_resume",
    {
      title: "Resume a paused agent",
      description: "Continue a paused (or finished) agent conversation, optionally with a new instruction.",
      input: { job_id: z.string(), message: z.string().optional() },
      effect: "execute",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const r = await hub.message(a.job_id, a.message || "Continue the task from where you stopped. First check the current state of the files, then carry on and report when done.");
      return cardResult(light(r.job), snapshot(hub, r.job.id), [{ type: "text", text: `resumed as job ${r.job.id}` }]);
    },
  );

  define(
    "agent_cancel",
    {
      title: "Stop agent",
      description: "Stop an agent conversation for good (queued instructions are dropped). Use agent_pause to keep it resumable.",
      input: { job_id: z.string() },
      effect: "execute",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const j = await hub.cancel(a.job_id);
      return cardResult(light(j), snapshot(hub, j.id), [{ type: "text", text: `job ${j.id}: ${j.status}` }]);
    },
  );

  define(
    "agent_result",
    {
      title: "Agent result",
      description: "Full result of an agent conversation: final report, every changed file and the diffs (truncated when very large). Review this before telling the user the work is done.",
      input: { job_id: z.string(), max_diff_chars: z.number().int().min(1000).max(200_000).optional() },
      effect: "read",
    },
    async (a) => {
      const j = hub.latest(a.job_id);
      const budget = a.max_diff_chars ?? 40_000;
      let used = 0;
      const diffs: string[] = [];
      for (const c of j.changed) {
        if (!c.diff) continue;
        const piece = `===== ${c.status} ${c.path}\n${c.diff}`;
        if (used + piece.length > budget) {
          diffs.push(`… ${j.changed.length - diffs.length} more file(s) not shown; use agent_diff for a specific file`);
          break;
        }
        diffs.push(piece);
        used += piece.length;
      }
      return `${hub.summarize(j, 30)}${diffs.length ? `\n\ndiffs:\n${diffs.join("\n\n")}` : ""}\n\nfull log: ${j.logFile}`;
    },
  );

  define(
    "agent_diff",
    {
      title: "Diff of one changed file",
      description: "The diff of one file changed by an agent conversation.",
      input: { job_id: z.string(), path: z.string(), card: z.boolean().optional().describe("Set by the cards: the diff goes to the card only") },
      effect: "read",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const j = hub.latest(a.job_id);
      const c = j.changed.find((x) => x.path === a.path || x.path.endsWith(a.path));
      if (!c) return { structuredContent: { error: "file not in this job's changes" }, content: [{ type: "text", text: `${a.path} was not changed by ${a.job_id}` }] };
      return cardResult({ path: c.path, status: c.status }, { diff: c.diff ?? "" }, [{ type: "text", text: a.card ? `${c.status} ${c.path}` : `${c.status} ${c.path}\n${c.diff ?? ""}` }]);
    },
  );

  define(
    "agent_revert",
    {
      title: "Undo an agent's changes",
      description: "Undo every file change of an agent conversation: modified files are restored from the commit the conversation started at, files it created are moved to ChatBridge's trash folder. Only for git projects and finished/paused conversations. Only when the user asks for it.",
      input: { job_id: z.string() },
      effect: "write",
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const j = hub.latest(a.job_id);
      if (j.status === "running") throw new Error("pause or stop the agent first");
      if (!j.gitRepo) throw new Error("undo needs a git project (use fs_checkpoints for other folders)");
      const done = await revertChanges(rt, j.cwd, j.baseCommit, j.changed);
      j.note = `${j.note ? j.note + "; " : ""}changes undone by the user`;
      j.changed = [];
      return done.length ? done.join("\n") : "nothing to undo";
    },
  );

  define(
    "agent_jobs",
    { title: "Recent agent conversations", description: "List recent agent conversations with their status.", input: { limit: z.number().int().min(1).max(50).optional() }, effect: "read", meta: { "openai/widgetAccessible": true } },
    async (a) => {
      const threads = new Map<string, HubJob>();
      for (const j of hub.list()) if (!threads.has(j.thread ?? j.id)) threads.set(j.thread ?? j.id, j);
      const rows = [...threads.values()].slice(0, a.limit ?? 15);
      return cardResult(
        {},
        { threads: rows.map((j) => ({ id: j.id, thread: j.thread ?? j.id, agent: AGENTS[j.agent].label, status: j.status, cwd: j.cwd, task: hub.threadRuns(j.thread ?? j.id)[0]?.task.slice(0, 120) ?? j.task.slice(0, 120), startedAt: j.startedAt })) },
        [{ type: "text", text: rows.map((j) => `${j.id}  ${j.status.padEnd(9)} ${AGENTS[j.agent].label.padEnd(14)} ${new Date(j.startedAt).toLocaleString()}  ${j.task.replace(/\s+/g, " ").slice(0, 80)}`).join("\n") || "no agent jobs yet" }],
      );
    },
  );

  define(
    "agents_configure",
    {
      title: "Set an agent's default model",
      description: "Change the default model an agent uses (e.g. kilo → google-vertex/gemini-3.8-flash). Empty model resets to the built-in default.",
      input: { agent: AgentEnum, model: z.string().optional() },
      effect: "write",
      destructive: false,
      meta: { "openai/widgetAccessible": true },
    },
    async (a) => {
      const cfg = hub.config();
      if (a.model) cfg.models[a.agent] = a.model;
      else delete cfg.models[a.agent];
      hub.saveConfig(cfg);
      return `${AGENTS[a.agent].label} default model: ${hub.modelFor(a.agent) ?? "(agent default)"}`;
    },
  );
}
