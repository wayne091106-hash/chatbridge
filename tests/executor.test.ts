import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CodexExecServerExecutor } from "../src/core/execServer.js";
import type { Executor } from "../src/core/executor.js";
import { NodeExecutor } from "../src/core/nodeExecutor.js";
import { ShellManager } from "../src/core/shell.js";
import { FileService } from "../src/core/files.js";
import { Checkpoints } from "../src/core/checkpoints.js";
import { findRipgrep } from "../src/core/runtime.js";
import { silentLogger } from "../src/core/logger.js";
import { hasCodex, tempDir } from "./helpers.js";

const variants: Array<[string, () => Executor, boolean]> = [
  ["node", () => new NodeExecutor(), true],
  ["codex exec-server", () => new CodexExecServerExecutor({ logger: silentLogger }), hasCodex],
];

for (const [name, make, enabled] of variants) {
  describe(`executor contract: ${name}`, { skip: !enabled && "codex not installed" }, () => {
    let ex: Executor;
    let shells: ShellManager;
    let files: FileService;
    let cps: Checkpoints;
    const t = tempDir();

    before(async () => {
      ex = make();
      shells = new ShellManager(ex, silentLogger, { cwd: t.dir });
      cps = new Checkpoints(path.join(t.dir, ".cp"), "test");
      files = new FileService(ex, shells, () => t.dir, cps, ex.kind === "codex-exec-server" ? findRipgrep() : null);
    });

    after(async () => {
      await shells.closeAll();
      await ex.close();
      t.cleanup();
    });

    test("info", async () => {
      const info = await ex.info();
      assert.equal(info.kind, ex.kind);
      assert.ok(info.version);
    });

    test("run command, exit code, unicode output", async () => {
      const ok = await shells.run({ command: "Write-Output 'hello 你好'; exit 0", yieldSeconds: 60 });
      assert.equal(ok.running, false);
      assert.equal(ok.exitCode, 0);
      assert.match(ok.output, /hello 你好/);
      const bad = await shells.run({ command: "Write-Error 'nope'; exit 7", yieldSeconds: 60 });
      assert.equal(bad.exitCode, 7);
      assert.match(bad.output, /nope/);
      const cmd = await shells.run({ command: "echo 中文測試", shell: "cmd", yieldSeconds: 60 });
      assert.match(cmd.output, /中文測試/);
    });

    test("yield while running, then read to completion", async () => {
      const first = await shells.run({ command: "Write-Output start; Start-Sleep -Seconds 3; Write-Output finish", yieldSeconds: 1 });
      assert.equal(first.running, true);
      let snap = first;
      let collected = first.output;
      for (let i = 0; i < 20 && snap.running; i++) {
        snap = await shells.read(first.sessionId, 2);
        collected += snap.output;
      }
      assert.equal(snap.running, false);
      assert.equal(snap.exitCode, 0);
      assert.match(collected, /start[\s\S]*finish/);
    });

    test("interactive stdin", async () => {
      const s = await shells.run({ command: "$l = [Console]::In.ReadLine(); Write-Output \"got:$l\"", interactive: true, yieldSeconds: 1 });
      const w = await shells.write(s.sessionId, "ping\r\n", 3);
      let out = s.output + w.output;
      let snap = w;
      for (let i = 0; i < 10 && snap.running; i++) {
        snap = await shells.read(s.sessionId, 1);
        out += snap.output;
      }
      assert.match(out, /got:ping/);
    });

    test("kill long-running process", async () => {
      const s = await shells.run({ command: "Start-Sleep -Seconds 60", yieldSeconds: 0.5 });
      assert.equal(s.running, true);
      const k = await shells.kill(s.sessionId);
      assert.equal(k.running, false);
      assert.ok(shells.list().some((x) => x.sessionId === s.sessionId && !x.running));
    });

    test("file service: write/read/edit/patch/list/search/manage + checkpoint undo", async () => {
      cps.beginTurn("t1");
      await files.write("proj/a.txt", "line1\nline2\nline3\n");
      const r = await files.read("proj/a.txt", { offset: 2, limit: 1 });
      assert.match(r.text, /^2\tline2$/);
      assert.equal(r.totalLines, 3);
      await files.edit("proj/a.txt", "line2", "LINE-TWO");
      await assert.rejects(files.edit("proj/a.txt", "absent", "x"), /not found/);
      await files.patch("*** Begin Patch\n*** Update File: proj/a.txt\n@@\n LINE-TWO\n-line3\n+line3!\n*** Add File: proj/sub/b.py\n+print('hi')\n*** End Patch");
      const after1 = (await ex.readFile(path.join(t.dir, "proj", "a.txt"))).toString();
      assert.equal(after1, "line1\nLINE-TWO\nline3!\n");
      cps.endTurn();

      const list = await files.list("proj", 3);
      assert.match(list.tree, /sub\/\n\s+b\.py/);
      const found = await files.search("print\\(", "proj");
      assert.equal(found.matches, 1);
      assert.match(found.results, /b\.py/);

      await files.manage("copy", "proj/a.txt", "proj/copy/a2.txt");
      assert.ok(await ex.stat(path.join(t.dir, "proj", "copy", "a2.txt")));

      const undone = await cps.undo(ex);
      assert.equal(undone.label, "t1");
      assert.equal(await ex.stat(path.join(t.dir, "proj", "a.txt")), null, "file created in the turn is removed on undo");
      assert.equal(await ex.stat(path.join(t.dir, "proj", "sub", "b.py")), null);
    });

    test("binary detection and missing file", async () => {
      await ex.writeFile(path.join(t.dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
      const r = await files.read("bin.dat");
      assert.equal(r.binary, true);
      await assert.rejects(files.read("nope.txt"), /not found/);
    });
  });
}
