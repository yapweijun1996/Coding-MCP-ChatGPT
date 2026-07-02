import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthConfig } from "./oauth.js";

// Centralized server configuration resolved from environment variables. Pure: no side
// effects, no I/O, no store initialization — server.ts owns the ordered bootstrap. Route
// modules receive this object (mirroring the registerAdminApi(app, config) convention) so
// handlers no longer close over a wall of module-level constants in server.ts.
export interface ServerConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  contentBaseUrl: string;
  workspaceRoot: string;
  shareRoot: string;
  artifactRoot: string;
  feedbackRoot: string;
  telemetryRoot: string;
  jobsRoot: string;
  jobRetentionDays: number;
  projectRoot: string;
  usersRoot: string;
  userStatePath: string;
  skillStatePath: string;
  toolStatePath: string;
  siteStatePath: string;
  blogStatePath: string;
  commandTimeoutMs: number;
  mcpRateLimit: McpRateLimitConfig;
  devToken?: string;
  configWarnings: string[];
  adminPasscode: string;
  oauthConfig: OAuthConfig;
  adminDistPath: string;
}

export interface McpRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface DevTokenResolution {
  token?: string;
  warnings: string[];
}

// Pure: decides whether the static MCP_DEV_TOKEN OAuth bypass is allowed, and why not.
// The bypass grants full MCP access with no per-user isolation, so it is only honored for a
// strong secret (>=32 chars) AND outside production unless explicitly force-enabled. Anything
// rejected returns no token plus an actionable warning that server.ts logs at startup.
export function resolveDevToken(raw: string | undefined, nodeEnv: string | undefined, allowInProd: boolean): DevTokenResolution {
  const value = raw?.trim();
  if (!value) return { warnings: [] };
  const isProd = nodeEnv === "production";
  if (value.length < 32) {
    return { warnings: ["MCP_DEV_TOKEN is set but shorter than 32 characters; the OAuth bypass is DISABLED. Use a 32+ character random secret to enable it."] };
  }
  if (isProd && !allowInProd) {
    return { warnings: ["MCP_DEV_TOKEN is set but NODE_ENV=production; the OAuth bypass is DISABLED. Set MCP_DEV_TOKEN_ALLOW_PROD=true to force-enable it (NOT recommended)."] };
  }
  const warning = isProd
    ? "SECURITY: MCP_DEV_TOKEN OAuth bypass is ENABLED in production via MCP_DEV_TOKEN_ALLOW_PROD. Any holder of this token has full MCP access as the legacy user."
    : "MCP_DEV_TOKEN OAuth bypass is enabled (non-production). Do not ship this token to production.";
  return { token: value, warnings: [warning] };
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveConfig(): ServerConfig {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://gmb01.xyz";
  const contentBaseUrl = process.env.CONTENT_BASE_URL ?? publicBaseUrl;
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const devTokenResolution = resolveDevToken(process.env.MCP_DEV_TOKEN, process.env.NODE_ENV, process.env.MCP_DEV_TOKEN_ALLOW_PROD === "true");
  return {
    port: Number.parseInt(process.env.PORT ?? "6859", 10),
    host: process.env.HOST ?? "127.0.0.1",
    publicBaseUrl,
    contentBaseUrl,
    workspaceRoot,
    shareRoot: process.env.SHARE_ROOT ?? `${workspaceRoot}/.shares`,
    artifactRoot: process.env.ARTIFACT_ROOT ?? `${workspaceRoot}/.artifacts`,
    feedbackRoot: process.env.FEEDBACK_ROOT ?? `${workspaceRoot}/.feedback`,
    telemetryRoot: process.env.TELEMETRY_ROOT ?? `${workspaceRoot}/.telemetry`,
    jobsRoot: process.env.JOBS_ROOT ?? `${workspaceRoot}/.jobs`,
    jobRetentionDays: ((value) => (Number.isFinite(value) ? value : 7))(Number.parseInt(process.env.JOB_RETENTION_DAYS ?? "7", 10)),
    projectRoot: process.env.PROJECT_ROOT ?? `${workspaceRoot}/.projects`,
    usersRoot: process.env.USERS_ROOT ?? `${workspaceRoot}/.users`,
    userStatePath: process.env.USER_STATE_PATH ?? `${workspaceRoot}/.state/users-state.json`,
    skillStatePath: process.env.SKILL_STATE_PATH ?? `${workspaceRoot}/.state/skill-state.json`,
    toolStatePath: process.env.TOOL_STATE_PATH ?? `${workspaceRoot}/.state/tool-state.json`,
    siteStatePath: process.env.SITE_STATE_PATH ?? `${workspaceRoot}/.state/site-state.json`,
    blogStatePath: process.env.BLOG_STATE_PATH ?? `${workspaceRoot}/.state/blog-state.json`,
    commandTimeoutMs: Number.parseInt(process.env.COMMAND_TIMEOUT_MS ?? "30000", 10),
    mcpRateLimit: {
      windowMs: parsePositiveInteger(process.env.MCP_RATE_LIMIT_WINDOW_MS, 60_000),
      maxRequests: parsePositiveInteger(process.env.MCP_RATE_LIMIT_MAX_REQUESTS, 100)
    },
    devToken: devTokenResolution.token,
    configWarnings: devTokenResolution.warnings,
    adminPasscode: process.env.ADMIN_PASSCODE ?? process.env.KB_MCP_OAUTH_PASSCODE ?? "",
    oauthConfig: {
      issuer: process.env.KB_MCP_OAUTH_ISSUER ?? publicBaseUrl,
      ownerPasscode: process.env.KB_MCP_OAUTH_PASSCODE ?? "",
      accessTokenTtlSeconds: Number.parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? "3600", 10),
      authCodeTtlSeconds: Number.parseInt(process.env.OAUTH_AUTH_CODE_TTL_SECONDS ?? "300", 10),
      refreshTokenTtlSeconds: Number.parseInt(process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS ?? "2592000", 10),
      statePath: process.env.OAUTH_STATE_PATH ?? `${workspaceRoot}/.state/oauth-state.json`
    },
    adminDistPath: process.env.ADMIN_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-ui/dist")
  };
}

export const config: ServerConfig = resolveConfig();
