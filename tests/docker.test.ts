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
