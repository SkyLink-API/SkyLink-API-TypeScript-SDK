import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError } from "../src/core/errors.js";
import type { NavaidsResponse } from "../src/models/navaids.js";
import { Navaids } from "../src/resources/navaids.js";
import {
  DIRECT_ORIGIN,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const navaidsBody = {
  navaids: [
    {
      id: 87796,
      ident: "JFK",
      name: "Kennedy",
      type: "VOR-DME",
      frequency_khz: 115900,
      latitude_deg: 40.63274,
      longitude_deg: -73.77618,
      elevation_ft: 12,
      iso_country: "US",
      dme_frequency_khz: 115900,
      dme_channel: "106X",
      slaved_variation_deg: -13.0,
      magnetic_variation_deg: -13.174,
      usageType: "BOTH",
      power: "HIGH",
      associated_airport: "KJFK",
    },
  ],
  total: 1,
  filters_applied: { airport: "KJFK" },
};

function navaids(options: ClientOptions = {}): Navaids {
  return new Navaids(new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("navaids.list", () => {
  it("searches by associated airport and keeps `usageType` in camelCase", async () => {
    mockJson({ path: /^\/v3\.1\/navaids\?/, body: navaidsBody });

    const result: NavaidsResponse = await navaids().list({ airport: "KJFK" });

    expect(result.total).toBe(1);
    expect(result.navaids[0]?.ident).toBe("JFK");
    expect(result.navaids[0]?.type).toBe("VOR-DME");
    // Numeric here, unlike the string form embedded in an enriched airport record.
    expect(result.navaids[0]?.frequency_khz).toBe(115900);
    expect(result.navaids[0]?.usageType).toBe("BOTH");
    expect(result.navaids[0]?.dme_channel).toBe("106X");
    expect(result.navaids[0]?.associated_airport).toBe("KJFK");
    expect(result.navaids[0]?.magnetic_variation_deg).toBeCloseTo(-13.174);

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/navaids");
    expect(request?.fullPath).toBe("/v3.1/navaids?airport=KJFK");
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("echoes the applied filters back, normalized", async () => {
    mockJson({
      path: /^\/v3\.1\/navaids\?/,
      body: {
        ...navaidsBody,
        total: 412,
        filters_applied: { ident: "jfk", type: "VOR", country: "US" },
      },
    });

    const result = await navaids().list({ ident: "jfk", type: "vor", country: "us", limit: 1 });

    expect(result.filters_applied.ident).toBe("jfk");
    expect(result.filters_applied.type).toBe("VOR");
    expect(result.filters_applied.country).toBe("US");
    expect(result.filters_applied.bbox).toBeUndefined();
    // `total` counts the matches before `limit` was applied.
    expect(result.total).toBe(412);
    expect(result.navaids).toHaveLength(1);

    expect(requests[0]?.fullPath).toBe("/v3.1/navaids?ident=jfk&type=vor&country=us&limit=1");
  });

  it("serializes a bbox tuple and passes a pre-joined string through", async () => {
    mockJson({
      path: /^\/v3\.1\/navaids\?/,
      body: { ...navaidsBody, filters_applied: { bbox: "40.0,-74.5,41.0,-73.5" } },
      times: 2,
    });

    const result = await navaids().list({ bbox: [40, -74.5, 41, -73.5], limit: 200 });

    expect(result.filters_applied.bbox).toBe("40.0,-74.5,41.0,-73.5");
    expect(requests[0]?.fullPath).toBe("/v3.1/navaids?bbox=40%2C-74.5%2C41%2C-73.5&limit=200");
    expect(requests[0]?.query.get("bbox")).toBe("40,-74.5,41,-73.5");

    await navaids().list({ bbox: "40,-74.5,41,-73.5" });

    expect(requests[1]?.query.get("bbox")).toBe("40,-74.5,41,-73.5");
    expect(requests[1]?.query.has("limit")).toBe(false);
  });

  it("rejects an unfiltered call before it reaches the network", () => {
    expect(() => navaids().list({})).toThrow(SkyLinkError);
    expect(() => navaids().list({ limit: 100 })).toThrow(/at least one filter/);
    expect(() => navaids().list({ limit: 100 })).toThrow(/ident, airport, type, country, bbox/);
    expect(requests).toHaveLength(0);
  });

  it("accepts any single filter as sufficient", async () => {
    mockJson({ path: /^\/v3\.1\/navaids\?/, body: navaidsBody, times: 5 });

    await navaids().list({ ident: "JFK" });
    await navaids().list({ airport: "KJFK" });
    await navaids().list({ type: "VOR" });
    await navaids().list({ country: "US" });
    await navaids().list({ bbox: "40,-74,41,-73" });

    expect(requests.map((request) => request.query.toString())).toEqual([
      "ident=JFK",
      "airport=KJFK",
      "type=VOR",
      "country=US",
      "bbox=40%2C-74%2C41%2C-73",
    ]);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/navaids\?/, body: navaidsBody });

    await navaids().list({ airport: "KJFK" }, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});
