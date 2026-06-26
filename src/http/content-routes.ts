import type express from "express";
import { readArtifact } from "../artifacts/store.js";
import { renderPublicSharePage, type PublicShareLocale } from "../admin.js";
import type { ServerConfig } from "../config.js";
import { getJob } from "../jobs/store.js";
import { renderPreviewPage } from "../preview.js";
import {
  getProject,
  getProjectFileContentType,
  getProjectStoredFilePath,
  isProjectTextFilePath,
  listProjects,
  readProjectFile
} from "../projects/store.js";
import { readShareArtifact } from "../share/store.js";
import { getBlogPostBySlug, getBlogTheme, listBlogPosts } from "../blog/store.js";
import { renderBlogIndex, renderBlogPost, renderBlogRss } from "../blog/render.js";
import { getHomepage } from "../site/store.js";
import {
  getAllProjectRoots,
  getProjectRootForUser,
  getPublicShareBasePathForUser,
  getUserByProjectRoot,
  getUserByUsername,
  getSession as getUserSession
} from "../user-store.js";
import { asyncRoute } from "./util.js";

const strictProjectContentCsp = "sandbox allow-scripts allow-popups allow-modals; form-action 'none';";
const contentHostProjectCsp = "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads; base-uri 'none'; form-action 'self';";
const blogCsp = "default-src 'self' 'unsafe-inline' data: https:; base-uri 'none'; form-action 'self';";
const sessionCookieName = "coding_mcp_session";

function configuredHost(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

function requestHost(req: express.Request): string {
  return (req.get("host") ?? "").toLowerCase();
}

function sameConfiguredHost(req: express.Request, baseUrl: string): boolean {
  const host = configuredHost(baseUrl);
  return Boolean(host && requestHost(req) === host);
}

function configuredHostsAreSeparate(publicBaseUrl: string, contentBaseUrl: string): boolean {
  const publicHost = configuredHost(publicBaseUrl);
  const contentHost = configuredHost(contentBaseUrl);
  return Boolean(publicHost && contentHost && publicHost !== contentHost);
}

function contentUrl(config: ServerConfig, pathAndQuery: string): string {
  return `${config.contentBaseUrl.replace(/\/$/, "")}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
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

async function canViewPublishedProject(req: express.Request, root: string, shareAccess: string | undefined): Promise<boolean> {
  if ((shareAccess ?? "private") === "anyone_with_link") return true;
  const sessionId = parseCookies(req.header("cookie"))[sessionCookieName];
  const session = await getUserSession(sessionId);
  if (!session || session.user.status !== "active") return false;
  if (session.user.role === "admin") return true;
  return session.user.projectRoot === root;
}

async function canViewLegacyShare(req: express.Request, shareAccess: string | undefined, ownerUserId?: string): Promise<boolean> {
  if ((shareAccess ?? "private") === "anyone_with_link") return true;
  const sessionId = parseCookies(req.header("cookie"))[sessionCookieName];
  const session = await getUserSession(sessionId);
  if (!session || session.user.status !== "active") return false;
  if (session.user.role === "admin") return true;
  return ownerUserId ? session.user.id === ownerUserId : false;
}

function setShareCacheHeaders(res: express.Response, shareAccess: string | undefined, isPublicRoute: boolean): void {
  if (isPublicRoute || (shareAccess ?? "private") === "anyone_with_link") {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie");
}

function getPublicShareLocale(req: express.Request): PublicShareLocale {
  if (req.query.lang === "zh" || req.query.lang === "en") return req.query.lang;
  const preferredLanguage = req.acceptsLanguages("zh-CN", "zh", "en");
  return typeof preferredLanguage === "string" && preferredLanguage.startsWith("zh") ? "zh" : "en";
}

function injectCanonicalLink(html: string, canonicalUrl: string): string {
  const link = `<link rel="canonical" href="${canonicalUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
  if (/<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(html)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${link}</head>`);
  return `${link}\n${html}`;
}

async function sendPublishedProjectFile(req: express.Request, res: express.Response, root: string, projectId: string, filename: string, canonicalUrl?: string, requireShareAccess = true, htmlCsp = strictProjectContentCsp): Promise<boolean> {
  const project = await getProject(root, projectId);
  if (project.status !== "published") return false;
  if (requireShareAccess && !await canViewPublishedProject(req, root, project.shareAccess)) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    res.status(404).type("text/plain").send("Share not found.");
    return true;
  }
  const contentType = getProjectFileContentType(filename);
  setShareCacheHeaders(res, project.shareAccess, !requireShareAccess);
  if (contentType === "text/html") {
    res.setHeader("Content-Security-Policy", htmlCsp);
    if (canonicalUrl) res.setHeader("Link", `<${canonicalUrl}>; rel="canonical"`);
  }
  if (isProjectTextFilePath(filename)) {
    const content = await readProjectFile(root, project.id, filename, 1024 * 1024);
    res.type(contentType).send(contentType === "text/html" && canonicalUrl ? injectCanonicalLink(content, canonicalUrl) : content);
    return true;
  }

  const absolutePath = await getProjectStoredFilePath(root, project.id, filename);
  res.type(contentType).sendFile(absolutePath, (error) => {
    if (error && !res.headersSent) {
      res.status(404).type("text/plain").send("Share not found.");
    }
  });
  return true;
}

function renderDefaultLanding(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coding MCP</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1511; color: #e8efe9; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: clamp(28px, 5vw, 44px); margin: 0 0 12px; }
  p { color: #9fb0a4; margin: 0 0 24px; }
  a { display: inline-block; margin: 6px; padding: 11px 18px; border-radius: 8px; text-decoration: none; font-weight: 650; }
  .primary { background: #16615a; color: #fff; }
  .ghost { border: 1px solid #2c3a31; color: #cfe0d4; }
</style>
</head>
<body>
  <main>
    <h1>Coding MCP</h1>
    <p>No homepage has been published yet.</p>
    <a class="primary" href="/admin">Admin console</a>
    <a class="ghost" href="/blog/">Blog</a>
    <a class="ghost" href="/share">Public projects</a>
  </main>
</body>
</html>`;
}

function renderHomepageUnavailable(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Homepage unavailable</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, sans-serif; background: #141718; color: #edf2f0; }
  main { max-width: 640px; padding: 32px; text-align: center; }
  h1 { font-size: clamp(28px, 5vw, 42px); margin: 0 0 12px; }
  p { color: #aab7b2; margin: 0; line-height: 1.55; }
</style>
</head>
<body>
  <main>
    <h1>Homepage unavailable</h1>
    <p>Configured homepage is unavailable. An administrator can publish a valid project or clear the homepage setting.</p>
  </main>
</body>
</html>`;
}

export function registerContentRoutes(app: express.Express, config: ServerConfig): void {
  const { publicBaseUrl, contentBaseUrl, artifactRoot } = config;
  const hasSeparateContentHost = configuredHostsAreSeparate(publicBaseUrl, contentBaseUrl);

  function isAppHostRequest(req: express.Request): boolean {
    return hasSeparateContentHost && sameConfiguredHost(req, publicBaseUrl);
  }

  function redirectAppHostToContent(req: express.Request, res: express.Response): boolean {
    if (!isAppHostRequest(req)) return false;
    res.redirect(302, contentUrl(config, req.originalUrl));
    return true;
  }

  function projectHtmlCspForRequest(req: express.Request): string {
    return hasSeparateContentHost && sameConfiguredHost(req, contentBaseUrl)
      ? contentHostProjectCsp
      : strictProjectContentCsp;
  }

  type HomepageServeResult = "served" | "not_configured" | "unavailable" | "not_found";

  async function serveHomepageFile(req: express.Request, res: express.Response, relativePath?: string): Promise<HomepageServeResult> {
    if (isAppHostRequest(req)) return "not_configured";
    const home = getHomepage();
    if (!home.homeProjectId || !home.homeOwnerUserId) return "not_configured";
    try {
      const root = await getProjectRootForUser(home.homeOwnerUserId);
      const project = await getProject(root, home.homeProjectId);
      if (project.status !== "published") return "unavailable";
      const filename = relativePath && relativePath !== "/" ? relativePath.replace(/^\/+/, "") : project.entryFile;
      return await sendPublishedProjectFile(req, res, root, home.homeProjectId, filename, `${contentBaseUrl.replace(/\/$/, "")}/`, false, projectHtmlCspForRequest(req))
        ? "served"
        : relativePath ? "not_found" : "unavailable";
    } catch {
      return relativePath ? "not_found" : "unavailable";
    }
  }

  app.get("/", asyncRoute(async (req, res) => {
    const homeResult = await serveHomepageFile(req, res);
    if (homeResult === "served") return;
    if (homeResult === "unavailable") {
      res.status(503).type("html").send(renderHomepageUnavailable());
      return;
    }
    res.type("html").send(renderDefaultLanding());
  }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      version: "0.1.0",
      service: "coding-mcp-chatgpt"
    });
  });

  app.get(["/share", "/share/"], asyncRoute(async (req, res) => {
    if (redirectAppHostToContent(req, res)) return;
    try {
      const roots = await getAllProjectRoots();
      const projects = (await Promise.all(roots.map((root) => listProjects(root, false).catch(() => [])))).flat().filter((project) => project.status === "published" && project.shareAccess === "anyone_with_link");
      res.type("html").send(renderPublicSharePage({
        publicBaseUrl: contentBaseUrl,
        projects,
        locale: getPublicShareLocale(req)
      }));
    } catch {
      res.status(500).type("text/plain").send("Unable to load public share index.");
    }
  }));

  app.get("/outcome/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).send("Outcome not found.");
      return;
    }

    // The 122-bit random jobId is the capability — there is no session here. Job
    // logs can contain sensitive command/build output, so prevent the URL leaking:
    // no Referer to outbound links, no search-engine indexing, no shared caching.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "private, no-store");
    res.type("html").send(renderPreviewPage(job));
  });

  app.get("/@:username", asyncRoute(async (req, res) => {
    if (redirectAppHostToContent(req, res)) return;
    try {
      const user = await getUserByUsername(req.params.username);
      if (!user?.username || !user.publicShareUsernameEnabled || !user.projectRoot) {
        res.status(404).type("text/plain").send("Public profile not found.");
        return;
      }
      const projects = (await listProjects(user.projectRoot, false)).filter((project) => project.status === "published" && project.shareAccess === "anyone_with_link");
      res.type("html").send(renderPublicSharePage({
        publicBaseUrl: contentBaseUrl,
        projects,
        locale: getPublicShareLocale(req)
      }));
    } catch {
      res.status(404).type("text/plain").send("Public profile not found.");
    }
  }));

  app.get("/@:username/share/:shareId/:filename(*)", asyncRoute(async (req, res) => {
    try {
      const user = await getUserByUsername(req.params.username);
      if (!user?.username || !user.publicShareUsernameEnabled || !user.projectRoot) {
        res.status(404).type("text/plain").send("Share not found.");
        return;
      }
      const canonicalUrl = `${contentBaseUrl.replace(/\/$/, "")}/@${user.username}/share/${req.params.shareId}/${req.params.filename}`;
      const project = await getProject(user.projectRoot, req.params.shareId);
      if (isAppHostRequest(req) && project.shareAccess === "anyone_with_link") {
        res.redirect(302, canonicalUrl);
        return;
      }
      if (await sendPublishedProjectFile(req, res, user.projectRoot, req.params.shareId, req.params.filename, canonicalUrl, true, projectHtmlCspForRequest(req))) return;
    } catch {
      // Fall through to 404.
    }
    if (!res.headersSent) res.status(404).type("text/plain").send("Share not found.");
  }));

  app.get("/share/:shareId/:filename(*)", asyncRoute(async (req, res) => {
    try {
      for (const root of await getAllProjectRoots()) {
        try {
          const owner = await getUserByProjectRoot(root);
          const canonicalBase = getPublicShareBasePathForUser(owner);
          const canonicalUrl = `${contentBaseUrl.replace(/\/$/, "")}${canonicalBase}/${req.params.shareId}/${req.params.filename}`;
          const project = await getProject(root, req.params.shareId);
          if (isAppHostRequest(req) && project.shareAccess === "anyone_with_link") {
            res.redirect(302, canonicalUrl);
            return;
          }
          if (await sendPublishedProjectFile(req, res, root, req.params.shareId, req.params.filename, canonicalUrl, true, projectHtmlCspForRequest(req))) return;
        } catch {
          continue;
        }
      }
    } catch {
      // Not a published project share; fall back to legacy standalone shares.
    }

    const artifact = await readShareArtifact(req.params.shareId, req.params.filename);
    if (!artifact || artifact.record.filename !== req.params.filename) {
      res.status(404).type("text/plain").send("Share not found.");
      return;
    }
    if (!await canViewLegacyShare(req, artifact.record.shareAccess, artifact.record.ownerUserId)) {
      res.status(404).type("text/plain").send("Share not found.");
      return;
    }
    res.setHeader("Content-Security-Policy", strictProjectContentCsp);
    res.type("html").send(artifact.html);
  }));

  app.get("/artifact/:artifactId/:filename(*)", asyncRoute(async (req, res) => {
    if (isAppHostRequest(req)) {
      res.status(404).type("text/plain").send("Artifact not found.");
      return;
    }
    try {
      const artifact = await readArtifact(artifactRoot, req.params.artifactId, req.params.filename);
      if (!artifact) {
        res.status(404).type("text/plain").send("Artifact not found.");
        return;
      }
      // Sandbox served artifacts: scripts still run for HTML previews, but the
      // document loads in an opaque origin (no allow-same-origin) so it cannot reach
      // admin-origin storage or make credentialed same-origin requests on this shared
      // origin. (The session cookie is already HttpOnly, so this guards the rest.)
      res.setHeader("Content-Security-Policy", strictProjectContentCsp);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type(artifact.record.contentType).send(artifact.content);
    } catch {
      res.status(404).type("text/plain").send("Artifact not found.");
    }
  }));

  app.get(["/blog", "/blog/"], asyncRoute(async (_req, res) => {
    const [posts, theme] = await Promise.all([listBlogPosts({ status: "published" }), getBlogTheme()]);
    res.setHeader("Content-Security-Policy", blogCsp);
    res.type("html").send(renderBlogIndex(posts, theme));
  }));

  app.get("/blog/rss.xml", asyncRoute(async (_req, res) => {
    const [posts, theme] = await Promise.all([listBlogPosts({ status: "published" }), getBlogTheme()]);
    res.type("application/rss+xml").send(renderBlogRss(posts, theme, publicBaseUrl));
  }));

  app.get("/blog/:slug", asyncRoute(async (req, res) => {
    const post = await getBlogPostBySlug(req.params.slug);
    if (!post || post.status !== "published") {
      res.status(404).type("text/plain").send("Post not found.");
      return;
    }
    const theme = await getBlogTheme();
    res.setHeader("Content-Security-Policy", blogCsp);
    res.type("html").send(renderBlogPost(post, theme));
  }));

  // Fallback: serve root-level assets of the homepage project (e.g. /styles.css, /assets/app.js).
  // Registered last so it never shadows a named route; falls through to 404 when no homepage is set.
  app.get("/:asset(*)", asyncRoute(async (req, res) => {
    const homeResult = await serveHomepageFile(req, res, req.params.asset);
    if (homeResult === "served") return;
    if (homeResult === "unavailable") {
      res.status(503).type("text/plain").send("Configured homepage is unavailable.");
      return;
    }
    res.status(404).type("text/plain").send("Not found.");
  }));
}
