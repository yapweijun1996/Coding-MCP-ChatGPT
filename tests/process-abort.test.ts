import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileAbortable } from "../src/shared/process.js";

test("execFileAbortable terminates the spawned process group on cancellation", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "mcp-process-abort-"));
  const marker = path.join(root, "grandchild-survived.txt");
  const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 700)`;
  const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const controller = new AbortController();
  try {
    const running = execFileAbortable(process.execPath, ["-e", parentScript], { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(new Error("test cancellation")), 100);
    await assert.rejects(running, /test cancellation/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(access(marker), /ENOENT/, "the grandchild must not survive cancellation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
