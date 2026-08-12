import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type { ChartSourcesResponse, ChartsResponse } from "../src/models/charts.js";
import { Charts } from "../src/resources/charts.js";
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

const chartsFixture = loadFixture<ChartsResponse>("charts");

function charts(options: ClientOptions = {}): Charts {
  return new Charts(
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

describe("charts.byAirport", () => {
  it("returns the category map and sends no query parameters by default", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/charts/KJFK`, body: chartsFixture });

    const result: ChartsResponse = await charts().byAirport("KJFK");

    expect(result.icao_code).toBe("KJFK");
    expect(result.source).toBe("faa");
    expect(result.total_count).toBe(42);
    expect(result.charts.GND?.[0]?.name).toBe("KJFK - Airport Diagram");
    expect(result.charts.SID?.[0]?.category).toBe("SID");
    // fetched_at is typed as a plain string: the router's documented example carries a
    // Z, while a live response serializes datetime.utcnow() naive, without one.
    expect(result.fetched_at).toBe("2026-02-11T12:00:00Z");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/charts/KJFK");
    expect(request?.query.has("source")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("leaves empty categories absent from the partial map", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/charts/KJFK`, body: chartsFixture });

    const result = await charts().byAirport("KJFK");

    expect(Object.keys(result.charts)).toEqual(["GND", "SID"]);
    expect(result.charts.APP).toBeUndefined();
    expect(result.charts.STAR).toBeUndefined();
    expect(result.charts.GEN).toBeUndefined();
    // The idiomatic read: coalesce rather than assume the key exists.
    expect(result.charts.APP ?? []).toEqual([]);
  });

  it("sends the source override", async () => {
    mockJson({ path: /^\/v3\.1\/charts\/EGLL\?/, body: { ...chartsFixture, source: "uk" } });

    const result = await charts().byAirport("EGLL", { source: "uk" });

    expect(result.source).toBe("uk");
    expect(requests[0]?.fullPath).toBe("/v3.1/charts/EGLL?source=uk");
  });

  it("percent-encodes the icao segment and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/charts/K%2FFK`, body: chartsFixture });

    await charts().byAirport("K/FK");
    expect(requests[0]?.path).toBe("/v3.1/charts/K%2FFK");

    expect(() => charts().byAirport("   ")).toThrow(SkyLinkError);
    expect(() => charts().byAirport("")).toThrow(/icao/);
  });

  it("maps an uncovered airport to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/charts/ZZZZ`,
      status: 404,
      body: { detail: "Charts for ZZZZ are not currently available." },
    });

    await expect(charts().byAirport("ZZZZ")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/charts/KJFK`, body: chartsFixture });

    await charts().byAirport("KJFK", undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("charts.byCategory", () => {
  it("filters to a single category, keeping the same envelope", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/charts/KJFK/SID`,
      body: {
        ...chartsFixture,
        charts: { SID: chartsFixture.charts.SID },
        total_count: 1,
      },
    });

    const result: ChartsResponse = await charts().byCategory("KJFK", "SID");

    expect(result.total_count).toBe(1);
    expect(Object.keys(result.charts)).toEqual(["SID"]);
    expect(result.charts.SID?.[0]?.name).toBe("KENNEDY TWO");
    expect(result.charts.GND).toBeUndefined();

    expect(requests[0]?.fullPath).toBe("/v3.1/charts/KJFK/SID");
  });

  it("sends the source override alongside the category", async () => {
    mockJson({
      path: /^\/v3\.1\/charts\/LFPG\/APP\?/,
      body: { ...chartsFixture, icao_code: "LFPG", source: "france", charts: {}, total_count: 0 },
    });

    await charts().byCategory("LFPG", "APP", { source: "france" });

    expect(requests[0]?.path).toBe("/v3.1/charts/LFPG/APP");
    expect(requests[0]?.fullPath).toBe("/v3.1/charts/LFPG/APP?source=france");
  });

  it("maps an empty category to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/charts/KJFK/GEN`,
      status: 404,
      body: { detail: "No GEN charts found for KJFK" },
    });

    await expect(charts().byCategory("KJFK", "GEN")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("charts.sources", () => {
  it("lists the scrapers and their icao prefixes", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/charts/sources`,
      body: {
        sources: [
          { source_id: "faa", name: "FAA (United States)", icao_prefixes: ["K", "P"] },
          { source_id: "uk", name: "UK NATS AIP", icao_prefixes: ["EG"] },
          {
            source_id: "russia",
            name: "Russia CAA",
            icao_prefixes: ["U* (except UA,UC,UG,UM,UT,UZ)"],
          },
        ],
        total_count: 3,
      },
    });

    const result: ChartSourcesResponse = await charts().sources();

    expect(result.total_count).toBe(3);
    expect(result.sources[0]?.source_id).toBe("faa");
    expect(result.sources[1]?.icao_prefixes).toEqual(["EG"]);
    // A prefix entry may be a prose exclusion rather than a bare prefix.
    expect(result.sources[2]?.icao_prefixes[0]).toBe("U* (except UA,UC,UG,UM,UT,UZ)");

    expect(requests[0]?.fullPath).toBe("/v3.1/charts/sources");
  });
});

describe("charts resource wiring", () => {
  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/charts/KJFK",
      body: chartsFixture,
    });

    await charts({ provider: "rapidapi", apiKey: "rapid-key" }).byAirport("KJFK");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/charts/KJFK");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
