/**
 * Live smoke tests: one call per namespace against a real deployment.
 *
 * What is asserted here is **that the round trip works and the payload has the
 * shape the types promise** — never the data itself. Live aviation data changes
 * by the minute: a METAR that exists now may be gone in ten, an ADS-B feed may
 * be empty at 3 a.m., and a departure board depends on who is flying today.
 * Asserting on values would turn this suite into a random number generator.
 *
 * The SDK does no runtime validation, so each test checks the three things that
 * a wrong path, a wrong query key or a drifted envelope would break:
 *
 * 1. the request reached the API and came back 2xx;
 * 2. the response is the declared envelope (its structural keys exist, with the
 *    declared primitive types);
 * 3. its invariants hold (counts match array lengths, echoed parameters come
 *    back, discriminated unions carry one of the declared tags).
 *
 * Endpoints fed by third parties degrade to `503` (upstream down, or the cache
 * still warming) and `404` (no data for this identifier right now). Both are
 * correct API behaviour, so {@link live} turns them into a skip with an
 * explanatory note rather than a failure.
 *
 * ```sh
 * # production, RapidAPI channel — the default, no provider needed
 * SKYLINK_TEST_API_KEY=...msh...jsn... npm run test:integration
 *
 * # production, direct channel, with a key issued by skylinkapi.com
 * SKYLINK_TEST_PROVIDER=direct \
 * SKYLINK_TEST_API_KEY=sk_live_... npm run test:integration
 *
 * # staging container from the backend's docker-compose.test.yml
 * SKYLINK_TEST_BASE_URL=http://localhost:8081/v3.1 npm run test:integration
 * ```
 *
 * `SKYLINK_TEST_API_KEY` is optional: given an explicit `baseUrl` the SDK does
 * not demand a key, which is what a staging instance running `DISABLE_AUTH=true`
 * expects.
 *
 * `SKYLINK_TEST_PROVIDER` selects the channel and mirrors the SDK default
 * (`rapidapi`); set it to `direct` for an `x-api-key` deployment. Either a key or a
 * base URL is enough to arm the suite — a key alone targets the channel's own
 * endpoint. With neither, the whole suite reports as skipped.
 */

import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  type APIStatusError,
  AuthenticationError,
  type ClientOptions,
  NotFoundError,
  PermissionDeniedError,
  type Provider,
  ServiceUnavailableError,
  SkyLink,
} from "../../src/index.js";

/** Endpoint under test, e.g. `http://localhost:8081/v3.1`. Empty → provider default. */
const BASE_URL = (process.env.SKYLINK_TEST_BASE_URL ?? "").trim();

/** Optional key. Empty → the client falls back to its own environment variables. */
const API_KEY = (process.env.SKYLINK_TEST_API_KEY ?? "").trim();

/** Channel to exercise: `rapidapi` (the SDK default) or `direct`. */
const PROVIDER: Provider =
  (process.env.SKYLINK_TEST_PROVIDER ?? "").trim() === "direct" ? "direct" : "rapidapi";

/** The suite is armed by a key (each channel knows its own endpoint) or by a base URL. */
const ARMED = Boolean(API_KEY) || Boolean(BASE_URL);

/**
 * Outcomes that are correct behaviour on a live deployment rather than SDK bugs:
 * `503` while an upstream is down or a cache is warming, `404` when the queried
 * identifier simply has no data at this moment. History adds its own `503` when
 * TimescaleDB is not attached.
 */
const UPSTREAM_ERRORS: readonly (typeof APIStatusError)[] = [
  NotFoundError,
  ServiceUnavailableError,
];

/**
 * Outcomes for the plan-gated webhook endpoints: `403` for a key without the
 * entitlement, `401` when the instance does not know the key at all, `503` when
 * the subscription store is down.
 */
const PLAN_ERRORS: readonly (typeof APIStatusError)[] = [
  AuthenticationError,
  PermissionDeniedError,
  ServiceUnavailableError,
];

/**
 * The history archive is both plan-gated (ULTRA/MEGA only, `403` otherwise) and
 * backed by a TimescaleDB that answers `503` when it is not attached.
 */
const ARCHIVE_ERRORS: readonly (typeof APIStatusError)[] = [
  ...UPSTREAM_ERRORS,
  PermissionDeniedError,
];

/** Stable, busy reference points present in every dataset the API ships. */
const ORIGIN = "KJFK";
const DESTINATION = "EGLL";
const ORIGIN_IATA = "JFK";
const DESTINATION_IATA = "LHR";

function describeError(error: APIStatusError): string {
  const body = error.body;
  const detail =
    body !== null && typeof body === "object" && "detail" in body
      ? (body as { detail: unknown }).detail
      : body;
  return `HTTP ${error.status}: ${typeof detail === "string" && detail ? detail : error.message}`;
}

/**
 * Run a live call, converting expected upstream failures into a skip.
 *
 * Anything not in `tolerated` — a wrong status, a transport error, an assertion
 * further down — still fails the test, which is the whole point of the suite.
 */
async function live<T>(
  ctx: TestContext,
  what: string,
  call: () => Promise<T>,
  tolerated: readonly (typeof APIStatusError)[] = UPSTREAM_ERRORS,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (tolerated.some((ErrorClass) => error instanceof ErrorClass)) {
      ctx.skip(`${what}: upstream data unavailable, ${describeError(error as APIStatusError)}`);
    }
    throw error;
  }
}

describe.skipIf(!ARMED)("live SkyLink API", () => {
  let sky: SkyLink;

  beforeAll(() => {
    // Built here rather than at module scope: `describe.skipIf` still evaluates
    // the suite body, and constructing a client without a base URL or a key would
    // throw before a single test could be reported as skipped.
    const options: ClientOptions = { provider: PROVIDER };
    if (BASE_URL) {
      options.baseUrl = BASE_URL;
    }
    if (API_KEY) {
      options.apiKey = API_KEY;
    }
    sky = new SkyLink(options);
  });

  // ── 1. weather ─────────────────────────────────────────────────────────────

  it("weather.metar returns the report envelope with the parsed block", async (ctx) => {
    const report = await live(ctx, "weather.metar", () =>
      sky.weather.metar(ORIGIN, { parsed: true }),
    );

    expect(report.icao).toBe(ORIGIN);
    expect(report.raw === null || typeof report.raw === "string").toBe(true);
    // The parsed overload's entire reason to exist: the key is always present,
    // even though its value is genuinely nullable.
    expect(report).toHaveProperty("parsed");
    if (report.parsed) {
      expect(Array.isArray(report.parsed.clouds)).toBe(true);
    }
  });

  // ── 2. airports ────────────────────────────────────────────────────────────

  it("airports.search returns the enriched airport", async (ctx) => {
    const airport = await live(ctx, "airports.search", () => sky.airports.search({ icao: ORIGIN }));

    expect(airport.search_code).toBe(ORIGIN);
    // Upper case on the wire — `routers/airports.py` sets `"ICAO" if icao else "IATA"`.
    expect(airport.search_type).toBe("ICAO");
    // Enrichment arrays are always present, even when empty.
    expect(Array.isArray(airport.runways)).toBe(true);
    expect(Array.isArray(airport.frequencies)).toBe(true);
    expect(Array.isArray(airport.navaids)).toBe(true);
  });

  // ── 3. airlines ────────────────────────────────────────────────────────────

  it("airlines.search returns a bare array, not an envelope", async (ctx) => {
    const airlines = await live(ctx, "airlines.search", () => sky.airlines.search({ icao: "BAW" }));

    expect(Array.isArray(airlines)).toBe(true);
    for (const airline of airlines.slice(0, 3)) {
      expect(typeof airline.name).toBe("string");
    }
  });

  // ── 4. navaids ─────────────────────────────────────────────────────────────

  it("navaids.list honours the limit and reports the pre-limit total", async (ctx) => {
    const result = await live(ctx, "navaids.list", () =>
      sky.navaids.list({ country: "US", limit: 5 }),
    );

    expect(result.navaids.length).toBeLessThanOrEqual(5);
    expect(result.total).toBeGreaterThanOrEqual(result.navaids.length);
    expect(result.filters_applied).toBeTypeOf("object");
    // camelCase on the wire for this one field — a rename would show up here.
    for (const navaid of result.navaids.slice(0, 3)) {
      expect(navaid.usageType === null || typeof navaid.usageType === "string").toBe(true);
    }
  });

  // ── 5. geo ─────────────────────────────────────────────────────────────────

  it("geo.countries returns the reference dataset", async (ctx) => {
    const result = await live(ctx, "geo.countries", () => sky.geo.countries());

    expect(result.countries.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.countries.length);
  });

  // ── 6. adsb ────────────────────────────────────────────────────────────────

  it("adsb.aircraft paginates and adsb.statistics summarises the same feed", async (ctx) => {
    const page = await live(ctx, "adsb.aircraft", () => sky.adsb.aircraft({ limit: 5 }));

    // The only paginated endpoint in the API; an empty feed is a valid answer.
    expect(page.aircraft.length).toBeLessThanOrEqual(5);
    expect(page.total_count).toBeGreaterThanOrEqual(page.aircraft.length);
    expect(typeof page.timestamp).toBe("string");

    const stats = await live(ctx, "adsb.statistics", () => sky.adsb.statistics());

    expect(stats.total_aircraft).toBeGreaterThanOrEqual(stats.positioned_aircraft);
    expect(typeof stats.on_ground).toBe("number");
  });

  // ── 7. aircraft ────────────────────────────────────────────────────────────

  it("aircraft.byRegistration returns the found/not-found union", async (ctx) => {
    const lookup = await live(ctx, "aircraft.byRegistration", () =>
      sky.aircraft.byRegistration("G-STBC", { photos: false }),
    );

    expect(typeof lookup.found).toBe("boolean");
    if (lookup.found) {
      expect(lookup.aircraft).not.toBeNull();
      expect(typeof lookup.aircraft.registration).toBe("string");
    } else {
      expect(lookup.aircraft).toBeNull();
    }
  });

  it("an unknown registration is a 200 sentinel, not an error", async () => {
    // The SDK's contract for "not found" sentinels: typed fields, never
    // exceptions. Deliberately not wrapped in `live()` — this endpoint reads an
    // in-process database, so there is no upstream to be unavailable, and a
    // thrown error here means the sentinel handling regressed.
    const lookup = await sky.aircraft.byRegistration("ZZ-ZZZZ", { photos: false });

    expect(lookup.found).toBe(false);
    expect(lookup.aircraft).toBeNull();
  });

  // ── 8. charts ──────────────────────────────────────────────────────────────

  it("charts.sources lists sources and charts.byAirport groups by category", async (ctx) => {
    const sources = await live(ctx, "charts.sources", () => sky.charts.sources());

    expect(sources.total_count).toBe(sources.sources.length);

    const charts = await live(ctx, "charts.byAirport", () => sky.charts.byAirport(ORIGIN));

    expect(charts.icao_code).toBe(ORIGIN);
    const grouped = Object.values(charts.charts).reduce(
      (sum, items) => sum + (items?.length ?? 0),
      0,
    );
    expect(charts.total_count).toBe(grouped);
  });

  // ── 9. delays ──────────────────────────────────────────────────────────────

  it("delays.faa totals its four alert categories", async (ctx) => {
    const delays = await live(ctx, "delays.faa", () => sky.delays.faa());

    expect(delays.total_alerts).toBe(
      delays.ground_delays.length +
        delays.ground_stops.length +
        delays.closures.length +
        delays.airspace_flow_programs.length,
    );
  });

  // ── 10. notams ─────────────────────────────────────────────────────────────

  it("notams.byAirport returns the envelope and leaves times opaque", async (ctx) => {
    const result = await live(ctx, "notams.byAirport", () =>
      sky.notams.byAirport(ORIGIN, { exclude_scope: ["FIR"] }),
    );

    expect(result.icao).toBe(ORIGIN);
    expect(result.total).toBe(result.notams.length);
    for (const notam of result.notams.slice(0, 5)) {
      // NOTAM validity times are opaque strings, never parsed into Date.
      expect(notam.effective === null || typeof notam.effective === "string").toBe(true);
      expect(typeof notam.raw).toBe("string");
    }
  });

  // ── 11. schedules ──────────────────────────────────────────────────────────

  it("schedules.departures returns PascalCase flight rows", async (ctx) => {
    const board = await live(ctx, "schedules.departures", () =>
      sky.schedules.departures({ icao: DESTINATION }),
    );

    expect(board.direction).toBe("departures");
    expect(board.total_flights).toBe(board.flights.length);
    for (const flight of board.flights.slice(0, 5)) {
      // Wire keys are PascalCase here and nowhere else in the API.
      expect(typeof flight.Time).toBe("string");
      expect(typeof flight.Flight).toBe("string");
      expect(typeof flight.Destination).toBe("string");
    }
  });

  // ── 12. ml ─────────────────────────────────────────────────────────────────

  it("ml.flightTime maps from/to and brackets its estimate", async (ctx) => {
    const prediction = await live(ctx, "ml.flightTime", () =>
      sky.ml.flightTime({ origin: ORIGIN, destination: DESTINATION }),
    );

    // A broken query builder would answer 422 here, so this doubles as a
    // regression test for the `from`/`to` wire keys.
    expect(prediction.origin).toBe(ORIGIN);
    expect(prediction.destination).toBe(DESTINATION);
    expect(prediction.min_minutes).toBeLessThanOrEqual(prediction.estimated_minutes);
    expect(prediction.estimated_minutes).toBeLessThanOrEqual(prediction.max_minutes);
  });

  // ── 13. carbon ─────────────────────────────────────────────────────────────

  it("carbon.estimate echoes the route it costed", async (ctx) => {
    const estimate = await live(ctx, "carbon.estimate", () =>
      sky.carbon.estimate({
        departure_icao: ORIGIN,
        arrival_icao: DESTINATION,
        aircraft_type: "B77W",
        passengers: 250,
      }),
    );

    expect(estimate.departure_icao).toBe(ORIGIN);
    expect(estimate.arrival_icao).toBe(DESTINATION);
    expect(estimate.passengers).toBe(250);
    expect(typeof estimate.co2_kg_total).toBe("number");
  });

  // ── 14. briefing ───────────────────────────────────────────────────────────

  it("briefing.flight resolves to the structured briefing for format=json", async (ctx) => {
    const briefing = await live(ctx, "briefing.flight", () =>
      sky.briefing.flight({ origin: ORIGIN, destination: DESTINATION }),
    );

    expect(briefing.origin).toBe(ORIGIN);
    expect(briefing.destination).toBe(DESTINATION);
    expect(Array.isArray(briefing.data_included)).toBe(true);
    expect(Array.isArray(briefing.critical_restrictions)).toBe(true);
  });

  it("briefing.flight resolves to a string for a text format", async (ctx) => {
    const rendered = await live(ctx, "briefing.flight(format=markdown)", () =>
      sky.briefing.flight({ origin: ORIGIN, destination: DESTINATION, format: "markdown" }),
    );

    // The overload unwraps the JSON envelope down to its `briefing` field.
    expect(typeof rendered).toBe("string");
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it("briefing.pdf returns bytes starting with the %PDF magic number", async (ctx) => {
    const payload = await live(ctx, "briefing.pdf", () =>
      sky.briefing.pdf({ departure_icao: ORIGIN, arrival_icao: DESTINATION }),
    );

    // The only binary endpoint in the API. `%PDF` proves the whole path: no JSON
    // decoding, no text decoding, no re-encoding on the way through.
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(payload.subarray(0, 4))).toBe("%PDF");
    expect(payload.byteLength).toBeGreaterThan(1000);
  });

  // ── 15. routes ─────────────────────────────────────────────────────────────

  it("routes.byCallsign returns a union tagged by source", async (ctx) => {
    const route = await live(ctx, "routes.byCallsign", () => sky.routes.byCallsign("BAW117"));

    expect(["vrs", "airline_routes"]).toContain(route.source);
    if (route.source === "vrs") {
      expect(Array.isArray(route.airports)).toBe(true);
      expect(typeof route.departure_icao).toBe("string");
    } else {
      expect(Array.isArray(route.routes)).toBe(true);
      expect(typeof route.total_routes).toBe("number");
    }
  });

  // ── 16. tickets ────────────────────────────────────────────────────────────

  it("tickets.search echoes the query and counts its offers", async (ctx) => {
    const result = await live(ctx, "tickets.search", () =>
      sky.tickets.search({
        origin: ORIGIN_IATA,
        destination: DESTINATION_IATA,
        passengers: 1,
      }),
    );

    expect(result.origin).toBe(ORIGIN_IATA);
    expect(result.destination).toBe(DESTINATION_IATA);
    expect(result.count).toBe(result.flights.length);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ── 17. webhooks ───────────────────────────────────────────────────────────

  it("webhooks survive a full create → list → update → delete cycle", async (ctx) => {
    await live(
      ctx,
      "webhooks CRUD",
      async () => {
        const eventTypes = await sky.webhooks.eventTypes();
        expect(Array.isArray(eventTypes)).toBe(true);
        expect(eventTypes).toContain("status_changed");

        // POST → 201
        const created = await sky.webhooks.create({
          url: "https://example.com/skylink-sdk-integration",
          event_types: ["status_changed"],
          filters: { flight_number: "BA117" },
        });
        expect(typeof created.id).toBe("string");
        const id = created.id;

        try {
          const listed = await sky.webhooks.list();
          expect(listed.map((item) => item.id)).toContain(id);

          const toggled = await sky.webhooks.update(id, { active: false });
          expect(toggled.id).toBe(id);
          expect(toggled.active).toBe(false);
        } finally {
          // Runs even when an assertion above threw, so the account is never
          // left holding a stray subscription. DELETE answers 204 No Content and
          // the SDK resolves to void rather than failing on an empty body.
          await sky.webhooks.delete(id);
        }

        const remaining = await sky.webhooks.list();
        expect(remaining.map((item) => item.id)).not.toContain(id);
      },
      PLAN_ERRORS,
    );
  });

  // ── 18. history ────────────────────────────────────────────────────────────

  it("history.flights returns the archive envelope", async (ctx) => {
    // At least one identifying filter is mandatory — the SDK refuses a
    // time-window-only search client side, and the API answers 422 to one.
    const result = await live(
      ctx,
      "history.flights",
      () => sky.history.flights({ departure_icao: ORIGIN, limit: 5 }),
      ARCHIVE_ERRORS,
    );

    expect(result.count).toBe(result.flights.length);
    expect(result.flights.length).toBeLessThanOrEqual(5);
    expect(result.filters).toBeTypeOf("object");
    expect(result.filters.departure_icao).toBe(ORIGIN);
    // `note` is a 200 sentinel ("nothing matched this filter"), not an error.
    expect(result.note === undefined || typeof result.note === "string").toBe(true);
  });

  // ── client-level shortcut methods ──────────────────────────────────────────

  it("sky.flightStatus is a method on the client", async (ctx) => {
    const status = await live(ctx, "sky.flightStatus", () => sky.flightStatus("BA117"));

    expect(typeof status.flight_number).toBe("string");
    expect(typeof status.status).toBe("string");
    // The two legs are deliberately asymmetric: `checkin` vs `baggage`.
    expect(status.departure).toBeTypeOf("object");
    expect(status.arrival).toBeTypeOf("object");
  });

  it("sky.distance is the other client-level shortcut", async (ctx) => {
    const leg = await live(ctx, "sky.distance", () =>
      sky.distance({ from_icao: ORIGIN, to_icao: DESTINATION, unit: "km" }),
    );

    expect(leg.unit).toBe("km");
    expect(leg.distance).toBeGreaterThan(0);
    expect(leg.bearing).toBeGreaterThanOrEqual(0);
    expect(leg.bearing).toBeLessThanOrEqual(360);
    expect(typeof leg.bearing_cardinal).toBe("string");
    expect(leg.midpoint).toBeTypeOf("object");
  });

  // ── quota headers ──────────────────────────────────────────────────────────

  it("lastRateLimit mirrors the quota headers when the gateway sends them", async (ctx) => {
    await live(ctx, "geo.countries (quota headers)", () => sky.geo.countries());

    // A staging instance behind `DISABLE_AUTH=true` sends no quota headers, so
    // `null` is a valid outcome there. Both production gateways do send them — under
    // different names, which is the point: RapidAPI spells them
    // `x-ratelimit-requests-*` (plus a decorative `x-ratelimit-rapid-*` family that
    // must not be picked up by mistake), APISIX spells them `x-ratelimit-*`. Reading
    // only the first is exactly the bug this assertion now catches on either channel.
    const quota = sky.lastRateLimit;
    if (!BASE_URL) {
      expect(quota).not.toBeNull();
    }
    if (quota !== null) {
      expect(quota.limit === null || quota.limit >= 0).toBe(true);
      expect(quota.remaining === null || quota.remaining >= 0).toBe(true);
      expect(quota.reset === null || quota.reset >= 0).toBe(true);
      if (quota.limit !== null && quota.remaining !== null) {
        expect(quota.remaining).toBeLessThanOrEqual(quota.limit);
      }
    }
  });
});
