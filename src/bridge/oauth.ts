import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { BridgeConfig } from "../core/config.js";
import type { AuditLog } from "../core/audit.js";
import { randomToken, safeEqual, sha256 } from "../core/util.js";
import { verifyPassword, verifyTotp } from "./secrets.js";

interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds
  resource?: string;
  family: string; // refresh-token rotation family
}

interface StoreFile {
  clients: Record<string, OAuthClientInformationFull & { approved?: boolean; lastUsedAt?: string }>;
  access: Record<string, StoredToken>;
  refresh: Record<string, StoredToken & { usedAt?: number }>;
}

interface PendingAuth {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
  csrf: string;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

export const SCOPES = ["computer"];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Self-contained OAuth 2.1 authorization server for the bridge (DCR + PKCE + rotating refresh
 * tokens). Only the owner can approve a connection: the consent page requires the owner
 * passphrase (and TOTP when configured), with lockout after repeated failures.
 */
export class BridgeOAuthProvider implements OAuthServerProvider {
  private store: StoreFile;
  private readonly file: string;
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, IssuedCode>();
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(
    private readonly cfg: BridgeConfig,
    dataDir: string,
    private readonly audit: AuditLog,
  ) {
    this.file = path.join(dataDir, "oauth.json");
    mkdirSync(dataDir, { recursive: true });
    this.store = { clients: {}, access: {}, refresh: {} };
    if (existsSync(this.file)) this.reloadIfChanged();
    this.purgeExpired();
  }

  private mtime = 0;

  private save() {
    writeFileSync(this.file, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    this.mtime = statSync(this.file).mtimeMs;
  }

  /** Pick up revocations made by the CLI in another process. */
  private reloadIfChanged() {
    try {
      const m = statSync(this.file).mtimeMs;
      if (m !== this.mtime) {
        this.store = JSON.parse(readFileSync(this.file, "utf8"));
        this.mtime = m;
      }
    } catch {
      /* file not written yet */
    }
  }

  private purgeExpired() {
    const now = Date.now() / 1000;
    for (const [k, t] of Object.entries(this.store.access)) if (t.expiresAt < now) delete this.store.access[k];
    for (const [k, t] of Object.entries(this.store.refresh)) if (t.expiresAt < now || (t.usedAt && now - t.usedAt > 3600)) delete this.store.refresh[k];
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => {
        this.reloadIfChanged();
        return this.store.clients[id];
      },
      registerClient: (client) => {
        const redirects = (client.redirect_uris ?? []).map(String);
        const bad = redirects.find((u) => !this.redirectAllowed(u));
        if (bad) {
          this.audit.write({ actor: "oauth:dcr", action: "oauth.register", args: { client_name: client.client_name, redirect_uris: redirects }, outcome: "denied", detail: `redirect host not allowed: ${bad}` });
          throw new InvalidClientMetadataError(`redirect_uri host not allowed by this bridge: ${bad}`);
        }
        const full = client as OAuthClientInformationFull;
        this.store.clients[full.client_id] = full;
        this.save();
        this.audit.write({ actor: "oauth:dcr", action: "oauth.register", args: { client_id: full.client_id, client_name: client.client_name, redirect_uris: redirects }, outcome: "ok" });
        return full;
      },
    };
  }

  redirectAllowed(uri: string): boolean {
    try {
      const u = new URL(uri);
      const host = u.hostname.toLowerCase();
      const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      if (u.protocol !== "https:" && !loopback) return false;
      return this.cfg.auth.allowedRedirectHosts.some((h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase()));
    } catch {
      return false;
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.redirectAllowed(params.redirectUri)) {
      res.status(400).type("text/plain").send("redirect_uri not allowed");
      return;
    }
    const id = randomToken(18);
    const csrf = randomToken(18);
    this.pending.set(id, { clientId: client.client_id, params, createdAt: Date.now(), csrf });
    for (const [k, p] of this.pending) if (Date.now() - p.createdAt > 10 * 60_000) this.pending.delete(k);
    // Browsers apply form-action to the redirect that follows the POST, so the client's own (already
    // allow-listed) redirect origin must be permitted too, or approving silently does nothing.
    const back = new URL(params.redirectUri).origin;
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${back}; frame-ancestors 'none'`);
    res.setHeader("X-Frame-Options", "DENY");
    res.status(200).type("html").send(this.consentPage(client, params, id, csrf));
  }

  private consentPage(client: OAuthClientInformationFull, params: AuthorizationParams, id: string, csrf: string, error = "") {
    const name = escapeHtml(client.client_name ?? client.client_id);
    const host = escapeHtml(new URL(params.redirectUri).host);
    const totp = this.cfg.auth.totpSecret
      ? `<label>驗證碼 (TOTP)<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label>`
      : "";
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatBridge 授權</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e2e0da;--accent:#1f6f5c;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--fg:#ecebe6;--muted:#9c9a93;--line:#34332f;--accent:#5cc2a6;--danger:#f2b8b5}button.ok{color:#0b231c!important;font-weight:600}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans TC",sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:420px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px}.who{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:18px}
.who b{display:block}.who span{color:var(--muted);font-size:13px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:12px}
input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:16px}
.row{display:flex;gap:10px;margin-top:8px}button{flex:1;padding:11px;border-radius:8px;border:1px solid var(--line);font-size:15px;cursor:pointer;background:transparent;color:var(--fg)}
button.ok{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:var(--danger);font-size:14px;margin-bottom:12px}.warn{font-size:13px;color:var(--muted);margin-top:16px}
</style></head><body><main>
<h1>允許連線到這台電腦？</h1><p>核准後，這個應用程式可以在你的電腦上執行指令、讀寫檔案與操作桌面。</p>
<div class="who"><b>${name}</b><span>回呼網域：${host}</span></div>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${csrf}">
<label>擁有者密語<input name="password" type="password" autocomplete="current-password" required autofocus></label>
${totp}
<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>拒絕</button><button class="ok" type="submit" name="decision" value="approve">核准</button></div>
</form>
<div class="warn">如果你沒有剛在 ChatGPT 或 Claude 新增連接器，請按「拒絕」。</div>
</main></body></html>`;
  }

  /** Express router for the consent form POST (mounted at /oauth). */
  consentRouter(): Router {
    const router = express.Router();
    router.post("/consent", express.urlencoded({ extended: false, limit: "8kb" }), (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const pending = this.pending.get(String(req.body.request ?? ""));
      if (!pending || !safeEqual(String(req.body.csrf ?? ""), pending.csrf)) {
        res.status(400).type("text/plain").send("授權請求已過期，請回到 ChatGPT / Claude 重新連線。");
        return;
      }
      const client = this.store.clients[pending.clientId];
      const redirect = new URL(pending.params.redirectUri);
      if (pending.params.state) redirect.searchParams.set("state", pending.params.state);

      if (req.body.decision !== "approve") {
        this.pending.delete(String(req.body.request));
        this.audit.write({ actor: `oauth:${pending.clientId}`, action: "oauth.consent", outcome: "denied", detail: "owner denied" });
        redirect.searchParams.set("error", "access_denied");
        res.redirect(302, redirect.href);
        return;
      }
      const now = Date.now();
      if (now < this.lockedUntil) {
        res.status(429).type("html").send(this.consentPage(client!, pending.params, String(req.body.request), pending.csrf, `嘗試次數過多，請在 ${Math.ceil((this.lockedUntil - now) / 60000)} 分鐘後再試。`));
        return;
      }
      const passOk = verifyPassword(String(req.body.password ?? ""), this.cfg.auth.ownerPasswordHash);
      const totpOk = !this.cfg.auth.totpSecret || verifyTotp(this.cfg.auth.totpSecret, String(req.body.totp ?? ""));
      if (!passOk || !totpOk) {
        this.failures = this.failures.filter((t) => now - t < 15 * 60_000);
        this.failures.push(now);
        if (this.failures.length >= 5) {
          this.lockedUntil = now + 15 * 60_000;
          this.failures = [];
        }
        this.audit.write({ actor: `oauth:${pending.clientId}`, action: "oauth.consent", outcome: "denied", detail: "bad owner credentials" });
        res.status(401).type("html").send(this.consentPage(client!, pending.params, String(req.body.request), pending.csrf, "密語或驗證碼錯誤。"));
        return;
      }
      this.failures = [];
      this.pending.delete(String(req.body.request));
      const code = randomToken(32);
      this.codes.set(code, { clientId: pending.clientId, params: pending.params, expiresAt: now + 5 * 60_000 });
      this.audit.write({ actor: `oauth:${pending.clientId}`, action: "oauth.consent", args: { client_name: client?.client_name }, outcome: "ok" });
      redirect.searchParams.set("code", code);
      res.redirect(302, redirect.href);
    });
    return router;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("invalid authorization code");
    return c.params.codeChallenge;
  }

  private issue(clientId: string, scopes: string[], resource?: string, family = randomToken(12)): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const access = "cba_" + randomToken(32);
    const refresh = "cbr_" + randomToken(32);
    this.store.access[sha256(access)] = { clientId, scopes, resource, family, expiresAt: now + this.cfg.auth.accessTokenTtlSec };
    this.store.refresh[sha256(refresh)] = { clientId, scopes, resource, family, expiresAt: now + this.cfg.auth.refreshTokenTtlSec };
    const client = this.store.clients[clientId];
    if (client) client.lastUsedAt = new Date().toISOString();
    this.purgeExpired();
    this.save();
    return { access_token: access, token_type: "bearer", expires_in: this.cfg.auth.accessTokenTtlSec, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("invalid authorization code");
    if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const scopes = c.params.scopes?.length ? c.params.scopes : SCOPES;
    this.audit.write({ actor: `oauth:${client.client_id}`, action: "oauth.token", args: { grant: "authorization_code" }, outcome: "ok" });
    return this.issue(client.client_id, scopes, (resource ?? c.params.resource)?.href);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const t = this.store.refresh[key];
    if (!t || t.clientId !== client.client_id || t.expiresAt < Date.now() / 1000) throw new InvalidGrantError("invalid refresh token");
    if (t.usedAt) {
      // Reuse of a rotated token = likely theft. Kill the whole family.
      this.revokeFamily(t.family);
      this.audit.write({ actor: `oauth:${client.client_id}`, action: "oauth.refresh", outcome: "denied", detail: "refresh token reuse detected; family revoked" });
      throw new InvalidGrantError("refresh token already used");
    }
    t.usedAt = Math.floor(Date.now() / 1000);
    const granted = scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes;
    return this.issue(client.client_id, granted, resource?.href ?? t.resource, t.family);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.reloadIfChanged();
    for (const st of this.cfg.auth.staticTokens) {
      if (safeEqual(sha256(token), st.hash)) {
        return { token, clientId: `token:${st.name}`, scopes: SCOPES, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      }
    }
    const t = this.store.access[sha256(token)];
    if (!t || t.expiresAt < Date.now() / 1000) throw new InvalidTokenError("invalid or expired access token");
    if (!this.store.clients[t.clientId]) throw new InvalidTokenError("client has been revoked");
    return { token, clientId: t.clientId, scopes: t.scopes, expiresAt: t.expiresAt, resource: t.resource ? new URL(t.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const t = this.store.access[key] ?? this.store.refresh[key];
    if (t && t.clientId === client.client_id) this.revokeFamily(t.family);
  }

  private revokeFamily(family: string) {
    for (const m of [this.store.access, this.store.refresh]) for (const [k, t] of Object.entries(m)) if (t.family === family) delete m[k];
    this.save();
  }

  listClients() {
    this.reloadIfChanged();
    const now = Date.now() / 1000;
    return Object.values(this.store.clients).map((c) => ({
      clientId: c.client_id,
      name: c.client_name ?? "(unnamed)",
      redirectUris: c.redirect_uris,
      registeredAt: c.client_id_issued_at ? new Date(c.client_id_issued_at * 1000).toISOString() : null,
      lastUsedAt: c.lastUsedAt ?? null,
      activeTokens: Object.values(this.store.access).filter((t) => t.clientId === c.client_id && t.expiresAt > now).length,
    }));
  }

  revokeClient(clientId: string): boolean {
    this.reloadIfChanged();
    const existed = !!this.store.clients[clientId];
    delete this.store.clients[clientId];
    for (const m of [this.store.access, this.store.refresh]) for (const [k, t] of Object.entries(m)) if (t.clientId === clientId) delete m[k];
    this.save();
    return existed;
  }

  revokeAll() {
    this.store = { clients: {}, access: {}, refresh: {} };
    this.save();
  }
}
