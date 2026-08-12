import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type {
  HistoryFlight,
  HistoryFlightsResponse,
  HistoryPositionsResponse,
  HistoryTrackResponse,
} from "../src/models/history.js";
import {
  DEFAULT_ITER_WINDOW_DAYS,
  HISTORY_MAX_WINDOW_DAYS,
  History,
} from "../src/resources/history.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const flightsFixture = loadFixture<HistoryFlightsResponse>("history_flights");
const emptyNoteFixture = loadFixture<HistoryFlightsResponse>("history_empty_note");
const trackFixture = loadFixture<HistoryTrackResponse>("history_track");

const FLIGHT_ID = "7f3c1a54-9d2e-4b8f-a1c6-2e5b7d0f9a13";

function history(options: ClientOptions = {}): History {
  return new History(
    new SkyLink({
      apiKey: "test-key",
      provider: "direct",
      sleep: async () => undefined,
      ...options,
    }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("history.flights", () => {
  it("searches with a single filter under the default ultra plan", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    const result: HistoryFlightsResponse = await history().flights({ registration: "G-STBA" });

    expect(result.count).toBe(2);
    expect(result.flights).toHaveLength(2);
    expect(result.filters.resolved_icao24).toBe("4ca1fb");
    expect(result.flights[0]?.flight_id).toBe(FLIGHT_ID);
    // icao24 comes back UPPERCASE in flight envelopes.
    expect(result.flights[0]?.icao24).toBe("4CA1FB");
    expect(result.flights[0]?.distance_nm).toBeCloseTo(2989.4);
    expect(result.flights[1]?.flight_end).toBeNull();

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/ultra/history/flights");
    expect(request?.fullPath).toBe("/v3.1/ultra/history/flights?registration=G-STBA");
  });

  it("formats Date filters as ISO 8601 and lower-cases icao24", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    await history().flights({
      start: new Date(Date.UTC(2026, 1, 10, 0, 0, 0)),
      end: new Date(Date.UTC(2026, 1, 11, 12, 30, 45)),
      icao24: "4CA1FB",
      callsign: "BAW117",
      departure_icao: "EGLL",
      arrival_icao: "KJFK",
      limit: 25,
    });

    const query = requests[0]?.query;
    expect(query?.get("start")).toBe("2026-02-10T00:00:00Z");
    expect(query?.get("end")).toBe("2026-02-11T12:30:45Z");
    expect(query?.get("icao24")).toBe("4ca1fb");
    expect(query?.get("callsign")).toBe("BAW117");
    expect(query?.get("limit")).toBe("25");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/ultra/history/flights?start=2026-02-10T00%3A00%3A00Z&end=2026-02-11T12%3A30%3A45Z" +
        "&icao24=4ca1fb&callsign=BAW117&departure_icao=EGLL&arrival_icao=KJFK&limit=25",
    );
  });

  it("hands the route confidence over as sent, label or score", async () => {
    // The archive writes a numeric score (`1`, `0.85`) where `/routes` writes the
    // "high" / "low" label the fixture carries; both stay untouched.
    mockJson({
      path: /^\/v3\.1\/ultra\/history\/flights\?/,
      body: {
        ...flightsFixture,
        flights: [{ ...flightsFixture.flights[0], confidence: 1, route_source: "vrs_confirmed" }],
      },
    });

    const result = await history().flights({ registration: "G-STBA" });

    expect(result.flights[0]?.confidence).toBe(1);
    expect(result.flights[0]?.route_source).toBe("vrs_confirmed");
  });

  it("passes an ISO string through untouched", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    await history().flights({ start: "2026-02-10T00:00:00+00:00", callsign: "BAW117" });

    expect(requests[0]?.query.get("start")).toBe("2026-02-10T00:00:00+00:00");
  });

  it("treats a 200 with {note, count: 0} as data, not an error", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: emptyNoteFixture });

    const result = await history().flights({ registration: "G-ZZZZ" });

    expect(result.count).toBe(0);
    expect(result.flights).toEqual([]);
    expect(result.note).toContain("not found in aircraft database");
    expect(result.filters.resolved_icao24).toBeNull();
  });

  it("leaves note undefined on a normal response", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    const result = await history().flights({ registration: "G-STBA" });

    expect(result.note).toBeUndefined();
  });

  it("rejects an unfiltered call before it reaches the network", () => {
    // The API answers 422 here ("At least one of icao24, registration, callsign,
    // departure_icao, arrival_icao must be provided."); the SDK says so first, so
    // a time-window-only search never costs a round trip or a quota unit.
    expect(() => history().flights({})).toThrow(SkyLinkError);
    expect(() => history().flights({ limit: 5 })).toThrow(/at least one filter/);
    expect(() => history().flights({ limit: 5 })).toThrow(
      /icao24, registration, callsign, departure_icao, arrival_icao/,
    );
    expect(requests).toHaveLength(0);
  });

  it("counts a time window alone as no filter", () => {
    expect(() => history().flights({ start: "2026-02-10T00:00:00Z", plan: "mega" })).toThrow(
      SkyLinkError,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("history plan resolution", () => {
  it("uses ultra by default", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    await history().flights({ callsign: "BAW117" });

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/flights");
  });

  it("switches the path prefix when plan: 'mega' is passed per call", async () => {
    mockJson({ path: /^\/v3\.1\/mega\/history\/flights\?/, body: flightsFixture });

    await history().flights({ callsign: "BAW117", plan: "mega" });

    expect(requests[0]?.path).toBe("/v3.1/mega/history/flights");
    expect(requests[0]?.query.has("plan")).toBe(false);
  });

  it("honours the client-level historyPlan option", async () => {
    mockJson({ path: /^\/v3\.1\/mega\/history\/flights\?/, body: flightsFixture });

    await history({ historyPlan: "mega" }).flights({ callsign: "BAW117" });

    expect(requests[0]?.path).toBe("/v3.1/mega/history/flights");
  });

  it("lets a per-call plan win over the client option", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/flights\?/, body: flightsFixture });

    await history({ historyPlan: "mega" }).flights({ callsign: "BAW117", plan: "ultra" });

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/flights");
  });

  it("applies to every method, not just flights", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/mega/history/flight/${FLIGHT_ID}`, body: {} });
    mockJson({
      path: `${DIRECT_PREFIX}/mega/history/flight/${FLIGHT_ID}/track`,
      body: trackFixture,
    });
    mockJson({ path: `${DIRECT_PREFIX}/mega/history/positions/4ca1fb`, body: {} });
    mockJson({ path: `${DIRECT_PREFIX}/mega/history/airport/EGLL/traffic`, body: {} });

    const mega = history({ historyPlan: "mega" });
    await mega.flight(FLIGHT_ID);
    await mega.track(FLIGHT_ID);
    await mega.positions("4ca1fb");
    await mega.airportTraffic("EGLL");

    expect(requests.map((r) => r.path)).toEqual([
      `/v3.1/mega/history/flight/${FLIGHT_ID}`,
      `/v3.1/mega/history/flight/${FLIGHT_ID}/track`,
      "/v3.1/mega/history/positions/4ca1fb",
      "/v3.1/mega/history/airport/EGLL/traffic",
    ]);
  });
});

describe("history.flight", () => {
  it("returns the wide flight shape with the detail-only columns", async () => {
    const detail = {
      ...flightsFixture.flights[0],
      off_block_time: "2026-02-10T08:42:11+00:00",
      on_block_time: "2026-02-10T16:27:53+00:00",
      duration_source: "adsb",
      arrival_distance_nm: 0.4,
      created_at: "2026-02-10T16:30:00+00:00",
      updated_at: "2026-02-10T16:31:12+00:00",
    };
    mockJson({ path: `${DIRECT_PREFIX}/ultra/history/flight/${FLIGHT_ID}`, body: detail });

    const flight: HistoryFlight = await history().flight(FLIGHT_ID);

    expect(flight.flight_id).toBe(FLIGHT_ID);
    expect(flight.duration_source).toBe("adsb");
    expect(flight.arrival_distance_nm).toBeCloseTo(0.4);
    expect(flight.created_at).toBe("2026-02-10T16:30:00+00:00");

    expect(requests[0]?.fullPath).toBe(`/v3.1/ultra/history/flight/${FLIGHT_ID}`);
  });

  it("percent-encodes the flight id and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/ultra/history/flight/a%2Fb`, body: {} });

    await history().flight("a/b");
    expect(requests[0]?.path).toBe("/v3.1/ultra/history/flight/a%2Fb");

    expect(() => history().flight("   ")).toThrow(SkyLinkError);
    expect(() => history().flight("")).toThrow(/flight id/);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/ultra/history/flight/${FLIGHT_ID}`,
      status: 404,
      body: { detail: `Flight '${FLIGHT_ID}' not found` },
    });

    await expect(history().flight(FLIGHT_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("history.track", () => {
  it("returns the track envelope and its positions", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/ultra/history/flight/${FLIGHT_ID}/track`,
      body: trackFixture,
    });

    const track: HistoryTrackResponse = await history().track(FLIGHT_ID);

    expect(track.flight_id).toBe(FLIGHT_ID);
    // Envelope carries the UPPERCASE address …
    expect(track.icao24).toBe("4CA1FB");
    expect(track.registration).toBe("G-STBA");
    expect(track.count).toBe(3);
    expect(track.positions).toHaveLength(3);
    // … while the rows themselves are lower-cased.
    expect(track.positions[0]?.icao24).toBe("4ca1fb");
    // Historical positions use altitude_baro, not the live namespace's `altitude`.
    expect(track.positions[1]?.altitude_baro).toBe(37000);
    expect(track.positions[2]?.altitude_baro).toBeNull();
    expect(track.positions[0]?.is_on_ground).toBe(true);
    expect(track.positions[0]?.gps_spoofed).toBe(false);
    expect(track.positions[1]?.ground_speed).toBeCloseTo(481);

    expect(requests[0]?.fullPath).toBe(`/v3.1/ultra/history/flight/${FLIGHT_ID}/track`);
    expect(requests[0]?.query.has("limit")).toBe(false);
  });

  it("forwards the limit", async () => {
    mockJson({
      path: /^\/v3\.1\/ultra\/history\/flight\/[^/]+\/track\?/,
      body: trackFixture,
    });

    await history().track(FLIGHT_ID, { limit: 500 });

    expect(requests[0]?.fullPath).toBe(`/v3.1/ultra/history/flight/${FLIGHT_ID}/track?limit=500`);
  });
});

describe("history.positions dispatch", () => {
  const positionsBody: HistoryPositionsResponse = {
    icao24: "4CA1FB",
    count: 1,
    positions: trackFixture.positions.slice(0, 1),
    flights: [
      {
        flight_id: FLIGHT_ID,
        callsign: "BAW117",
        flight_number: "BA117",
        departure_airport_icao: "EGLL",
        arrival_airport_icao: "KJFK",
      },
    ],
  };

  it("routes a six-hex identifier to /positions/{icao24}", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/ultra/history/positions/4ca1fb`, body: positionsBody });

    const result: HistoryPositionsResponse = await history().positions("4ca1fb");

    expect(result.icao24).toBe("4CA1FB");
    expect(result.count).toBe(1);
    expect(result.positions[0]?.altitude_baro).toBe(0);
    expect(result.flights[0]?.departure_airport_icao).toBe("EGLL");
    expect(result.registration).toBeUndefined();

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/positions/4ca1fb");
  });

  it("lower-cases an upper-case hex identifier", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/ultra/history/positions/4ca1fb`, body: positionsBody });

    await history().positions("4CA1FB");

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/positions/4ca1fb");
  });

  it("routes anything else to /positions/registration/{reg}", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/ultra/history/positions/registration/G-STBA`,
      body: { ...positionsBody, registration: "G-STBA" },
    });

    const result = await history().positions("G-STBA");

    expect(result.registration).toBe("G-STBA");
    expect(requests[0]?.path).toBe("/v3.1/ultra/history/positions/registration/G-STBA");
  });

  it("routes a six-character non-hex registration to the registration route", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/ultra/history/positions/registration/N12345`,
      body: positionsBody,
    });

    await history().positions("N12345");

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/positions/registration/N12345");
  });

  it("exposes explicit variants that skip the dispatch", async () => {
    mockJson({
      path: /^\/v3\.1\/ultra\/history\/positions\/4ca1fb\?/,
      body: positionsBody,
    });
    mockJson({
      path: /^\/v3\.1\/ultra\/history\/positions\/registration\/4CA1FB\?/,
      body: positionsBody,
    });

    const ns = history();
    await ns.positionsByIcao24("4ca1fb", { limit: 10 });
    // "4CA1FB" looks like an ICAO24 but is forced down the registration route here.
    await ns.positionsByRegistration("4CA1FB", { limit: 10 });

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/positions/4ca1fb");
    expect(requests[1]?.path).toBe("/v3.1/ultra/history/positions/registration/4CA1FB");
  });

  it("serializes the time window and limit", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/positions\/4ca1fb\?/, body: positionsBody });

    await history().positions("4ca1fb", {
      start: new Date(Date.UTC(2026, 1, 10, 8, 0, 0)),
      end: "2026-02-10T17:00:00Z",
      limit: 2000,
    });

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/ultra/history/positions/4ca1fb?start=2026-02-10T08%3A00%3A00Z&end=2026-02-10T17%3A00%3A00Z&limit=2000",
    );
  });

  it("maps a 404 (unknown registration) to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/ultra/history/positions/registration/G-ZZZZ`,
      status: 404,
      body: { detail: "Registration 'G-ZZZZ' not found in aircraft database" },
    });

    await expect(history().positions("G-ZZZZ")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("history.airportTraffic", () => {
  const trafficBody = {
    icao: "EGLL",
    direction: "dep",
    count: 1,
    flights: [
      {
        flight_id: FLIGHT_ID,
        icao24: "4CA1FB",
        callsign: "BAW117",
        flight_number: "BA117",
        aircraft_type_icao: "B77W",
        airline_name: "British Airways",
        departure_airport_icao: "EGLL",
        departure_airport_iata: "LHR",
        arrival_airport_icao: "KJFK",
        arrival_airport_iata: "JFK",
        flight_state: "ARCHIVED",
        takeoff_time: "2026-02-10T08:55:02+00:00",
        landing_time: "2026-02-10T16:19:44+00:00",
        flight_duration_min: 444,
        distance_nm: 2989.4,
      },
    ],
  };

  it("filters by direction and window", async () => {
    mockJson({ path: /^\/v3\.1\/ultra\/history\/airport\/EGLL\/traffic\?/, body: trafficBody });

    const traffic = await history().airportTraffic("EGLL", {
      direction: "dep",
      start: "2026-02-10T00:00:00Z",
      end: "2026-02-11T00:00:00Z",
      limit: 50,
    });

    expect(traffic.icao).toBe("EGLL");
    expect(traffic.direction).toBe("dep");
    expect(traffic.flights[0]?.airline_name).toBe("British Airways");
    // The traffic projection omits columns the search list has.
    expect(traffic.flights[0]?.tail_number).toBeUndefined();

    expect(requests[0]?.path).toBe("/v3.1/ultra/history/airport/EGLL/traffic");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/ultra/history/airport/EGLL/traffic?start=2026-02-10T00%3A00%3A00Z&end=2026-02-11T00%3A00%3A00Z&direction=dep&limit=50",
    );
  });

  it("sends no query at all when called bare", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/ultra/history/airport/EGLL/traffic`, body: trafficBody });

    await history().airportTraffic("EGLL");

    expect(requests[0]?.fullPath).toBe("/v3.1/ultra/history/airport/EGLL/traffic");
  });
});

describe("history.iterFlights", () => {
  const ULTRA_FLIGHTS = /^\/v3\.1\/ultra\/history\/flights\?/;
  const MEGA_FLIGHTS = /^\/v3\.1\/mega\/history\/flights\?/;
  const DAY_MS = 86_400_000;

  function flightsBody(...ids: string[]): HistoryFlightsResponse {
    return {
      filters: flightsFixture.filters,
      count: ids.length,
      flights: ids.map((flight_id) => ({ ...flightsFixture.flights[0], flight_id })),
    };
  }

  async function collect(source: AsyncIterable<HistoryFlight>): Promise<(string | undefined)[]> {
    const out: (string | undefined)[] = [];
    for await (const flight of source) out.push(flight.flight_id);
    return out;
  }

  /** `[start, end]` of every request issued, as epoch milliseconds. */
  function windows(): [number, number][] {
    return requests.map((r) => [
      Date.parse(r.query.get("start") ?? ""),
      Date.parse(r.query.get("end") ?? ""),
    ]);
  }

  it("slices the range into windows and walks them newest first", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-new-1", "f-new-2") });
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-old-1") });

    const seen = await collect(
      history().iterFlights(
        { registration: "G-STBA", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7 },
      ),
    );

    expect(seen).toEqual(["f-new-1", "f-new-2", "f-old-1"]);
    expect(requests.map((r) => r.fullPath)).toEqual([
      "/v3.1/ultra/history/flights?start=2026-01-08T00%3A00%3A00Z&end=2026-01-15T00%3A00%3A00Z&registration=G-STBA",
      "/v3.1/ultra/history/flights?start=2026-01-01T00%3A00%3A00Z&end=2026-01-08T00%3A00%3A00Z&registration=G-STBA",
    ]);
  });

  it("de-duplicates the flights that straddle a window boundary", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1", "f-boundary") });
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-boundary", "f-2") });

    const seen = await collect(
      history().iterFlights(
        { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7 },
      ),
    );

    expect(seen).toEqual(["f-1", "f-boundary", "f-2"]);
  });

  it("falls back to a composite key for rows without a flight_id", async () => {
    const row: HistoryFlight = {
      icao24: "4CA1FB",
      callsign: "BAW117",
      flight_start: "2026-01-09T08:00:00+00:00",
    };
    const body = { filters: flightsFixture.filters, count: 1, flights: [row] };
    mockJson({ path: ULTRA_FLIGHTS, body });
    mockJson({ path: ULTRA_FLIGHTS, body });

    const seen: HistoryFlight[] = [];
    for await (const flight of history().iterFlights(
      { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
      { windowDays: 7 },
    )) {
      seen.push(flight);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.callsign).toBe("BAW117");
  });

  it("stops mid-window once maxItems is reached", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1", "f-2", "f-3") });

    const seen = await collect(
      history().iterFlights(
        { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7, maxItems: 2 },
      ),
    );

    expect(seen).toEqual(["f-1", "f-2"]);
    // The second window is never requested.
    expect(requests).toHaveLength(1);
  });

  it("issues no request at all for maxItems: 0", async () => {
    const seen = await collect(
      history().iterFlights({ callsign: "BAW117" }, { maxItems: 0, windowDays: 90 }),
    );

    expect(seen).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("keeps walking past an empty window", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody() });
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-old") });

    const seen = await collect(
      history().iterFlights(
        { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7 },
      ),
    );

    expect(seen).toEqual(["f-old"]);
    expect(requests).toHaveLength(2);
  });

  it("treats a 200 with {note, count: 0} as an empty window, not an error", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: emptyNoteFixture });

    const seen = await collect(
      history().iterFlights({ registration: "G-ZZZZ" }, { windowDays: 90 }),
    );

    expect(seen).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("defaults the range to the plan's whole retention window, ending now", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });
    const before = Date.now();

    await collect(history().iterFlights({ callsign: "BAW117" }, { windowDays: 90 }));

    const [[start, end] = [0, 0]] = windows();
    expect(end).toBeGreaterThanOrEqual(before - 1_000);
    expect(end - start).toBe(HISTORY_MAX_WINDOW_DAYS.ultra * DAY_MS);
  });

  it("uses the 365-day retention of the mega plan", async () => {
    mockJson({ path: MEGA_FLIGHTS, body: flightsBody("f-1") });

    await collect(history().iterFlights({ callsign: "BAW117" }, { windowDays: 365, plan: "mega" }));

    const [[start, end] = [0, 0]] = windows();
    expect(requests[0]?.path).toBe("/v3.1/mega/history/flights");
    expect(end - start).toBe(HISTORY_MAX_WINDOW_DAYS.mega * DAY_MS);
  });

  it("clamps a window wider than the plan allows instead of earning a 422", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });

    await collect(history().iterFlights({ callsign: "BAW117" }, { windowDays: 400 }));

    const [[start, end] = [0, 0]] = windows();
    expect(end - start).toBe(HISTORY_MAX_WINDOW_DAYS.ultra * DAY_MS);
    expect(requests).toHaveLength(1);
  });

  it("defaults to a seven-day window", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });

    await collect(
      history().iterFlights({
        callsign: "BAW117",
        start: "2026-01-08T00:00:00Z",
        end: "2026-01-15T00:00:00Z",
      }),
    );

    const [[start, end] = [0, 0]] = windows();
    expect(end - start).toBe(DEFAULT_ITER_WINDOW_DAYS * DAY_MS);
  });

  it("lets the options plan win over the params plan", async () => {
    mockJson({ path: MEGA_FLIGHTS, body: flightsBody("f-1") });

    await collect(
      history({ historyPlan: "ultra" }).iterFlights(
        { callsign: "BAW117", plan: "ultra" },
        { plan: "mega", windowDays: 365 },
      ),
    );

    expect(requests[0]?.path).toBe("/v3.1/mega/history/flights");
    expect(requests[0]?.query.has("plan")).toBe(false);
  });

  it("reads a zoneless date string as UTC, the way the backend does", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });

    await collect(
      history().iterFlights(
        { callsign: "BAW117", start: "2026-01-08T00:00:00", end: "2026-01-15T00:00:00" },
        { windowDays: 7 },
      ),
    );

    expect(requests[0]?.query.get("start")).toBe("2026-01-08T00:00:00Z");
    expect(requests[0]?.query.get("end")).toBe("2026-01-15T00:00:00Z");
  });

  it("accepts Date objects for the range", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });

    await collect(
      history().iterFlights(
        {
          callsign: "BAW117",
          start: new Date(Date.UTC(2026, 0, 8)),
          end: new Date(Date.UTC(2026, 0, 15)),
        },
        { windowDays: 7 },
      ),
    );

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/ultra/history/flights?start=2026-01-08T00%3A00%3A00Z&end=2026-01-15T00%3A00%3A00Z&callsign=BAW117",
    );
  });

  it("rejects an unfiltered walk synchronously, before any request", () => {
    expect(() => history().iterFlights({})).toThrow(SkyLinkError);
    expect(() => history().iterFlights({ start: "2026-01-01T00:00:00Z" })).toThrow(
      /at least one filter/,
    );
    expect(() => history().iterFlights({ limit: 5 })).toThrow(/history\.iterFlights\(\)/);
    expect(requests).toHaveLength(0);
  });

  it("rejects an unusable range or window synchronously", () => {
    const ns = history();
    expect(() => ns.iterFlights({ callsign: "BAW117", start: "not-a-date" })).toThrow(
      /not a parseable date/,
    );
    expect(() =>
      ns.iterFlights({
        callsign: "BAW117",
        start: "2026-01-15T00:00:00Z",
        end: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/start before end/);
    expect(() => ns.iterFlights({ callsign: "BAW117" }, { windowDays: 0 })).toThrow(
      /positive number/,
    );
    expect(() => ns.iterFlights({ callsign: "BAW117" }, { maxItems: 1.5 })).toThrow(
      /non-negative integer/,
    );
    expect(requests).toHaveLength(0);
  });

  it("propagates an error from a later window", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });
    mockError({ path: ULTRA_FLIGHTS, status: 500, body: { detail: "boom" } });

    const seen: (string | undefined)[] = [];
    await expect(async () => {
      for await (const flight of history({ maxRetries: 0 }).iterFlights(
        { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7 },
      )) {
        seen.push(flight.flight_id);
      }
    }).rejects.toBeInstanceOf(SkyLinkError);

    expect(seen).toEqual(["f-1"]);
  });

  it("forwards per-call request options to every window", async () => {
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-1") });
    mockJson({ path: ULTRA_FLIGHTS, body: flightsBody("f-2") });

    await collect(
      history().iterFlights(
        { callsign: "BAW117", start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
        { windowDays: 7, headers: { "X-Trace": "iter" } },
      ),
    );

    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.headers["x-trace"]).toBe("iter");
  });
});

describe("history namespace behaviour", () => {
  it("exposes every method", () => {
    const ns = history();
    expect(typeof ns.flights).toBe("function");
    expect(typeof ns.iterFlights).toBe("function");
    expect(typeof ns.flight).toBe("function");
    expect(typeof ns.track).toBe("function");
    expect(typeof ns.positions).toBe("function");
    expect(typeof ns.positionsByIcao24).toBe("function");
    expect(typeof ns.positionsByRegistration).toBe("function");
    expect(typeof ns.airportTraffic).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/ultra\/history\/flights\?/,
      body: flightsFixture,
    });

    await history({ provider: "rapidapi", apiKey: "rapid-key" }).flights({ callsign: "BAW117" });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/ultra/history/flights");
  });
});
