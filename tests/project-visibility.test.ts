import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject, forkProject, publishProject, setProjectShareAccess, writeProjectFile } from "../src/projects/store.js";

test("new and forked projects default to global link access and can be made private", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-visibility-"));
  const projectRoot = path.join(root, "projects");
  try {
    const project = await createProject(projectRoot, { title: "Public by default", createdByClientId: "test" });
    assert.equal(project.shareAccess, "anyone_with_link");

    const forked = await forkProject(projectRoot, project.id, { title: "Forked public project", createdByClientId: "test" });
    assert.equal(forked.shareAccess, "anyone_with_link");

    await setProjectShareAccess(projectRoot, project.id, "private");
    await writeProjectFile(projectRoot, project.id, "index.html", "<!doctype html><title>Private preview</title>");
    const published = await publishProject(projectRoot, project.id, "https://example.test");
    assert.equal(published.shareAccess, "private");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
