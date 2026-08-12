/**
 * Operation names — the keys the cache's per-endpoint TTLs are configured with.
 *
 * `"weather.metar"`, `"airports.search"`, `"history.flights"`: the dotted name of the
 * endpoint a request goes to, independent of the path parameters in it. They exist so
 * a TTL can be attached to *an endpoint* rather than to a URL, since
 * `/weather/metar/KJFK` and `/weather/metar/EGLL` are the same thing with the same
 * shelf life.
 *
 * A {@link RequestSpec} may name itself through `spec.operation`. When it does not —
 * which is every built-in resource call — the name is derived from the path by
 * keeping the segments that are part of the SDK's own vocabulary and dropping the
 * rest, because those are exactly the path parameters:
 *
 * ```text
 * /weather/metar/KJFK          → weather.metar
 * /aircraft/icao24/4ca1fb      → aircraft.icao24
 * /ultra/history/flight/9/track → history.flight.track
 * /charts/KJFK/APP             → charts
 * ```
 *
 * Deriving instead of threading a name through all ~60 resource methods keeps the
 * feature confined to the core, and a name that fails to derive is harmless: it only
 * means the caller's TTL entry does not match, so nothing is cached — never that
 * something wrong is served.
 */

import type { RequestSpec } from "./types.js";

/**
 * Every literal path segment the SDK builds URLs from.
 *
 * A segment that is not in here is a path parameter (an ICAO code, a registration, a
 * hex address, a webhook id) and is dropped from the derived name. Matching is
 * case-sensitive, which is itself a guard: user-supplied codes are usually
 * upper-case, and the vocabulary is entirely lower-case.
 *
 * Adding an endpoint without adding its literals here costs nothing but a shorter
 * name — hence a test that walks the whole surface.
 */
const PATH_VOCABULARY: ReadonlySet<string> = new Set([
  "adsb",
  "aircraft",
  "airlines",
  "airport",
  "airports",
  "airsigmet",
  "arrivals",
  "briefing",
  "callsign",
  "carbon",
  "charts",
  "countries",
  "database",
  "delays",
  "departures",
  "distance",
  "estimate",
  "events",
  "faa",
  "flight",
  "flight-time",
  "flight_status",
  "flights",
  "health",
  "history",
  "icao24",
  "ip",
  "location",
  "metar",
  "ml",
  "navaids",
  "notams",
  "pairs",
  "pdf",
  "performance",
  "pireps",
  "positions",
  "regions",
  "registration",
  "routes",
  "schedules",
  "search",
  "sources",
  "statistics",
  "stats",
  "taf",
  "text",
  "tickets",
  "track",
  "traffic",
  "weather",
  "webhooks",
  "winds-aloft",
]);

/**
 * The history plan prefixes, stripped before deriving.
 *
 * `/ultra/history/flights` and `/mega/history/flights` are one operation on two
 * plans; a TTL for `"history.flights"` should not have to be written twice.
 */
const PLAN_PREFIXES: ReadonlySet<string> = new Set(["ultra", "mega"]);

/**
 * Dotted operation name for a request path.
 *
 * @param path Path relative to the base URL, e.g. `"/weather/metar/KJFK"`.
 * @returns The name (`"weather.metar"`), or `""` when no segment is recognised — for
 * an unknown path the only TTL that can apply is the cache's `defaultTtl`.
 */
export function deriveOperation(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  const start = first !== undefined && PLAN_PREFIXES.has(first) ? 1 : 0;
  const names: string[] = [];
  for (let index = start; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    if (PATH_VOCABULARY.has(segment)) names.push(segment);
  }
  return names.join(".");
}

/** The operation name of a spec: its own `operation`, or one derived from the path. */
export function operationOf(spec: RequestSpec): string {
  const explicit = spec.operation?.trim();
  return explicit ? explicit : deriveOperation(spec.path);
}
