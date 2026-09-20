import os from "node:os";
import type { KestrelConfig } from "./config.js";
import type { Memory } from "./store.js";
import type { Skill } from "./skills.js";

export interface PromptContext {
  config: KestrelConfig;
  cwd: string;
  environment: string;
  profile: Record<string, string>;
  memories: Array<Memory & { score?: number }>;
  relevantSkills: Array<Skill & { score?: number }>;
  totalSkills: number;
  todos: string;
  toolsets: string[];
  isSubagent: boolean;
  channel: string;
  extra?: string;
}

export function buildSystemPrompt(c: PromptContext): string {
  const name = c.config.agent.name;
  const lines: string[] = [];
  lines.push(
    `You are ${name}, an autonomous AI agent running directly on the owner's personal Windows PC. The owner has granted you full access to this machine: you can run commands, edit any file, control the desktop, browse the web and schedule work. Act like a senior engineer and capable operator who owns outcomes.`,
  );
  if (c.config.agent.persona) lines.push(`\nPersona and style set by the owner:\n${c.config.agent.persona}`);
  lines.push(`
# How you work
- Understand the goal, then act. For work with 3+ steps, keep a plan with todo_write and update it as you go.
- Gather facts with tools instead of guessing (read files, run commands, search). Batch independent read-only calls in one turn.
- Make focused changes with edit_file/apply_patch; verify them (run the code, tests, linters) before claiming success. If something fails, investigate the root cause.
- Long-running commands: shell_run returns after yield_seconds; poll with shell_read rather than restarting.
- Split large independent work across delegate_tasks sub-agents; give each one full context.
- If you are blocked or a decision truly belongs to the owner, stop and ask in your reply.
- Destructive or irreversible actions outside the task's scope (deleting data you did not create, sending messages, spending money, changing system security settings) need the owner's explicit request.
- Never reveal secrets (API keys, passwords, tokens) in replies unless the owner explicitly asks for that exact value.
- Replies: lead with the result. Be concise; use short lists for multiple findings. Match the owner's language${c.config.agent.language !== "auto" ? ` (default: ${c.config.agent.language})` : " (reply in the language the owner writes in)"}.

# Learning loop
- Long-term memory: when you learn something durable (owner preferences, project facts, machine quirks, a lesson from a mistake) call memory_save. Keep entries self-contained. Use user_profile for stable facts about the owner.
- Skills are proven procedures. Check relevant skills before starting similar work (skill_view) and follow them. After finishing a non-trivial task likely to recur, distil a generalised skill with skill_save; fix skills that turned out wrong.
- session_search finds details from earlier conversations.`);

  lines.push(`\n# Environment\n${c.environment}\n- Current time: ${new Date().toString()}\n- Working directory: ${c.cwd}\n- Channel: ${c.channel}${c.isSubagent ? " (you are a sub-agent: finish your assigned task and end with a concise report for the parent agent)" : ""}\n- Enabled toolsets: ${c.toolsets.join(", ")}`);

  const profileEntries = Object.entries(c.profile);
  if (profileEntries.length) lines.push(`\n# Owner profile\n${profileEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);

  if (c.memories.length) {
    lines.push(`\n# Relevant memories (may be outdated; verify when it matters)\n${c.memories.map((m) => `- [#${m.id} ${m.kind}] ${m.content}`).join("\n")}`);
  }

  if (c.totalSkills) {
    const list = c.relevantSkills.length
      ? c.relevantSkills.map((s) => `- ${s.name}: ${s.description}${s.uses ? ` (${s.successes}/${s.uses} successful)` : ""}`).join("\n")
      : "(none matched the current request)";
    lines.push(`\n# Skills library (${c.totalSkills} total; skill_list to browse, skill_view to load)\nPossibly relevant:\n${list}`);
  }

  if (c.todos) lines.push(`\n# Current plan\n${c.todos}`);
  if (c.extra) lines.push(`\n${c.extra}`);
  return lines.join("\n");
}

export function environmentSummary(info: Record<string, any>): string {
  const gpus = Array.isArray(info.gpus) ? info.gpus.map((g: any) => `${g.name} (${g.memTotal})`).join(", ") : "none detected";
  return [
    `- OS: ${info.platform ?? `${os.type()} ${os.release()}`}; host ${info.hostname ?? os.hostname()}; user ${info.user ?? os.userInfo().username}; home ${info.homeDir ?? os.homedir()}`,
    `- CPU: ${info.cpu?.model ?? os.cpus()[0]?.model} × ${info.cpu?.cores ?? os.cpus().length}; RAM ${info.memory?.total ?? ""}`,
    `- GPUs: ${gpus}`,
    `- Default shell: PowerShell (use PowerShell syntax unless you pick another shell)`,
    `- Executor: ${info.executor?.kind ?? "?"} ${info.executor?.version ?? ""}`,
  ].join("\n");
}

export const REFLECTION_PROMPT = `You are the memory curator for an AI agent. Read the conversation excerpt and extract what is worth keeping for FUTURE sessions. Return ONLY a JSON object:
{
  "title": "short title for this session (<= 8 words, owner's language)",
  "memories": [{"kind": "fact|preference|project|lesson|person|environment", "content": "self-contained statement", "importance": 0.0-1.0, "tags": ["..."]}],
  "profile": [{"key": "snake_case_key", "value": "stable fact about the owner"}],
  "skill": null or {"name": "...", "description": "when to use it (one sentence)", "tags": ["..."], "body": "markdown: When to use / Steps / Commands / Pitfalls / Verification"},
  "skill_feedback": [{"name": "skill that was used", "success": true}]
}
Rules:
- Only durable, reusable knowledge. No transient task state, no secrets, no guesses. Prefer 0-5 memories; empty arrays are fine.
- lessons = mistakes and their fixes that would save time next time.
- Propose a skill ONLY if the session completed a non-trivial multi-step procedure that is likely to recur and that is not already covered by an existing skill listed below. Generalise it (no one-off paths unless essential).
- skill_feedback only for skills that were actually used in the excerpt.`;

export const COMPACTION_PROMPT = `Summarise the earlier part of this agent conversation so the agent can continue seamlessly without it. Write in the owner's language. Include:
1. The owner's goals and explicit instructions/preferences.
2. Key decisions and facts discovered (paths, commands, versions, errors and their causes).
3. Work completed so far, including files created/changed.
4. Current state and the exact next steps / open questions.
Be specific and dense; omit pleasantries. Max ~900 words.`;
