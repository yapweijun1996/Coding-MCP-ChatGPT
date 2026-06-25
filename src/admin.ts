import type { ActivityEvent } from "./activity.js";
import type { OAuthClientStatus } from "./oauth.js";
import type { ProjectFileInfo, ProjectManifest, ProjectMetadata, ProjectStatus, ProjectSummary, ProjectValidationResult } from "./projects/store.js";
import type { ResearchReportStatus } from "./research/store.js";
import type { SkillState } from "./skills/state.js";
import type { VisibleBrowserControlState } from "./special-tools.js";
import type { EffectiveToolState } from "./tool-state.js";

export type PublicShareLocale = "en" | "zh";

export interface AdminPageData {
  publicBaseUrl: string;
  adminToken: string;
  clients: OAuthClientStatus[];
  specialTools: VisibleBrowserControlState[];
  skills: SkillState[];
  tools: EffectiveToolState[];
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

function publicContentUrl(baseUrl: string, project: ProjectSummary): string {
  const fallbackPath = `/share/${project.id}/${project.entryFile}`;
  const normalizedBase = baseUrl.replace(/\/$/, "");
  if (!project.publishedUrl) return `${normalizedBase}${fallbackPath}`;
  try {
    const published = new URL(project.publishedUrl);
    return `${normalizedBase}${published.pathname}${published.search}${published.hash}`;
  } catch {
    return `${normalizedBase}${fallbackPath}`;
  }
}

function escapeHtml(value: string | number | boolean | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function styles(): string {
  return `
    :root { --bg: #f4f6f8; --ink: #18231f; --muted: #68746f; --line: #dce3df; --surface: #fff; --surface-2: #f8faf9; --accent: #16685f; --accent-ink: #fff; --danger: #aa332e; --warning: #8a6200; --soft: #e8efec; --focus: #2b7bd8; --sidebar: #15231f; --sidebar-muted: #aebbb6; --sidebar-hover: #22352f; --safe-top: env(safe-area-inset-top, 0px); --safe-right: env(safe-area-inset-right, 0px); --safe-bottom: env(safe-area-inset-bottom, 0px); --safe-left: env(safe-area-inset-left, 0px); }
    * { box-sizing: border-box; }
    html { min-width: 320px; min-height: 100%; text-size-adjust: 100%; -webkit-text-size-adjust: 100%; touch-action: manipulation; }
    body { margin: 0; min-height: 100vh; min-height: 100dvh; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; overscroll-behavior-x: none; }
    header { padding: calc(18px + var(--safe-top)) calc(28px + var(--safe-right)) 18px 28px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.94); position: sticky; top: 0; z-index: 10; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .eyebrow { margin: 0 0 4px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 0; font-size: 24px; line-height: 1.15; }
    h1 a { color: inherit; text-decoration: none; }
    header p { margin: 6px 0 0; color: var(--muted); }
    main { width: min(1520px, calc(100% - 48px)); margin: 22px auto 48px; }
    .admin-shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    .admin-sidebar { background: var(--sidebar); color: #f7faf8; border-right: 1px solid #0d1815; padding: calc(18px + var(--safe-top)) 14px calc(18px + var(--safe-bottom)) calc(14px + var(--safe-left)); position: sticky; top: 0; height: 100vh; height: 100dvh; overflow: auto; z-index: 20; -webkit-overflow-scrolling: touch; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 18px; border-bottom: 1px solid rgba(255,255,255,.09); }
    .brand-mark { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: #d8f2ea; color: #0f4d45; font-weight: 900; }
    .brand-title { display: block; font-size: 15px; font-weight: 800; }
    .brand-subtitle { display: block; color: var(--sidebar-muted); font-size: 12px; margin-top: 2px; }
    .admin-sidebar nav { margin-top: 16px; display: grid; gap: 4px; }
    .admin-sidebar a { display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none; color: #e9f0ed; font-weight: 700; font-size: 13px; border-radius: 8px; padding: 9px 10px; }
    .admin-sidebar a:hover { background: var(--sidebar-hover); }
    .nav-icon { width: 24px; height: 24px; flex: 0 0 24px; display: grid; place-items: center; border-radius: 7px; background: rgba(255,255,255,.08); color: #d8f2ea; font-size: 11px; font-weight: 900; }
    .sidebar-foot { margin-top: 22px; padding: 12px 10px; border-top: 1px solid rgba(255,255,255,.09); color: var(--sidebar-muted); font-size: 12px; line-height: 1.4; }
    .sidebar-backdrop { display: none; }
    .admin-content { min-width: 0; }
    .title-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .sidebar-toggle { width: 44px; height: 44px; min-width: 0; padding: 0; background: var(--surface-2); color: var(--ink); border-radius: 8px; border: 1px solid var(--line); font-weight: 900; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
    .metric strong { display: block; font-size: 24px; line-height: 1; }
    .metric span { color: var(--muted); font-size: 13px; }
    section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; overflow: hidden; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
    .section-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 17px; }
    section > h2 { padding: 16px; border-bottom: 1px solid var(--line); }
    .section-note { color: var(--muted); font-size: 13px; margin: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 800; background: var(--surface-2); text-transform: uppercase; letter-spacing: .04em; }
    tbody tr:hover { background: #fbfcfb; }
    .truncate, td code, .project-title, .project-id, .url-cell a, .compact-date { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; padding: 8px 11px; color: white; cursor: pointer; min-width: 58px; min-height: 40px; text-decoration: none; font-size: 16px; line-height: 1.15; font-weight: 800; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, .button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid color-mix(in srgb, var(--focus), transparent 70%); outline-offset: 2px; }
    .enabled, .primary { background: var(--accent); color: var(--accent-ink); }
    .disabled, .danger { background: var(--danger); color: #fff; }
    .secondary { background: #47544d; color: #fff; }
    .ghost { color: var(--accent); background: #e6f2ef; }
    .empty { color: var(--muted); padding: 16px; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
    .project-actions { display: flex; gap: 7px; flex-wrap: nowrap; align-items: center; }
    .project-actions .button,
    .project-actions button { width: 38px; height: 38px; min-width: 0; min-height: 38px; padding: 0; }
    .icon-button svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .actions form { margin: 0; }
    .pill { display: inline-block; border-radius: 999px; background: var(--soft); color: var(--muted); padding: 4px 9px; font-size: 12px; font-weight: 700; }
    .badge-published { background: #ddf3eb; color: #106042; }
    .badge-private { background: #e7eef8; color: #244b76; }
    .badge-draft { background: #f0eee8; color: #645d51; }
    .badge-deleted { background: #f8d8d8; color: #8a1f1f; }
    .badge-low { background: #e3f3e8; color: #176139; }
    .badge-medium { background: #fff0c2; color: #6a4a00; }
    .badge-high { background: #f8d8d8; color: #8a1f1f; }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; }
    .file-list a { display: block; padding: 8px 10px; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); }
    .file-list a.active { background: var(--soft); font-weight: 700; }
    .code-view { width: 100%; min-height: 620px; box-sizing: border-box; resize: vertical; border: 0; border-top: 1px solid var(--line); padding: 16px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #18241e; background: #fbfcf8; }
    .meta { color: var(--muted); margin: 6px 0 0; }
    .error { color: var(--danger); padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .json-view { margin: 0; padding: 16px; overflow: auto; max-height: 360px; background: #fbfcf8; border-top: 1px solid var(--line); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    .sidebar-collapsed .admin-sidebar { width: 68px; padding: 14px 8px; }
    .sidebar-collapsed .brand { justify-content: center; padding: 4px 0 14px; }
    .sidebar-collapsed .brand-text,
    .sidebar-collapsed .admin-sidebar .text,
    .sidebar-collapsed .sidebar-foot { display: none; }
    .sidebar-collapsed .admin-sidebar a { justify-content: center; padding: 10px 0; }
    body.sidebar-collapsed .admin-shell { grid-template-columns: 68px minmax(0, 1fr); }
    .section-anchor { scroll-margin-top: 90px; }
    .admin-content main { width: min(1440px, calc(100% - 32px)); margin: 20px auto 48px; }
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
    .project-id { margin-top: 5px; color: var(--muted); }
    .url-cell a { display: block; }
    .status-form { display: flex; flex-direction: column; gap: 7px; align-items: flex-start; }
    .status-control { display: inline-flex; gap: 6px; align-items: center; }
    input, select, textarea { font-size: 16px; }
    select { min-width: 112px; min-height: 44px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); padding: 7px 8px; font: inherit; }
    .mini-button { min-width: 0; padding: 7px 10px; }
    .special-tool-table th:nth-child(1) { width: 18%; }
    .special-tool-table th:nth-child(2) { width: 14%; }
    .special-tool-table th:nth-child(3) { width: 18%; }
    .special-tool-table th:nth-child(4) { width: 16%; }
    .special-tool-table th:nth-child(5) { width: 34%; }
    .project-table th:nth-child(1) { width: 18%; }
    .project-table th:nth-child(2) { width: 13%; }
    .project-table th:nth-child(3) { width: 8%; }
    .project-table th:nth-child(4) { width: 5%; }
    .project-table th:nth-child(5) { width: 11%; }
    .project-table th:nth-child(6) { width: 14%; }
    .project-table th:nth-child(7) { width: 14%; }
    .project-table th:nth-child(8) { width: 17%; }
    @media (max-width: 1100px) { .stats { grid-template-columns: 1fr 1fr; } .layout { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; table-layout: auto; } th, td { min-width: 140px; } .project-table th:nth-child(n) { width: auto; } }
    @media (max-width: 900px) {
      body { overflow-x: hidden; }
      .admin-shell, body.sidebar-collapsed .admin-shell { display: block; }
      .admin-sidebar,
      .sidebar-collapsed .admin-sidebar { position: fixed; inset: 0 auto 0 0; width: min(82vw, 300px); height: 100vh; height: 100dvh; padding: calc(18px + var(--safe-top)) 14px calc(18px + var(--safe-bottom)) calc(14px + var(--safe-left)); transform: translateX(-105%); transition: transform .18s ease; box-shadow: 18px 0 40px rgba(12, 22, 19, .24); }
      body.sidebar-open .admin-sidebar { transform: translateX(0); }
      .sidebar-collapsed .brand { justify-content: flex-start; padding: 6px 8px 18px; }
      .sidebar-collapsed .brand-text,
      .sidebar-collapsed .admin-sidebar .text,
      .sidebar-collapsed .sidebar-foot { display: block; }
      .sidebar-collapsed .admin-sidebar a { justify-content: flex-start; padding: 9px 10px; }
      body.sidebar-open .sidebar-backdrop { display: block; position: fixed; inset: 0; z-index: 15; min-width: 0; min-height: 100vh; min-height: 100dvh; padding: 0; border: 0; border-radius: 0; background: rgba(8, 15, 13, .44); cursor: default; }
      .admin-content main { width: min(100% - 20px, 1440px); margin-top: 16px; }
      header { padding: calc(16px + var(--safe-top)) calc(18px + var(--safe-right)) 16px calc(18px + var(--safe-left)); }
    }
    @media (max-width: 760px) {
      .admin-content table,
      .admin-content thead,
      .admin-content tbody,
      .admin-content tr,
      .admin-content td { display: block; width: 100%; }
      .admin-content thead { display: none; }
      .admin-content table { overflow: visible; table-layout: auto; }
      .admin-content tbody { display: grid; gap: 12px; padding: 12px; }
      .admin-content tr { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--surface); }
      .admin-content td { min-width: 0; display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; align-items: start; padding: 10px 12px; }
      .admin-content td::before { content: attr(data-label); color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      .admin-content td[data-label="Actions"],
      .admin-content td[data-label="Access"],
      .admin-content td[data-label="Tool override"] { display: block; }
      .admin-content td[data-label="Actions"]::before,
      .admin-content td[data-label="Access"]::before,
      .admin-content td[data-label="Tool override"]::before { display: block; margin-bottom: 8px; }
      .admin-content .actions { align-items: stretch; }
      .admin-content .actions .button,
      .admin-content .actions button { flex: 1 1 130px; }
      .project-actions { flex-wrap: wrap; }
      .project-actions .button,
      .project-actions button { flex: 0 0 44px; width: 44px; height: 44px; min-height: 44px; }
      .truncate, td code, .project-title, .project-id, .url-cell a, .compact-date { white-space: normal; overflow-wrap: anywhere; }
    }
    @media (max-width: 640px) { header { padding: calc(14px + var(--safe-top)) calc(14px + var(--safe-right)) 14px calc(14px + var(--safe-left)); } .topbar, .public-hero .public-shell, .public-summary-bar { align-items: flex-start; flex-direction: column; } .topbar .actions { width: 100%; } .topbar .button { width: 100%; } h1 { font-size: 21px; } header p { overflow-wrap: anywhere; } main { width: min(100% - 20px, 1440px); margin-bottom: calc(48px + var(--safe-bottom)); } .stats { grid-template-columns: 1fr 1fr; } .metric { padding: 12px; } .metric strong { font-size: 22px; } .section-header { padding: 12px; } .public-shell { width: min(100% - 24px, 1180px); } .public-hero { padding: calc(28px + var(--safe-top)) 0 28px; } .public-hero h1 { font-size: 28px; } }
    @media (max-width: 460px) { .stats { grid-template-columns: 1fr; } .admin-content td { grid-template-columns: 1fr; gap: 6px; } .status-control { width: 100%; align-items: stretch; } select { width: 100%; } .mini-button { min-width: 84px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .001ms !important; animation-duration: .001ms !important; } }
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
  const icon = {
    open: `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"></path></svg>`,
    code: `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m10 16-4-4 4-4"></path><path d="m14 8 4 4-4 4"></path></svg>`,
    download: `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>`,
    delete: `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>`
  };
  const clientRows = data.clients.map((client) => `
    <tr>
	      <td data-label="Client ID"><code title="${escapeHtml(client.clientId)}">${escapeHtml(client.clientId)}</code></td>
	      <td data-label="Name"><span class="truncate" title="${escapeHtml(client.clientName)}">${escapeHtml(client.clientName)}</span></td>
	      <td data-label="Redirect host"><span class="truncate" title="${escapeHtml(client.redirectHost)}">${escapeHtml(client.redirectHost)}</span></td>
	      <td data-label="Access tokens">${escapeHtml(client.activeAccessTokens)}</td>
	      <td data-label="Refresh tokens">${escapeHtml(client.refreshTokens)}</td>
	      <td data-label="Last used">${escapeHtml(client.lastUsedAt ?? "-")}</td>
	      <td data-label="Requests">${escapeHtml(client.requestCount)}</td>
	      <td data-label="Action">
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
	      <td data-label="Project"><span class="project-title" title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</span><code class="project-id" title="${escapeHtml(project.id)}">${escapeHtml(project.id)}</code></td>
	      <td data-label="Visibility">${statusControls}</td>
	      <td data-label="Validation"><span class="pill ${validation.className}">${escapeHtml(validation.label)}</span></td>
	      <td data-label="Files">${escapeHtml(project.filesCount)}</td>
	      <td data-label="Updated" class="compact-date" title="${escapeHtml(formatDate(project.updatedAt))}">${escapeHtml(formatDate(project.updatedAt))}</td>
	      <td data-label="Created by"><code title="${escapeHtml(project.createdByClientId)}">${escapeHtml(project.createdByClientId)}</code></td>
	      <td data-label="Public URL" class="url-cell">${project.publishedUrl ? `<a href="${escapeHtml(project.publishedUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(project.publishedUrl)}">${escapeHtml(project.publishedUrl)}</a>` : `<span class="pill badge-empty">not public</span>`}</td>
	      <td data-label="Actions">
	        <div class="actions project-actions">
	          ${project.publishedUrl ? `<a class="button primary icon-button" href="${escapeHtml(project.publishedUrl)}" target="_blank" rel="noreferrer" aria-label="Open preview" title="Open preview">${icon.open}</a>` : ""}
	          <a class="button secondary icon-button" href="${escapeHtml(withToken(`/admin/projects/${project.id}`))}" aria-label="View code" title="View code">${icon.code}</a>
	          <a class="button secondary icon-button" href="${escapeHtml(withToken(`/admin/projects/${project.id}/download.zip`))}" aria-label="Download ZIP" title="Download ZIP">${icon.download}</a>
	          <form method="post" action="/admin/projects/${escapeHtml(project.id)}/delete${adminTokenQuery}" onsubmit="return confirm('Soft-delete this project?')">
	            <button class="danger icon-button" type="submit" aria-label="Delete project" title="Delete project">${icon.delete}</button>
	          </form>
        </div>
      </td>
    </tr>`;
  }).join("");

  const skillRows = data.skills.map((skill) => `
    <tr>
	      <td data-label="Skill"><strong class="truncate" title="${escapeHtml(skill.label)}">${escapeHtml(skill.label)}</strong><code class="project-id" title="${escapeHtml(skill.id)}">${escapeHtml(skill.id)}</code></td>
	      <td data-label="Category"><span class="truncate" title="${escapeHtml(skill.category)}">${escapeHtml(skill.category)}</span></td>
	      <td data-label="Risk"><span class="pill badge-${escapeHtml(skill.riskLevel)}">${escapeHtml(skill.riskLevel)}</span></td>
	      <td data-label="Status"><span class="pill">${escapeHtml(skill.status)}</span></td>
	      <td data-label="Tools">${escapeHtml(skill.toolCount)}</td>
	      <td data-label="Description"><span class="truncate" title="${escapeHtml(skill.description)}">${escapeHtml(skill.description)}</span></td>
	      <td data-label="Access">
        <form method="post" action="/admin/skills/toggle${adminTokenQuery}">
          <input type="hidden" name="id" value="${escapeHtml(skill.id)}">
          <input type="hidden" name="enabled" value="${skill.enabled ? "0" : "1"}">
          <button class="${skill.enabled ? "enabled" : "disabled"}" type="submit">${skill.enabled ? "On" : "Off"}</button>
        </form>
      </td>
    </tr>`).join("");

  const toolAccessLabel = (tool: EffectiveToolState): string => {
    if (tool.access === "blocked_by_tool") return "Blocked by tool";
    if (tool.access === "blocked_by_skill") return "Blocked by skill";
    return "Enabled";
  };
  const toolRows = data.tools.map((tool) => `
    <tr>
	      <td data-label="Name"><code title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</code></td>
	      <td data-label="Description"><span class="truncate" title="${escapeHtml(tool.description)}">${escapeHtml(tool.description)}</span></td>
	      <td data-label="Effective access"><span class="pill ${tool.enabled ? "enabled" : "disabled"}">${escapeHtml(toolAccessLabel(tool))}</span><div class="meta truncate" title="${escapeHtml(tool.enabledBySkills.join(", ") || "no enabled skill")}">${escapeHtml(tool.enabledBySkills.join(", ") || "no enabled skill")}</div></td>
	      <td data-label="Tool override">
        <form method="post" action="/admin/tools/toggle${adminTokenQuery}">
          <input type="hidden" name="name" value="${escapeHtml(tool.name)}">
          <input type="hidden" name="enabled" value="${tool.toolEnabled ? "0" : "1"}">
          <button class="${tool.toolEnabled ? "enabled" : "disabled"}" type="submit">${tool.toolEnabled ? "On" : "Off"}</button>
        </form>
      </td>
    </tr>`).join("");

  const specialToolRows = data.specialTools.map((tool) => {
    const status = tool.enabled ? "On" : "Off";
    const statusClass = tool.enabled ? "enabled" : "disabled";
    return `
    <tr>
		      <td data-label="Name"><strong class="truncate" title="${escapeHtml(tool.label)}">${escapeHtml(tool.label)}</strong><code class="project-id" title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</code></td>
	      <td data-label="Status"><span class="pill ${statusClass}">${escapeHtml(status)}</span></td>
	      <td data-label="Enabled until">${escapeHtml(tool.enabledUntil ? formatDate(tool.enabledUntil) : "-")}</td>
		      <td data-label="Enabled by"><code title="${escapeHtml(tool.enabledBy ?? "-")}">${escapeHtml(tool.enabledBy ?? "-")}</code></td>
	      <td data-label="Actions">
        <div class="actions">
          <form method="post" action="/admin/special-tools/visible-browser/enable${adminTokenQuery}">
            <input type="hidden" name="durationMinutes" value="15">
            <button class="enabled" type="submit">Enable 15 min</button>
          </form>
          <form method="post" action="/admin/special-tools/visible-browser/enable${adminTokenQuery}">
            <input type="hidden" name="durationMinutes" value="30">
            <button class="enabled" type="submit">Enable 30 min</button>
          </form>
          <form method="post" action="/admin/special-tools/visible-browser/enable${adminTokenQuery}">
            <input type="hidden" name="durationMinutes" value="60">
            <button class="enabled" type="submit">Enable 60 min</button>
          </form>
          <form method="post" action="/admin/special-tools/visible-browser/disable${adminTokenQuery}">
            <button class="secondary" type="submit">Disable now</button>
          </form>
          <form method="post" action="/admin/special-tools/visible-browser/kill${adminTokenQuery}" onsubmit="return confirm('Kill visible browser sessions?')">
            <button class="danger" type="submit">Kill Browser Session</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join("");

  const activityRows = data.activity.map((event) => `
    <tr>
	      <td data-label="Time">${escapeHtml(event.time)}</td>
		      <td data-label="Client"><code title="${escapeHtml(event.clientId)}">${escapeHtml(event.clientId)}</code></td>
		      <td data-label="Method"><span class="truncate" title="${escapeHtml(event.method)}">${escapeHtml(event.method)}</span></td>
		      <td data-label="Tool"><span class="truncate" title="${escapeHtml(event.toolName ?? "-")}">${escapeHtml(event.toolName ?? "-")}</span></td>
		      <td data-label="Status">${event.ok ? "OK" : "Fail"}</td>
		      <td data-label="Summary"><span class="truncate" title="${escapeHtml(event.summary)}">${escapeHtml(event.summary)}</span></td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#15231f">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <title>Coding MCP Admin</title>
  <style>${styles()}</style>
</head>
<body>
  <button id="sidebar-backdrop" class="sidebar-backdrop" type="button" aria-label="Close sidebar"></button>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="brand">
        <span class="brand-mark">CM</span>
        <span class="brand-text">
          <span class="brand-title">Coding MCP</span>
          <span class="brand-subtitle">Admin Console</span>
        </span>
      </div>
      <nav aria-label="Admin sections">
        <a href="#admin-projects"><span class="nav-icon" aria-hidden="true">P</span><span class="text">Projects</span></a>
        <a href="#admin-connectors"><span class="nav-icon" aria-hidden="true">C</span><span class="text">Connectors</span></a>
        <a href="#admin-special-tools"><span class="nav-icon" aria-hidden="true">S</span><span class="text">Special Tools</span></a>
        <a href="#admin-skills"><span class="nav-icon" aria-hidden="true">K</span><span class="text">Skills</span></a>
        <a href="#admin-tools"><span class="nav-icon" aria-hidden="true">T</span><span class="text">Tool Overrides</span></a>
        <a href="#admin-activity"><span class="nav-icon" aria-hidden="true">A</span><span class="text">Activity</span></a>
        <a href="/share"><span class="nav-icon" aria-hidden="true">I</span><span class="text">Public Index</span></a>
      </nav>
      <div class="sidebar-foot">MCP administration, project publishing, and tool access controls.</div>
    </aside>
    <div class="admin-content">
      <header>
        <div class="topbar">
          <div class="title-row">
            <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-label="Toggle sidebar">☰</button>
            <div>
              <p class="eyebrow">Admin panel</p>
              <h1>Coding MCP Admin</h1>
              <p>${escapeHtml(data.publicBaseUrl)}/mcp</p>
            </div>
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
        <section id="admin-projects" class="section-anchor">
          <div class="section-header">
            <div>
              <h2>Projects</h2>
              <p class="section-note">Set visibility directly from the list. Published projects appear on the public share index.</p>
            </div>
          </div>
          ${projectRows ? `<table class="project-table"><thead><tr><th>Project</th><th>Visibility</th><th>Validation</th><th>Files</th><th>Updated</th><th>Created by</th><th>Public URL</th><th>Actions</th></tr></thead><tbody>${projectRows}</tbody></table>` : `<div class="empty">No projects created yet.</div>`}
        </section>
        <section id="admin-connectors" class="section-anchor">
          <div class="section-header"><h2>ChatGPT Connectors</h2></div>
          ${clientRows ? `<table><thead><tr><th>Client ID</th><th>Name</th><th>Redirect host</th><th>Access tokens</th><th>Refresh tokens</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>${clientRows}</tbody></table>` : `<div class="empty">No connectors registered yet.</div>`}
        </section>
        <section id="admin-special-tools" class="section-anchor">
          <div class="section-header">
            <div>
              <h2>Special Tools</h2>
              <p class="section-note">High-risk tools are hidden from MCP until explicitly enabled for a limited time.</p>
            </div>
          </div>
          ${specialToolRows ? `<table class="special-tool-table"><thead><tr><th>Name</th><th>Status</th><th>Enabled until</th><th>Enabled by</th><th>Actions</th></tr></thead><tbody>${specialToolRows}</tbody></table>` : `<div class="empty">No special tools configured.</div>`}
        </section>
        <section id="admin-skills" class="section-anchor">
          <div class="section-header">
            <div>
              <h2>Skills</h2>
              <p class="section-note">Skill packs control which MCP tools and SOPs an agent can access.</p>
            </div>
          </div>
          <table><thead><tr><th>Skill</th><th>Category</th><th>Risk</th><th>Status</th><th>Tools</th><th>Description</th><th>Access</th></tr></thead><tbody>${skillRows}</tbody></table>
        </section>
        <section id="admin-tools" class="section-anchor">
          <div class="section-header">
            <div>
              <h2>Advanced Tool Overrides</h2>
              <p class="section-note">A tool is callable only when both its override and at least one exposing skill are enabled.</p>
            </div>
          </div>
          <table><thead><tr><th>Name</th><th>Description</th><th>Effective access</th><th>Tool override</th></tr></thead><tbody>${toolRows}</tbody></table>
        </section>
        <section id="admin-activity" class="section-anchor">
          <div class="section-header"><h2>Activity</h2></div>
          ${activityRows ? `<table><thead><tr><th>Time</th><th>Client</th><th>Method</th><th>Tool</th><th>Status</th><th>Summary</th></tr></thead><tbody>${activityRows}</tbody></table>` : `<div class="empty">No MCP activity recorded yet.</div>`}
        </section>
      </main>
    </div>
  </div>
  <script>
    (function () {
      const body = document.body;
      const toggle = document.getElementById("sidebar-toggle");
      const backdrop = document.getElementById("sidebar-backdrop");
      const mobileQuery = window.matchMedia("(max-width: 900px)");
      if (!toggle) return;

      function syncMode() {
        if (mobileQuery.matches) {
          body.classList.remove("sidebar-collapsed");
          body.classList.remove("sidebar-open");
          return;
        }
        body.classList.remove("sidebar-open");
        if (localStorage.getItem("coding-mcp-admin-sidebar-collapsed") === "1") {
          body.classList.add("sidebar-collapsed");
        } else {
          body.classList.remove("sidebar-collapsed");
        }
      }

      syncMode();
      mobileQuery.addEventListener("change", syncMode);

      toggle.addEventListener("click", () => {
        if (mobileQuery.matches) {
          body.classList.toggle("sidebar-open");
          return;
        }
        body.classList.toggle("sidebar-collapsed");
        localStorage.setItem("coding-mcp-admin-sidebar-collapsed", body.classList.contains("sidebar-collapsed") ? "1" : "0");
      });

      backdrop?.addEventListener("click", () => {
        body.classList.remove("sidebar-open");
      });

      document.querySelectorAll(".admin-sidebar a").forEach((link) => {
        link.addEventListener("click", () => {
          if (mobileQuery.matches) body.classList.remove("sidebar-open");
        });
      });
    })();
  </script>
</body>
</html>`;
}

export function renderPublicSharePage(data: PublicSharePageData): string {
  const copy = publicShareCopy[data.locale];
  const projectCards = data.projects.map((project) => {
    const previewUrl = publicContentUrl(data.publicBaseUrl, project);
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
