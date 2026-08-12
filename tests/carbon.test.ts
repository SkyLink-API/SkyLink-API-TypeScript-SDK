import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type { CarbonEstimate } from "../src/models/carbon.js";
import { Carbon } from "../src/resources/carbon.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const carbonFixture = loadFixture<CarbonEstimate>("carbon");

/** The fixture was captured with a callsign; strip the three conditional keys. */
const {
  callsign: _callsign,
  callsign_resolved: _callsignResolved,
  route_confidence: _routeConfidence,
  ...airportsOnlyFixture
} = carbonFixture;

function carbon(options: ClientOptions = {}): Carbon {
  return new Carbon(
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

describe("carbon.estimate", () => {
  it("estimates from an airport pair", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: airportsOnlyFixture });

    const estimate: CarbonEstimate = await carbon().estimate({
      departure_icao: "EGLL",
      arrival_icao: "KJFK",
      aircraft_type: "B77W",
    });

    expect(estimate.distance_km).toBeCloseTo(5555.1);
    expect(estimate.distance_nm).toBeCloseTo(2999.5);
    expect(estimate.co2_kg_total).toBeCloseTo(205538.7);
    expect(estimate.co2_kg_per_passenger).toBeCloseTo(519.0);
    expect(estimate.methodology).toBe("ICAO-Doc9988");
    expect(estimate.aircraft_category).toBe("widebody");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/carbon/estimate");
    expect(request?.fullPath).toBe(
      "/v3.1/carbon/estimate?departure_icao=EGLL&arrival_icao=KJFK&aircraft_type=B77W",
    );
    expect(request?.query.has("callsign")).toBe(false);
    expect(request?.query.has("include_rfi")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("omits the three conditional keys entirely when no callsign was sent", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: airportsOnlyFixture });

    const estimate = await carbon().estimate({ departure_icao: "EGLL", arrival_icao: "KJFK" });

    // The keys are ABSENT, not null — `in` must be false, not merely the value nullish.
    expect("callsign" in estimate).toBe(false);
    expect("callsign_resolved" in estimate).toBe(false);
    expect("route_confidence" in estimate).toBe(false);
    expect(estimate.callsign).toBeUndefined();
    expect(estimate.callsign_resolved).toBeUndefined();
    expect(estimate.route_confidence).toBeUndefined();

    // ...while co2_equivalent_* are present-but-null without include_rfi.
    expect("co2_equivalent_kg_total" in estimate).toBe(true);
    expect(estimate.co2_equivalent_kg_total).toBeNull();
    expect(estimate.co2_equivalent_kg_per_passenger).toBeNull();
    expect(estimate.rfi_applied).toBe(false);
    expect(estimate.rfi_factor).toBeCloseTo(1.9);
  });

  it("adds the conditional keys when a callsign was sent", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: carbonFixture });

    const estimate = await carbon().estimate({ callsign: "BAW117" });

    expect("callsign" in estimate).toBe(true);
    expect(estimate.callsign).toBe("BAW117");
    expect(estimate.callsign_resolved).toBe(true);
    expect(estimate.route_confidence).toBe("high");

    expect(requests[0]?.fullPath).toBe("/v3.1/carbon/estimate?callsign=BAW117");
    expect(requests[0]?.query.has("departure_icao")).toBe(false);
  });

  it("fills co2_equivalent_* when include_rfi is requested", async () => {
    mockJson({
      path: /^\/v3\.1\/carbon\/estimate\?/,
      body: {
        ...airportsOnlyFixture,
        rfi_applied: true,
        co2_equivalent_kg_total: 390523.5,
        co2_equivalent_kg_per_passenger: 986.1,
        notes:
          "RFI (Radiative Forcing Index) accounts for non-CO2 climate effects " +
          "(contrails, ozone) at altitude. IPCC value 1.9x used.",
      },
    });

    const estimate = await carbon().estimate({
      departure_icao: "EGLL",
      arrival_icao: "KJFK",
      passengers: 2,
      include_rfi: true,
    });

    expect(estimate.rfi_applied).toBe(true);
    expect(estimate.co2_equivalent_kg_total).toBeCloseTo(390523.5);
    expect(estimate.co2_equivalent_kg_per_passenger).toBeCloseTo(986.1);

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/carbon/estimate?departure_icao=EGLL&arrival_icao=KJFK&passengers=2&include_rfi=true",
    );
  });

  it("sends include_rfi=false explicitly when asked", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: airportsOnlyFixture });

    await carbon().estimate({ departure_icao: "EGLL", arrival_icao: "KJFK", include_rfi: false });

    expect(requests[0]?.query.get("include_rfi")).toBe("false");
  });

  it("rejects a call that identifies no flight, before touching the network", () => {
    expect(() => carbon().estimate({})).toThrow(SkyLinkError);
    expect(() => carbon().estimate({ departure_icao: "EGLL" })).toThrow(/callsign/);
    expect(() => carbon().estimate({ arrival_icao: "KJFK" })).toThrow(
      /departure_icao.*arrival_icao/,
    );
    expect(() => carbon().estimate({ aircraft_type: "B77W", passengers: 3 })).toThrow(SkyLinkError);

    // Blank strings count as missing, not as a valid airport pair.
    expect(() => carbon().estimate({ departure_icao: "  ", arrival_icao: "KJFK" })).toThrow(
      SkyLinkError,
    );
    expect(() => carbon().estimate({ callsign: "   " })).toThrow(SkyLinkError);

    expect(requests).toHaveLength(0);
  });

  it("accepts a callsign alone or a single airport alongside it", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: carbonFixture, times: 2 });

    await carbon().estimate({ callsign: "BAW117", departure_icao: "EGLL" });
    expect(requests[0]?.fullPath).toBe("/v3.1/carbon/estimate?departure_icao=EGLL&callsign=BAW117");

    await carbon().estimate({ callsign: " baw117 " });
    expect(requests[1]?.query.get("callsign")).toBe("baw117");
  });

  it("narrows the literal unions of confidence, distance_source and passengers_source", async () => {
    mockJson({
      path: /^\/v3\.1\/carbon\/estimate\?/,
      body: {
        ...carbonFixture,
        confidence: "medium",
        distance_source: "adsb_track",
        passengers_source: "provided",
        passengers: 2,
      },
    });

    const estimate = await carbon().estimate({ callsign: "BAW117", passengers: 2 });

    expect(estimate.confidence).toBe("medium");
    expect(estimate.distance_source).toBe("adsb_track");
    expect(estimate.passengers_source).toBe("provided");

    // Compile-time: the unions are closed, so an unknown member is a type error.
    // @ts-expect-error "unknown" is not a CarbonConfidence
    const bogus: typeof estimate.confidence = "unknown";
    expect(bogus).toBe("unknown");
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/carbon\/estimate\?/,
      status: 404,
      body: { detail: "Departure airport not found: ZZZZ" },
    });

    await expect(
      carbon().estimate({ departure_icao: "ZZZZ", arrival_icao: "KJFK" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/carbon\/estimate\?/, body: airportsOnlyFixture });

    await carbon().estimate(
      { departure_icao: "EGLL", arrival_icao: "KJFK" },
      { headers: { "X-Trace": "abc" } },
    );

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/carbon\/estimate\?/,
      body: airportsOnlyFixture,
    });

    await carbon({ provider: "rapidapi", apiKey: "rapid-key" }).estimate({
      departure_icao: "EGLL",
      arrival_icao: "KJFK",
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/carbon/estimate");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
