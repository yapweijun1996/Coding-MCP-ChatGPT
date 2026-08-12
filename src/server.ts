import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { registerAdminApi } from "./admin-api.js";
import { jsonRpcError } from "./http/json-rpc.js";
import { registerMcpRoutes } from "./http/mcp-routes.js";
import { registerOAuthRoutes } from "./http/oauth-routes.js";
import { registerContentRoutes } from "./http/content-routes.js";
import { configuredHost } from "./http/hosts.js";
import { assignUnownedClientsToUser, initializeOAuthState } from "./oauth.js";
import { initializeBlogStore } from "./blog/store.js";
import { initializeSiteState } from "./site/store.js";
import { initializeSkillState } from "./skills/state.js";
import { initializeTelemetry } from "./telemetry/store.js";
import { initializeToolState } from "./tool-state.js";
import { initializeJobStore } from "./jobs/store.js";
import { pruneJobCache, replaceJobsFromPersistentStore } from "./jobs/store.js";
import { closeJobDatabase, initializeJobDatabase, isJobDatabaseEnabled, listPersistedJobChanges, listRecentPersistedJobs, prunePersistedJobs } from "./jobs/database.js";
import { initializeShareStore } from "./share/store.js";
import { configureStoragePolicy, configureStorageRootProvider } from "./storage/manager.js";
import { startStorageMonitor } from "./storage/monitor.js";
import { collectStorageScopes } from "./storage/scopes.js";
import { getUserByEmail, initializeUserStore } from "./user-store.js";

export const app = express();

const storagePolicy = config.storagePolicy ?? {
  projectQuotaBytes: 0,
  userQuotaBytes: 0,
  globalQuotaBytes: 0,
  warningThreshold: 0.8,
  deletedProjectRetentionDays: 7,
  monitorIntervalMs: 0
};
configureStoragePolicy(storagePolicy);

// Surface configuration warnings (e.g. a disabled or production-enabled dev-token bypass)
// loudly at startup so a misconfigured deployment is visible in the logs.
for (const warning of config.configWarnings) console.warn(`[config] ${warning}`);

// --- Store initialization. Ordered and awaited before any route is registered so the
// first request never races a half-initialized store. ---
initializeOAuthState(config.oauthConfig.statePath);
initializeSkillState(config.skillStatePath);
initializeToolState(config.toolStatePath);
initializeSiteState(config.siteStatePath);
initializeTelemetry(config.telemetryRoot);
initializeJobStore("");
await initializeShareStore(config.shareRoot);
await initializeBlogStore({ databaseUrl: process.env.DATABASE_URL, statePath: config.blogStatePath });
await initializeUserStore({
  databaseUrl: process.env.DATABASE_URL,
  statePath: config.userStatePath,
  projectRoot: config.projectRoot,
  usersRoot: config.usersRoot,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  fallbackAdminPasscode: config.adminPasscode,
  sessionTtlMs: 8 * 60 * 60 * 1000
});
// The HTTP process keeps a read cache for cheap status endpoints while the separate worker
// claims and executes durable jobs from Postgres. If Postgres is not configured, the existing
// file-backed in-process queue remains the local-development fallback.
if (await initializeJobDatabase(process.env.DATABASE_URL)) {
  const initialJobs = await listRecentPersistedJobs();
  let jobsCursor = initialJobs.cursor;
  let jobsRefreshInFlight: Promise<void> | undefined;
  replaceJobsFromPersistentStore(initialJobs.jobs);
  const refreshJobs = async () => {
    for (let page = 0; page < 5; page += 1) {
      const changes = await listPersistedJobChanges(jobsCursor);
      if (!changes.jobs.length) break;
      replaceJobsFromPersistentStore(changes.jobs);
      jobsCursor = changes.cursor;
      if (changes.jobs.length < 1000) break;
    }
    pruneJobCache();
  };
  const scheduleJobRefresh = () => {
    if (jobsRefreshInFlight) return;
    jobsRefreshInFlight = refreshJobs()
      .catch((error) => console.error("Job queue refresh failed:", error))
      .finally(() => { jobsRefreshInFlight = undefined; });
  };
  setInterval(scheduleJobRefresh, 1000).unref();
  setInterval(() => void prunePersistedJobs(config.jobRetentionDays).catch((error) => console.error("Job queue retention failed:", error)), 60 * 60 * 1000).unref();
  void prunePersistedJobs(config.jobRetentionDays).catch((error) => console.error("Job queue retention failed:", error));
  if (isJobDatabaseEnabled()) console.log("Postgres job queue enabled.");
} else {
  initializeJobStore(config.jobsRoot, config.jobRetentionDays);
}
const legacyUser = await getUserByEmail("legacy-user@local");
if (legacyUser) assignUnownedClientsToUser(legacyUser.id);

configureStorageRootProvider(async () => {
  const scopes = await collectStorageScopes({ projectRoot: config.projectRoot, workspaceRoot: config.workspaceRoot });
  return [
    ...scopes.flatMap((scope) => [scope.projectRoot, scope.workspaceRoot]),
    config.artifactRoot,
    config.shareRoot,
    config.telemetryRoot
  ];
});

const storageMonitor = startStorageMonitor({
  policy: storagePolicy,
  collectScopes: () => collectStorageScopes({ projectRoot: config.projectRoot, workspaceRoot: config.workspaceRoot }),
  roots: { artifactRoot: config.artifactRoot, shareRoot: config.shareRoot, telemetryRoot: config.telemetryRoot }
});

// Native ChatGPT file promotion carries a short JSON file reference and downloads the
// binary server-side. Keep the legacy Base64 JSON ceiling explicit; it is not the native
// file-transfer path and should not be increased to accommodate large images.
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

const publicHost = configuredHost(config.publicBaseUrl);
const contentHost = configuredHost(config.contentBaseUrl);
const hasSeparateContentHost = Boolean(publicHost && contentHost && publicHost !== contentHost);
const appOnlyPath = /^\/(?:admin|mcp|authorize|oauth\/approve|token|register|revoke|\.well-known|blog|health|outcome)(?:\/|$)/;

app.use((req, res, next) => {
  if (hasSeparateContentHost && req.get("host")?.toLowerCase() === contentHost && appOnlyPath.test(req.path)) {
    res.status(404).type("text/plain").send("Not found.");
    return;
  }
  next();
});

// --- Route groups. Registration order matters in Express: the content catch-all
// (`/:asset(*)`) must be registered last, and the admin SPA fallback must precede it. ---
registerOAuthRoutes(app, config);
registerMcpRoutes(app, config);

registerAdminApi(app, {
  adminPasscode: config.adminPasscode,
  publicBaseUrl: config.publicBaseUrl,
  contentBaseUrl: config.contentBaseUrl,
  projectRoot: config.projectRoot,
  workspaceRoot: config.workspaceRoot,
  shareRoot: config.shareRoot,
  artifactRoot: config.artifactRoot,
  feedbackRoot: config.feedbackRoot,
  telemetryRoot: config.telemetryRoot,
  storagePolicy
});

app.use("/admin/assets", express.static(path.join(config.adminDistPath, "assets"), {
  immutable: true,
  maxAge: "1y"
}));

app.get(/^\/admin(?:\/.*)?$/, (req, res, next) => {
  if (req.path.startsWith("/admin/api")) {
    next();
    return;
  }
  res.sendFile(path.join(config.adminDistPath, "index.html"), (error) => {
    if (error && !res.headersSent) {
      res.status(503).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin UI unavailable</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f6f8;color:#18231f;margin:0}main{width:min(520px,calc(100vw - 32px));margin:72px auto;background:#fff;border:1px solid #dce3df;border-radius:8px;padding:24px}code{background:#eef3f0;padding:2px 5px;border-radius:4px}</style></head><body><main><h1>Admin UI is not built</h1><p>Run <code>npm run build:admin</code> or <code>npm run build</code>, then restart the server.</p></main></body></html>`);
    }
  });
});

// Browsers auto-request /favicon.ico on every page (including sandboxed content pages served
// from an opaque origin). Without this it falls through to the content catch-all and 404s,
// spamming the console. Serve one inline SVG glyph for the whole deployment, cached hard.
const faviconSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#18231f"/>' +
  '<path d="M8 11l5 5-5 5" fill="none" stroke="#5ad19a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<line x1="16" y1="22" x2="23" y2="22" stroke="#5ad19a" stroke-width="2.6" stroke-linecap="round"/>' +
  "</svg>";
app.get("/favicon.ico", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.send(faviconSvg);
});

registerContentRoutes(app, config);

// Terminal error middleware. Registered last so it catches anything forwarded by
// asyncRoute (or thrown synchronously) instead of letting the request hang.
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`Request failed: ${req.method} ${req.originalUrl}`, error);
  if (res.headersSent) return;
  if (req.path === "/mcp") {
    res.status(500).json(jsonRpcError(null, -32603, "Internal server error."));
    return;
  }
  res.status(500).type("text/plain").send("Internal server error.");
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Last-resort guards. An unhandled rejection is usually a missed catch in one
  // request — log it and keep serving. An uncaught exception leaves process state
  // undefined (half-mutated stores, leaked handles), so log and exit; PM2
  // (autorestart: true in ecosystem.config.cjs) brings a clean process back.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception, exiting for a clean restart:", error);
    process.exit(1);
  });

  const server = app.listen(config.port, config.host, () => {
    console.log(`coding-mcp-chatgpt listening on http://${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => console.log("HTTP server closed."));
    try {
      storageMonitor.stop();
      const { closeAllBrowserSessions } = await import("./mcp/tools/browser.js");
      const closed = await closeAllBrowserSessions();
      if (closed.length) console.log(`Closed ${closed.length} browser session(s).`);
      await closeJobDatabase();
    } catch (error) {
      console.error("Error while closing browser sessions:", error);
    }
    // Give the server a moment to drain, then exit.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
