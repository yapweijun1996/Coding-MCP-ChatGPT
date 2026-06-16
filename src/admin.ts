import type { ActivityEvent } from "./activity.js";
import type { OAuthClientStatus } from "./oauth.js";
import type { ProjectFileInfo, ProjectManifest, ProjectMetadata, ProjectSummary, ProjectValidationResult } from "./projects/store.js";

export interface AdminPageData {
  publicBaseUrl: string;
  adminToken: string;
  clients: OAuthClientStatus[];
  tools: Array<{ name: string; description: string; enabled: boolean }>;
  activity: ActivityEvent[];
  projects: ProjectSummary[];
  stats: {
    jobs: number;
    shares: number;
    projects: number;
    enabledTools: number;
    connectedClients: number;
  };
}

export interface ProjectPageData {
  publicBaseUrl: string;
  adminToken: string;
  project: ProjectMetadata;
  files: ProjectFileInfo[];
  manifest: ProjectManifest;
  selectedPath?: string;
  selectedContent?: string;
  error?: string;
}

function escapeHtml(value: string | number | boolean | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function styles(): string {
  return `
    :root { --bg: #f4f5f1; --ink: #15221d; --muted: #627067; --line: #d5dbd2; --surface: #fff; --accent: #12645d; --danger: #a32929; --soft: #eef1ea; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
    header { padding: 24px 28px; border-bottom: 1px solid var(--line); background: var(--surface); }
    h1 { margin: 0; font-size: 26px; }
    h1 a { color: inherit; text-decoration: none; }
    main { width: min(1280px, calc(100vw - 32px)); margin: 22px auto 48px; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .metric { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric strong { display: block; font-size: 28px; }
    .metric span { color: var(--muted); font-size: 13px; }
    section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; overflow: hidden; }
    h2 { margin: 0; padding: 16px; font-size: 18px; border-bottom: 1px solid var(--line); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 650; background: #f9faf7; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    button, .button { display: inline-block; border: 0; border-radius: 6px; padding: 8px 12px; color: white; cursor: pointer; min-width: 58px; text-decoration: none; font-size: 13px; line-height: 1.15; }
    .enabled, .primary { background: var(--accent); }
    .disabled, .danger { background: var(--danger); }
    .secondary { background: #425047; }
    .empty { color: var(--muted); padding: 16px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .actions form { margin: 0; }
    .pill { display: inline-block; border-radius: 999px; background: var(--soft); color: var(--muted); padding: 3px 8px; font-size: 12px; }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; }
    .file-list a { display: block; padding: 8px 10px; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); }
    .file-list a.active { background: var(--soft); font-weight: 700; }
    .code-view { width: 100%; min-height: 620px; box-sizing: border-box; resize: vertical; border: 0; border-top: 1px solid var(--line); padding: 16px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #18241e; background: #fbfcf8; }
    .meta { color: var(--muted); margin: 6px 0 0; }
    .error { color: var(--danger); padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .json-view { margin: 0; padding: 16px; overflow: auto; max-height: 360px; background: #fbfcf8; border-top: 1px solid var(--line); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    .badge-valid { background: #e3f3e8; color: #176139; }
    .badge-warnings { background: #fff0c2; color: #6a4a00; }
    .badge-failed { background: #f8d8d8; color: #8a1f1f; }
    .badge-empty { background: var(--soft); color: var(--muted); }
    @media (max-width: 900px) { .stats { grid-template-columns: 1fr 1fr; } .layout { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
  `;
}

function validationStatus(validation?: ProjectValidationResult): { label: string; className: string } {
  if (!validation) return { label: "not checked", className: "badge-empty" };
  if (validation.status === "valid") return { label: "valid", className: "badge-valid" };
  if (validation.status === "warnings") return { label: "warnings", className: "badge-warnings" };
  return { label: "failed", className: "badge-failed" };
}

export function renderAdminPage(data: AdminPageData): string {
  const adminTokenQuery = `?token=${encodeURIComponent(data.adminToken)}`;
  const withToken = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(data.adminToken)}`;
  const clientRows = data.clients.map((client) => `
    <tr>
      <td><code>${escapeHtml(client.clientId)}</code></td>
      <td>${escapeHtml(client.clientName)}</td>
      <td>${escapeHtml(client.redirectHost)}</td>
      <td>${escapeHtml(client.activeAccessTokens)}</td>
      <td>${escapeHtml(client.refreshTokens)}</td>
      <td>${escapeHtml(client.lastUsedAt ?? "-")}</td>
      <td>${escapeHtml(client.requestCount)}</td>
      <td>
        <form method="post" action="/admin/connectors/revoke${adminTokenQuery}">
          <input type="hidden" name="clientId" value="${escapeHtml(client.clientId)}">
          <button class="disabled" type="submit">Revoke</button>
        </form>
      </td>
    </tr>`).join("");

  const projectRows = data.projects.map((project) => {
    const validation = validationStatus(project.lastValidation);
    return `
    <tr>
      <td>${escapeHtml(project.title)}<br><code>${escapeHtml(project.id)}</code></td>
      <td><span class="pill">${escapeHtml(project.status)}</span></td>
      <td><span class="pill ${validation.className}">${escapeHtml(validation.label)}</span></td>
      <td>${escapeHtml(project.filesCount)}</td>
      <td>${escapeHtml(project.updatedAt)}</td>
      <td><code>${escapeHtml(project.createdByClientId)}</code></td>
      <td>${project.publishedUrl ? `<a href="${escapeHtml(project.publishedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(project.publishedUrl)}</a>` : "-"}</td>
      <td>
        <div class="actions">
          ${project.publishedUrl ? `<a class="button primary" href="${escapeHtml(project.publishedUrl)}" target="_blank" rel="noreferrer">Open Preview</a>` : ""}
          <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${project.id}`))}">View Code</a>
          <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${project.id}/download.zip`))}">Download ZIP</a>
          <form method="post" action="/admin/projects/${escapeHtml(project.id)}/delete${adminTokenQuery}" onsubmit="return confirm('Soft-delete this project?')">
            <button class="danger" type="submit">Delete</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join("");

  const toolRows = data.tools.map((tool) => `
    <tr>
      <td><code>${escapeHtml(tool.name)}</code></td>
      <td>${escapeHtml(tool.description)}</td>
      <td>
        <form method="post" action="/admin/tools/toggle${adminTokenQuery}">
          <input type="hidden" name="name" value="${escapeHtml(tool.name)}">
          <input type="hidden" name="enabled" value="${tool.enabled ? "0" : "1"}">
          <button class="${tool.enabled ? "enabled" : "disabled"}" type="submit">${tool.enabled ? "On" : "Off"}</button>
        </form>
      </td>
    </tr>`).join("");

  const activityRows = data.activity.map((event) => `
    <tr>
      <td>${escapeHtml(event.time)}</td>
      <td><code>${escapeHtml(event.clientId)}</code></td>
      <td>${escapeHtml(event.method)}</td>
      <td>${escapeHtml(event.toolName ?? "-")}</td>
      <td>${event.ok ? "OK" : "Fail"}</td>
      <td>${escapeHtml(event.summary)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coding MCP Admin</title>
  <style>${styles()}</style>
</head>
<body>
  <header>
    <h1>Coding MCP Admin</h1>
    <p>${escapeHtml(data.publicBaseUrl)}/mcp</p>
  </header>
  <main>
    <div class="stats">
      <div class="metric"><strong>${data.stats.connectedClients}</strong><span>Connected clients</span></div>
      <div class="metric"><strong>${data.stats.enabledTools}</strong><span>Enabled tools</span></div>
      <div class="metric"><strong>${data.stats.projects}</strong><span>Projects</span></div>
      <div class="metric"><strong>${data.stats.jobs}</strong><span>Legacy jobs</span></div>
      <div class="metric"><strong>${data.stats.shares}</strong><span>Shared pages</span></div>
    </div>
    <section>
      <h2>Projects</h2>
      ${projectRows ? `<table><thead><tr><th>Title / ID</th><th>Status</th><th>Validation</th><th>Files</th><th>Updated</th><th>Created by</th><th>Published URL</th><th>Actions</th></tr></thead><tbody>${projectRows}</tbody></table>` : `<div class="empty">No projects created yet.</div>`}
    </section>
    <section>
      <h2>ChatGPT Connectors</h2>
      ${clientRows ? `<table><thead><tr><th>Client ID</th><th>Name</th><th>Redirect host</th><th>Access tokens</th><th>Refresh tokens</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>${clientRows}</tbody></table>` : `<div class="empty">No connectors registered yet.</div>`}
    </section>
    <section>
      <h2>Tools</h2>
      <table><thead><tr><th>Name</th><th>Description</th><th>Access</th></tr></thead><tbody>${toolRows}</tbody></table>
    </section>
    <section>
      <h2>Activity</h2>
      ${activityRows ? `<table><thead><tr><th>Time</th><th>Client</th><th>Method</th><th>Tool</th><th>Status</th><th>Summary</th></tr></thead><tbody>${activityRows}</tbody></table>` : `<div class="empty">No MCP activity recorded yet.</div>`}
    </section>
  </main>
</body>
</html>`;
}

export function renderProjectPage(data: ProjectPageData): string {
  const withToken = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(data.adminToken)}`;
  const validation = validationStatus(data.manifest.lastValidation);
  const manifestJson = JSON.stringify(data.manifest, null, 2);
  const validationJson = data.manifest.lastValidation ? JSON.stringify(data.manifest.lastValidation, null, 2) : "No validation has been run yet.";
  const inspectionReportUrl = data.manifest.lastValidation?.browserInspection?.reportUrl;
  const historyRows = data.manifest.taskHistory.map((event) => `
    <tr>
      <td>${escapeHtml(event.time)}</td>
      <td><code>${escapeHtml(event.toolName)}</code></td>
      <td>${event.ok ? "OK" : "Fail"}</td>
      <td>${escapeHtml(event.summary)}</td>
    </tr>`).join("");
  const fileLinks = data.files.map((file) => {
    const href = withToken(`/admin/projects/${data.project.id}?path=${encodeURIComponent(file.path)}`);
    const active = data.selectedPath === file.path ? " active" : "";
    return `<a class="${active}" href="${escapeHtml(href)}"><code>${escapeHtml(file.path)}</code><br><span class="meta">${escapeHtml(file.size)} bytes</span></a>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.project.title)} - Coding MCP Admin</title>
  <style>${styles()}</style>
</head>
<body>
  <header>
    <h1><a href="${escapeHtml(withToken("/admin"))}">Coding MCP Admin</a> / ${escapeHtml(data.project.title)}</h1>
    <p class="meta"><code>${escapeHtml(data.project.id)}</code> · ${escapeHtml(data.project.status)} · entry: <code>${escapeHtml(data.project.entryFile)}</code></p>
  </header>
  <main>
    <div class="actions">
      <a class="button secondary" href="${escapeHtml(withToken("/admin"))}">Back</a>
      ${data.project.publishedUrl ? `<a class="button primary" href="${escapeHtml(data.project.publishedUrl)}" target="_blank" rel="noreferrer">Open Preview</a>` : ""}
      <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${data.project.id}/download.zip`))}">Download ZIP</a>
      <span class="pill ${validation.className}">validation: ${escapeHtml(validation.label)}</span>
    </div>
    <section>
      <h2>Manifest</h2>
      <pre class="json-view">${escapeHtml(manifestJson)}</pre>
    </section>
    <section>
      <h2>Last Validation</h2>
      ${inspectionReportUrl ? `<div class="empty"><a href="${escapeHtml(inspectionReportUrl)}" target="_blank" rel="noreferrer">Open browser inspection report</a></div>` : ""}
      <pre class="json-view">${escapeHtml(validationJson)}</pre>
    </section>
    <section>
      <h2>Task History</h2>
      ${historyRows ? `<table><thead><tr><th>Time</th><th>Tool</th><th>Status</th><th>Summary</th></tr></thead><tbody>${historyRows}</tbody></table>` : `<div class="empty">No task history yet.</div>`}
    </section>
    <div class="layout">
      <section>
        <h2>Files</h2>
        <div class="file-list">${fileLinks || `<div class="empty">No files yet.</div>`}</div>
      </section>
      <section>
        <h2>${data.selectedPath ? `Code: <code>${escapeHtml(data.selectedPath)}</code>` : "Code"}</h2>
        ${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ""}
        <textarea class="code-view" readonly spellcheck="false">${escapeHtml(data.selectedContent ?? "Select a file to view code.")}</textarea>
      </section>
    </div>
  </main>
</body>
</html>`;
}
