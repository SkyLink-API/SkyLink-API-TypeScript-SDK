import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type {
  AircraftDatabaseStats,
  AircraftLookupResponse,
  AircraftPerformance,
} from "../src/models/aircraft.js";
import { Aircraft } from "../src/resources/aircraft.js";
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

const foundFixture = loadFixture<AircraftLookupResponse>("aircraft_found");
const notFoundFixture = loadFixture<AircraftLookupResponse>("aircraft_not_found");
const performanceFixture = loadFixture<AircraftPerformance>("performance");

function aircraft(options: ClientOptions = {}): Aircraft {
  return new Aircraft(
    new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("aircraft.byRegistration", () => {
  it("returns the registry record and sends no query parameters by default", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/registration/G-STBA`, body: foundFixture });

    const result: AircraftLookupResponse = await aircraft().byRegistration("G-STBA");

    expect(result.query).toBe("G-STBA");
    expect(result.found).toBe(true);
    // Narrowing on `found` is what unlocks `aircraft` without a null check.
    if (!result.found) throw new Error("expected a hit");
    expect(result.aircraft.manufacturer_and_model).toBe("Boeing 777-336(ER)");
    expect(result.aircraft.icao_type).toBe("B77W");
    expect(result.aircraft.is_private_operator).toBe(false);
    expect(result.aircraft.serial_number).toBe("38593");
    // year_built is a string on the wire, not a number.
    expect(result.aircraft.year_built).toBe("2010");
    expect(result.aircraft.photos[0]?.photographer).toBe("Jane Doe");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/aircraft/registration/G-STBA");
    // photos defaults to true server-side — never send a false the caller did not ask for.
    expect(request?.query.has("photos")).toBe(false);
  });

  it("returns found:false with a null aircraft on a miss, not a 404", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/registration/ZZ-ZZZ`,
      status: 200,
      body: notFoundFixture,
    });

    const result: AircraftLookupResponse = await aircraft().byRegistration("ZZ-ZZZ");

    expect(result.found).toBe(false);
    expect(result.query).toBe("ZZ-ZZZ");
    if (result.found) throw new Error("expected a miss");
    expect(result.aircraft).toBeNull();
  });

  it("sends photos=false when the caller opts out", async () => {
    mockJson({ path: /^\/v3\.1\/aircraft\/registration\/G-STBA\?/, body: foundFixture });

    await aircraft().byRegistration("G-STBA", { photos: false });

    expect(requests[0]?.fullPath).toBe("/v3.1/aircraft/registration/G-STBA?photos=false");
    expect(requests[0]?.query.get("photos")).toBe("false");
  });

  it("percent-encodes the registration and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/registration/N1%2F2`, body: foundFixture });

    await aircraft().byRegistration("N1/2");
    expect(requests[0]?.path).toBe("/v3.1/aircraft/registration/N1%2F2");

    expect(() => aircraft().byRegistration("   ")).toThrow(SkyLinkError);
    expect(() => aircraft().byRegistration("")).toThrow(/registration/);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/registration/G-STBA`, body: foundFixture });

    await aircraft().byRegistration("G-STBA", undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("aircraft.byIcao24", () => {
  it("looks up by hex address", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/4CA1FB`,
      body: { ...foundFixture, query: "4CA1FB" },
    });

    const result = await aircraft().byIcao24("4CA1FB");

    expect(result.query).toBe("4CA1FB");
    if (!result.found) throw new Error("expected a hit");
    expect(result.aircraft.icao24).toBe("4CA1FB");
    expect(result.aircraft.registration).toBe("G-STBA");

    expect(requests[0]?.fullPath).toBe("/v3.1/aircraft/icao24/4CA1FB");
    expect(requests[0]?.query.has("photos")).toBe(false);
  });

  it("returns found:false on a miss", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/icao24/ffffff`,
      body: { query: "FFFFFF", found: false, aircraft: null },
    });

    const result = await aircraft().byIcao24("ffffff");

    expect(result.found).toBe(false);
    expect(result.aircraft).toBeNull();
  });

  it("sends photos=false when the caller opts out and rejects an empty hex", async () => {
    mockJson({ path: /^\/v3\.1\/aircraft\/icao24\/4CA1FB\?/, body: foundFixture });

    await aircraft().byIcao24("4CA1FB", { photos: false });
    expect(requests[0]?.fullPath).toBe("/v3.1/aircraft/icao24/4CA1FB?photos=false");

    expect(() => aircraft().byIcao24(" ")).toThrow(/icao24/);
  });
});

describe("aircraft.performance", () => {
  it("returns the type performance profile", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/aircraft/performance/B77W`, body: performanceFixture });

    const perf: AircraftPerformance = await aircraft().performance("B77W");

    expect(perf.icao_type).toBe("B77W");
    expect(perf.name).toBe("BOEING 777-300ER");
    expect(perf.wake_category).toBe("H");
    expect(perf.cruise_speed_ktas).toBe(490);
    expect(perf.service_ceiling_ft).toBe(43000);
    expect(perf.max_range_nm).toBe(7370);
    expect(perf.mtow_t).toBeCloseTo(351.5);
    expect(perf.max_passengers).toBe(396);

    expect(requests[0]?.fullPath).toBe("/v3.1/aircraft/performance/B77W");
  });

  it("tolerates a sparse profile — every field is optional", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/performance/AT72`,
      body: { icao_type: "AT72", name: "ATR 72", wake_category: "M" },
    });

    const perf = await aircraft().performance("AT72");

    expect(perf.name).toBe("ATR 72");
    expect(perf.cruise_speed_ktas).toBeUndefined();
    expect(perf.wing_span_m).toBeUndefined();
    expect(perf.max_passengers).toBeUndefined();
  });

  it("maps an unknown type to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/aircraft/performance/ZZZZ`,
      status: 404,
      body: { detail: "No performance data found for aircraft type 'ZZZZ'." },
    });

    await expect(aircraft().performance("ZZZZ")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an empty type code", () => {
    expect(() => aircraft().performance("  ")).toThrow(/icaoType/);
  });
});

describe("aircraft.databaseStats", () => {
  it("reports the registry snapshot size", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/aircraft/database/stats`,
      body: {
        loaded: true,
        total_icao_entries: 615656,
        total_registration_entries: 613252,
        source_url: "http://10.0.1.15:8090/aircraft.json",
      },
    });

    const stats: AircraftDatabaseStats = await aircraft().databaseStats();

    expect(stats.loaded).toBe(true);
    expect(stats.total_icao_entries).toBe(615656);
    expect(stats.total_registration_entries).toBe(613252);
    expect(stats.source_url).toContain("aircraft.json");

    expect(requests[0]?.fullPath).toBe("/v3.1/aircraft/database/stats");
  });
});

describe("aircraft resource wiring", () => {
  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/aircraft/registration/G-STBA",
      body: foundFixture,
    });

    await aircraft({ provider: "rapidapi", apiKey: "rapid-key" }).byRegistration("G-STBA");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/aircraft/registration/G-STBA");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
