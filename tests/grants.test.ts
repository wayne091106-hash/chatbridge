import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeConfigSchema } from "../src/core/config.js";
import { activeGrants, addGrant, isInside, revokeGrant } from "../src/core/grants.js";
import { Policy, absolutePathsIn, subjectFromArgs } from "../src/core/policy.js";
import { createRuntime } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { createMcpServer } from "../src/bridge/tools.js";
import { tempDir, testConfig } from "./helpers.js";

const policyFor = (over: Record<string, unknown>, base: string, dir: string) =>
  new Policy(BridgeConfigSchema.parse({ policy: over }).policy, () => base, dir);

test("grants: containment does not leak into a sibling with the same prefix", () => {
  assert.equal(isInside("C:/work", "C:/work/app/src/index.ts"), true);
  assert.equal(isInside("C:/work", "C:/work"), true);
  assert.equal(isInside("C:/work", "C:/work-secrets/passwords.txt"), false);
  assert.equal(isInside("C:/work", "C:/work/../other"), false);
});

test("grants: add, list, expire and revoke", () => {
  const t = tempDir();
  try {
    const g = addGrant(t.dir, { hours: 1, note: "today" }, t.dir);
    assert.equal(activeGrants(t.dir).length, 1);
    // Re-granting the same folder replaces rather than stacks.
    addGrant(t.dir, {}, t.dir);
    assert.equal(activeGrants(t.dir).length, 1);
    assert.equal(revokeGrant(g.path, t.dir), 1);
    assert.equal(activeGrants(t.dir).length, 0);

    addGrant(t.dir, { hours: -1 / 3600, note: "already over" }, t.dir);
    assert.equal(activeGrants(t.dir).length, 0, "expired grants drop out on their own");
  } finally {
    t.cleanup();
  }
});

test("policy: arguments give up their paths without every tool declaring them", () => {
  assert.deepEqual(subjectFromArgs({ path: "a.txt", cwd: "C:/p", files: ["b", "c"], count: 3 }).paths, ["a.txt", "C:/p", "b", "c"]);
  assert.equal(subjectFromArgs({ command: "npm test" }).command, "npm test");
  // `to`/`from` are only paths when they look like one, so a model name or a line number cannot cause a refusal.
  assert.equal(subjectFromArgs({ to: "gpt-5.6-sol", from: 12 }).paths, undefined);
  assert.deepEqual(subjectFromArgs({ to: "C:/out/report.md" }).paths, ["C:/out/report.md"]);
  assert.deepEqual(absolutePathsIn('type "C:\\secrets\\a.txt" && npm test'), ["C:\\secrets\\a.txt"]);
  assert.deepEqual(absolutePathsIn("curl https://example.com/x"), []);
});

test("policy: project scope allows the granted folder and refuses everything else", () => {
  const t = tempDir();
  const project = path.join(t.dir, "proj");
  mkdirSync(project, { recursive: true });
  try {
    const p = policyFor({ scope: "projects" }, project, t.dir);

    // Nothing granted yet: even a read is refused, and the message says what to do.
    const cold = p.check("read", { paths: [path.join(project, "a.txt")] });
    assert.equal(cold.allowed, false);
    assert.match(cold.reason!, /chatbridge grant/);

    addGrant(project, {}, t.dir);
    assert.equal(p.check("read", { paths: [path.join(project, "a.txt")] }).allowed, true);
    assert.equal(p.check("write", { paths: ["sub/b.txt"] }).allowed, true, "relative paths resolve against the working directory");
    assert.equal(p.check("execute", { command: "npm test", paths: [project] }).allowed, true);

    // A file that does not exist yet still has to resolve inside the grant, or nothing could ever be created.
    assert.equal(p.check("write", { paths: [path.join(project, "does", "not", "exist", "yet.txt")] }).allowed, true);

    const outside = p.check("write", { paths: [path.join(t.dir, "elsewhere.txt")] });
    assert.equal(outside.allowed, false);
    assert.match(outside.reason!, /outside the granted project folders/);

    // A command that names a path outside the project is refused even though its cwd is fine.
    assert.equal(p.check("execute", { command: `type ${path.join(t.dir, "secret.txt")}`, paths: [project] }).allowed, false);
    // Screen and mouse are off in project scope unless the owner turns them back on.
    assert.equal(p.check("desktop", {}).allowed, false);
    assert.equal(policyFor({ scope: "projects", projectsAllowDesktop: true }, project, t.dir).check("desktop", {}).allowed, true);
  } finally {
    t.cleanup();
  }
});

test("policy: machine scope (the default) is unchanged by grants", () => {
  const t = tempDir();
  try {
    const p = policyFor({}, t.dir, t.dir);
    assert.equal(p.scope, "machine");
    assert.equal(p.check("write", { paths: ["C:/anything/at/all.txt"] }).allowed, true);
    assert.equal(p.check("desktop", {}).allowed, true);
  } finally {
    t.cleanup();
  }
});

test("policy: a tool call outside the grant is denied and audited", async () => {
  const t = tempDir();
  const home = path.join(t.dir, "home");
  const project = path.join(t.dir, "proj");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(project, "in.txt"), "inside");
  writeFileSync(path.join(t.dir, "out.txt"), "outside");
  process.env.CHATBRIDGE_HOME = home;
  const rt = await createRuntime({
    dataDir: home,
    config: testConfig({ executor: { kind: "node" }, shell: { cwd: project }, policy: { scope: "projects" } }),
    logger: silentLogger,
  });
  const server = createMcpServer({ rt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    addGrant(project, {}, home);
    const ok = (await client.callTool({ name: "fs_read", arguments: { path: path.join(project, "in.txt") } })) as any;
    assert.equal(ok.isError, undefined, JSON.stringify(ok.content));

    const denied = (await client.callTool({ name: "fs_read", arguments: { path: path.join(t.dir, "out.txt") } })) as any;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Denied by owner policy/);
    assert.ok(rt.audit.tail(10).some((e) => e.outcome === "denied" && e.action === "fs_read"));
  } finally {
    delete process.env.CHATBRIDGE_HOME;
    await client.close();
    await rt.close();
    t.cleanup();
  }
});
