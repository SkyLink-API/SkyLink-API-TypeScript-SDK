import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, ServiceUnavailableError, SkyLinkError } from "../src/core/errors.js";
import type {
  AirlineCallsignRoute,
  AirportRoutesResponse,
  CallsignRoute,
  RoutePairsResponse,
  VrsCallsignRoute,
} from "../src/models/routes.js";
import { Routes } from "../src/resources/routes.js";
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

const vrsFixture = loadFixture<VrsCallsignRoute>("routes_vrs");
const airlineFixture = loadFixture<AirlineCallsignRoute>("routes_airline");

function routes(options: ClientOptions = {}): Routes {
  return new Routes(new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }));
}

/**
 * Compiles only while `source` is a working discriminant: each branch reaches for
 * fields the other one does not have.
 */
function describeRoute(route: CallsignRoute): string {
  if (route.source === "vrs") {
    return `${route.callsign} ${route.departure_icao}-${route.arrival_icao} (${route.airports.length} airports)`;
  }
  return `${route.airline_name} ${route.routes.length}/${route.total_routes}`;
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("routes.byCallsign", () => {
  it("returns the vrs branch for an exact callsign match", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BAW117`, body: vrsFixture });

    const route: CallsignRoute = await routes().byCallsign("BAW117");

    expect(route.source).toBe("vrs");
    if (route.source !== "vrs") throw new Error("expected the vrs branch");

    expect(route.callsign).toBe("BAW117");
    expect(route.callsign_prefix).toBe("BAW");
    expect(route.airline_code).toBe("BA");
    expect(route.departure_icao).toBe("EGLL");
    expect(route.arrival_icao).toBe("KJFK");
    expect(route.airports).toEqual(["EGLL", "KJFK"]);
    expect(route.confidence).toBe("high");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/routes/callsign/BAW117");
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("returns the airline_routes branch, which carries no callsign key at all", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BAW999`, body: airlineFixture });

    const route = await routes().byCallsign("BAW999");

    expect(route.source).toBe("airline_routes");
    if (route.source !== "airline_routes") throw new Error("expected the airline branch");

    expect(route.callsign_prefix).toBe("BAW");
    expect(route.airline_name).toBe("British Airways");
    expect(route.routes).toHaveLength(3);
    expect(route.routes[0]?.src).toBe("LHR");
    expect(route.routes[0]?.dst).toBe("JFK");
    expect(route.routes[0]?.km).toBe(5555);
    expect(route.routes[0]?.duration_min).toBe(445);
    expect(route.total_routes).toBe(412);
    expect(route.confidence).toBe("low");

    // The key is absent on the wire, not null — and absent from the type as well.
    expect("callsign" in route).toBe(false);
    expect("departure_icao" in route).toBe(false);
    expect("arrival_icao" in route).toBe(false);
  });

  it("narrows on source: only the vrs branch exposes callsign", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BAW999`, body: airlineFixture });

    const route = await routes().byCallsign("BAW999");

    // Before narrowing, `callsign` is not on the union — the union is real, not a
    // widened superset of both branches.
    // @ts-expect-error `callsign` exists only on the "vrs" branch
    const beforeNarrowing: unknown = route.callsign;
    expect(beforeNarrowing).toBeUndefined();

    expect(describeRoute(route)).toBe("British Airways 3/412");
    expect(describeRoute(vrsFixture)).toBe("BAW117 EGLL-KJFK (2 airports)");
  });

  it("percent-encodes the callsign segment and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/callsign/BAW%2F117`, body: vrsFixture });

    await routes().byCallsign("BAW/117");
    expect(requests[0]?.path).toBe("/v3.1/routes/callsign/BAW%2F117");

    expect(() => routes().byCallsign("   ")).toThrow(SkyLinkError);
    expect(() => routes().byCallsign("")).toThrow(/callsign/);
  });

  it("maps a 404 to NotFoundError and a 503 to ServiceUnavailableError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/routes/callsign/ZZZ999`,
      status: 404,
      body: { detail: "No routes found for callsign prefix in 'ZZZ999'." },
    });
    await expect(routes().byCallsign("ZZZ999")).rejects.toBeInstanceOf(NotFoundError);

    mockError({
      path: `${DIRECT_PREFIX}/routes/callsign/BAW117`,
      status: 503,
      body: { detail: "Route data not yet loaded. Please retry in a few seconds." },
      persist: true,
    });
    await expect(routes().byCallsign("BAW117", { maxRetries: 0 })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});

describe("routes.byAirport", () => {
  const airportBody: AirportRoutesResponse = {
    code: "LHR",
    direction: "dep",
    count: 2,
    routes: [
      {
        departure: "LHR",
        arrival: "JFK",
        airlines: ["British Airways", "American Airlines", "Virgin Atlantic"],
        km: 5555,
        duration_min: 445,
      },
      {
        departure: "LHR",
        arrival: "CDG",
        airlines: ["British Airways"],
        km: 348,
        duration_min: 80,
      },
    ],
  };

  it("filters by direction and limit", async () => {
    mockJson({ path: /^\/v3\.1\/routes\/airport\/LHR\?/, body: airportBody });

    const result: AirportRoutesResponse = await routes().byAirport("LHR", {
      direction: "dep",
      limit: 25,
    });

    expect(result.code).toBe("LHR");
    expect(result.direction).toBe("dep");
    expect(result.count).toBe(2);
    expect(result.routes[0]?.airlines).toHaveLength(3);
    expect(result.routes[0]?.km).toBe(5555);

    expect(requests[0]?.path).toBe("/v3.1/routes/airport/LHR");
    expect(requests[0]?.fullPath).toBe("/v3.1/routes/airport/LHR?direction=dep&limit=25");
  });

  it("omits both filters when they are unset and accepts an ICAO code", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/airport/EGLL`, body: airportBody });

    await routes().byAirport("EGLL");

    expect(requests[0]?.fullPath).toBe("/v3.1/routes/airport/EGLL");
    expect(requests[0]?.query.has("direction")).toBe(false);
    expect(requests[0]?.query.has("limit")).toBe(false);
  });

  it("rejects an empty airport code", () => {
    expect(() => routes().byAirport("  ")).toThrow(SkyLinkError);
    expect(() => routes().byAirport("")).toThrow(/code/);
    expect(requests).toHaveLength(0);
  });
});

describe("routes.pairs", () => {
  const pairsBody: RoutePairsResponse = {
    count: 1,
    routes: [
      {
        departure: "LHR",
        arrival: "JFK",
        airlines: ["British Airways", "American Airlines"],
        km: 5555,
        duration_min: 445,
      },
    ],
  };

  it("sends both filters and the limit", async () => {
    mockJson({ path: /^\/v3\.1\/routes\/pairs\?/, body: pairsBody });

    const result: RoutePairsResponse = await routes().pairs({
      departure: "LHR",
      arrival: "JFK",
      limit: 10,
    });

    expect(result.count).toBe(1);
    expect(result.routes[0]?.departure).toBe("LHR");
    expect(result.routes[0]?.arrival).toBe("JFK");
    expect(result.routes[0]?.duration_min).toBe(445);

    expect(requests[0]?.path).toBe("/v3.1/routes/pairs");
    expect(requests[0]?.fullPath).toBe("/v3.1/routes/pairs?departure=LHR&arrival=JFK&limit=10");
  });

  it("works unfiltered and with a single filter", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/routes/pairs`, body: pairsBody });
    await routes().pairs();
    expect(requests[0]?.fullPath).toBe("/v3.1/routes/pairs");

    mockJson({ path: /^\/v3\.1\/routes\/pairs\?/, body: pairsBody });
    await routes().pairs({ arrival: "JFK" });
    expect(requests[1]?.fullPath).toBe("/v3.1/routes/pairs?arrival=JFK");
    expect(requests[1]?.query.has("departure")).toBe(false);
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/routes/pairs",
      body: pairsBody,
    });

    await routes({ provider: "rapidapi", apiKey: "rapid-key" }).pairs();

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/routes/pairs");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
