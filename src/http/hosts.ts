import type express from "express";

export function configuredHost(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

export function requestHost(req: express.Request): string {
  return (req.get("host") ?? "").toLowerCase();
}

export function sameConfiguredHost(req: express.Request, baseUrl: string): boolean {
  const host = configuredHost(baseUrl);
  return Boolean(host && requestHost(req) === host);
}

export function configuredHostsAreSeparate(publicBaseUrl: string, contentBaseUrl: string): boolean {
  const publicHost = configuredHost(publicBaseUrl);
  const contentHost = configuredHost(contentBaseUrl);
  return Boolean(publicHost && contentHost && publicHost !== contentHost);
}

export function contentUrl(config: { contentBaseUrl: string }, pathAndQuery: string): string {
  return `${config.contentBaseUrl.replace(/\/$/, "")}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}
