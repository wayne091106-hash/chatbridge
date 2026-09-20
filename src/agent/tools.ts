import os from "node:os";
import path from "node:path";
import * as z from "zod";
import type { Agent } from "./agent.js";
import type { KestrelService } from "./service.js";
import type { Toolset } from "./config.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import { formatShell } from "../bridge/tools.js";
import { errorMessage, randomId, truncateMiddle } from "../core/util.js";
import type { ToolSpec } from "./providers/types.js";

export interface ToolImage {
  data: string;
  mimeType: string;
}
export type ToolOutput = string | { text: string; images?: ToolImage[] };

export interface ToolRunContext {
  agent: Agent;
  service: KestrelService;
  signal: AbortSignal;
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  toolset: Toolset;
  /** Read-only tools may run in parallel within one assistant turn. */
  readOnly?: boolean;
  run(args: z.infer<S>, ctx: ToolRunContext): Promise<ToolOutput>;
}

function tool<S extends z.ZodObject>(t: AgentTool<S>): AgentTool {
  return t as unknown as AgentTool;
}

export function toolSpec(t: AgentTool): ToolSpec {
  const schema = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, parameters: schema };
}

// ---------------------------------------------------------------------------------------------
// HTML → text for web_fetch

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  let s = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|header|footer|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<a [^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const label = t.replace(/<[^>]+>/g, "").trim();
      return label && !href.startsWith("javascript:") ? `${label} (${href})` : label;
    })
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? "") !== "")
    .join("\n")
    .trim();
  return { title, text: s };
}

// ---------------------------------------------------------------------------------------------

export function builtinTools(): AgentTool[] {
  return [
    // ------------------------------------------------------------------ core: shell
    tool({
      name: "shell_run",
      toolset: "core",
      description:
        "Run a command on the Windows PC (PowerShell by default). Returns output and exit code. Long commands keep running after yield_seconds; continue with shell_read. Use interactive=true to feed stdin later with shell_write.",
      schema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional().describe("Working directory; defaults to the agent working directory"),
        shell: z.enum(["powershell", "pwsh", "cmd", "bash"]).optional(),
        yield_seconds: z.number().min(0).max(600).optional().describe("Default 60"),
        interactive: z.boolean().optional(),
      }),
      async run(a, { service, agent }) {
        return formatShell(
          await service.rt.shells.run({
            command: a.command,
            cwd: a.cwd ? service.rt.files.resolve(a.cwd) : agent.cwd,
            shell: a.shell,
            yieldSeconds: a.yield_seconds ?? 60,
            interactive: a.interactive,
            maxOutputChars: service.config.agent.toolOutputChars,
          }),
        );
      },
    }),
    tool({
      name: "shell_read",
      toolset: "core",
      readOnly: true,
      description: "Read new output of a shell session, waiting up to wait_seconds for more.",
      schema: z.object({ session_id: z.string(), wait_seconds: z.number().min(0).max(600).optional() }),
      async run(a, { service }) {
        return formatShell(await service.rt.shells.read(a.session_id, a.wait_seconds ?? 30, service.config.agent.toolOutputChars));
      },
    }),
    tool({
      name: "shell_write",
      toolset: "core",
      description: "Send input (a newline is appended unless append_newline=false) to an interactive shell session.",
      schema: z.object({ session_id: z.string(), input: z.string(), append_newline: z.boolean().optional(), wait_seconds: z.number().min(0).max(120).optional() }),
      async run(a, { service }) {
        return formatShell(await service.rt.shells.write(a.session_id, a.input + (a.append_newline === false ? "" : "\r\n"), a.wait_seconds ?? 3));
      },
    }),
    tool({
      name: "shell_kill",
      toolset: "core",
      description: "Terminate a shell session.",
      schema: z.object({ session_id: z.string() }),
      async run(a, { service }) {
        return formatShell(await service.rt.shells.kill(a.session_id));
      },
    }),
    // ------------------------------------------------------------------ core: files
    tool({
      name: "read_file",
      toolset: "core",
      readOnly: true,
      description: "Read a text file with line numbers (offset/limit for large files).",
      schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(5000).optional() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.read(agent.resolvePath(a.path), { offset: a.offset, limit: a.limit, maxChars: service.config.agent.toolOutputChars });
        if (r.binary) return r.text;
        return `${r.path} (${r.totalLines} lines)\n${r.text}${r.truncated ? `\n[lines ${r.fromLine}-${r.toLine} of ${r.totalLines}]` : ""}`;
      },
    }),
    tool({
      name: "write_file",
      toolset: "core",
      description: "Create or overwrite a file. Prefer edit_file / apply_patch for changes to existing files.",
      schema: z.object({ path: z.string(), content: z.string() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.write(agent.resolvePath(a.path), a.content);
        agent.noteChangedFile(r.path);
        return `wrote ${r.bytes} bytes to ${r.path}`;
      },
    }),
    tool({
      name: "edit_file",
      toolset: "core",
      description: "Replace an exact, unique string in a file (set replace_all for every occurrence).",
      schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.edit(agent.resolvePath(a.path), a.old_string, a.new_string, a.replace_all);
        agent.noteChangedFile(r.path);
        return `edited ${r.path} (${r.replacements} replacement(s))`;
      },
    }),
    tool({
      name: "apply_patch",
      toolset: "core",
      description: "Apply a Codex-format multi-file patch (*** Begin Patch / *** Update File: / @@ / -old / +new / *** Add File: / *** Delete File: / *** End Patch). Validated before writing.",
      schema: z.object({ patch: z.string() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.patch(a.patch, agent.cwd);
        [...r.added, ...r.updated, ...r.deleted, ...r.moved.map((m) => m.to)].forEach((p) => agent.noteChangedFile(p));
        return ["patch applied", ...r.added.map((p) => `A ${p}`), ...r.updated.map((p) => `M ${p}`), ...r.deleted.map((p) => `D ${p}`), ...r.moved.map((m) => `R ${m.from} -> ${m.to}`)].join("\n");
      },
    }),
    tool({
      name: "list_dir",
      toolset: "core",
      readOnly: true,
      description: "Tree listing of a directory.",
      schema: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(6).optional() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.list(agent.resolvePath(a.path ?? "."), a.depth ?? 2);
        return `${r.path}${r.truncated ? " (truncated)" : ""}\n${r.tree}`;
      },
    }),
    tool({
      name: "search_files",
      toolset: "core",
      readOnly: true,
      description: "Regex search in file contents (ripgrep). files_only lists matching files.",
      schema: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), ignore_case: z.boolean().optional(), files_only: z.boolean().optional() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.search(a.pattern, agent.resolvePath(a.path ?? "."), { glob: a.glob, ignoreCase: a.ignore_case, filesOnly: a.files_only, maxResults: 300 });
        return `${r.matches} result(s)${r.truncated ? " (truncated)" : ""}\n${r.results}`;
      },
    }),
    tool({
      name: "manage_path",
      toolset: "core",
      description: "mkdir, delete, copy or move files/directories.",
      schema: z.object({ action: z.enum(["mkdir", "delete", "copy", "move"]), path: z.string(), destination: z.string().optional() }),
      async run(a, { service, agent }) {
        const r = await service.rt.files.manage(a.action, agent.resolvePath(a.path), a.destination ? agent.resolvePath(a.destination) : undefined);
        return JSON.stringify(r);
      },
    }),
    tool({
      name: "change_directory",
      toolset: "core",
      readOnly: true,
      description: "Set the agent's working directory for relative paths and commands.",
      schema: z.object({ path: z.string() }),
      async run(a, { service, agent }) {
        const abs = agent.resolvePath(a.path);
        const st = await service.rt.executor.stat(abs);
        if (!st?.isDirectory) throw new Error(`not a directory: ${abs}`);
        agent.cwd = abs;
        return `working directory: ${abs}`;
      },
    }),
    tool({
      name: "undo_changes",
      toolset: "core",
      description: "Undo file changes made by this agent: restores every file touched in a checkpoint (default: most recent turn). action=list shows checkpoints.",
      schema: z.object({ action: z.enum(["list", "undo"]).default("undo"), checkpoint_id: z.number().int().optional() }),
      async run(a, { service, agent }) {
        if (a.action === "list") return JSON.stringify(agent.checkpoints.list().slice(-20), null, 1);
        const r = await agent.checkpoints.undo(service.rt.executor, a.checkpoint_id);
        return `restored ${r.restored.length} file(s) from checkpoint ${r.turn} (${r.label}):\n${r.restored.join("\n")}`;
      },
    }),
    tool({
      name: "system_info",
      toolset: "core",
      readOnly: true,
      description: "Hardware and OS info: CPU, RAM, GPUs (utilisation, VRAM), disks.",
      schema: z.object({}),
      async run(_a, { service }) {
        return JSON.stringify(await service.rt.desktop.systemInfo(), null, 1);
      },
    }),
    // ------------------------------------------------------------------ desktop
    tool({
      name: "screenshot",
      toolset: "desktop",
      readOnly: true,
      description: "Capture the screen. Mouse coordinates default to this image's pixel space.",
      schema: z.object({ max_width: z.number().int().min(320).max(2560).optional() }),
      async run(a, { service }) {
        const { png, meta } = await service.rt.desktop.screenshot({ maxWidth: a.max_width ?? 1400 });
        return { text: `screenshot ${meta.outWidth}x${meta.outHeight} (screen ${meta.width}x${meta.height})`, images: [{ data: png.toString("base64"), mimeType: "image/png" }] };
      },
    }),
    tool({
      name: "mouse",
      toolset: "desktop",
      description: "Mouse action at x,y from the last screenshot: move, click, double_click, right_click, middle_click, scroll (amount<0 = down), drag (to_x,to_y).",
      schema: z.object({
        action: z.enum(["move", "click", "double_click", "right_click", "middle_click", "scroll", "drag"]),
        x: z.number().optional(),
        y: z.number().optional(),
        to_x: z.number().optional(),
        to_y: z.number().optional(),
        amount: z.number().optional(),
      }),
      async run(a, { service }) {
        return JSON.stringify(await service.rt.desktop.mouse({ action: a.action, x: a.x, y: a.y, toX: a.to_x, toY: a.to_y, amount: a.amount }));
      },
    }),
    tool({
      name: "keyboard",
      toolset: "desktop",
      description: "Type literal text, or send keys with SendKeys syntax (^c, %{F4}, {ENTER}).",
      schema: z.object({ text: z.string().optional(), keys: z.string().optional() }),
      async run(a, { service }) {
        return JSON.stringify(await service.rt.desktop.keyboard(a));
      },
    }),
    tool({
      name: "windows",
      toolset: "desktop",
      description: "List top-level windows, or focus one by pid/title.",
      schema: z.object({ action: z.enum(["list", "focus"]), pid: z.number().int().optional(), title: z.string().optional() }),
      async run(a, { service }) {
        if (a.action === "list") return JSON.stringify(await service.rt.desktop.windows(), null, 1);
        return JSON.stringify(await service.rt.desktop.focusWindow({ pid: a.pid, title: a.title }));
      },
    }),
    tool({
      name: "clipboard",
      toolset: "desktop",
      description: "Get or set clipboard text.",
      schema: z.object({ action: z.enum(["get", "set"]), text: z.string().optional() }),
      async run(a, { service }) {
        return JSON.stringify(await service.rt.desktop.clipboard(a));
      },
    }),
    // ------------------------------------------------------------------ web
    tool({
      name: "web_fetch",
      toolset: "web",
      readOnly: true,
      description: "Fetch a URL. HTML is converted to readable text with links; JSON/text returned as-is.",
      schema: z.object({ url: z.string().url(), raw: z.boolean().optional(), max_chars: z.number().int().min(500).max(200_000).optional() }),
      async run(a, { signal }) {
        const res = await fetch(a.url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kestrel/1.0", Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
          redirect: "follow",
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        });
        const type = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const max = a.max_chars ?? 40_000;
        if (!a.raw && type.includes("html")) {
          const { title, text } = htmlToText(body);
          return `HTTP ${res.status} ${res.url}\nTitle: ${title}\n\n${truncateMiddle(text, max)}`;
        }
        return `HTTP ${res.status} ${res.url} (${type})\n\n${truncateMiddle(body, max)}`;
      },
    }),
    tool({
      name: "web_search",
      toolset: "web",
      readOnly: true,
      description: "Search the web (DuckDuckGo). Returns titles, URLs and snippets; follow up with web_fetch.",
      schema: z.object({ query: z.string().min(1), max_results: z.number().int().min(1).max(20).optional() }),
      async run(a, { signal }) {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.query)}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        const html = await res.text();
        const results: string[] = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && results.length < (a.max_results ?? 8)) {
          let href = m[1]!;
          const uddg = href.match(/uddg=([^&]+)/);
          if (uddg) href = decodeURIComponent(uddg[1]!);
          const title = htmlToText(m[2]!).text;
          const snippet = m[3] ? htmlToText(m[3]).text : "";
          results.push(`${results.length + 1}. ${title}\n   ${href}\n   ${snippet}`);
        }
        if (!results.length) return `no results parsed (HTTP ${res.status}); try web_fetch on a specific site`;
        return results.join("\n");
      },
    }),
    // ------------------------------------------------------------------ memory
    tool({
      name: "memory_save",
      toolset: "memory",
      description:
        "Save a durable memory that will help in future sessions (user preferences, project facts, environment details, lessons learned). Not for transient task state. Near-duplicates are merged.",
      schema: z.object({
        content: z.string().min(3).describe("Self-contained statement"),
        kind: z.enum(["fact", "preference", "project", "lesson", "person", "environment"]).optional(),
        importance: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
      }),
      async run(a, { service, agent }) {
        const dup = service.store.findSimilarMemory(a.content, 0.75);
        if (dup) {
          const m = service.store.updateMemory(dup.id, { content: a.content, importance: Math.max(dup.importance, a.importance ?? 0.5), tags: a.tags?.join(",") ?? dup.tags });
          return `updated memory #${m.id}`;
        }
        const m = service.store.addMemory({ ...a, source: `session:${agent.sessionId}` });
        return `saved memory #${m.id}`;
      },
    }),
    tool({
      name: "memory_search",
      toolset: "memory",
      readOnly: true,
      description: "Search long-term memory.",
      schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
      async run(a, { service }) {
        const r = service.store.searchMemories(a.query, a.limit ?? 10, { touch: true });
        return r.length ? r.map((m) => `#${m.id} [${m.kind}, importance ${m.importance.toFixed(2)}] ${m.content}`).join("\n") : "no matching memories";
      },
    }),
    tool({
      name: "memory_forget",
      toolset: "memory",
      description: "Archive a memory that is wrong or obsolete (by id from memory_search).",
      schema: z.object({ id: z.number().int() }),
      async run(a, { service }) {
        return service.store.archiveMemory(a.id) ? `archived memory #${a.id}` : `memory #${a.id} not found`;
      },
    }),
    tool({
      name: "user_profile",
      toolset: "memory",
      description: "Set (or delete with value=null) a stable fact about the user shown in every session, e.g. name, preferred_language, timezone, coding_style.",
      schema: z.object({ key: z.string().min(1).max(60), value: z.string().max(500).nullable() }),
      async run(a, { service }) {
        if (a.value === null) service.store.deleteProfile(a.key);
        else service.store.setProfile(a.key, a.value);
        return `profile ${a.key} ${a.value === null ? "deleted" : "set"}`;
      },
    }),
    tool({
      name: "session_search",
      toolset: "memory",
      readOnly: true,
      description: "Full-text search across past conversations (including other channels like Telegram and scheduled runs).",
      schema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(30).optional() }),
      async run(a, { service }) {
        const r = service.store.searchMessages(a.query, a.limit ?? 10);
        return r.length ? r.map((x) => `[${x.sessionId} · ${x.title || "untitled"} · ${x.createdAt.slice(0, 16)} · ${x.role}] ${x.snippet.replace(/\s+/g, " ")}`).join("\n") : "no matches";
      },
    }),
    // ------------------------------------------------------------------ skills
    tool({
      name: "skill_list",
      toolset: "skills",
      readOnly: true,
      description: "List skills (reusable procedures), optionally filtered by a query.",
      schema: z.object({ query: z.string().optional() }),
      async run(a, { service }) {
        const list = a.query ? service.skills.search(a.query, 20) : service.skills.list();
        if (!list.length) return "no skills";
        return list.map((s) => `- ${s.name} (v${s.version}, ${s.uses ? `${s.successes}/${s.uses} successful` : "unused"}): ${s.description}`).join("\n");
      },
    }),
    tool({
      name: "skill_view",
      toolset: "skills",
      readOnly: true,
      description: "Load the full instructions of a skill before following it.",
      schema: z.object({ name: z.string() }),
      async run(a, { service, agent }) {
        const s = service.skills.get(a.name) ?? service.skills.search(a.name, 1)[0] ?? null;
        if (!s) return `skill "${a.name}" not found`;
        agent.noteSkillUsed(s.slug);
        return `# ${s.name} (v${s.version})\n${s.description}\n\n${s.body}`;
      },
    }),
    tool({
      name: "skill_save",
      toolset: "skills",
      description:
        "Create or improve a skill: a reusable, generalised procedure (when to use, steps, commands, pitfalls, verification). Save one after completing a non-trivial task that is likely to recur, or when an existing skill proved wrong.",
      schema: z.object({ name: z.string().min(3).max(80), description: z.string().min(10).max(300), body: z.string().min(40), tags: z.array(z.string()).optional() }),
      async run(a, { service }) {
        const s = service.skills.save({ ...a, origin: "learned" });
        return `saved skill "${s.name}" v${s.version} at ${s.dir}`;
      },
    }),
    // ------------------------------------------------------------------ planning
    tool({
      name: "todo_write",
      toolset: "planning",
      description: "Maintain the task plan for multi-step work. Send the full list each time; exactly one item should be in_progress while working.",
      schema: z.object({ todos: z.array(z.object({ content: z.string().min(1), status: z.enum(["pending", "in_progress", "done", "cancelled"]) })).max(50) }),
      async run(a, { agent }) {
        agent.todos = a.todos;
        return agent.renderTodos();
      },
    }),
    tool({
      name: "notify_user",
      toolset: "planning",
      description: "Send a notification to the owner's inbox (and Telegram if configured). Use for results of long/background/scheduled work.",
      schema: z.object({ title: z.string().min(1).max(200), message: z.string().min(1).max(8000) }),
      async run(a, { service, agent }) {
        await service.notify(a.title, a.message, `session:${agent.sessionId}`);
        return "notification sent";
      },
    }),
    // ------------------------------------------------------------------ delegation
    tool({
      name: "delegate_tasks",
      toolset: "delegation",
      description:
        "Run independent sub-tasks in parallel with isolated sub-agents (own context, same machine). Give each task complete context: goal, relevant paths, constraints and what to report back. Returns each sub-agent's final report.",
      schema: z.object({
        tasks: z.array(z.object({ goal: z.string().min(10), context: z.string().optional(), toolsets: z.array(z.enum(["core", "desktop", "web", "memory", "skills", "planning", "codex"])).optional() })).min(1).max(8),
      }),
      async run(a, ctx) {
        return ctx.service.runSubagents(ctx.agent, a.tasks, ctx.signal);
      },
    }),
    // ------------------------------------------------------------------ schedule
    tool({
      name: "schedule_task",
      toolset: "schedule",
      description:
        "Schedule an autonomous task. schedule: cron ('0 9 * * 1-5'), 'every 30m', 'daily 09:30', 'weekdays 08:00', 'weekly mon 10:00', 'in 20m', or 'at 2026-09-20 09:00'. The prompt runs as a fresh session; results go to the inbox/Telegram. gpu_idle_below delays the run until GPU utilisation is below that percent.",
      schema: z.object({ name: z.string().min(1), schedule: z.string().min(2), prompt: z.string().min(5), deliver: z.enum(["inbox", "telegram", "both"]).optional(), gpu_idle_below: z.number().min(1).max(100).optional() }),
      async run(a, { service }) {
        const schedule = normalizeSchedule(a.schedule);
        const next = nextRun(schedule, new Date());
        const job = service.store.addJob({ name: a.name, schedule, prompt: a.prompt, deliver: a.deliver ?? "both", conditions: a.gpu_idle_below ? { gpuIdleBelow: a.gpu_idle_below } : {}, nextRunAt: next?.toISOString() ?? null });
        return `scheduled ${job.id} "${job.name}" — ${describeSchedule(schedule)}; next run ${next ? next.toLocaleString() : "never"}${service.schedulerRunning ? "" : " (note: start `kestrel daemon` for jobs to run)"}`;
      },
    }),
    tool({
      name: "schedule_manage",
      toolset: "schedule",
      description: "List scheduled tasks, or pause/resume/delete/run_now one by id.",
      schema: z.object({ action: z.enum(["list", "pause", "resume", "delete", "run_now"]), id: z.string().optional() }),
      async run(a, { service }) {
        if (a.action === "list") {
          const jobs = service.store.listJobs();
          return jobs.length ? jobs.map((j) => `${j.id} ${j.enabled ? "▶" : "⏸"} "${j.name}" ${describeSchedule(j.schedule)} next=${j.nextRunAt ?? "-"} last=${j.lastStatus ?? "-"}`).join("\n") : "no scheduled tasks";
        }
        if (!a.id) throw new Error("id is required");
        const job = service.store.getJob(a.id);
        if (!job) throw new Error(`job ${a.id} not found`);
        if (a.action === "delete") return service.store.deleteJob(a.id) ? `deleted ${a.id}` : "not found";
        if (a.action === "pause") service.store.updateJob(a.id, { enabled: false });
        if (a.action === "resume") service.store.updateJob(a.id, { enabled: true, nextRunAt: nextRun(job.schedule, new Date())?.toISOString() ?? null });
        if (a.action === "run_now") service.store.updateJob(a.id, { enabled: true, nextRunAt: new Date().toISOString() });
        return `${a.action} ${a.id} ok`;
      },
    }),
    // ------------------------------------------------------------------ codex
    tool({
      name: "codex_delegate",
      toolset: "codex",
      description:
        "Hand a well-scoped coding task to the local OpenAI Codex agent (ChatGPT subscription) running in a directory. Good for large mechanical edits or a second opinion. Returns Codex's final report; verify its changes afterwards.",
      schema: z.object({
        task: z.string().min(10),
        cwd: z.string().optional(),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("Default workspace-write"),
        timeout_minutes: z.number().min(1).max(120).optional(),
      }),
      async run(a, { service, agent }) {
        return service.codexDelegate(a.task, a.cwd ? agent.resolvePath(a.cwd) : agent.cwd, a.sandbox ?? "workspace-write", (a.timeout_minutes ?? 30) * 60);
      },
    }),
  ];
}

export function filterTools(tools: AgentTool[], toolsets: readonly string[]): AgentTool[] {
  const allowed = new Set(toolsets);
  return tools.filter((t) => allowed.has(t.toolset));
}

export async function runTool(t: AgentTool, rawArgs: string, ctx: ToolRunContext): Promise<{ ok: boolean; output: ToolOutput }> {
  let parsedJson: unknown;
  try {
    parsedJson = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, output: `Error: arguments are not valid JSON: ${rawArgs.slice(0, 300)}` };
  }
  const parsed = t.schema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, output: `Error: invalid arguments for ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  }
  try {
    return { ok: true, output: await t.run(parsed.data, ctx) };
  } catch (err) {
    return { ok: false, output: `Error: ${errorMessage(err)}` };
  }
}

export const tmpName = (ext: string) => path.join(os.tmpdir(), `${randomId("kestrel-", 6)}.${ext}`);
