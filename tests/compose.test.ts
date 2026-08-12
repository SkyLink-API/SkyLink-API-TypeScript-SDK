/**
 * `sky.compose` — the aggregating namespace (`src/resources/compose.ts`).
 *
 * The contract under test, in order of importance:
 *
 * 1. **Degradation.** One failing part becomes `errors[part]`; the rest of the brief
 *    still arrives. Only the primary call (airport lookup, flight status) throws, and
 *    anything that is not a `SkyLinkError` always throws.
 * 2. **Parallelism.** Independent sub-requests are in flight at the same time. Proved
 *    with an injected `fetch` that counts overlapping calls — a sequential `await` in
 *    a loop would peak at one.
 * 3. **Quota.** `include`/`exclude` change what is requested, not just what is
 *    returned; `maxLookups` and `limit` cap the fan-out *before* any call goes out.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import {
  NotFoundError,
  PermissionDeniedError,
  ServiceUnavailableError,
  SkyLinkError,
} from "../src/core/errors.js";
import type { FetchLike } from "../src/core/types.js";
import type { AdsbAircraft } from "../src/models/adsb.js";
import type { AircraftLookupResponse } from "../src/models/aircraft.js";
import type { EnrichedAirport } from "../src/models/airports.js";
import type { CarbonEstimate } from "../src/models/carbon.js";
import type { ChartsResponse } from "../src/models/charts.js";
import {
  AIRPORT_BRIEF_PARTS,
  type AirportBriefPart,
  FLIGHT_BRIEF_PARTS,
  ROUTE_BRIEF_PARTS,
} from "../src/models/compose.js";
import type { FlightStatusResponse } from "../src/models/flight-status.js";
import type { NotamsResponse } from "../src/models/notams.js";
import type { CallsignRoute } from "../src/models/routes.js";
import type { DeparturesResponse } from "../src/models/schedules.js";
import type { ParsedMetarResponse, ParsedTafResponse } from "../src/models/weather.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const airportFixture = loadFixture<EnrichedAirport>("airports_search");
// The briefs ask for `parsed=true`, so the decoded fixtures are the ones that match
// what the endpoints actually answer these calls with.
const metarFixture = loadFixture<ParsedMetarResponse>("weather_metar_parsed");
const tafFixture = loadFixture<ParsedTafResponse>("weather_taf_parsed");
const notamsFixture = loadFixture<NotamsResponse>("notams");
const chartsFixture = loadFixture<ChartsResponse>("charts");
const boardFixture = loadFixture<DeparturesResponse>("schedules_departures");
const statusFixture = loadFixture<FlightStatusResponse>("flight_status");
const vrsRouteFixture = loadFixture<CallsignRoute>("routes_vrs");
const airlineRouteFixture = loadFixture<CallsignRoute>("routes_airline");
const carbonFixture = loadFixture<CarbonEstimate>("carbon");
const aircraftFoundFixture = loadFixture<AircraftLookupResponse>("aircraft_found");
const aircraftNotFoundFixture = loadFixture<AircraftLookupResponse>("aircraft_not_found");

const delaysBody = {
  ground_delays: [],
  ground_stops: [],
  closures: [],
  airspace_flow_programs: [],
};

const distanceBody = {
  from_point: { latitude: 51.4, longitude: -0.4, icao_code: "EGLL", iata_code: "LHR", name: "LHR" },
  to_point: { latitude: 40.6, longitude: -73.7, icao_code: "KJFK", iata_code: "JFK", name: "JFK" },
  distance: 2999.5,
  unit: "nm",
  bearing: 288.2,
  bearing_cardinal: "WNW",
  midpoint: { latitude: 52.1, longitude: -41.2, icao_code: null, iata_code: null, name: null },
};

const flightTimeBody = {
  origin: "EGLL",
  destination: "KJFK",
  aircraft_type: null,
  distance_nm: 2999.5,
  estimated_minutes: 443,
  estimated_hours_display: "7h 23m",
  min_minutes: 410,
  max_minutes: 480,
  model_version: "flight-time-v3",
};

/** A board with four rows, so `limit` has something to cut. */
const multiRowBoard: DeparturesResponse = {
  ...boardFixture,
  flights: [
    { ...boardFixture.flights[0], Flight: "C84093" },
    { ...boardFixture.flights[0], Flight: "BA123", Destination: "London" },
    { ...boardFixture.flights[0], Flight: "  ", Destination: "Nowhere" },
    { ...boardFixture.flights[0], Flight: "XX999", Destination: "Elsewhere" },
  ] as DeparturesResponse["flights"],
};

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

function adsbState(icao24: string, callsign = "BAW117"): AdsbAircraft {
  return {
    icao24,
    callsign,
    latitude: 51.4,
    longitude: -0.4,
    altitude: 35000,
    ground_speed: 470,
    track: 288,
    vertical_rate: 0,
    is_on_ground: false,
    last_seen: "2026-02-11T16:05:00",
    first_seen: "2026-02-11T15:00:00",
    registration: null,
    aircraft_type: null,
    airline: null,
    photo_url: null,
  };
}

/**
 * A client whose `fetch` answers from a path→body table after a real delay, while
 * recording how many calls overlap.
 *
 * The delay is what makes the count meaningful: with it, a parallel implementation
 * peaks at the number of requests it launched and a sequential one peaks at 1.
 */
function trackingClient(bodies: Record<string, unknown>, delayMs = 15) {
  const state = { inFlight: 0, maxInFlight: 0, paths: [] as string[] };
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input);
    state.paths.push(url.pathname);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state.inFlight -= 1;
    return new Response(JSON.stringify(bodies[url.pathname] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { sky: client({ fetch: fetchImpl }), state };
}

/** Interceptors for a complete, successful KJFK airport brief. */
function mockAirportBriefParts(): void {
  mockJson({ path: `${DIRECT_PREFIX}/airports/search?icao=KJFK`, body: airportFixture });
  mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: metarFixture });
  mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK?parsed=true`, body: tafFixture });
  mockJson({ path: `${DIRECT_PREFIX}/notams/KJFK`, body: notamsFixture });
  mockJson({ path: `${DIRECT_PREFIX}/delays/faa/KJFK`, body: delaysBody });
  mockJson({ path: `${DIRECT_PREFIX}/charts/KJFK`, body: chartsFixture });
  mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=KJFK`, body: boardFixture });
  mockJson({ path: `${DIRECT_PREFIX}/schedules/arrivals?icao=KJFK`, body: boardFixture });
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("compose.airportBrief", () => {
  it("assembles all eight parts, one request each, with no errors", async () => {
    mockAirportBriefParts();

    const brief = await client().compose.airportBrief("KJFK");

    expect(brief.airport?.ident).toBe(airportFixture.ident);
    expect(brief.metar?.icao).toBe(metarFixture.icao);
    // Weather comes back decoded: the brief is meant to be read, and `flightCategory()`
    // needs the `parsed` block.
    expect(brief.metar?.parsed?.flight_rules).toBe("VFR");
    expect(brief.taf?.parsed?.forecast).toHaveLength(2);
    expect(requests.find((r) => r.path.includes("/weather/metar/"))?.query.get("parsed")).toBe(
      "true",
    );
    expect(requests.find((r) => r.path.includes("/weather/taf/"))?.query.get("parsed")).toBe(
      "true",
    );
    expect(brief.notams?.total).toBe(notamsFixture.total);
    expect(brief.delays?.ground_delays).toEqual([]);
    expect(brief.charts?.icao_code).toBe(chartsFixture.icao_code);
    expect(brief.departures?.direction).toBe("departures");
    expect(brief.arrivals?.direction).toBe("departures"); // fixture echo, not our doing
    expect(brief.errors).toEqual({});

    expect(requests).toHaveLength(8);
    expect(new Set(requests.map((r) => r.path)).size).toBe(8);
  });

  it("keeps every field of the result addressable by its part name", async () => {
    mockAirportBriefParts();

    const brief = await client().compose.airportBrief("KJFK");

    // The include/exclude vocabulary is the result's own keys — drift here would make
    // a valid part name a silent no-op.
    expect(Object.keys(brief).filter((key) => key !== "errors")).toEqual([...AIRPORT_BRIEF_PARTS]);
  });

  it("files one failed part under its name and returns the rest", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/airports/search?icao=KJFK`, body: airportFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: metarFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK?parsed=true`, body: tafFixture });
    mockJson({ path: `${DIRECT_PREFIX}/notams/KJFK`, body: notamsFixture });
    mockError({
      path: `${DIRECT_PREFIX}/delays/faa/KJFK`,
      status: 403,
      body: { detail: "Requires PRO plan" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/charts/KJFK`, body: chartsFixture });
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=KJFK`, body: boardFixture });
    mockJson({ path: `${DIRECT_PREFIX}/schedules/arrivals?icao=KJFK`, body: boardFixture });

    const brief = await client().compose.airportBrief("KJFK");

    expect(brief.delays).toBeNull();
    expect(brief.errors.delays).toBeInstanceOf(PermissionDeniedError);
    expect(brief.errors.delays?.message).toContain("Requires PRO plan");
    expect(Object.keys(brief.errors)).toEqual(["delays"]);
    expect(brief.metar).not.toBeNull();
    expect(brief.charts).not.toBeNull();
  });

  it("throws when the primary airport lookup fails", async () => {
    mockError({ path: `${DIRECT_PREFIX}/airports/search?icao=ZZZZ`, status: 404 });
    mockJson({ path: /\/v3\.1\/weather\/metar\/ZZZZ\?/, body: metarFixture, persist: true });
    mockJson({ path: /\/v3\.1\/weather\/taf\/ZZZZ\?/, body: tafFixture, persist: true });
    mockJson({ path: `${DIRECT_PREFIX}/notams/ZZZZ`, body: notamsFixture, persist: true });
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa/ZZZZ`, body: delaysBody, persist: true });
    mockJson({ path: `${DIRECT_PREFIX}/charts/ZZZZ`, body: chartsFixture, persist: true });
    mockJson({
      path: `${DIRECT_PREFIX}/schedules/departures?icao=ZZZZ`,
      body: boardFixture,
      persist: true,
    });
    mockJson({
      path: `${DIRECT_PREFIX}/schedules/arrivals?icao=ZZZZ`,
      body: boardFixture,
      persist: true,
    });

    await expect(client().compose.airportBrief("ZZZZ")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requests only the parts in include", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: metarFixture });
    mockJson({ path: `${DIRECT_PREFIX}/notams/KJFK`, body: notamsFixture });

    const brief = await client().compose.airportBrief("KJFK", { include: ["metar", "notams"] });

    expect(requests.map((r) => r.path).sort()).toEqual([
      "/v3.1/notams/KJFK",
      "/v3.1/weather/metar/KJFK",
    ]);
    expect(brief.metar).not.toBeNull();
    expect(brief.airport).toBeNull();
    expect(brief.errors).toEqual({});
  });

  it("subtracts exclude from the full set, primary included", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: metarFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK?parsed=true`, body: tafFixture });
    mockJson({ path: `${DIRECT_PREFIX}/notams/KJFK`, body: notamsFixture });
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa/KJFK`, body: delaysBody });

    const brief = await client().compose.airportBrief("KJFK", {
      exclude: ["airport", "charts", "departures", "arrivals"],
    });

    expect(requests).toHaveLength(4);
    expect(requests.some((r) => r.path.includes("/airports/search"))).toBe(false);
    expect(brief.airport).toBeNull();
    expect(brief.errors).toEqual({});
  });

  it("rejects include and exclude together, before any request", async () => {
    await expect(
      client().compose.airportBrief("KJFK", { include: ["metar"], exclude: ["taf"] }),
    ).rejects.toThrow(/either 'include' or 'exclude', not both/);
    expect(requests).toHaveLength(0);
  });

  it("rejects an unknown part name and names the valid ones", async () => {
    const sky = client();
    // Cast: TypeScript already rejects this at compile time; the runtime guard is
    // what protects JavaScript callers.
    const bad = { include: ["weather"] as unknown as AirportBriefPart[] };

    await expect(sky.compose.airportBrief("KJFK", bad)).rejects.toBeInstanceOf(SkyLinkError);
    await expect(sky.compose.airportBrief("KJFK", bad)).rejects.toThrow(
      /unknown part 'weather'.*Valid parts: airport, metar/s,
    );
    expect(requests).toHaveLength(0);
  });

  it("truncates both boards to schedulesLimit without touching the envelope", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=KJFK`, body: multiRowBoard });
    mockJson({ path: `${DIRECT_PREFIX}/schedules/arrivals?icao=KJFK`, body: multiRowBoard });

    const brief = await client().compose.airportBrief("KJFK", {
      include: ["departures", "arrivals"],
      schedulesLimit: 2,
    });

    expect(brief.departures?.flights).toHaveLength(2);
    expect(brief.arrivals?.flights).toHaveLength(2);
    // The board's own count still reports what the airport actually has.
    expect(brief.departures?.total_flights).toBe(multiRowBoard.total_flights);
  });

  it("rejects a nonsensical schedulesLimit", async () => {
    await expect(
      client().compose.airportBrief("KJFK", { schedulesLimit: -1 }),
    ).rejects.toBeInstanceOf(SkyLinkError);
    expect(requests).toHaveLength(0);
  });

  it("issues all eight requests in parallel", async () => {
    const { sky, state } = trackingClient({
      "/v3.1/airports/search": airportFixture,
      "/v3.1/weather/metar/KJFK": metarFixture,
      "/v3.1/weather/taf/KJFK": metarFixture,
      "/v3.1/notams/KJFK": notamsFixture,
      "/v3.1/delays/faa/KJFK": delaysBody,
      "/v3.1/charts/KJFK": chartsFixture,
      "/v3.1/schedules/departures": boardFixture,
      "/v3.1/schedules/arrivals": boardFixture,
    });

    await sky.compose.airportBrief("KJFK");

    expect(state.paths).toHaveLength(8);
    // Sequential awaits would never exceed 1 here.
    expect(state.maxInFlight).toBe(8);
  });

  it("rethrows a non-SkyLinkError from a part instead of filing it", async () => {
    const sky = client();
    mockJson({ path: `${DIRECT_PREFIX}/airports/search?icao=KJFK`, body: airportFixture });
    (sky.weather as unknown as { metar: () => Promise<never> }).metar = () =>
      Promise.reject(new TypeError("bug in a caller-supplied fetch"));

    await expect(
      sky.compose.airportBrief("KJFK", { include: ["airport", "metar"] }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("compose.flightBrief", () => {
  it("skips the registry lookup when the status carries no registration", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    expect(brief.status?.flight_number).toBe(statusFixture.flight_number);
    // The live source publishes no registration — not an error, just no aircraft.
    expect(brief.aircraft).toBeNull();
    expect(brief.errors).toEqual({});
    expect(requests.some((r) => r.path.includes("/aircraft/"))).toBe(false);

    expect(brief.route?.source).toBe("vrs");
    expect(brief.carbon?.co2_kg_total).toBe(carbonFixture.co2_kg_total);
    const carbonQuery = requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query;
    expect(carbonQuery?.get("departure_icao")).toBe("EGLL");
    expect(carbonQuery?.get("arrival_icao")).toBe("KJFK");
  });

  it("follows a registration through to the registry record", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: { ...statusFixture, registration: "g-stba" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/registration/G-STBA`, body: aircraftFoundFixture });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    // The whole envelope, not the details: `found` must stay readable.
    expect(brief.aircraft?.found).toBe(true);
    expect(brief.aircraft?.found === true && brief.aircraft.aircraft.registration).toBe("G-STBA");
    expect(brief.aircraft?.found === true && brief.aircraft.aircraft.icao_type).toBe("B77W");
    expect(brief.errors).toEqual({});
    // The type designator the lookup produced conditions the emission estimate — which
    // is why carbon waits for both parallel steps instead of riding along with them.
    expect(
      requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query.get("aircraft_type"),
    ).toBe("B77W");
  });

  it("looks the route up by the designator it was given, not by the payload's echo", async () => {
    // `/flight_status` normalizes the designator to its IATA display form on the way out
    // ("BAW117" in, "BA 117" out), while `/routes/callsign` only finds the exact VRS
    // record — the one carrying the airport pair, and therefore the CO₂ — under the ICAO
    // callsign. So the caller's argument wins and the echo is merely the fallback;
    // preferring the echo downgraded every ICAO callsign to the airline-level fallback
    // and made the documented "pass BAW117 for the exact match" impossible. Confirmed on
    // the live API, 2026-08-12: BAW117 → `source: "vrs"`, EGLL→KJFK.
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BAW117`,
      body: { ...statusFixture, flight_number: "BA 117" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BAW117`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BAW117");

    const paths = requests.map((r) => r.path);
    expect(paths).toContain("/v3.1/routes/callsign/BAW117");
    expect(paths).not.toContain("/v3.1/routes/callsign/BA117");
    expect(brief.route?.source).toBe("vrs");
  });

  it("falls back to the payload's number, spaces removed, when the argument is not one", async () => {
    // `"--"` is the scraper's way of writing "no value", so it cannot be looked up; the
    // status payload's own number takes over, in the unspaced form the route wants.
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/--`,
      body: { ...statusFixture, flight_number: "BA 456" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA456`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("--");

    expect(requests.map((r) => r.path)).toContain("/v3.1/routes/callsign/BA456");
    expect(brief.route?.source).toBe("vrs");
  });

  it("skips the route entirely when neither the argument nor the payload is a number", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/--`,
      body: { ...statusFixture, flight_number: "  " },
    });

    const brief = await client().compose.flightBrief("--");

    // No callsign to look up, so no request and no error: `route` and `carbon` — which
    // has nothing to price from either — are simply absent.
    expect(requests.some((r) => r.path.includes("/routes/callsign/"))).toBe(false);
    expect(requests.some((r) => r.path.includes("/carbon/estimate"))).toBe(false);
    expect(brief.route).toBeNull();
    expect(brief.carbon).toBeNull();
    expect(brief.errors).toEqual({});
  });

  it("keeps the found:false sentinel instead of flattening it to null", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: { ...statusFixture, aircraft: { registration: "ZZ-ZZZ" } },
    });
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/registration/ZZ-ZZZ`,
      body: aircraftNotFoundFixture,
    });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    // `found: false` is the registry answering "not mine" — a 200, not a failure, and
    // not the same thing as `null`, which means no lookup was made at all.
    expect(brief.aircraft).not.toBeNull();
    expect(brief.aircraft?.found).toBe(false);
    expect(brief.errors.aircraft).toBeUndefined();
    expect(requests.some((r) => r.path === "/v3.1/aircraft/registration/ZZ-ZZZ")).toBe(true);
  });

  it("finds a registration under any of the spellings the API family uses", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: { ...statusFixture, aircraft: { tail_number: "g-stba" } },
    });
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/registration/G-STBA`, body: aircraftFoundFixture });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: airlineRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    expect(brief.aircraft?.found).toBe(true);
  });

  it("ignores the scraped placeholders where a registration would be", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: { ...statusFixture, registration: "--" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: vrsRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    expect(brief.aircraft).toBeNull();
    expect(requests.some((r) => r.path.includes("/aircraft/"))).toBe(false);
  });

  it("prices carbon by callsign when the route is the airline-level fallback", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: airlineRouteFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    expect(brief.route?.source).toBe("airline_routes");
    // Its IATA airports belong to the airline's network, not to this flight — but the
    // endpoint resolves a callsign itself, and does it against the flights actually flown.
    const carbonQuery = requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query;
    expect(carbonQuery?.get("callsign")).toBe("BA123");
    expect(carbonQuery?.has("departure_icao")).toBe(false);
    expect(brief.carbon).not.toBeNull();
    expect(brief.errors).toEqual({});
  });

  it("prices carbon by callsign when the VRS pair is unusable", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({
      path: `${DIRECT_PREFIX}/routes/callsign/BA123`,
      // A round-robin callsign: identical airports are a 422 on /carbon/estimate.
      body: { ...vrsRouteFixture, departure_icao: "EGLL", arrival_icao: "EGLL" },
    });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    await client().compose.flightBrief("BA123");

    const carbonQuery = requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query;
    expect(carbonQuery?.get("callsign")).toBe("BA123");
    expect(carbonQuery?.has("arrival_icao")).toBe(false);
  });

  it("files a failed route and still prices carbon from the callsign", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockError({
      path: `${DIRECT_PREFIX}/routes/callsign/BA123`,
      status: 503,
      body: { detail: "Route dataset is loading" },
      times: 4,
    });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123");

    expect(brief.status).not.toBeNull();
    expect(brief.route).toBeNull();
    expect(brief.errors.route).toBeInstanceOf(ServiceUnavailableError);
    // The route was only ever the better of two ways to price the flight.
    expect(brief.carbon).not.toBeNull();
    expect(brief.errors.carbon).toBeUndefined();
    expect(requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query.get("callsign")).toBe(
      "BA123",
    );
  });

  it("throws when the primary flight-status call fails", async () => {
    mockError({ path: `${DIRECT_PREFIX}/flight_status/XX999`, status: 404 });

    await expect(client().compose.flightBrief("XX999")).rejects.toBeInstanceOf(NotFoundError);
    // Nothing downstream was even attempted.
    expect(requests).toHaveLength(1);
  });

  it("prices carbon from the callsign alone when route is excluded", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const brief = await client().compose.flightBrief("BA123", { exclude: ["route"] });

    expect(requests.map((r) => r.path)).toEqual([
      "/v3.1/flight_status/BA123",
      "/v3.1/carbon/estimate",
    ]);
    expect(brief.route).toBeNull();
    expect(brief.carbon).not.toBeNull();
  });

  it("makes no carbon request when carbon itself is excluded", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BA123`, body: vrsRouteFixture });

    const brief = await client().compose.flightBrief("BA123", { exclude: ["carbon"] });

    expect(requests.some((r) => r.path.includes("/carbon/"))).toBe(false);
    expect(brief.carbon).toBeNull();
  });

  it("exposes exactly the documented parts as result fields", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const brief = await client().compose.flightBrief("BA123", { include: ["status"] });

    expect(Object.keys(brief).filter((key) => key !== "errors")).toEqual([...FLIGHT_BRIEF_PARTS]);
  });

  it("runs the registry lookup and the route lookup at the same time", async () => {
    const { sky, state } = trackingClient({
      "/v3.1/flight_status/BA123": { ...statusFixture, registration: "G-STBA" },
      "/v3.1/aircraft/registration/G-STBA": aircraftFoundFixture,
      "/v3.1/routes/callsign/BA123": airlineRouteFixture,
      "/v3.1/carbon/estimate": carbonFixture,
    });

    await sky.compose.flightBrief("BA123");

    expect(state.paths).toEqual([
      "/v3.1/flight_status/BA123",
      "/v3.1/aircraft/registration/G-STBA",
      "/v3.1/routes/callsign/BA123",
      // Last, and alone: it is priced from what those two returned.
      "/v3.1/carbon/estimate",
    ]);
    // The status must come first (it carries the registration); the two after it
    // must not wait for each other.
    expect(state.maxInFlight).toBe(2);
  });
});

describe("compose.routeBrief", () => {
  function mockRouteBriefParts(): void {
    mockJson({ path: /\/v3\.1\/distance\?/, body: distanceBody });
    mockJson({ path: /\/v3\.1\/ml\/flight-time\?/, body: flightTimeBody });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL?parsed=true`, body: metarFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: metarFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/EGLL?parsed=true`, body: tafFixture });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK?parsed=true`, body: tafFixture });
    mockJson({ path: /\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });
  }

  it("assembles all seven parts and sends the endpoints' own parameter names", async () => {
    mockRouteBriefParts();

    const brief = await client().compose.routeBrief("EGLL", "KJFK");

    expect(brief.distance?.distance).toBe(distanceBody.distance);
    expect(brief.flightTime?.estimated_hours_display).toBe("7h 23m");
    // Decoded at both ends, like the airport brief's weather.
    expect(brief.originMetar?.parsed?.flight_rules).toBe("VFR");
    expect(brief.destinationMetar).not.toBeNull();
    expect(brief.originTaf?.parsed?.forecast[0]?.type).toBe("FROM");
    expect(brief.destinationTaf).not.toBeNull();
    for (const path of ["/v3.1/weather/metar/EGLL", "/v3.1/weather/taf/KJFK"]) {
      expect(requests.find((r) => r.path === path)?.query.get("parsed")).toBe("true");
    }
    expect(brief.carbon?.methodology).toBe("ICAO-Doc9988");
    expect(brief.errors).toEqual({});
    expect(Object.keys(brief).filter((key) => key !== "errors")).toEqual([...ROUTE_BRIEF_PARTS]);

    const ml = requests.find((r) => r.path === "/v3.1/ml/flight-time")?.query;
    expect(ml?.get("from")).toBe("EGLL");
    expect(ml?.get("to")).toBe("KJFK");
    const distance = requests.find((r) => r.path === "/v3.1/distance")?.query;
    expect(distance?.get("from_icao")).toBe("EGLL");
    expect(distance?.get("to_icao")).toBe("KJFK");
  });

  it("keeps a failure on the end of the route it happened at", async () => {
    mockJson({ path: /\/v3\.1\/distance\?/, body: distanceBody });
    mockJson({ path: /\/v3\.1\/ml\/flight-time\?/, body: flightTimeBody });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL?parsed=true`, body: metarFixture });
    mockError({ path: `${DIRECT_PREFIX}/weather/metar/ZZZZ?parsed=true`, status: 404 });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/EGLL?parsed=true`, body: tafFixture });
    mockError({ path: `${DIRECT_PREFIX}/weather/taf/ZZZZ?parsed=true`, status: 404 });
    mockError({ path: /\/v3\.1\/carbon\/estimate\?/, status: 422 });

    const brief = await client().compose.routeBrief("EGLL", "ZZZZ");

    expect(brief.originMetar).not.toBeNull();
    expect(brief.destinationMetar).toBeNull();
    expect(brief.errors.destinationMetar).toBeInstanceOf(NotFoundError);
    expect(brief.errors.destinationTaf).toBeInstanceOf(NotFoundError);
    expect(brief.errors.carbon).toBeInstanceOf(SkyLinkError);
    // No primary part: a route brief where everything but the distance failed is
    // still a route brief.
    expect(brief.distance).not.toBeNull();
    expect(Object.keys(brief.errors).sort()).toEqual([
      "carbon",
      "destinationMetar",
      "destinationTaf",
    ]);
  });

  it("passes aircraftType to both models and passengers to carbon", async () => {
    mockRouteBriefParts();

    await client().compose.routeBrief("EGLL", "KJFK", {
      aircraftType: "B77W",
      passengers: 280,
    });

    const ml = requests.find((r) => r.path === "/v3.1/ml/flight-time")?.query;
    expect(ml?.get("aircraft")).toBe("B77W");
    const carbon = requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query;
    expect(carbon?.get("aircraft_type")).toBe("B77W");
    expect(carbon?.get("passengers")).toBe("280");
    // Passengers only make sense per-flight; the time model has no such parameter.
    expect(ml?.has("passengers")).toBe(false);
  });

  it("omits both when they are not given, letting each endpoint default", async () => {
    mockRouteBriefParts();

    await client().compose.routeBrief("EGLL", "KJFK");

    expect(requests.find((r) => r.path === "/v3.1/ml/flight-time")?.query.has("aircraft")).toBe(
      false,
    );
    const carbon = requests.find((r) => r.path === "/v3.1/carbon/estimate")?.query;
    expect(carbon?.has("aircraft_type")).toBe(false);
    expect(carbon?.has("passengers")).toBe(false);
  });

  it("requests only what include asks for", async () => {
    mockJson({ path: /\/v3\.1\/distance\?/, body: distanceBody });
    mockJson({ path: /\/v3\.1\/ml\/flight-time\?/, body: flightTimeBody });

    const brief = await client().compose.routeBrief("EGLL", "KJFK", {
      include: ["distance", "flightTime"],
    });

    expect(requests).toHaveLength(2);
    expect(brief.originMetar).toBeNull();
    expect(brief.carbon).toBeNull();
  });

  it("issues all seven requests in parallel", async () => {
    const { sky, state } = trackingClient({
      "/v3.1/distance": distanceBody,
      "/v3.1/ml/flight-time": flightTimeBody,
      "/v3.1/weather/metar/EGLL": metarFixture,
      "/v3.1/weather/metar/KJFK": metarFixture,
      "/v3.1/weather/taf/EGLL": metarFixture,
      "/v3.1/weather/taf/KJFK": metarFixture,
      "/v3.1/carbon/estimate": carbonFixture,
    });

    await sky.compose.routeBrief("EGLL", "KJFK");

    expect(state.paths).toHaveLength(7);
    expect(state.maxInFlight).toBe(7);
  });
});

describe("compose.enrichAdsb", () => {
  it("looks each address up once and joins the answer back onto every state", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/4ca1fb?photos=false`,
      body: aircraftFoundFixture,
    });

    const states = [adsbState("4ca1fb"), adsbState("4CA1FB", "BAW118"), adsbState("4ca1fb")];
    const enriched = await client().compose.enrichAdsb(states);

    expect(enriched).toHaveLength(3);
    // Case-normalized: the feed sends lower-case, the registry upper-case.
    expect(requests.map((r) => r.path)).toEqual(["/v3.1/aircraft/icao24/4ca1fb"]);
    for (const entry of enriched) {
      expect(entry.info?.found).toBe(true);
      expect(entry.error).toBeNull();
    }
    expect(enriched[1]?.state.callsign).toBe("BAW118");
  });

  it("asks for photos=false by default, overriding the endpoint's own default", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/icao24/4ca1fb?photos=false`, body: {} });

    await client().compose.enrichAdsb([adsbState("4ca1fb")]);

    // The endpoint defaults to photos=true, which is its slow path — and this method
    // makes up to 50 of these calls.
    expect(requests[0]?.query.get("photos")).toBe("false");
  });

  it("fetches photos when asked to", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/icao24/4ca1fb?photos=true`, body: {} });

    await client().compose.enrichAdsb([adsbState("4ca1fb")], { photos: true });

    expect(requests[0]?.query.get("photos")).toBe("true");
  });

  it("stops looking up beyond maxLookups without issuing the request", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/aaaaaa?photos=false`,
      body: aircraftFoundFixture,
    });
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/bbbbbb?photos=false`,
      body: aircraftFoundFixture,
    });

    const states = [
      adsbState("aaaaaa"),
      adsbState("bbbbbb"),
      adsbState("cccccc"),
      adsbState("dddddd"),
    ];
    const enriched = await client().compose.enrichAdsb(states, { maxLookups: 2 });

    expect(requests).toHaveLength(2);
    expect(enriched[0]?.info).not.toBeNull();
    expect(enriched[1]?.info).not.toBeNull();
    expect(enriched[2]).toEqual({ state: states[2], info: null, error: null });
    expect(enriched[3]?.info).toBeNull();
    expect(enriched[3]?.error).toBeNull();
  });

  it("makes no request at all with a zero budget", async () => {
    const enriched = await client().compose.enrichAdsb([adsbState("4ca1fb")], { maxLookups: 0 });

    expect(requests).toHaveLength(0);
    expect(enriched[0]?.info).toBeNull();
  });

  it("reports a failed lookup on its own aircraft", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/4ca1fb?photos=false`,
      body: aircraftFoundFixture,
    });
    mockError({
      path: `${DIRECT_PREFIX}/aircraft/icao24/aaaaaa?photos=false`,
      status: 429,
      times: 4,
    });

    const enriched = await client().compose.enrichAdsb([adsbState("4ca1fb"), adsbState("aaaaaa")]);

    expect(enriched[0]?.info?.found).toBe(true);
    expect(enriched[1]?.info).toBeNull();
    expect(enriched[1]?.error).toBeInstanceOf(SkyLinkError);
  });

  it("passes over states without a usable address", async () => {
    const states = [
      adsbState(""),
      { ...adsbState("nothex"), icao24: "nothex" },
      adsbState("~abc123"),
    ];

    const enriched = await client().compose.enrichAdsb(states);

    expect(requests).toHaveLength(0);
    expect(enriched.map((entry) => entry.info)).toEqual([null, null, null]);
  });

  it("rejects a nonsensical maxLookups before any request", async () => {
    await expect(
      client().compose.enrichAdsb([adsbState("4ca1fb")], { maxLookups: 1.5 }),
    ).rejects.toBeInstanceOf(SkyLinkError);
    expect(requests).toHaveLength(0);
  });

  it("keeps at most `concurrency` lookups in flight", async () => {
    const bodies: Record<string, unknown> = {};
    const states: AdsbAircraft[] = [];
    for (let i = 0; i < 8; i++) {
      const hex = `a0000${i}`;
      bodies[`/v3.1/aircraft/icao24/${hex}`] = aircraftFoundFixture;
      states.push(adsbState(hex));
    }
    const { sky, state } = trackingClient(bodies);

    await sky.compose.enrichAdsb(states);

    expect(state.paths).toHaveLength(8);
    // Parallel, but bounded: the default is five.
    expect(state.maxInFlight).toBe(5);
  });
});

describe("compose.schedulesWithStatus", () => {
  it("takes the flight number from the row's PascalCase Flight cell", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=LIMC`, body: multiRowBoard });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const board = await client().compose.schedulesWithStatus("LIMC", { limit: 2 });

    expect(board).toHaveLength(2);
    expect(board[0]?.entry.Time).toBe(multiRowBoard.flights[0]?.Time);
    expect(board[0]?.entry.Destination).toBe("Seoul");
    expect(board[0]?.status?.status).toBe(statusFixture.status);
    expect(board[1]?.error).toBeNull();
    expect(requests.map((r) => r.path)).toContain("/v3.1/flight_status/C84093");
  });

  it("truncates the board before spending a request per row", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=LIMC`, body: multiRowBoard });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });

    await client().compose.schedulesWithStatus("LIMC", { limit: 1 });

    expect(requests).toHaveLength(2); // the board plus one status
  });

  it("skips a row whose Flight cell is blank and reports a failed status per row", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=LIMC`, body: multiRowBoard });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockError({ path: `${DIRECT_PREFIX}/flight_status/XX999`, status: 404 });

    const board = await client().compose.schedulesWithStatus("LIMC");

    expect(board).toHaveLength(4);
    expect(board[2]?.status).toBeNull();
    expect(board[2]?.error).toBeNull();
    expect(board[3]?.status).toBeNull();
    expect(board[3]?.error).toBeInstanceOf(NotFoundError);
    // Three numbers, not four: the blank row costs nothing.
    expect(requests.filter((r) => r.path.startsWith("/v3.1/flight_status/"))).toHaveLength(3);
  });

  it("reads the arrivals board when asked", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/schedules/arrivals?icao=LIMC`,
      body: { ...multiRowBoard, direction: "arrivals" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });

    const board = await client().compose.schedulesWithStatus("LIMC", {
      direction: "arrivals",
      limit: 1,
    });

    expect(requests[0]?.path).toBe("/v3.1/schedules/arrivals");
    expect(board[0]?.entry.Origin).toBeUndefined(); // fixture is a departure row
    expect(board[0]?.status).not.toBeNull();
  });

  it("sends a three-letter code as iata, not icao", async () => {
    // /schedules takes icao= or iata= and rejects the wrong one; this is the only part
    // of the method that touches the code, so it can accept either flavour.
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?iata=LHR`, body: multiRowBoard });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });

    const board = await client().compose.schedulesWithStatus("LHR", { limit: 1 });

    expect(requests[0]?.query.get("iata")).toBe("LHR");
    expect(requests[0]?.query.has("icao")).toBe(false);
    expect(board).toHaveLength(1);
  });

  it("requests a repeated flight number once and shares the answer", async () => {
    const repeated: DeparturesResponse = {
      ...boardFixture,
      flights: [
        { ...boardFixture.flights[0], Flight: "BA123" },
        // The same flight, in the board's other spelling — one number, one request.
        { ...boardFixture.flights[0], Flight: "BA 123", Destination: "London" },
        { ...boardFixture.flights[0], Flight: "C84093", Destination: "Seoul" },
      ] as DeparturesResponse["flights"],
    };
    mockJson({ path: `${DIRECT_PREFIX}/schedules/departures?icao=LIMC`, body: repeated });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/C84093`, body: statusFixture });

    const board = await client().compose.schedulesWithStatus("LIMC");

    expect(requests.filter((r) => r.path.startsWith("/v3.1/flight_status/"))).toHaveLength(2);
    expect(board[0]?.status).not.toBeNull();
    expect(board[1]?.status).toBe(board[0]?.status);
    expect(board[2]?.status).not.toBeNull();
  });

  it("throws when the board itself fails — there is no row to report it on", async () => {
    mockError({ path: `${DIRECT_PREFIX}/schedules/departures?icao=ZZZZ`, status: 404 });

    await expect(client().compose.schedulesWithStatus("ZZZZ")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects an unusable concurrency before spending the board request", async () => {
    await expect(client().compose.schedulesWithStatus("LIMC", { concurrency: 0 })).rejects.toThrow(
      /concurrency must be a positive integer/,
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects a misspelled direction before any request", async () => {
    const sky = client();
    // Cast: TypeScript rejects this already; the guard is for JavaScript callers.
    const bad = { direction: "departure" as unknown as "departures" };

    await expect(sky.compose.schedulesWithStatus("LIMC", bad)).rejects.toBeInstanceOf(SkyLinkError);
    expect(requests).toHaveLength(0);
  });

  it("polls the rows in parallel", async () => {
    const bodies: Record<string, unknown> = {
      "/v3.1/schedules/departures": multiRowBoard,
      "/v3.1/flight_status/C84093": statusFixture,
      "/v3.1/flight_status/BA123": statusFixture,
      "/v3.1/flight_status/XX999": statusFixture,
    };
    const { sky, state } = trackingClient(bodies);

    await sky.compose.schedulesWithStatus("LIMC");

    expect(state.paths).toHaveLength(4); // board + 3 numbered rows
    expect(state.maxInFlight).toBe(3);
  });
});

describe("compose.northAmericaCountries", () => {
  it("returns the countries pandas dropped, in one request", async () => {
    mockJson({
      path: /\/v3\.1\/countries/,
      body: {
        countries: [
          {
            id: 1,
            code: "US",
            name: "United States",
            continent: null,
            wikipedia_link: null,
            keywords: null,
          },
          {
            id: 2,
            code: "CA",
            name: "Canada",
            continent: "",
            wikipedia_link: null,
            keywords: null,
          },
          {
            id: 3,
            code: "MX",
            name: "Mexico",
            continent: "  ",
            wikipedia_link: null,
            keywords: null,
          },
          {
            id: 4,
            code: "GB",
            name: "United Kingdom",
            continent: "EU",
            wikipedia_link: null,
            keywords: null,
          },
          {
            id: 5,
            code: "BR",
            name: "Brazil",
            continent: "SA",
            wikipedia_link: null,
            keywords: null,
          },
          {
            id: 6,
            code: "CU",
            name: "Cuba",
            continent: "NA",
            wikipedia_link: null,
            keywords: null,
          },
        ],
        total: 6,
      },
    });

    const countries = await client().compose.northAmericaCountries();

    // null, "" and whitespace all mean "pandas ate the NA"; a literal "NA" is what a
    // fixed backend would send, and must keep working rather than start returning
    // nothing.
    expect(countries.map((country) => country.code)).toEqual(["US", "CA", "MX", "CU"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query.has("continent")).toBe(false);
  });

  it("survives an empty dataset", async () => {
    mockJson({ path: /\/v3\.1\/countries/, body: { countries: [], total: 0 } });

    expect(await client().compose.northAmericaCountries()).toEqual([]);
  });
});
