#!/usr/bin/env node
import { isEntryPoint } from "../core/entry.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs, flagNumber, flagString, type ParsedArgs } from "../core/args.js";
import { AuditLog } from "../core/audit.js";
import { BridgeConfigSchema, configPath, dataDir, loadConfig, RuntimeState, saveConfig, type BridgeConfig } from "../core/config.js";
import { findCodexBinary } from "../core/execServer.js";
import { createLogger } from "../core/logger.js";
import { objectStore, saveStoreConfig } from "../core/objectStore.js";
import { createRuntime } from "../core/runtime.js";
import { errorMessage, expandHome, randomToken, sha256 } from "../core/util.js";
import { startHttpBridge } from "./http.js";
import { activeGrants, addGrant, describeGrant, revokeGrant } from "../core/grants.js";
import { BridgeOAuthProvider } from "./oauth.js";
import { generatePassphrase, generateTotpSecret, hashPassword, totpUri } from "./secrets.js";
import { createMcpServer, type ToolContext } from "./tools.js";

const HELP = `chatbridge — let ChatGPT / Claude web chat drive this PC through MCP

Setup
  chatbridge init [--public-url URL] [--port 8765] [--no-totp] [--full-machine] [--force]
                                   Create config + owner passphrase/TOTP + admin token.
                                   New installs start in project scope; --full-machine opens the whole PC
  chatbridge set-public-url URL    Set the HTTPS origin of your tunnel
  chatbridge connect-info          Show how to add the connector in ChatGPT / Claude
  chatbridge doctor                Check codex, exec-server protocol, config

Run
  chatbridge up                    serve + Kestrel scheduler, web UI and Telegram in one process
  chatbridge serve                 Start the HTTP MCP server (+ OAuth, admin dashboard)
  chatbridge stdio [--name label]  MCP over stdio (OpenAI tunnel-client, Claude Desktop, Codex).
                                   --name labels this connection in the audit log (one per account)
  chatbridge autostart enable|disable   Run \`up\` at Windows logon (hidden)

Everyday
  chatbridge tunnel status|restart|logs [--profile name] [--tail 40]
                                   The ChatGPT tunnel(s): up?, restart one, show a log.
                                   One profile per ChatGPT account; no --profile means all
  chatbridge tunnel add <name> --tunnel-id tunnel_xxx [--key-var VAR]
                                   Add another ChatGPT account to this PC (runs alongside the first)
  chatbridge mode readonly|full    readonly = ChatGPT can look but not change anything
  chatbridge scope machine|projects
                                   machine = the whole PC (default); projects = only granted folders
  chatbridge grant <folder> [--hours 8] [--note "..."]
                                   Allow one project folder (used when scope = projects)
  chatbridge grants                List live grants
  chatbridge revoke <id|folder|all>  Take a grant back
  chatbridge name "Office PC"      Name this computer (shown to ChatGPT; helps with several PCs)
  chatbridge agents                Coding agents on this PC and whether they work
  chatbridge recover               Work that was cut off when ChatBridge stopped, and how to continue it
  chatbridge quiz status|add ["問題" --answer x --alt "y,z"]|remove <id>|test|lock
                                   Personal questions used to check it is really you (answers stored hashed)
  chatbridge workbench [folder] [--new-token]
                                   Open the full-size workbench in your browser (needs the local server)
  chatbridge drive status|set <folder>|account <email>|off
                                   Google Drive folder for fast file hand-off (收件 / 寄件)
  chatbridge storage status|set|setup|test|off
                                   Cloud storage (e.g. Cloudflare R2) for fast PC → chat file transfers

Control
  chatbridge status
  chatbridge pause [reason]        Kill switch: refuse all tool calls immediately
  chatbridge resume
  chatbridge admin-url             Print a fresh URL for the local dashboard
  chatbridge audit [--tail 30] [--verify]
  chatbridge clients [list|revoke <id>|revoke-all]
  chatbridge token create <name> | list | revoke <name>
  chatbridge passphrase reset      New owner passphrase
  chatbridge totp enable|disable

Environment: CHATBRIDGE_HOME (default ~/.chatbridge), CHATBRIDGE_PORT, CHATBRIDGE_PUBLIC_URL, LOG_LEVEL`;

const out = (s = "") => process.stdout.write(s + "\n");

async function agentExtensions(cfg: BridgeConfig): Promise<ToolContext["extensions"]> {
  if (!cfg.features.agent) return [];
  try {
    const mod = await import("../agent/bridgeExtension.js");
    return [await mod.kestrelBridgeExtension()];
  } catch (err) {
    createLogger(cfg.logLevel, "chatbridge").warn(`Kestrel agent tools disabled: ${errorMessage(err)}`);
    return [];
  }
}

function writeCredentials(dir: string, lines: string[]) {
  const file = path.join(dir, "OWNER-CREDENTIALS.txt");
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return file;
}

async function cmdInit(a: ParsedArgs) {
  const dir = dataDir();
  if (existsSync(configPath(dir)) && !a.flags.force) {
    out(`config already exists at ${configPath(dir)} (use --force to regenerate credentials)`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const passphrase = generatePassphrase();
  const adminToken = randomToken(24);
  const totpSecret = a.flags.totp === false ? undefined : generateTotpSecret();
  // A fresh install starts narrow: nothing is reachable until the owner grants a folder. Existing configs
  // are never touched by this, and `chatbridge scope machine` opens the whole PC when that is what you want.
  const scope = a.flags["full-machine"] ? "machine" : "projects";
  const cfg = BridgeConfigSchema.parse({
    server: { port: flagNumber(a, "port") ?? 8765, publicUrl: flagString(a, "public-url") },
    auth: { mode: "oauth", ownerPasswordHash: hashPassword(passphrase), totpSecret, adminTokenHash: sha256(adminToken) },
    executor: { kind: "auto", pinnedVersion: await detectCodexVersion() },
    policy: { scope },
  });
  saveConfig(cfg, dir);
  const port = cfg.server.port;
  const file = writeCredentials(dir, [
    "ChatBridge owner credentials — keep this file private.",
    "",
    `Owner passphrase (OAuth consent page): ${passphrase}`,
    totpSecret ? `TOTP secret: ${totpSecret}` : "TOTP: disabled",
    totpSecret ? `TOTP URI (add to Google Authenticator / 1Password): ${totpUri(totpSecret)}` : "",
    `Admin dashboard: http://127.0.0.1:${port}/admin/#token=${adminToken}`,
    "",
    `Generated ${new Date().toISOString()}`,
  ]);
  out(`✓ config written to ${configPath(dir)}`);
  out(`✓ owner credentials written to ${file}`);
  out(`  passphrase: ${passphrase}`);
  if (totpSecret) out(`  TOTP secret: ${totpSecret}  (add it to an authenticator app)`);
  out(`  dashboard:  http://127.0.0.1:${port}/admin/#token=${adminToken}`);
  out("");
  if (scope === "projects") {
    out("Permissions: this install starts in project scope — nothing on the PC is reachable until you say so:");
    out('  chatbridge grant "C:\\path\\to\\your\\project" --hours 8');
    out("  chatbridge scope machine      # or open the whole computer (screen, mouse, every folder)");
    out("");
  }
  out("Next: expose the server through a tunnel, then `chatbridge set-public-url https://...` and `chatbridge connect-info`.");
}

async function detectCodexVersion(): Promise<string | undefined> {
  const bin = findCodexBinary();
  if (!bin) return undefined;
  try {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", shell: /\.cmd$/i.test(bin), windowsHide: true });
    return v.trim().split(/\s+/).pop();
  } catch {
    return undefined;
  }
}

async function cmdServe(a: ParsedArgs, withKestrel = false) {
  const rt = await createRuntime();
  let kestrel: { close(): Promise<void> } | null = null;
  let extensions = await agentExtensions(rt.config);
  if (withKestrel) {
    // One process: bridge + Kestrel scheduler/web UI/Telegram sharing a single exec-server.
    const { KestrelService } = await import("../agent/service.js");
    const { kestrelBridgeExtension } = await import("../agent/bridgeExtension.js");
    const s = await KestrelService.create({ runtime: rt });
    extensions = [await kestrelBridgeExtension(s)];
    if (s.config.scheduler.enabled && a.flags.scheduler !== false) s.startScheduler();
    const parts: Array<{ close?(): Promise<void>; stop?(): void }> = [];
    if (a.flags.web !== false) {
      const { startWebUi } = await import("../agent/web.js");
      const web = await startWebUi(s);
      parts.push(web);
      rt.logger.info(`Kestrel web UI ${web.url} (\`kestrel web-url\` for a login link)`);
    }
    if (s.config.telegram.enabled && a.flags.telegram !== false) {
      const { startTelegram } = await import("../agent/telegram.js");
      try {
        parts.push(startTelegram(s));
      } catch (err) {
        rt.logger.warn(`Telegram gateway not started: ${errorMessage(err)}`);
      }
    }
    kestrel = {
      async close() {
        for (const p of parts) {
          p.stop?.();
          await p.close?.();
        }
        await s.close();
      },
    };
  }
  const bridge = await startHttpBridge(rt, { extensions });
  rt.logger.info(`dashboard: ${bridge.url}/admin/ (run \`chatbridge admin-url\` for a login link)`);
  const shutdown = async () => {
    rt.logger.info("shutting down");
    await bridge.close();
    await kestrel?.close();
    await rt.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStdio(a: ParsedArgs) {
  const rt = await createRuntime({ logger: createLogger((process.env.LOG_LEVEL as any) ?? "warn", "chatbridge") });
  // With more than one tunnel on this PC (e.g. a second ChatGPT account), --name labels which one is
  // calling, so the audit log and the workbench feed say who did what.
  const actor = flagString(a, "name") ?? process.env.CHATBRIDGE_ACTOR;
  const server = createMcpServer({ rt, actor: actor ? `chat:${actor}` : undefined, extensions: await agentExtensions(rt.config) });
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close();
    await rt.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const state = new RuntimeState();
  const audit = new AuditLog(path.join(dataDir(), "audit", "audit.jsonl"));
  let running = false;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.server.port}/healthz`, { signal: AbortSignal.timeout(1500) });
    running = r.ok;
  } catch {
    running = false;
  }
  out(`data dir:     ${dataDir()}`);
  out(`server:       ${running ? "running" : "not running"} on 127.0.0.1:${cfg.server.port}`);
  out(`public url:   ${cfg.server.publicUrl ?? "(not set)"}`);
  out(`auth:         ${cfg.auth.mode}${cfg.auth.totpSecret ? " + TOTP" : ""}`);
  out(`kill switch:  ${state.paused ? `PAUSED (${state.pausedReason || "no reason"})` : "off"}`);
  out(`policy:       ${cfg.policy.mode} (scope: ${cfg.policy.scope})`);
  if (cfg.policy.scope === "projects") for (const g of activeGrants()) out(`  grant:      ${describeGrant(g)}`);
  const v = audit.verify();
  out(`audit log:    ${v.records} records, chain ${v.ok ? "intact" : `BROKEN at ${v.brokenAt} (${v.reason})`}`);
}

async function cmdAudit(a: ParsedArgs) {
  const audit = new AuditLog(path.join(dataDir(), "audit", "audit.jsonl"));
  if (a.flags.verify) {
    const v = audit.verify();
    out(v.ok ? `✓ audit chain intact (${v.records} records)` : `✗ audit chain broken at record ${v.brokenAt}: ${v.reason}`);
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  for (const r of audit.tail(flagNumber(a, "tail") ?? 30)) {
    out(`${r.ts}  ${r.outcome.padEnd(6)}  ${r.actor.padEnd(28).slice(0, 28)}  ${r.action}  ${r.detail ? `— ${r.detail}` : ""}`);
  }
}

async function cmdClients(a: ParsedArgs) {
  const cfg = loadConfig();
  const provider = new BridgeOAuthProvider(cfg, dataDir(), new AuditLog(path.join(dataDir(), "audit", "audit.jsonl")));
  const sub = a._[1] ?? "list";
  if (sub === "list") {
    const clients = provider.listClients();
    if (!clients.length) out("no OAuth clients");
    for (const c of clients) out(`${c.clientId}  ${c.name}  last used ${c.lastUsedAt ?? "never"}  tokens ${c.activeTokens}`);
  } else if (sub === "revoke") {
    const id = a._[2];
    if (!id) throw new Error("usage: chatbridge clients revoke <client-id>");
    out(provider.revokeClient(id) ? `revoked ${id}` : `no such client ${id}`);
  } else if (sub === "revoke-all") {
    provider.revokeAll();
    out("all OAuth clients and tokens revoked");
  } else throw new Error(`unknown clients subcommand ${sub}`);
}

async function cmdToken(a: ParsedArgs) {
  const cfg = loadConfig();
  const sub = a._[1] ?? "list";
  const name = a._[2];
  if (sub === "create") {
    if (!name) throw new Error("usage: chatbridge token create <name>");
    if (cfg.auth.staticTokens.some((t) => t.name === name)) throw new Error(`token ${name} already exists`);
    const token = "cbs_" + randomToken(32);
    cfg.auth.staticTokens.push({ name, hash: sha256(token), createdAt: new Date().toISOString() });
    saveConfig(cfg);
    out(`token "${name}" (shown once): ${token}`);
    out(`use it as:  Authorization: Bearer ${token}`);
  } else if (sub === "list") {
    if (!cfg.auth.staticTokens.length) out("no static tokens");
    for (const t of cfg.auth.staticTokens) out(`${t.name}  created ${t.createdAt}`);
  } else if (sub === "revoke") {
    const before = cfg.auth.staticTokens.length;
    cfg.auth.staticTokens = cfg.auth.staticTokens.filter((t) => t.name !== name);
    saveConfig(cfg);
    out(before !== cfg.auth.staticTokens.length ? `revoked ${name} (restart serve to apply)` : `no token named ${name}`);
  } else throw new Error(`unknown token subcommand ${sub}`);
}

function cmdPause(a: ParsedArgs, paused: boolean) {
  const state = new RuntimeState();
  state.setPaused(paused, paused ? a._.slice(1).join(" ") : "");
  new AuditLog(path.join(dataDir(), "audit", "audit.jsonl")).write({ actor: "admin:cli", action: paused ? "admin.pause" : "admin.resume", outcome: "ok" });
  out(paused ? "⏸  ChatBridge paused — every tool call is refused until `chatbridge resume`." : "▶  ChatBridge resumed.");
}

function cmdAdminUrl() {
  const cfg = loadConfig();
  const token = randomToken(24);
  cfg.auth.adminTokenHash = sha256(token);
  saveConfig(cfg);
  out(`http://127.0.0.1:${cfg.server.port}/admin/#token=${token}`);
  out("(restart `chatbridge serve` if it is already running so the new token is loaded)");
}

function cmdPassphrase(a: ParsedArgs) {
  if (a._[1] !== "reset") throw new Error("usage: chatbridge passphrase reset");
  const cfg = loadConfig();
  const passphrase = generatePassphrase();
  cfg.auth.ownerPasswordHash = hashPassword(passphrase);
  saveConfig(cfg);
  out(`new owner passphrase: ${passphrase}\n(restart serve to apply)`);
}

function cmdTotp(a: ParsedArgs) {
  const cfg = loadConfig();
  if (a._[1] === "enable") {
    cfg.auth.totpSecret = generateTotpSecret();
    saveConfig(cfg);
    out(`TOTP secret: ${cfg.auth.totpSecret}\nURI: ${totpUri(cfg.auth.totpSecret)}\n(restart serve to apply)`);
  } else if (a._[1] === "disable") {
    delete cfg.auth.totpSecret;
    saveConfig(cfg);
    out("TOTP disabled (restart serve to apply)");
  } else throw new Error("usage: chatbridge totp enable|disable");
}

function cmdSetPublicUrl(a: ParsedArgs) {
  const url = a._[1];
  if (!url || !/^https:\/\//.test(url)) throw new Error("usage: chatbridge set-public-url https://your-tunnel.example.com");
  const cfg = loadConfig();
  cfg.server.publicUrl = url.replace(/\/+$/, "");
  saveConfig(cfg);
  out(`public url set to ${cfg.server.publicUrl}; MCP endpoint: ${cfg.server.publicUrl}/mcp (restart serve)`);
}

function cmdConnectInfo() {
  const cfg = loadConfig();
  const mcp = cfg.server.publicUrl ? `${cfg.server.publicUrl}/mcp` : "https://<your-tunnel>/mcp";
  const cli = path.resolve(fileURLToPath(import.meta.url));
  out(`MCP endpoint: ${mcp}\n`);
  out("ChatGPT (web)");
  out("  1. Settings → Security and login → Developer mode: ON");
  out("  2. Plugins → + → create app. Connection: URL = the endpoint above, Authentication: OAuth");
  out("     (with OpenAI Secure MCP Tunnel choose Connection: Tunnel instead, see docs/CONNECT.md)");
  out("  3. Approve on the ChatBridge consent page with your owner passphrase" + (cfg.auth.totpSecret ? " + TOTP" : ""));
  out("  4. In a chat: + → Developer mode → enable ChatBridge\n");
  out("Claude.ai (web)");
  out("  1. Settings → Connectors → Add custom connector");
  out("  2. URL = the endpoint above (leave OAuth client id/secret empty: dynamic registration is supported)");
  out("  3. Approve on the consent page, then enable the connector in a chat via the tools menu\n");
  out("OpenAI Secure MCP Tunnel (no public URL at all)");
  out(`  tunnel-client init --sample sample_mcp_stdio_local --profile chatbridge --tunnel-id <tunnel_id> --mcp-command "node ${cli} stdio"`);
  out("  tunnel-client run --profile chatbridge");
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

async function cmdAutostart(a: ParsedArgs) {
  if (process.platform !== "win32") throw new Error("autostart is implemented for Windows (Task Scheduler)");
  const dir = dataDir();
  const cli = path.resolve(fileURLToPath(import.meta.url));
  const launcher = path.join(dir, "start-hidden.vbs");
  const logFile = path.join(dir, "serve.log");
  if (a._[1] === "enable") {
    writeFileSync(
      launcher,
      `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "cmd /c """"${process.execPath}"" --disable-warning=ExperimentalWarning ""${cli}"" up >> ""${logFile}"" 2>&1""", 0, False\r\n`,
    );
    // Per-user Run key: works without administrator rights (ONLOGON scheduled tasks need admin).
    execFileSync("reg", ["add", RUN_KEY, "/v", "ChatBridge", "/t", "REG_SZ", "/d", `wscript.exe "${launcher}"`, "/f"], { stdio: "ignore" });
    out(`autostart enabled at logon (log: ${logFile})`);
  } else if (a._[1] === "disable") {
    try {
      execFileSync("reg", ["delete", RUN_KEY, "/v", "ChatBridge", "/f"], { stdio: "ignore" });
    } catch {
      /* not registered */
    }
    out("autostart disabled");
  } else throw new Error("usage: chatbridge autostart enable|disable");
}

async function cmdDoctor() {
  let failed = 0;
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      out(`✓ ${name}: ${await fn()}`);
    } catch (err) {
      failed++;
      out(`✗ ${name}: ${errorMessage(err)}`);
    }
  };
  let cfg: BridgeConfig | null = null;
  await check("config", async () => {
    cfg = loadConfig();
    return existsSync(configPath()) ? configPath() : "defaults (run `chatbridge init`)";
  });
  await check("node", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) throw new Error(`Node ${process.version} is too old (need >= 22.12)`);
    return process.version;
  });
  await check("codex binary", async () => findCodexBinary(cfg?.executor.codexPath) ?? "not found (Node executor fallback will be used)");
  await check("exec-server protocol", async () => {
    const rt = await createRuntime({ logger: createLogger("warn") });
    try {
      const info = await rt.executor.info();
      const r = await rt.shells.exec("echo chatbridge-ok", { timeoutSeconds: 30 });
      if (!r.output.includes("chatbridge-ok")) throw new Error(`unexpected output: ${r.output}`);
      const tmp = path.join(rt.dataDir, `doctor-${Date.now()}.txt`);
      await rt.executor.writeFile(tmp, "héllo 你好");
      const back = (await rt.executor.readFile(tmp)).toString("utf8");
      await rt.executor.remove(tmp);
      if (back !== "héllo 你好") throw new Error("fs round-trip mismatch");
      const pinned = rt.config.executor.pinnedVersion;
      return `${info.kind} ${info.version}${pinned && pinned !== info.version ? ` (pinned ${pinned} — re-run tests, then update executor.pinnedVersion)` : ""}; shell + fs OK`;
    } finally {
      await rt.close();
    }
  });
  await check("auth", async () => {
    const c = cfg!;
    if (c.auth.mode === "oauth" && !c.auth.ownerPasswordHash) throw new Error("no owner passphrase; run `chatbridge init`");
    return `${c.auth.mode}${c.auth.totpSecret ? " + TOTP" : ""}`;
  });
  await check("public url", async () => {
    const c = cfg!;
    if (!c.server.publicUrl) return "not set (needed for ChatGPT/Claude via URL; not needed for OpenAI tunnel stdio)";
    if (!c.server.publicUrl.startsWith("https://")) throw new Error("must be https");
    return c.server.publicUrl;
  });
  await check("port", async () => {
    const c = cfg!;
    try {
      const r = await fetch(`http://127.0.0.1:${c.server.port}/healthz`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? `${c.server.port} (chatbridge already running)` : `${c.server.port} in use by something else`;
    } catch {
      return `${c.server.port} free`;
    }
  });
  await check("tunnel", async () => {
    if (!(await tunnelReady())) {
      const procs = tunnelProcesses();
      throw new Error(procs.length ? `tunnel-client is running (pid ${procs.map((p) => p.pid).join(", ")}) but not answering on ${TUNNEL_HEALTH}` : "not running — ChatGPT cannot reach this PC (`chatbridge tunnel restart`)");
    }
    return "up — ChatGPT can reach this PC";
  });
  await check("permission scope", async () => {
    const c = cfg!;
    if (c.policy.scope !== "projects") return `${c.policy.scope} — the whole PC is reachable${c.policy.mode === "readonly" ? ", readonly" : ""}`;
    const live = activeGrants();
    if (!live.length) throw new Error('scope is "projects" but nothing is granted, so every tool call fails (`chatbridge grant "<folder>"`)');
    return `projects — ${live.length} folder(s): ${live.map((g) => g.path).join(", ")}`;
  });
  await check("agents", async () => {
    const { AGENTS, offeredAgentIds } = await import("../hub/agents.js");
    const healthFile = path.join(dataDir(), "hub", "health.json");
    const health: Record<string, { ok?: boolean }> = existsSync(healthFile) ? JSON.parse(readFileSync(healthFile, "utf8")) : {};
    const installed = offeredAgentIds().filter((id) => !!AGENTS[id].resolve());
    if (!installed.length) throw new Error("no coding agent is installed (`chatbridge agents`)");
    const broken = installed.filter((id) => health[id] && health[id].ok === false);
    return `${installed.join(", ")}${broken.length ? ` — but ${broken.join(", ")} failed its last check (agents_check to retry)` : ""}`;
  });
  await check("drive lane", async () => {
    const folder = cfg!.drive.folder;
    if (!folder) return "not configured (chat transfer still works)";
    if (!existsSync(folder)) throw new Error(`${folder} does not exist — is Google Drive for desktop running?`);
    return folder;
  });
  await check("audit log", async () => {
    const log = new AuditLog(path.join(dataDir(), "audit", "audit.jsonl"));
    const v = log.verify();
    if (!v.ok) throw new Error(`chain broken at entry ${v.brokenAt ?? "?"} — someone edited or truncated the log`);
    return `${log.tail(1_000_000).length} recent entries, chain intact`;
  });
  out("");
  out(failed ? `${failed} check(s) failed.` : "all checks passed.");
  process.exitCode = failed ? 1 : 0;
}

const TUNNEL_DIR = () => path.join(dataDir(), "tunnel-client");
const TUNNEL_HEALTH = "http://127.0.0.1:18081";

async function tunnelReady(): Promise<boolean> {
  try {
    const r = await fetch(`${TUNNEL_HEALTH}/readyz`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function tunnelProcesses(profile?: string): { pid: number; name: string; profile: string }[] {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='tunnel-client.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
      { encoding: "utf8", windowsHide: true },
    );
    const all = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [pid, ...rest] = l.split("|");
        return { name: "tunnel-client.exe", pid: Number(pid), profile: /--profile\s+"?([\w.-]+)/.exec(rest.join("|"))?.[1] ?? "chatbridge" };
      })
      .filter((p) => Number.isFinite(p.pid));
    return profile ? all.filter((p) => p.profile === profile) : all;
  } catch {
    return [];
  }
}

/** Profiles that exist on disk — one yaml per ChatGPT account. */
function tunnelProfiles(): string[] {
  const dir = path.join(TUNNEL_DIR(), "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => f.replace(/\.ya?ml$/, ""));
}

/** Each profile keeps its own log, so two accounts do not interleave. */
function tunnelLog(profile: string): string {
  return path.join(TUNNEL_DIR(), profile === "chatbridge" ? "tunnel.log" : `tunnel-${profile}.log`);
}

/**
 * Adds a second (third, …) ChatGPT account to this PC: its own tunnel profile, its own health port, its own
 * watchdog, and a --name so the audit log says which account did what. The tunnels run side by side.
 */
async function cmdTunnelAdd(a: ParsedArgs) {
  const name = a._[2];
  if (!name || !/^[\w-]+$/.test(name)) throw new Error('usage: chatbridge tunnel add <profile-name> --tunnel-id tunnel_xxx [--key-var GPT_TUNNELS_CONTROL_API_KEY-2]');
  if (name === "chatbridge") throw new Error("that name is taken by the first account");
  const tunnelId = flagString(a, "tunnel-id");
  if (!tunnelId?.startsWith("tunnel_")) throw new Error("--tunnel-id must be the tunnel id from platform.openai.com (starts with tunnel_)");
  const keyVar = flagString(a, "key-var") ?? "GPT_TUNNELS_CONTROL_API_KEY-2";
  if (!process.env[keyVar] && !execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${keyVar}','User')`], { encoding: "utf8", windowsHide: true }).trim()) {
    throw new Error(`the user environment variable ${keyVar} is empty — put that account's API key there first (it never goes in a file)`);
  }
  const dir = TUNNEL_DIR();
  const used = tunnelProfiles().length;
  const healthPort = flagNumber(a, "health-port") ?? 18081 + used;
  const profileFile = path.join(dir, "profiles", `${name}.yaml`);
  if (existsSync(profileFile) && !a.flags.force) throw new Error(`${profileFile} already exists (use --force to overwrite)`);
  const cli = path.resolve(fileURLToPath(new URL("../../bin/chatbridge.mjs", import.meta.url))).split("\\").join("/");
  writeFileSync(
    profileFile,
    [
      "config_version: 1",
      "control_plane:",
      '  base_url: "https://api.openai.com"',
      `  tunnel_id: "${tunnelId}"`,
      `  api_key: "\${${keyVar}}"`,
      "health:",
      `  listen_addr: "127.0.0.1:${healthPort}"`,
      "admin_ui:",
      "  open_browser: false",
      "log:",
      "  level: info",
      "  format: json",
      "mcp:",
      "  commands:",
      "    - channel: main",
      `      command: "node ${cli} stdio --name ${name}"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const vbs = path.join(dir, `start-hidden-${name}.vbs`);
  writeFileSync(
    vbs,
    `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${path.join(dir, "start-tunnel.ps1")}"" run ${name} ${keyVar}", 0, False\r\n`,
  );
  const task = `ChatBridgeTunnelWatchdog-${name}`;
  try {
    execFileSync("schtasks", ["/Create", "/F", "/TN", task, "/SC", "MINUTE", "/MO", "5", "/TR", `wscript.exe "${vbs}"`], { stdio: "ignore", windowsHide: true });
  } catch {
    out(`(could not register the watchdog task ${task}; the tunnel still runs, it just will not restart itself)`);
  }
  out(`profile  ${profileFile}`);
  out(`health   127.0.0.1:${healthPort}`);
  out(`key from ${keyVar} (user environment variable)`);
  out(`watchdog ${task} (every 5 minutes)`);
  out("");
  out(`start it now:  wscript.exe "${vbs}"`);
  out(`then check:    chatbridge tunnel status`);
  out(`In ChatGPT (that account): Settings → developer mode on, then add an app pointing at this tunnel.`);
}

async function cmdTunnel(a: ParsedArgs) {
  const sub = a._[1] ?? "status";
  if (sub === "add") return cmdTunnelAdd(a);
  // One profile per ChatGPT account. Without --profile, status shows them all and restart takes them all.
  const only = flagString(a, "profile");
  const log = tunnelLog(only ?? "chatbridge");
  if (sub === "status") {
    const procs = tunnelProcesses(only);
    const ready = await tunnelReady();
    const known = tunnelProfiles();
    for (const name of only ? [only] : known.length ? known : ["chatbridge"]) {
      const mine = procs.filter((p) => p.profile === name);
      out(`${name.padEnd(12)} ${mine.length ? `running (pid ${mine.map((p) => p.pid).join(", ")})` : "NOT running"}   log: ${tunnelLog(name)}`);
    }
    out(`connected      : ${ready ? "yes — ChatGPT can reach this PC" : "no"}`);
    if (!procs.length) out(`\nstart it: wscript.exe "${path.join(TUNNEL_DIR(), "start-hidden.vbs")}"   (it also starts by itself at logon)`);
    process.exitCode = ready ? 0 : 1;
  } else if (sub === "restart") {
    // Restarting kills the MCP server, and with it every running shell session, so never cut into live work.
    // Card polling (a live terminal, a progress card) is not work in progress, so it does not block a restart.
    const POLLS = new Set(["relay_poll", "shell_peek", "view_screen_frame", "workbench_state", "agent_status", "tools/list", "http.response"]);
    const last = new AuditLog(path.join(dataDir(), "audit", "audit.jsonl")).tail(40).filter((e) => !POLLS.has(e.action) && e.actor !== "workbench").at(-1);
    const idleSec = last ? (Date.now() - Date.parse(last.ts)) / 1000 : Infinity;
    if (idleSec < 180 && !a.flags.force) {
      throw new Error(
        `ChatGPT used this PC ${Math.round(idleSec)}s ago (${last!.action}); restarting now would kill its running commands.\n` +
          `Wait until it is idle, or force it with: chatbridge tunnel restart --force`,
      );
    }
    const procs = tunnelProcesses(only);
    if (!procs.length) throw new Error(only ? `no tunnel is running for profile "${only}"` : "tunnel is not running; start it with start-hidden.vbs");
    for (const p of procs) execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    out("stopped; waiting for it to come back…");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await tunnelReady()) return out("tunnel is back and connected. In ChatGPT, refresh the app's tools if new tools were added.");
    }
    throw new Error(`tunnel did not come back within 60 s — see ${log}`);
  } else if (sub === "logs") {
    if (!existsSync(log)) throw new Error(`no log at ${log}`);
    const lines = readFileSync(log, "utf8").trimEnd().split(/\r?\n/);
    out(lines.slice(-(flagNumber(a, "tail") ?? 40)).join("\n"));
  } else throw new Error("usage: chatbridge tunnel status|restart|logs [--profile name] [--tail N] | add <name> --tunnel-id tunnel_xxx");
}

async function restartTunnelIfRunning() {
  // CHATBRIDGE_HOME points somewhere else: we are working on a scratch profile, and the running tunnel
  // belongs to the real one. Restarting it would interrupt whatever it is doing for no reason.
  if (process.env.CHATBRIDGE_HOME) {
    out(`(config in ${dataDir()} — the running tunnel uses a different profile, leaving it alone)`);
    return;
  }
  if (tunnelProcesses().length) {
    out("restarting the tunnel so the change takes effect…");
    await cmdTunnel(parseArgs(["tunnel", "restart"], []));
  } else out("restart chatbridge (or the tunnel) for the change to take effect.");
}

async function cmdMode(a: ParsedArgs) {
  const mode = a._[1];
  const cfg = loadConfig();
  if (!mode) return out(`mode: ${cfg.policy.mode}`);
  if (mode !== "readonly" && mode !== "full") throw new Error("usage: chatbridge mode readonly|full");
  cfg.policy.mode = mode;
  saveConfig(cfg);
  out(mode === "readonly" ? "readonly: ChatGPT can look at files and the screen but cannot run commands or change anything." : "full: ChatGPT can do everything (commands, files, mouse/keyboard, agents).");
  await restartTunnelIfRunning();
}

async function cmdScope(a: ParsedArgs) {
  const scope = a._[1];
  const cfg = loadConfig();
  if (!scope) {
    out(`scope: ${cfg.policy.scope}`);
    if (cfg.policy.scope === "projects") cmdGrants();
    return;
  }
  if (scope !== "machine" && scope !== "projects") throw new Error("usage: chatbridge scope machine|projects");
  cfg.policy.scope = scope;
  saveConfig(cfg);
  if (scope === "projects") {
    const live = activeGrants();
    out("projects: ChatGPT can only reach folders you grant. Screen/mouse tools are off (policy.projectsAllowDesktop turns them back on).");
    out(live.length ? `granted now:\n  ${live.map(describeGrant).join("\n  ")}` : 'nothing is granted yet — run: chatbridge grant "C:\\你的專案"');
  } else {
    out("machine: the whole computer is available again (grants are kept but not enforced).");
  }
  await restartTunnelIfRunning();
}

function cmdGrants() {
  const live = activeGrants();
  const scope = loadConfig().policy.scope;
  if (!live.length) return out(`no grants${scope === "projects" ? " — ChatGPT cannot reach anything right now" : ""}`);
  for (const g of live) out(describeGrant(g));
  if (scope !== "projects") out("\n(scope is 'machine', so these are not enforced — `chatbridge scope projects` turns them on)");
}

async function cmdGrant(a: ParsedArgs) {
  const target = a._.slice(1).join(" ").trim();
  if (!target) throw new Error('usage: chatbridge grant "C:\\你的專案" [--hours 8] [--note "為什麼"]');
  const resolved = path.resolve(expandHome(target));
  if (!existsSync(resolved)) throw new Error(`no such folder: ${resolved}`);
  const hours = a.flags.hours ? Number(a.flags.hours) : undefined;
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) throw new Error("--hours must be a positive number");
  const g = addGrant(resolved, { hours, note: typeof a.flags.note === "string" ? a.flags.note : undefined });
  out(`granted ${describeGrant(g)}`);
  if (loadConfig().policy.scope !== "projects") out("note: scope is 'machine', so everything is reachable anyway. `chatbridge scope projects` makes grants the only way in.");
}

async function cmdRevoke(a: ParsedArgs) {
  const target = a._.slice(1).join(" ").trim();
  if (!target) throw new Error("usage: chatbridge revoke <id|folder|all>");
  const n = revokeGrant(target);
  out(n ? `revoked ${n} grant(s)` : "nothing matched");
}

/** What was still in flight when the bridge last stopped, and how to pick it up. */
async function cmdRecover(a: ParsedArgs) {
  const rt = await createRuntime({ logger: createLogger("error") });
  try {
    const { HubJobs } = await import("../hub/jobs.js");
    const hub = new HubJobs(rt);
    const { AGENTS } = await import("../hub/agents.js");
    const rows = hub.list().filter((j) => j.status === "interrupted").slice(0, flagNumber(a, "limit") ?? 10);
    if (!rows.length) return out("nothing was left unfinished.");
    for (const j of rows) {
      const stopped = j.interruptedAt ?? j.endedAt;
      out(`${j.id}  ${AGENTS[j.agent].label}  stopped ${stopped ? new Date(stopped).toLocaleString() : "?"}`);
      out(`  in       ${j.cwd}`);
      out(`  task     ${j.task.replace(/\s+/g, " ").slice(0, 160)}`);
      const last = [...j.events].reverse().find((e) => e.kind !== "info");
      out(`  reached  ${last?.text?.replace(/\s+/g, " ").slice(0, 160) ?? "(no steps recorded)"}`);
      if (j.changed?.length) out(`  touched  ${j.changed.map((c) => c.path).join(", ").slice(0, 200)}`);
      out(`  continue ${j.agentSession ? `ask ChatGPT to continue job ${j.id}` : `start it again in ${j.cwd} (check agent_diff ${j.id} first)`}`);
      out("");
    }
  } finally {
    await rt.close();
  }
}

/** Personal questions used for the "is this really you?" check. Answers are only ever stored hashed. */
async function cmdQuiz(a: ParsedArgs) {
  const { addQuestion, askQuestion, answerQuestion, clearVerification, isVerified, listQuestions, removeQuestion } = await import("../core/ownerQuiz.js");
  const sub = a._[1] ?? "status";

  if (sub === "add") {
    // Without --answer the answer is typed at the prompt, so it never reaches the shell history.
    const flagAnswer = flagString(a, "answer");
    const question = (flagAnswer ? a._.slice(2).join(" ") : a._.slice(2).join(" ")).trim() || (await ask("問題（例如「我最喜歡的飲料是什麼？」）："));
    if (!question) throw new Error("no question given");
    const answer = flagAnswer ?? (await ask("答案（只會存雜湊，不會存原文）："));
    if (!answer) throw new Error("no answer given");
    const altSource = flagAnswer ? (flagString(a, "alt") ?? "") : await ask("其他也算對的說法，用逗號分隔（可留空）：");
    const alts = altSource.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    const item = addQuestion(question, answer, alts);
    out(`added ${item.id}: ${item.question}`);
    return;
  }
  if (sub === "remove") {
    const id = a._[2];
    if (!id) throw new Error("usage: chatbridge quiz remove <id>");
    out(removeQuestion(id) ? `removed ${id}` : "nothing matched");
    return;
  }
  if (sub === "test") {
    const q = askQuestion();
    if (!q) return out("no questions yet — add some with: chatbridge quiz add");
    const given = await ask(`${q.question}
> `);
    const r = answerQuestion(given);
    out(r.ok ? "correct ✓" : `wrong: ${r.reason}`);
    // Testing should not leave the bridge unlocked.
    clearVerification();
    return;
  }
  if (sub === "lock") {
    clearVerification();
    return out("verification cleared — the next protected action will ask again");
  }
  if (sub !== "status" && sub !== "list") throw new Error("usage: chatbridge quiz status|add|remove <id>|test|lock");

  const items = listQuestions();
  const cfg = loadConfig();
  out(`questions: ${items.length}`);
  for (const i of items) out(`  ${i.id}  ${i.question}  (asked ${i.asked ?? 0}x)`);
  const asks = [...cfg.policy.askOwnerFor, ...cfg.policy.askOwnerForTools];
  out(`asks before: ${asks.length ? asks.join(", ") : "nothing (set policy.askOwnerForTools, e.g. [\"mouse\",\"keyboard\"])"}`);
  out(`verified now: ${isVerified() ? "yes" : "no"}`);
}

async function cmdName(a: ParsedArgs) {
  const name = a._.slice(1).join(" ").trim();
  const cfg = loadConfig();
  if (!name) return out(`name: ${cfg.server.displayName ?? "(not set — using the Windows computer name)"}`);
  cfg.server.displayName = name;
  saveConfig(cfg);
  out(`this computer is now called "${name}"`);
  await restartTunnelIfRunning();
}

/** The Drive lane: a cloud-synced folder with 收件 / 寄件 subfolders. */
async function cmdDrive(a: ParsedArgs) {
  const cfg = loadConfig();
  const sub = a._[1] ?? "status";
  if (sub === "set") {
    const folder = a._.slice(2).join(" ").trim();
    if (!folder) throw new Error('usage: chatbridge drive set "H:\\我的雲端硬碟\\ChatBridge"');
    const abs = path.resolve(folder);
    mkdirSync(path.join(abs, "收件"), { recursive: true });
    mkdirSync(path.join(abs, "寄件"), { recursive: true });
    cfg.drive.folder = abs;
    saveConfig(cfg);
    out(`Drive folder set: ${abs}\n  收件 = files you drop in for the PC\n  寄件 = files the PC sends you`);
    await restartTunnelIfRunning();
    return;
  }
  if (sub === "account") {
    const email = a._.slice(2).join(" ").trim();
    if (!email) {
      return out(cfg.drive.account ? `Drive account: ${cfg.drive.account}` : "Drive account: not set (the model will not be told which Google account to expect)");
    }
    cfg.drive.account = email === "none" ? undefined : email;
    saveConfig(cfg);
    out(cfg.drive.account ? `Drive account: ${cfg.drive.account} — the model is told to check the connector is signed in to this one before reading.` : "Drive account cleared.");
    await restartTunnelIfRunning();
    return;
  }
  if (sub === "off") {
    delete cfg.drive.folder;
    saveConfig(cfg);
    out("Drive folder disabled.");
    await restartTunnelIfRunning();
    return;
  }
  if (sub !== "status") throw new Error("usage: chatbridge drive status|set <folder>|account <email>|off");
  if (!cfg.drive.folder) return out('Drive folder: not set (chatbridge drive set "H:\\我的雲端硬碟\\ChatBridge")');
  out(`Drive folder: ${cfg.drive.folder} ${existsSync(cfg.drive.folder) ? "" : "(NOT FOUND — is Google Drive running?)"}`);
  out(`account: ${cfg.drive.account ?? "not set (chatbridge drive account <email>)"}`);
  out(`old files in 寄件 are removed after ${cfg.drive.keepDays} days`);
}

/** Object storage for fast PC → chat transfers (Cloudflare R2 or any S3-compatible service). */
async function cmdStorage(a: ParsedArgs) {
  const sub = a._[1] ?? "status";
  if (sub === "set") {
    const endpoint = flagString(a, "endpoint");
    const bucket = flagString(a, "bucket");
    const accessKeyId = flagString(a, "key-id");
    if (!endpoint || !bucket || !accessKeyId) throw new Error("usage: chatbridge storage set --endpoint https://<account-id>.r2.cloudflarestorage.com --bucket <name> --key-id <access key id>   (the secret is asked for)");
    // The secret is typed here rather than passed as a flag, so it stays out of shell history.
    const secretAccessKey = flagString(a, "secret") ?? (await ask("Secret Access Key: "));
    if (!secretAccessKey) throw new Error("no secret given");
    saveStoreConfig({ endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey, region: "auto" });
    out(`saved to ${path.join(dataDir(), "storage.json")}. Next: chatbridge storage setup`);
    return;
  }
  if (sub === "off") {
    const file = path.join(dataDir(), "storage.json");
    if (existsSync(file)) rmSync(file);
    return out("object storage disabled; the upload card uses the (slow) tunnel again.");
  }
  const store = objectStore();
  if (!store) {
    out("object storage: not set up (the upload card goes through the tunnel, ~0.5 MB/s).");
    out("set up: chatbridge storage set --endpoint … --bucket … --key-id …");
    return;
  }
  if (sub === "status") return out(`object storage: ${store.cfg.bucket} @ ${store.origin}`);
  if (sub === "setup") {
    for (const line of await store.setupBucket()) out(`✓ ${line}`);
    return;
  }
  if (sub === "test") {
    const tmp = path.join(os.tmpdir(), `chatbridge-storage-test-${Date.now()}.bin`);
    writeFileSync(tmp, randomBytes(16 * 1024 * 1024));
    try {
      const r = await store.selfTest(tmp);
      const mbps = (ms: number) => ((r.bytes / 1048576) / Math.max(ms / 1000, 0.001)).toFixed(1);
      out(`${r.ok ? "✓" : "✗"} 16 MB round trip: upload ${(r.uploadMs / 1000).toFixed(1)} s (${mbps(r.uploadMs)} MB/s), download ${(r.downloadMs / 1000).toFixed(1)} s (${mbps(r.downloadMs)} MB/s)${r.ok ? "" : " — content mismatch"}`);
      process.exitCode = r.ok ? 0 : 1;
    } finally {
      rmSync(tmp, { force: true });
    }
    return;
  }
  throw new Error("usage: chatbridge storage status|set|setup|test|off");
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))));
}

/** Opens the local workbench page (full-size UI for the PC, outside ChatGPT's card). */
async function cmdWorkbench(a: ParsedArgs) {
  const cfg = loadConfig();
  const { workbenchToken } = await import("./workbenchWeb.js");
  const token = workbenchToken(a.flags["new-token"] === true);
  const cwd = flagString(a, "cwd") ?? a._[1];
  const url = `http://127.0.0.1:${cfg.server.port}/workbench?t=${encodeURIComponent(token)}${cwd ? `&cwd=${encodeURIComponent(path.resolve(cwd))}` : ""}`;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.server.port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error("not ok");
  } catch {
    throw new Error(`nothing is serving on port ${cfg.server.port} — start it with: chatbridge serve`);
  }
  out(url);
  if (process.platform === "win32" && a.flags.open !== false) spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function cmdAgents() {
  const { AGENTS, agentIds } = await import("../hub/agents.js");
  const file = path.join(dataDir(), "hub", "health.json");
  const health: Record<string, any> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const id of agentIds()) {
    const h = health[id];
    const installed = !!AGENTS[id].resolve();
    const state = !installed ? "not installed" : h ? `${h.ok ? "works" : "NOT working"} (checked ${String(h.checkedAt).slice(0, 16).replace("T", " ")})` : "not checked";
    out(`${AGENTS[id].label.padEnd(16)} ${state}${h && !h.ok ? `\n${" ".repeat(17)}${String(h.detail).split("\n")[0]!.slice(0, 110)}` : ""}`);
  }
  out(`\nRe-check from ChatGPT with agents_check, or: node spike/check-agents.mjs`);
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv, ["force", "verify", "totp", "web", "telegram", "scheduler"]);
  const cmd = a._[0];
  switch (cmd) {
    case "init":
      return cmdInit(a);
    case "serve":
      return cmdServe(a);
    case "up":
      return cmdServe(a, true);
    case "stdio":
      return cmdStdio(a);
    case "status":
      return cmdStatus();
    case "pause":
      return cmdPause(a, true);
    case "resume":
      return cmdPause(a, false);
    case "audit":
      return cmdAudit(a);
    case "clients":
      return cmdClients(a);
    case "token":
      return cmdToken(a);
    case "admin-url":
      return cmdAdminUrl();
    case "passphrase":
      return cmdPassphrase(a);
    case "totp":
      return cmdTotp(a);
    case "set-public-url":
      return cmdSetPublicUrl(a);
    case "connect-info":
      return cmdConnectInfo();
    case "autostart":
      return cmdAutostart(a);
    case "doctor":
      return cmdDoctor();
    case "tunnel":
      return cmdTunnel(a);
    case "scope":
      return cmdScope(a);
    case "grant":
      return cmdGrant(a);
    case "grants":
      return cmdGrants();
    case "revoke":
      return cmdRevoke(a);
    case "quiz":
      return cmdQuiz(a);
    case "recover":
      return cmdRecover(a);
    case "mode":
      return cmdMode(a);
    case "name":
      return cmdName(a);
    case "agents":
      return cmdAgents();
    case "workbench":
      return cmdWorkbench(a);
    case "storage":
      return cmdStorage(a);
    case "drive":
      return cmdDrive(a);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
