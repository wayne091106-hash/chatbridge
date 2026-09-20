/**
 * A small Chrome DevTools Protocol client.
 *
 * Driving a browser through screenshots and pixel coordinates is guesswork: the page has a DOM, so we can
 * name the thing we want instead of aiming at it. This talks CDP over the WebSocket that Node now ships
 * with, so the bridge gains browser control without pulling in Puppeteer or Playwright.
 *
 * Chrome runs under its own profile directory, not the owner's: a model driving the browser should not
 * inherit every session the owner is signed into. Logins made inside it do persist, so signing in once is
 * enough.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./config.js";
import { sleep } from "./util.js";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function findChrome(explicit?: string): string | null {
  const list = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  return list.find((p) => p && existsSync(p)) ?? null;
}

export const browserProfileDir = () => path.join(dataDir(), "browser-profile");

/** One CDP connection to one page. */
export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events = new Map<string, Array<(params: any) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "CDP error"}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.events.get(msg.method) ?? []) fn(msg.params);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("the browser connection closed"));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting to the browser")), timeoutMs);
      ws.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error("could not connect to the browser"))), { once: true });
    });
    return new CdpSession(ws);
  }

  on(method: string, fn: (params: any) => void) {
    const list = this.events.get(method) ?? [];
    list.push(fn);
    this.events.set(method, list);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the page and returns its value, turning a thrown page error into a real error. */
  async evaluate<T = any>(expression: string, timeoutMs = 30_000): Promise<T> {
    const r = await this.send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "the page threw an error");
    }
    return r.result?.value as T;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

async function httpJson<T>(url: string, timeoutMs = 3000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as T;
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const all = await httpJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`);
  return all.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
}

export async function newTab(port: number, url: string): Promise<CdpTarget> {
  // /json/new needs PUT on current Chrome builds.
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`could not open a tab (${r.status})`);
  return (await r.json()) as CdpTarget;
}

export async function closeTab(port: number, id: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
}

export async function browserAlive(port: number): Promise<boolean> {
  try {
    await httpJson(`http://127.0.0.1:${port}/json/version`, 1500);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  port: number;
  chromePath?: string;
  /** Use the owner's own Chrome profile instead of the bridge's. Off by default: that profile holds every session they are signed into. */
  ownProfile?: boolean;
  headless?: boolean;
  startUrl?: string;
}

export async function launchBrowser(o: LaunchOptions): Promise<{ pid?: number; reused: boolean }> {
  if (await browserAlive(o.port)) return { reused: true };
  const exe = findChrome(o.chromePath);
  if (!exe) throw new Error("no Chrome or Edge found on this PC (set browser.chromePath in ~/.chatbridge/config.json)");
  const profile = o.ownProfile ? path.join(os.homedir(), "AppData/Local/Google/Chrome/User Data") : browserProfileDir();
  const args = [
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationGuideModelDownloading",
    ...(o.headless ? ["--headless=new"] : []),
    o.startUrl ?? "about:blank",
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await browserAlive(o.port)) return { pid: child.pid, reused: false };
  }
  throw new Error(`the browser did not open its debugging port (${o.port}) within 10s`);
}
