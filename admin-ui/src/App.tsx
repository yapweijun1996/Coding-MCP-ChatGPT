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
  Gauge,
  HardDrive,
  Home,
  Inbox,
  KeyRound,
  LogOut,
  Menu,
  RotateCcw,
  RefreshCw,
  Search,
  Settings,
  Users,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { Fragment, FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, loadSession, login, register, setCsrfToken } from "./api";
import type {
  ActivityEvent,
  ClientStatus,
  ConnectorDetail,
  FeedbackIssue,
  FeedbackResult,
  IssueStatus,
  TelemetryResult,
  TelemetrySummary,
  OverviewResult,
  PageResult,
  PublicUser,
  RegistrationSettings,
  ProjectFileInfo,
  ProjectManifest,
  ProjectShareAccess,
  ProjectStatus,
  ProjectSummary,
  SettingsResult,
  SkillState,
  StorageQuotaStatus,
  StorageResult,
  SpecialToolState,
  ToolState,
  ValidationStatus
} from "./types";

type Route = "overview" | "projects" | "blog" | "project-detail" | "tools" | "connectors" | "activity" | "observability" | "feedback" | "users" | "settings" | "storage" | "login" | "register";
type Toast = { id: number; tone: "success" | "error"; message: string };
type MutableProjectStatus = Exclude<ProjectStatus, "deleted">;
type ConfirmState = {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void>;
};

const navItems: Array<{ route: Route; href: string; label: string; icon: ReactNode }> = [
  { route: "overview", href: "/admin", label: "Overview", icon: <Activity size={18} /> },
  { route: "storage", href: "/admin/storage", label: "Storage", icon: <HardDrive size={18} /> },
  { route: "projects", href: "/admin/projects", label: "Projects", icon: <Archive size={18} /> },
  { route: "blog", href: "/admin/blog", label: "Blog", icon: <FileCode2 size={18} /> },
  { route: "tools", href: "/admin/tools", label: "Tools & Skills", icon: <Wrench size={18} /> },
  { route: "connectors", href: "/admin/connectors", label: "Connectors", icon: <KeyRound size={18} /> },
  { route: "activity", href: "/admin/activity", label: "Activity", icon: <ShieldAlert size={18} /> },
  { route: "observability", href: "/admin/observability", label: "Observability", icon: <Gauge size={18} /> },
  { route: "feedback", href: "/admin/feedback", label: "Agent Feedback", icon: <Inbox size={18} /> },
  { route: "users", href: "/admin/users", label: "Users", icon: <Users size={18} /> },
  { route: "settings", href: "/admin/settings", label: "Settings", icon: <Settings size={18} /> }
];

function currentRoute(): { route: Route; projectId?: string } {
  const path = window.location.pathname.replace(/\/+$/, "") || "/admin";
  if (path === "/admin/login") return { route: "login" };
  if (path === "/admin/register") return { route: "register" };
  if (path === "/admin/storage") return { route: "storage" };
  if (path === "/admin/projects") return { route: "projects" };
  if (path === "/admin/blog") return { route: "blog" };
  const projectMatch = /^\/admin\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) return { route: "project-detail", projectId: decodeURIComponent(projectMatch[1]) };
  if (path === "/admin/tools") return { route: "tools" };
  if (path === "/admin/connectors") return { route: "connectors" };
  if (path === "/admin/activity") return { route: "activity" };
  if (path === "/admin/observability") return { route: "observability" };
  if (path === "/admin/feedback") return { route: "feedback" };
  if (path === "/admin/users") return { route: "users" };
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
  if (["published", "valid", "ok", "enabled", "low", "anyone_with_link"].includes(value)) return "badge good";
  if (["warnings", "warning", "private", "medium", "draft", "not_checked"].includes(value)) return "badge warn";
  if (["failed", "deleted", "fail", "high", "disabled", "over_quota"].includes(value)) return "badge bad";
  return "badge neutral";
}

const projectStatusActions: Array<{ status: MutableProjectStatus; label: string; confirmLabel: string; body: (title: string) => string; tone?: "danger" | "primary" }> = [
  { status: "published", label: "Publish", confirmLabel: "Publish", tone: "primary", body: (title) => `Publish ${title}. New projects are public to anyone with the link by default; use Sharing to make this project private.` },
  { status: "private", label: "Make private", confirmLabel: "Make private", body: (title) => `Make ${title} private. Public preview access will be removed.` },
  { status: "draft", label: "Move to draft", confirmLabel: "Move to draft", body: (title) => `Move ${title} back to draft. It will no longer appear as a published project.` }
];

function shareAccessLabel(value: ProjectShareAccess | undefined): string {
  return value === "anyone_with_link" ? "Public — anyone with link" : "Private";
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

function IconButton({ label, children, onClick, href, tone = "secondary", target, rel }: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "primary" | "secondary" | "danger";
  target?: string;
  rel?: string;
}) {
  const className = `icon-action ${tone}`;
  if (href) {
    return <a className={className} href={href} target={target} rel={rel} aria-label={label} title={label}>{children}</a>;
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
  const [currentUser, setCurrentUser] = useState<PublicUser | undefined>();
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
        setCurrentUser(session.user);
        if (!session.authenticated && route.route !== "login" && route.route !== "register") navigate(`/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      })
      .catch(() => {
        setAuthenticated(false);
        if (route.route !== "login" && route.route !== "register") navigate(`/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
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
  if (route.route === "register") {
    return <RegisterPage toast={toast} />;
  }
  if (route.route === "login" || !authenticated) {
    return <LoginPage onLogin={(user) => {
      setAuthenticated(true);
      setCurrentUser(user);
      const rawNext = new URLSearchParams(window.location.search).get("next");
      const next = rawNext && /^\/(?!\/)/.test(rawNext) ? rawNext : "/admin";
      window.location.href = next;
    }} toast={toast} />;
  }

  const title = route.route === "overview" ? "Overview"
    : route.route === "project-detail" ? "Project Detail"
      : navItems.find((item) => item.route === route.route)?.label ?? "Admin";

  const publicIndexHref = currentUser?.username && currentUser.publicShareUsernameEnabled
    ? `/@${currentUser.username}`
    : "/share";

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
        <a className="public-link" href={publicIndexHref} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Public Index</a>
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
          <div><p className="eyebrow">{currentUser?.role ?? "Admin"}</p><h1>{title}</h1></div>
          <button className="button subtle" type="button" onClick={() => run(async () => {
            await api("/session", { method: "DELETE" });
            setCsrfToken(undefined);
            setAuthenticated(false);
            setCurrentUser(undefined);
            navigate("/admin/login");
          })}><LogOut size={16} /> Sign out</button>
        </header>
        <div className="content">
          {route.route === "overview" && <OverviewPage />}
          {route.route === "storage" && <StoragePage />}
          {route.route === "projects" && <ProjectsPage setConfirm={setConfirm} toast={toast} publicIndexHref={publicIndexHref} isAdmin={currentUser?.role === "admin"} />}
          {route.route === "blog" && <BlogPage setConfirm={setConfirm} toast={toast} isAdmin={currentUser?.role === "admin"} />}
          {route.route === "project-detail" && route.projectId && <ProjectDetailPage projectId={route.projectId} setConfirm={setConfirm} toast={toast} />}
          {route.route === "tools" && <ToolsPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "connectors" && <ConnectorsPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "activity" && <ActivityPage />}
          {route.route === "observability" && <ObservabilityPage toast={toast} />}
          {route.route === "feedback" && <FeedbackPage setConfirm={setConfirm} toast={toast} />}
          {route.route === "users" && <UsersPage setConfirm={setConfirm} toast={toast} />}
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

function LoginPage({ onLogin, toast }: { onLogin: (user?: PublicUser) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const session = await login(email, password);
      onLogin(session.user);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";
      setError(message);
      toast("error", message);
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
        {error && <div className="form-alert error" role="alert">{error}</div>}
        <label>Email<input type="email" value={email} autoFocus autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="button primary" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        <button className="button subtle" type="button" onClick={() => navigate("/admin/register")}>Request access</button>
      </form>
    </main>
  );
}

function RegisterPage({ toast }: { toast: (tone: Toast["tone"], message: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await register(email, password);
      setPending(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Registration failed.";
      setError(message);
      toast("error", message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark">CM</span>
        <h1>Request access</h1>
        {pending ? (
          <>
            <div className="form-alert success" role="status">Request sent. Your account is pending admin approval.</div>
            <p>You can sign in after an admin approves your request.</p>
            <button className="button primary" type="button" onClick={() => navigate("/admin/login")}>Back to sign in</button>
          </>
        ) : (
          <>
            <p>Create an account for Coding MCP. New accounts require admin approval.</p>
            {error && <div className="form-alert error" role="alert">{error}</div>}
            <label>Email<input type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="button primary" type="submit" disabled={busy}>{busy ? "Submitting..." : "Submit request"}</button>
            <button className="button subtle" type="button" onClick={() => navigate("/admin/login")}>Back to sign in</button>
          </>
        )}
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function StorageQuotaBar({ quota, label = "Usage" }: { quota: StorageQuotaStatus; label?: string }) {
  const percent = quota.quotaBytes === null ? null : Math.max(0, Math.min(100, quota.percentUsed ?? 0));
  return (
    <div className="quota-block">
      <div className="quota-header"><strong>{label}</strong><span>{quota.quotaBytes === null ? `${formatBytes(quota.usedBytes)} used` : `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.quotaBytes)} (${quota.percentUsed ?? 0}%)`}</span></div>
      {percent === null
        ? <div className="quota-unlimited">No hard limit configured</div>
        : <div className="quota-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span className={`quota-fill ${quota.state}`} style={{ width: `${percent}%` }} /></div>}
    </div>
  );
}

function StoragePage() {
  const [data, setData] = useState<StorageResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<StorageResult>("/storage")
      .then((result) => {
        if (!active) return;
        setData(result);
        setError("");
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load storage report.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  if (!data && loading) return <div className="panel">Loading storage report...</div>;
  if (!data && error) return <EmptyState title="Storage report unavailable" body={error} />;
  if (!data) return <EmptyState title="Storage report unavailable" body="No storage data was returned." />;

  const storage = data.storage;
  const totals = storage.totals;
  const cards = [
    ["Tracked storage", totals.totalBytes, <HardDrive size={20} />],
    ["Project files", totals.projectBytes, <Archive size={20} />],
    ["Workspaces", totals.workspaceBytes, <Wrench size={20} />],
    ["Artifacts", totals.artifactBytes, <Download size={20} />],
    ["Shares", totals.shareBytes, <ExternalLink size={20} />],
    ["Telemetry", totals.telemetryBytes, <Activity size={20} />]
  ] as const;

  return (
    <div className="storage-page">
      <div className="panel-title">
        <div><h2>Storage usage</h2><p className="muted">Generated {fmtDate(storage.generatedAt)}. Filesystem paths are intentionally hidden.</p></div>
        <button className="button subtle" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={loading}><RefreshCw size={16} /> {loading ? "Refreshing..." : "Refresh"}</button>
      </div>
      {error && <div className="form-alert error" role="alert">{error}</div>}
      <section className="metric-grid storage-metric-grid">{cards.map(([label, value, icon]) => <div className="metric-card" key={label}><span>{icon}</span><strong>{formatBytes(value)}</strong><small>{label}</small></div>)}</section>
      <section className="panel storage-global-panel">
        <PanelTitle title="Global quota" action={<span className={badgeClass(storage.globalQuota.state)}>{storage.globalQuota.state.replace("_", " ")}</span>} />
        <StorageQuotaBar quota={storage.globalQuota} label="All tracked storage" />
        {storage.warnings.length > 0 && <div className="storage-warning" role="alert"><strong>Storage warnings</strong><ul>{storage.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      </section>
      <div className="stack">
        {storage.scopes.length === 0
          ? <EmptyState title="No storage scopes" body="There are no project roots visible to this account." />
          : storage.scopes.map((scope) => (
            <section className="panel storage-scope" key={scope.id}>
              <PanelTitle title={scope.label} action={<span className="badge neutral">{scope.projectCount} project{scope.projectCount === 1 ? "" : "s"}</span>} />
              <StorageQuotaBar quota={scope.quota} label="Scope usage" />
              <div className="storage-scope-breakdown">
                <div><span>Project files</span><strong>{formatBytes(scope.projectUsage.bytes)}</strong><small>{scope.projectUsage.files} files</small></div>
                <div><span>Workspace files</span><strong>{formatBytes(scope.workspaceUsage.bytes)}</strong><small>{scope.workspaceUsage.files} files</small></div>
                <div><span>Total</span><strong>{formatBytes(scope.totalBytes)}</strong><small>{scope.quota.state.replace("_", " ")}</small></div>
              </div>
              {scope.projects.length === 0
                ? <EmptyState title="No projects in this scope" body="Project-level usage will appear here when a project is created." />
                : <div className="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Project files</th><th>Workspace</th><th>Total</th><th>Quota</th></tr></thead><tbody>{scope.projects.map((project) => <tr key={project.id}><td data-label="Project"><strong>{project.title}</strong><code>{project.id}</code></td><td data-label="Status"><span className={badgeClass(project.status)}>{project.status}</span></td><td data-label="Project files">{formatBytes(project.projectBytes)}</td><td data-label="Workspace">{formatBytes(project.workspaceBytes)}</td><td data-label="Total"><strong>{formatBytes(project.totalBytes)}</strong></td><td data-label="Quota"><span className={badgeClass(project.quota.state)}>{project.quota.percentUsed === null ? "unlimited" : `${project.quota.percentUsed}%`}</span></td></tr>)}</tbody></table></div>}
            </section>
          ))}
      </div>
    </div>
  );
}

type HomepageInfo = { projectId: string; title: string | null; status?: string } | null;

function ProjectsPage({ setConfirm, toast, publicIndexHref, isAdmin }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void; publicIndexHref: string; isAdmin: boolean }) {
  const [params, updateParams] = useQueryState({ page: "1", pageSize: "20", sort: "updated-desc" });
  const [data, setData] = useState<PageResult<ProjectSummary>>();
  const [error, setError] = useState("");
  const [homepage, setHomepage] = useState<HomepageInfo>(null);
  const query = params.toString();
  const reload = useCallback(() => {
    api<PageResult<ProjectSummary>>(`/projects?${query}`).then(setData).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load projects."));
  }, [query]);
  const reloadHome = useCallback(() => {
    api<{ homepage: HomepageInfo }>("/site/home").then((result) => setHomepage(result.homepage)).catch(() => setHomepage(null));
  }, []);
  useEffect(() => reload(), [reload]);
  useEffect(() => reloadHome(), [reloadHome]);
  const clearHome = () => setConfirm({
    title: "Clear homepage",
    body: "The site root (/) will show the default landing page.",
    confirmLabel: "Clear homepage",
    onConfirm: async () => { await api("/site/home", { method: "DELETE" }); toast("success", "Homepage cleared."); reloadHome(); }
  });
  return (
    <section className="panel">
      <PanelTitle title="Projects" action={<a className="button subtle" href={publicIndexHref} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Public index</a>} />
      <div className="form-alert success" role="note">New projects are public to anyone with the link by default. Use the Sharing control to make a published project private.</div>
      {isAdmin && (
        <div className="form-alert" role="status" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <Home size={16} />
          {homepage
            ? <><span>Homepage: <strong>{homepage.title ?? homepage.projectId}</strong> <code>{homepage.projectId}</code></span><button className="button subtle mini" type="button" onClick={clearHome}>Clear</button><a className="button subtle mini" href="/" target="_blank" rel="noreferrer">Open</a></>
            : <span>No homepage set — the site root shows the default landing page.</span>}
        </div>
      )}
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
      {data && <ProjectTable projects={data.items} onReload={reload} setConfirm={setConfirm} toast={toast} isAdmin={isAdmin} homeProjectId={homepage?.projectId ?? null} onHomepageChange={reloadHome} />}
      {data && <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onPage={(page) => updateParams({ page: String(page) })} />}
    </section>
  );
}

function ProjectTable({ projects, onReload, setConfirm, toast, isAdmin, homeProjectId, onHomepageChange }: { projects: ProjectSummary[]; onReload: () => void; setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void; isAdmin: boolean; homeProjectId: string | null; onHomepageChange: () => void }) {
  const [statusMenuProjectId, setStatusMenuProjectId] = useState<string | null>(null);
  if (projects.length === 0) return <EmptyState title="No projects found" body="Adjust search or filters to see more projects." />;
  const updateStatus = async (project: ProjectSummary, status: MutableProjectStatus) => {
    await api(`/projects/${encodeURIComponent(project.id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    toast("success", `Project set to ${status}.`);
    onReload();
  };
  const updateShareAccess = async (project: ProjectSummary, shareAccess: ProjectShareAccess) => {
    await api(`/projects/${encodeURIComponent(project.id)}/share-access`, { method: "POST", body: JSON.stringify({ shareAccess }) });
    toast("success", `Sharing set to ${shareAccessLabel(shareAccess)}.`);
    onReload();
  };
  const requestShareAccessChange = (project: ProjectSummary) => {
    const current = project.shareAccess ?? "private";
    const next: ProjectShareAccess = current === "anyone_with_link" ? "private" : "anyone_with_link";
    setConfirm({
      title: next === "anyone_with_link" ? "Share with anyone" : "Make link private",
      body: next === "anyone_with_link"
        ? `Anyone with the link can view "${project.title}" without signing in.`
        : `Only signed-in project users and admins can view "${project.title}".`,
      confirmLabel: next === "anyone_with_link" ? "Share with link" : "Make private",
      tone: next === "anyone_with_link" ? "primary" : undefined,
      onConfirm: () => updateShareAccess(project, next)
    });
  };
  const requestStatusChange = (project: ProjectSummary, status: MutableProjectStatus) => {
    const action = projectStatusActions.find((item) => item.status === status);
    if (!action || project.status === status) return;
    setStatusMenuProjectId(null);
    setConfirm({
      title: action.label,
      body: action.body(project.title),
      confirmLabel: action.confirmLabel,
      tone: action.tone,
      onConfirm: () => updateStatus(project, status)
    });
  };
  return (
    <div className="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Sharing</th><th>Validation</th><th>Files</th><th>Updated</th><th>Created by</th><th>Actions</th></tr></thead><tbody>
      {projects.map((project) => <tr key={project.id}>
        <td data-label="Project"><button className="link-button" type="button" onClick={() => navigate(`/admin/projects/${encodeURIComponent(project.id)}`)}>{project.title}</button><code>{project.id}</code></td>
        <td data-label="Status">
          <div className="status-cell">
            <span className={badgeClass(project.status)}>{project.status}</span>
            {project.status !== "deleted" && (
              <button
                className="button subtle mini"
                type="button"
                aria-expanded={statusMenuProjectId === project.id}
                aria-label={`Change status for ${project.title}`}
                onClick={() => setStatusMenuProjectId((current) => current === project.id ? null : project.id)}
              >
                Change
              </button>
            )}
          </div>
          {statusMenuProjectId === project.id && project.status !== "deleted" && (
            <div className="status-menu" role="menu" aria-label={`Status actions for ${project.title}`}>
              {projectStatusActions.map((action) => {
                const isCurrent = project.status === action.status;
                return (
                  <button
                    key={action.status}
                    className={isCurrent ? "current" : ""}
                    type="button"
                    role="menuitem"
                    disabled={isCurrent}
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => requestStatusChange(project, action.status)}
                  >
                    <span>{action.label}</span>
                    {isCurrent && <small>Current</small>}
                  </button>
                );
              })}
            </div>
          )}
        </td>
        <td data-label="Sharing">
          <div className="status-cell">
            <span className={badgeClass(project.shareAccess ?? "private")}>{shareAccessLabel(project.shareAccess)}</span>
            {project.status === "published" && (
              <button className="button subtle mini" type="button" onClick={() => requestShareAccessChange(project)}>
                {project.shareAccess === "anyone_with_link" ? "Restrict" : "Share"}
              </button>
            )}
          </div>
        </td>
        <td data-label="Validation"><span className={badgeClass(validationStatus(project))}>{validationStatus(project).replace("_", " ")}</span></td>
        <td data-label="Files">{project.filesCount}</td>
        <td data-label="Updated">{fmtDate(project.updatedAt)}</td>
        <td data-label="Created by"><code>{project.createdByClientId}</code></td>
        <td data-label="Actions"><div className="row-actions">
          {project.publishedUrl && <IconButton label="Open preview" href={project.publishedUrl} tone="primary" target="_blank" rel="noreferrer"><ExternalLink size={18} /></IconButton>}
          {isAdmin && project.status === "published" && (
            homeProjectId === project.id
              ? <IconButton label="Current homepage" tone="primary" onClick={() => toast("success", "This project is the current homepage.")}><Home size={18} /></IconButton>
              : <IconButton label="Set as homepage" onClick={() => setConfirm({ title: "Set as homepage", body: `Visitors to the site root (/) will see "${project.title}".`, confirmLabel: "Set as homepage", onConfirm: async () => { await api(`/projects/${encodeURIComponent(project.id)}/homepage`, { method: "POST" }); toast("success", "Homepage updated."); onHomepageChange(); } })}><Home size={18} /></IconButton>
          )}
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
  const setShareAccess = (shareAccess: ProjectShareAccess) => setConfirm({
    title: shareAccess === "anyone_with_link" ? "Share with anyone" : "Make link private",
    body: shareAccess === "anyone_with_link"
      ? `Anyone with the link can view "${project.title}" without signing in.`
      : `Only signed-in project users and admins can view "${project.title}".`,
    confirmLabel: shareAccess === "anyone_with_link" ? "Share with link" : "Make private",
    tone: shareAccess === "anyone_with_link" ? "primary" : undefined,
    onConfirm: async () => {
      await api(`/projects/${encodeURIComponent(project.id)}/share-access`, { method: "POST", body: JSON.stringify({ shareAccess }) });
      toast("success", `Sharing set to ${shareAccessLabel(shareAccess)}.`);
      reload();
    }
  });
  return (
    <div className="detail-layout">
      <section className="panel">
        <button className="button subtle" type="button" onClick={() => navigate("/admin/projects")}><ChevronLeft size={16} /> Projects</button>
        <h2>{project.title}</h2>
        <p>{project.summary || "No summary provided."}</p>
        <div className="detail-meta">
          <span className={badgeClass(project.status)}>{project.status}</span>
          <span className={badgeClass(project.shareAccess ?? "private")}>{shareAccessLabel(project.shareAccess)}</span>
          <span className={badgeClass(validationStatus(project))}>{validationStatus(project).replace("_", " ")}</span>
          <span>{files.length} files</span>
          <span>Updated {fmtDate(project.updatedAt)}</span>
        </div>
        <div className="actions-row">
          {project.publishedUrl && <a className="button primary" href={project.publishedUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open preview</a>}
          {project.status === "published" && <button className="button secondary" type="button" onClick={() => setShareAccess(project.shareAccess === "anyone_with_link" ? "private" : "anyone_with_link")}>{project.shareAccess === "anyone_with_link" ? "Restrict link" : "Share with link"}</button>}
          <a className="button secondary" href={`/admin/api/projects/${encodeURIComponent(project.id)}/download.zip`}><Download size={16} /> Download ZIP</a>
          {project.status !== "deleted" && <button className="button danger" type="button" onClick={() => setConfirm({ title: "Delete project", body: `Soft-delete ${project.title}.`, confirmLabel: "Delete", tone: "danger", onConfirm: async () => { await api(`/projects/${encodeURIComponent(project.id)}/delete`, { method: "POST" }); toast("success", "Project deleted."); navigate("/admin/projects"); } })}><Trash2 size={16} /> Delete</button>}
        </div>
      </section>
      <section className="panel"><PanelTitle title="Files" />{files.length ? <div className="file-list">{files.map((file) => <div key={file.path}><FileCode2 size={16} /><span>{file.path}</span><small>{Math.round(file.size / 1024)} KB</small></div>)}</div> : <EmptyState title="No files" body="This project has no stored files." />}</section>
      {(project.reviewFeedback?.length ?? 0) > 0 && (
        <section className="panel wide">
          <PanelTitle title={`Review feedback (${project.reviewFeedback!.filter((f) => f.status === "open").length} open)`} />
          <div className="table-wrap"><table><thead><tr><th>ID</th><th>Severity</th><th>Category</th><th>Area</th><th>Finding</th><th>Status</th></tr></thead><tbody>
            {project.reviewFeedback!.slice().reverse().map((f) => (
              <tr key={f.id}>
                <td data-label="ID"><code>{f.id}</code></td>
                <td data-label="Severity"><span className={badgeClass(f.severity)}>{f.severity}</span></td>
                <td data-label="Category">{f.category}</td>
                <td data-label="Area">{f.area ? <code>{f.area}</code> : "-"}</td>
                <td data-label="Finding"><strong>{f.title}</strong>{f.suggestion ? <><br /><small>{f.suggestion}</small></> : null}</td>
                <td data-label="Status"><span className={badgeClass(f.status === "addressed" ? "ok" : f.status === "wontfix" ? "disabled" : "medium")}>{f.status}</span></td>
              </tr>
            ))}
          </tbody></table></div>
        </section>
      )}
      <section className="panel wide"><PanelTitle title="Task history" /><HistoryList items={manifest?.taskHistory ?? []} /></section>
    </div>
  );
}

type BlogPostRow = { slug: string; title: string; status: "draft" | "published"; tags: string[]; publishedAt: string | null; updatedAt: string };
type BlogThemeForm = { title: string; css: string; headerHtml: string; footerHtml: string };
type BlogFormat = "markdown" | "html";
type BlogEditor = { originalSlug: string | null; title: string; slug: string; content: string; format: BlogFormat; excerpt: string; tags: string; status: "draft" | "published"; seoDescription: string; coverImageUrl: string };
type BlogPostFull = { slug: string; title: string; content: string; format: BlogFormat; excerpt: string; tags: string[]; status: "draft" | "published"; seoDescription: string | null; coverImageUrl: string | null };

const emptyEditor: BlogEditor = { originalSlug: null, title: "", slug: "", content: "", format: "markdown", excerpt: "", tags: "", status: "published", seoDescription: "", coverImageUrl: "" };

function BlogPage({ setConfirm, toast, isAdmin }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void; isAdmin: boolean }) {
  const [posts, setPosts] = useState<BlogPostRow[]>();
  const [theme, setTheme] = useState<BlogThemeForm>({ title: "", css: "", headerHtml: "", footerHtml: "" });
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<BlogEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const reload = useCallback(() => {
    api<{ posts: BlogPostRow[] }>("/blog/posts").then((result) => setPosts(result.posts)).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load posts."));
    api<{ theme: BlogThemeForm }>("/blog/theme").then((result) => setTheme(result.theme)).catch(() => undefined);
  }, []);
  useEffect(() => reload(), [reload]);

  if (!isAdmin) return <EmptyState title="Admins only" body="Blog management is restricted to admin accounts." />;

  const saveTheme = async () => {
    try {
      await api("/blog/theme", { method: "POST", body: JSON.stringify(theme) });
      toast("success", "Blog theme saved.");
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to save theme.");
    }
  };

  const editPost = async (slug: string) => {
    try {
      const { post } = await api<{ post: BlogPostFull }>(`/blog/posts/${encodeURIComponent(slug)}`);
      setEditor({ originalSlug: post.slug, title: post.title, slug: post.slug, content: post.content, format: post.format === "html" ? "html" : "markdown", excerpt: post.excerpt ?? "", tags: post.tags.join(", "), status: post.status, seoDescription: post.seoDescription ?? "", coverImageUrl: post.coverImageUrl ?? "" });
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to load post.");
    }
  };

  const savePost = async () => {
    if (!editor) return;
    if (!editor.title.trim() || !editor.content.trim()) { toast("error", "Title and content are required."); return; }
    setSaving(true);
    try {
      await api("/blog/posts", { method: "POST", body: JSON.stringify({
        title: editor.title, content: editor.content, format: editor.format, slug: editor.slug.trim() || undefined,
        excerpt: editor.excerpt, tags: editor.tags, status: editor.status,
        seoDescription: editor.seoDescription, coverImageUrl: editor.coverImageUrl || undefined
      }) });
      toast("success", editor.originalSlug ? "Post updated." : "Post created.");
      setEditor(null);
      reload();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to save post.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="panel">
        <PanelTitle title="Blog posts" action={<div className="row-actions"><button className="button primary" type="button" onClick={() => setEditor({ ...emptyEditor })}>New post</button><a className="button subtle" href="/blog/" target="_blank" rel="noreferrer"><ExternalLink size={16} /> View blog</a></div>} />
        {editor && (
          <div className="settings-form" style={{ marginBottom: "20px", paddingBottom: "20px", borderBottom: "1px solid var(--border, #e3e8e2)" }}>
            <strong>{editor.originalSlug ? `Editing "${editor.originalSlug}"` : "New post"}</strong>
            <label>Title<input value={editor.title} onChange={(event) => setEditor((c) => c && ({ ...c, title: event.target.value }))} placeholder="Post title" /></label>
            <label>Slug (optional)<input value={editor.slug} onChange={(event) => setEditor((c) => c && ({ ...c, slug: event.target.value }))} placeholder="auto-generated from title" /></label>
            <label>Format<select value={editor.format} onChange={(event) => setEditor((c) => c && ({ ...c, format: event.target.value === "html" ? "html" : "markdown" }))}><option value="markdown">Markdown</option><option value="html">HTML (sanitized)</option></select></label>
            <label>Content ({editor.format === "html" ? "HTML — scripts/handlers stripped on render" : "Markdown"})<textarea rows={12} value={editor.content} onChange={(event) => setEditor((c) => c && ({ ...c, content: event.target.value }))} placeholder={editor.format === "html" ? "<h2>Heading</h2><p>Body in <strong>HTML</strong>.</p>" : "# Heading&#10;&#10;Body in **Markdown**."} /></label>
            <label>Excerpt<textarea rows={2} value={editor.excerpt} onChange={(event) => setEditor((c) => c && ({ ...c, excerpt: event.target.value }))} placeholder="Short summary for the index" /></label>
            <label>Tags (comma-separated)<input value={editor.tags} onChange={(event) => setEditor((c) => c && ({ ...c, tags: event.target.value }))} placeholder="news, product" /></label>
            <label>SEO description<input value={editor.seoDescription} onChange={(event) => setEditor((c) => c && ({ ...c, seoDescription: event.target.value }))} placeholder="Meta description" /></label>
            <label>Status<select value={editor.status} onChange={(event) => setEditor((c) => c && ({ ...c, status: event.target.value === "draft" ? "draft" : "published" }))}><option value="published">Published</option><option value="draft">Draft</option></select></label>
            <div className="row-actions">
              <button className="button primary" type="button" disabled={saving} onClick={savePost}>{saving ? "Saving..." : "Save post"}</button>
              <button className="button subtle" type="button" onClick={() => setEditor(null)}>Cancel</button>
            </div>
          </div>
        )}
        {error && <EmptyState title="Blog unavailable" body={error} />}
        {!error && !posts && <div className="table-loader">Loading posts...</div>}
        {posts && posts.length === 0 && <EmptyState title="No posts yet" body="Click New post to write one here, or ask the assistant to publish one." />}
        {posts && posts.length > 0 && (
          <div className="table-wrap"><table><thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Tags</th><th>Updated</th><th>Actions</th></tr></thead><tbody>
            {posts.map((post) => <tr key={post.slug}>
              <td data-label="Title"><strong>{post.title}</strong></td>
              <td data-label="Slug"><code>{post.slug}</code></td>
              <td data-label="Status"><span className={badgeClass(post.status === "published" ? "published" : "draft")}>{post.status}</span></td>
              <td data-label="Tags">{post.tags.join(", ") || "-"}</td>
              <td data-label="Updated">{fmtDate(post.updatedAt)}</td>
              <td data-label="Actions"><div className="row-actions">
                {post.status === "published" && <IconButton label="Open post" href={`/blog/${encodeURIComponent(post.slug)}`} tone="primary" target="_blank" rel="noreferrer"><ExternalLink size={18} /></IconButton>}
                <IconButton label="Edit post" onClick={() => editPost(post.slug)}><Eye size={18} /></IconButton>
                <IconButton label="Delete post" tone="danger" onClick={() => setConfirm({ title: "Delete post", body: `Delete "${post.title}". This cannot be undone.`, confirmLabel: "Delete", tone: "danger", onConfirm: async () => { await api(`/blog/posts/${encodeURIComponent(post.slug)}`, { method: "DELETE" }); toast("success", "Post deleted."); reload(); } })}><Trash2 size={18} /></IconButton>
              </div></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
      <section className="panel">
        <PanelTitle title="Blog theme" />
        <div className="settings-form">
          <label>Blog title<input value={theme.title} onChange={(event) => setTheme((current) => ({ ...current, title: event.target.value }))} placeholder="Blog" /></label>
          <label>Custom CSS<textarea rows={5} value={theme.css} onChange={(event) => setTheme((current) => ({ ...current, css: event.target.value }))} placeholder="/* appended to the base stylesheet */" /></label>
          <label>Header HTML<textarea rows={3} value={theme.headerHtml} onChange={(event) => setTheme((current) => ({ ...current, headerHtml: event.target.value }))} placeholder="<h1>My Blog</h1>" /></label>
          <label>Footer HTML<textarea rows={3} value={theme.footerHtml} onChange={(event) => setTheme((current) => ({ ...current, footerHtml: event.target.value }))} placeholder="<p>© 2026</p>" /></label>
          <button className="button primary" type="button" onClick={saveTheme}>Save theme</button>
        </div>
      </section>
    </>
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
  const [detail, setDetail] = useState<ConnectorDetail>();
  const [detailLoading, setDetailLoading] = useState("");
  const load = useCallback(() => api<{ clients: ClientStatus[] }>("/connectors").then((data) => setClients(data.clients)), []);
  useEffect(() => { load().catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load connectors.")); }, [load, toast]);
  const openDetail = async (clientId: string) => {
    setDetailLoading(clientId);
    try {
      setDetail(await api<ConnectorDetail>(`/connectors/${encodeURIComponent(clientId)}`));
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Unable to load connector activity.");
    } finally {
      setDetailLoading("");
    }
  };
  return (
    <>
      <section className="panel"><PanelTitle title="ChatGPT connectors" />{clients.length === 0 ? <EmptyState title="No connectors" body="No OAuth clients are registered yet." /> : <div className="table-wrap"><table><thead><tr><th>Client</th><th>Name</th><th>Owner</th><th>Redirect host</th><th>Tokens</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>{clients.map((client) => <tr key={client.clientId}><td data-label="Client"><code>{client.clientId}</code></td><td data-label="Name">{client.clientName}</td><td data-label="Owner"><code>{client.ownerUserId ?? "unbound"}</code></td><td data-label="Redirect">{client.redirectHost}</td><td data-label="Tokens">{client.activeAccessTokens} access, {client.refreshTokens} refresh</td><td data-label="Last used">{fmtDate(client.lastUsedAt)}</td><td data-label="Requests">{client.requestCount}</td><td data-label="Action"><div className="row-actions"><button className="button secondary" type="button" disabled={detailLoading === client.clientId} onClick={() => openDetail(client.clientId)}>{detailLoading === client.clientId ? "Loading..." : "View Activity"}</button><button className="button danger" type="button" onClick={() => setConfirm({ title: "Revoke connector", body: `Revoke ${client.clientName}. Existing tokens for this client will no longer work.`, confirmLabel: "Revoke", tone: "danger", onConfirm: async () => { await api(`/connectors/${encodeURIComponent(client.clientId)}/revoke`, { method: "POST" }); setDetail(undefined); await load(); toast("success", "Connector revoked."); } })}>Revoke</button></div></td></tr>)}</tbody></table></div>}</section>
      {detail && <ConnectorDetailModal detail={detail} onClose={() => setDetail(undefined)} />}
    </>
  );
}

function ConnectorDetailModal({ detail, onClose }: { detail: ConnectorDetail; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal wide-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><h2 id="connector-title">Connector activity</h2><IconButton label="Close connector activity" onClick={onClose}><X size={18} /></IconButton></div>
        <div className="settings-grid">
          <div><span>Client ID</span><code>{detail.client.clientId}</code></div>
          <div><span>Owner</span><code>{detail.owner ? `${detail.owner.email} · ${detail.owner.role}` : "Unbound legacy connector"}</code></div>
          <div><span>Tokens</span><code>{detail.client.activeAccessTokens} access, {detail.client.refreshTokens} refresh</code></div>
          <div><span>Requests</span><code>{detail.client.requestCount}</code></div>
          <div><span>Last used</span><code>{fmtDate(detail.client.lastUsedAt)}</code></div>
          <div><span>Failures</span><code>{detail.failures.length}</code></div>
        </div>
        <h3>Tools used</h3>
        <div className="chip-row">{detail.toolsUsed.length ? detail.toolsUsed.map((tool) => <span className="badge neutral" key={tool}>{tool}</span>) : <span className="badge neutral">No tool calls</span>}</div>
        <h3>Recent activity</h3>
        <ActivityTable events={detail.activity} />
      </section>
    </div>
  );
}

function ActivityPage() {
  const [params, updateParams] = useQueryState({ page: "1", pageSize: "30" });
  const [data, setData] = useState<PageResult<ActivityEvent>>();
  const query = params.toString();
  useEffect(() => { api<PageResult<ActivityEvent>>(`/activity?${query}`).then(setData).catch(() => undefined); }, [query]);
  return <section className="panel"><PanelTitle title="Activity audit" /><Toolbar><label className="search-field"><Search size={16} /><input placeholder="Search activity" value={params.get("q") ?? ""} onChange={(event) => updateParams({ q: event.target.value, page: "1" })} /></label><select value={params.get("status") ?? ""} onChange={(event) => updateParams({ status: event.target.value, page: "1" })} aria-label="Filter activity status"><option value="">All status</option><option value="ok">OK</option><option value="fail">Fail</option></select><input value={params.get("client") ?? ""} placeholder="Client" onChange={(event) => updateParams({ client: event.target.value, page: "1" })} /><input value={params.get("tool") ?? ""} placeholder="Tool" onChange={(event) => updateParams({ tool: event.target.value, page: "1" })} /></Toolbar>{data ? <><ActivityTable events={data.items} /><Pagination page={data.page} pageCount={data.pageCount} total={data.total} onPage={(page) => updateParams({ page: String(page) })} /></> : <div className="table-loader">Loading activity...</div>}</section>;
}

const telemetryWindows = [1, 7, 30, 90];
// Cloudflare proxies time out around 100s; flag tools whose p95 approaches it.
const slowP95ThresholdMs = 90000;

function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function errorRateLevel(rate: number): string {
  if (rate >= 0.2) return "high";
  if (rate >= 0.05) return "medium";
  return "low";
}

function ObservabilityPage({ toast }: { toast: (tone: Toast["tone"], message: string) => void }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<TelemetrySummary>();
  const load = useCallback(
    () => api<TelemetryResult>(`/telemetry?days=${days}`).then((result) => setData(result.telemetry)).catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load telemetry.")),
    [days, toast]
  );
  useEffect(() => { load(); }, [load]);

  const metricRow = (metric: TelemetryResult["telemetry"]["byTool"][number]) => (
    <tr key={metric.key}>
      <td data-label="Name"><code>{metric.key}</code></td>
      <td data-label="Calls">{metric.calls}</td>
      <td data-label="Errors">{metric.errors}</td>
      <td data-label="Error rate"><span className={badgeClass(errorRateLevel(metric.errorRate))}>{(metric.errorRate * 100).toFixed(0)}%</span></td>
      <td data-label="p50">{fmtMs(metric.p50Ms)}</td>
      <td data-label="p95">{metric.p95Ms !== null && metric.p95Ms >= slowP95ThresholdMs ? <span className={badgeClass("high")}>{fmtMs(metric.p95Ms)}</span> : fmtMs(metric.p95Ms)}</td>
      <td data-label="p99">{fmtMs(metric.p99Ms)}</td>
      <td data-label="Max">{fmtMs(metric.maxMs)}</td>
    </tr>
  );

  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle title="Observability" />
        <Toolbar>
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Telemetry window in days">
            {telemetryWindows.map((window) => <option key={window} value={window}>Last {window} day{window > 1 ? "s" : ""}</option>)}
          </select>
          {data && <span className="muted">{data.totalCalls} calls · {data.totalErrors} errors · {(data.errorRate * 100).toFixed(1)}% error rate · {data.from} → {data.to}</span>}
        </Toolbar>
        {!data ? <div className="table-loader">Loading telemetry...</div> : data.totalCalls === 0 ? (
          <EmptyState title="No telemetry yet" body="No MCP tool calls have been recorded in this window. Telemetry is captured automatically on every tools/call." />
        ) : null}
      </section>

      {data && Object.values(data.performance).some((metric) => metric.samples > 0) && (
        <section className="panel">
          <PanelTitle title="Runtime and queue performance (p95)" />
          <div className="metric-grid">
            <div className="metric-card"><strong>{fmtMs(data.performance.queueWaitMs.p95)}</strong><small>Queue wait</small></div>
            <div className="metric-card"><strong>{fmtMs(data.performance.executionMs.p95)}</strong><small>Job execution</small></div>
            <div className="metric-card"><strong>{data.performance.queueDepth.p95 ?? "-"}</strong><small>Queue depth</small></div>
            <div className="metric-card"><strong>{fmtMs(data.performance.eventLoopDelayMs.p95)}</strong><small>Event-loop delay</small></div>
            <div className="metric-card"><strong>{data.performance.rssBytes.p95 === null ? "-" : formatBytes(data.performance.rssBytes.p95)}</strong><small>Process RSS</small></div>
            <div className="metric-card"><strong>{data.performance.toolListBytes.p95 === null ? "-" : formatBytes(data.performance.toolListBytes.p95)}</strong><small>Tool list payload</small></div>
          </div>
        </section>
      )}

      {data && data.totalCalls > 0 && (
        <section className="panel">
          <PanelTitle title="By tool (most problematic first)" />
          <div className="table-wrap"><table><thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>{data.byTool.map(metricRow)}</tbody></table></div>
        </section>
      )}

      {data && data.byClient.length > 0 && (
        <section className="panel">
          <PanelTitle title="By client" />
          <div className="table-wrap"><table><thead><tr><th>Client</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>{data.byClient.map(metricRow)}</tbody></table></div>
        </section>
      )}

      {data && data.byFailureCategory.length > 0 && (
        <section className="panel">
          <PanelTitle title="Failures by category" />
          <div className="table-wrap"><table><thead><tr><th>Category</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>{data.byFailureCategory.map(metricRow)}</tbody></table></div>
        </section>
      )}

      {data && data.recentErrors.length > 0 && (
        <section className="panel">
          <PanelTitle title="Recent errors" />
          <div className="activity-list">{data.recentErrors.map((error, index) => (
            <div key={`${error.time}-${index}`}>
              <span className={badgeClass("fail")}>Fail</span>
              <strong>{error.toolName ?? "-"}</strong>
              <p>{error.errorMessage ?? "(no message)"}</p>
              <small>{fmtDate(error.time)} · {error.clientType ?? "unknown"} · {fmtMs(error.durationMs)}</small>
            </div>
          ))}</div>
        </section>
      )}
    </div>
  );
}

const feedbackStatusOptions: IssueStatus[] = ["open", "investigating", "resolved", "wontfix"];

function FeedbackPage({ setConfirm, toast }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [data, setData] = useState<FeedbackResult>();
  const [statusFilter, setStatusFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
  const load = useCallback(
    () => api<FeedbackResult>(`/feedback${query}`).then(setData).catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load feedback.")),
    [query, toast]
  );
  useEffect(() => { load(); }, [load]);

  const changeStatus = (issue: FeedbackIssue, next: IssueStatus) => {
    if (next === issue.status) return;
    const note = next === "resolved" || next === "wontfix" ? window.prompt(`Resolution note for ${issue.id} (optional):`, issue.resolutionNote ?? "") : null;
    if (note === null && (next === "resolved" || next === "wontfix")) {
      // prompt cancelled — abort without changing
      return;
    }
    setConfirm({
      title: "Update issue status",
      body: `Mark ${issue.id} "${issue.title}" as ${next}.`,
      confirmLabel: "Update",
      tone: next === "wontfix" ? "danger" : "primary",
      onConfirm: async () => {
        await api(`/feedback/${encodeURIComponent(issue.id)}/status`, { method: "POST", body: JSON.stringify({ status: next, resolutionNote: note ?? undefined }) });
        await load();
        toast("success", `Issue ${issue.id} marked ${next}.`);
      }
    });
  };

  return (
    <section className="panel">
      <PanelTitle title="Agent feedback inbox" />
      <Toolbar>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter issues by status">
          <option value="">All status</option>
          {feedbackStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        {data && <span className="muted">{data.stats.open} open · {data.stats.total} total</span>}
      </Toolbar>
      {!data ? <div className="table-loader">Loading feedback...</div> : data.issues.length === 0 ? (
        <EmptyState title="No issues" body="No agent-reported issues match the current filter. Agents report problems with the report_issue MCP tool." />
      ) : (
        <div className="table-wrap"><table><thead><tr><th>ID</th><th>Severity</th><th>Category</th><th>Tool</th><th>Title</th><th>Reported</th><th>Status</th></tr></thead><tbody>
          {data.issues.map((issue) => (
            <Fragment key={issue.id}>
              <tr>
                <td data-label="ID"><button type="button" className="link-button" onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}><code>{issue.id}</code></button></td>
                <td data-label="Severity"><span className={badgeClass(issue.severity)}>{issue.severity}</span></td>
                <td data-label="Category">{issue.category}</td>
                <td data-label="Tool">{issue.toolName ? <code>{issue.toolName}</code> : "-"}</td>
                <td data-label="Title">{issue.title}</td>
                <td data-label="Reported">{fmtDate(issue.createdAt)}{issue.reportedByClientId ? <><br /><small>{issue.reportedByClientId}</small></> : null}</td>
                <td data-label="Status"><select value={issue.status} onChange={(event) => changeStatus(issue, event.target.value as IssueStatus)} aria-label={`Status for ${issue.id}`}>{feedbackStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></td>
              </tr>
              {expanded === issue.id && (
                <tr className="detail-row"><td colSpan={7}><div className="feedback-detail"><p><strong>Detail:</strong> {issue.detail}</p>{issue.reproSteps ? <p><strong>Repro:</strong> {issue.reproSteps}</p> : null}{issue.resolutionNote ? <p><strong>Resolution:</strong> {issue.resolutionNote}</p> : null}{issue.context ? <pre>{JSON.stringify(issue.context, null, 2)}</pre> : null}<small>Updated {fmtDate(issue.updatedAt)}</small></div></td></tr>
              )}
            </Fragment>
          ))}
        </tbody></table></div>
      )}
    </section>
  );
}

function UsersPage({ setConfirm, toast }: { setConfirm: (state: ConfirmState) => void; toast: (tone: Toast["tone"], message: string) => void }) {
  const [params, updateParams] = useQueryState({ page: "1", pageSize: "20" });
  const [data, setData] = useState<PageResult<PublicUser>>();
  const query = params.toString();
  const load = useCallback(() => api<PageResult<PublicUser>>(`/users?${query}`).then(setData).catch((error: unknown) => toast("error", error instanceof Error ? error.message : "Unable to load users.")), [query, toast]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="panel">
      <PanelTitle title="Users" />
      <Toolbar>
        <label className="search-field"><Search size={16} /><input placeholder="Search users" value={params.get("q") ?? ""} onChange={(event) => updateParams({ q: event.target.value, page: "1" })} /></label>
        <select value={params.get("status") ?? ""} onChange={(event) => updateParams({ status: event.target.value, page: "1" })} aria-label="Filter users by status">
          <option value="">All status</option><option value="pending">Pending</option><option value="active">Active</option><option value="disabled">Disabled</option>
        </select>
      </Toolbar>
      {!data ? <div className="table-loader">Loading users...</div> : data.items.length === 0 ? <EmptyState title="No users" body="No users match the current filters." /> : (
        <div className="table-wrap"><table><thead><tr><th>Email</th><th>Username</th><th>Role</th><th>Status</th><th>Project root</th><th>Created</th><th>Actions</th></tr></thead><tbody>{data.items.map((user) => <tr key={user.id}><td data-label="Email"><strong>{user.email}</strong><code>{user.id}</code></td><td data-label="Username">{user.username ? <><code>@{user.username}</code><span className={badgeClass(user.publicShareUsernameEnabled ? "enabled" : "disabled")}>{user.publicShareUsernameEnabled ? "public" : "off"}</span></> : "-"}</td><td data-label="Role"><select value={user.role} onChange={(event) => setConfirm({ title: "Change role", body: `Change ${user.email} to ${event.target.value}.`, confirmLabel: "Change role", onConfirm: async () => { await api(`/users/${encodeURIComponent(user.id)}/role`, { method: "POST", body: JSON.stringify({ role: event.target.value }) }); await load(); toast("success", "Role updated."); } })}><option value="admin">admin</option><option value="developer">developer</option><option value="viewer">viewer</option></select></td><td data-label="Status"><span className={badgeClass(user.status === "active" ? "enabled" : user.status === "pending" ? "draft" : "disabled")}>{user.status}</span></td><td data-label="Project root"><code>{user.projectRoot ?? "-"}</code></td><td data-label="Created">{fmtDate(user.createdAt)}</td><td data-label="Actions"><div className="row-actions">{user.status === "pending" && <button className="button primary" type="button" onClick={() => setConfirm({ title: "Approve user", body: `Approve ${user.email} as developer.`, confirmLabel: "Approve", onConfirm: async () => { await api(`/users/${encodeURIComponent(user.id)}/approve`, { method: "POST" }); await load(); toast("success", "User approved."); } })}>Approve</button>}{user.status !== "disabled" && <button className="button danger" type="button" onClick={() => setConfirm({ title: "Disable user", body: `Disable ${user.email}. They cannot sign in or use MCP tokens after this.`, confirmLabel: "Disable", tone: "danger", onConfirm: async () => { await api(`/users/${encodeURIComponent(user.id)}/disable`, { method: "POST" }); await load(); toast("success", "User disabled."); } })}>Disable</button>}</div></td></tr>)}</tbody></table></div>
      )}
      {data && <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onPage={(page) => updateParams({ page: String(page) })} />}
    </section>
  );
}

function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResult>();
  const [profile, setProfile] = useState<PublicUser>();
  const [username, setUsername] = useState("");
  const [publicShareUsernameEnabled, setPublicShareUsernameEnabled] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [registration, setRegistration] = useState<RegistrationSettings>();
  const [domains, setDomains] = useState("");
  const load = useCallback(async () => {
    const [next, profileResult] = await Promise.all([
      api<SettingsResult>("/settings"),
      api<{ user: PublicUser }>("/profile")
    ]);
    setSettings(next);
    setProfile(profileResult.user);
    setUsername(profileResult.user.username ?? "");
    setPublicShareUsernameEnabled(profileResult.user.publicShareUsernameEnabled);
    setRegistration(next.registrationSettings);
    setDomains(next.registrationSettings?.allowedEmailDomains.join(", ") ?? "");
  }, []);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!settings) return <div className="panel">Loading settings...</div>;
  const contentBaseUrl = settings.contentBaseUrl.replace(/\/$/, "");
  const publicProfileUrl = username ? `${contentBaseUrl}/@${username.trim().toLowerCase()}` : "";
  return (
    <div className="stack">
      <section className="panel"><PanelTitle title="System settings" /><div className="settings-grid">{Object.entries({ "Public base URL": settings.publicBaseUrl, "Content base URL": settings.contentBaseUrl, "Workspace root": settings.workspaceRoot, "Project root": settings.projectRoot, "Share root": settings.shareRoot, "Artifact root": settings.artifactRoot, "Session TTL": `${settings.sessionTtlHours} hours` }).map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}</div></section>
      {profile && <section className="panel"><PanelTitle title="Public identity" /><div className="settings-form">{profileError && <div className="form-alert error" role="alert">{profileError}</div>}{profileSaved && <div className="form-alert success" role="status">Public identity saved.</div>}<label>Username<input value={username} placeholder="yourname" onChange={(event) => { setUsername(event.target.value); setProfileSaved(false); setProfileError(""); }} /></label><label><input type="checkbox" checked={publicShareUsernameEnabled} onChange={(event) => { setPublicShareUsernameEnabled(event.target.checked); setProfileSaved(false); }} /> Use username in public share links</label><div className="settings-grid"><div><span>Profile URL</span><code>{publicProfileUrl || "Set a username to create a public identity URL."}</code></div><div><span>Publish behavior</span><code>{username && publicShareUsernameEnabled ? `${contentBaseUrl}/@${username.trim().toLowerCase()}/share/...` : `${contentBaseUrl}/share/...`}</code></div></div><button className="button primary" type="button" onClick={async () => { setProfileError(""); setProfileSaved(false); try { const result = await api<{ user: PublicUser }>("/profile", { method: "POST", body: JSON.stringify({ username, publicShareUsernameEnabled }) }); setProfile(result.user); setUsername(result.user.username ?? ""); setPublicShareUsernameEnabled(result.user.publicShareUsernameEnabled); setProfileSaved(true); } catch (error) { setProfileError(error instanceof Error ? error.message : "Unable to save public identity."); } }}>Save public identity</button></div></section>}
      {registration && <section className="panel"><PanelTitle title="Registration controls" /><div className="settings-form"><label><input type="checkbox" checked={registration.allowRegistration} onChange={(event) => setRegistration({ ...registration, allowRegistration: event.target.checked })} /> Allow registration</label><label>Allowed email domains<input value={domains} placeholder="example.com, company.com" onChange={(event) => setDomains(event.target.value)} /></label><div className="settings-grid"><div><span>Require approval</span><code>on</code></div><div><span>Default role</span><code>developer</code></div></div><button className="button primary" type="button" onClick={async () => { await api("/registration-settings", { method: "POST", body: JSON.stringify({ allowRegistration: registration.allowRegistration, allowedEmailDomains: domains.split(",").map((item) => item.trim()).filter(Boolean) }) }); await load(); }}>Save registration settings</button></div></section>}
    </div>
  );
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
