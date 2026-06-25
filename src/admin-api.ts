import crypto from "node:crypto";
import { ZipArchive } from "archiver";
import express from "express";
import { constantTimeEqual } from "./shared/crypto.js";
import type { ActivityEvent } from "./activity.js";
import { listActivity, recordActivity } from "./activity.js";
import type { OAuthClientStatus } from "./oauth.js";
import { getOAuthClientStatus, listOAuthClientStatus, revokeClient } from "./oauth.js";
import type { ProjectStatus, ProjectSummary, ProjectValidationStatus } from "./projects/store.js";
import {
  deleteProject,
  getProject,
  getProjectFilesDirectory,
  getProjectWorkspaceDirectory,
  getProjectManifest,
  getProjectWithFiles,
  listProjects,
  setProjectShareAccess,
  setProjectStatus
} from "./projects/store.js";
import { getResearchSummary } from "./research/store.js";
import { getIssueStats, listIssues, updateIssueStatus, type IssueStatus } from "./feedback/store.js";
import { summarizeTelemetry } from "./telemetry/aggregate.js";
import { deleteBlogPost, getBlogPostBySlug, getBlogTheme, listBlogPosts, setBlogTheme, upsertBlogPost } from "./blog/store.js";
import { clearHomepage, getHomepage, setHomepage } from "./site/store.js";
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
import type { PublicUser, UserRole, UserSession } from "./user-store.js";
import {
  approveUser,
  createUserSession,
  deleteSession as deleteUserSession,
  disableUser,
  getAllProjectRoots,
  getPublicShareBasePathForUser,
  getUserByProjectRoot,
  getProjectRootForUser,
  getRegistrationSettings,
  getSession as getUserSession,
  getUserById,
  listUsers,
  loginBootstrapAdminWithPasscode,
  loginUser,
  registerUser,
  updateRegistrationSettings,
  updateUserProfile,
  updateUserRole
} from "./user-store.js";

interface AdminApiConfig {
  adminPasscode: string;
  publicBaseUrl: string;
  contentBaseUrl: string;
  projectRoot: string;
  workspaceRoot: string;
  shareRoot: string;
  artifactRoot: string;
  feedbackRoot: string;
}

function projectPublishBaseUrl(config: AdminApiConfig, shareAccess: "private" | "anyone_with_link" | undefined): string {
  return shareAccess === "anyone_with_link" ? config.contentBaseUrl : config.publicBaseUrl;
}

type SortDirection = "asc" | "desc";
type AdminCookieSecureMode = "auto" | "true" | "false";

const sessionCookieName = "coding_mcp_session";
const sessionTtlMs = 8 * 60 * 60 * 1000;
const loginFailureWindowMs = 5 * 60 * 1000;
const loginLockoutMs = 15 * 60 * 1000;
const maxLoginFailures = 5;
const loginAttempts = new Map<string, { failed: number; windowStartedAt: number; lockedUntil?: number }>();

function now(): number {
  return Date.now();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join("="));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function readSessionIdFromRequest(req: express.Request): string | undefined {
  return parseCookies(req.header("cookie"))[sessionCookieName];
}

function adminCookieSecureMode(): AdminCookieSecureMode {
  const value = (process.env.ADMIN_COOKIE_SECURE ?? "auto").trim().toLowerCase();
  if (value === "true" || value === "1") return "true";
  if (value === "false" || value === "0") return "false";
  return "auto";
}

function secureCookie(req: express.Request): boolean {
  const mode = adminCookieSecureMode();
  if (mode === "true") return true;
  if (mode === "false") return false;
  if (req.secure) return true;
  // Only read X-Forwarded-Proto when the operator has explicitly trusted the proxy
  const trustProxy = (process.env.ADMIN_TRUST_PROXY ?? "").toLowerCase();
  if (trustProxy === "true" || trustProxy === "1") {
    const proto = (req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
    return proto === "https";
  }
  return false;
}

function setSessionCookie(req: express.Request, res: express.Response, session: UserSession): void {
  const secure = secureCookie(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookieName}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`);
}

function clearSessionCookie(req: express.Request, res: express.Response): void {
  const secure = secureCookie(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
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

async function readSession(req: express.Request): Promise<{ session: UserSession; user: PublicUser } | undefined> {
  return getUserSession(readSessionIdFromRequest(req));
}

async function requireSession(req: express.Request, res: express.Response): Promise<{ session: UserSession; user: PublicUser } | undefined> {
  const value = await readSession(req);
  if (!value) {
    fail(res, 401, "Admin session required.");
    return undefined;
  }
  return value;
}

function requireCsrf(req: express.Request, res: express.Response, session: UserSession): boolean {
  if (constantTimeEqual(req.header("x-csrf-token"), session.csrfToken)) return true;
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

function filterActivityForUser(user: PublicUser, activity: ActivityEvent[]): ActivityEvent[] {
  if (user.role === "admin") return activity;
  return activity.filter((event) => event.userId === user.id);
}

function filterClientsForUser(user: PublicUser, clients: OAuthClientStatus[]): OAuthClientStatus[] {
  if (user.role === "admin") return clients;
  return clients.filter((client) => client.ownerUserId === user.id);
}

function requireAdmin(user: PublicUser, res: express.Response): boolean {
  if (user.role === "admin") return true;
  fail(res, 403, "Admin role required.");
  return false;
}

function requireProjectMutation(user: PublicUser, res: express.Response): boolean {
  if (user.role === "viewer") {
    fail(res, 403, "Viewer role cannot mutate projects.");
    return false;
  }
  return true;
}

async function listVisibleProjects(user: PublicUser, includeDeleted: boolean): Promise<ProjectSummary[]> {
  if (user.role !== "admin") return listProjects(await getProjectRootForUser(user.id), includeDeleted);
  const roots = await getAllProjectRoots();
  const projects = await Promise.all(roots.map((root) => listProjects(root, includeDeleted).catch(() => [] as ProjectSummary[])));
  return projects.flat();
}

async function requestedProjectRoot(req: express.Request, user: PublicUser): Promise<string> {
  const requestedUserId = readStringQuery(req, "userId");
  if (user.role === "admin" && requestedUserId) return getProjectRootForUser(requestedUserId);
  return getProjectRootForUser(user.id);
}

async function findProjectRoot(req: express.Request, user: PublicUser, projectId: string): Promise<string> {
  const firstRoot = await requestedProjectRoot(req, user);
  try {
    await getProject(firstRoot, projectId);
    return firstRoot;
  } catch {
    if (user.role !== "admin") throw new Error("Project not found.");
  }
  for (const root of await getAllProjectRoots()) {
    try {
      await getProject(root, projectId);
      return root;
    } catch {
      continue;
    }
  }
  throw new Error("Project not found.");
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

function sessionPayload(session: UserSession, user: PublicUser): Record<string, unknown> {
  return {
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user
  };
}

function toPublicSessionUser(user: {
  id: string;
  email: string;
  role: UserRole;
  status: "pending" | "active" | "disabled";
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
}, projectRoot?: string): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    username: "username" in user && typeof user.username === "string" ? user.username : undefined,
    publicShareUsernameEnabled: "publicShareUsernameEnabled" in user ? Boolean(user.publicShareUsernameEnabled) : false,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy,
    projectRoot
  };
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
    requireSession(req, res).then((value) => {
      if (!value) return;
      res.locals.userSession = value.session;
      res.locals.currentUser = value.user;
      if (req.method !== "GET" && req.method !== "HEAD" && !requireCsrf(req, res, value.session)) return;
      next();
    }).catch(next);
  };
}

export function registerAdminApi(app: express.Express, config: AdminApiConfig): void {
  const api = express.Router();

  api.post("/auth/login", asyncRoute(async (req, res) => {
    const email = readBodyString(req, "email");
    const password = readBodyString(req, "password");
    const attemptKey = loginAttemptKey(req);
    const current = now();
    const lockedAttempt = getLockedLoginAttempt(attemptKey, current);
    if (lockedAttempt?.lockedUntil) {
      recordActivity({ clientId: "admin", method: "admin/auth/login", ok: false, summary: "Rate-limited login attempt." });
      fail(res, 429, "Too many login attempts. Try again later.");
      return;
    }
    try {
      const user = await loginUser(email, password);
      loginAttempts.delete(attemptKey);
      const session = await createUserSession(user.id);
      setSessionCookie(req, res, session);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/auth/login", ok: true, summary: `User ${user.email} logged in.` });
      ok(res, sessionPayload(session, toPublicSessionUser(user, await getProjectRootForUser(user.id))));
    } catch (error) {
      const failure = recordLoginFailure(attemptKey, current);
      recordActivity({ clientId: "admin", method: "admin/auth/login", ok: false, summary: "Rejected login attempt." });
      fail(res, failure.locked ? 429 : 401, failure.locked ? "Too many login attempts. Try again later." : error instanceof Error ? error.message : "Login failed.");
      return;
    }
  }));

  api.post("/auth/register", asyncRoute(async (req, res) => {
    try {
      const user = await registerUser(readBodyString(req, "email"), readBodyString(req, "password"));
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/auth/register", ok: true, summary: `Registered pending user ${user.email}.` });
      ok(res, { user, pending: true });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Registration failed.");
    }
  }));

  api.post("/session", asyncRoute(async (req, res) => {
    const attemptKey = loginAttemptKey(req);
    const current = now();
    const lockedAttempt = getLockedLoginAttempt(attemptKey, current);
    if (lockedAttempt?.lockedUntil) {
      fail(res, 429, "Too many login attempts. Try again later.");
      return;
    }
    const passcode = readBodyString(req, "passcode");
    const email = readBodyString(req, "email");
    const password = readBodyString(req, "password");
    try {
      const user = email && password ? await loginUser(email, password) : await loginBootstrapAdminWithPasscode(passcode);
      loginAttempts.delete(attemptKey);
      const session = await createUserSession(user.id);
      setSessionCookie(req, res, session);
      ok(res, sessionPayload(session, toPublicSessionUser(user, await getProjectRootForUser(user.id))));
    } catch (error) {
      const failure = recordLoginFailure(attemptKey, current);
      fail(res, failure.locked ? 429 : 401, failure.locked ? "Too many login attempts. Try again later." : error instanceof Error ? error.message : "Login failed.");
    }
  }));

  api.get("/session", asyncRoute(async (req, res) => {
    const value = await readSession(req);
    ok(res, {
      authenticated: Boolean(value),
      csrfToken: value?.session.csrfToken,
      expiresAt: value?.session.expiresAt,
      user: value?.user
    });
  }));

  api.use(requireApiSession(config));

  api.delete("/session", asyncRoute(async (req, res) => {
    const session = res.locals.userSession as UserSession;
    const user = res.locals.currentUser as PublicUser;
    await deleteUserSession(session.id);
    clearSessionCookie(req, res);
    recordActivity({ userId: user.id, clientId: "admin", method: "admin/session", ok: true, summary: "Admin session ended." });
    ok(res);
  }));

  api.get("/overview", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    const projects = await listVisibleProjects(user, true);
    const activeProjects = projects.filter((project) => project.status !== "deleted");
    const activity = filterActivityForUser(user, listActivity(200));
    const specialTools = getSpecialToolStates();
    const tools = listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name));
    const counts = projectCounts(projects);
    ok(res, {
      metrics: {
        connectedClients: filterClientsForUser(user, listOAuthClientStatus()).length,
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
    const user = res.locals.currentUser as PublicUser;
    const { page, pageSize } = readPageQuery(req);
    const sort = readStringQuery(req, "sort") || "updated-desc";
    const projects = sortProjects(filterProjects(req, await listVisibleProjects(user, true)), sort);
    ok(res, { ...paginate(projects, page, pageSize), sort });
  }));

  api.get("/projects/:projectId", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      const root = await findProjectRoot(req, user, req.params.projectId);
      const project = await getProjectWithFiles(root, req.params.projectId);
      const manifest = await getProjectManifest(root, req.params.projectId);
      const researchSummary = await getResearchSummary(root, req.params.projectId);
      ok(res, { project: project.metadata, files: project.files, manifest, researchSummary });
    } catch (error) {
      fail(res, 404, error instanceof Error ? error.message : "Project not found.");
    }
  }));

  api.get("/projects/:projectId/download.zip", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      const root = await findProjectRoot(req, user, req.params.projectId);
      const project = await getProject(root, req.params.projectId);
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
      archive.directory(getProjectFilesDirectory(root, project.id), "published");
      archive.glob("**/*", {
        cwd: getProjectWorkspaceDirectory(root, project.id),
        ignore: ["node_modules/**", "dist/**"]
      }, { prefix: "workspace" });
      await archive.finalize();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to download project.";
      res.status(404).send(message);
    }
  }));

  api.post("/projects/:projectId/status", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireProjectMutation(user, res)) return;
      const status = readBodyString(req, "status");
      if (status !== "published" && status !== "private" && status !== "draft") throw new Error("Invalid project status.");
      const root = await findProjectRoot(req, user, req.params.projectId);
      const owner = await getUserByProjectRoot(root);
      const current = await getProject(root, req.params.projectId);
      const project = await setProjectStatus(root, req.params.projectId, status, projectPublishBaseUrl(config, current.shareAccess), {
        privateBaseUrl: config.publicBaseUrl,
        shareBasePath: getPublicShareBasePathForUser(owner)
      });
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/projects/status", toolName: req.params.projectId, ok: true, summary: `Set project ${req.params.projectId} to ${status}.` });
      ok(res, { project });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Project status update failed.");
    }
  }));

  api.post("/projects/:projectId/share-access", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireProjectMutation(user, res)) return;
      const shareAccess = readBodyString(req, "shareAccess");
      if (shareAccess !== "private" && shareAccess !== "anyone_with_link") throw new Error("Invalid project share access.");
      const root = await findProjectRoot(req, user, req.params.projectId);
      const owner = await getUserByProjectRoot(root);
      const project = await setProjectShareAccess(root, req.params.projectId, shareAccess, {
        publicBaseUrl: config.contentBaseUrl,
        privateBaseUrl: config.publicBaseUrl,
        shareBasePath: getPublicShareBasePathForUser(owner)
      });
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/projects/share-access", toolName: req.params.projectId, ok: true, summary: `Set project ${req.params.projectId} share access to ${shareAccess}.` });
      ok(res, { project });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Project share access update failed.");
    }
  }));

  api.post("/projects/:projectId/delete", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireProjectMutation(user, res)) return;
      const root = await findProjectRoot(req, user, req.params.projectId);
      const project = await deleteProject(root, req.params.projectId);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/projects/delete", toolName: req.params.projectId, ok: true, summary: `Soft-deleted project ${req.params.projectId}.` });
      ok(res, { project });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Project delete failed.");
    }
  }));

  api.get("/site/home", asyncRoute(async (_req, res) => {
    const home = getHomepage();
    if (!home.homeProjectId || !home.homeOwnerUserId) {
      ok(res, { homepage: null });
      return;
    }
    try {
      const root = await getProjectRootForUser(home.homeOwnerUserId);
      const project = await getProject(root, home.homeProjectId);
      ok(res, { homepage: { projectId: home.homeProjectId, title: project.title, status: project.status, updatedAt: home.updatedAt } });
    } catch {
      ok(res, { homepage: { projectId: home.homeProjectId, title: null, status: "unknown", updatedAt: home.updatedAt } });
    }
  }));

  api.post("/projects/:projectId/homepage", asyncRoute(async (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      const root = await findProjectRoot(req, user, req.params.projectId);
      const project = await getProject(root, req.params.projectId);
      if (project.status !== "published") throw new Error("Project must be published before it can be the homepage.");
      const owner = await getUserByProjectRoot(root);
      if (!owner) throw new Error("Could not resolve the project owner.");
      setHomepage({ projectId: req.params.projectId, ownerUserId: owner.id });
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/site/home", toolName: req.params.projectId, ok: true, summary: `Set project ${req.params.projectId} as the homepage.` });
      ok(res, { homepage: { projectId: req.params.projectId, title: project.title } });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Failed to set homepage.");
    }
  }));

  api.delete("/site/home", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    clearHomepage();
    recordActivity({ userId: user.id, clientId: "admin", method: "admin/site/home", ok: true, summary: "Cleared the homepage." });
    ok(res, { homepage: null });
  }));

  api.get("/blog/posts", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const posts = await listBlogPosts();
    ok(res, { posts: posts.map((post) => ({ slug: post.slug, title: post.title, status: post.status, tags: post.tags, publishedAt: post.publishedAt, updatedAt: post.updatedAt })) });
  }));

  api.get("/blog/posts/:slug", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const post = await getBlogPostBySlug(req.params.slug);
    if (!post) { fail(res, 404, "Blog post not found."); return; }
    ok(res, { post });
  }));

  api.post("/blog/posts", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const body = readBody(req);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!title) { fail(res, 400, "Title is required."); return; }
    if (!content) { fail(res, 400, "Content is required."); return; }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string")
      : typeof body.tags === "string"
        ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : undefined;
    try {
      const post = await upsertBlogPost({
        title,
        content,
        format: body.format === "html" ? "html" : "markdown",
        slug: typeof body.slug === "string" && body.slug.trim() ? body.slug.trim() : undefined,
        excerpt: typeof body.excerpt === "string" ? body.excerpt : undefined,
        coverImageUrl: typeof body.coverImageUrl === "string" ? body.coverImageUrl : undefined,
        seoDescription: typeof body.seoDescription === "string" ? body.seoDescription : undefined,
        tags,
        status: body.status === "draft" ? "draft" : "published",
        authorUserId: user.id
      });
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/blog/upsert", toolName: post.slug, ok: true, summary: `Saved blog post ${post.slug}.` });
      ok(res, { post });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Failed to save blog post.");
    }
  }));

  api.delete("/blog/posts/:slug", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const removed = await deleteBlogPost(req.params.slug);
    if (!removed) { fail(res, 404, "Blog post not found."); return; }
    recordActivity({ userId: user.id, clientId: "admin", method: "admin/blog/delete", toolName: req.params.slug, ok: true, summary: `Deleted blog post ${req.params.slug}.` });
    ok(res, { slug: req.params.slug });
  }));

  api.get("/blog/theme", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { theme: await getBlogTheme() });
  }));

  api.post("/blog/theme", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const body = readBody(req);
    const input: { title?: string; css?: string; headerHtml?: string; footerHtml?: string } = {};
    if (typeof body.title === "string") input.title = body.title;
    if (typeof body.css === "string") input.css = body.css;
    if (typeof body.headerHtml === "string") input.headerHtml = body.headerHtml;
    if (typeof body.footerHtml === "string") input.footerHtml = body.footerHtml;
    const theme = await setBlogTheme(input);
    recordActivity({ userId: user.id, clientId: "admin", method: "admin/blog/theme", ok: true, summary: "Updated blog theme." });
    ok(res, { theme });
  }));

  api.get("/connectors", (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    ok(res, { clients: shapeClients(filterClientsForUser(user, listOAuthClientStatus())) });
  });

  api.get("/connectors/:clientId", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    const client = getOAuthClientStatus(req.params.clientId);
    if (!client || !filterClientsForUser(user, [client]).length) {
      fail(res, 404, "Connector not found.");
      return;
    }
    const owner = client.ownerUserId ? await getUserById(client.ownerUserId) : undefined;
    const activity = listActivity(200).filter((event) => event.clientId === req.params.clientId).slice(0, 40);
    const failures = activity.filter((event) => !event.ok);
    const toolsUsed = [...new Set(activity.map((event) => event.toolName).filter((value): value is string => Boolean(value)))];
    ok(res, { client, owner, activity, failures, toolsUsed });
  }));

  api.get("/connectors/:clientId/activity", (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    const client = getOAuthClientStatus(req.params.clientId);
    if (!client || !filterClientsForUser(user, [client]).length) {
      fail(res, 404, "Connector not found.");
      return;
    }
    const { page, pageSize } = readPageQuery(req);
    const scoped = listActivity(200).filter((event) => event.clientId === req.params.clientId);
    ok(res, paginate(filterActivity(req, scoped), page, pageSize));
  });

  api.post("/connectors/:clientId/revoke", (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      const client = getOAuthClientStatus(req.params.clientId);
      if (!client || !filterClientsForUser(user, [client]).length) {
        fail(res, 404, "Connector not found.");
        return;
      }
      revokeClient(req.params.clientId);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/connectors/revoke", toolName: req.params.clientId, ok: true, summary: `Revoked connector ${req.params.clientId}.` });
      ok(res);
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Connector revoke failed.");
    }
  });

  api.get("/special-tools", (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { tools: getSpecialToolStates() });
  });

  api.post("/special-tools/visible-browser/enable", (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      const durationMinutes = Number.parseInt(readBodyString(req, "durationMinutes") || "15", 10);
      const state = enableVisibleBrowserControl(durationMinutes, user.id);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Enabled visible browser control until ${state.enabledUntil}.` });
      ok(res, { state });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool enable failed.");
    }
  });

  api.post("/special-tools/visible-browser/disable", asyncRoute(async (_req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      disableVisibleBrowserControl("admin-disabled");
      const closed = await closeAllBrowserSessions();
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Disabled visible browser control. Closed ${closed.length} browser session(s).` });
      ok(res, { closed });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool disable failed.");
    }
  }));

  api.post("/special-tools/visible-browser/kill", asyncRoute(async (_req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      disableVisibleBrowserControl("admin-kill");
      const closed = await closeAllBrowserSessions();
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/special-tools", toolName: "visible_browser_control", ok: true, summary: `Killed visible browser control. Closed ${closed.length} browser session(s).` });
      ok(res, { closed });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Special tool kill failed.");
    }
  }));

  api.get("/skills", (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { skills: shapeSkills(listSkillStates()) });
  });

  api.post("/skills/:id/toggle", (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      const enabled = readBody(req).enabled === true;
      setSkillEnabled(req.params.id, enabled);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/skills", toolName: req.params.id, ok: true, summary: `${enabled ? "Enabled" : "Disabled"} skill ${req.params.id}.` });
      ok(res, { skills: shapeSkills(listSkillStates()) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Skill toggle failed.");
    }
  });

  api.get("/tools", (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { tools: shapeTools(listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name))) });
  });

  api.post("/tools/:name/toggle", (req, res) => {
    try {
      const user = res.locals.currentUser as PublicUser;
      if (!requireAdmin(user, res)) return;
      const enabled = readBody(req).enabled === true;
      if (isVisibleBrowserToolName(req.params.name)) throw new Error("Browser control tools are managed from Special Tools.");
      setToolEnabled(req.params.name, enabled);
      recordActivity({ userId: user.id, clientId: "admin", method: "admin/tools", toolName: req.params.name, ok: true, summary: `${enabled ? "Enabled" : "Disabled"} tool override ${req.params.name}.` });
      ok(res, { tools: shapeTools(listEffectiveToolStates().filter((tool) => !isVisibleBrowserToolName(tool.name))) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Tool toggle failed.");
    }
  });

  api.get("/activity", (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    const { page, pageSize } = readPageQuery(req);
    ok(res, paginate(filterActivity(req, filterActivityForUser(user, listActivity(200))), page, pageSize));
  });

  api.get("/users", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const { page, pageSize } = readPageQuery(req);
    ok(res, paginate(await listUsers({ status: readStringQuery(req, "status"), q: readStringQuery(req, "q") }), page, pageSize));
  }));

  api.get("/profile", (_req, res) => {
    ok(res, { user: res.locals.currentUser as PublicUser });
  });

  api.post("/profile", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    try {
      const updated = await updateUserProfile(user.id, {
        username: readBodyString(req, "username"),
        publicShareUsernameEnabled: Boolean(readBody(req).publicShareUsernameEnabled)
      });
      const projectRoot = await getProjectRootForUser(updated.id);
      const shareBasePath = getPublicShareBasePathForUser(updated);
      const publishedProjects = (await listProjects(projectRoot, true)).filter((project) => project.status === "published");
      for (const project of publishedProjects) {
        await setProjectStatus(projectRoot, project.id, "published", projectPublishBaseUrl(config, project.shareAccess), {
          privateBaseUrl: config.publicBaseUrl,
          shareBasePath
        });
      }
      ok(res, { user: updated, updatedProjectCount: publishedProjects.length });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "Profile update failed.");
    }
  }));

  api.post("/users/:userId/approve", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { user: await approveUser(req.params.userId, user.id) });
  }));

  api.post("/users/:userId/disable", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    try {
      ok(res, { user: await disableUser(req.params.userId) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "User disable failed.");
    }
  }));

  api.post("/users/:userId/role", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const role = readBodyString(req, "role") as UserRole;
    if (role !== "admin" && role !== "developer" && role !== "viewer") {
      fail(res, 400, "Invalid role.");
      return;
    }
    try {
      ok(res, { user: await updateUserRole(req.params.userId, role) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : "User role update failed.");
    }
  }));

  api.get("/registration-settings", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { settings: await getRegistrationSettings() });
  }));

  api.post("/registration-settings", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    ok(res, { settings: await updateRegistrationSettings({
      allowRegistration: Boolean(readBody(req).allowRegistration),
      allowedEmailDomains: Array.isArray(readBody(req).allowedEmailDomains)
        ? (readBody(req).allowedEmailDomains as unknown[]).map(String)
        : readBodyString(req, "allowedEmailDomains").split(",").map((item) => item.trim()).filter(Boolean)
    }) });
  }));

  api.get("/settings", asyncRoute(async (_req, res) => {
    const user = res.locals.currentUser as PublicUser;
    ok(res, {
      publicBaseUrl: config.publicBaseUrl,
      contentBaseUrl: config.contentBaseUrl,
      workspaceRoot: config.workspaceRoot,
      projectRoot: user.role === "admin" ? config.projectRoot : await getProjectRootForUser(user.id),
      shareRoot: config.shareRoot,
      artifactRoot: config.artifactRoot,
      sessionTtlHours: sessionTtlMs / (60 * 60 * 1000),
      registrationSettings: user.role === "admin" ? await getRegistrationSettings() : undefined
    });
  }));

  api.get("/feedback", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const allowedStatus: IssueStatus[] = ["open", "investigating", "resolved", "wontfix"];
    const status = allowedStatus.includes(statusFilter as IssueStatus) ? (statusFilter as IssueStatus) : undefined;
    const [issues, stats] = await Promise.all([
      listIssues(config.feedbackRoot, { status, limit: 500 }),
      getIssueStats(config.feedbackRoot)
    ]);
    ok(res, { issues, stats });
  }));

  api.post("/feedback/:id/status", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const status = readBodyString(req, "status") as IssueStatus;
    if (!["open", "investigating", "resolved", "wontfix"].includes(status)) {
      fail(res, 400, "Invalid status.");
      return;
    }
    const resolutionNote = readBodyString(req, "resolutionNote") || undefined;
    try {
      const issue = await updateIssueStatus(config.feedbackRoot, { id: req.params.id, status, resolutionNote });
      ok(res, { issue });
    } catch (error) {
      fail(res, 404, error instanceof Error ? error.message : "Issue not found.");
    }
  }));

  api.get("/telemetry", asyncRoute(async (req, res) => {
    const user = res.locals.currentUser as PublicUser;
    if (!requireAdmin(user, res)) return;
    const windowDays = Math.min(90, Math.max(1, Number.parseInt(readStringQuery(req, "days") || "7", 10) || 7));
    ok(res, { telemetry: await summarizeTelemetry(windowDays) });
  }));

  app.use("/admin/api", api);
}
