import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";

export const ShellKindSchema = z.enum(["powershell", "pwsh", "cmd", "bash", "sh", "direct"]);

export const BridgeConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8765),
      /** Public HTTPS origin the connector uses (tunnel URL). Required for OAuth. */
      publicUrl: z.string().url().optional(),
      /** Extra Host headers accepted (DNS-rebinding protection). */
      allowedHosts: z.array(z.string()).default([]),
      /** Name shown to ChatGPT/Claude for this computer (useful with several PCs). Defaults to the hostname. */
      displayName: z.string().optional(),
    })
    .prefault({}),
  auth: z
    .object({
      mode: z.enum(["oauth", "token", "none"]).default("oauth"),
      ownerPasswordHash: z.string().optional(),
      totpSecret: z.string().optional(),
      /** sha256 hashes of static bearer tokens (for tunnel-client, scripts, Claude Desktop). */
      staticTokens: z.array(z.object({ name: z.string(), hash: z.string(), createdAt: z.string() })).default([]),      /** OAuth redirect URIs must point at one of these hosts (blocks phishing clients). */
      allowedRedirectHosts: z
        .array(z.string())
        .default(["chatgpt.com", "chat.openai.com", "platform.openai.com", "claude.ai", "claude.com", "localhost", "127.0.0.1"]),
      /** sha256 of the local admin dashboard token. */
      adminTokenHash: z.string().optional(),
      accessTokenTtlSec: z.number().int().positive().default(3600),
      refreshTokenTtlSec: z.number().int().positive().default(30 * 24 * 3600),
    })
    .prefault({}),
  executor: z
    .object({
      kind: z.enum(["auto", "codex", "node"]).default("auto"),
      codexPath: z.string().optional(),
      /** Attach to an existing exec-server instead of spawning one. */
      url: z.string().optional(),
      pinnedVersion: z.string().optional(),
    })
    .prefault({}),
  shell: z
    .object({
      default: ShellKindSchema.optional(),
      cwd: z.string().optional(),
      defaultYieldSeconds: z.number().positive().default(25),
    })
    .prefault({}),
  policy: z
    .object({
      /** full = everything allowed (owner's choice); readonly = no mutations or commands. */
      mode: z.enum(["full", "readonly"]).default("full"),
      /**
       * machine = the whole computer is reachable (the owner's default choice).
       * projects = only folders with a live grant (see `chatbridge grant`) can be touched.
       */
      scope: z.enum(["machine", "projects"]).default("machine"),
      /** Folders always reachable in projects scope, on top of the bridge's own state and temp. */
      alwaysAllow: z.array(z.string()).default([]),
      /** Screen capture, mouse and window control stay off in projects scope unless this is set. */
      projectsAllowDesktop: z.boolean().default(false),
      /**
       * Effects that require the owner to have answered a personal question recently (see ownerQuiz).
       * Empty by default. e.g. ["execute","desktop"] makes commands and mouse/keyboard ask first.
       */
      askOwnerFor: z.array(z.enum(["read", "write", "execute", "desktop"])).default([]),
      /**
       * Individual tools that require it, when a whole effect is too broad — e.g. ["mouse","keyboard"]
       * asks before the PC is physically driven, but leaves screenshots and everything else alone.
       */
      askOwnerForTools: z.array(z.string()).default([]),
      denyCommandPatterns: z.array(z.string()).default([]),
      denyPathPatterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  features: z
    .object({
      gui: z.boolean().default(true),
      /** Legacy Kestrel agent tools (replaced by the agent hub). */
      agent: z.boolean().default(false),
      /** Agent hub: hand tasks to installed coding agents (Codex, Claude Code, Kilo, OpenCode, Cline, Gemini). */
      hub: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * A cloud-synced folder (e.g. Google Drive for desktop) used as the fast lane for files between the PC and
   * the owner's other devices: <folder>/收件 is what the owner drops in, <folder>/寄件 is what the PC hands out.
   */
  drive: z
    .object({
      folder: z.string().optional(),
      /**
       * Which Google account the synced folder belongs to, e.g. "you@gmail.com". Only used to tell the
       * model which account its Drive connector must be signed in to, so it cannot read someone else's.
       */
      account: z.string().optional(),
      /** Files in 寄件 older than this are deleted when new files are sent. */
      keepDays: z.number().int().min(1).max(365).default(7),
    })
    .prefault({}),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function dataDir(): string {
  return process.env.CHATBRIDGE_HOME ?? path.join(os.homedir(), ".chatbridge");
}

export function configPath(dir = dataDir()): string {
  return path.join(dir, "config.json");
}

export function loadConfig(dir = dataDir()): BridgeConfig {
  const file = configPath(dir);
  let raw: unknown = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    raw = JSON.parse(text);
  }
  const parsed = BridgeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const cfg = parsed.data;
  if (process.env.CHATBRIDGE_PORT) cfg.server.port = Number(process.env.CHATBRIDGE_PORT);
  if (process.env.CHATBRIDGE_PUBLIC_URL) cfg.server.publicUrl = process.env.CHATBRIDGE_PUBLIC_URL;
  return cfg;
}

export function saveConfig(cfg: BridgeConfig, dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2) + "\n");
}

/** Runtime state that changes while running (kill switch). */
export class RuntimeState {
  private file: string;
  paused = false;
  pausedReason = "";

  constructor(dir = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.reload();
  }

  reload() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      this.paused = !!s.paused;
      this.pausedReason = s.pausedReason ?? "";
    } catch {
      /* ignore */
    }
  }

  setPaused(paused: boolean, reason = "") {
    this.paused = paused;
    this.pausedReason = reason;
    writeFileSync(this.file, JSON.stringify({ paused, pausedReason: reason, updatedAt: new Date().toISOString() }, null, 2));
  }
}
