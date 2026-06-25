import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("project workflow docs include copyable recipes and naming guidance", async () => {
  const docs = await readFile(path.join(process.cwd(), "docs/mcp-tools.md"), "utf8");

  assert.match(docs, /### Project workflow recipes/);
  assert.match(docs, /"tool": "deliver_static_project"/);
  assert.match(docs, /"entryFile": "index\.html"/);
  assert.match(docs, /"files": \[/);
  assert.match(docs, /"tool": "write_project_file"/);
  assert.match(docs, /"tool": "validate_project"/);
  assert.match(docs, /"tool": "publish_and_report"/);
  assert.match(docs, /projectId.*persistent Project identifier/s);
  assert.match(docs, /jobId.*same value/s);
  assert.match(docs, /restore_latest_project_backup/);
  assert.match(docs, /Do not call legacy `create_share`/);
});
