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
  siteStatePath: string;
  blogStatePath: string;
  commandTimeoutMs: number;
  devToken?: string;
  adminPasscode: string;
  oauthConfig: OAuthConfig;
  adminDistPath: string;
}

function resolveConfig(): ServerConfig {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://gmb01.xyz";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  return {
    port: Number.parseInt(process.env.PORT ?? "6859", 10),
    host: process.env.HOST ?? "127.0.0.1",
    publicBaseUrl,
    workspaceRoot,
    shareRoot: process.env.SHARE_ROOT ?? `${workspaceRoot}/.shares`,
    artifactRoot: process.env.ARTIFACT_ROOT ?? `${workspaceRoot}/.artifacts`,
    feedbackRoot: process.env.FEEDBACK_ROOT ?? `${workspaceRoot}/.feedback`,
    telemetryRoot: process.env.TELEMETRY_ROOT ?? `${workspaceRoot}/.telemetry`,
    jobsRoot: process.env.JOBS_ROOT ?? `${workspaceRoot}/.jobs`,
    jobRetentionDays: Number.parseInt(process.env.JOB_RETENTION_DAYS ?? "7", 10) || 7,
    projectRoot: process.env.PROJECT_ROOT ?? `${workspaceRoot}/.projects`,
    usersRoot: process.env.USERS_ROOT ?? `${workspaceRoot}/.users`,
    userStatePath: process.env.USER_STATE_PATH ?? `${workspaceRoot}/.state/users-state.json`,
    skillStatePath: process.env.SKILL_STATE_PATH ?? `${workspaceRoot}/.state/skill-state.json`,
    siteStatePath: process.env.SITE_STATE_PATH ?? `${workspaceRoot}/.state/site-state.json`,
    blogStatePath: process.env.BLOG_STATE_PATH ?? `${workspaceRoot}/.state/blog-state.json`,
    commandTimeoutMs: Number.parseInt(process.env.COMMAND_TIMEOUT_MS ?? "30000", 10),
    devToken: process.env.MCP_DEV_TOKEN,
    adminPasscode: process.env.ADMIN_PASSCODE ?? process.env.KB_MCP_OAUTH_PASSCODE ?? "",
    oauthConfig: {
      issuer: process.env.KB_MCP_OAUTH_ISSUER ?? publicBaseUrl,
      ownerPasscode: process.env.KB_MCP_OAUTH_PASSCODE ?? "",
      accessTokenTtlSeconds: Number.parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? "3600", 10),
      authCodeTtlSeconds: Number.parseInt(process.env.OAUTH_AUTH_CODE_TTL_SECONDS ?? "300", 10),
      statePath: process.env.OAUTH_STATE_PATH ?? `${workspaceRoot}/.state/oauth-state.json`
    },
    adminDistPath: process.env.ADMIN_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-ui/dist")
  };
}

export const config: ServerConfig = resolveConfig();
