import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Dockerfile pins GeneralUser GS and verifies SHA-256 hashes", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.equal(dockerfile.includes("GeneralUser-GS/master"), false);
  assert.match(dockerfile, /684543d5e5efaef08d02be50dcda8d552478fa60/);
  assert.match(dockerfile, /9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe/);
  assert.match(dockerfile, /7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be/);
  assert.match(dockerfile, /f1a5d1ef99591763617689d064e57113b1db900a920e145233aa2789331e085a/);
  assert.match(dockerfile, /createHash\("sha256"\)/);
  assert.match(dockerfile, /SHA-256 mismatch/);
});

// Regression guard. `xvfb-run` starts the X server but never execs COMMAND when the container
// has no TTY, and docker-compose.yml sets neither tty nor stdin_open. Verified in a detached
// container: `xvfb-run --auto-servernum sh -c 'echo MARKER; touch /tmp/ran_marker'` produced no
// output, no marker file, and exit 0. As the CMD that means node never starts, the healthcheck
// fails forever, and there are no logs explaining why.
test("Dockerfile starts the server directly, not through xvfb-run", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const cmdLine = dockerfile.split("\n").find((line) => line.startsWith("CMD ")) ?? "";
  assert.ok(cmdLine, "Dockerfile has a CMD");
  assert.equal(cmdLine.includes("xvfb-run"), false, "xvfb-run does not exec COMMAND without a TTY");
  assert.match(cmdLine, /Xvfb :\d+/, "an X server is still started, for the one non-headless tool");
  // exec keeps node as PID 1 so it still receives SIGTERM for the graceful shutdown path.
  assert.match(cmdLine, /exec node dist\/server\.js/, "node must be exec'd as PID 1");
  assert.match(cmdLine, /DISPLAY=/, "DISPLAY must be exported for the non-headless path");
});

test("docker-compose does not allocate a TTY, which is why the CMD must not rely on one", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.equal(/^\s*tty:\s*true/m.test(compose), false);
  assert.equal(/^\s*stdin_open:\s*true/m.test(compose), false);
});
