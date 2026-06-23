import type { JobRecord } from "./jobs/store.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPreviewPage(job: JobRecord): string {
  const statusLabel = job.status === "success" ? "Success" : job.status === "error" ? "Error" : job.status === "running" ? "Running" : job.status === "cancelled" ? "Cancelled" : job.status === "timeout" ? "Timeout" : "Created";
  const logHtml = job.logs.length > 0 ? job.logs.map((line) => `<li>${escapeHtml(line)}</li>`).join("") : "<li>No logs recorded.</li>";
  const artifactHtml = job.artifacts.length > 0 ? job.artifacts.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>No artifacts recorded.</li>";
  const errorHtml = job.errors.length > 0 ? `<section><h2>Errors</h2><ul>${job.errors.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(job.title)} - Coding MCP Preview</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #17211b;
      --muted: #5e665e;
      --line: #d9ddd2;
      --accent: #16615a;
      --surface: #ffffff;
      --error: #9f1d1d;
    }
    body {
      margin: 0;
      background: linear-gradient(180deg, #f7f7f2 0%, #eef3ed 100%);
      color: var(--ink);
      font-family: ui-serif, Georgia, "Times New Roman", serif;
    }
    main {
      width: min(920px, calc(100vw - 32px));
      margin: 48px auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      box-shadow: 0 16px 60px rgba(23, 33, 27, 0.08);
    }
    header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
      margin-bottom: 22px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 5vw, 44px);
      line-height: 1;
    }
    h2 {
      margin-top: 26px;
      font-size: 18px;
      color: var(--accent);
    }
    p, li {
      color: var(--muted);
      line-height: 1.55;
    }
    code {
      background: #edf0e8;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--ink);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      color: ${job.status === "error" || job.status === "cancelled" || job.status === "timeout" ? "var(--error)" : "var(--accent)"};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    ul {
      padding-left: 22px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="status">${statusLabel}</div>
      <h1>${escapeHtml(job.title)}</h1>
      <p>${escapeHtml(job.summary)}</p>
      <p><code>${escapeHtml(job.id)}</code></p>
    </header>
    <section>
      <h2>Artifacts</h2>
      <ul>${artifactHtml}</ul>
    </section>
    <section>
      <h2>Logs</h2>
      <ul>${logHtml}</ul>
    </section>
    ${errorHtml}
  </main>
</body>
</html>`;
}
