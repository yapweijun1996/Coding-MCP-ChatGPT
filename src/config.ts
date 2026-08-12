import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthConfig } from "./oauth.js";
import { resolveStoragePolicy, type StoragePolicy } from "./storage/manager.js";

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
  storagePolicy?: StoragePolicy;
  conversationFileMaxBytes: number;
  fileTransferTimeoutMs: number;
  jobQueue: JobQueueConfig;
}

export interface McpRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface JobQueueConfig {
  pollMs: number;
  leaseMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
  workerConcurrency: number;
  browserConcurrency: number;
  buildConcurrency: number;
  audioConcurrency: number;
  maxConcurrentPerUser: number;
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

function parseByteLimit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/.exec(value);
  if (!match) return fallback;
  const amount = Number.parseFloat(match[1]!);
  const multiplier = match[2] === "g" || match[2] === "gb" || match[2] === "gib"
    ? 1024 ** 3
    : match[2] === "m" || match[2] === "mb" || match[2] === "mib"
      ? 1024 ** 2
      : match[2] === "k" || match[2] === "kb" || match[2] === "kib"
        ? 1024
        : 1;
  const parsed = Math.round(amount * multiplier);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    adminDistPath: process.env.ADMIN_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-ui/dist"),
    storagePolicy: resolveStoragePolicy(),
    conversationFileMaxBytes: parseByteLimit(process.env.CONVERSATION_FILE_MAX_BYTES, 100 * 1024 * 1024),
    fileTransferTimeoutMs: parsePositiveInteger(process.env.FILE_TRANSFER_TIMEOUT_MS, 5 * 60 * 1000),
    jobQueue: {
      pollMs: parsePositiveInteger(process.env.JOB_WORKER_POLL_MS, 250),
      leaseMs: parsePositiveInteger(process.env.JOB_LEASE_MS, 30_000),
      heartbeatMs: parsePositiveInteger(process.env.JOB_HEARTBEAT_MS, 2_000),
      shutdownGraceMs: parsePositiveInteger(process.env.JOB_SHUTDOWN_GRACE_MS, 30_000),
      workerConcurrency: parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 5),
      browserConcurrency: parsePositiveInteger(process.env.JOB_BROWSER_CONCURRENCY, 2),
      buildConcurrency: parsePositiveInteger(process.env.JOB_BUILD_CONCURRENCY, 2),
      audioConcurrency: parsePositiveInteger(process.env.JOB_AUDIO_CONCURRENCY, 1),
      maxConcurrentPerUser: parsePositiveInteger(process.env.JOB_MAX_CONCURRENT_PER_USER, 2)
    }
  };
}

export const config: ServerConfig = resolveConfig();
