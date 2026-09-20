import type { Agent } from "./agent.js";
import type { KestrelService } from "./service.js";
import { errorMessage, sleep, truncateMiddle } from "../core/util.js";

export interface TelegramApi {
  call(method: string, body: Record<string, unknown>): Promise<any>;
}

export function telegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  return {
    async call(method, body) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(method === "getUpdates" ? 70_000 : 30_000),
      });
      const data: any = await res.json();
      if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
      return data.result;
    },
  };
}

/** Split long text on paragraph/line boundaries under Telegram's 4096 char limit. */
export function splitMessage(text: string, limit = 3900): string[] {
  const parts: string[] = [];
  let rest = text.trim() || "(empty)";
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts;
}

const HELP = `Kestrel on your PC.
Just send a task or question.
/new – start a new conversation
/stop – interrupt the current task
/status – model, memory, jobs
/jobs – scheduled tasks
/inbox – unread notifications`;

/**
 * Telegram gateway: chat with Kestrel from the phone, receive scheduled-task reports. Only user IDs
 * listed in telegram.allowedUserIds are served; everyone else is ignored (and logged).
 */
export class TelegramGateway {
  private offset = 0;
  private stopped = false;
  private agents = new Map<number, Agent>();
  private running = new Map<number, AbortController>();

  constructor(
    private readonly s: KestrelService,
    private readonly api: TelegramApi,
    private readonly allowed: Set<number>,
  ) {}

  async notifyOwners(title: string, body: string) {
    for (const id of this.allowed) {
      for (const part of splitMessage(`${title}\n\n${body}`)) await this.api.call("sendMessage", { chat_id: id, text: part, disable_web_page_preview: true });
    }
  }

  stop() {
    this.stopped = true;
    for (const c of this.running.values()) c.abort();
  }

  async run() {
    const log = this.s.rt.logger;
    log.info(`telegram gateway polling (${this.allowed.size} allowed user(s))`);
    while (!this.stopped) {
      try {
        const updates: any[] = await this.api.call("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message"] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          void this.handle(u).catch((err) => log.warn(`telegram update failed: ${errorMessage(err)}`));
        }
      } catch (err) {
        if (this.stopped) break;
        log.warn(`telegram polling error: ${errorMessage(err)}`);
        await sleep(5000);
      }
    }
  }

  async handle(update: any) {
    const msg = update.message;
    if (!msg?.text || !msg.from) return;
    const chatId: number = msg.chat.id;
    const userId: number = msg.from.id;
    if (!this.allowed.has(userId)) {
      this.s.rt.audit.write({ actor: `telegram:${userId}`, action: "telegram.message", outcome: "denied", detail: "user not in allowedUserIds" });
      return;
    }
    const text: string = msg.text.trim();
    const reply = async (t: string) => {
      for (const part of splitMessage(t)) await this.api.call("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
    };

    if (text === "/start" || text === "/help") return reply(HELP);
    if (text === "/new") {
      const old = this.agents.get(chatId);
      if (old && this.s.config.agent.autoReflect) void old.reflect().catch(() => {});
      this.agents.delete(chatId);
      return reply("🆕 New conversation.");
    }
    if (text === "/stop") {
      const c = this.running.get(chatId);
      if (!c) return reply("Nothing is running.");
      c.abort();
      return reply("⏹ Stopping…");
    }
    if (text === "/status") {
      const st = this.s;
      return reply(`Model: ${st.provider.name}/${st.provider.model}\nMemories: ${st.store.countMemories()}\nSkills: ${st.skills.list().length}\nJobs: ${st.store.listJobs().filter((j) => j.enabled).length} active`);
    }
    if (text === "/jobs") {
      const jobs = this.s.store.listJobs();
      return reply(jobs.length ? jobs.map((j) => `${j.enabled ? "▶" : "⏸"} ${j.name} — ${j.schedule}\n   next ${j.nextRunAt ?? "-"}, last ${j.lastStatus ?? "-"}`).join("\n") : "No scheduled tasks.");
    }
    if (text === "/inbox") {
      const items = this.s.store.listInbox(true, 10);
      this.s.store.markInboxRead();
      return reply(items.length ? items.map((i: any) => `• ${i.title}\n${truncateMiddle(i.body, 600)}`).join("\n\n") : "Inbox empty.");
    }
    if (this.running.has(chatId)) return reply("⏳ Still working on the previous task. Send /stop to interrupt.");

    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = this.s.createAgent({ source: "telegram" });
      this.agents.set(chatId, agent);
    }
    const controller = new AbortController();
    this.running.set(chatId, controller);
    const typing = setInterval(() => void this.api.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4500);
    void this.api.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const toolLog: string[] = [];
    let lastProgress = Date.now();
    try {
      const r = await agent.runTurn(text, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "tool_start") toolLog.push(e.name);
          // Long tasks: send a short progress ping at most every 2 minutes.
          if (e.type === "tool_end" && Date.now() - lastProgress > 120_000) {
            lastProgress = Date.now();
            void reply(`⚙ still working… (${toolLog.length} steps: ${[...new Set(toolLog.slice(-6))].join(", ")})`).catch(() => {});
          }
        },
      });
      const footer = toolLog.length ? `\n\n— ${toolLog.length} tool call(s)${r.stopped !== "completed" ? `, ${r.stopped}` : ""}` : r.stopped !== "completed" ? `\n\n— ${r.stopped}` : "";
      await reply((r.text || "(no reply)") + footer);
    } catch (err) {
      await reply(`✗ ${errorMessage(err)}`);
    } finally {
      clearInterval(typing);
      this.running.delete(chatId);
    }
  }
}

export function startTelegram(s: KestrelService): { stop(): void; gateway: TelegramGateway } {
  const token = process.env[s.config.telegram.tokenEnv];
  if (!token) throw new Error(`telegram enabled but ${s.config.telegram.tokenEnv} is not set`);
  if (!s.config.telegram.allowedUserIds.length) throw new Error("telegram.allowedUserIds is empty; refusing to start an open bot");
  const gw = new TelegramGateway(s, telegramApi(token), new Set(s.config.telegram.allowedUserIds));
  s.addNotifier((title, body) => gw.notifyOwners(title, body));
  void gw.run();
  return { stop: () => gw.stop(), gateway: gw };
}
