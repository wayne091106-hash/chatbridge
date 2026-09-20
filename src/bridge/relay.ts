/**
 * Relay: text typed in the local workbench that should reach the ChatGPT conversation. The card in that
 * conversation is the only thing that can speak into it (window.openai.sendFollowUpMessage), so it picks
 * messages up from here.
 *
 * The workbench page and the card live in different processes (`chatbridge serve` and the tunnel's
 * `chatbridge stdio`), so the queue is a small file both of them share. Messages are delivered once and
 * expire after an hour.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { dataDir } from "../core/config.js";
import type { Runtime } from "../core/runtime.js";
import type { DefineTool } from "./tools.js";
import { cardResult } from "./widgets.js";

interface RelayMessage {
  text: string;
  at: number;
}
const file = () => path.join(dataDir(), "relay.json");
const MAX_AGE = 3600_000;

function read(): RelayMessage[] {
  if (!existsSync(file())) return [];
  try {
    const now = Date.now();
    return (JSON.parse(readFileSync(file(), "utf8")) as RelayMessage[]).filter((m) => m && typeof m.text === "string" && now - m.at < MAX_AGE);
  } catch {
    return [];
  }
}

function write(list: RelayMessage[]) {
  writeFileSync(file(), JSON.stringify(list.slice(-20)), { mode: 0o600 });
}

export function queueRelay(text: string): number {
  const list = read();
  list.push({ text, at: Date.now() });
  write(list);
  return list.length;
}

export function takeRelay(): string[] {
  const list = read();
  if (list.length) write([]);
  return list.map((m) => m.text);
}

export function relayPending(): number {
  return read().length;
}

export function registerRelay(define: DefineTool, _rt: Runtime) {
  define(
    "relay_poll",
    {
      title: "Workbench messages (for cards)",
      description: "Internal: messages the user typed in the local workbench, to be spoken into this conversation by the card.",
      input: { take: z.boolean().optional() },
      effect: "read",
      meta: { "openai/widgetAccessible": true, "openai/visibility": "private" },
    },
    async (a) => {
      const messages = a.take === false ? [] : takeRelay();
      return cardResult({ pending: a.take === false ? relayPending() : messages.length }, { messages }, [{ type: "text", text: `${messages.length} message(s)` }]);
    },
  );
}
