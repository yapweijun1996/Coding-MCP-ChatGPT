import { z } from "zod";
import { safeFetch } from "../../security/url.js";
import type { ToolModule } from "../types.js";

const flightsEndpoint = "https://www.agoda.com/api/flights-bff/search/v1/flights";
const maxPollingAttempts = 5;
const requestTimeoutMs = 20000;

const flightSearchInputSchema = z.object({
  origin: z.string().regex(/^[A-Za-z]{3}$/, "origin must be a 3-letter IATA airport code"),
  destination: z.string().regex(/^[A-Za-z]{3}$/, "destination must be a 3-letter IATA airport code"),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "departureDate must be YYYY-MM-DD"),
  adults: z.number().int().min(1).max(9).optional().default(1),
  children: z.number().int().min(0).max(8).optional().default(0),
  infants: z.number().int().min(0).max(8).optional().default(0),
  cabinClass: z.enum(["Economy", "PremiumEconomy", "Business", "First"]).optional().default("Economy"),
  sortBy: z.enum(["Best", "Price", "Duration"]).optional().default("Best"),
  maxResults: z.number().int().min(1).max(20).optional().default(10)
}).strict();

type FlightSearchInput = z.infer<typeof flightSearchInputSchema>;

type FlightSegment = {
  airline: string | null;
  flightNumber: string | null;
  cabinClass: string | null;
  departureAirport: string | null;
  departureTime: string | null;
  arrivalAirport: string | null;
  arrivalTime: string | null;
  duration: string | null;
};

type FlightResult = {
  bundleRefId: string | null;
  price: number | null;
  currency: string | null;
  totalDuration: string | null;
  stops: number;
  segments: FlightSegment[];
  bookingUrl: string | null;
};

type PollingState = { count: number; token: string };

// Unlike Agoda's hotel search (session-bound GraphQL behind Akamai bot mitigation, see
// hotel-search.ts), this flights endpoint is a genuinely stateless public API: no cookies,
// no xsrf token, works with zero custom headers. Confirmed empirically (curl with only a
// Content-Type header returns real itineraries). Round-trip search returns only the
// outbound leg per item (Agoda's client likely fetches the return leg in a second,
// bundle-scoped call) so this tool is scoped to one-way search only.
function buildRequestBody(input: FlightSearchInput, polling: PollingState | { count: number }) {
  const slice = {
    origin: [{ code: input.origin.toUpperCase(), type: "Airport" }],
    destination: [{ code: input.destination.toUpperCase(), type: "Airport" }],
    departureDate: input.departureDate,
    sliceFilter: { cabinClasses: [], carrier: { exclude: [], preferred: [] } }
  };
  return {
    pagination: { page: 1 },
    polling,
    searchCriteria: {
      passengers: { adult: input.adults, child: input.children, infant: input.infants },
      trip: {
        outboundSlice: slice,
        slices: [slice],
        itineraryFilter: { hackerFareEnabled: true, cabinClass: input.cabinClass },
        sort: { sortBy: input.sortBy },
        preferredBundleIds: []
      },
      // Left blank rather than reusing Agoda's own web client's aid: this is a generic
      // no-affiliation search, not an attempt to route traffic through any specific account.
      whitelabelContext: { programId: "", aid: "" }
    }
  };
}

async function fetchOnce(input: FlightSearchInput, polling: PollingState | { count: number }): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await safeFetch(flightsEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildRequestBody(input, polling))
    });
    if (!response.ok) throw new Error(`Agoda flights search returned HTTP ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithPolling(input: FlightSearchInput): Promise<{ items: unknown[]; completed: boolean }> {
  let polling: PollingState | { count: number } = { count: 1 };
  for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
    const json = (await fetchOnce(input, polling)) as {
      data?: {
        polling?: { completed?: boolean; count?: number; delayMs?: number };
        response?: { content?: { items?: unknown[]; pollingToken?: string } };
      };
    };
    const data = json.data;
    const items = data?.response?.content?.items ?? [];
    const completed = Boolean(data?.polling?.completed);
    if (completed || items.length > 0) return { items, completed };
    const token = data?.response?.content?.pollingToken;
    if (!token) return { items, completed: false };
    polling = { count: (data?.polling?.count ?? attempt + 1) + 1, token };
    const delayMs = Math.min(Math.max(data?.polling?.delayMs ?? 1500, 500), 3000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { items: [], completed: false };
}

function extractFlights(items: unknown[], maxResults: number): FlightResult[] {
  return items.slice(0, maxResults).map((raw) => {
    const item = raw as {
      bundleRefId?: string;
      totalPrice?: { priceAfterDiscount?: { amount?: string; currencySymbol?: string } };
      slice?: {
        duration?: string;
        segments?: Array<{
          airline?: { name?: string };
          flightNumber?: string;
          cabinClass?: string;
          departure?: { airport?: { code?: string }; rawDate?: string };
          arrival?: { airport?: { code?: string }; rawDate?: string };
          duration?: string;
        }>;
      };
      url?: string;
    };
    const segments: FlightSegment[] = (item.slice?.segments ?? []).map((seg) => ({
      airline: seg.airline?.name ?? null,
      flightNumber: seg.flightNumber ?? null,
      cabinClass: seg.cabinClass ?? null,
      departureAirport: seg.departure?.airport?.code ?? null,
      departureTime: seg.departure?.rawDate ?? null,
      arrivalAirport: seg.arrival?.airport?.code ?? null,
      arrivalTime: seg.arrival?.rawDate ?? null,
      duration: seg.duration ?? null
    }));
    const amountText = item.totalPrice?.priceAfterDiscount?.amount;
    return {
      bundleRefId: item.bundleRefId ?? null,
      price: amountText ? Number.parseFloat(amountText.replace(/,/g, "")) : null,
      currency: item.totalPrice?.priceAfterDiscount?.currencySymbol ?? null,
      totalDuration: item.slice?.duration ?? null,
      stops: Math.max(0, segments.length - 1),
      segments,
      bookingUrl: item.url ?? null
    };
  });
}

export const flightSearchTools: ToolModule[] = [
  {
    definition: {
      name: "agoda_search_flights",
      description: "Search live one-way flight availability and pricing on Agoda via its public flights search API (stateless, no session/cookies required, unlike agoda_search_hotels). Read-only: returns structured itineraries and never books or pays for anything. Round-trip search is not supported in this version; run it twice (outbound leg, then return leg) for a round trip. Currency is server-determined and cannot be requested by the caller.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "string", pattern: "^[A-Za-z]{3}$", description: "3-letter IATA airport code, e.g. 'SIN'." },
          destination: { type: "string", pattern: "^[A-Za-z]{3}$", description: "3-letter IATA airport code, e.g. 'HND'." },
          departureDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          adults: { type: "number", minimum: 1, maximum: 9 },
          children: { type: "number", minimum: 0, maximum: 8 },
          infants: { type: "number", minimum: 0, maximum: 8 },
          cabinClass: { type: "string", enum: ["Economy", "PremiumEconomy", "Business", "First"] },
          sortBy: { type: "string", enum: ["Best", "Price", "Duration"] },
          maxResults: { type: "number", minimum: 1, maximum: 20 }
        },
        required: ["origin", "destination", "departureDate"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: flightSearchInputSchema,
    async handler(rawInput) {
      const input = flightSearchInputSchema.parse(rawInput ?? {}) as FlightSearchInput;
      const origin = input.origin.toUpperCase();
      const destination = input.destination.toUpperCase();
      try {
        const { items, completed } = await searchWithPolling(input);
        const flights = extractFlights(items, input.maxResults);
        if (flights.length === 0) {
          return {
            ok: false,
            summary: `No flights found for ${origin} -> ${destination} on ${input.departureDate}.`,
            artifacts: [],
            structuredContent: { origin, destination, departureDate: input.departureDate, completed },
            logs: [],
            errors: ["No results."]
          };
        }
        const structuredContent = {
          origin,
          destination,
          departureDate: input.departureDate,
          adults: input.adults,
          children: input.children,
          infants: input.infants,
          cabinClass: input.cabinClass,
          flightCount: flights.length,
          flights
        };
        return {
          ok: true,
          summary: `Found ${flights.length} flight${flights.length === 1 ? "" : "s"} from ${origin} to ${destination} on ${input.departureDate}.`,
          artifacts: [],
          structuredContent,
          logs: [JSON.stringify(structuredContent, null, 2)],
          errors: []
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agoda flight search failed.";
        return {
          ok: false,
          summary: `Agoda flight search failed: ${message}`,
          artifacts: [],
          structuredContent: { origin, destination, error: message },
          logs: [],
          errors: [message]
        };
      }
    }
  }
];
