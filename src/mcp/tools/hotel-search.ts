import { z } from "zod";
import type { Page } from "playwright";
import { assertSafePublicUrl } from "../../security/url.js";
import { installSsrfRouteGuard } from "../../security/playwright-guard.js";
import type { ToolModule } from "../types.js";

const agodaBaseUrl = "https://www.agoda.com/";
const navigationTimeoutMs = 45000;
const resultsTimeoutMs = 20000;
const suggestionTimeoutMs = 8000;

const hotelSearchInputSchema = z.object({
  destination: z.string().min(2).max(120),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkInDate must be YYYY-MM-DD"),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOutDate must be YYYY-MM-DD"),
  rooms: z.number().int().min(1).max(8).optional().default(1),
  adults: z.number().int().min(1).max(30).optional().default(2),
  children: z.number().int().min(0).max(20).optional().default(0),
  currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code").optional().default("USD"),
  maxResults: z.number().int().min(1).max(20).optional().default(10)
}).strict();

type HotelSearchInput = z.infer<typeof hotelSearchInputSchema>;

type HotelResult = {
  hotelId: string | null;
  name: string | null;
  starRating: number | null;
  reviewRating: string | null;
  reviewScore: number | null;
  reviewCount: number | null;
  area: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
};

type ResolvedDestination = { id: string; label: string };

function nightsBetween(checkIn: string, checkOut: string): number {
  const inDate = new Date(`${checkIn}T00:00:00Z`);
  const outDate = new Date(`${checkOut}T00:00:00Z`);
  return Math.round((outDate.getTime() - inDate.getTime()) / 86400000);
}

// Agoda has no stateless public search API: a bare GraphQL POST replay returns
// "Missing required headers" because the real query is bound to session cookies,
// an xsrf_token, and a signed x-gate-meta header minted by the page's own JS.
// Driving the actual search UI (like a browser would) sidesteps all of that.
async function dismissOverlays(page: Page): Promise<void> {
  const dismissSelectors = ["#onetrust-accept-btn-handler", 'button:has-text("Accept all")', 'button:has-text("I Accept")'];
  for (const selector of dismissSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1500 })) await el.click({ timeout: 1500 });
    } catch {
      // Best effort only: the consent banner is region-dependent and often absent.
    }
  }
}

async function resolveDestination(page: Page, destination: string): Promise<ResolvedDestination | null> {
  const input = page.locator('[data-selenium="textInput"]').first();
  await input.click({ timeout: navigationTimeoutMs });
  await input.fill("");
  await input.pressSequentially(destination, { delay: 25 });

  const normalizedQuery = destination.trim().toLowerCase();
  try {
    // The suggestion list renders once immediately with stale/default entries, then
    // re-renders after the debounced query resolves. A fixed sleep here is a race (it can
    // read the wrong destination back, or hang on a since-detached node for a "no match"
    // query); poll instead for an option whose value actually echoes the typed text.
    await page.waitForFunction((query) => {
      const options = Array.from(document.querySelectorAll('[data-testid="autosuggest-item"]'));
      return options.some((el) => {
        const value = (el.getAttribute("data-element-value") ?? "").toLowerCase();
        return value.length > 0 && (value.startsWith(query) || query.startsWith(value));
      });
    }, normalizedQuery, { timeout: suggestionTimeoutMs });
  } catch {
    return null;
  }

  // data-element-object-id is Agoda's resolved place id for the matched suggestion; reading
  // it directly avoids clicking the option and fighting the calendar/guest-picker widgets.
  const match = await page.evaluate((query) => {
    const options = Array.from(document.querySelectorAll('[data-testid="autosuggest-item"]'));
    const hit = options.find((el) => {
      const value = (el.getAttribute("data-element-value") ?? "").toLowerCase();
      return value.length > 0 && (value.startsWith(query) || query.startsWith(value));
    });
    if (!hit) return null;
    return { id: hit.getAttribute("data-element-object-id"), label: hit.getAttribute("data-element-suggestion-label") };
  }, normalizedQuery);

  if (!match || !match.id) return null;
  return { id: match.id, label: match.label ?? destination };
}

async function extractHotelCards(page: Page, maxResults: number): Promise<HotelResult[]> {
  // Inlined rather than via a shared helper: a named inner function here gets wrapped in an
  // esbuild `__name(...)` call under tsx's dev transpile, which throws ReferenceError once the
  // function body is serialized into the isolated browser context (no esbuild runtime there).
  const raw = await page.evaluate((limit) => {
    // Some cards (Agoda Homes / sponsored slots mixed into the same list) don't use this
    // markup and yield an all-null row; over-fetch and trim after filtering rather than
    // guessing a second selector for a variant this tool isn't scoped to support.
    const cards = Array.from(document.querySelectorAll('[data-selenium="hotel-item"]')).slice(0, limit * 2);
    return cards.map((card) => {
      const link = card.querySelector('a[href*="/hotel/"]');
      const nameText = card.querySelector('[data-selenium="hotel-name"]')?.textContent?.replace(/\s+/g, " ").trim() || null;
      const priceText = card.querySelector('[data-selenium="display-price"]')?.textContent?.replace(/\s+/g, " ").trim() || null;
      const currencyText = card.querySelector('[data-selenium="hotel-currency"]')?.textContent?.replace(/\s+/g, " ").trim() || null;
      const areaEl = card.querySelector('[data-selenium="area-city-text"]') ?? card.querySelector('[data-selenium="area-city"]');
      const areaText = areaEl?.textContent?.replace(/\s+/g, " ").trim() || null;
      // Star rating and review score have no data-selenium hooks; the accessible
      // aria-label strings ("3 stars out of 5", "Average rating Excellent 8.3 out
      // of 10 with 56,449 reviews") are stable, localization-safe extraction points.
      const cardText = card.textContent?.replace(/\s+/g, " ") ?? "";
      const starMatch = cardText.match(/(\d+)\s+stars?\s+out of\s+5/i);
      const reviewMatch = cardText.match(/Average rating (\w[\w\s]*?)\s+([\d.]+)\s+out of 10 with\s+([\d,]+)\s+reviews?/i);
      const href = link ? link.getAttribute("href") : null;
      return {
        hotelId: card.getAttribute("data-hotelid"),
        name: nameText,
        starRating: starMatch ? Number.parseInt(starMatch[1], 10) : null,
        reviewRating: reviewMatch ? reviewMatch[1] : null,
        reviewScore: reviewMatch ? Number.parseFloat(reviewMatch[2]) : null,
        reviewCount: reviewMatch ? Number.parseInt(reviewMatch[3].replace(/,/g, ""), 10) : null,
        area: areaText,
        price: priceText ? Number.parseFloat(priceText.replace(/[^\d.]/g, "")) : null,
        currency: currencyText,
        url: href ? new URL(href, location.origin).toString() : null
      };
    });
  }, maxResults);
  return raw.filter((hotel) => hotel.name !== null).slice(0, maxResults);
}

function buildSearchUrl(destinationId: string, input: HotelSearchInput): URL {
  const searchUrl = new URL("/search", agodaBaseUrl);
  searchUrl.searchParams.set("city", destinationId);
  searchUrl.searchParams.set("checkIn", input.checkInDate);
  searchUrl.searchParams.set("checkOut", input.checkOutDate);
  searchUrl.searchParams.set("rooms", String(input.rooms));
  searchUrl.searchParams.set("adults", String(input.adults));
  searchUrl.searchParams.set("children", String(input.children));
  searchUrl.searchParams.set("currency", input.currency.toUpperCase());
  return searchUrl;
}

export const hotelSearchTools: ToolModule[] = [
  {
    definition: {
      name: "agoda_search_hotels",
      description: "Search live hotel availability and pricing on Agoda for a destination and date range by driving a real headless browser session (Agoda's search backend has no stateless public API). Read-only: returns structured results and never books or pays for anything.",
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", minLength: 2, maxLength: 120, description: "Free-text destination, e.g. 'Da Nang' or 'Kuala Lumpur'." },
          checkInDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          checkOutDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          rooms: { type: "number", minimum: 1, maximum: 8 },
          adults: { type: "number", minimum: 1, maximum: 30 },
          children: { type: "number", minimum: 0, maximum: 20 },
          currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
          maxResults: { type: "number", minimum: 1, maximum: 20 }
        },
        required: ["destination", "checkInDate", "checkOutDate"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: hotelSearchInputSchema,
    async handler(rawInput) {
      const input = hotelSearchInputSchema.parse(rawInput ?? {}) as HotelSearchInput;
      const nights = nightsBetween(input.checkInDate, input.checkOutDate);
      if (nights < 1 || nights > 60) {
        return {
          ok: false,
          summary: "checkOutDate must be 1-60 nights after checkInDate.",
          artifacts: [],
          structuredContent: { checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, nights },
          logs: [],
          errors: ["Invalid date range."]
        };
      }

      const source = await assertSafePublicUrl(agodaBaseUrl);
      const { chromium } = await import("playwright");
      // headless: false is required here, not a stylistic choice: Agoda's Akamai-fronted
      // backend returns 502 on every graphql/search call from headless Chromium (verified
      // via a controlled same-machine/same-IP A/B test — only the headless flag differed).
      // The runtime container runs this under xvfb-run so a real display is always present.
      const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await installSsrfRouteGuard(page, false);

        await page.goto(source.toString(), { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
        await dismissOverlays(page);

        const destination = await resolveDestination(page, input.destination);
        if (!destination) {
          return {
            ok: false,
            summary: `No Agoda destination match found for "${input.destination}".`,
            artifacts: [],
            structuredContent: { destination: input.destination },
            logs: [],
            errors: ["Destination not resolved."]
          };
        }

        const searchUrl = buildSearchUrl(destination.id, input);
        await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });

        try {
          await page.locator('[data-selenium="hotel-item"]').first().waitFor({ state: "visible", timeout: resultsTimeoutMs });
          await page.locator('[data-selenium="display-price"]').first().waitFor({ state: "visible", timeout: resultsTimeoutMs });
        } catch {
          return {
            ok: false,
            summary: `Agoda returned no hotel results for "${destination.label}" on ${input.checkInDate}-${input.checkOutDate}.`,
            artifacts: [],
            structuredContent: { destination: destination.label, searchUrl: searchUrl.toString() },
            logs: [],
            errors: ["No results rendered."]
          };
        }

        const hotels = await extractHotelCards(page, input.maxResults);
        const structuredContent = {
          destination: destination.label,
          destinationId: destination.id,
          checkInDate: input.checkInDate,
          checkOutDate: input.checkOutDate,
          nights,
          rooms: input.rooms,
          adults: input.adults,
          children: input.children,
          currency: input.currency.toUpperCase(),
          searchUrl: searchUrl.toString(),
          hotelCount: hotels.length,
          hotels
        };
        return {
          ok: true,
          summary: `Found ${hotels.length} hotel${hotels.length === 1 ? "" : "s"} in ${destination.label} for ${input.checkInDate} to ${input.checkOutDate}.`,
          artifacts: [],
          structuredContent,
          logs: [JSON.stringify(structuredContent, null, 2)],
          errors: []
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agoda hotel search failed.";
        return {
          ok: false,
          summary: `Agoda hotel search failed: ${message}`,
          artifacts: [],
          structuredContent: { destination: input.destination, error: message },
          logs: [],
          errors: [message]
        };
      } finally {
        await browser.close();
      }
    }
  }
];
