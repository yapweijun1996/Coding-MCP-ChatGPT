import crypto from "node:crypto";
import { ZipArchive } from "archiver";
import express from "express";
import type { ActivityEvent } from "./activity.js";
import { listActivity, recordActivity } from "./activity.js";
import type { OAuthClientStatus } from "./oauth.js";
import { listOAuthClientStatus, revokeClient } from "./oauth.js";
import type { ProjectStatus, ProjectSummary, ProjectValidationStatus } from "./projects/store.js";
import {
  deleteProject,
  getProject,
  getProjectFilesDirectory,
  getProjectWorkspaceDirectory,
  getProjectManifest,
  getProjectWithFiles,
  listProjects,
  setProjectStatus
} from "./projects/store.js";
import { getResearchSummary } from "./research/store.js";
import type { SkillState } from "./skills/state.js";
import { listSkillStates, setSkillEnabled } from "./skills/state.js";
import {
  disableVisibleBrowserControl,
  enableVisibleBrowserControl,
  getSpecialToolStates,
  isVisibleBrowserControlEnabled,
  isVisibleBrowserToolName,
  visibleBrowserToolNames
} from "./special-tools.js";
import { closeAllBrowserSessions } from "./mcp/tools/browser.js";
import type { EffectiveToolState } from "./tool-state.js";
import { listEffectiveToolStates, setToolEnabled } from "./tool-state.js";

interface AdminApiConfig {
  adminPasscode: string;
  publicBaseUrl: string;
  projectRoot: string;
  workspaceRoot: string;
  shareRoot: string;
  artifactRoot: string;
}

interface AdminSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

type SortDirection = "asc" | "desc";
type AdminCookieSecureMode = "auto" | "true" | "false";

const sessionCookieName = "coding_mcp_admin_session";
const sessionTtlMs = 8 * 60 * 60 * 1000;
const sessions = new Map<string, AdminSession>();
const loginFailureWindowMs = 5 * 60 * 1000;
const loginLockoutMs = 15 * 60 * 1000;
const maxLoginFailures = 5;
const loginAttempts = new Map<string, { failed: number; windowStartedAt: number; lockedUntil?: number }>();

function now(): number {
  return Date.now();
}

function cleanupSessions(): void {
  const current = now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= current) sessions.delete(id);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function getSession(req: express.Request): AdminSession | undefined {
  cleanupSessions();
  const sessionId = parseCookies(req.header("cookie"))[sessionCookieName];
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= now()) {
    sessions.delete(sessionId);
    return undefined;
  }
  return session;
}

function adminCookieSecureMode(): AdminCookieSecureMode {
  const value = (process.env.ADMIN_COOKIE_SECURE ?? "auto").trim().toLowerCase();
  if (value === "true" || value === "1") return "true";
  if (value === "false" || value === "0") return "false";
  return "auto";
}

function forwardedProto(req: express.Request): string {
  return (req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
}

function secureCookie(req: express.Request): boolean {
  const mode = adminCookieSecureMode();
  if (mode === "true") return true;
  if (mode === "false") return false;
  return req.secure || forwardedProto(req) === "https";
}

function setSessionCookie(req: express.Request, res: express.Response, session: AdminSession): void {
  const secure = secureCookie(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookieName}=${encodeURIComponent(session.id)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`);
}

function clearSessionCookie(req: express.Request, res: express.Response): void {
  const secure = secureCookie(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function createSession(): AdminSession {
  const createdAt = now();
  const session = {
    id: crypto.randomBytes(32).toString("base64url"),
    csrfToken: crypto.randomBytes(32).toString("base64url"),
    createdAt,
    expiresAt: createdAt + sessionTtlMs
  };
  sessions.set(session.id, session);
  return session;
}

function ok(res: express.Response, data: Record<string, unknown> = {}): void {
  res.json({ ok: true, ...data });
}

function fail(res: express.Response, status: number, error: string): void {
  res.status(status).json({ ok: false, error });
}

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error: unknown) => {
      console.error("Admin API request failed:", error);
      if (res.headersSent) {
        next(error);
        return;
      }
      fail(res, 500, "Admin API request failed.");
    });
  };
}

function requireSession(req: express.Request, res: express.Response): AdminSession | undefined {
  const session = getSession(req);
  if (!session) {
    fail(res, 401, "Admin session required.");
    return undefined;
  }
  return session;
}

function requireCsrf(req: express.Request, res: express.Response, session: AdminSession): boolean {
  if (req.header("x-csrf-token") === session.csrfToken) return true;
  fail(res, 403, "Invalid CSRF token.");
  return false;
}

function readStringQuery(req: express.Request, name: string): string {
  const value = req.query[name];
  return typeof value === "string" ? value.trim() : "";
}

function readPageQuery(req: express.Request): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(readStringQuery(req, "page") || "1", 10) || 1);
  const requestedPageSize = Number.parseInt(readStringQuery(req, "pageSize") || "20", 10) || 20;
  const pageSize = Math.min(100, Math.max(5, requestedPageSize));
  return { page, pageSize };
}

function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number; page: number; pageSize: number; pageCount: number } {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page: safePage, pageSize, pageCount };
}

function includesText(value: string | undefined, q: string): boolean {
  return value?.toLowerCase().includes(q) ?? false;
}

function projectValidationStatus(project: ProjectSummary): ProjectValidationStatus | "not_checked" {
  return project.lastValidation?.status ?? "not_checked";
}

function sortProjects(projects: ProjectSummary[], sort: string): ProjectSummary[] {
  const [field, directionValue] = sort.split("-");
  const direction: SortDirection = directionValue === "asc" ? "asc" : "desc";
  const multiplier = direction === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    if (field === "title") return a.title.localeCompare(b.title) * multiplier;
    if (field === "status") return a.status.localeCompare(b.status) * multiplier;
    if (field === "validation") return projectValidationStatus(a).localeCompare(projectValidationStatus(b)) * multiplier;
    if (field === "created") return a.createdAt.localeCompare(b.createdAt) * multiplier;
    return a.updatedAt.localeCompare(b.updatedAt) * multiplier;
  });
}

function filterProjects(req: express.Request, projects: ProjectSummary[]): ProjectSummary[] {
  const q = readStringQuery(req, "q").toLowerCase();
  const status = readStringQuery(req, "status");
  const validation = readStringQuery(req, "validation");
  return projects.filter((project) => {
    if (status && project.status !== status) return false;
    if (validation && projectValidationStatus(project) !== validation) return false;
    if (!q) return true;
    return includesText(project.title, q)
      || includesText(project.summary, q)
      || includesText(project.id, q)
      || includesText(project.createdByClientId, q)
      || includesText(project.publishedUrl, q);
  });
}

function filterActivity(req: express.Request, activity: ActivityEvent[]): ActivityEvent[] {
  const q = readStringQuery(req, "q").toLowerCase();
  const status = readStringQuery(req, "status");
  const client = readStringQuery(req, "client").toLowerCase();
  const tool = readStringQuery(req, "tool").toLowerCase();
  return activity.filter((event) => {
    if (status === "ok" && !event.ok) return false;
    if (status === "fail" && event.ok) return false;
    if (client && !event.clientId.toLowerCase().includes(client)) return false;
    if (tool && !(event.toolName ?? "").toLowerCase().includes(tool)) return false;
    if (!q) return true;
    return includesText(event.clientId, q)
      || includesText(event.method, q)
      || includesText(event.toolName, q)
      || includesText(event.summary, q);
  });
}

function staleDraftCount(projects: ProjectSummary[]): number {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  return projects.filter((project) => {
    if (project.status !== "draft") return false;
    const updatedAt = Date.parse(project.updatedAt);
    return Number.isFinite(updatedAt) && updatedAt < cutoff;
  }).length;
}

function projectCounts(projects: ProjectSummary[]): Record<ProjectStatus, number> {
  return projects.reduce<Record<ProjectStatus, number>>((counts, project) => {
    counts[project.status] += 1;
    return counts;
  }, { draft: 0, private: 0, published: 0, deleted: 0 });
}

function toolAccessLabel(tool: EffectiveToolState): string {
  if (tool.access === "blocked_by_tool") return "Blocked by tool";
  if (tool.access === "blocked_by_skill") return "Blocked by skill";
  return "Enabled";
}

function shapeTools(tools: EffectiveToolState[]): Array<EffectiveToolState & { accessLabel: string }> {
  return tools.map((tool) => ({ ...tool, accessLabel: toolAccessLabel(tool) }));
}

function shapeSkills(skills: SkillState[]): SkillState[] {
  return skills;
}

function shapeClients(clients: OAuthClientStatus[]): OAuthClientStatus[] {
  return clients;
}

function readBody(req: express.Request): Partial<Record<string, unknown>> {
  return req.body && typeof req.body === "object" ? req.body as Partial<Record<string, unknown>> : {};
}

function readBodyString(req: express.Request, name: string): string {
  const value = readBody(req)[name];
  return typeof value === "string" ? value : "";
}

function loginAttemptKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function getLockedLoginAttempt(key: string, current: number): { failed: number; windowStartedAt: number; lockedUntil?: number } | undefined {
  const attempt = loginAttempts.get(key);
  if (!attempt) return undefined;
  if (attempt.lockedUntil && attempt.lockedUntil > current) return attempt;
  if (attempt.lockedUntil || current - attempt.windowStartedAt > loginFailureWindowMs) {
    loginAttempts.delete(key);
    return undefined;
  }
  return attempt;
}

function recordLoginFailure(key: string, current: number): { locked: boolean; lockedUntil?: number } {
  const currentAttempt = loginAttempts.get(key);
  const attempt = !currentAttempt || currentAttempt.lockedUntil || current - currentAttempt.windowStartedAt > loginFailureWindowMs
    ? { failed: 0, windowStartedAt: current }
    : currentAttempt;
  attempt.failed += 1;
  if (attempt.failed >= maxLoginFailures) {
    attempt.lockedUntil = current + loginLockoutMs;
    loginAttempts.set(key, attempt);
    return { locked: true, lockedUntil: attempt.lockedUntil };
  }
  loginAttempts.set(key, attempt);
  return { locked: false };
}

function requireApiSession(config: AdminApiConfig) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const session = requireSession(req, res);
    if (!session) return;
    res.locals.adminSession = session;
    if (req.method !== "GET" && req.method !== "HEAD" && !requireCsrf(req, res, session)) return;
    next();
  };
}

export function registerAdminApi(app: express.Express, config: AdminApiConfig): void {
  const api = express.Router();

  api.post("/session", (req, res) => {
    const passcode = readBodyString(req, "passcode");
    const attemptKey = loginAttemptKey(req);
    const current = now();
    const lockedAttempt = getLockedLoginAttempt(attemptKey, current);
    if (lockedAttempt?.lockedUntil) {
      recordActivity({ clientId: "admin", method: "admin/session", ok: false, summary: "Rate-limited admin login attempt." });
      fail(res, 429, "Too many login attempts. Try again later.");
      return;
    }
    if (!config.adminPasscode) {
      fail(res, 503, "Admin passcode is not configured.");
      return;
    }
    if (passcode !== config.adminPasscode) {
      const failure = recordLoginFailure(attemptKey, current);
      recordActivity({ clientId: "admin", method: "admin/session", ok: false, summary: "Rejected admin login attempt." });
      fail(res, failure.locked ? 429 : 401, failure.locked ? "Too many login attempts. Try again later." : "Invalid passcode.");
      return;
    }
    loginAttempts.delete(attemptKey);
    const session = createSession();
    setSessionCookie(req, res, session);
    recordActivity({ clientId: "admin", method: "admin/session", ok: true, summary: "Admin session started." });
    ok(res, { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  api.get("/session", (req, res) => {
    const session = getSession(req);
    ok(res, {
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : undefined
    });
  });

  api.use(requireApiSession(config));

  api.delete("/session", (req, res) => {
    const session = res.locals.adminSession as AdminSession;
    sessions.delete(session.id);
    clearSessionCookie(req, res);
    recordActivity({ clientId: "admin", method: "admin/session", ok: true, summary: "Admin session ended." });
    ok(res);
  });

  api.get("/overview", asyncRoute(async (_req, res) => {
    const projects = await listProjects(config.projectRoot, true);
    const activeProjects = projects.filter((project) => project.status !== "deleted");
    const activity = listActivity(200);
    const specialTools = getSpecialToolStates();
    const tools = listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name));
    const counts = projectCounts(projects);
    ok(res, {
      metrics: {
        connectedClients: listOAuthClientStatus().length,
        enabledTools: tools.filter((tool) => tool.enabled).length + (isVisibleBrowserControlEnabled() ? visibleBrowserToolNames.length : 0),
        projects: activeProjects.length,
        publishedProjects: counts.published,
        privateProjects: counts.private,
        draftProjects: counts.draft,
        failedValidations: projects.filter((project) => project.lastValidation?.status === "failed").length,
        activeSpecialTools: specialTools.filter((tool) => tool.enabled).length,
        failedCalls: activity.filter((event) => !event.ok).length,
        staleDrafts: staleDraftCount(projects)
      },
      recentFailures: activity.filter((event) => !event.ok).slice(0, 8),
      recentProjects: activeProjects.slice(0, 8),
      activeSpecialTools: specialTools.filter((tool) => tool.enabled)
    });
  }));

  api.get("/projects", asyncRoute(async (req, res) => {
    const { page, pageSize } = readPageQuery(req);
    const sort = readStringQuery(req, "sort") || "updated-desc";
    const projects = sortProjects(filterProjects(req, await listProjects(config.projectRoot, true)), sort);
    ok(res, { ...paginate(projects, page, pageSize), sort });
  }));

  api.get("/projects/:projectId", asyncRoute(async (req, res) => {
    try {
      const project = await getProjectWithFiles(config.projectRoot, req.params.projectId);
      const manifest = await getProjectManifest(config.projectRoot, req.params.projectId);
      const researchSummary = await getResearchSummary(config.projectRoot, req.params.projectId);
      ok(res, { project: project.metadata, files: project.files, manifest, researchSummary });
    } catch (error) {
      fail(res, 404, error instanceof Error ? error.message : "Project not found.");
    }
  }));

  api.get("/projects/:projectId/download.zip", asyncRoute(async (req, res) => {
    try {
      const project = await getProject(config.projectRoot, req.params.projectId);
      if (project.status === "deleted") {
        fail(res, 404, "Project is deleted.");
        return;
      }

      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error: Error) => {
        if (!res.headersSent) res.status(500).send(error.message);
        else res.end();
      });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${project.id}.zip"`);
      archive.pipe(res);
      archive.directory(getProjectFilesDirectory(config.projectRoot, project.id), "published");
      archive.glob("**/*", {
        cwd: getProjectWorkspaceDirectory(config.projectRoot, project.id),
        ignore: ["node_modules/**", "dist/**"]
      }, { prefix: "workspace" });
      await archive.finalize();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to download project.";
      res.status(404).send(message);
    }
  }));

  api.post("/projects/:projectId/status", async (req, res) => {
    try {
      const status = readBodyString(req, "status");
      if (status !== "published" && status !== "private" && status !== "draft") throw new Error("Invalid project status.");
      const project = await setProjectStatus(config.projectRoot, req.params.projectId, status, config.publicBaseUrl);
      recordActivity({ clientId: "admin", method: "admin/projects/status", toolName: req.params.projectId, ok: true, summary: `Set project ${req.params.projectId} to ${status}.` });
      ok(res, { project });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Project status update failed.");
    }
  });

  api.post("/projects/:projectId/delete", async (req, res) => {
    try {
      const project = await deleteProject(config.projectRoot, req.params.projectId);
      recordActivity({ clientId: "admin", method: "admin/projects/delete", toolName: req.params.projectId, ok: true, summary: `Soft-deleted project ${req.params.projectId}.` });
      ok(res, { project });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Project delete failed.");
    }
  });

  api.get("/connectors", (_req, res) => {
    ok(res, { clients: shapeClients(listOAuthClientStatus()) });
  });

  api.post("/connectors/:clientId/revoke", (req, res) => {
    try {
      revokeClient(req.params.clientId);
      recordActivity({ clientId: "admin", method: "admin/connectors/revoke", toolName: req.params.clientId, ok: true, summary: `Revoked connector ${req.params.clientId}.` });
      ok(res);
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Connector revoke failed.");
    }
  });

  api.get("/special-tools", (_req, res) => {
    ok(res, { tools: getSpecialToolStates() });
  });

  api.post("/special-tools/visible-browser/enable", (req, res) => {
    try {
      const durationMinutes = Number.parseInt(readBodyString(req, "durationMinutes") || "15", 10);
      const state = enableVisibleBrowserControl(durationMinutes, "admin");
      recordActivity({ clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Enabled visible browser control until ${state.enabledUntil}.` });
      ok(res, { state });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool enable failed.");
    }
  });

  api.post("/special-tools/visible-browser/disable", asyncRoute(async (_req, res) => {
    try {
      disableVisibleBrowserControl("admin-disabled");
      const closed = await closeAllBrowserSessions();
      recordActivity({ clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Disabled visible browser control. Closed ${closed.length} browser session(s).` });
      ok(res, { closed });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool disable failed.");
    }
  }));

  api.post("/special-tools/visible-browser/kill", asyncRoute(async (_req, res) => {
    try {
      disableVisibleBrowserControl("admin-kill");
      const closed = await closeAllBrowserSessions();
      recordActivity({ clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Killed visible browser control. Closed ${closed.length} browser session(s).` });
      ok(res, { closed });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool kill failed.");
    }
  }));

  api.get("/skills", (_req, res) => {
    ok(res, { skills: shapeSkills(listSkillStates()) });
  });

  api.post("/skills/:id/toggle", (req, res) => {
    try {
      const enabled = Boolean(readBody(req).enabled);
      setSkillEnabled(req.params.id, enabled);
      recordActivity({ clientId: "admin", method: "admin/skills", toolName: req.params.id, ok: true, summary: `${enabled ? "Enabled" : "Disabled"} skill ${req.params.id}.` });
      ok(res, { skills: shapeSkills(listSkillStates()) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Skill toggle failed.");
    }
  });

  api.get("/tools", (_req, res) => {
    ok(res, { tools: shapeTools(listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name))) });
  });

  api.post("/tools/:name/toggle", (req, res) => {
    try {
      const enabled = Boolean(readBody(req).enabled);
      if (isVisibleBrowserToolName(req.params.name)) throw new Error("Browser control tools are managed from Special Tools.");
      setToolEnabled(req.params.name, enabled);
      recordActivity({ clientId: "admin", method: "admin/tools", toolName: req.params.name, ok: true, summary: `${enabled ? "Enabled" : "Disabled"} tool override ${req.params.name}.` });
      ok(res, { tools: shapeTools(listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name))) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Tool toggle failed.");
    }
  });

  api.get("/activity", (req, res) => {
    const { page, pageSize } = readPageQuery(req);
    ok(res, paginate(filterActivity(req, listActivity(200)), page, pageSize));
  });

  api.get("/settings", (_req, res) => {
    ok(res, {
      publicBaseUrl: config.publicBaseUrl,
      workspaceRoot: config.workspaceRoot,
      projectRoot: config.projectRoot,
      shareRoot: config.shareRoot,
      artifactRoot: config.artifactRoot,
      sessionTtlHours: sessionTtlMs / (60 * 60 * 1000)
    });
  });

  app.use("/admin/api", api);
}
