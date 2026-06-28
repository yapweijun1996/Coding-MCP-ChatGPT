import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProject, validateProject, writeProjectAsset, writeProjectFile, detectSandboxIncompatibleFetches } from "../src/projects/store.js";

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

// Published pages on the same-origin /share route run under a sandbox CSP (opaque origin), so
// fetch()/XHR to their OWN relative URLs fail silently. detectSandboxIncompatibleFetches flags those
// at validate/publish time so a score/data page that would render blank is caught before handoff.
test("detectSandboxIncompatibleFetches flags relative fetch/XHR, ignores absolute + CDN + data:", () => {
  const html = `
    <script>
      fetch("music/score.xml").then(r=>r.text());
      fetch('./data/notes.json');
      fetch("https://cdn.example.com/lib.js");
      fetch("//cdn.example.com/x.js");
      fetch("data:text/plain,hi");
      var x = new XMLHttpRequest(); x.open("GET", "api/local.json");
    </script>`;
  const found = detectSandboxIncompatibleFetches(html);
  assert.deepEqual(found, ["./data/notes.json", "api/local.json", "music/score.xml"]);
  assert.equal(found.some((u) => u.includes("cdn.example.com")), false, "absolute/protocol-relative URLs are not flagged");
  assert.equal(found.some((u) => u.startsWith("data:")), false, "data: URLs are not flagged");
});

test("static validation warns when entry HTML fetches its own same-origin resource", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-validation-sandbox-fetch-"));
  try {
    const project = await createProject(root, { title: "Score viewer", createdByClientId: "test" });
    await writeProjectFile(root, project.id, "music/score.xml", `<?xml version="1.0"?><score-partwise/>`);
    await writeProjectFile(root, project.id, "index.html", `<!doctype html><html><body>
      <div id="osmd"></div>
      <script>fetch("music/score.xml").then(r=>r.text()).then(render);</script>
    </body></html>`);
    const validation = await validateProject(root, project.id);
    assert.equal(validation.ok, true, "same-origin fetch is a portability warning, not a hard error");
    assert.equal(validation.warnings.some((w) => w.includes("sandbox CSP") && w.includes("music/score.xml")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static validation does not warn for inlined data or CDN scripts (the recommended fix)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-validation-inlined-"));
  try {
    const project = await createProject(root, { title: "Inlined score", createdByClientId: "test" });
    await writeProjectFile(root, project.id, "index.html", `<!doctype html><html><body>
      <div id="osmd"></div>
      <script type="application/xml" id="score"><score-partwise/></script>
      <script src="https://cdn.jsdelivr.net/npm/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js"></script>
      <script>var xml=document.getElementById("score").textContent; render(xml);</script>
    </body></html>`);
    const validation = await validateProject(root, project.id);
    assert.equal(validation.warnings.some((w) => w.includes("sandbox CSP")), false, "no same-origin fetch -> no warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
