import type express from "express";
import type { ProjectShareAccess } from "../projects/store.js";
import { getSession as getUserSession } from "../user-store.js";

const sessionCookieName = "coding_mcp_session";

type ShareAccess = ProjectShareAccess | undefined;

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

export async function canViewPublishedProjectShare(input: {
  cookieHeader?: string;
  projectRoot: string;
  shareAccess: ShareAccess;
}): Promise<boolean> {
  if ((input.shareAccess ?? "private") === "anyone_with_link") return true;
  const sessionId = parseCookies(input.cookieHeader)[sessionCookieName];
  const session = await getUserSession(sessionId);
  if (!session || session.user.status !== "active") return false;
  if (session.user.role === "admin") return true;
  return session.user.projectRoot === input.projectRoot;
}

export async function canViewLegacyShare(input: {
  cookieHeader?: string;
  shareAccess: ShareAccess;
  ownerUserId?: string;
}): Promise<boolean> {
  if ((input.shareAccess ?? "private") === "anyone_with_link") return true;
  const sessionId = parseCookies(input.cookieHeader)[sessionCookieName];
  const session = await getUserSession(sessionId);
  if (!session || session.user.status !== "active") return false;
  if (session.user.role === "admin") return true;
  return input.ownerUserId ? session.user.id === input.ownerUserId : false;
}

export function setShareCacheHeaders(res: express.Response, shareAccess: ShareAccess, isPublicRoute: boolean): void {
  if (isPublicRoute || (shareAccess ?? "private") === "anyone_with_link") {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie");
}
