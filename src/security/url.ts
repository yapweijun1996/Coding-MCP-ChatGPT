import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SafeUrlOptions = {
  protocols?: string[];
  allowPrivateNetwork?: boolean;
};

export function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

export function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4[1]);
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized.startsWith("::ffff:");
}

export function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * fetch() that re-validates the target on every redirect hop. Plain fetch follows
 * 30x responses without re-checking, so an allowed entry URL can redirect into a
 * private/reserved address (SSRF). This validates the entry URL and each Location
 * with assertSafePublicUrl before following it. (DNS rebinding between validation
 * and connection is a separate concern requiring a pinned-IP agent / egress proxy.)
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, options: SafeUrlOptions = {}): Promise<Response> {
  const maxRedirects = 5;
  let current = await assertSafePublicUrl(input, options);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current.toString(), { ...init, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    current = await assertSafePublicUrl(new URL(location, current), options);
  }
  throw new Error("Too many redirects.");
}

export async function assertSafePublicUrl(input: string | URL, options: SafeUrlOptions = {}): Promise<URL> {
  const url = input instanceof URL ? input : new URL(input);
  const protocols = options.protocols ?? ["https:"];
  if (!protocols.includes(url.protocol)) {
    throw new Error(`Only ${protocols.map((protocol) => protocol.replace(":", "://")).join(" or ")} URLs are allowed.`);
  }

  if (options.allowPrivateNetwork) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not allowed.");
  }

  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) throw new Error("Private or reserved IP URLs are not allowed.");
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((record) => isBlockedIpAddress(record.address))) {
    throw new Error("URL resolves to a private or reserved IP address.");
  }

  return url;
}
