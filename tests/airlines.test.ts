import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import type { Airline } from "../src/models/airlines.js";
import { Airlines } from "../src/resources/airlines.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const britishAirways = {
  id: 1355,
  name: "British Airways",
  alias: null,
  iata: "BA",
  icao: "BAW",
  callsign: "SPEEDBIRD",
  country: "United Kingdom",
  active: "Y",
  logo: "https://media.skylinkapi.com/logos/BA.png",
};

function airlines(options: ClientOptions = {}): Airlines {
  return new Airlines(
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

describe("airlines.search", () => {
  it("returns a bare array rather than an envelope", async () => {
    mockJson({ path: /^\/v3\.1\/airlines\/search\?/, body: [britishAirways] });

    const results: Airline[] = await airlines().search({ iata: "BA" });

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(1355);
    expect(results[0]?.name).toBe("British Airways");
    expect(results[0]?.callsign).toBe("SPEEDBIRD");
    expect(results[0]?.alias).toBeNull();
    expect(results[0]?.logo).toBe("https://media.skylinkapi.com/logos/BA.png");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/airlines/search?iata=BA");
    expect(request?.query.has("icao")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("reports `active` as the letter Y or N, not a boolean", async () => {
    mockJson({
      path: /^\/v3\.1\/airlines\/search\?/,
      body: [britishAirways, { ...britishAirways, id: 1, active: "N", iata: null, logo: null }],
    });

    const results = await airlines().search({ icao: "BAW" });

    expect(results[0]?.active).toBe("Y");
    expect(results[1]?.active).toBe("N");
    expect(typeof results[0]?.active).toBe("string");
    // No IATA code means no logo URL can be built.
    expect(results[1]?.iata).toBeNull();
    expect(results[1]?.logo).toBeNull();
  });

  it("searches by ICAO code", async () => {
    mockJson({ path: /^\/v3\.1\/airlines\/search\?/, body: [britishAirways] });

    await airlines().search({ icao: "BAW" });

    expect(requests[0]?.fullPath).toBe("/v3.1/airlines/search?icao=BAW");
    expect(requests[0]?.query.has("iata")).toBe(false);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/airlines\/search\?/,
      status: 404,
      body: { detail: "No airlines found for code 'ZZZ'" },
    });

    await expect(airlines().search({ icao: "ZZZ" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/airlines\/search\?/, body: [britishAirways] });

    await airlines().search({ iata: "BA" }, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});
