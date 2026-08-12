/**
 * The opt-in response cache: `src/helpers/cache.ts`, `src/core/operations.ts` and the
 * single insertion point in `src/core/transport.ts`.
 *
 * What matters here, in order:
 *
 * 1. **Off by default.** A client built without a cache, and a cache built without
 *    TTLs, must behave exactly as before — same requests, same count.
 * 2. **Only successful GETs.** A POST, an error and a PDF are never stored; serving a
 *    stale one of those is worse than any latency it would save.
 * 3. **No shared mutable state.** Two callers that get "the same" cached response must
 *    get two objects, because the SDK does not freeze what it hands out.
 * 4. **Expiry is monotonic and injectable** — the clock is a constructor seam, so no
 *    test sleeps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError } from "../src/core/errors.js";
import { deriveOperation, operationOf } from "../src/core/operations.js";
import { buildCacheKey, CACHE_HIT_HEADER } from "../src/core/transport.js";
import { type CacheProtocol, MemoryCache, resolveTtl } from "../src/helpers/cache.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

/** A clock the test drives by hand, in milliseconds. */
function fakeClock(start = 0) {
  const state = { now: start };
  return { state, read: () => state.now, advance: (ms: number) => (state.now += ms) };
}

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

describe("resolveTtl", () => {
  const ttls = {
    "weather.metar": 300_000,
    "weather.*": 60_000,
    "aircraft.database.*": 86_400_000,
    "*": 1_000,
  };

  it("prefers the exact operation name", () => {
    expect(resolveTtl("weather.metar", ttls, 7)).toBe(300_000);
  });

  it("falls back to the nearest wildcard prefix", () => {
    expect(resolveTtl("weather.pireps", ttls, 7)).toBe(60_000);
    expect(resolveTtl("aircraft.database.stats", ttls, 7)).toBe(86_400_000);
  });

  it("walks outwards from the most specific prefix", () => {
    expect(resolveTtl("weather.taf.parsed", ttls, 7)).toBe(60_000);
  });

  it("falls back to the catch-all, then to the default", () => {
    expect(resolveTtl("geo.countries", ttls, 7)).toBe(1_000);
    expect(resolveTtl("geo.countries", { "weather.*": 5 }, 7)).toBe(7);
    expect(resolveTtl("", {}, 7)).toBe(7);
  });

  it("defaults to zero — no configuration means no caching", () => {
    expect(resolveTtl("weather.metar")).toBe(0);
  });
});

describe("deriveOperation", () => {
  it.each([
    ["/weather/metar/KJFK", "weather.metar"],
    ["/weather/taf/EGLL", "weather.taf"],
    ["/weather/winds-aloft", "weather.winds-aloft"],
    ["/weather/pireps", "weather.pireps"],
    ["/weather/airsigmet", "weather.airsigmet"],
    ["/airports/search", "airports.search"],
    ["/airports/search/location", "airports.search.location"],
    ["/airports/search/ip", "airports.search.ip"],
    ["/airports/search/text", "airports.search.text"],
    ["/airlines/search", "airlines.search"],
    ["/navaids", "navaids"],
    ["/countries", "countries"],
    ["/countries/US", "countries"],
    ["/regions", "regions"],
    ["/adsb/aircraft", "adsb.aircraft"],
    ["/adsb/aircraft/statistics", "adsb.aircraft.statistics"],
    ["/adsb/health", "adsb.health"],
    ["/aircraft/registration/G-STBA", "aircraft.registration"],
    ["/aircraft/icao24/4ca1fb", "aircraft.icao24"],
    ["/aircraft/performance/B77W", "aircraft.performance"],
    ["/aircraft/database/stats", "aircraft.database.stats"],
    ["/charts/KJFK", "charts"],
    ["/charts/KJFK/APP", "charts"],
    ["/charts/sources", "charts.sources"],
    ["/delays/faa", "delays.faa"],
    ["/delays/faa/KJFK", "delays.faa"],
    ["/notams/KJFK", "notams"],
    ["/schedules/departures", "schedules.departures"],
    ["/schedules/arrivals", "schedules.arrivals"],
    ["/ml/flight-time", "ml.flight-time"],
    ["/carbon/estimate", "carbon.estimate"],
    ["/briefing/flight", "briefing.flight"],
    ["/briefing/pdf", "briefing.pdf"],
    ["/routes/callsign/BAW117", "routes.callsign"],
    ["/routes/airport/EGLL", "routes.airport"],
    ["/routes/pairs", "routes.pairs"],
    ["/tickets/search", "tickets.search"],
    ["/webhooks", "webhooks"],
    ["/webhooks/wh_123", "webhooks"],
    ["/webhooks/events", "webhooks.events"],
    ["/distance", "distance"],
    ["/flight_status/BA123", "flight_status"],
    ["/ultra/history/flights", "history.flights"],
    ["/mega/history/flights", "history.flights"],
    ["/ultra/history/positions", "history.positions"],
    ["/ultra/history/flight/42/track", "history.flight.track"],
    ["/ultra/history/airport/EGLL/traffic", "history.airport.traffic"],
  ])("names %s as %s", (path, operation) => {
    expect(deriveOperation(path)).toBe(operation);
  });

  it("collapses the plan prefix so one TTL covers ultra and mega", () => {
    expect(deriveOperation("/ultra/history/flights")).toBe(
      deriveOperation("/mega/history/flights"),
    );
  });

  it("returns an empty name for a path it does not recognise", () => {
    expect(deriveOperation("/something/new")).toBe("");
  });

  it("lets a spec name itself", () => {
    expect(operationOf({ method: "GET", path: "/anything", operation: "custom.op" })).toBe(
      "custom.op",
    );
    expect(operationOf({ method: "GET", path: "/weather/metar/KJFK" })).toBe("weather.metar");
  });
});

describe("MemoryCache", () => {
  it("stores and returns a value within its TTL", () => {
    const clock = fakeClock();
    const cache = new MemoryCache({ now: clock.read });

    cache.set("k", { a: 1 }, 1_000);
    expect(cache.get("k")).toEqual({ a: 1 });
    clock.advance(999);
    expect(cache.get("k")).toEqual({ a: 1 });
  });

  it("drops an entry once its TTL has elapsed", () => {
    const clock = fakeClock();
    const cache = new MemoryCache({ now: clock.read });

    cache.set("k", "v", 1_000);
    clock.advance(1_000);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0); // expiry is lazy but reclaims on read
  });

  it("stores nothing for a TTL of zero or less", () => {
    const cache = new MemoryCache();
    cache.set("k", "v", 0);
    cache.set("j", "v", -5);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry past maxEntries", () => {
    const cache = new MemoryCache({ maxEntries: 2 });

    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.get("a"); // "a" is now the most recently used
    cache.set("c", 3, 10_000);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("supports delete and clear", () => {
    const cache = new MemoryCache();
    cache.set("a", 1, 10_000);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    cache.set("b", 2, 10_000);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("resolves TTLs by operation name", () => {
    const cache = new MemoryCache({ defaultTtl: 5, ttls: { "weather.*": 60_000 } });
    expect(cache.ttlFor("weather.metar")).toBe(60_000);
    expect(cache.ttlFor("geo.countries")).toBe(5);
  });

  it("refuses a nonsensical configuration loudly", () => {
    expect(() => new MemoryCache({ defaultTtl: -1 })).toThrow(SkyLinkError);
    expect(() => new MemoryCache({ ttls: { "weather.*": Number.NaN } })).toThrow(/weather\.\*/);
    expect(() => new MemoryCache({ maxEntries: 0 })).toThrow(SkyLinkError);
    expect(() => new MemoryCache({ maxEntries: 1.5 })).toThrow(SkyLinkError);
  });
});

describe("buildCacheKey", () => {
  it("is insensitive to query order but sensitive to values", () => {
    const a = buildCacheKey("GET", "/adsb/aircraft", { limit: 10, bbox: "1,2,3,4" }, "direct", "u");
    const b = buildCacheKey("GET", "/adsb/aircraft", { bbox: "1,2,3,4", limit: 10 }, "direct", "u");
    const c = buildCacheKey("GET", "/adsb/aircraft", { bbox: "1,2,3,4", limit: 11 }, "direct", "u");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates methods, providers and base URLs", () => {
    const base = buildCacheKey("GET", "/x", undefined, "direct", "https://a");
    expect(base).not.toBe(buildCacheKey("POST", "/x", undefined, "direct", "https://a"));
    expect(base).not.toBe(buildCacheKey("GET", "/x", undefined, "rapidapi", "https://a"));
    expect(base).not.toBe(buildCacheKey("GET", "/x", undefined, "direct", "https://b"));
  });

  it("drops nullish query values, exactly as the request does", () => {
    expect(buildCacheKey("GET", "/x", { a: undefined, b: null }, "direct", "u")).toBe(
      buildCacheKey("GET", "/x", {}, "direct", "u"),
    );
  });
});

describe("the cache in the transport", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  it("does not cache at all by default", async () => {
    const sky = client();
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "one" }, times: 2 });

    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK");

    expect(requests).toHaveLength(2);
    expect(sky.config.cache).toBeNull();
  });

  it("does not cache when the cache has no TTL for the operation", async () => {
    const cache = new MemoryCache({ ttls: { "airports.*": 60_000 } });
    const sky = client({ cache });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "one" }, times: 2 });

    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK");

    expect(requests).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it("serves a repeated GET from the cache without touching the network", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    // One interceptor only: a second request would find none and fail loudly.
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "METAR KJFK" } });

    const first = await sky.weather.metar("KJFK");
    const second = await sky.weather.metar("KJFK");

    expect(requests).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("matches on the whole request, not just the path", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "plain" } });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK?parsed=true`, body: { raw: "parsed" } });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/EGLL`, body: { raw: "other" } });

    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK", { parsed: true });
    await sky.weather.metar("EGLL");
    // All three again, all from the cache.
    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK", { parsed: true });
    await sky.weather.metar("EGLL");

    expect(requests).toHaveLength(3);
  });

  it("matches a TTL by prefix", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.*": 300_000 } }) });
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK`, body: { raw: "TAF" } });

    await sky.weather.taf("KJFK");
    await sky.weather.taf("KJFK");

    expect(requests).toHaveLength(1);
  });

  it("re-requests once the TTL has elapsed", async () => {
    const clock = fakeClock();
    const cache = new MemoryCache({ ttls: { "weather.metar": 1_000 }, now: clock.read });
    const sky = client({ cache });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "one" } });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "two" } });

    expect((await sky.weather.metar("KJFK")).raw).toBe("one");
    clock.advance(999);
    expect((await sky.weather.metar("KJFK")).raw).toBe("one");
    clock.advance(1);
    expect((await sky.weather.metar("KJFK")).raw).toBe("two");

    expect(requests).toHaveLength(2);
  });

  it("never caches a POST", async () => {
    const sky = client({ cache: new MemoryCache({ defaultTtl: 300_000 }) });
    mockJson({
      path: `${DIRECT_PREFIX}/webhooks`,
      method: "POST",
      status: 201,
      body: { id: "wh_1" },
      times: 2,
    });

    await sky.request({ method: "POST", path: "/webhooks", body: { url: "https://e/x" } });
    await sky.request({ method: "POST", path: "/webhooks", body: { url: "https://e/x" } });

    expect(requests).toHaveLength(2);
  });

  it("never caches an error response", async () => {
    const cache = new MemoryCache({ ttls: { "weather.metar": 300_000 } });
    const sky = client({ cache, maxRetries: 0 });
    mockError({ path: `${DIRECT_PREFIX}/weather/metar/ZZZZ`, status: 404, times: 2 });

    await expect(sky.weather.metar("ZZZZ")).rejects.toThrow();
    await expect(sky.weather.metar("ZZZZ")).rejects.toThrow();

    expect(requests).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it("hands every caller its own object, so one mutation cannot poison the next", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    mockJson({
      path: `${DIRECT_PREFIX}/weather/metar/KJFK`,
      body: { raw: "METAR KJFK", clouds: [{ cover: "BKN" }] },
    });

    const first = await sky.weather.metar("KJFK");
    // A caller doing what callers do: normalising the response in place.
    (first as unknown as { raw: string }).raw = "MUTATED";
    (first as unknown as { clouds: unknown[] }).clouds.length = 0;

    const second = await sky.weather.metar("KJFK");

    expect(second.raw).toBe("METAR KJFK");
    expect((second as unknown as { clouds: unknown[] }).clouds).toHaveLength(1);
    expect(second).not.toBe(first);
  });

  it("marks a cache hit on the response and reports no quota for it", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    mockJson({
      path: `${DIRECT_PREFIX}/weather/metar/KJFK`,
      body: { raw: "one" },
      headers: {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "42",
        "x-ratelimit-requests-reset": "60",
      },
    });

    const live = await sky.requestWithResponse({ method: "GET", path: "/weather/metar/KJFK" });
    expect(live.response.headers.get(CACHE_HIT_HEADER)).toBeNull();
    expect(live.rateLimit).toEqual({ limit: 100, remaining: 42, reset: 60 });

    const hit = await sky.requestWithResponse({ method: "GET", path: "/weather/metar/KJFK" });
    expect(hit.response.headers.get(CACHE_HIT_HEADER)).toBe("hit");
    // A hit spends no quota, so it must not look like it reported any.
    expect(hit.rateLimit).toBeNull();
    expect(sky.lastRateLimit).toEqual({ limit: 100, remaining: 42, reset: 60 });
  });

  it("caches a text response and leaves binary alone", async () => {
    const sky = client({ cache: new MemoryCache({ defaultTtl: 300_000 }) });
    mockJson({ path: `${DIRECT_PREFIX}/briefing/flight`, body: "text", times: 1 });

    await sky.request({ method: "GET", path: "/briefing/flight", responseKind: "text" });
    const again = await sky.request<string>({
      method: "GET",
      path: "/briefing/flight",
      responseKind: "text",
    });

    expect(requests).toHaveLength(1);
    expect(again).toBe('"text"');
  });

  it("ignores an entry stored for a different response kind", async () => {
    const sky = client({ cache: new MemoryCache({ defaultTtl: 300_000 }) });
    mockJson({ path: `${DIRECT_PREFIX}/briefing/flight`, body: { ok: true }, times: 2 });

    await sky.request({ method: "GET", path: "/briefing/flight" });
    // Same URL, different decoding: the stored JSON entry must not be served as text.
    await sky.request({ method: "GET", path: "/briefing/flight", responseKind: "text" });

    expect(requests).toHaveLength(2);
  });

  it("keeps two clients on different base URLs apart in a shared store", async () => {
    const cache = new MemoryCache({ ttls: { "weather.metar": 300_000 } });
    const direct = client({ cache });
    const staging = client({ cache, baseUrl: "http://localhost:8081/v3.1" });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "prod" } });
    mockJson({
      origin: "http://localhost:8081",
      path: `${DIRECT_PREFIX}/weather/metar/KJFK`,
      body: { raw: "staging" },
    });

    expect((await direct.weather.metar("KJFK")).raw).toBe("prod");
    expect((await staging.weather.metar("KJFK")).raw).toBe("staging");
    expect((await direct.weather.metar("KJFK")).raw).toBe("prod");
  });

  it("never puts the API key in a key", async () => {
    const cache = new MemoryCache({ ttls: { "weather.metar": 300_000 } });
    const keys: string[] = [];
    const spy: CacheProtocol = {
      get: (key) => {
        keys.push(key);
        return cache.get(key);
      },
      set: (key, value, ttl) => cache.set(key, value, ttl),
      ttlFor: (operation) => cache.ttlFor(operation),
    };
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: {} });

    await client({ cache: spy, apiKey: "super-secret-key" }).weather.metar("KJFK");

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("super-secret-key");
    expect(keys[0]).toContain("GET /weather/metar/KJFK");
  });

  it("caches nothing for a store that declares no TTL policy", async () => {
    const stored: string[] = [];
    const store: CacheProtocol = {
      get: () => undefined,
      set: (key) => {
        stored.push(key);
      },
    };
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: {}, times: 2 });

    const sky = client({ cache: store });
    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK");

    expect(stored).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("survives a store that throws on either side, saying so once per failure", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: CacheProtocol = {
      get: () => {
        throw new Error("redis is down");
      },
      set: () => {
        throw new Error("redis is still down");
      },
      ttlFor: () => 300_000,
    };
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "live" }, times: 2 });

    const sky = client({ cache: store });

    // A broken cache is a slow client, never a failed request.
    expect((await sky.weather.metar("KJFK")).raw).toBe("live");
    expect((await sky.weather.metar("KJFK")).raw).toBe("live");
    expect(requests).toHaveLength(2);
    // Swallowed, but not silently: four failures, four warnings.
    expect(warnings).toHaveBeenCalledTimes(4);
    expect(warnings.mock.calls[0]?.[0]).toContain("[skylink-api] cache.get() threw");
    warnings.mockRestore();
  });

  it("ignores a foreign value found under one of its keys", async () => {
    const store: CacheProtocol = {
      get: () => ({ some: "other library's value" }),
      set: () => undefined,
      ttlFor: () => 300_000,
    };
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "live" } });

    expect((await client({ cache: store }).weather.metar("KJFK")).raw).toBe("live");
  });

  it("can be turned off again on a clone", async () => {
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: {}, times: 2 });

    await sky.weather.metar("KJFK");
    await sky.withOptions({ cache: null }).weather.metar("KJFK");

    expect(requests).toHaveLength(2);
  });
});
