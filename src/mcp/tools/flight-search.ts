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
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "returnDate must be YYYY-MM-DD").optional(),
  selectedOutboundBundleRefId: z.string().optional(),
  adults: z.number().int().min(1).max(9).optional().default(1),
  children: z.number().int().min(0).max(8).optional().default(0),
  infants: z.number().int().min(0).max(8).optional().default(0),
  cabinClass: z.enum(["Economy", "PremiumEconomy", "Business", "First"]).optional().default("Economy"),
  sortBy: z.enum(["Best", "Price", "Duration"]).optional().default("Best"),
  maxResults: z.number().int().min(1).max(20).optional().default(10)
}).strict().refine((data) => !data.returnDate || data.returnDate > data.departureDate, {
  message: "returnDate must be after departureDate",
  path: ["returnDate"]
});

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

type SliceSpec = {
  origin: Array<{ code: string; type: string }>;
  destination: Array<{ code: string; type: string }>;
  departureDate: string;
  sliceFilter: { cabinClasses: string[]; carrier: { exclude: string[]; preferred: string[] } };
};

// Unlike Agoda's hotel search (session-bound GraphQL behind Akamai bot mitigation, see
// hotel-search.ts), this flights endpoint is a genuinely stateless public API: no cookies,
// no xsrf token, works with zero custom headers. Confirmed empirically (curl with only a
// Content-Type header returns real itineraries).
//
// Round-trip is a two-call protocol against this SAME endpoint, reverse-engineered
// empirically (not documented): call 1 with both slices and no preferredBundleIds returns
// only outbound options (slice.id 1); call 2, identical body but with the chosen outbound's
// bundleRefId in preferredBundleIds, returns return-leg options (slice.id 2) whose price is
// the combined round-trip total (cheaper than summing two one-ways, per normal fare
// construction) rather than the return leg priced alone.
function buildSlices(input: FlightSearchInput): SliceSpec[] {
  const outboundSlice: SliceSpec = {
    origin: [{ code: input.origin.toUpperCase(), type: "Airport" }],
    destination: [{ code: input.destination.toUpperCase(), type: "Airport" }],
    departureDate: input.departureDate,
    sliceFilter: { cabinClasses: [], carrier: { exclude: [], preferred: [] } }
  };
  if (!input.returnDate) return [outboundSlice];
  const returnSlice: SliceSpec = {
    origin: [{ code: input.destination.toUpperCase(), type: "Airport" }],
    destination: [{ code: input.origin.toUpperCase(), type: "Airport" }],
    departureDate: input.returnDate,
    sliceFilter: { cabinClasses: [], carrier: { exclude: [], preferred: [] } }
  };
  return [outboundSlice, returnSlice];
}

function buildRequestBody(input: FlightSearchInput, polling: PollingState | { count: number }, preferredBundleIds: string[]) {
  const slices = buildSlices(input);
  return {
    pagination: { page: 1 },
    polling,
    searchCriteria: {
      passengers: { adult: input.adults, child: input.children, infant: input.infants },
      trip: {
        outboundSlice: slices[0],
        slices,
        itineraryFilter: { hackerFareEnabled: true, cabinClass: input.cabinClass },
        sort: { sortBy: input.sortBy },
        preferredBundleIds
      },
      // Left blank rather than reusing Agoda's own web client's aid: this is a generic
      // no-affiliation search, not an attempt to route traffic through any specific account.
      whitelabelContext: { programId: "", aid: "" }
    }
  };
}

async function fetchOnce(input: FlightSearchInput, polling: PollingState | { count: number }, preferredBundleIds: string[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await safeFetch(flightsEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildRequestBody(input, polling, preferredBundleIds))
    });
    if (!response.ok) throw new Error(`Agoda flights search returned HTTP ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithPolling(input: FlightSearchInput, preferredBundleIds: string[]): Promise<{ items: unknown[]; completed: boolean }> {
  let polling: PollingState | { count: number } = { count: 1 };
  for (let attempt = 0; attempt < maxPollingAttempts; attempt++) {
    const json = (await fetchOnce(input, polling, preferredBundleIds)) as {
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

type RawFlightItem = {
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

// Agoda's flights-bff matches at metro-area level even when the request specifies a
// single airport code (e.g. a "HND" destination request also returns NRT arrivals, since
// both serve Tokyo) — confirmed empirically across both outbound and return legs. Filter
// to an exact airport match here so the tool's documented "3-letter airport code" contract
// (not "nearby airports") actually holds.
function matchesExactAirports(item: RawFlightItem, expectedDeparture: string, expectedArrival: string): boolean {
  const segments = item.slice?.segments ?? [];
  if (segments.length === 0) return false;
  const actualDeparture = segments[0]?.departure?.airport?.code;
  const actualArrival = segments[segments.length - 1]?.arrival?.airport?.code;
  return actualDeparture === expectedDeparture && actualArrival === expectedArrival;
}

function extractFlights(items: unknown[], maxResults: number, expectedDeparture: string, expectedArrival: string): FlightResult[] {
  const matched = (items as RawFlightItem[]).filter((item) => matchesExactAirports(item, expectedDeparture, expectedArrival));
  return matched.slice(0, maxResults).map((item) => {
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
      description: "Search live flight availability and pricing on Agoda via its public flights search API (stateless, no session/cookies required, unlike agoda_search_hotels). Read-only: returns structured itineraries and never books or pays for anything. Results are filtered to the exact origin/destination airport codes given (Agoda's own API matches at metro-area level, e.g. a Tokyo HND search also returns NRT flights, so those are dropped here). Pass returnDate for a round trip: the response includes outboundFlights plus returnFlights paired with the first (best) outbound option, where each return flight's price is the combined round-trip total. To get return options for a different outbound choice, call again with selectedOutboundBundleRefId set to that option's bundleRefId. Currency is server-determined and cannot be requested by the caller.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "string", pattern: "^[A-Za-z]{3}$", description: "3-letter IATA airport code, e.g. 'SIN'." },
          destination: { type: "string", pattern: "^[A-Za-z]{3}$", description: "3-letter IATA airport code, e.g. 'HND'." },
          departureDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          returnDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Omit for a one-way search." },
          selectedOutboundBundleRefId: { type: "string", description: "Fetch return options paired with this specific outbound flight (its bundleRefId from a prior call) instead of the default best outbound." },
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
        const outboundSearch = await searchWithPolling(input, []);
        const outboundFlights = extractFlights(outboundSearch.items, input.maxResults, origin, destination);
        if (outboundFlights.length === 0) {
          return {
            ok: false,
            summary: `No flights found for ${origin} -> ${destination} on ${input.departureDate}.`,
            artifacts: [],
            structuredContent: { origin, destination, departureDate: input.departureDate, completed: outboundSearch.completed },
            logs: [],
            errors: ["No results."]
          };
        }

        if (!input.returnDate) {
          const structuredContent = {
            origin,
            destination,
            departureDate: input.departureDate,
            adults: input.adults,
            children: input.children,
            infants: input.infants,
            cabinClass: input.cabinClass,
            flightCount: outboundFlights.length,
            flights: outboundFlights
          };
          return {
            ok: true,
            summary: `Found ${outboundFlights.length} flight${outboundFlights.length === 1 ? "" : "s"} from ${origin} to ${destination} on ${input.departureDate}.`,
            artifacts: [],
            structuredContent,
            logs: [JSON.stringify(structuredContent, null, 2)],
            errors: []
          };
        }

        const chosenOutboundId = input.selectedOutboundBundleRefId ?? outboundFlights[0].bundleRefId;
        if (!chosenOutboundId) {
          return {
            ok: false,
            summary: "Outbound flights were found but none had a usable bundleRefId to pair return options against.",
            artifacts: [],
            structuredContent: { origin, destination, outboundFlights },
            logs: [],
            errors: ["Missing bundleRefId on outbound results."]
          };
        }

        const returnSearch = await searchWithPolling(input, [chosenOutboundId]);
        const returnFlights = extractFlights(returnSearch.items, input.maxResults, destination, origin);

        const structuredContent = {
          origin,
          destination,
          departureDate: input.departureDate,
          returnDate: input.returnDate,
          adults: input.adults,
          children: input.children,
          infants: input.infants,
          cabinClass: input.cabinClass,
          outboundFlightCount: outboundFlights.length,
          outboundFlights,
          selectedOutboundBundleRefId: chosenOutboundId,
          returnFlightCount: returnFlights.length,
          returnFlights
        };
        return {
          ok: true,
          summary: returnFlights.length > 0
            ? `Found ${outboundFlights.length} outbound flight${outboundFlights.length === 1 ? "" : "s"} (${origin}->${destination}) and ${returnFlights.length} return option${returnFlights.length === 1 ? "" : "s"} (${destination}->${origin}) paired with outbound ${chosenOutboundId}.`
            : `Found ${outboundFlights.length} outbound flight${outboundFlights.length === 1 ? "" : "s"} (${origin}->${destination}) but no return options for outbound ${chosenOutboundId}.`,
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
