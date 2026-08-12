/**
 * Live verification of the DX layer: batch, compose, iterators, pollers, the cache
 * and the pure helpers, all against a real deployment.
 *
 * The unit suite proves these features against an undici `MockAgent` — that is, against
 * what the API was *believed* to answer. This file proves the other half: that the
 * assumptions hold on the wire. It is deliberately separate from `live.test.ts`, which
 * covers one call per namespace; nothing here re-tests a bare endpoint.
 *
 * Same discipline as the smoke suite. Values are never asserted (live aviation data
 * changes by the minute); what is asserted is the *machinery*: that a batch keys its
 * results by the strings it was given, that a brief degrades one part at a time, that
 * an iterator actually advances its offset instead of looping, that a cache hit costs
 * no request, that a diff between two live snapshots is internally consistent.
 *
 * Where a live answer is informative rather than assertable — which parts of an
 * airport brief a given deployment can serve today, how many countries the North
 * America workaround finds — it is printed. Those lines are the point of running this:
 * they are a snapshot of what the backend can do right now.
 *
 * ```sh
 * SKYLINK_TEST_PROVIDER=rapidapi SKYLINK_TEST_API_KEY=... npm run test:integration
 * ```
 *
 * Known backend defects (see `research/04-live-verification.md`) are tolerated, not
 * worked around. Neither of the two standing ones is reachable from this layer: no
 * part of any brief is served by `briefing.flight` (503 in every format) or by
 * `weather.airsigmet` (500 on any parameters) — `live.test.ts` covers those endpoints
 * directly. What the DX layer does inherit is every weakness underneath it: a status
 * scraper that answers 503, a registry that has never heard of an airframe, a carbon
 * estimate the backend cannot resolve a route for. Each of those lands in the brief's
 * `errors` map, is printed, and is never asserted away.
 */

import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  type AdsbAircraft,
  AIRPORT_BRIEF_PARTS,
  type APIStatusError,
  CACHE_HIT_HEADER,
  type ClientOptions,
  csv,
  FLIGHT_CATEGORIES,
  geojson,
  MemoryCache,
  NotFoundError,
  type Provider,
  ROUTE_BRIEF_PARTS,
  ServiceUnavailableError,
  SkyLink,
  SkyLinkError,
  spatial,
  units,
  weatherHelpers,
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
 * Only a production gateway sends quota headers; a `DISABLE_AUTH` staging box does not.
 *
 * Both channels do, in their own dialect — `x-ratelimit-requests-*` through the
 * marketplace, `x-ratelimit-*` through APISIX — so the channel does not enter into it.
 */
const QUOTA_HEADERS_EXPECTED = !BASE_URL;

/** Stable, busy reference points present in every dataset the API ships. */
const ORIGIN = "KJFK";
const DESTINATION = "EGLL";
const MOSCOW = "UUEE";
/** Four letters, correctly shaped, and deliberately not an airport. */
const NONSENSE = "ZZZZ";

/**
 * Outcomes that are correct behaviour on a live deployment rather than SDK bugs:
 * `503` while an upstream is down or a cache is warming, `404` when the queried
 * identifier simply has no data at this moment.
 */
const UPSTREAM_ERRORS: readonly (typeof APIStatusError)[] = [
  NotFoundError,
  ServiceUnavailableError,
];

function describeError(error: unknown): string {
  if (error instanceof SkyLinkError && "status" in error) {
    const status = (error as APIStatusError).status;
    const body = (error as APIStatusError).body;
    const detail =
      body !== null && typeof body === "object" && "detail" in body
        ? (body as { detail: unknown }).detail
        : body;
    return `HTTP ${status}: ${typeof detail === "string" && detail ? detail : error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Print a block of live findings.
 *
 * These are the parts of a live run that cannot be asserted but are worth having in
 * the log: which brief parts a deployment can serve, what a workaround found, how far
 * an iterator actually got.
 */
function report(title: string, lines: readonly string[]): void {
  const body = lines.length > 0 ? lines.map((line) => `    ${line}`).join("\n") : "    (nothing)";
  console.info(`\n  [live-dx] ${title}\n${body}`);
}

/** One line per failed part of a brief, in the order the parts are declared. */
function describeParts<Part extends string>(errors: Partial<Record<Part, SkyLinkError>>): string[] {
  const entries = Object.entries(errors as Record<string, SkyLinkError>);
  if (entries.length === 0) return ["errors: {} — every requested part came back"];
  return entries.map(([part, error]) => `errors.${part} — ${describeError(error)}`);
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
      ctx.skip(`${what}: upstream data unavailable, ${describeError(error)}`);
    }
    throw error;
  }
}

describe.skipIf(!ARMED)("live SkyLink DX features", () => {
  let sky: SkyLink;

  beforeAll(() => {
    const options: ClientOptions = { provider: PROVIDER };
    if (BASE_URL) {
      options.baseUrl = BASE_URL;
    }
    if (API_KEY) {
      options.apiKey = API_KEY;
    }
    sky = new SkyLink(options);
  });

  // ── batch ──────────────────────────────────────────────────────────────────

  it("batch.metars keys results by the caller's strings and isolates one bad code", async (ctx) => {
    const icaos = [ORIGIN, DESTINATION, MOSCOW, NONSENSE];

    // No `live()` wrapper: the entire contract of this method is that failures come
    // back as values. A rejection here is the regression.
    const results = await sky.batch.metars(icaos, { concurrency: 2 });

    // Keys verbatim, in input order — not upper-cased, not de-duplicated away.
    expect(Object.keys(results)).toEqual(icaos);

    const failed: string[] = [];
    const succeeded: string[] = [];
    for (const icao of icaos) {
      const result = results[icao];
      expect(result).toBeDefined();
      if (result instanceof SkyLinkError) {
        failed.push(`${icao}: ${describeError(result)}`);
      } else if (result !== undefined) {
        // A METAR envelope, not an error: the ICAO is echoed and `raw` is a string
        // (or null for a station that is currently silent).
        expect(result.icao).toBe(icao);
        expect(result.raw === null || typeof result.raw === "string").toBe(true);
        succeeded.push(`${icao}: ${result.raw ?? "(no report)"}`);
      }
    }

    report("batch.metars", [...succeeded, ...failed]);

    // The real assertion: one bad key does not take the batch with it. If every code
    // failed, the weather upstream is down and there is nothing to conclude.
    if (succeeded.length === 0) {
      ctx.skip(`batch.metars: every station failed — ${failed.join("; ")}`);
    }
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
  });

  // ── compose.airportBrief ───────────────────────────────────────────────────

  it("compose.airportBrief assembles KJFK and files each failure under its part", async (ctx) => {
    const brief = await live(ctx, "compose.airportBrief", () =>
      sky.compose.airportBrief(ORIGIN, { schedulesLimit: 5 }),
    );

    const arrived = AIRPORT_BRIEF_PARTS.filter((part) => brief[part] !== null);
    report("compose.airportBrief(KJFK)", [
      `parts present: ${arrived.join(", ") || "(none)"}`,
      ...describeParts(brief.errors),
      `metar.raw: ${brief.metar?.raw ?? "—"}`,
      `notams: ${brief.notams?.total ?? "—"}`,
      `charts: ${brief.charts?.total_count ?? "—"}`,
      `departures/arrivals rows: ${brief.departures?.flights.length ?? "—"}/${
        brief.arrivals?.flights.length ?? "—"
      }`,
    ]);

    // The primary part is not captured: reaching this line means it succeeded.
    expect(brief.airport).not.toBeNull();
    expect(brief.airport?.search_code).toBe(ORIGIN);

    // Every key of `errors` is a declared part, and every entry is a SkyLinkError —
    // anything else would mean a bug leaked into the aggregate instead of throwing.
    for (const [part, error] of Object.entries(brief.errors as Record<string, SkyLinkError>)) {
      expect(AIRPORT_BRIEF_PARTS as readonly string[]).toContain(part);
      expect(error).toBeInstanceOf(SkyLinkError);
    }

    // A part is either present or explained. Never silently null.
    for (const part of AIRPORT_BRIEF_PARTS) {
      const failed = brief.errors[part] !== undefined;
      expect(brief[part] === null).toBe(failed);
    }

    // Client-side truncation of the boards, which have no server-side limit.
    expect(brief.departures?.flights.length ?? 0).toBeLessThanOrEqual(5);
    expect(brief.arrivals?.flights.length ?? 0).toBeLessThanOrEqual(5);
    // `total_flights` still describes the whole board — that is how you tell there is more.
    if (brief.departures) {
      expect(brief.departures.total_flights).toBeGreaterThanOrEqual(
        brief.departures.flights.length,
      );
    }

    // Weather is requested decoded, so the helper works without a second call.
    if (brief.metar) {
      expect(brief.metar).toHaveProperty("parsed");
    }
  });

  // ── compose.flightBrief ────────────────────────────────────────────────────

  it("compose.flightBrief resolves a flight number taken off a live board", async (ctx) => {
    const board = await live(ctx, "schedules.departures", () =>
      sky.schedules.departures({ icao: DESTINATION }),
    );

    // Numbers from the board itself, so the flight demonstrably exists today.
    const candidates = [
      ...new Set(
        board.flights
          .map((row) => row.Flight?.replace(/\s+/g, "").toUpperCase() ?? "")
          .filter((number) => number.length >= 3),
      ),
    ].slice(0, 4);

    if (candidates.length === 0) {
      ctx.skip("compose.flightBrief: the departure board carried no flight numbers");
    }

    const tried: string[] = [];
    for (const number of candidates) {
      let brief: Awaited<ReturnType<typeof sky.compose.flightBrief>>;
      try {
        brief = await sky.compose.flightBrief(number);
      } catch (error) {
        // `status` is the primary part: a number the status scraper does not know
        // rejects the whole brief, which is the documented behaviour.
        if (error instanceof NotFoundError || error instanceof ServiceUnavailableError) {
          tried.push(`${number}: ${describeError(error)}`);
          continue;
        }
        throw error;
      }

      report(`compose.flightBrief(${number})`, [
        ...tried,
        `status: ${brief.status?.status ?? "—"} (${brief.status?.flight_number ?? "—"})`,
        `aircraft: ${brief.aircraft === null ? "not looked up (no registration in status)" : `found=${brief.aircraft.found}`}`,
        `route: ${brief.route?.source ?? "—"}`,
        `carbon: ${brief.carbon?.co2_kg_total ?? "—"} kg`,
        ...describeParts(brief.errors),
      ]);

      expect(brief.status).not.toBeNull();
      expect(typeof brief.status?.flight_number).toBe("string");
      // The union is tagged, and each branch is narrowed rather than merely counted:
      // the two share only `callsign_prefix`, `airline_code`, `confidence`, `source`.
      if (brief.route?.source === "vrs") {
        expect(typeof brief.route.callsign).toBe("string");
        expect(brief.route.confidence).toBe("high");
        expect(brief.route.airports.length).toBeGreaterThanOrEqual(2);
      } else if (brief.route) {
        expect(brief.route.source).toBe("airline_routes");
        expect(brief.route.confidence).toBe("low");
        // No `callsign` key at all on the fallback — the reason the union is tagged.
        expect("callsign" in brief.route).toBe(false);
        expect(brief.route.total_routes).toBeGreaterThanOrEqual(brief.route.routes.length);
      }
      // The registry lookup is kept whole, sentinel included.
      if (brief.aircraft) {
        expect(typeof brief.aircraft.found).toBe("boolean");
      }
      for (const [part, error] of Object.entries(brief.errors as Record<string, SkyLinkError>)) {
        expect(["aircraft", "route", "carbon"]).toContain(part);
        expect(error).toBeInstanceOf(SkyLinkError);
      }
      // A board number is IATA, so `route` is usually the airline-level fallback, which
      // carries no airport pair; the estimate then falls back to pricing the callsign,
      // and the backend does not resolve IATA designators as callsigns. Live on
      // 2026-08-12: BA1466 → `errors.carbon` = 404 "Could not resolve departure/arrival
      // airports". Correct degradation, not a failure — hence a check of the *pairing*,
      // never of presence. The ICAO-callsign path that does price is the next test.
      expect(brief.carbon === null).toBe(brief.errors.carbon !== undefined);
      return;
    }

    ctx.skip(`compose.flightBrief: no board number resolved — ${tried.join("; ")}`);
  });

  it("compose.flightBrief takes the vrs branch for an ICAO callsign and prices it", async (ctx) => {
    // The documented difference between the two designator forms, on the wire.
    // `/flight_status` normalizes "BAW117" to "BA117" on the way out, while
    // `/routes/callsign` only finds the exact VRS record — the one carrying the airport
    // pair — under the ICAO callsign. The brief therefore looks the route up by *what
    // the caller passed*, not by the number the status payload echoes back; preferring
    // the payload downgraded every callsign to the airline fallback.
    const CALLSIGN = "BAW117";

    // `status` is the primary part: if BA117 is not operating today it rejects, and
    // there is nothing to conclude about the branch.
    const brief = await live(ctx, `compose.flightBrief(${CALLSIGN})`, () =>
      sky.compose.flightBrief(CALLSIGN),
    );

    report(`compose.flightBrief(${CALLSIGN})`, [
      `status: ${brief.status?.status ?? "—"} (echoed as ${brief.status?.flight_number ?? "—"})`,
      `route: ${brief.route?.source ?? "—"}${
        brief.route?.source === "vrs"
          ? ` ${brief.route.departure_icao}→${brief.route.arrival_icao}`
          : ""
      }`,
      `carbon: ${brief.carbon?.co2_kg_total ?? "—"} kg`,
      ...describeParts(brief.errors),
    ]);

    const route = brief.route;
    if (route === null || route.source !== "vrs") {
      // VRS standing data is a dataset, not a live feed, so a fallback here means the
      // reference data moved rather than the SDK — but it is worth a loud skip.
      ctx.skip(
        route === null
          ? `routes.byCallsign(${CALLSIGN}) failed — ${describeParts(brief.errors).join("; ")}`
          : `routes.byCallsign(${CALLSIGN}) fell back to ${route.source}`,
      );
      return;
    }

    // The exact match: an ICAO pair, high confidence, and the callsign echoed.
    expect(route.callsign).toBe(CALLSIGN);
    expect(route.confidence).toBe("high");
    expect(route.departure_icao).toMatch(/^[A-Z]{4}$/);
    expect(route.arrival_icao).toMatch(/^[A-Z]{4}$/);
    expect(route.airports).toContain(route.departure_icao);

    // …and because the pair is known, the estimate is priced from it rather than from
    // the callsign, so this part cannot 404 the way the IATA path can.
    if (brief.carbon) {
      expect(brief.carbon.departure_icao).toBe(route.departure_icao);
      expect(brief.carbon.arrival_icao).toBe(route.arrival_icao);
      expect(brief.carbon.co2_kg_total).toBeGreaterThan(0);
    } else {
      expect(brief.errors.carbon).toBeInstanceOf(SkyLinkError);
    }
  });

  // ── compose.routeBrief ─────────────────────────────────────────────────────

  it("compose.routeBrief costs KJFK→EGLL across seven independent endpoints", async () => {
    // No `live()` wrapper: a route brief has no primary part, so it must not throw
    // however badly the upstreams are behaving.
    const brief = await sky.compose.routeBrief(ORIGIN, DESTINATION, {
      aircraftType: "B77W",
      passengers: 250,
    });

    const arrived = ROUTE_BRIEF_PARTS.filter((part) => brief[part] !== null);
    report(`compose.routeBrief(${ORIGIN}, ${DESTINATION})`, [
      `parts present: ${arrived.join(", ") || "(none)"}`,
      ...describeParts(brief.errors),
      `distance: ${brief.distance?.distance ?? "—"} ${brief.distance?.unit ?? ""}`,
      `block time: ${brief.flightTime?.estimated_hours_display ?? "—"}`,
      `CO2: ${brief.carbon?.co2_kg_total ?? "—"} kg`,
    ]);

    for (const part of ROUTE_BRIEF_PARTS) {
      const failed = brief.errors[part] !== undefined;
      expect(brief[part] === null).toBe(failed);
    }

    if (brief.distance) {
      expect(brief.distance.distance).toBeGreaterThan(0);
    }
    if (brief.flightTime) {
      // The `from`/`to` wire keys again — a broken query builder answers 422 here.
      expect(brief.flightTime.origin).toBe(ORIGIN);
      expect(brief.flightTime.destination).toBe(DESTINATION);
    }
    if (brief.carbon) {
      expect(brief.carbon.departure_icao).toBe(ORIGIN);
      expect(brief.carbon.arrival_icao).toBe(DESTINATION);
      expect(brief.carbon.passengers).toBe(250);
    }
  });

  // ── compose.enrichAdsb ─────────────────────────────────────────────────────

  it("compose.enrichAdsb joins live states with the registry inside its lookup budget", async (ctx) => {
    // Filtered rather than raw: the head of the unfiltered feed is padded with synthetic
    // hex codes (`000001`, `008ba5`) that no registry knows, which would exercise only
    // the `found: false` path. A busy box over London returns real airframes.
    const feed = await live(ctx, "adsb.aircraft(bbox)", () =>
      sky.adsb.aircraft({ bbox: spatial.bboxAround(51.4706, -0.4619, 150), limit: 12 }),
    );
    if (feed.aircraft.length === 0) {
      ctx.skip("compose.enrichAdsb: the live feed is empty right now");
    }

    // Deliberately small: this is a quota guard, and the states beyond it must come
    // back un-enriched rather than un-returned.
    const maxLookups = 3;
    const enriched = await sky.compose.enrichAdsb(feed.aircraft, {
      maxLookups,
      concurrency: 2,
    });

    // One entry per input state, in input order, whatever happened to the lookups.
    expect(enriched).toHaveLength(feed.aircraft.length);
    enriched.forEach((entry, index) => {
      expect(entry.state.icao24).toBe(feed.aircraft[index]?.icao24);
      // `info` and `error` are mutually exclusive.
      expect(entry.info === null || entry.error === null).toBe(true);
    });

    const touched = enriched.filter((entry) => entry.info !== null || entry.error !== null);
    const distinct = new Set(touched.map((entry) => entry.state.icao24.toLowerCase()));
    expect(distinct.size).toBeLessThanOrEqual(maxLookups);

    const found = enriched.filter((entry) => entry.info?.found === true);
    report("compose.enrichAdsb", [
      `states in: ${feed.aircraft.length}, looked up: ${distinct.size} (cap ${maxLookups})`,
      ...found
        .slice(0, 3)
        .map(
          (entry) =>
            `${entry.state.icao24} ${entry.state.callsign?.trim() ?? "—"} → ${
              entry.info?.found === true
                ? (entry.info.aircraft.manufacturer_and_model ?? entry.info.aircraft.registration)
                : "—"
            }`,
        ),
      ...enriched
        .filter((entry) => entry.error !== null)
        .map((entry) => `${entry.state.icao24}: ${describeError(entry.error)}`),
    ]);

    for (const entry of found) {
      expect(entry.info?.found).toBe(true);
    }
  });

  // ── compose.northAmericaCountries ──────────────────────────────────────────

  it("compose.northAmericaCountries works around the pandas NA-as-NaN bug", async (ctx) => {
    const countries = await live(ctx, "compose.northAmericaCountries", () =>
      sky.compose.northAmericaCountries(),
    );

    report("compose.northAmericaCountries", [
      `count: ${countries.length}`,
      `sample: ${countries
        .slice(0, 6)
        .map((country) => `${country.code}/${country.name}`)
        .join(", ")}`,
      `continent values seen: ${[
        ...new Set(countries.map((country) => JSON.stringify(country.continent))),
      ].join(", ")}`,
    ]);

    // 41 rows on the dataset the API ships today; the band leaves room for a refresh
    // of the reference data without turning this into a data test.
    expect(countries.length).toBeGreaterThanOrEqual(30);
    expect(countries.length).toBeLessThanOrEqual(60);
    // The predicate accepts null, "" and "NA" — anything else means it drifted. Widened
    // to `string` on purpose: `Continent` does not include `""`, and the point of the
    // check is what the *wire* carries, not what the union promises.
    for (const country of countries) {
      const continent: string | null | undefined = country.continent;
      const blank = continent === null || continent === undefined || continent.trim() === "";
      expect(blank || continent?.toUpperCase() === "NA").toBe(true);
    }
  });

  // ── adsb.iterAircraft ──────────────────────────────────────────────────────

  it("adsb.iterAircraft really advances the offset and terminates", async (ctx) => {
    const pageSize = 50;
    const maxItems = 150;

    const seen: string[] = [];
    try {
      for await (const state of sky.adsb.iterAircraft({}, { pageSize, maxItems })) {
        seen.push(state.icao24);
      }
    } catch (error) {
      if (UPSTREAM_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
        ctx.skip(`adsb.iterAircraft: ${describeError(error)}`);
      }
      throw error;
    }

    const distinct = new Set(seen);
    report("adsb.iterAircraft", [
      `yielded: ${seen.length} (cap ${maxItems}, page ${pageSize})`,
      `distinct icao24: ${distinct.size}`,
      `pages walked: ${Math.ceil(seen.length / pageSize)}`,
    ]);

    expect(seen.length).toBeLessThanOrEqual(maxItems);
    // The guard against an API that ignores `offset`: the iterator stops on a repeated
    // page, so more than one page's worth of items proves paging actually happened.
    if (seen.length > pageSize) {
      expect(distinct.size).toBeGreaterThan(pageSize);
    }
    // A live feed can hand the same airframe back on two pages when it shifts under
    // the cursor, but wholesale repetition would mean the offset is being ignored.
    expect(distinct.size).toBeGreaterThanOrEqual(Math.floor(seen.length * 0.8));
  });

  // ── helpers on live data ───────────────────────────────────────────────────

  it("weather helpers classify a live METAR", async (ctx) => {
    const metar = await live(ctx, "weather.metar(parsed)", () =>
      sky.weather.metar(ORIGIN, { parsed: true }),
    );

    const category = weatherHelpers.flightCategory(metar);
    const ceiling = weatherHelpers.ceilingFt(metar);
    const visibility = units.parseVisibility(metar.parsed?.visibility);
    const altimeter = units.normalizeAltimeter(metar.parsed?.altimeter);
    const ageMs = weatherHelpers.metarAgeMs(metar);

    report("weather helpers", [
      `raw: ${metar.raw ?? "—"}`,
      `flightCategory: ${category ?? "—"}`,
      `ceilingFt: ${ceiling ?? "—"}`,
      `visibility: ${visibility ? `${visibility.statuteMiles?.toFixed(2)} sm / ${visibility.meters?.toFixed(0)} m${visibility.atLeast ? "+" : ""}` : "—"}`,
      `altimeter: ${altimeter ? `${altimeter.inHg.toFixed(2)} inHg / ${altimeter.hPa.toFixed(1)} hPa (read as ${altimeter.unit})` : "—"}`,
      `age: ${ageMs === null ? "—" : `${Math.round(ageMs / 60_000)} min`}`,
    ]);

    if (category !== null) {
      expect(FLIGHT_CATEGORIES as readonly string[]).toContain(category);
    }
    if (altimeter !== null) {
      // The unit is inferred from magnitude; both renderings must agree.
      expect(altimeter.hPa / altimeter.inHg).toBeCloseTo(units.HPA_PER_INHG, 6);
      // KJFK reports inches of mercury, in a band no hPa reading can reach.
      expect(altimeter.unit).toBe("inHg");
      expect(altimeter.inHg).toBeGreaterThan(25);
      expect(altimeter.inHg).toBeLessThan(35);
    }
    if (ageMs !== null) {
      // A METAR from the future would mean the naive-timestamp handling regressed.
      expect(ageMs).toBeGreaterThan(-10 * 60_000);
    }
  });

  it("spatial.bboxAround feeds adsb.aircraft, and the exports render the result", async (ctx) => {
    // Heathrow, 120 km — a box tight enough to be a real filter and busy enough to
    // usually contain something.
    const centre = { lat: 51.4706, lon: -0.4619 };
    const box = spatial.bboxAround(centre.lat, centre.lon, 120);
    const parsed = spatial.parseBbox(box);

    // The wire form the endpoint wants: south-west corner first.
    expect(box.split(",")).toHaveLength(4);
    expect(parsed.south).toBeLessThan(parsed.north);
    expect(parsed.west).toBeLessThan(parsed.east);

    const feed = await live(ctx, "adsb.aircraft(bbox)", () =>
      // The string goes on the wire untouched — a rejected bbox would be a 422 here.
      sky.adsb.aircraft({ bbox: box, limit: 40 }),
    );

    const located = feed.aircraft.filter(
      (state) => state.latitude !== null && state.longitude !== null,
    );

    report("spatial.bboxAround → adsb.aircraft", [
      `bbox: ${box}`,
      `aircraft: ${feed.aircraft.length} (total_count ${feed.total_count}), located: ${located.length}`,
    ]);

    expect(feed.aircraft.length).toBeLessThanOrEqual(40);
    // The server honoured the filter: every located aircraft is inside the box.
    for (const state of located) {
      expect(state.latitude).toBeGreaterThanOrEqual(parsed.south - 0.5);
      expect(state.latitude).toBeLessThanOrEqual(parsed.north + 0.5);
      expect(state.longitude).toBeGreaterThanOrEqual(parsed.west - 0.5);
      expect(state.longitude).toBeLessThanOrEqual(parsed.east + 0.5);
    }

    if (feed.aircraft.length === 0) {
      ctx.skip("geojson/csv: the box is empty right now");
    }

    // ── GeoJSON ──
    const collection = geojson.adsbToGeojson(feed.aircraft);
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(located.length);
    for (const [index, feature] of collection.features.entries()) {
      const source = located[index] as AdsbAircraft;
      expect(feature.geometry.type).toBe("Point");
      // [longitude, latitude] — the one bug this exporter exists to prevent.
      expect(feature.geometry.coordinates[0]).toBe(source.longitude);
      expect(feature.geometry.coordinates[1]).toBe(source.latitude);
      expect(feature.properties.icao24).toBe(source.icao24);
      // Empty values are dropped rather than emitted as null.
      for (const value of Object.values(feature.properties)) {
        expect(value === null || value === undefined).toBe(false);
      }
    }
    // Round-trips through JSON, which is what a map consumer will do with it.
    expect(() => JSON.parse(JSON.stringify(collection)) as unknown).not.toThrow();

    // ── CSV ──
    const document = csv.toCsv(feed.aircraft);
    const header = document.split("\n")[0] ?? "";
    const columns = header.split(",");
    expect(columns).toContain("icao24");
    expect(columns).toContain("is_on_ground");
    // Wire names, unrenamed: a camelCase column here would mean the exporter reshaped.
    expect(header).not.toMatch(/icao24Hex|groundSpeed|isOnGround/);

    // One record per aircraft. Callsigns and timestamps carry no line breaks on this
    // endpoint, so records and lines coincide — asserted rather than assumed.
    expect(document).not.toContain('"');
    expect(document.split("\n")).toHaveLength(feed.aircraft.length + 1);

    report("geojson + csv exports", [
      `features: ${collection.features.length}`,
      `csv columns: ${columns.join(", ")}`,
      `csv bytes: ${document.length}`,
    ]);
  });

  // ── cache ──────────────────────────────────────────────────────────────────

  it("MemoryCache serves the second identical request without a round trip", async (ctx) => {
    const cache = new MemoryCache({ ttls: { "weather.metar": 300_000 } });
    // Shares this client's connection pool and credentials; only the cache is new.
    const cached = sky.withOptions({ cache });

    let responses = 0;
    const off = cached.onRateLimit(() => {
      responses += 1;
    });

    try {
      const first = await live(ctx, "weather.metar (cache miss)", () =>
        cached.weather.metar(ORIGIN),
      );
      const second = await cached.weather.metar(ORIGIN);

      // Same body, but a *different object*: the cache stores the raw text and
      // re-parses it, so one caller cannot mutate another's response.
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(cache.size).toBe(1);

      // The direct evidence: a cache hit carries the synthetic header and no quota
      // snapshot, because it never touched the network.
      const spec = { method: "GET", path: `/weather/metar/${DESTINATION}` } as const;
      const miss = await cached.requestWithResponse(spec);
      const hit = await cached.requestWithResponse(spec);
      expect(miss.response.headers.get(CACHE_HIT_HEADER)).toBeNull();
      expect(hit.response.headers.get(CACHE_HIT_HEADER)).toBe("hit");
      expect(hit.rateLimit).toBeNull();
      expect(hit.data).toEqual(miss.data);

      report("MemoryCache", [
        `entries: ${cache.size}`,
        `responses carrying quota headers: ${responses} (4 calls issued, 2 expected on the wire)`,
        `quota headers expected from this channel: ${QUOTA_HEADERS_EXPECTED}`,
      ]);

      if (QUOTA_HEADERS_EXPECTED) {
        // Two of the four calls were served from memory, so only two responses can
        // have carried quota headers.
        expect(responses).toBe(2);
      }
    } finally {
      off();
    }
  });

  // ── poll ───────────────────────────────────────────────────────────────────

  it("poll.adsb diffs two live snapshots", async (ctx) => {
    const box = spatial.bboxAround(51.4706, -0.4619, 200);

    interface DiffSummary {
      appeared: number;
      disappeared: number;
      updated: number;
      snapshot: number;
      isFirst: boolean;
    }

    const diffs: DiffSummary[] = [];
    let previous: Set<string> | null = null;
    try {
      for await (const diff of sky.poll.adsb(
        { bbox: box, limit: 60 },
        { interval: 3_000, maxIterations: 2 },
      )) {
        const keys = new Set(Object.keys(diff.snapshot));

        // Every diff list is consistent with the two snapshots it was computed from.
        for (const state of diff.appeared) {
          expect(keys.has(state.icao24)).toBe(true);
          if (previous) expect(previous.has(state.icao24)).toBe(false);
        }
        for (const icao24 of diff.disappeared) {
          expect(keys.has(icao24)).toBe(false);
          expect(previous?.has(icao24)).toBe(true);
        }
        for (const state of diff.updated) {
          expect(keys.has(state.icao24)).toBe(true);
          expect(previous?.has(state.icao24)).toBe(true);
        }

        if (previous === null) {
          // The baseline: everything is new and nothing can have gone.
          expect(diff.isFirst).toBe(true);
          expect(diff.appeared).toHaveLength(keys.size);
          expect(diff.disappeared).toHaveLength(0);
          expect(diff.updated).toHaveLength(0);
        } else {
          expect(diff.isFirst).toBe(false);
        }

        diffs.push({
          appeared: diff.appeared.length,
          disappeared: diff.disappeared.length,
          updated: diff.updated.length,
          snapshot: keys.size,
          isFirst: diff.isFirst,
        });
        previous = keys;
      }
    } catch (error) {
      if (UPSTREAM_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
        ctx.skip(`poll.adsb: ${describeError(error)}`);
      }
      throw error;
    }

    report(
      "poll.adsb (2 iterations, 3 s apart)",
      diffs.map(
        (diff, index) =>
          `#${index + 1} snapshot=${diff.snapshot} appeared=${diff.appeared} disappeared=${diff.disappeared} updated=${diff.updated} isFirst=${diff.isFirst}`,
      ),
    );

    // A survivable failure (429, 5xx) is retried inside the generator and costs an
    // iteration, so one diff is a valid live outcome; zero is not.
    expect(diffs.length).toBeGreaterThanOrEqual(1);
    expect(diffs.length).toBeLessThanOrEqual(2);
    expect(diffs[0]?.isFirst).toBe(true);
  });
});
