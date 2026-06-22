import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { registerAdminApi } from "./admin-api.js";
import { closeAllBrowserSessions } from "./mcp/tools/browser.js";
import { jsonRpcError } from "./http/json-rpc.js";
import { registerMcpRoutes } from "./http/mcp-routes.js";
import { registerOAuthRoutes } from "./http/oauth-routes.js";
import { registerContentRoutes } from "./http/content-routes.js";
import { assignUnownedClientsToUser, initializeOAuthState } from "./oauth.js";
import { initializeBlogStore } from "./blog/store.js";
import { initializeSiteState } from "./site/store.js";
import { initializeSkillState } from "./skills/state.js";
import { initializeTelemetry } from "./telemetry/store.js";
import { initializeJobStore } from "./jobs/store.js";
import { initializeShareStore } from "./share/store.js";
import { getUserByEmail, initializeUserStore } from "./user-store.js";

export const app = express();

// --- Store initialization. Ordered and awaited before any route is registered so the
// first request never races a half-initialized store. ---
initializeOAuthState(config.oauthConfig.statePath);
initializeSkillState(config.skillStatePath);
initializeSiteState(config.siteStatePath);
initializeTelemetry(config.telemetryRoot);
initializeJobStore(config.jobsRoot, config.jobRetentionDays);
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
const legacyUser = await getUserByEmail("legacy-user@local");
if (legacyUser) assignUnownedClientsToUser(legacyUser.id);

app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

// --- Route groups. Registration order matters in Express: the content catch-all
// (`/:asset(*)`) must be registered last, and the admin SPA fallback must precede it. ---
registerOAuthRoutes(app, config);
registerMcpRoutes(app, config);

registerAdminApi(app, {
  adminPasscode: config.adminPasscode,
  publicBaseUrl: config.publicBaseUrl,
  projectRoot: config.projectRoot,
  workspaceRoot: config.workspaceRoot,
  shareRoot: config.shareRoot,
  artifactRoot: config.artifactRoot,
  feedbackRoot: config.feedbackRoot
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
      const closed = await closeAllBrowserSessions();
      if (closed.length) console.log(`Closed ${closed.length} browser session(s).`);
    } catch (error) {
      console.error("Error while closing browser sessions:", error);
    }
    // Give the server a moment to drain, then exit.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
