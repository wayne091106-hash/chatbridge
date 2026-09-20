import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { dataDir } from "../core/config.js";
import { PRESETS, type ModelProfile } from "./providers/index.js";

const ProfileSchema = z.object({
  provider: z.enum(["openai", "anthropic", "codex", "mock"]),
  model: z.string().default(""),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  supportsImages: z.boolean().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

export const TOOLSETS = ["core", "desktop", "web", "memory", "skills", "planning", "delegation", "schedule", "codex"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const KestrelConfigSchema = z.object({
  defaultProfile: z.string().default("codex"),
  /** Tried in order when the active profile fails (rate limit, outage). */
  fallbackProfiles: z.array(z.string()).default([]),
  /** Cheaper/faster profile for reflection and compaction; defaults to defaultProfile. */
  auxiliaryProfile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  agent: z
    .object({
      name: z.string().default("Kestrel"),
      persona: z.string().default(""),
      language: z.string().default("auto"),
      maxIterations: z.number().int().min(1).max(500).default(80),
      toolOutputChars: z.number().int().min(1000).default(24_000),
      compactAtRatio: z.number().min(0.2).max(0.95).default(0.72),
      keepRecentMessages: z.number().int().min(2).default(14),
      autoReflect: z.boolean().default(true),
      reflectEveryTurns: z.number().int().min(1).default(6),
      /** Minimum tool calls in a session before a skill may be distilled. */
      skillMinToolCalls: z.number().int().min(1).default(5),
      toolsets: z.array(z.enum(TOOLSETS)).default([...TOOLSETS]),
      maxParallelSubagents: z.number().int().min(1).max(16).default(4),
      subagentMaxIterations: z.number().int().min(1).default(40),
      memoriesInPrompt: z.number().int().min(0).max(50).default(10),
      skillsInPrompt: z.number().int().min(0).max(50).default(8),
    })
    .prefault({}),
  scheduler: z.object({ enabled: z.boolean().default(true), tickSeconds: z.number().int().min(5).default(30) }).prefault({}),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      tokenEnv: z.string().default("KESTREL_TELEGRAM_TOKEN"),
      allowedUserIds: z.array(z.number().int()).default([]),
    })
    .prefault({}),
  web: z.object({ port: z.number().int().default(8791), tokenHash: z.string().optional() }).prefault({}),
});

export type KestrelConfig = z.infer<typeof KestrelConfigSchema>;

export function kestrelHome(): string {
  return process.env.KESTREL_HOME ?? path.join(dataDir(), "kestrel");
}

export function loadKestrelConfig(home = kestrelHome()): KestrelConfig {
  const file = path.join(home, "config.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : {};
  const parsed = KestrelConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return parsed.data;
}

export function saveKestrelConfig(cfg: KestrelConfig, home = kestrelHome()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

/** Resolve a profile by name from config, falling back to built-in presets. */
export function resolveProfile(cfg: KestrelConfig, name: string): ModelProfile {
  const p = cfg.profiles[name] ?? PRESETS[name];
  if (!p) throw new Error(`unknown model profile "${name}" (known: ${[...new Set([...Object.keys(cfg.profiles), ...Object.keys(PRESETS)])].join(", ")})`);
  return p as ModelProfile;
}
