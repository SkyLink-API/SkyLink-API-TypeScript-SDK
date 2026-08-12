import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type {
  AirportsByIpResponse,
  AirportsNearbyResponse,
  AirportsTextSearchResponse,
  EnrichedAirport,
} from "../src/models/airports.js";
import { Airports } from "../src/resources/airports.js";
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

/**
 * `airports_search.json` is the router's OpenAPI example, which omits the
 * `country` / `region` blocks and the two `search_*` keys the endpoint always
 * adds. They are layered on here so the full response shape is exercised.
 */
const airportFixture = loadFixture<EnrichedAirport>("airports_search");

const enrichedBody = {
  ...airportFixture,
  country: {
    id: 302672,
    code: "US",
    name: "United States",
    continent: "NA",
    wikipedia_link: "https://en.wikipedia.org/wiki/United_States",
    keywords: "America",
  },
  region: {
    id: 306125,
    code: "US-NY",
    local_code: "NY",
    name: "New York",
    continent: "NA",
    iso_country: "US",
    wikipedia_link: "https://en.wikipedia.org/wiki/New_York",
    keywords: null,
  },
  search_code: "KJFK",
  search_type: "ICAO",
};

function airports(options: ClientOptions = {}): Airports {
  return new Airports(
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

describe("airports.search", () => {
  it("looks an airport up by ICAO and returns the enriched record", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\?/, body: enrichedBody });

    const airport: EnrichedAirport = await airports().search({ icao: "KJFK" });

    expect(airport.ident).toBe("KJFK");
    expect(airport.type).toBe("large_airport");
    expect(airport.iata_code).toBe("JFK");
    expect(airport.elevation_ft).toBe(13);
    expect(airport.scheduled_service).toBe("yes");
    expect(airport.search_code).toBe("KJFK");
    expect(airport.search_type).toBe("ICAO");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/airports/search?icao=KJFK");
    expect(request?.query.has("iata")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("keeps the numeric strings of the documented payload as strings", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\?/, body: enrichedBody });

    const airport = await airports().search({ icao: "KJFK" });

    const runway = airport.runways[0];
    expect(runway?.length_ft).toBe(14511);
    expect(runway?.surface).toBe("ASP");
    // Booleans-as-numeric-strings, not 1/0 and not true/false.
    expect(runway?.lighted).toBe("1");
    expect(runway?.closed).toBe("0");
    expect(runway?.le_ident).toBe("04L");
    expect(runway?.he_ident).toBe("22R");

    const frequency = airport.frequencies[0];
    expect(frequency?.type).toBe("TWR");
    expect(frequency?.frequency_mhz).toBe("119.1");
    expect(typeof frequency?.frequency_mhz).toBe("string");

    const navaid = airport.navaids[0];
    expect(navaid?.ident).toBe("JFK");
    expect(navaid?.type).toBe("VOR-DME");
    expect(navaid?.frequency_khz).toBe("115900");
    expect(typeof navaid?.frequency_khz).toBe("string");
  });

  it("passes the same fields through unchanged when the API sends numbers", async () => {
    // What the live API actually answers: it loads the OurAirports CSVs with
    // pandas, so fully numeric columns arrive as numbers while the published
    // examples show them quoted. Both are handed over verbatim — hence the
    // `string | number | null` union — and neither is coerced.
    mockJson({
      path: /^\/v3\.1\/airports\/search\?/,
      body: {
        ...enrichedBody,
        icao_code: "KJFK",
        runways: [{ ...enrichedBody.runways[0], lighted: 1, closed: 0 }],
        frequencies: [{ ...enrichedBody.frequencies[0], frequency_mhz: 125.7 }],
        navaids: [{ ...enrichedBody.navaids[0], frequency_khz: 112300, dme_frequency_khz: 112300 }],
      },
    });

    const airport = await airports().search({ icao: "KJFK" });

    expect(airport.icao_code).toBe("KJFK");
    expect(airport.runways[0]?.lighted).toBe(1);
    expect(airport.runways[0]?.closed).toBe(0);
    expect(airport.frequencies[0]?.frequency_mhz).toBe(125.7);
    expect(airport.navaids[0]?.frequency_khz).toBe(112300);
    expect(airport.navaids[0]?.dme_frequency_khz).toBe(112300);
  });

  it("exposes the nested country and region blocks", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\?/, body: enrichedBody });

    const airport = await airports().search({ icao: "KJFK" });

    expect(airport.country?.code).toBe("US");
    expect(airport.country?.continent).toBe("NA");
    expect(airport.region?.code).toBe("US-NY");
    expect(airport.region?.local_code).toBe("NY");
    expect(airport.region?.iso_country).toBe("US");
    expect(airport.region?.keywords).toBeNull();
  });

  it("survives a record with no country, region, runways or navaids", async () => {
    mockJson({
      path: /^\/v3\.1\/airports\/search\?/,
      body: {
        ...enrichedBody,
        runways: [],
        frequencies: [],
        navaids: [],
        country: null,
        region: null,
      },
    });

    const airport = await airports().search({ icao: "KJFK" });

    expect(airport.country).toBeNull();
    expect(airport.region).toBeNull();
    expect(airport.runways).toEqual([]);
    expect(airport.navaids).toEqual([]);
  });

  it("searches by IATA and reports search_type IATA", async () => {
    mockJson({
      path: /^\/v3\.1\/airports\/search\?/,
      body: { ...enrichedBody, search_code: "JFK", search_type: "IATA" },
    });

    const airport = await airports().search({ iata: "JFK" });

    expect(airport.search_type).toBe("IATA");
    expect(airport.search_code).toBe("JFK");
    expect(requests[0]?.fullPath).toBe("/v3.1/airports/search?iata=JFK");
    expect(requests[0]?.query.has("icao")).toBe(false);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/airports\/search\?/,
      status: 404,
      body: { detail: "Airport not found for ICAO code: ZZZZ" },
    });

    await expect(airports().search({ icao: "ZZZZ" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\?/, body: enrichedBody });

    await airports().search({ icao: "KJFK" }, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("airports.nearby", () => {
  const nearbyBody = {
    search_location: {
      latitude: 40.64,
      longitude: -73.78,
      radius_km: 50,
      type_filter: null,
    },
    airports: [
      {
        id: 3682,
        ident: "KJFK",
        type: "large_airport",
        name: "John F Kennedy International Airport",
        latitude_deg: 40.6398,
        longitude_deg: -73.7789,
        elevation_ft: 13,
        municipality: "New York",
        iso_country: "US",
        iso_region: "US-NY",
        iata_code: "JFK",
        distance_km: 0.15,
      },
    ],
    airports_found: 1,
  };

  it("sends every filter in a stable order", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/location\?/, body: nearbyBody });

    const result: AirportsNearbyResponse = await airports().nearby({
      lat: 40.64,
      lon: -73.78,
      radius: 25,
      type: "large_airport",
      limit: 10,
    });

    expect(result.airports_found).toBe(1);
    expect(result.airports[0]?.ident).toBe("KJFK");
    expect(result.airports[0]?.distance_km).toBeCloseTo(0.15);
    expect(result.search_location.radius_km).toBe(50);
    expect(result.search_location.type_filter).toBeNull();

    expect(requests[0]?.path).toBe("/v3.1/airports/search/location");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/airports/search/location?lat=40.64&lon=-73.78&radius=25&type=large_airport&limit=10",
    );
  });

  it("omits the optional filters when they are unset", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/location\?/, body: nearbyBody });

    await airports().nearby({ lat: 51.47, lon: -0.46 });

    expect(requests[0]?.fullPath).toBe("/v3.1/airports/search/location?lat=51.47&lon=-0.46");
    expect(requests[0]?.query.has("radius")).toBe(false);
    expect(requests[0]?.query.has("type")).toBe(false);
    expect(requests[0]?.query.has("limit")).toBe(false);
  });

  it("keeps a zero coordinate instead of dropping it", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/location\?/, body: nearbyBody });

    await airports().nearby({ lat: 0, lon: 0 });

    expect(requests[0]?.fullPath).toBe("/v3.1/airports/search/location?lat=0&lon=0");
  });
});

describe("airports.byIp", () => {
  const byIpBody = {
    ip_address: "8.8.8.8",
    location: {
      latitude: 37.751,
      longitude: -97.822,
      city: "Wichita",
      region: "Kansas",
      country: "United States",
      country_code: "US",
      postal: "67202",
      timezone: "America/Chicago",
      ip: "8.8.8.8",
    },
    airports: [],
    search_radius_km: 100,
    airports_found: 0,
    error: null,
  };

  it("geolocates an explicit IP", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/ip\?/, body: byIpBody });

    const result: AirportsByIpResponse = await airports().byIp({
      ip: "8.8.8.8",
      radius: 200,
      type: "medium_airport",
      limit: 5,
    });

    expect(result.ip_address).toBe("8.8.8.8");
    expect(result.location?.city).toBe("Wichita");
    expect(result.location?.timezone).toBe("America/Chicago");
    expect(result.search_radius_km).toBe(100);
    expect(result.error).toBeNull();

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/airports/search/ip?ip=8.8.8.8&radius=200&type=medium_airport&limit=5",
    );
  });

  it("sends no parameters at all when called bare", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/airports/search/ip`, body: byIpBody });

    await airports().byIp();

    expect(requests[0]?.fullPath).toBe("/v3.1/airports/search/ip");
    expect(requests[0]?.query.has("ip")).toBe(false);
  });

  it("treats a geolocation failure reported inside a 200 as data, not an error", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/airports/search/ip`,
      body: {
        ip_address: "127.0.0.1",
        location: null,
        airports: [],
        search_radius_km: 100,
        airports_found: 0,
        error: "Could not geolocate IP address 127.0.0.1",
      },
    });

    const result = await airports().byIp();

    expect(result.error).toBe("Could not geolocate IP address 127.0.0.1");
    expect(result.location).toBeNull();
    expect(result.airports).toEqual([]);
    expect(result.airports_found).toBe(0);
  });
});

describe("airports.searchText", () => {
  const textBody = {
    query: "London",
    airports: [
      {
        id: 2434,
        ident: "EGLL",
        type: "large_airport",
        name: "London Heathrow Airport",
        latitude_deg: 51.4706,
        longitude_deg: -0.4619,
        municipality: "London",
        iso_country: "GB",
        iata_code: "LHR",
        relevance_score: 80,
      },
    ],
    airports_found: 1,
  };

  it("ranks matches by relevance score", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/text\?/, body: textBody });

    const result: AirportsTextSearchResponse = await airports().searchText({
      q: "London",
      limit: 5,
      type: "large_airport",
    });

    expect(result.query).toBe("London");
    expect(result.airports[0]?.relevance_score).toBe(80);
    expect(result.airports[0]?.iata_code).toBe("LHR");
    expect(result.airports_found).toBe(1);

    expect(requests[0]?.path).toBe("/v3.1/airports/search/text");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/airports/search/text?q=London&limit=5&type=large_airport",
    );
  });

  it("escapes a multi-word query", async () => {
    mockJson({ path: /^\/v3\.1\/airports\/search\/text\?/, body: textBody });

    await airports().searchText({ q: "New York" });

    expect(requests[0]?.fullPath).toBe("/v3.1/airports/search/text?q=New+York");
    expect(requests[0]?.query.get("q")).toBe("New York");
  });

  it("maps a 422 to a validation error", async () => {
    mockError({
      path: /^\/v3\.1\/airports\/search\/text\?/,
      status: 422,
      body: {
        detail: [
          {
            loc: ["query", "q"],
            msg: "String should have at least 2 characters",
            type: "too_short",
          },
        ],
      },
    });

    await expect(airports().searchText({ q: "L" })).rejects.toBeInstanceOf(SkyLinkError);
  });
});
