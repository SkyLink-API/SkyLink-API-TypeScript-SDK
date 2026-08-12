/**
 * Quota observers: `client.onRateLimit()` and `client.onQuotaLow()`.
 *
 * Three properties are the point of the feature:
 *
 * 1. **The callback sees its own response.** Reading `client.lastRateLimit` inside a
 *    callback is wrong under concurrency — it is last-writer-wins — so the info is
 *    passed in, and this is tested with two overlapping requests.
 * 2. **`onQuotaLow` fires on the crossing, not on the state.** A client below the
 *    threshold answers hundreds of requests; the alert must arrive once.
 * 3. **An observer cannot break the thing it observes.** A callback that throws is
 *    reported on `console.warn` and the request still resolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError } from "../src/core/errors.js";
import type { RateLimitInfo } from "../src/core/ratelimit.js";
import type { FetchLike } from "../src/core/types.js";
import { MemoryCache } from "../src/helpers/cache.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

/** Quota headers for a response with `remaining` of `limit` left. */
function quotaHeaders(remaining: number, limit = 100): Record<string, string> {
  return {
    "x-ratelimit-requests-limit": String(limit),
    "x-ratelimit-requests-remaining": String(remaining),
    "x-ratelimit-requests-reset": "3600",
  };
}

function ping(sky: SkyLink): Promise<unknown> {
  return sky.request({ method: "GET", path: "/health" });
}

describe("onRateLimit", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  it("fires once per response carrying quota headers", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    sky.onRateLimit((info) => seen.push(info));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(99) });
    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(98) });
    await ping(sky);
    await ping(sky);

    expect(seen).toEqual([
      { limit: 100, remaining: 99, reset: 3600 },
      { limit: 100, remaining: 98, reset: 3600 },
    ]);
    expect(sky.lastRateLimit).toEqual(seen[1]);
  });

  it("stays quiet for a response without quota headers", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    sky.onRateLimit((info) => seen.push(info));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {} });
    await ping(sky);

    expect(seen).toEqual([]);
  });

  it("fires for an error response too — a 429 is exactly when you want to know", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client({ maxRetries: 0 });
    sky.onRateLimit((info) => seen.push(info));

    mockError({ path: `${DIRECT_PREFIX}/health`, status: 429, headers: quotaHeaders(0) });
    await expect(ping(sky)).rejects.toThrow();

    expect(seen).toEqual([{ limit: 100, remaining: 0, reset: 3600 }]);
  });

  it("stops firing after the returned unsubscribe is called", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    const off = sky.onRateLimit((info) => seen.push(info));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(99), times: 2 });
    await ping(sky);
    off();
    await ping(sky);

    expect(seen).toHaveLength(1);
  });

  it("runs every registered listener", async () => {
    const calls: string[] = [];
    const sky = client();
    sky.onRateLimit(() => calls.push("a"));
    sky.onRateLimit(() => calls.push("b"));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(99) });
    await ping(sky);

    expect(calls).toEqual(["a", "b"]);
  });

  it("does not fire on a cache hit, which spends no quota", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) });
    sky.onRateLimit((info) => seen.push(info));

    mockJson({
      path: `${DIRECT_PREFIX}/weather/metar/KJFK`,
      body: {},
      headers: quotaHeaders(99),
    });
    await sky.weather.metar("KJFK");
    await sky.weather.metar("KJFK");

    expect(seen).toHaveLength(1);
  });

  it("keeps a throwing listener from failing the request, and says so", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sky = client();
    sky.onRateLimit(() => {
      throw new Error("metrics backend is down");
    });
    const after: RateLimitInfo[] = [];
    sky.onRateLimit((info) => after.push(info));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: { ok: true }, headers: quotaHeaders(99) });

    await expect(ping(sky)).resolves.toEqual({ ok: true });
    // The next listener still runs, and the failure is not swallowed silently.
    expect(after).toHaveLength(1);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]?.[0]).toContain("onRateLimit() listener threw");
    warnings.mockRestore();
  });

  it("hands each listener the info of its own response, not the shared snapshot", async () => {
    // Two overlapping requests: the second finishes first, so `lastRateLimit` no
    // longer describes the first one by the time its callback runs.
    const seen: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const slow = url.includes("slow");
      await new Promise((resolve) => setTimeout(resolve, slow ? 30 : 1));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", ...quotaHeaders(slow ? 50 : 10) },
      });
    };
    const sky = client({ fetch: fetchImpl });
    sky.onRateLimit((info) => seen.push(info.remaining ?? -1));

    await Promise.all([
      sky.request({ method: "GET", path: "/slow" }),
      sky.request({ method: "GET", path: "/fast" }),
    ]);

    expect(seen.sort((a, b) => a - b)).toEqual([10, 50]);
  });
});

describe("onQuotaLow", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  it("fires once when the quota crosses the threshold, not on every response below it", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    sky.onQuotaLow((info) => seen.push(info));

    for (const remaining of [50, 11, 10, 9, 8]) {
      mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(remaining) });
    }
    for (let i = 0; i < 5; i++) await ping(sky);

    // 10/100 is the first reading at or below the default 0.1.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.remaining).toBe(10);
  });

  it("rearms when the window resets above the threshold", async () => {
    const seen: number[] = [];
    const sky = client();
    sky.onQuotaLow((info) => seen.push(info.remaining ?? -1));

    for (const remaining of [5, 4, 100, 3]) {
      mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(remaining) });
    }
    for (let i = 0; i < 4; i++) await ping(sky);

    expect(seen).toEqual([5, 3]);
  });

  it("honours a custom threshold", async () => {
    const seen: number[] = [];
    const sky = client();
    sky.onQuotaLow((info) => seen.push(info.remaining ?? -1), { threshold: 0.5 });

    for (const remaining of [60, 50, 40]) {
      mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(remaining) });
    }
    for (let i = 0; i < 3; i++) await ping(sky);

    expect(seen).toEqual([50]);
  });

  it("ignores a reading it cannot turn into a fraction", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    sky.onQuotaLow((info) => seen.push(info));

    mockJson({
      path: `${DIRECT_PREFIX}/health`,
      body: {},
      headers: { "x-ratelimit-requests-remaining": "0" },
    });
    mockJson({
      path: `${DIRECT_PREFIX}/health`,
      body: {},
      headers: { ...quotaHeaders(0, 0) },
    });
    await ping(sky);
    await ping(sky);

    // No limit, or a limit of zero: "0 of nothing left" is not a percentage.
    expect(seen).toEqual([]);
  });

  it("stops after unsubscribing", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    const off = sky.onQuotaLow((info) => seen.push(info));
    off();

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(1) });
    await ping(sky);

    expect(seen).toEqual([]);
  });

  it("keeps each subscription's own crossing state", async () => {
    const tight: number[] = [];
    const loose: number[] = [];
    const sky = client();
    sky.onQuotaLow((info) => tight.push(info.remaining ?? -1), { threshold: 0.05 });
    sky.onQuotaLow((info) => loose.push(info.remaining ?? -1), { threshold: 0.5 });

    for (const remaining of [60, 40, 4]) {
      mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(remaining) });
    }
    for (let i = 0; i < 3; i++) await ping(sky);

    expect(loose).toEqual([40]);
    expect(tight).toEqual([4]);
  });

  it("rejects a threshold outside 0..1 before anything is registered", () => {
    const sky = client();
    expect(() => sky.onQuotaLow(() => undefined, { threshold: 1.5 })).toThrow(SkyLinkError);
    expect(() => sky.onQuotaLow(() => undefined, { threshold: -0.1 })).toThrow(/between 0 and 1/);
  });

  it("keeps a throwing listener from failing the request", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sky = client();
    sky.onQuotaLow(() => {
      throw new Error("pager is down");
    });

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: { ok: true }, headers: quotaHeaders(1) });

    await expect(ping(sky)).resolves.toEqual({ ok: true });
    expect(warnings.mock.calls[0]?.[0]).toContain("onQuotaLow() listener threw");
    warnings.mockRestore();
  });

  it("is not inherited by a clone", async () => {
    const seen: RateLimitInfo[] = [];
    const sky = client();
    sky.onQuotaLow((info) => seen.push(info));
    sky.onRateLimit((info) => seen.push(info));

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: quotaHeaders(1) });
    await ping(sky.withOptions({ timeout: 5_000 }));

    expect(seen).toEqual([]);
  });
});
