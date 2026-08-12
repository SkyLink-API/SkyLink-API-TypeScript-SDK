import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { ServiceUnavailableError, SkyLinkError } from "../src/core/errors.js";
import type { FaaDelaysResponse } from "../src/models/delays.js";
import { Delays } from "../src/resources/delays.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const delaysBody = {
  ground_delays: [
    {
      airport: "KEWR",
      airport_name: null,
      reason: "WEATHER / THUNDERSTORMS",
      avg_delay: "1 hour and 30 minutes",
      max_delay: "2 hours",
    },
  ],
  ground_stops: [
    {
      airport: "KLGA",
      airport_name: "LaGuardia",
      reason: "WEATHER / LOW CEILINGS",
      end_time: "22:00 UTC",
    },
  ],
  closures: [
    {
      airport: "KDCA",
      airport_name: null,
      reason: "RUNWAY MAINTENANCE",
      begin: "1800 UTC",
      reopen: "2000 UTC",
    },
  ],
  airspace_flow_programs: [
    {
      facility: "ZNY",
      reason: "WEATHER / THUNDERSTORMS",
      fca_start: "1700 UTC",
      fca_end: "2300 UTC",
    },
  ],
  total_alerts: 4,
  message: null,
};

function delays(options: ClientOptions = {}): Delays {
  return new Delays(
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

describe("delays.faa", () => {
  it("fetches the national picture when called without an airport", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa`, body: delaysBody });

    const nas: FaaDelaysResponse = await delays().faa();

    expect(nas.total_alerts).toBe(4);
    expect(nas.ground_delays[0]?.airport).toBe("KEWR");
    expect(nas.ground_stops[0]?.airport_name).toBe("LaGuardia");
    expect(nas.closures[0]?.reopen).toBe("2000 UTC");
    expect(nas.airspace_flow_programs[0]?.facility).toBe("ZNY");
    expect(nas.message).toBeNull();

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/delays/faa");
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("keeps durations as prose strings rather than numbers", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa`, body: delaysBody });

    const nas = await delays().faa();
    const gdp = nas.ground_delays[0];

    expect(gdp?.avg_delay).toBe("1 hour and 30 minutes");
    expect(gdp?.max_delay).toBe("2 hours");
    expect(typeof gdp?.avg_delay).toBe("string");
    expect(Number(gdp?.avg_delay)).toBeNaN();
    // Time fields are opaque FAA strings too, not ISO 8601.
    expect(nas.ground_stops[0]?.end_time).toBe("22:00 UTC");
    expect(nas.closures[0]?.begin).toBe("1800 UTC");
    expect(nas.airspace_flow_programs[0]?.fca_start).toBe("1700 UTC");
  });

  it("appends the airport to the path when one is given", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/delays/faa/KEWR`,
      body: { ...delaysBody, ground_stops: [], closures: [], total_alerts: 2 },
    });

    const nas = await delays().faa("KEWR");

    expect(nas.ground_delays).toHaveLength(1);
    expect(nas.ground_stops).toEqual([]);
    // The per-airport variant does not filter flow programs — they are ARTCC-wide.
    expect(nas.airspace_flow_programs).toHaveLength(1);

    expect(requests[0]?.fullPath).toBe("/v3.1/delays/faa/KEWR");
    expect(requests[0]?.query.has("icao")).toBe(false);
  });

  it("carries the message sentinel when nothing is delayed", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/delays/faa/KSFO`,
      body: {
        ground_delays: [],
        ground_stops: [],
        closures: [],
        airspace_flow_programs: [],
        total_alerts: 0,
        message: "No delays reported for KSFO",
      },
    });

    const nas = await delays().faa("KSFO");

    expect(nas.total_alerts).toBe(0);
    expect(nas.message).toBe("No delays reported for KSFO");
    expect(nas.ground_delays).toEqual([]);
  });

  it("percent-encodes the icao segment and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa/K%2FWR`, body: delaysBody });

    await delays().faa("K/WR");
    expect(requests[0]?.path).toBe("/v3.1/delays/faa/K%2FWR");

    expect(() => delays().faa("   ")).toThrow(SkyLinkError);
    expect(() => delays().faa("")).toThrow(/icao/);
  });

  it("maps the upstream feed being down to ServiceUnavailableError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/delays/faa`,
      status: 503,
      body: { detail: "FAA delay service temporarily unavailable" },
    });

    await expect(delays({ maxRetries: 0 }).faa()).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa`, body: delaysBody });

    await delays().faa(undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("delays resource wiring", () => {
  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/delays/faa",
      body: delaysBody,
    });

    await delays({ provider: "rapidapi", apiKey: "rapid-key" }).faa();

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/delays/faa");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
