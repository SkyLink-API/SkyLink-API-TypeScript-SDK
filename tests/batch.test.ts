/**
 * `sky.batch` — the fan-out namespace (`src/resources/batch.ts`).
 *
 * The contract under test: one entry per caller-supplied string, keyed verbatim and
 * in input order; a failure on one key stays on that key; duplicates cost one
 * request; and anything that is not a `SkyLinkError` is a bug, so it is rethrown
 * rather than stored as a value.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { APIConnectionError, NotFoundError, SkyLinkError } from "../src/core/errors.js";
import { isBatchError } from "../src/helpers/batch.js";
import type { EnrichedAirport } from "../src/models/airports.js";
import type { FlightStatusResponse } from "../src/models/flight-status.js";
import type { NotamsResponse } from "../src/models/notams.js";
import type { MetarResponse } from "../src/models/weather.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const metarFixture = loadFixture<MetarResponse>("weather_metar");
const notamsFixture = loadFixture<NotamsResponse>("notams");
const airportFixture = loadFixture<EnrichedAirport>("airports_search");
const flightFixture = loadFixture<FlightStatusResponse>("flight_status");

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

function metarBody(icao: string): MetarResponse {
  return { ...metarFixture, icao };
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("batch.metars", () => {
  it("keeps a failed key from taking the rest of the batch down", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: metarBody("KJFK") });
    mockError({
      path: `${DIRECT_PREFIX}/weather/metar/ZZZZ`,
      status: 404,
      body: { detail: "No METAR found for ZZZZ" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL`, body: metarBody("EGLL") });

    const results = await client().batch.metars(["KJFK", "ZZZZ", "EGLL"]);

    expect(Object.keys(results)).toEqual(["KJFK", "ZZZZ", "EGLL"]);

    const jfk = results.KJFK;
    const zzzz = results.ZZZZ;
    const egll = results.EGLL;

    expect(isBatchError(jfk)).toBe(false);
    expect(isBatchError(egll)).toBe(false);
    if (isBatchError(jfk) || isBatchError(egll)) throw new Error("unreachable");
    expect(jfk?.icao).toBe("KJFK");
    expect(egll?.icao).toBe("EGLL");

    expect(zzzz).toBeInstanceOf(NotFoundError);
    expect((zzzz as NotFoundError).status).toBe(404);
    expect((zzzz as NotFoundError).message).toContain("No METAR found for ZZZZ");

    expect(requests).toHaveLength(3);
  });

  it("keys by the caller's exact string and preserves input order", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/kjfk`, body: metarBody("KJFK") });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL`, body: metarBody("EGLL") });

    const results = await client().batch.metars(["kjfk", " EGLL "]);

    // Normalization is the caller's business: the key round-trips untouched, even
    // though the path segment itself is trimmed and percent-encoded on the way out.
    expect(Object.keys(results)).toEqual(["kjfk", " EGLL "]);
    expect(requests.map((r) => r.path)).toEqual([
      "/v3.1/weather/metar/kjfk",
      "/v3.1/weather/metar/EGLL",
    ]);
  });

  it("collapses duplicates into a single request", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: metarBody("KJFK") });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL`, body: metarBody("EGLL") });

    const results = await client().batch.metars(["KJFK", "EGLL", "KJFK"]);

    expect(Object.keys(results)).toEqual(["KJFK", "EGLL"]);
    expect(requests).toHaveLength(2);
  });

  it("honours a concurrency of one and forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: metarBody("KJFK") });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL`, body: metarBody("EGLL") });

    const results = await client().batch.metars(["KJFK", "EGLL"], {
      concurrency: 1,
      headers: { "X-Trace": "batch" },
    });

    expect(Object.keys(results)).toEqual(["KJFK", "EGLL"]);
    expect(requests.map((r) => r.path)).toEqual([
      "/v3.1/weather/metar/KJFK",
      "/v3.1/weather/metar/EGLL",
    ]);
    for (const request of requests) expect(request.headers["x-trace"]).toBe("batch");
  });

  it("rejects an unusable concurrency before issuing any request", async () => {
    await expect(client().batch.metars(["KJFK"], { concurrency: 0 })).rejects.toBeInstanceOf(
      SkyLinkError,
    );
    expect(requests).toHaveLength(0);
  });

  it("returns an empty object for an empty input, without touching the network", async () => {
    expect(await client().batch.metars([])).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("turns an aborted signal into an error per key instead of a rejection", async () => {
    const results = await client().batch.metars(["KJFK", "EGLL"], {
      signal: AbortSignal.abort(new Error("cancelled")),
    });

    expect(Object.keys(results)).toEqual(["KJFK", "EGLL"]);
    expect(results.KJFK).toBeInstanceOf(APIConnectionError);
    expect(results.EGLL).toBeInstanceOf(APIConnectionError);
    expect(requests).toHaveLength(0);
  });

  it("rethrows anything that is not a SkyLinkError instead of storing it", async () => {
    const sky = client();
    (sky.weather as unknown as { metar: () => Promise<never> }).metar = () =>
      Promise.reject(new TypeError("bug in a caller-supplied fetch"));

    await expect(sky.batch.metars(["KJFK"])).rejects.toBeInstanceOf(TypeError);
  });
});

describe("batch.tafs", () => {
  it("fans out over the TAF endpoint", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK`, body: metarBody("KJFK") });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/EGLL`, body: metarBody("EGLL") });

    const results = await client().batch.tafs(["KJFK", "EGLL"]);

    expect(Object.keys(results)).toEqual(["KJFK", "EGLL"]);
    expect(requests.map((r) => r.path).sort()).toEqual([
      "/v3.1/weather/taf/EGLL",
      "/v3.1/weather/taf/KJFK",
    ]);
    for (const request of requests) expect(request.query.has("parsed")).toBe(false);
  });
});

describe("batch.notams", () => {
  it("fans out over the NOTAM endpoint without extra filters", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/KJFK`, body: notamsFixture });

    const results = await client().batch.notams(["KJFK"]);

    const jfk = results.KJFK;
    if (isBatchError(jfk) || jfk === undefined) throw new Error("expected a response");
    expect(jfk.total).toBe(notamsFixture.total);
    expect(requests[0]?.fullPath).toBe("/v3.1/notams/KJFK");
  });
});

describe("batch.airports", () => {
  it("sends three-letter codes as iata and everything else as icao", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/airports/search?icao=KJFK`, body: airportFixture });
    mockJson({ path: `${DIRECT_PREFIX}/airports/search?iata=LHR`, body: airportFixture });
    mockError({
      path: `${DIRECT_PREFIX}/airports/search?icao=GB-0888`,
      status: 400,
      body: { detail: "Invalid ICAO code" },
    });

    const results = await client().batch.airports(["KJFK", "LHR", "GB-0888"]);

    expect(Object.keys(results)).toEqual(["KJFK", "LHR", "GB-0888"]);
    const jfk = results.KJFK;
    if (isBatchError(jfk) || jfk === undefined) throw new Error("expected a response");
    expect(jfk.ident).toBe(airportFixture.ident);
    expect(results["GB-0888"]).toBeInstanceOf(SkyLinkError);

    const byQuery = requests.map((r) => r.fullPath).sort();
    expect(byQuery).toEqual([
      "/v3.1/airports/search?iata=LHR",
      "/v3.1/airports/search?icao=GB-0888",
      "/v3.1/airports/search?icao=KJFK",
    ]);
  });
});

describe("batch.flightStatuses", () => {
  it("fans out over the flight-status shortcut and reports unknown numbers per key", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: flightFixture });
    mockError({
      path: `${DIRECT_PREFIX}/flight_status/XX999`,
      status: 404,
      body: { detail: "Flight not found" },
    });

    const results = await client().batch.flightStatuses(["BA123", "XX999"]);

    const ba = results.BA123;
    if (isBatchError(ba) || ba === undefined) throw new Error("expected a response");
    expect(ba.flight_number).toBe(flightFixture.flight_number);
    expect(results.XX999).toBeInstanceOf(NotFoundError);
  });
});
