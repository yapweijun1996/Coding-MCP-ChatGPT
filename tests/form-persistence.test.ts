import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "form-persistence-test"
  };
}

async function serveHtml(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

const html = `<!doctype html>
<html><head><title>Persistence</title></head><body>
<form id="prefs">
  <input id="name" name="name">
  <select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select>
  <label><input id="draft" type="checkbox"> Save draft</label>
  <button id="save" type="button">Save</button>
</form>
<script>
const nameInput = document.getElementById('name');
const themeSelect = document.getElementById('theme');
const draftToggle = document.getElementById('draft');
const saveButton = document.getElementById('save');
const read = () => {
  nameInput.value = localStorage.getItem('draftName') || '';
  themeSelect.value = localStorage.getItem('theme') || 'light';
  draftToggle.checked = sessionStorage.getItem('draftEnabled') === 'true';
};
const write = () => {
  localStorage.setItem('draftName', nameInput.value);
  localStorage.setItem('theme', themeSelect.value);
  sessionStorage.setItem('draftEnabled', String(draftToggle.checked));
};
for (const el of [nameInput, themeSelect, draftToggle]) el.addEventListener('input', write);
themeSelect.addEventListener('change', write);
draftToggle.addEventListener('change', write);
saveButton.addEventListener('click', write);
indexedDB.open('draft-db', 1);
read();
</script>
</body></html>`;

test("test_form_persistence verifies reload persistence, storage assertions, IndexedDB, and same-context reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "form-persistence-"));
  const server = await serveHtml(html);
  try {
    const tool = getToolModule("test_form_persistence");
    assert.ok(tool, "test_form_persistence registered");
    const result = await tool!.handler({
      url: server.url,
      resetStorage: true,
      fields: [
        { selector: "#name", value: "Ada Lovelace" },
        { selector: "#theme", value: "dark", type: "select" },
        { selector: "#draft", value: "true", type: "checkbox" }
      ],
      submitSelector: "#save",
      expectedLocalStorage: [
        { key: "draftName", value: "Ada Lovelace" },
        { key: "theme", value: "dark" }
      ],
      expectedSessionStorage: [{ key: "draftEnabled", value: "true" }],
      expectedIndexedDbDatabases: ["draft-db"],
      checkNewPageSameContext: true
    }, toolContext(root));
    assert.equal(result.ok, true);
    assert.match(result.summary, /passed/);
    assert.equal(result.artifacts.length >= 2, true);
    const payload = result.structuredContent as {
      phases: Array<{ phase: string; assertions: Array<{ ok: boolean; id: string }> }>;
      failedAssertions: unknown[];
    };
    assert.deepEqual(payload.failedAssertions, []);
    assert.ok(payload.phases.some((phase) => phase.phase === "after-reload"));
    assert.ok(payload.phases.some((phase) => phase.phase === "new-page-same-context"));
    assert.ok(payload.phases.flatMap((phase) => phase.assertions).some((assertion) => assertion.id === "localStorage:draftName" && assertion.ok));
    assert.ok(payload.phases.flatMap((phase) => phase.assertions).some((assertion) => assertion.id === "indexedDB:draft-db" && assertion.ok));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("test_form_persistence seeds storage before filling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "form-persistence-"));
  const server = await serveHtml(html);
  try {
    const tool = getToolModule("test_form_persistence");
    const result = await tool!.handler({
      url: server.url,
      resetStorage: true,
      seedLocalStorage: { theme: "dark" },
      fields: [{ selector: "#theme", value: "dark", type: "select" }],
      expectedLocalStorage: [{ key: "theme", value: "dark" }]
    }, toolContext(root));
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { phases: Array<{ assertions: Array<{ id: string; ok: boolean }> }> };
    assert.ok(payload.phases.flatMap((phase) => phase.assertions).some((assertion) => assertion.id === "localStorage:theme" && assertion.ok));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("form persistence tool is exposed through coding, debug, browser QA, and observability skills", () => {
  for (const skillId of ["coding", "debug", "browser-qa", "agent-browser-observability"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("test_form_persistence"), `${skillId} exposes test_form_persistence`);
  }
});
