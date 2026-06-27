import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProject, validateProject, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";

test("static validation blocks pure Web Audio synthesis for realistic cafe piano music", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-validation-web-audio-music-"));
  try {
    const project = await createProject(root, {
      title: "Starbucks Piano Jazz",
      summary: "Five minute cafe piano background music.",
      createdByClientId: "test"
    });
    await writeProjectFile(root, project.id, "index.html", `<!doctype html>
<html>
  <body>
    <h1>Five-minute Starbucks piano jazz background music</h1>
    <script src="app.js"></script>
  </body>
</html>`);
    await writeProjectFile(root, project.id, "app.js", `const ctx = new AudioContext();
const piano = ctx.createOscillator();
piano.type = "sine";
piano.start();`);

    const validation = await validateProject(root, project.id);

    assert.equal(validation.ok, false);
    assert.equal(validation.status, "failed");
    assert.equal(validation.errors.some((error) => error.includes("Pure Web Audio synthesis is blocked")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static validation allows cafe piano pages backed by rendered audio assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-validation-rendered-audio-"));
  try {
    const project = await createProject(root, {
      title: "Rendered Piano Jazz",
      summary: "Cafe piano background music with a rendered WAV.",
      createdByClientId: "test"
    });
    await writeProjectFile(root, project.id, "index.html", `<!doctype html>
<html>
  <body>
    <h1>Five-minute cafe piano jazz background music</h1>
    <audio controls src="track.wav"></audio>
    <script src="app.js"></script>
  </body>
</html>`);
    await writeProjectFile(root, project.id, "app.js", `const ctx = new AudioContext();
const metronomePreview = ctx.createOscillator();`);
    await writeProjectAsset(root, project.id, "track.wav", Buffer.from("RIFF0000WAVEfmt data"));

    const validation = await validateProject(root, project.id);

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static validation does not block non-music Web Audio effects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-validation-web-audio-effect-"));
  try {
    const project = await createProject(root, {
      title: "Button Demo",
      summary: "Simple UI sound effect demo.",
      createdByClientId: "test"
    });
    await writeProjectFile(root, project.id, "index.html", `<!doctype html>
<html>
  <body>
    <h1>Button sound effect</h1>
    <button>Click</button>
    <script src="app.js"></script>
  </body>
</html>`);
    await writeProjectFile(root, project.id, "app.js", `const ctx = new AudioContext();
function clickTone() {
  const tone = ctx.createOscillator();
  tone.start();
}`);

    const validation = await validateProject(root, project.id);

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
