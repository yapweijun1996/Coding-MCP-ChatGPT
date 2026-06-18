import { isIP } from "node:net";
import { assertSafePublicUrl, isBlockedIpAddress } from "./url.js";
import type { Page } from "playwright";

const HTTP_PROTOCOLS = ["http:", "https:"];

function isLiteralBlockedHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isIP(h) !== 0 && isBlockedIpAddress(h);
}

/**
 * Install a per-request SSRF guard on a Playwright page. Entry-URL validation alone
 * does not stop a page from redirecting (or loading a subresource) into an internal
 * address after the first hop. This aborts any such request:
 *  - navigations get the full DNS-backed assertSafePublicUrl check (catches
 *    redirects to internal hostnames as well as literal IPs);
 *  - subresources get a cheap literal-IP / localhost check.
 *
 * Pass allowPrivateNetwork=true for tools that legitimately target localhost
 * (e.g. inspecting a freshly spawned local dev server).
 */
export async function installSsrfRouteGuard(page: Page, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  await page.route("**/*", async (route) => {
    const request = route.request();
    try {
      if (request.isNavigationRequest()) {
        await assertSafePublicUrl(request.url(), { protocols: HTTP_PROTOCOLS });
      } else if (isLiteralBlockedHost(new URL(request.url()).hostname)) {
        await route.abort("addressunreachable");
        return;
      }
      await route.continue();
    } catch {
      await route.abort("addressunreachable");
    }
  });
}
