import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyHunks, applyPatch, parsePatch, PatchError } from "../src/core/patch.js";
import { base32Encode, generatePassphrase, hashPassword, totp, verifyPassword, verifyTotp } from "../src/bridge/secrets.js";
import { AuditLog } from "../src/core/audit.js";
import { cleanTerminalOutput, estimateTokens, truncateMiddle } from "../src/core/util.js";
import { parseArgs } from "../src/core/args.js";
import { globToRegExp } from "../src/core/files.js";
import { splitArgs } from "../src/core/shell.js";
import { escapeSendKeys } from "../src/core/desktop.js";
import { Policy } from "../src/core/policy.js";
import { testConfig, tempDir } from "./helpers.js";

test("patch: update with context, preserves CRLF and trailing newline", () => {
  const original = "a\r\nb\r\nc\r\nd\r\n";
  const ops = parsePatch("*** Begin Patch\n*** Update File: x.txt\n@@\n b\n-c\n+C1\n+C2\n d\n*** End Patch");
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.equal(op.type, "update");
  const out = applyHunks(original, (op as any).hunks);
  assert.equal(out, "a\r\nb\r\nC1\r\nC2\r\nd\r\n");
});

test("patch: anchor, whitespace-tolerant match, multiple hunks, EOF insert", () => {
  const original = "class A:\n    def f(self):\n        return 1\n\nclass B:\n    def f(self):\n        return 1\n";
  const ops = parsePatch(
    [
      "*** Begin Patch",
      "*** Update File: m.py",
      "@@ class B:",
      "     def f(self):",
      "-        return 1   ",
      "+        return 2",
      "@@",
      "+# end",
      "*** End of File",
      "*** End Patch",
    ].join("\n"),
  );
  const out = applyHunks(original, (ops[0] as any).hunks);
  assert.match(out, /class A:\n    def f\(self\):\n        return 1\n/);
  assert.match(out, /class B:\n    def f\(self\):\n        return 2\n# end\n$/);
});

test("patch: add/delete/move against a fake fs is atomic on failure", async () => {
  const files = new Map<string, string>([[path.resolve("/base/keep.txt"), "one\ntwo\n"]]);
  const fs = {
    readFile: async (p: string) => Buffer.from(files.get(p) ?? ""),
    writeFile: async (p: string, d: string) => void files.set(p, d),
    remove: async (p: string) => void files.delete(p),
    exists: async (p: string) => files.has(p),
    mkdirp: async () => {},
  };
  await assert.rejects(
    applyPatch("*** Begin Patch\n*** Add File: new.txt\n+hi\n*** Update File: keep.txt\n@@\n-missing\n+x\n*** End Patch", path.resolve("/base"), fs),
    PatchError,
  );
  assert.equal(files.has(path.resolve("/base/new.txt")), false, "nothing written when a hunk fails");

  const r = await applyPatch(
    "*** Begin Patch\n*** Add File: new.txt\n+hi\n+there\n*** Update File: keep.txt\n*** Move to: moved.txt\n@@\n one\n-two\n+2\n*** End Patch",
    path.resolve("/base"),
    fs,
  );
  assert.deepEqual(r.added, [path.resolve("/base/new.txt")]);
  assert.equal(files.get(path.resolve("/base/new.txt")), "hi\nthere\n");
  assert.equal(files.get(path.resolve("/base/moved.txt")), "one\n2\n");
  assert.equal(files.has(path.resolve("/base/keep.txt")), false);
});

test("patch: rejects malformed input", () => {
  assert.throws(() => parsePatch("no markers"), PatchError);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\nnot-plus\n*** End Patch"), PatchError);
  assert.throws(() => applyHunks("x\n", [{ oldLines: ["y"], newLines: ["z"], endOfFile: false }]), PatchError);
});

test("secrets: RFC 6238 TOTP vector and password hashing", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totp(secret, 59_000), "287082");
  assert.equal(totp(secret, 1111111109_000), "081804");
  assert.ok(verifyTotp(secret, "287082", 59_000));
  assert.ok(!verifyTotp(secret, "000000", 59_000));
  const pass = generatePassphrase();
  assert.match(pass, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
  const h = hashPassword(pass);
  assert.ok(verifyPassword(pass, h));
  assert.ok(!verifyPassword(pass + "x", h));
  assert.ok(!verifyPassword(pass, undefined));
});

test("audit: hash chain detects tampering and redacts secrets", () => {
  const t = tempDir();
  try {
    const file = path.join(t.dir, "audit.jsonl");
    const log = new AuditLog(file);
    log.write({ actor: "a", action: "x", args: { api_key: "sk-123", path: "C:/x" }, outcome: "ok" });
    log.write({ actor: "a", action: "y", outcome: "error", detail: "boom" });
    assert.deepEqual(log.verify(), { ok: true, records: 2 });
    assert.equal((log.tail(1)[0] as any).seq, 2);
    assert.equal((log.tail(2)[0]!.args as any).api_key, "[redacted]");
    // Continue chain from a new instance.
    new AuditLog(file).write({ actor: "b", action: "z", outcome: "ok" });
    assert.equal(new AuditLog(file).verify().ok, true);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[1] = lines[1]!.replace('"boom"', '"b00m"');
    writeFileSync(file, lines.join("\n"));
    const v = new AuditLog(file).verify();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
    appendFileSync(file, "garbage\n");
  } finally {
    t.cleanup();
  }
});

test("audit: a fresh log that continues an archived log still verifies; an unknown link does not", () => {
  const t = tempDir();
  try {
    const file = path.join(t.dir, "audit.jsonl");
    const running = new AuditLog(file);
    running.write({ actor: "a", action: "before-archive", outcome: "ok" });
    // The owner archives the log while a process is still running; that process keeps chaining.
    renameSync(file, path.join(t.dir, "audit-2026-09-18.jsonl"));
    running.write({ actor: "a", action: "after-archive", outcome: "ok" });
    assert.deepEqual(new AuditLog(file).verify(), { ok: true, records: 1 });
    // A first record linking to nothing we know about is still reported.
    rmSync(path.join(t.dir, "audit-2026-09-18.jsonl"));
    assert.equal(new AuditLog(file).verify().ok, false);
  } finally {
    t.cleanup();
  }
});

test("audit: two writers on the same file keep one valid chain", () => {
  const t = tempDir();
  try {
    const file = path.join(t.dir, "audit.jsonl");
    const server = new AuditLog(file); // long-running process
    const cli = new AuditLog(file); // separate CLI invocation
    server.write({ actor: "server", action: "a", outcome: "ok" });
    cli.write({ actor: "cli", action: "b", outcome: "ok" });
    server.write({ actor: "server", action: "c", outcome: "ok" });
    cli.write({ actor: "cli", action: "d", outcome: "ok" });
    assert.deepEqual(new AuditLog(file).verify(), { ok: true, records: 4 });
    assert.deepEqual(new AuditLog(file).tail(4).map((r) => r.seq), [1, 2, 3, 4]);
  } finally {
    t.cleanup();
  }
});

test("util: terminal cleanup, truncation, token estimate", () => {
  assert.equal(cleanTerminalOutput("\x1b[32mgreen\x1b[0m\r\nprogress 10%\rprogress 100%\n\x1b]0;title\x07done"), "green\nprogress 100%\ndone");
  const long = "a".repeat(1000) + "END";
  const t = truncateMiddle(long, 200);
  assert.ok(t.length < 260 && t.endsWith("END") && t.includes("omitted"));
  assert.ok(estimateTokens("你好世界") === 4);
  assert.ok(estimateTokens("hello world, this is text") >= 5);
});

test("args, glob, splitArgs, sendkeys, policy", () => {
  const a = parseArgs(["run", "--model", "x", "--json", "--n=3", "--no-color", "rest"], ["json"]);
  assert.deepEqual(a._, ["run", "rest"]);
  assert.equal(a.flags.model, "x");
  assert.equal(a.flags.json, true);
  assert.equal(a.flags.n, "3");
  assert.equal(a.flags.color, false);
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("*.{py,ts}").test("x.py"));
  assert.ok(!globToRegExp("*.py").test("dir/x.py"));
  assert.deepEqual(splitArgs(`git commit -m "hello world" 'x y'`), ["git", "commit", "-m", "hello world", "x y"]);
  assert.equal(escapeSendKeys("a+b(c)\n"), "a{+}b{(}c{)}{ENTER}");
  const p = new Policy(testConfig({ policy: { denyCommandPatterns: ["format\\s+c:"], denyPathPatterns: ["/\\.ssh/"] } }).policy);
  assert.equal(p.check("execute", { command: "format C:" }).allowed, false);
  assert.equal(p.check("read", { paths: ["C:\\Users\\me\\.ssh\\id_rsa"] }).allowed, false);
  assert.equal(p.check("execute", { command: "dir" }).allowed, true);
  const ro = new Policy(testConfig({ policy: { mode: "readonly" } }).policy);
  assert.equal(ro.check("write").allowed, false);
  assert.equal(ro.check("read").allowed, true);
});
