import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Agent, AgentEvent } from "./agent.js";
import type { KestrelService } from "./service.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import { webPage } from "./webPage.js";
import { errorMessage, safeEqual, sha256 } from "../core/util.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function portError(err: Error & { code?: string }, port: number, setting: string): Error {
  if (err.code === "EADDRINUSE" || err.code === "EACCES") return new Error(`port ${port} is not available (${err.code}); change ${setting}`);
  return err;
}

/** Local-only web UI + JSON API for Kestrel (chat with streaming, memory, skills, jobs, inbox). */
export async function startWebUi(s: KestrelService, opts: { port?: number; host?: string } = {}): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const app = express();
  app.disable("x-powered-by");
  const agents = new Map<string, Agent>();
  const running = new Map<string, AbortController>();
  const agentFor = (sessionId?: string) => {
    if (sessionId && agents.has(sessionId)) return agents.get(sessionId)!;
    const a = s.createAgent({ sessionId, source: "web" });
    agents.set(a.sessionId, a);
    return a;
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!LOOPBACK.has(req.hostname)) {
      res.status(403).end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'");
    res.type("html").send(webPage(s.config.agent.name));
  });
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const hash = s.config.web.tokenHash;
    if (!hash || !token || !safeEqual(sha256(token), hash)) {
      res.status(401).json({ error: "token required: run `kestrel web-url`" });
      return;
    }
    next();
  });
  app.use("/api", express.json({ limit: "10mb" }));
  const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try {
      const r = await fn(req, res);
      if (r !== undefined && !res.headersSent) res.json(r);
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: errorMessage(err) });
    }
  };

  app.get(
    "/api/state",
    wrap(() => ({
      name: s.config.agent.name,
      model: `${s.provider.name}/${s.provider.model}`,
      memories: s.store.countMemories(),
      skills: s.skills.list().length,
      jobs: s.store.listJobs().length,
      unread: s.store.listInbox(true, 100).length,
      scheduler: s.schedulerRunning,
      running: [...running.keys()],
    })),
  );
  app.get("/api/sessions", wrap(() => ({ sessions: s.store.listSessions({ limit: 200 }) })));
  app.get(
    "/api/sessions/:id",
    wrap((req) => {
      const row = s.store.getSession(String(req.params.id));
      if (!row) throw new Error("session not found");
      return { session: row, messages: s.store.loadMessages(row.id, true).map((m) => ({ ...m, providerBlocks: undefined })), running: running.has(row.id) };
    }),
  );
  app.delete(
    "/api/sessions/:id",
    wrap((req) => {
      const id = String(req.params.id);
      if (running.has(id)) throw new Error("session is running");
      agents.delete(id);
      s.store.deleteSession(id);
      return { deleted: true };
    }),
  );

  // Streams NDJSON agent events for one turn.
  app.post("/api/chat", async (req: Request, res: Response) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) {
      res.status(400).json({ error: "message required" });
      return;
    }
    let agent: Agent;
    try {
      agent = agentFor(req.body?.sessionId || undefined);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    if (running.has(agent.sessionId)) {
      res.status(409).json({ error: "this session is already running" });
      return;
    }
    const controller = new AbortController();
    running.set(agent.sessionId, controller);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.flushHeaders();
    const send = (e: AgentEvent | Record<string, unknown>) => {
      if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
    };
    send({ type: "session", sessionId: agent.sessionId });
    const keepAlive = setInterval(() => send({ type: "ping" }), 15_000);
    try {
      await agent.runTurn(message, { signal: controller.signal, onEvent: (e) => send(e) });
    } catch (err) {
      send({ type: "error", message: errorMessage(err) });
    } finally {
      clearInterval(keepAlive);
      running.delete(agent.sessionId);
      res.end();
    }
  });
  app.post(
    "/api/chat/:id/abort",
    wrap((req) => {
      running.get(String(req.params.id))?.abort();
      return { aborting: true };
    }),
  );
  app.post("/api/sessions/:id/reflect", wrap(async (req) => agentFor(String(req.params.id)).reflect({ force: true })));
  app.post(
    "/api/sessions/:id/undo",
    wrap(async (req) => {
      const a = agentFor(String(req.params.id));
      return a.checkpoints.undo(s.rt.executor, req.body?.checkpoint);
    }),
  );
  app.get("/api/sessions/:id/checkpoints", wrap((req) => ({ checkpoints: agentFor(String(req.params.id)).checkpoints.list() })));

  app.get("/api/memories", wrap((req) => ({ memories: req.query.q ? s.store.searchMemories(String(req.query.q), 50) : s.store.listMemories({ limit: 300 }), profile: s.store.getProfile() })));
  app.post("/api/memories", wrap((req) => s.store.addMemory({ content: String(req.body.content), kind: req.body.kind ?? "fact", importance: Number(req.body.importance ?? 0.6), source: "web" })));
  app.patch("/api/memories/:id", wrap((req) => s.store.updateMemory(Number(req.params.id), { content: req.body.content, importance: req.body.importance, kind: req.body.kind })));
  app.delete("/api/memories/:id", wrap((req) => ({ archived: s.store.archiveMemory(Number(req.params.id)) })));
  app.post(
    "/api/profile",
    wrap((req) => {
      if (req.body.value === null || req.body.value === "") s.store.deleteProfile(String(req.body.key));
      else s.store.setProfile(String(req.body.key), String(req.body.value));
      return s.store.getProfile();
    }),
  );

  app.get("/api/skills", wrap(() => ({ skills: s.skills.list().map(({ body: _b, ...k }) => k) })));
  app.get(
    "/api/skills/:slug",
    wrap((req) => {
      const k = s.skills.get(String(req.params.slug));
      if (!k) throw new Error("not found");
      return k;
    }),
  );
  app.put("/api/skills/:slug", wrap((req) => s.skills.save({ name: String(req.body.name), description: String(req.body.description), body: String(req.body.body), tags: req.body.tags ?? [] })));
  app.delete("/api/skills/:slug", wrap((req) => ({ deleted: s.skills.delete(String(req.params.slug)) })));

  app.get("/api/jobs", wrap(() => ({ jobs: s.store.listJobs().map((j) => ({ ...j, description: describeSchedule(j.schedule), runs: s.store.jobRuns(j.id, 5) })), scheduler: s.schedulerRunning })));
  app.post(
    "/api/jobs",
    wrap((req) => {
      const schedule = normalizeSchedule(String(req.body.schedule));
      const next = nextRun(schedule, new Date());
      return s.store.addJob({ name: String(req.body.name), schedule, prompt: String(req.body.prompt), deliver: req.body.deliver ?? "both", nextRunAt: next?.toISOString() ?? null });
    }),
  );
  app.post(
    "/api/jobs/:id/toggle",
    wrap((req) => {
      const j = s.store.getJob(String(req.params.id));
      if (!j) throw new Error("not found");
      s.store.updateJob(j.id, { enabled: !j.enabled, nextRunAt: !j.enabled ? (nextRun(j.schedule, new Date())?.toISOString() ?? null) : j.nextRunAt });
      return s.store.getJob(j.id);
    }),
  );
  app.post(
    "/api/jobs/:id/run",
    wrap((req) => {
      const j = s.store.getJob(String(req.params.id));
      if (!j) throw new Error("not found");
      void s.runJob(j);
      return { started: true };
    }),
  );
  app.delete("/api/jobs/:id", wrap((req) => ({ deleted: s.store.deleteJob(String(req.params.id)) })));

  app.get("/api/inbox", wrap(() => ({ items: s.store.listInbox(false, 100) })));
  app.post(
    "/api/inbox/read",
    wrap((req) => {
      s.store.markInboxRead(req.body?.id);
      return { ok: true };
    }),
  );

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? s.config.web.port;
  const server = await new Promise<Server>((resolve, reject) => {
    // Express 5 passes listen errors (e.g. EADDRINUSE) to the callback.
    const srv = app.listen(port, host, (err?: Error) => (err ? reject(portError(err, port, "web.port in ~/.chatbridge/kestrel/config.json")) : resolve(srv)));
  });
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of running.values()) c.abort();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
