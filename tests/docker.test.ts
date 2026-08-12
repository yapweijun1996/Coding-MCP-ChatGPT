import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Docker build copies the tool-manifest generator before running the build", async () => {
  const [dockerfile, packageJsonSource] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile("package.json", "utf8")
  ]);
  const scriptsCopyIndex = dockerfile.indexOf("COPY scripts ./scripts");
  const buildIndex = dockerfile.indexOf("npm run build");
  assert.ok(scriptsCopyIndex >= 0, "Docker build stage must copy scripts/ for manifest generation");
  assert.ok(scriptsCopyIndex < buildIndex, "scripts/ must be available before npm run build");
  const packageJson = JSON.parse(packageJsonSource) as { scripts?: Record<string, string> };
  assert.match(packageJson.scripts?.["build:server"] ?? "", /generate:tool-manifest/);
});

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
test("Dockerfile supervises the HTTP server and durable worker without xvfb-run", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const cmdLine = dockerfile.split("\n").find((line) => line.startsWith("CMD ")) ?? "";
  assert.ok(cmdLine, "Dockerfile has a CMD");
  assert.equal(cmdLine.includes("xvfb-run"), false, "xvfb-run does not exec COMMAND without a TTY");
  assert.match(cmdLine, /Xvfb :\d+/, "an X server is still started, for the one non-headless tool");
  assert.match(cmdLine, /node dist\/server\.js/, "the HTTP process must be started");
  assert.match(cmdLine, /node dist\/worker\.js/, "the durable job worker must be started separately");
  assert.match(cmdLine, /trap terminate TERM INT/, "the PID 1 supervisor must forward termination");
  assert.match(cmdLine, /wait -n/, "the container must stop if either critical process exits");
  assert.match(cmdLine, /DISPLAY=/, "DISPLAY must be exported for the non-headless path");
});

test("docker-compose does not allocate a TTY, which is why the CMD must not rely on one", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.equal(/^\s*tty:\s*true/m.test(compose), false);
  assert.equal(/^\s*stdin_open:\s*true/m.test(compose), false);
});
