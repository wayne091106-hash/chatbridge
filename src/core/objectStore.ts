/**
 * Optional S3-compatible object store (Cloudflare R2, Backblaze B2, …) used as a fast data channel:
 * the PC uploads a file at full speed and hands out a short-lived presigned link, so big files never
 * travel through the MCP tunnel. Credentials live in ~/.chatbridge/storage.json (written by
 * `chatbridge storage set`), never in tool results.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { AwsClient } from "aws4fetch";
import { dataDir } from "./config.js";
import { randomToken } from "./util.js";

export interface StoreConfig {
  endpoint: string; // e.g. https://<account-id>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // "auto" for R2
}

/** Uploaded objects live under this prefix; the bucket lifecycle rule deletes them after a day. */
export const STORE_PREFIX = "chatbridge-xfer/";

const storeFile = () => path.join(dataDir(), "storage.json");

export function loadStoreConfig(): StoreConfig | null {
  if (!existsSync(storeFile())) return null;
  try {
    const c = JSON.parse(readFileSync(storeFile(), "utf8"));
    return c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey ? c : null;
  } catch {
    return null;
  }
}

export function saveStoreConfig(c: StoreConfig) {
  writeFileSync(storeFile(), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

export class ObjectStore {
  private aws: AwsClient;
  constructor(readonly cfg: StoreConfig) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region ?? "auto" });
  }

  /** Origin the browser downloads from (for the card's CSP). */
  get origin(): string {
    return new URL(this.cfg.endpoint).origin;
  }

  private url(key: string, query = ""): string {
    const k = key.split("/").map(encodeURIComponent).join("/");
    return `${this.cfg.endpoint.replace(/\/+$/, "")}/${this.cfg.bucket}${key ? `/${k}` : ""}${query}`;
  }

  newKey(fileName: string): string {
    return `${STORE_PREFIX}${new Date().toISOString().slice(0, 10)}/${randomToken(12)}/${fileName}`;
  }

  /** Streams a local file up; onProgress gets bytes sent so far. */
  async putFile(key: string, file: string, contentType: string, onProgress?: (sent: number) => void): Promise<void> {
    const size = statSync(file).size;
    let sent = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length;
        onProgress?.(sent);
        cb(null, chunk);
      },
    });
    const body = Readable.toWeb(createReadStream(file).pipe(meter)) as unknown as ReadableStream;
    const res = await this.aws.fetch(this.url(key), {
      method: "PUT",
      body,
      // Streaming upload: the payload is not hashed up front.
      headers: { "Content-Type": contentType, "Content-Length": String(size), "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" },
      duplex: "half",
    } as RequestInit);
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  /** A GET link that works without credentials for `seconds`. */
  async presignGet(key: string, seconds = 600): Promise<string> {
    const signed = await this.aws.sign(this.url(key, `?X-Amz-Expires=${seconds}`), { method: "GET", aws: { signQuery: true } });
    return signed.url;
  }

  async delete(key: string): Promise<void> {
    await this.aws.fetch(this.url(key), { method: "DELETE" });
  }

  /**
   * One-time bucket setup: let the ChatGPT card (a browser page on another origin) download presigned
   * links, and delete transferred files after one day.
   */
  async setupBucket(): Promise<string[]> {
    const done: string[] = [];
    const cors = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
    await this.putBucketXml("?cors", cors);
    done.push("CORS: browser downloads of presigned links allowed");
    const lifecycle = `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration><Rule><ID>chatbridge-xfer-cleanup</ID><Status>Enabled</Status><Filter><Prefix>${STORE_PREFIX}</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>`;
    await this.putBucketXml("?lifecycle", lifecycle);
    done.push(`lifecycle: files under ${STORE_PREFIX} are deleted after 1 day`);
    return done;
  }

  private async putBucketXml(query: string, xml: string) {
    const res = await this.aws.fetch(this.url("", query), {
      method: "PUT",
      body: xml,
      headers: { "Content-Type": "application/xml", "Content-MD5": createHash("md5").update(xml).digest("base64") },
    });
    if (!res.ok) throw new Error(`${query.slice(1)} setup failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  /** Round trip check used by `chatbridge storage test`. */
  async selfTest(tmpFile: string): Promise<{ uploadMs: number; downloadMs: number; bytes: number; ok: boolean }> {
    const key = this.newKey(path.basename(tmpFile));
    const t0 = Date.now();
    await this.putFile(key, tmpFile, "application/octet-stream");
    const t1 = Date.now();
    const res = await fetch(await this.presignGet(key, 120));
    const buf = Buffer.from(await res.arrayBuffer());
    const t2 = Date.now();
    await this.delete(key);
    const ok = res.ok && createHash("sha256").update(buf).digest("hex") === createHash("sha256").update(readFileSync(tmpFile)).digest("hex");
    return { uploadMs: t1 - t0, downloadMs: t2 - t1, bytes: buf.length, ok };
  }
}

export function objectStore(): ObjectStore | null {
  const c = loadStoreConfig();
  return c ? new ObjectStore(c) : null;
}
