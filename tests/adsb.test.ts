import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError } from "../src/core/errors.js";
import type {
  AdsbAircraftResponse,
  AdsbHealthResponse,
  AdsbStatisticsResponse,
} from "../src/models/adsb.js";
import { Adsb } from "../src/resources/adsb.js";
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
  return new Adsb(new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }));
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
