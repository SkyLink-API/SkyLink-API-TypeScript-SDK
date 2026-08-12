import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError } from "../src/core/errors.js";
import type {
  AdsbAircraft,
  AdsbAircraftResponse,
  AdsbHealthResponse,
  AdsbStatisticsResponse,
} from "../src/models/adsb.js";
import { Adsb, DEFAULT_ITER_PAGE_SIZE, MAX_ITER_PAGE_SIZE } from "../src/resources/adsb.js";
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

const feedFixture = loadFixture<AdsbAircraftResponse>("adsb_aircraft");

function adsb(options: ClientOptions = {}): Adsb {
  return new Adsb(
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

describe("adsb.aircraft", () => {
  it("fetches the unfiltered feed and sends no query parameters", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: feedFixture });

    const feed: AdsbAircraftResponse = await adsb().aircraft();

    expect(feed.total_count).toBe(2);
    expect(feed.aircraft).toHaveLength(2);
    expect(feed.aircraft[0]?.icao24).toBe("4ca1fb");
    expect(feed.aircraft[0]?.callsign).toBe("BAW117");
    expect(feed.aircraft[0]?.altitude).toBe(36000);
    expect(feed.aircraft[0]?.is_on_ground).toBe(false);
    // Naive ISO: the API serializes these without a Z suffix or offset.
    expect(feed.timestamp).toBe("2026-02-11T12:00:04.881233");
    expect(feed.aircraft[0]?.last_seen).not.toMatch(/Z$/);

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/adsb/aircraft");
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("keeps every positional field nullable for an aircraft without a position", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: feedFixture });

    const feed = await adsb().aircraft();
    const stateless = feed.aircraft[1];

    expect(stateless?.icao24).toBe("a1b2c3");
    expect(stateless?.latitude).toBeNull();
    expect(stateless?.longitude).toBeNull();
    expect(stateless?.altitude).toBeNull();
    expect(stateless?.ground_speed).toBeNull();
    expect(stateless?.track).toBeNull();
    expect(stateless?.vertical_rate).toBeNull();
    expect(stateless?.is_on_ground).toBeNull();
    expect(stateless?.callsign).toBeNull();
    expect(stateless?.registration).toBeNull();
    expect(stateless?.photo_url).toBeNull();
    // The two timestamps are the only fields guaranteed alongside icao24.
    expect(stateless?.first_seen).toBe("2026-02-11T11:59:12.110447");
  });

  it("serializes every filter, with the bbox tuple comma-joined", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: feedFixture });

    await adsb().aircraft({
      icao24: "4ca1fb",
      callsign: "BAW",
      lat: 51.47,
      lon: -0.45,
      radius: 100,
      bbox: [51, -1, 52, 0],
      min_alt: 10000,
      max_alt: 40000,
      min_speed: 200,
      max_speed: 500,
      registration: "G-STBA",
      airline: "British Airways",
      photos: true,
      limit: 50,
      offset: 100,
    });

    const request = requests[0];
    expect(request?.path).toBe("/v3.1/adsb/aircraft");
    expect(request?.query.get("icao24")).toBe("4ca1fb");
    expect(request?.query.get("callsign")).toBe("BAW");
    expect(request?.query.get("lat")).toBe("51.47");
    expect(request?.query.get("lon")).toBe("-0.45");
    expect(request?.query.get("radius")).toBe("100");
    expect(request?.query.get("bbox")).toBe("51,-1,52,0");
    expect(request?.query.get("min_alt")).toBe("10000");
    expect(request?.query.get("max_alt")).toBe("40000");
    expect(request?.query.get("min_speed")).toBe("200");
    expect(request?.query.get("max_speed")).toBe("500");
    expect(request?.query.get("registration")).toBe("G-STBA");
    expect(request?.query.get("airline")).toBe("British Airways");
    expect(request?.query.get("photos")).toBe("true");
    expect(request?.query.get("limit")).toBe("50");
    expect(request?.query.get("offset")).toBe("100");
  });

  it("passes a pre-joined bbox string through untouched", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: feedFixture });

    await adsb().aircraft({ bbox: "51,-1,52,0" });

    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/aircraft?bbox=51%2C-1%2C52%2C0");
  });

  it("omits photos rather than sending the server-side default of false", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: feedFixture });

    await adsb().aircraft({});

    expect(requests[0]?.query.has("photos")).toBe(false);
    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/aircraft");
  });

  it("sends offset=0 explicitly when asked, and an uncapped limit", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: feedFixture });

    await adsb().aircraft({ limit: 25000, offset: 0 });

    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/aircraft?limit=25000&offset=0");
    expect(requests[0]?.query.get("offset")).toBe("0");
  });

  it("sends photos=false explicitly when asked", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: feedFixture });

    await adsb().aircraft({ photos: false });

    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/aircraft?photos=false");
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: feedFixture });

    await adsb().aircraft(undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });

  it("surfaces a 400 from a malformed bounding box", async () => {
    mockError({
      path: /^\/v3\.1\/adsb\/aircraft\?/,
      status: 400,
      body: { detail: "Invalid bounding box format: lat1 < lat2 and lon1 < lon2" },
    });

    await expect(adsb().aircraft({ bbox: "52,0,51,-1" })).rejects.toBeInstanceOf(SkyLinkError);
  });
});

describe("adsb.statistics", () => {
  const statsBody = {
    total_aircraft: 4691,
    positioned_aircraft: 4102,
    on_ground: 288,
    airborne: 3814,
    altitude_stats: { min_altitude: 25, max_altitude: 45000, avg_altitude: 22317.4 },
    timestamp: "2026-02-11T12:00:04.881233",
  };

  it("returns the aggregate counts", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft/statistics`, body: statsBody });

    const stats: AdsbStatisticsResponse = await adsb().statistics();

    expect(stats.total_aircraft).toBe(4691);
    expect(stats.positioned_aircraft).toBe(4102);
    expect(stats.on_ground).toBe(288);
    expect(stats.airborne).toBe(3814);
    expect(stats.altitude_stats.max_altitude).toBe(45000);
    expect(stats.altitude_stats.avg_altitude).toBeCloseTo(22317.4);

    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/aircraft/statistics");
  });

  it("survives an empty altitude_stats object", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/adsb/aircraft/statistics`,
      body: { ...statsBody, airborne: 0, altitude_stats: {} },
    });

    const stats: AdsbStatisticsResponse = await adsb().statistics();

    expect(stats.altitude_stats).toEqual({});
    expect(stats.altitude_stats.min_altitude).toBeUndefined();
    expect(stats.altitude_stats.avg_altitude).toBeUndefined();
  });
});

describe("adsb.health", () => {
  it("reports the pipeline status", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/adsb/health`,
      body: {
        status: "healthy",
        connected: true,
        active_aircraft_count: 4691,
        connection_uptime: null,
        last_message_received: "2026-02-11T12:00:03.412870",
      },
    });

    const health: AdsbHealthResponse = await adsb().health();

    expect(health.status).toBe("healthy");
    expect(health.connected).toBe(true);
    expect(health.active_aircraft_count).toBe(4691);
    expect(health.connection_uptime).toBeNull();
    expect(health.last_message_received).toBe("2026-02-11T12:00:03.412870");

    expect(requests[0]?.fullPath).toBe("/v3.1/adsb/health");
  });

  it("carries the connected-but-silent status verbatim", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/adsb/health`,
      body: {
        status: "connected_no_data",
        connected: true,
        active_aircraft_count: 0,
        connection_uptime: 128.5,
        last_message_received: null,
      },
    });

    const health = await adsb().health();

    expect(health.status).toBe("connected_no_data");
    expect(health.active_aircraft_count).toBe(0);
    expect(health.connection_uptime).toBeCloseTo(128.5);
    expect(health.last_message_received).toBeNull();
  });
});

describe("adsb.iterAircraft", () => {
  const template = feedFixture.aircraft[0] as AdsbAircraft;

  function page(...icao24s: string[]): AdsbAircraftResponse {
    return {
      aircraft: icao24s.map((icao24) => ({ ...template, icao24 })),
      total_count: 5,
      timestamp: feedFixture.timestamp,
    };
  }

  async function collect(source: AsyncIterable<AdsbAircraft>): Promise<string[]> {
    const out: string[] = [];
    for await (const state of source) out.push(state.icao24);
    return out;
  }

  it("pages with limit/offset until a short page ends it", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002") });
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00003", "a00004") });
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00005") });

    const seen = await collect(adsb().iterAircraft({}, { pageSize: 2 }));

    expect(seen).toEqual(["a00001", "a00002", "a00003", "a00004", "a00005"]);
    expect(requests.map((r) => r.fullPath)).toEqual([
      "/v3.1/adsb/aircraft?limit=2&offset=0",
      "/v3.1/adsb/aircraft?limit=2&offset=2",
      "/v3.1/adsb/aircraft?limit=2&offset=4",
    ]);
  });

  it("stops on an empty first page without a second request", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page() });

    expect(await collect(adsb().iterAircraft({}, { pageSize: 2 }))).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("stops mid-page once maxItems is reached", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002") });
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00003") });

    const seen = await collect(adsb().iterAircraft({}, { pageSize: 2, maxItems: 3 }));

    expect(seen).toEqual(["a00001", "a00002", "a00003"]);
    // The last page asks for exactly the remaining item, not a whole page.
    expect(requests.map((r) => r.fullPath)).toEqual([
      "/v3.1/adsb/aircraft?limit=2&offset=0",
      "/v3.1/adsb/aircraft?limit=1&offset=2",
    ]);
  });

  it("truncates within the first page when maxItems is smaller than it", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002", "a00003") });

    const seen = await collect(adsb().iterAircraft({}, { pageSize: 10, maxItems: 2 }));

    expect(seen).toEqual(["a00001", "a00002"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query.get("limit")).toBe("2");
  });

  it("issues no request at all for maxItems: 0", async () => {
    expect(await collect(adsb().iterAircraft({}, { maxItems: 0 }))).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("gives up when the API ignores offset and repeats a page", async () => {
    // Same two aircraft, twice: without this guard the iterator would loop forever.
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002") });
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002") });

    const seen = await collect(adsb().iterAircraft({}, { pageSize: 2 }));

    expect(seen).toEqual(["a00001", "a00002"]);
    expect(requests).toHaveLength(2);
  });

  it("defaults to a page of 100 and clamps an oversized one", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page() });
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page() });

    await collect(adsb().iterAircraft());
    await collect(adsb().iterAircraft({}, { pageSize: 100_000 }));

    expect(requests[0]?.query.get("limit")).toBe(String(DEFAULT_ITER_PAGE_SIZE));
    expect(requests[1]?.query.get("limit")).toBe(String(MAX_ITER_PAGE_SIZE));
  });

  it("keeps the filters, honours a starting offset and forwards request options", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001") });

    await collect(
      adsb().iterAircraft(
        { bbox: [51, -1, 52, 0], min_alt: 10000, offset: 40, limit: 999 },
        { pageSize: 5, headers: { "X-Trace": "iter" } },
      ),
    );

    // `limit` from the params is ignored; `pageSize` owns it.
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/adsb/aircraft?bbox=51%2C-1%2C52%2C0&min_alt=10000&limit=5&offset=40",
    );
    expect(requests[0]?.headers["x-trace"]).toBe("iter");
  });

  it("rejects an unusable page size or item cap before touching the network", () => {
    expect(() => adsb().iterAircraft({}, { pageSize: 0 })).toThrow(SkyLinkError);
    expect(() => adsb().iterAircraft({}, { pageSize: 2.5 })).toThrow(/positive integer/);
    expect(() => adsb().iterAircraft({}, { maxItems: -1 })).toThrow(/non-negative integer/);
    expect(requests).toHaveLength(0);
  });

  it("propagates an error from a later page", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: page("a00001", "a00002") });
    mockError({ path: /^\/v3\.1\/adsb\/aircraft\?/, status: 500, body: { detail: "boom" } });

    const seen: string[] = [];
    await expect(async () => {
      for await (const state of adsb({ maxRetries: 0 }).iterAircraft({}, { pageSize: 2 })) {
        seen.push(state.icao24);
      }
    }).rejects.toBeInstanceOf(SkyLinkError);

    expect(seen).toEqual(["a00001", "a00002"]);
  });
});

describe("adsb resource wiring", () => {
  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/adsb/health",
      body: { status: "offline", connected: false, active_aircraft_count: 0 },
    });

    await adsb({ provider: "rapidapi", apiKey: "rapid-key" }).health();

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/adsb/health");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
