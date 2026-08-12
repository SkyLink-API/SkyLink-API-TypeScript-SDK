import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { ServiceUnavailableError, SkyLinkError } from "../src/core/errors.js";
import type { NotamsResponse } from "../src/models/notams.js";
import { Notams } from "../src/resources/notams.js";
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

const notamsFixture = loadFixture<NotamsResponse>("notams");

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

/** The namespace is attached to the client in a later task; instantiate it directly. */
function notams(options: ClientOptions = {}): Notams {
  return new Notams(client(options));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("notams.byAirport", () => {
  it("fetches NOTAMs for an airport and sends no query parameters by default", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/OMDB`, body: notamsFixture });

    const response: NotamsResponse = await notams().byAirport("OMDB");

    expect(response.icao).toBe("OMDB");
    expect(response.total).toBe(1);
    expect(response.notams).toHaveLength(1);
    expect(response.notams[0]?.raw).toContain("A2161/26 NOTAMN");
    expect(response.notams[0]?.body).toBe("RWY 12L/30R CLSD");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/notams/OMDB");
    expect([...(request?.query.keys() ?? [])]).toEqual([]);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("exposes the parsed items of an entry", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/OMDB`, body: notamsFixture });

    const entry = (await notams().byAirport("OMDB")).notams[0];

    expect(entry?.notam_id).toBe("A2161/2026");
    expect(entry?.notam_id_domestic).toBe("07/2161");
    expect(entry?.type).toBe("N");
    expect(entry?.location).toBe("OMDB");
    expect(entry?.qline).toBe("OMAE/QMRLC/IV/NBO/A/000/999/2515N05521E005");
    expect(entry?.scope).toBe("AERODROME");
  });

  it("percent-encodes the icao path segment and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/OM%2FB`, body: notamsFixture });

    await notams().byAirport("OM/B");
    expect(requests[0]?.path).toBe("/v3.1/notams/OM%2FB");

    expect(() => notams().byAirport("   ")).toThrow(SkyLinkError);
    expect(() => notams().byAirport("")).toThrow(/icao/);
  });

  it("maps a 503 to ServiceUnavailableError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      status: 503,
      body: { detail: "NOTAM service temporarily unavailable" },
    });

    // 503 is a retryable status, so exhaust the budget up front to assert the mapping.
    await expect(notams().byAirport("KJFK", undefined, { maxRetries: 0 })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/OMDB`, body: notamsFixture });

    await notams().byAirport("OMDB", undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("notams CSV filters", () => {
  it("comma-joins array filters", async () => {
    mockJson({ path: /^\/v3\.1\/notams\/KJFK\?/, body: { ...notamsFixture, icao: "KJFK" } });

    await notams().byAirport("KJFK", {
      exclude_qcode: ["QK", "QFA"],
      exclude_scope: ["FIR"],
    });

    expect(requests[0]?.query.get("exclude_qcode")).toBe("QK,QFA");
    expect(requests[0]?.query.get("exclude_scope")).toBe("FIR");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/notams/KJFK?exclude_qcode=QK%2CQFA&exclude_scope=FIR",
    );
  });

  it("passes a pre-joined CSV string through untouched", async () => {
    mockJson({ path: /^\/v3\.1\/notams\/KJFK\?/, body: { ...notamsFixture, icao: "KJFK" } });

    await notams().byAirport("KJFK", {
      exclude_qcode: "QKKKK,QFA",
      exclude_scope: "AERODROME,FIR",
    });

    expect(requests[0]?.query.get("exclude_qcode")).toBe("QKKKK,QFA");
    expect(requests[0]?.query.get("exclude_scope")).toBe("AERODROME,FIR");
  });

  it("drops filters that were not supplied", async () => {
    mockJson({ path: /^\/v3\.1\/notams\/KJFK\?/, body: { ...notamsFixture, icao: "KJFK" } });

    await notams().byAirport("KJFK", { exclude_scope: ["FIR"] });

    expect(requests[0]?.query.has("exclude_qcode")).toBe(false);
    expect(requests[0]?.query.has("include_future")).toBe(false);
    expect(requests[0]?.fullPath).toBe("/v3.1/notams/KJFK?exclude_scope=FIR");
  });
});

describe("notams include_future", () => {
  const futureBody = {
    icao: "KJFK",
    notams: [
      {
        raw: "A0001/26 NOTAMN\nA) KJFK B) 2603010000 C) 2603312359\nE) TWY A CLSD",
        notam_id: "A0001/2026",
        notam_id_domestic: "03/0001",
        type: "N",
        location: "KJFK",
        effective: "2026-03-01T00:00:00Z",
        expiration: "2026-03-31T23:59:00Z",
        body: "TWY A CLSD",
        schedule: null,
        lower_limit: null,
        upper_limit: null,
        affected_fir: "KZNY",
        q_code: "QMXLC",
        qline: null,
        scope: "AERODROME",
        status: "FUTURE",
      },
    ],
    total: 1,
  };

  it("sends include_future=true and surfaces the status field", async () => {
    mockJson({ path: /^\/v3\.1\/notams\/KJFK\?/, body: futureBody });

    const response = await notams().byAirport("KJFK", { include_future: true });

    expect(requests[0]?.fullPath).toBe("/v3.1/notams/KJFK?include_future=true");
    expect(response.notams[0]?.status).toBe("FUTURE");
  });

  it("sends include_future=false explicitly when asked", async () => {
    mockJson({ path: /^\/v3\.1\/notams\/KJFK\?/, body: { ...futureBody, notams: [] } });

    await notams().byAirport("KJFK", { include_future: false });

    expect(requests[0]?.fullPath).toBe("/v3.1/notams/KJFK?include_future=false");
  });

  it("reports ACTIVE when future NOTAMs were not requested", async () => {
    // The API classifies every NOTAM it returns; a default call simply filters
    // the FUTURE ones out, so the field is `ACTIVE` rather than absent.
    mockJson({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      body: {
        ...futureBody,
        notams: [{ ...futureBody.notams[0], status: "ACTIVE" }],
      },
    });

    const response = await notams().byAirport("KJFK");

    expect(response.notams[0]?.status).toBe("ACTIVE");
  });

  it("still tolerates a null status from an older deployment", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      body: {
        ...futureBody,
        notams: [{ ...futureBody.notams[0], status: null }],
      },
    });

    const response = await notams().byAirport("KJFK");

    expect(response.notams[0]?.status).toBeNull();
  });
});

describe("notams timestamps stay opaque strings", () => {
  it("keeps the [YY]YYMMDDHHMM NOTAM date group verbatim", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/notams/OMDB`, body: notamsFixture });

    const entry = (await notams().byAirport("OMDB")).notams[0];

    expect(entry?.effective).toBe("202607162130");
    expect(entry?.expiration).toBe("202607302215");
    expect(typeof entry?.effective).toBe("string");
    expect(entry?.effective).not.toBeInstanceOf(Date);
  });

  it("keeps an ISO 8601 timestamp verbatim too — the same field carries both formats", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      body: {
        icao: "KJFK",
        notams: [
          {
            ...notamsFixture.notams[0],
            effective: "2026-07-16T21:30:00Z",
            expiration: "PERM",
          },
        ],
        total: 1,
      },
    });

    const entry = (await notams().byAirport("KJFK")).notams[0];

    expect(entry?.effective).toBe("2026-07-16T21:30:00Z");
    expect(entry?.expiration).toBe("PERM");
    expect(typeof entry?.expiration).toBe("string");
  });

  it("tolerates both timestamps being null", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      body: {
        icao: "KJFK",
        notams: [{ ...notamsFixture.notams[0], effective: null, expiration: null }],
        total: 1,
      },
    });

    const entry = (await notams().byAirport("KJFK")).notams[0];

    expect(entry?.effective).toBeNull();
    expect(entry?.expiration).toBeNull();
  });
});

describe("notams empty result", () => {
  it("returns an empty list rather than a 404", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/notams/EGLL`,
      body: { icao: "EGLL", notams: [], total: 0 },
    });

    const response = await notams().byAirport("EGLL");

    expect(response.notams).toEqual([]);
    expect(response.total).toBe(0);
  });
});

describe("notams wiring", () => {
  it("exposes byAirport", () => {
    expect(typeof notams().byAirport).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/notams/OMDB",
      body: notamsFixture,
    });

    await notams({ provider: "rapidapi", apiKey: "rapid-key" }).byAirport("OMDB");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/notams/OMDB");
  });
});
