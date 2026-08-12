import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type {
  CountriesResponse,
  CountryDetail,
  RegionDetail,
  RegionsResponse,
} from "../src/models/geo.js";
import { Geo } from "../src/resources/geo.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const countriesBody = {
  countries: [
    {
      id: 302672,
      code: "US",
      name: "United States",
      continent: "NA",
      wikipedia_link: "https://en.wikipedia.org/wiki/United_States",
      keywords: "America",
    },
    {
      id: 302618,
      code: "GB",
      name: "United Kingdom",
      continent: "EU",
      wikipedia_link: "https://en.wikipedia.org/wiki/United_Kingdom",
      keywords: null,
    },
  ],
  total: 2,
};

const regionsBody = {
  regions: [
    {
      id: 306125,
      code: "US-CA",
      local_code: "CA",
      name: "California",
      continent: "NA",
      iso_country: "US",
      wikipedia_link: "https://en.wikipedia.org/wiki/California",
      keywords: null,
    },
  ],
  total: 1,
};

function geo(options: ClientOptions = {}): Geo {
  return new Geo(new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("geo.countries", () => {
  it("lists every country when called bare", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/countries`, body: countriesBody });

    const result: CountriesResponse = await geo().countries();

    expect(result.total).toBe(2);
    expect(result.countries[0]?.code).toBe("US");
    expect(result.countries[0]?.continent).toBe("NA");
    expect(result.countries[1]?.keywords).toBeNull();

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/countries");
    expect(request?.query.has("continent")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("filters by continent", async () => {
    mockJson({ path: /^\/v3\.1\/countries\?/, body: countriesBody });

    await geo().countries({ continent: "EU" });

    expect(requests[0]?.fullPath).toBe("/v3.1/countries?continent=EU");
  });
});

describe("geo.country", () => {
  it("returns the detail record flat, not wrapped in a country key", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/countries/US`,
      body: {
        id: 302672,
        code: "US",
        name: "United States",
        continent: "NA",
        wikipedia_link: "https://en.wikipedia.org/wiki/United_States",
        keywords: "America",
      },
    });

    const country: CountryDetail = await geo().country("US");

    expect(country.code).toBe("US");
    expect(country.name).toBe("United States");
    expect(country.continent).toBe("NA");
    expect(country.keywords).toBe("America");
    expect(requests[0]?.fullPath).toBe("/v3.1/countries/US");
  });

  it("percent-encodes the code and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/countries/U%2FS`, body: { code: "U/S" } });

    await geo().country("U/S");
    expect(requests[0]?.path).toBe("/v3.1/countries/U%2FS");

    expect(() => geo().country("   ")).toThrow(SkyLinkError);
    expect(() => geo().country("")).toThrow(/code/);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/countries/ZZ`,
      status: 404,
      body: { detail: "Country 'ZZ' not found" },
    });

    await expect(geo().country("ZZ")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("geo.regions", () => {
  it("filters by country and continent in a stable order", async () => {
    mockJson({ path: /^\/v3\.1\/regions\?/, body: regionsBody });

    const result: RegionsResponse = await geo().regions({ country: "US", continent: "NA" });

    expect(result.total).toBe(1);
    expect(result.regions[0]?.code).toBe("US-CA");
    expect(result.regions[0]?.local_code).toBe("CA");
    expect(result.regions[0]?.iso_country).toBe("US");

    expect(requests[0]?.path).toBe("/v3.1/regions");
    expect(requests[0]?.fullPath).toBe("/v3.1/regions?country=US&continent=NA");
  });

  it("sends no parameters when called bare", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/regions`, body: regionsBody });

    await geo().regions();

    expect(requests[0]?.fullPath).toBe("/v3.1/regions");
    expect(requests[0]?.query.has("country")).toBe(false);
  });
});

describe("geo.region", () => {
  it("returns the detail record flat", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/regions/US-CA`,
      body: {
        id: 306125,
        code: "US-CA",
        local_code: "CA",
        name: "California",
        continent: "NA",
        iso_country: "US",
        wikipedia_link: "https://en.wikipedia.org/wiki/California",
        keywords: null,
      },
    });

    const region: RegionDetail = await geo().region("US-CA");

    expect(region.code).toBe("US-CA");
    expect(region.local_code).toBe("CA");
    expect(region.iso_country).toBe("US");
    expect(region.keywords).toBeNull();
    expect(requests[0]?.fullPath).toBe("/v3.1/regions/US-CA");
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/regions/US-ZZ`,
      status: 404,
      body: { detail: "Region 'US-ZZ' not found" },
    });

    await expect(geo().region("US-ZZ")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/regions/US-CA",
      body: { code: "US-CA" },
    });

    await geo({ provider: "rapidapi", apiKey: "rapid-key" }).region("US-CA");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/regions/US-CA");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
