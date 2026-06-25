import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeShareStore, createShareArtifact, readShareArtifact } from "../src/share/store.js";

test("initializeShareStore rehydrates artifacts left on disk by a prior run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-"));
  try {
    // Simulate a share written before this process started (e.g. before restart).
    const id = "11111111-1111-1111-1111-111111111111";
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, "report.html"), "<h1>persisted</h1>", "utf8");

    await initializeShareStore(root);

    const got = await readShareArtifact(id, "report.html");
    assert.ok(got, "rehydrated share is served after restart");
    assert.equal(got?.html, "<h1>persisted</h1>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readShareArtifact self-heals on a map miss when the file exists on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-"));
  try {
    await initializeShareStore(root); // empty root: map starts empty
    const id = "22222222-2222-2222-2222-222222222222";
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, "page.html"), "<p>late</p>", "utf8");

    // Not in the map (created after init), but must still be served from disk.
    const got = await readShareArtifact(id, "page.html");
    assert.ok(got, "disk fallback serves a share missing from the map");
    assert.equal(got?.html, "<p>late</p>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readShareArtifact rejects path-escaping ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-"));
  try {
    await initializeShareStore(root);
    const got = await readShareArtifact("../../etc", "passwd.html");
    assert.equal(got, undefined, "id with path separators is rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("created shares are readable in the same process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-"));
  try {
    await initializeShareStore(root);
    const rec = await createShareArtifact({ shareRoot: root, title: "T", summary: "S", filename: "out.html", html: "<i>x</i>", ownerUserId: "test-user" });
    const got = await readShareArtifact(rec.id, "out.html");
    assert.equal(got?.html, "<i>x</i>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
