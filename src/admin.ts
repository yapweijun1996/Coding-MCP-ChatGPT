import type { ActivityEvent } from "./activity.js";
import type { OAuthClientStatus } from "./oauth.js";
import type { ProjectFileInfo, ProjectManifest, ProjectMetadata, ProjectStatus, ProjectSummary, ProjectValidationResult } from "./projects/store.js";
import type { ResearchReportStatus } from "./research/store.js";

export type PublicShareLocale = "en" | "zh";

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

export interface PublicSharePageData {
  publicBaseUrl: string;
  projects: ProjectSummary[];
  locale: PublicShareLocale;
}

export interface ProjectPageData {
  publicBaseUrl: string;
  adminToken: string;
  project: ProjectMetadata;
  files: ProjectFileInfo[];
  manifest: ProjectManifest;
  researchSummary?: {
    sourceCount: number;
    usedSourceCount: number;
    evidenceCount: number;
    report: ResearchReportStatus;
  };
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
    :root { --bg: #f6f7f4; --ink: #17211b; --muted: #66736b; --line: #d9dfd6; --surface: #fff; --surface-2: #fbfcf8; --accent: #176b62; --accent-ink: #fff; --danger: #aa332e; --warning: #8a6200; --soft: #eef2eb; --focus: #2b7bd8; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
    header { padding: 22px 32px; border-bottom: 1px solid var(--line); background: var(--surface); }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .eyebrow { margin: 0 0 4px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 0; font-size: 28px; line-height: 1.1; }
    h1 a { color: inherit; text-decoration: none; }
    header p { margin: 6px 0 0; color: var(--muted); }
    main { width: min(1440px, calc(100vw - 32px)); margin: 20px auto 48px; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
    .metric strong { display: block; font-size: 26px; line-height: 1; }
    .metric span { color: var(--muted); font-size: 13px; }
    section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; overflow: hidden; }
    .section-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 18px; }
    section > h2 { padding: 16px; border-bottom: 1px solid var(--line); }
    .section-note { color: var(--muted); font-size: 13px; margin: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; table-layout: fixed; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 700; background: var(--surface-2); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; padding: 8px 12px; color: white; cursor: pointer; min-width: 58px; text-decoration: none; font-size: 13px; line-height: 1.15; font-weight: 700; }
    button:focus-visible, .button:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--focus), transparent 70%); outline-offset: 2px; }
    .enabled, .primary { background: var(--accent); color: var(--accent-ink); }
    .disabled, .danger { background: var(--danger); color: #fff; }
    .secondary { background: #47544d; color: #fff; }
    .ghost { color: var(--accent); background: #e6f2ef; }
    .empty { color: var(--muted); padding: 16px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .actions form { margin: 0; }
    .pill { display: inline-block; border-radius: 999px; background: var(--soft); color: var(--muted); padding: 4px 9px; font-size: 12px; font-weight: 700; }
    .badge-published { background: #ddf3eb; color: #106042; }
    .badge-private { background: #e7eef8; color: #244b76; }
    .badge-draft { background: #f0eee8; color: #645d51; }
    .badge-deleted { background: #f8d8d8; color: #8a1f1f; }
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
    .public-shell { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
    .public-hero { background: linear-gradient(135deg, #15352f 0%, #176b62 55%, #eef2eb 55%, #f8faf5 100%); color: #fff; padding: 34px 0 38px; border-bottom: 1px solid var(--line); }
    .public-hero .public-shell { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
    .public-hero h1 { max-width: 720px; font-size: 34px; }
    .public-hero p { max-width: 660px; color: rgba(255,255,255,.82); font-size: 15px; line-height: 1.55; margin: 10px 0 0; }
    .language-switch { display: inline-flex; gap: 4px; background: rgba(255,255,255,.92); border: 1px solid rgba(255,255,255,.62); border-radius: 8px; padding: 4px; white-space: nowrap; }
    .language-switch a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 800; padding: 7px 10px; border-radius: 6px; }
    .language-switch a.active { background: var(--accent); color: #fff; }
    .public-summary-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 20px 0 14px; }
    .public-count { display: inline-flex; align-items: baseline; gap: 8px; color: var(--muted); }
    .public-count strong { color: var(--ink); font-size: 26px; }
    .public-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .public-card { display: flex; flex-direction: column; min-height: 250px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 1px 0 rgba(23,33,27,.04); }
    .public-title { margin: 0 0 10px; font-size: 19px; line-height: 1.25; }
    .public-title a { color: var(--ink); text-decoration-thickness: 2px; text-underline-offset: 4px; }
    .public-meta { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .public-meta code { overflow-wrap: anywhere; }
    .public-summary { margin: 14px 0 0; color: var(--ink); font-size: 14px; line-height: 1.55; }
    .public-link { margin-top: auto; align-self: flex-start; }
    .project-title { font-weight: 800; line-height: 1.25; }
    .project-id { display: block; margin-top: 5px; color: var(--muted); overflow-wrap: anywhere; }
    .compact-date { white-space: nowrap; }
    .url-cell a { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-form { display: flex; flex-direction: column; gap: 7px; align-items: flex-start; }
    .status-control { display: inline-flex; gap: 6px; align-items: center; }
    select { min-width: 112px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); padding: 7px 8px; font: inherit; }
    .mini-button { min-width: 0; padding: 7px 10px; }
    .project-table th:nth-child(1) { width: 22%; }
    .project-table th:nth-child(2) { width: 16%; }
    .project-table th:nth-child(3) { width: 10%; }
    .project-table th:nth-child(4) { width: 7%; }
    .project-table th:nth-child(5) { width: 12%; }
    .project-table th:nth-child(6) { width: 16%; }
    .project-table th:nth-child(7) { width: 17%; }
    @media (max-width: 1100px) { .stats { grid-template-columns: 1fr 1fr; } .layout { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; table-layout: auto; } th, td { min-width: 140px; } .project-table th:nth-child(n) { width: auto; } }
    @media (max-width: 640px) { header { padding: 18px 16px; } .topbar, .public-hero .public-shell, .public-summary-bar { align-items: flex-start; flex-direction: column; } main { width: min(100% - 20px, 1440px); } .stats { grid-template-columns: 1fr; } .public-shell { width: min(100% - 24px, 1180px); } .public-hero { padding: 28px 0; } .public-hero h1 { font-size: 28px; } }
  `;
}

function validationStatus(validation?: ProjectValidationResult): { label: string; className: string } {
  if (!validation) return { label: "not checked", className: "badge-empty" };
  if (validation.status === "valid") return { label: "valid", className: "badge-valid" };
  if (validation.status === "warnings") return { label: "warnings", className: "badge-warnings" };
  return { label: "failed", className: "badge-failed" };
}

function projectStatus(status: ProjectStatus): { label: string; className: string } {
  if (status === "published") return { label: "published", className: "badge-published" };
  if (status === "private") return { label: "private", className: "badge-private" };
  if (status === "deleted") return { label: "deleted", className: "badge-deleted" };
  return { label: "draft", className: "badge-draft" };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatPublicDate(value: string, locale: PublicShareLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusOption(value: Exclude<ProjectStatus, "deleted">, current: ProjectStatus, label: string): string {
  return `<option value="${value}"${current === value ? " selected" : ""}>${label}</option>`;
}

const publicShareCopy: Record<PublicShareLocale, {
  htmlLang: string;
  title: string;
  eyebrow: string;
  subtitle: string;
  countLabel: string;
  sectionTitle: string;
  id: string;
  updated: string;
  files: string;
  open: string;
  empty: string;
  noSummary: string;
}> = {
  en: {
    htmlLang: "en",
    title: "Public Project Gallery",
    eyebrow: "Published projects",
    subtitle: "Browse projects that the admin has made public. Draft and private projects are hidden from this page.",
    countLabel: "projects live",
    sectionTitle: "Available Projects",
    id: "ID",
    updated: "Updated",
    files: "Files",
    open: "Open Preview",
    empty: "No published projects are available yet.",
    noSummary: "No summary provided."
  },
  zh: {
    htmlLang: "zh-CN",
    title: "公开项目库",
    eyebrow: "已发布项目",
    subtitle: "这里展示管理员设为公开的项目。草稿和私有项目不会出现在此页面。",
    countLabel: "个项目已公开",
    sectionTitle: "可访问项目",
    id: "ID",
    updated: "更新",
    files: "文件",
    open: "打开预览",
    empty: "当前没有已发布项目。",
    noSummary: "暂无项目摘要。"
  }
};

export function renderAdminPage(data: AdminPageData): string {
  const adminTokenQuery = `?token=${encodeURIComponent(data.adminToken)}`;
  const withToken = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(data.adminToken)}`;
  const publishedCount = data.projects.filter((project) => project.status === "published").length;
  const privateCount = data.projects.filter((project) => project.status === "private").length;
  const draftCount = data.projects.filter((project) => project.status === "draft").length;
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
    const status = projectStatus(project.status);
    const statusControls = project.status === "deleted"
      ? `<span class="pill ${status.className}">${escapeHtml(status.label)}</span>`
      : `<form class="status-form" method="post" action="/admin/projects/${escapeHtml(project.id)}/status${adminTokenQuery}">
          <span class="pill ${status.className}">${escapeHtml(status.label)}</span>
          <div class="status-control">
            <select name="status" aria-label="Project status for ${escapeHtml(project.title)}">
              ${statusOption("published", project.status, "Published")}
              ${statusOption("private", project.status, "Private")}
              ${statusOption("draft", project.status, "Draft")}
            </select>
            <button class="button ghost mini-button" type="submit">Apply</button>
          </div>
        </form>`;
    return `
    <tr>
      <td><span class="project-title">${escapeHtml(project.title)}</span><code class="project-id">${escapeHtml(project.id)}</code></td>
      <td>${statusControls}</td>
      <td><span class="pill ${validation.className}">${escapeHtml(validation.label)}</span></td>
      <td>${escapeHtml(project.filesCount)}</td>
      <td class="compact-date">${escapeHtml(formatDate(project.updatedAt))}</td>
      <td><code>${escapeHtml(project.createdByClientId)}</code></td>
      <td class="url-cell">${project.publishedUrl ? `<a href="${escapeHtml(project.publishedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(project.publishedUrl)}</a>` : `<span class="pill badge-empty">not public</span>`}</td>
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
    <div class="topbar">
      <div>
        <p class="eyebrow">Admin panel</p>
        <h1>Coding MCP Admin</h1>
        <p>${escapeHtml(data.publicBaseUrl)}/mcp</p>
      </div>
      <div class="actions">
        <a class="button ghost" href="/share" target="_blank" rel="noreferrer">Public Index</a>
      </div>
    </div>
  </header>
  <main>
    <div class="stats">
      <div class="metric"><strong>${data.stats.connectedClients}</strong><span>Connected clients</span></div>
      <div class="metric"><strong>${data.stats.enabledTools}</strong><span>Enabled tools</span></div>
      <div class="metric"><strong>${data.stats.projects}</strong><span>Projects</span></div>
      <div class="metric"><strong>${publishedCount}</strong><span>Published</span></div>
      <div class="metric"><strong>${privateCount + draftCount}</strong><span>Private / Draft</span></div>
    </div>
    <section>
      <div class="section-header">
        <div>
          <h2>Projects</h2>
          <p class="section-note">Set visibility directly from the list. Published projects appear on the public share index.</p>
        </div>
      </div>
      ${projectRows ? `<table class="project-table"><thead><tr><th>Project</th><th>Visibility</th><th>Validation</th><th>Files</th><th>Updated</th><th>Created by</th><th>Public URL</th><th>Actions</th></tr></thead><tbody>${projectRows}</tbody></table>` : `<div class="empty">No projects created yet.</div>`}
    </section>
    <section>
      <div class="section-header"><h2>ChatGPT Connectors</h2></div>
      ${clientRows ? `<table><thead><tr><th>Client ID</th><th>Name</th><th>Redirect host</th><th>Access tokens</th><th>Refresh tokens</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>${clientRows}</tbody></table>` : `<div class="empty">No connectors registered yet.</div>`}
    </section>
    <section>
      <div class="section-header"><h2>Tools</h2></div>
      <table><thead><tr><th>Name</th><th>Description</th><th>Access</th></tr></thead><tbody>${toolRows}</tbody></table>
    </section>
    <section>
      <div class="section-header"><h2>Activity</h2></div>
      ${activityRows ? `<table><thead><tr><th>Time</th><th>Client</th><th>Method</th><th>Tool</th><th>Status</th><th>Summary</th></tr></thead><tbody>${activityRows}</tbody></table>` : `<div class="empty">No MCP activity recorded yet.</div>`}
    </section>
	  </main>
	</body>
	</html>`;
}

export function renderPublicSharePage(data: PublicSharePageData): string {
  const copy = publicShareCopy[data.locale];
  const projectCards = data.projects.map((project) => {
    const previewUrl = project.publishedUrl ?? `${data.publicBaseUrl.replace(/\/$/, "")}/share/${project.id}/${project.entryFile}`;
    const updated = formatPublicDate(project.updatedAt, data.locale);
    return `<article class="public-card">
      <h2 class="public-title"><a href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(project.title)}</a></h2>
      <p class="public-meta"><strong>${escapeHtml(copy.id)}:</strong> <code>${escapeHtml(project.id)}</code></p>
      <p class="public-meta"><strong>${escapeHtml(copy.updated)}:</strong> ${escapeHtml(updated)} · <strong>${escapeHtml(copy.files)}:</strong> ${escapeHtml(project.filesCount)}</p>
      <p class="public-summary">${escapeHtml(project.summary || copy.noSummary)}</p>
      <a class="button primary public-link" href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(copy.open)}</a>
    </article>`;
  }).join("");

  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(copy.title)}</title>
  <style>${styles()}</style>
</head>
<body>
  <header class="public-hero">
    <div class="public-shell">
      <div>
        <p class="eyebrow">${escapeHtml(copy.eyebrow)}</p>
        <h1>${escapeHtml(copy.title)}</h1>
        <p>${escapeHtml(copy.subtitle)}</p>
      </div>
      <nav class="language-switch" aria-label="Language">
        <a class="${data.locale === "en" ? "active" : ""}" href="/share/?lang=en" lang="en">EN</a>
        <a class="${data.locale === "zh" ? "active" : ""}" href="/share/?lang=zh" lang="zh-CN">中文</a>
      </nav>
    </div>
  </header>
  <main class="public-shell">
    <div class="public-summary-bar">
      <div>
        <h2>${escapeHtml(copy.sectionTitle)}</h2>
        <p class="section-note">${escapeHtml(data.publicBaseUrl)}/share/?lang=${escapeHtml(data.locale)}</p>
      </div>
      <div class="public-count"><strong>${escapeHtml(data.projects.length)}</strong><span>${escapeHtml(copy.countLabel)}</span></div>
    </div>
    <section>
      ${projectCards ? `<div class="public-list">${projectCards}</div>` : `<div class="empty">${escapeHtml(copy.empty)}</div>`}
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
  const researchSummary = data.researchSummary
    ? `<section>
      <h2>Research</h2>
      <div class="stats">
        <div class="metric"><strong>${escapeHtml(data.researchSummary.sourceCount)}</strong><span>Sources</span></div>
        <div class="metric"><strong>${escapeHtml(data.researchSummary.usedSourceCount)}</strong><span>Used sources</span></div>
        <div class="metric"><strong>${escapeHtml(data.researchSummary.evidenceCount)}</strong><span>Evidence items</span></div>
        <div class="metric"><strong>${data.researchSummary.report.markdownExists ? "yes" : "no"}</strong><span>report.md</span></div>
        <div class="metric"><strong>${data.researchSummary.report.htmlExists ? "yes" : "no"}</strong><span>report.html</span></div>
      </div>
      <div class="actions">
        <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${data.project.id}?path=report.md`))}">Open report.md</a>
        <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${data.project.id}?path=report.html`))}">Open report.html</a>
        <a class="button secondary" href="${escapeHtml(withToken(`/admin/projects/${data.project.id}?path=research/research.json`))}">Open research.json</a>
      </div>
    </section>`
    : "";
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
    ${researchSummary}
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
