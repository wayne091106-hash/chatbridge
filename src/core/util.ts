import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function randomId(prefix = "", bytes = 8): string {
  return prefix + randomBytes(bytes).toString("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// CSI / OSC / single-char escape sequences plus stray control chars (keep \n \r \t).
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Normalise terminal output for a model: strip escapes, resolve CRLF and bare-CR progress lines. */
export function cleanTerminalOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

/** Keep head and tail of long text so both the command echo and final result stay visible. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 80);
  const head = Math.floor(keep * 0.4);
  const tail = keep - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…[${omitted} characters omitted]…\n\n${text.slice(text.length - tail)}`;
}

/** Rough token estimate that treats CJK characters as ~1 token each. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function toFileUri(p: string): string {
  return pathToFileURL(path.resolve(p)).href;
}

export function fromFileUri(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
}

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", p.slice(1));
  }
  return p;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export class AsyncQueue {
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }
}
