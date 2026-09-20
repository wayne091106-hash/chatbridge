import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BridgeConfigSchema, type BridgeConfig } from "../src/core/config.js";
import { findCodexBinary } from "../src/core/execServer.js";

export function tempDir(prefix = "cb-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* windows file locks */
      }
    },
  };
}

export function testConfig(overrides: Record<string, any> = {}): BridgeConfig {
  return BridgeConfigSchema.parse({
    logLevel: "error",
    ...overrides,
  });
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export const hasCodex = !!findCodexBinary() && process.env.SKIP_CODEX !== "1";

/** What a card sees: light structuredContent merged with the card-only _meta["chatbridge/card"]. */
export function cardOf(r: any): any {
  return { ...(r?.structuredContent ?? {}), ...(r?._meta?.["chatbridge/card"] ?? {}) };
}
