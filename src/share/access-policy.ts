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
    // Published share URLs are STABLE but their content is MUTABLE — re-publishing overwrites a file
    // in place at the same path. The previous `max-age=300, stale-while-revalidate=86400` let browsers
    // serve the old bytes for up to 5 min outright, and stale for up to 24h while revalidating in the
    // background — so a viewer could hear/see a superseded version long after the author re-published.
    // `no-cache` keeps the response cacheable but forces revalidation on every use; Express's automatic
    // ETag/Last-Modified make that a cheap 304 when the file is unchanged, and a fresh 200 once it changes.
    res.setHeader("Cache-Control", "public, no-cache");
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Cookie");
}
