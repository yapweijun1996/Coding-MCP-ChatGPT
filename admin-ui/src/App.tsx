import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  KeyRound,
  LogOut,
  Menu,
  RotateCcw,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, loadSession, login, setCsrfToken } from "./api";
import type {
  ActivityEvent,
  ClientStatus,
  OverviewResult,
  PageResult,
  ProjectFileInfo,
  ProjectManifest,
  ProjectStatus,
  ProjectSummary,
  SettingsResult,
  SkillState,
  SpecialToolState,
  ToolState,
  ValidationStatus
} from "./types";

type Route = "overview" | "projects" | "project-detail" | "tools" | "connectors" | "activity" | "settings" | "login";
type Toast = { id: number; tone: "success" | "error"; message: string };
type ConfirmState = {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void>;
};

const navItems: Array<{ route: Route; href: string; label: string; icon: ReactNode }> = [
  { route: "overview", href: "/admin", label: "Overview", icon: <Activity size={18} /> },
  { route: "projects", href: "/admin/projects", label: "Projects", icon: <Archive size={18} /> },
  { route: "tools", href: "/admin/tools", label: "Tools & Skills", icon: <Wrench size={18} /> },
  { route: "connectors", href: "/admin/connectors", label: "Connectors", icon: <KeyRound size={18} /> },
  { route: "activity", href: "/admin/activity", label: "Activity", icon: <ShieldAlert size={18} /> },
  { route: "settings", href: "/admin/settings", label: "Settings", icon: <Settings size={18} /> }
];

function currentRoute(): { route: Route; projectId?: string } {
  const path = window.location.pathname.replace(/\/+$/, "") || "/admin";
  if (path === "/admin/login") return { route: "login" };
  if (path === "/admin/projects") return { route: "projects" };
  const projectMatch = /^\/admin\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) return { route: "project-detail", projectId: decodeURIComponent(projectMatch[1]) };
  if (path === "/admin/tools") return { route: "tools" };
  if (path === "/admin/connectors") return { route: "connectors" };
  if (path === "/admin/activity") return { route: "activity" };
  if (path === "/admin/settings") return { route: "settings" };
  return { route: "overview" };
}

function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function fmtDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function validationStatus(project: ProjectSummary): ValidationStatus {
  return project.lastValidation?.status ?? "not_checked";
}

function badgeClass(value: string): string {
  if (["published", "valid", "ok", "enabled", "low"].includes(value)) return "badge good";
  if (["warnings", "private", "medium", "draft", "not_checked"].includes(value)) return "badge warn";
  if (["failed", "deleted", "fail", "high", "disabled"].includes(value)) return "badge bad";
  return "badge neutral";
}

function useRoute(): { route: Route; projectId?: string } {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

function useQueryState(defaults: Record<string, string>): [URLSearchParams, (updates: Record<string, string>) => void] {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const onPop = () => setSearch(window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const params = useMemo(() => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(defaults)) {
      if (!next.has(key)) next.set(key, value);
    }
    return next;
  }, [defaults, search]);
  const update = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const query = next.toString();
    window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    setSearch(window.location.search);
  };
  return [params, update];
}

function IconButton({ label, children, onClick, href, tone = "secondary" }: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "primary" | "secondary" | "danger";
}) {
  const className = `icon-action ${tone}`;
  if (href) {
    return <a className={className} href={href} aria-label={label} title={label}>{children}</a>;
  }
  return <button className={className} type="button" onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><strong>{title}</strong><span>{body}</span></div>;
}

function Pagination({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (page: number) => void }) {
  return (
    <div className="pagination">
      <span>{total} results</span>
      <div className="pager-buttons">
        <IconButton label="Previous page" onClick={() => onPage(Math.max(1, page - 1))}><ChevronLeft size={18} /></IconButton>
        <span>Page {page} of {pageCount}</span>
        <IconButton label="Next page" onClick={() => onPage(Math.min(pageCount, page + 1))}><ChevronRight size={18} /></IconButton>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactNav, setCompactNav] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | undefined>();

  const toast = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const run = useCallback(async (action: () => Promise<void>, success?: string) => {
    try {
      await action();
      if (success) toast("success", success);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Action failed.");
    }
  }, [toast]);

  useEffect(() => {
    loadSession()
      .then((session) => {
        setAuthenticated(session.authenticated);
        if (!session.authenticated && route.route !== "login") navigate("/admin/login");
      })
      .catch(() => {
        setAuthenticated(false);
        if (route.route !== "login") navigate("/admin/login");
      })
      .finally(() => setSessionLoading(false));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        setConfirm(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      setCompactNav(query.matches);
      if (query.matches) setSidebarCollapsed(false);
      else setDrawerOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  if (sessionLoading) return <div className="screen-loader">Loading admin console...</div>;
  if (route.route === "login" || !authenticated) {
    return <LoginPage onLogin={() => { setAuthenticated(true); navigate("/admin"); }} toast={toast} />;
  }

  const title = route.route === "overview" ? "Overview"
    : route.route === "project-detail" ? "Project Detail"
      : navItems.find((item) => item.route === route.route)?.label ?? "Admin";

  return (
    <div className={`app-shell${drawerOpen ? " drawer-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <button className="drawer-backdrop" type="button" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
      <aside className="sidebar" aria-label="Admin navigation">
        <div className="brand">
          <span className="brand-mark">CM</span>
          <span><strong>Coding MCP</strong><small>Operations Console</small></span>
        </div>
        <nav>
          {navItems.map((item) => (
            <a
              key={item.href}
              className={route.route === item.route ? "active" : ""}
              href={item.href}
              onClick={(event) => {
                event.preventDefault();
                setDrawerOpen(false);
                navigate(item.href);
              }}
            >
              {item.icon}<span>{item.label}</span>
            </a>
          ))}
        </nav>
        <a className="public-link" href="/share" target="_blank" rel="noreferrer"><ExternalLink size={16} /> Public Index</a>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button
            className="menu-button"
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={compactNav ? drawerOpen : !sidebarCollapsed}
            onClick={() => {
              if (compactNav) setDrawerOpen((open) => !open);
              else setSidebarCollapsed((collapsed) => !collapsed);
            }}
          >
            <Menu size={20} />
          </button>
          <div><p className="eyebrow">Admin</p><h1>{title}</h1></div>
          <button className="button subtle" type="button" onClick={() => run(async () => {
            await api("/session", { method: "DELETE" });
            setCsrfToken(undefined);
            setAuthenticated(false);
            navigate("/admin/login");
          })}><LogOut size={16} /> Sign out</button>
        </header>
        <div className="content">
          {route.route === "overview" && <OverviewPage />}
          {route.route === "projects" && <ProjectsPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "project-detail" && route.projectId && <ProjectDetailPage projectId={route.projectId} setConfirm={setConfirm} toast={toast} />}
          {route.route === "tools" && <ToolsPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "connectors" && <ConnectorsPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "activity" && <ActivityPage />}
          {route.route === "settings" && <SettingsPage />}
        </div>
      </main>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => <div key={item.id} className={`toast ${item.tone}`}>{item.message}</div>)}
      </div>
      {confirm && <ConfirmModal state={confirm} onClose={() => setConfirm(undefined)} toast={toast} />}
    </div>
  );
}

function LoginPage({ onLogin, toast }: { onLogin: () => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await login(passcode);
      onLogin();
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark">CM</span>
        <h1>Coding MCP Admin</h1>
        <p>Sign in to manage project publishing, tools, connectors, and audit activity.</p>
        <label>Admin passcode<input type="password" value={passcode} autoFocus onChange={(event) => setPasscode(event.target.value)} /></label>
        <button className="button primary" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
}

function OverviewPage() {
  const [data, setData] = useState<OverviewResult | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<OverviewResult>("/overview").then(setData).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load overview."));
  }, []);
  if (error) return <EmptyState title="Overview unavailable" body={error} />;
  if (!data) return <div className="panel">Loading overview...</div>;
  const cards = [
    ["Failed validations", data.metrics.failedValidations, <AlertTriangle size={20} />],
    ["Active special tools", data.metrics.activeSpecialTools, <ShieldAlert size={20} />],
    ["Failed calls", data.metrics.failedCalls, <Activity size={20} />],
    ["Published projects", data.metrics.publishedProjects, <ExternalLink size={20} />],
    ["Stale drafts", data.metrics.staleDrafts, <Archive size={20} />],
    ["Enabled tools", data.metrics.enabledTools, <Wrench size={20} />]
  ] as const;
  return (
    <>
      <section className="metric-grid">{cards.map(([label, value, icon]) => <div className="metric-card" key={label}><span>{icon}</span><strong>{value}</strong><small>{label}</small></div>)}</section>
      <section className="split-grid">
        <div className="panel"><PanelTitle title="Recent failures" /><ActivityList events={data.recentFailures} empty="No failed calls recorded." /></div>
        <div className="panel"><PanelTitle title="Recent projects" /><ProjectList projects={data.recentProjects} /></div>
      </section>
    </>
  );
}

function ProjectsPage({ setConfirm, toast }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [params, updateParams] = useQueryState({ page: "1", pageSize: "20", sort: "updated-desc" });
  const [data, setData] = useState<PageResult<ProjectSummary>>();
  const [error, setError] = useState("");
  const query = params.toString();
  const reload = useCallback(() => {
    api<PageResult<ProjectSummary>>(`/projects?${query}`).then(setData).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load projects."));
  }, [query]);
  useEffect(() => reload(), [reload]);
  return (
    <section className="panel">
      <PanelTitle title="Projects" action={<a className="button subtle" href="/share" target="_blank" rel="noreferrer"><ExternalLink size={16} /> Public index</a>} />
      <Toolbar>
        <label className="search-field"><Search size={16} /><input placeholder="Search projects" value={params.get("q") ?? ""} onChange={(event) => updateParams({ q: event.target.value, page: "1" })} /></label>
        <select value={params.get("status") ?? ""} onChange={(event) => updateParams({ status: event.target.value, page: "1" })} aria-label="Filter by status">
          <option value="">All statuses</option><option value="published">Published</option><option value="private">Private</option><option value="draft">Draft</option><option value="deleted">Deleted</option>
        </select>
        <select value={params.get("validation") ?? ""} onChange={(event) => updateParams({ validation: event.target.value, page: "1" })} aria-label="Filter by validation">
          <option value="">All validations</option><option value="valid">Valid</option><option value="warnings">Warnings</option><option value="failed">Failed</option><option value="not_checked">Not checked</option>
        </select>
        <select value={params.get("sort") ?? "updated-desc"} onChange={(event) => updateParams({ sort: event.target.value, page: "1" })} aria-label="Sort projects">
          <option value="updated-desc">Updated newest</option><option value="updated-asc">Updated oldest</option><option value="title-asc">Title A-Z</option><option value="status-asc">Status</option><option value="validation-desc">Validation</option>
        </select>
      </Toolbar>
      {error && <EmptyState title="Projects unavailable" body={error} />}
      {!error && !data && <div className="table-loader">Loading projects...</div>}
      {data && <ProjectTable projects={data.items} onReload={reload} setConfirm={setConfirm} toast={toast} />}
      {data && <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onPage={(page) => updateParams({ page: String(page) })} />}
    </section>
  );
}

function ProjectTable({ projects, onReload, setConfirm, toast }: { projects: ProjectSummary[]; onReload: () => void; setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  if (projects.length === 0) return <EmptyState title="No projects found" body="Adjust search or filters to see more projects." />;
  const updateStatus = async (project: ProjectSummary, status: ProjectStatus) => {
    await api(`/projects/${encodeURIComponent(project.id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    toast("success", `Project set to ${status}.`);
    onReload();
  };
  return (
    <div className="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Validation</th><th>Files</th><th>Updated</th><th>Created by</th><th>Actions</th></tr></thead><tbody>
      {projects.map((project) => <tr key={project.id}>
        <td data-label="Project"><button className="link-button" type="button" onClick={() => navigate(`/admin/projects/${encodeURIComponent(project.id)}`)}>{project.title}</button><code>{project.id}</code></td>
        <td data-label="Status"><span className={badgeClass(project.status)}>{project.status}</span>{project.status !== "deleted" && <select value={project.status} onChange={(event) => updateStatus(project, event.target.value as ProjectStatus)} aria-label={`Project status for ${project.title}`}><option value="published">Published</option><option value="private">Private</option><option value="draft">Draft</option></select>}</td>
        <td data-label="Validation"><span className={badgeClass(validationStatus(project))}>{validationStatus(project).replace("_", " ")}</span></td>
        <td data-label="Files">{project.filesCount}</td>
        <td data-label="Updated">{fmtDate(project.updatedAt)}</td>
        <td data-label="Created by"><code>{project.createdByClientId}</code></td>
        <td data-label="Actions"><div className="row-actions">
          {project.publishedUrl && <IconButton label="Open preview" href={project.publishedUrl} tone="primary"><ExternalLink size={18} /></IconButton>}
          <IconButton label="View project" onClick={() => navigate(`/admin/projects/${encodeURIComponent(project.id)}`)}><Eye size={18} /></IconButton>
          <IconButton label="Download ZIP" href={`/admin/api/projects/${encodeURIComponent(project.id)}/download.zip`}><Download size={18} /></IconButton>
          {project.status !== "deleted" && <IconButton label="Delete project" tone="danger" onClick={() => setConfirm({ title: "Delete project", body: `Soft-delete ${project.title}. Public access will be removed.`, confirmLabel: "Delete", tone: "danger", onConfirm: async () => { await api(`/projects/${encodeURIComponent(project.id)}/delete`, { method: "POST" }); toast("success", "Project deleted."); onReload(); } })}><Trash2 size={18} /></IconButton>}
        </div></td>
      </tr>)}
    </tbody></table></div>
  );
}

function ProjectDetailPage({ projectId, setConfirm, toast }: { projectId: string; setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [project, setProject] = useState<ProjectSummary>();
  const [files, setFiles] = useState<ProjectFileInfo[]>([]);
  const [manifest, setManifest] = useState<ProjectManifest>();
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<{ project: ProjectSummary; files: ProjectFileInfo[]; manifest: ProjectManifest }>(`/projects/${encodeURIComponent(projectId)}`)
      .then((data) => { setProject(data.project); setFiles(data.files); setManifest(data.manifest); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load project."));
  }, [projectId]);
  useEffect(() => reload(), [reload]);
  if (error) return <EmptyState title="Project unavailable" body={error} />;
  if (!project) return <div className="panel">Loading project...</div>;
  return (
    <div className="detail-layout">
      <section className="panel">
        <button className="button subtle" type="button" onClick={() => navigate("/admin/projects")}><ChevronLeft size={16} /> Projects</button>
        <h2>{project.title}</h2>
        <p>{project.summary || "No summary provided."}</p>
        <div className="detail-meta">
          <span className={badgeClass(project.status)}>{project.status}</span>
          <span className={badgeClass(validationStatus(project))}>{validationStatus(project).replace("_", " ")}</span>
          <span>{files.length} files</span>
          <span>Updated {fmtDate(project.updatedAt)}</span>
        </div>
        <div className="actions-row">
          {project.publishedUrl && <a className="button primary" href={project.publishedUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open preview</a>}
          <a className="button secondary" href={`/admin/api/projects/${encodeURIComponent(project.id)}/download.zip`}><Download size={16} /> Download ZIP</a>
          {project.status !== "deleted" && <button className="button danger" type="button" onClick={() => setConfirm({ title: "Delete project", body: `Soft-delete ${project.title}.`, confirmLabel: "Delete", tone: "danger", onConfirm: async () => { await api(`/projects/${encodeURIComponent(project.id)}/delete`, { method: "POST" }); toast("success", "Project deleted."); navigate("/admin/projects"); } })}><Trash2 size={16} /> Delete</button>}
        </div>
      </section>
      <section className="panel"><PanelTitle title="Files" />{files.length ? <div className="file-list">{files.map((file) => <div key={file.path}><FileCode2 size={16} /><span>{file.path}</span><small>{Math.round(file.size / 1024)} KB</small></div>)}</div> : <EmptyState title="No files" body="This project has no stored files." />}</section>
      <section className="panel wide"><PanelTitle title="Task history" /><HistoryList items={manifest?.taskHistory ?? []} /></section>
    </div>
  );
}

function ToolsPage({ setConfirm, toast }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [skills, setSkills] = useState<SkillState[]>([]);
  const [tools, setTools] = useState<ToolState[]>([]);
  const [special, setSpecial] = useState<SpecialToolState[]>([]);
  const load = useCallback(async () => {
    const [skillsData, toolsData, specialData] = await Promise.all([
      api<{ skills: SkillState[] }>("/skills"),
      api<{ tools: ToolState[] }>("/tools"),
      api<{ tools: SpecialToolState[] }>("/special-tools")
    ]);
    setSkills(skillsData.skills);
    setTools(toolsData.tools);
    setSpecial(specialData.tools);
  }, []);
  useEffect(() => { load().catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load tools.")); }, [load, toast]);
  const toggleSkill = (skill: SkillState) => setConfirm({ title: `${skill.enabled ? "Disable" : "Enable"} skill`, body: `${skill.label} controls ${skill.toolCount} tool(s).`, confirmLabel: skill.enabled ? "Disable" : "Enable", onConfirm: async () => { await api(`/skills/${encodeURIComponent(skill.id)}/toggle`, { method: "POST", body: JSON.stringify({ enabled: !skill.enabled }) }); await load(); toast("success", "Skill updated."); } });
  const toggleTool = (tool: ToolState) => setConfirm({ title: `${tool.toolEnabled ? "Disable" : "Enable"} tool override`, body: tool.name, confirmLabel: tool.toolEnabled ? "Disable" : "Enable", onConfirm: async () => { await api(`/tools/${encodeURIComponent(tool.name)}/toggle`, { method: "POST", body: JSON.stringify({ enabled: !tool.toolEnabled }) }); await load(); toast("success", "Tool override updated."); } });
  return (
    <div className="stack">
      <section className="panel"><PanelTitle title="Special tools" /><div className="cards-grid">{special.map((tool) => <div className="control-card" key={tool.name}><strong>{tool.label}</strong><code>{tool.name}</code><span className={badgeClass(tool.enabled ? "enabled" : "disabled")}>{tool.enabled ? "enabled" : "disabled"}</span><small>{tool.enabledUntil ? `Until ${fmtDate(tool.enabledUntil)}` : "Time gated access"}</small><div className="actions-row"><button className="button primary" type="button" onClick={() => setConfirm({ title: "Enable visible browser", body: "Enable high-risk visible browser control for 15 minutes.", confirmLabel: "Enable", onConfirm: async () => { await api("/special-tools/visible-browser/enable", { method: "POST", body: JSON.stringify({ durationMinutes: "15" }) }); await load(); toast("success", "Visible browser enabled."); } })}>Enable 15 min</button><button className="button secondary" type="button" onClick={() => setConfirm({ title: "Disable visible browser", body: "Disable visible browser control and close sessions.", confirmLabel: "Disable", onConfirm: async () => { await api("/special-tools/visible-browser/disable", { method: "POST" }); await load(); toast("success", "Visible browser disabled."); } })}>Disable</button></div></div>)}</div></section>
      <section className="panel"><PanelTitle title="Skill packs" /><div className="table-wrap"><table><thead><tr><th>Skill</th><th>Category</th><th>Risk</th><th>Status</th><th>Tools</th><th>Access</th></tr></thead><tbody>{skills.map((skill) => <tr key={skill.id}><td data-label="Skill"><strong>{skill.label}</strong><code>{skill.id}</code></td><td data-label="Category">{skill.category}</td><td data-label="Risk"><span className={badgeClass(skill.riskLevel)}>{skill.riskLevel}</span></td><td data-label="Status">{skill.status}</td><td data-label="Tools">{skill.toolCount}</td><td data-label="Access"><button className={skill.enabled ? "button danger" : "button primary"} type="button" onClick={() => toggleSkill(skill)}>{skill.enabled ? "Disable" : "Enable"}</button></td></tr>)}</tbody></table></div></section>
      <section className="panel"><PanelTitle title="Tool overrides" /><div className="table-wrap"><table><thead><tr><th>Tool</th><th>Description</th><th>Effective access</th><th>Override</th></tr></thead><tbody>{tools.map((tool) => <tr key={tool.name}><td data-label="Tool"><code>{tool.name}</code></td><td data-label="Description">{tool.description}</td><td data-label="Effective access"><span className={badgeClass(tool.enabled ? "enabled" : "disabled")}>{tool.accessLabel}</span><small>{tool.enabledBySkills.join(", ") || "No enabled skill"}</small></td><td data-label="Override"><button className={tool.toolEnabled ? "button danger" : "button primary"} type="button" onClick={() => toggleTool(tool)}>{tool.toolEnabled ? "Disable" : "Enable"}</button></td></tr>)}</tbody></table></div></section>
    </div>
  );
}

function ConnectorsPage({ setConfirm, toast }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const load = useCallback(() => api<{ clients: ClientStatus[] }>("/connectors").then((data) => setClients(data.clients)), []);
  useEffect(() => { load().catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load connectors.")); }, [load, toast]);
  return <section className="panel"><PanelTitle title="ChatGPT connectors" />{clients.length === 0 ? <EmptyState title="No connectors" body="No OAuth clients are registered yet." /> : <div className="table-wrap"><table><thead><tr><th>Client</th><th>Name</th><th>Redirect host</th><th>Tokens</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>{clients.map((client) => <tr key={client.clientId}><td data-label="Client"><code>{client.clientId}</code></td><td data-label="Name">{client.clientName}</td><td data-label="Redirect">{client.redirectHost}</td><td data-label="Tokens">{client.activeAccessTokens} access, {client.refreshTokens} refresh</td><td data-label="Last used">{fmtDate(client.lastUsedAt)}</td><td data-label="Requests">{client.requestCount}</td><td data-label="Action"><button className="button danger" type="button" onClick={() => setConfirm({ title: "Revoke connector", body: `Revoke ${client.clientName}. Existing tokens for this client will no longer work.`, confirmLabel: "Revoke", tone: "danger", onConfirm: async () => { await api(`/connectors/${encodeURIComponent(client.clientId)}/revoke`, { method: "POST" }); await load(); toast("success", "Connector revoked."); } })}>Revoke</button></td></tr>)}</tbody></table></div>}</section>;
}

function ActivityPage() {
  const [params, updateParams] = useQueryState({ page: "1", pageSize: "30" });
  const [data, setData] = useState<PageResult<ActivityEvent>>();
  const query = params.toString();
  useEffect(() => { api<PageResult<ActivityEvent>>(`/activity?${query}`).then(setData).catch(() => undefined); }, [query]);
  return <section className="panel"><PanelTitle title="Activity audit" /><Toolbar><label className="search-field"><Search size={16} /><input placeholder="Search activity" value={params.get("q") ?? ""} onChange={(event) => updateParams({ q: event.target.value, page: "1" })} /></label><select value={params.get("status") ?? ""} onChange={(event) => updateParams({ status: event.target.value, page: "1" })} aria-label="Filter activity status"><option value="">All status</option><option value="ok">OK</option><option value="fail">Fail</option></select><input value={params.get("client") ?? ""} placeholder="Client" onChange={(event) => updateParams({ client: event.target.value, page: "1" })} /><input value={params.get("tool") ?? ""} placeholder="Tool" onChange={(event) => updateParams({ tool: event.target.value, page: "1" })} /></Toolbar>{data ? <><ActivityTable events={data.items} /><Pagination page={data.page} pageCount={data.pageCount} total={data.total} onPage={(page) => updateParams({ page: String(page) })} /></> : <div className="table-loader">Loading activity...</div>}</section>;
}

function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResult>();
  useEffect(() => { api<SettingsResult>("/settings").then(setSettings).catch(() => undefined); }, []);
  if (!settings) return <div className="panel">Loading settings...</div>;
  return <section className="panel"><PanelTitle title="System settings" /><div className="settings-grid">{Object.entries({ "Public base URL": settings.publicBaseUrl, "Workspace root": settings.workspaceRoot, "Project root": settings.projectRoot, "Share root": settings.shareRoot, "Artifact root": settings.artifactRoot, "Session TTL": `${settings.sessionTtlHours} hours` }).map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}</div></section>;
}

function ConfirmModal({ state, onClose, toast }: { state: ConfirmState; onClose: () => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><h2 id="confirm-title">{state.title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={18} /></IconButton></div>
        <p>{state.body}</p>
        <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose}>Cancel</button><button className={state.tone === "danger" ? "button danger" : "button primary"} type="button" disabled={busy} onClick={async () => { setBusy(true); try { await state.onConfirm(); onClose(); } catch (error) { toast("error", error instanceof Error ? error.message : "Action failed."); setBusy(false); } }}>{busy ? "Working..." : state.confirmLabel}</button></div>
      </section>
    </div>
  );
}

function PanelTitle({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="panel-title"><h2>{title}</h2>{action}</div>;
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar"><SlidersHorizontal size={18} />{children}</div>;
}

function ActivityList({ events, empty }: { events: ActivityEvent[]; empty: string }) {
  if (events.length === 0) return <EmptyState title="Clear" body={empty} />;
  return <div className="activity-list">{events.map((event) => <div key={event.id}><span className={badgeClass(event.ok ? "ok" : "fail")}>{event.ok ? "OK" : "Fail"}</span><strong>{event.method}</strong><p>{event.summary}</p><small>{fmtDate(event.time)} · {event.clientId}</small></div>)}</div>;
}

function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  if (projects.length === 0) return <EmptyState title="No projects" body="No projects have been created yet." />;
  return <div className="project-list">{projects.map((project) => <button type="button" key={project.id} onClick={() => navigate(`/admin/projects/${encodeURIComponent(project.id)}`)}><strong>{project.title}</strong><span className={badgeClass(project.status)}>{project.status}</span><small>{fmtDate(project.updatedAt)}</small></button>)}</div>;
}

function HistoryList({ items }: { items: Array<{ id: string; time: string; toolName: string; ok: boolean; summary: string }> }) {
  if (items.length === 0) return <EmptyState title="No task history" body="This project has no recorded task history." />;
  return <div className="activity-list">{items.slice().reverse().map((item) => <div key={item.id}><span className={badgeClass(item.ok ? "ok" : "fail")}>{item.ok ? "OK" : "Fail"}</span><strong>{item.toolName}</strong><p>{item.summary}</p><small>{fmtDate(item.time)}</small></div>)}</div>;
}

function ActivityTable({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) return <EmptyState title="No activity found" body="Adjust filters to inspect other events." />;
  return <div className="table-wrap"><table><thead><tr><th>Time</th><th>Status</th><th>Client</th><th>Method</th><th>Tool</th><th>Summary</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td data-label="Time">{fmtDate(event.time)}</td><td data-label="Status"><span className={badgeClass(event.ok ? "ok" : "fail")}>{event.ok ? "OK" : "Fail"}</span></td><td data-label="Client"><code>{event.clientId}</code></td><td data-label="Method">{event.method}</td><td data-label="Tool">{event.toolName ?? "-"}</td><td data-label="Summary">{event.summary}</td></tr>)}</tbody></table></div>;
}
