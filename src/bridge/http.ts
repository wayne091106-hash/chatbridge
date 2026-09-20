import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Runtime } from "../core/runtime.js";
import { errorMessage, safeEqual, sha256 } from "../core/util.js";
import { BridgeOAuthProvider, SCOPES } from "./oauth.js";
import { createMcpServer, type ToolContext } from "./tools.js";
import { adminPage } from "./adminPage.js";
import { registerWorkbenchWeb } from "./workbenchWeb.js";

export interface HttpBridge {
  app: express.Express;
  server: Server;
  url: string;
  mcpUrl: string;
  oauth: BridgeOAuthProvider | null;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export async function startHttpBridge(rt: Runtime, opts: { extensions?: ToolContext["extensions"]; extraRoutes?: (app: express.Express) => void } = {}): Promise<HttpBridge> {
  const cfg = rt.config;
  const { host, port } = cfg.server;
  const localOrigin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  // Without a public URL, advertise the address we actually bind: "localhost" can resolve to ::1 while
  // the server listens on 127.0.0.1, and then the advertised metadata URL does not answer.
  const publicOrigin = (cfg.server.publicUrl ?? localOrigin).replace(/\/+$/, "");
  const mcpUrl = new URL("/mcp", publicOrigin);

  if (cfg.auth.mode === "none" && !LOOPBACK.has(host)) {
    throw new Error("auth.mode=none is only allowed when binding to a loopback address");
  }
  if (cfg.auth.mode === "oauth" && !cfg.auth.ownerPasswordHash) {
    throw new Error("OAuth mode needs an owner passphrase. Run `chatbridge init` first.");
  }
  if (cfg.auth.mode === "oauth" && !cfg.server.publicUrl) {
    rt.logger.warn(`server.publicUrl is not set; OAuth metadata will advertise ${localOrigin} (fine for local tests only)`);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...cfg.server.allowedHosts]);
  allowedHosts.add(new URL(publicOrigin).hostname);
  app.use(hostHeaderValidation([...allowedHosts]));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_req, res) => {
    rt.state.reload();
    res.json({ ok: true, name: "chatbridge", paused: rt.state.paused });
  });

  let oauth: BridgeOAuthProvider | null = null;
  let bearer: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
  if (cfg.auth.mode === "oauth" || cfg.auth.mode === "token") {
    oauth = new BridgeOAuthProvider(cfg, rt.dataDir, rt.audit);
    if (cfg.auth.mode === "oauth") {
      app.use(
        mcpAuthRouter({
          provider: oauth,
          issuerUrl: new URL(publicOrigin),
          resourceServerUrl: mcpUrl,
          scopesSupported: SCOPES,
          resourceName: "ChatBridge (this PC)",
        }),
      );
      app.use("/oauth", oauth.consentRouter());
    }
    bearer = requireBearerAuth({
      verifier: oauth,
      resourceMetadataUrl: cfg.auth.mode === "oauth" ? getOAuthProtectedResourceMetadataUrl(mcpUrl) : undefined,
    });
  }

  const handleMcp = async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
      return;
    }
    const server = createMcpServer({ rt, extensions: opts.extensions });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Delivery log for large results: was the response fully sent, and how fast (the client may give up).
    const started = Date.now();
    const sentBefore = req.socket.bytesWritten;
    res.on("close", () => {
      const bytes = req.socket.bytesWritten - sentBefore;
      if (bytes > 1024 * 1024) {
        const secs = (Date.now() - started) / 1000;
        rt.audit.write({
          actor: "http",
          action: "http.response",
          args: { method: (req.body as any)?.method, tool: (req.body as any)?.params?.name, mb: +(bytes / 1048576).toFixed(1), seconds: +secs.toFixed(1), mbps: +((bytes * 8) / 1e6 / Math.max(secs, 0.001)).toFixed(1) },
          outcome: res.writableFinished ? "ok" : "error",
          ...(res.writableFinished ? {} : { detail: "client closed the connection before the response was fully sent" }),
        });
      }
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      rt.logger.error(`mcp request failed: ${errorMessage(err)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };
  const json = express.json({ limit: "50mb" });
  if (bearer) app.all("/mcp", bearer, json, handleMcp);
  else app.all("/mcp", json, handleMcp);

  // ------------------------------------------------------------------ local admin dashboard
  const adminGuard = (req: Request, res: Response, next: NextFunction) => {
    // Dashboard is only reachable on the loopback host name, never through a tunnel hostname.
    if (!LOOPBACK.has(req.hostname) || req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) {
      res.status(404).end();
      return;
    }
    if (req.path === "/" || req.path === "") return next();
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!cfg.auth.adminTokenHash || !token || !safeEqual(sha256(token), cfg.auth.adminTokenHash)) {
      res.status(401).json({ error: "admin token required (run `chatbridge admin-url`)" });
      return;
    }
    next();
  };
  registerWorkbenchWeb(app, rt, cfg, opts.extensions);

  const admin = express.Router();
  admin.use(adminGuard, express.json());
  admin.get("/", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'");
    res.type("html").send(adminPage());
  });
  admin.get("/api/status", async (_req, res) => {
    rt.state.reload();
    res.json({
      paused: rt.state.paused,
      pausedReason: rt.state.pausedReason,
      authMode: cfg.auth.mode,
      publicUrl: cfg.server.publicUrl ?? null,
      mcpUrl: mcpUrl.href,
      policy: rt.policy.mode,
      executor: await rt.executor.info().catch((e) => ({ error: errorMessage(e) })),
      workingDirectory: rt.cwd.value,
      auditChain: rt.audit.verify(),
    });
  });
  admin.post("/api/pause", (req, res) => {
    const paused = !!req.body?.paused;
    rt.state.setPaused(paused, String(req.body?.reason ?? ""));
    rt.audit.write({ actor: "admin:dashboard", action: paused ? "admin.pause" : "admin.resume", outcome: "ok", detail: req.body?.reason });
    res.json({ paused });
  });
  admin.get("/api/audit", (req, res) => res.json({ records: rt.audit.tail(Math.min(Number(req.query.n ?? 100), 1000)).reverse() }));
  admin.get("/api/clients", (_req, res) => res.json({ clients: oauth?.listClients() ?? [], staticTokens: cfg.auth.staticTokens.map((t) => ({ name: t.name, createdAt: t.createdAt })) }));
  admin.post("/api/clients/:id/revoke", (req, res) => {
    const ok = oauth?.revokeClient(String(req.params.id)) ?? false;
    rt.audit.write({ actor: "admin:dashboard", action: "admin.revokeClient", args: { clientId: req.params.id }, outcome: ok ? "ok" : "error" });
    res.json({ revoked: ok });
  });
  admin.post("/api/revoke-all", (_req, res) => {
    oauth?.revokeAll();
    rt.audit.write({ actor: "admin:dashboard", action: "admin.revokeAll", outcome: "ok" });
    res.json({ revoked: true });
  });
  admin.get("/api/sessions", (_req, res) => res.json({ sessions: rt.shells.list() }));
  admin.post("/api/sessions/:id/kill", async (req, res) => {
    try {
      res.json(await rt.shells.kill(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });
  app.use("/admin", admin);

  opts.extraRoutes?.(app);

  const server = await new Promise<Server>((resolve, reject) => {
    // Express 5 passes listen errors (e.g. EADDRINUSE) to the callback.
    const s = app.listen(port, host, (err?: Error & { code?: string }) => {
      if (!err) return resolve(s);
      reject(err.code === "EADDRINUSE" || err.code === "EACCES" ? new Error(`port ${port} is not available (${err.code}); set CHATBRIDGE_PORT or server.port in ~/.chatbridge/config.json`) : err);
    });
  });
  const actualPort = (server.address() as { port: number }).port;
  const url = localOrigin.replace(/:\d+$/, `:${actualPort}`);
  rt.logger.info(`MCP endpoint ${cfg.server.publicUrl ? mcpUrl.href : `${url}/mcp`} (auth: ${cfg.auth.mode})`);
  return {
    app,
    server,
    url,
    mcpUrl: cfg.server.publicUrl ? mcpUrl.href : `${url}/mcp`,
    oauth,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
