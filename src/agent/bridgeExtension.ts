import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { DefineTool } from "../bridge/tools.js";
import type { Runtime } from "../core/runtime.js";
import { KestrelService } from "./service.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import { truncateMiddle } from "../core/util.js";

/**
 * Exposes Kestrel to ChatGPT / Claude web chat through the bridge ("dual brain"): the chat model
 * can hand long autonomous jobs to the local agent, and share its long-term memory and skills.
 */
export async function kestrelBridgeExtension(shared?: KestrelService) {
  let service: KestrelService | null = shared ?? null;
  let creating: Promise<KestrelService> | null = null;
  const get = async (rt: Runtime) => {
    if (service) return service;
    creating ??= KestrelService.create({ runtime: rt }).then((s) => (service = s));
    return creating;
  };

  return (_server: McpServer, define: DefineTool, rt: Runtime) => {
    define(
      "kestrel_task_start",
      {
        title: "Start Kestrel task",
        description:
          "Hand a task to Kestrel, the autonomous agent living on this PC (own model, memory, skills, sub-agents). Use for long or multi-step work that should keep running without you (builds, research, refactors, monitoring). Returns a task id; poll kestrel_task_status.",
        input: {
          task: z.string().min(5).describe("Complete instructions with goal, context, constraints and what to report"),
          session_id: z.string().optional().describe("Continue an existing Kestrel session"),
        },
        effect: "execute",
        openWorld: true,
      },
      async (a) => {
        const s = await get(rt);
        const t = s.startTask(a.task, { sessionId: a.session_id, source: "mcp" });
        return `started ${t.id}. Poll with kestrel_task_status (Kestrel model: ${s.provider.name}/${s.provider.model}).`;
      },
    );

    define(
      "kestrel_task_status",
      {
        title: "Kestrel task status",
        description: "Progress log and result of a Kestrel task. wait_seconds waits for completion (max 100).",
        input: { task_id: z.string(), wait_seconds: z.number().min(0).max(100).optional(), last_events: z.number().int().min(0).max(100).optional() },
        effect: "read",
      },
      async (a) => {
        const s = await get(rt);
        const deadline = Date.now() + (a.wait_seconds ?? 0) * 1000;
        let t = s.getTask(a.task_id);
        if (!t) return { isError: true, content: [{ type: "text", text: `unknown task ${a.task_id}` }] };
        while (t.status === "running" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          t = s.getTask(a.task_id)!;
        }
        const events = t.events.slice(-(a.last_events ?? 15)).map((e) => `${e.ts.slice(11, 19)} ${e.kind}: ${e.text}`);
        return [
          `task ${t.id}: ${t.status} (session ${t.sessionId ?? "-"}, started ${t.startedAt}${t.endedAt ? `, ended ${t.endedAt}` : ""})`,
          events.length ? `\nrecent activity:\n${events.join("\n")}` : "",
          t.result !== null ? `\nresult:\n${truncateMiddle(t.result, 20_000)}` : "",
        ].join("\n");
      },
    );

    define(
      "kestrel_task_cancel",
      { title: "Cancel Kestrel task", description: "Stop a running Kestrel task.", input: { task_id: z.string() }, effect: "execute" },
      async (a) => ((await get(rt)).cancelTask(a.task_id) ? `cancelling ${a.task_id}` : `unknown task ${a.task_id}`),
    );

    define(
      "kestrel_memory",
      {
        title: "Kestrel memory",
        description: "Search, save or forget long-term memories shared with the local agent (owner preferences, project facts, lessons).",
        input: {
          action: z.enum(["search", "save", "forget", "profile"]),
          query: z.string().optional(),
          content: z.string().optional(),
          kind: z.enum(["fact", "preference", "project", "lesson", "person", "environment"]).optional(),
          importance: z.number().min(0).max(1).optional(),
          id: z.number().int().optional(),
        },
        effect: "write",
        destructive: false,
      },
      async (a) => {
        const s = await get(rt);
        switch (a.action) {
          case "search": {
            const r = a.query ? s.store.searchMemories(a.query, 15, { touch: true }) : s.store.listMemories({ limit: 30 });
            return r.length ? r.map((m) => `#${m.id} [${m.kind}] ${m.content}`).join("\n") : "no memories";
          }
          case "save": {
            if (!a.content) throw new Error("content is required");
            const dup = s.store.findSimilarMemory(a.content, 0.75);
            if (dup) return `updated #${s.store.updateMemory(dup.id, { content: a.content }).id}`;
            return `saved #${s.store.addMemory({ content: a.content, kind: a.kind, importance: a.importance, source: "mcp" }).id}`;
          }
          case "forget":
            if (a.id === undefined) throw new Error("id is required");
            return s.store.archiveMemory(a.id) ? `archived #${a.id}` : "not found";
          case "profile":
            return JSON.stringify(s.store.getProfile(), null, 2);
        }
      },
    );

    define(
      "kestrel_skills",
      {
        title: "Kestrel skills",
        description: "List/search, read, or save reusable procedures (skills) in the local agent's library.",
        input: { action: z.enum(["list", "get", "save"]), query: z.string().optional(), name: z.string().optional(), description: z.string().optional(), body: z.string().optional(), tags: z.array(z.string()).optional() },
        effect: "write",
        destructive: false,
      },
      async (a) => {
        const s = await get(rt);
        if (a.action === "list") {
          const list = a.query ? s.skills.search(a.query, 30) : s.skills.list();
          return list.length ? list.map((k) => `- ${k.name} (v${k.version}): ${k.description}`).join("\n") : "no skills";
        }
        if (!a.name) throw new Error("name is required");
        if (a.action === "get") {
          const k = s.skills.get(a.name);
          return k ? `# ${k.name}\n${k.description}\n\n${k.body}` : `skill ${a.name} not found`;
        }
        if (!a.description || !a.body) throw new Error("description and body are required");
        const k = s.skills.save({ name: a.name, description: a.description, body: a.body, tags: a.tags, origin: "user" });
        return `saved ${k.name} v${k.version}`;
      },
    );

    define(
      "kestrel_schedule",
      {
        title: "Kestrel schedule",
        description: "List, create or delete scheduled autonomous tasks run by Kestrel's daemon. schedule accepts cron, 'every 30m', 'daily 09:30', 'in 20m', 'at 2026-09-20 09:00'.",
        input: { action: z.enum(["list", "create", "delete"]), name: z.string().optional(), schedule: z.string().optional(), prompt: z.string().optional(), id: z.string().optional() },
        effect: "write",
      },
      async (a) => {
        const s = await get(rt);
        if (a.action === "list") {
          const jobs = s.store.listJobs();
          return jobs.length ? jobs.map((j) => `${j.id} ${j.enabled ? "on " : "off"} "${j.name}" ${describeSchedule(j.schedule)} next=${j.nextRunAt ?? "-"} last=${j.lastStatus ?? "-"}`).join("\n") : "no jobs";
        }
        if (a.action === "delete") return a.id && s.store.deleteJob(a.id) ? `deleted ${a.id}` : "not found";
        if (!a.name || !a.schedule || !a.prompt) throw new Error("name, schedule and prompt are required");
        const schedule = normalizeSchedule(a.schedule);
        const next = nextRun(schedule, new Date());
        const job = s.store.addJob({ name: a.name, schedule, prompt: a.prompt, deliver: "both", nextRunAt: next?.toISOString() ?? null });
        return `created ${job.id}: ${describeSchedule(schedule)}, next ${next?.toLocaleString() ?? "never"} (runs while \`kestrel daemon\` is running)`;
      },
    );

    define(
      "kestrel_inbox",
      { title: "Kestrel inbox", description: "Read notifications and scheduled-task reports from Kestrel.", input: { unread_only: z.boolean().optional(), mark_read: z.boolean().optional() }, effect: "read" },
      async (a) => {
        const s = await get(rt);
        const items = s.store.listInbox(a.unread_only ?? true, 30);
        if (a.mark_read) s.store.markInboxRead();
        return items.length ? items.map((i: any) => `#${i.id} ${i.created_at.slice(0, 16)} ${i.title}\n${truncateMiddle(i.body, 2000)}`).join("\n\n") : "inbox empty";
      },
    );
  };
}
