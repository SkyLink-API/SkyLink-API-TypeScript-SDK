import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { BadRequestError, NotFoundError } from "../src/core/errors.js";
import type { DistanceResponse } from "../src/models/distance.js";
import { Distance } from "../src/resources/distance.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const distanceBody = {
  from_point: {
    latitude: 40.639751,
    longitude: -73.778925,
    icao_code: "KJFK",
    iata_code: "JFK",
    name: "John F Kennedy International Airport",
  },
  to_point: {
    latitude: 51.4706,
    longitude: -0.461941,
    icao_code: "EGLL",
    iata_code: "LHR",
    name: "London Heathrow Airport",
  },
  distance: 2991.01,
  unit: "nm",
  bearing: 51.35,
  bearing_cardinal: "NE",
  midpoint: {
    latitude: 52.216674,
    longitude: -41.302671,
    icao_code: null,
    iata_code: null,
    name: null,
  },
};

function distance(options: ClientOptions = {}): Distance {
  return new Distance(
    new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("distance.calculate", () => {
  it("resolves both endpoints from airport codes", async () => {
    mockJson({ path: /^\/v3\.1\/distance\?/, body: distanceBody });

    const leg: DistanceResponse = await distance().calculate({
      from_icao: "KJFK",
      to_icao: "EGLL",
    });

    expect(leg.distance).toBeCloseTo(2991.01);
    expect(leg.unit).toBe("nm");
    expect(leg.bearing).toBeCloseTo(51.35);
    expect(leg.bearing_cardinal).toBe("NE");
    expect(leg.from_point.icao_code).toBe("KJFK");
    expect(leg.from_point.iata_code).toBe("JFK");
    expect(leg.to_point.name).toBe("London Heathrow Airport");
    // A computed midpoint carries no airport identity.
    expect(leg.midpoint.icao_code).toBeNull();
    expect(leg.midpoint.latitude).toBeCloseTo(52.216674);

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/distance");
    expect(request?.fullPath).toBe("/v3.1/distance?from_icao=KJFK&to_icao=EGLL");
    expect(request?.query.has("unit")).toBe(false);
  });

  it("accepts raw coordinates for both endpoints and a unit override", async () => {
    mockJson({ path: /^\/v3\.1\/distance\?/, body: { ...distanceBody, unit: "km" } });

    const leg = await distance().calculate({
      from_lat: 40.64,
      from_lon: -73.78,
      to_lat: 51.47,
      to_lon: -0.46,
      unit: "km",
    });

    expect(leg.unit).toBe("km");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/distance?from_lat=40.64&from_lon=-73.78&to_lat=51.47&to_lon=-0.46&unit=km",
    );
  });

  it("mixes an airport code with coordinates", async () => {
    mockJson({ path: /^\/v3\.1\/distance\?/, body: distanceBody });

    await distance().calculate({ from_lat: 40.64, from_lon: -73.78, to_icao: "EGLL" });

    expect(requests[0]?.query.get("from_lat")).toBe("40.64");
    expect(requests[0]?.query.get("from_lon")).toBe("-73.78");
    expect(requests[0]?.query.get("to_icao")).toBe("EGLL");
    expect(requests[0]?.query.has("from_icao")).toBe(false);
    expect(requests[0]?.query.has("to_lat")).toBe(false);
  });

  it("serializes a zero coordinate instead of dropping it", async () => {
    mockJson({ path: /^\/v3\.1\/distance\?/, body: distanceBody });

    await distance().calculate({ from_lat: 0, from_lon: 0, to_icao: "EGLL", unit: "mi" });

    expect(requests[0]?.fullPath).toBe("/v3.1/distance?to_icao=EGLL&from_lat=0&from_lon=0&unit=mi");
  });

  it("surfaces a 400 for a half-specified endpoint", async () => {
    mockError({
      path: /^\/v3\.1\/distance\?/,
      status: 400,
      body: { detail: "Provide either to_icao or both to_lat and to_lon." },
    });

    await expect(distance().calculate({ from_icao: "KJFK", to_icao: "" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("maps an unresolvable airport code to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/distance\?/,
      status: 404,
      body: { detail: "Airport not found: ZZZZ" },
    });

    await expect(
      distance().calculate({ from_icao: "ZZZZ", to_icao: "EGLL" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/distance\?/, body: distanceBody });

    await distance().calculate(
      { from_icao: "KJFK", to_icao: "EGLL" },
      { headers: { "X-Trace": "abc" } },
    );

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("distance resource wiring", () => {
  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/distance\?/,
      body: distanceBody,
    });

    await distance({ provider: "rapidapi", apiKey: "rapid-key" }).calculate({
      from_icao: "KJFK",
      to_icao: "EGLL",
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/distance");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
