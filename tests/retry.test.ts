import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import {
  InternalServerError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from "../src/core/errors.js";
import {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
  parseRetryAfter,
  RETRY_AFTER_MAX_MS,
  RETRYABLE_STATUS_CODES,
  shouldRetryNetworkError,
  shouldRetryStatus,
  sleep,
} from "../src/core/retry.js";
import type { HttpMethod } from "../src/core/types.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const RETRYABLE = [429, 500, 502, 503, 504];
const NON_RETRYABLE = [400, 401, 403, 404, 422];

describe("shouldRetryStatus", () => {
  it("exposes exactly the documented retryable set", () => {
    expect([...RETRYABLE_STATUS_CODES].sort((a, b) => a - b)).toEqual(RETRYABLE);
  });

  for (const status of RETRYABLE) {
    it(`retries ${status} for GET`, () => {
      expect(shouldRetryStatus(status, "GET")).toBe(true);
    });
  }

  for (const status of NON_RETRYABLE) {
    it(`does not retry ${status} for GET`, () => {
      expect(shouldRetryStatus(status, "GET")).toBe(false);
    });
  }

  it("retries POST only on 429", () => {
    expect(shouldRetryStatus(429, "POST")).toBe(true);
    for (const status of [500, 502, 503, 504]) {
      expect(shouldRetryStatus(status, "POST")).toBe(false);
    }
  });

  it("retries other non-GET verbs like GET", () => {
    for (const method of ["DELETE", "PATCH", "PUT"] as HttpMethod[]) {
      expect(shouldRetryStatus(503, method)).toBe(true);
    }
  });
});

describe("shouldRetryNetworkError", () => {
  it("retries every verb except POST", () => {
    expect(shouldRetryNetworkError("GET")).toBe(true);
    expect(shouldRetryNetworkError("DELETE")).toBe(true);
    expect(shouldRetryNetworkError("PATCH")).toBe(true);
    expect(shouldRetryNetworkError("POST")).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses a delay in seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 2 ")).toBe(2000);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const target = new Date(now + 5000).toUTCString();
    expect(parseRetryAfter(target, now)).toBe(5000);
  });

  it("clamps an HTTP-date in the past to zero", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const target = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfter(target, now)).toBe(0);
  });

  it("caps both forms at 60 seconds", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter("600")).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now)).toBe(RETRY_AFTER_MAX_MS);
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("backoffDelay", () => {
  it("is zero when the jitter RNG bottoms out", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(backoffDelay(attempt, () => 0)).toBe(0);
    }
  });

  it("doubles the ceiling per attempt and caps at 8s", () => {
    const ceilings = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, () => 1));
    expect(ceilings).toEqual([
      BACKOFF_INITIAL_MS,
      1000,
      2000,
      4000,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
    ]);
  });

  it("scales linearly with the RNG output (full jitter)", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(250);
    expect(backoffDelay(2, () => 0.25)).toBe(500);
  });

  it("stays inside [0, ceiling) for real randomness", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** attempt);
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
      }
    }
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const started = Date.now();
    await sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("nope"));
    await expect(sleep(1000, controller.signal)).rejects.toThrow("nope");
  });

  it("rejects when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = sleep(5000, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 1);
    await expect(promise).rejects.toThrow("cancelled");
  });
});

describe("retry loop over the wire", () => {
  let delays: number[];

  beforeEach(() => {
    setupMockAgent();
    delays = [];
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  function client(overrides: { maxRetries?: number; random?: () => number } = {}): SkyLink {
    return new SkyLink({
      apiKey: "key",
      provider: "direct",
      maxRetries: overrides.maxRetries ?? 3,
      random: overrides.random ?? (() => 0.5),
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
  }

  it("retries a 500 and returns the eventual success", async () => {
    mockError({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, status: 500 });
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "METAR KJFK" } });

    const data = await client().request<{ raw: string }>({
      method: "GET",
      path: "/weather/metar/KJFK",
    });

    expect(data).toEqual({ raw: "METAR KJFK" });
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([250]);
  });

  it("retries 503 from a flaky upstream", async () => {
    mockError({ path: `${DIRECT_PREFIX}/notams/KJFK`, status: 503 });
    mockJson({
      path: `${DIRECT_PREFIX}/notams/KJFK`,
      body: { icao: "KJFK", notams: [], total: 0 },
    });

    await expect(client().request({ method: "GET", path: "/notams/KJFK" })).resolves.toMatchObject({
      icao: "KJFK",
    });
    expect(requests).toHaveLength(2);
  });

  it("honours Retry-After (seconds) instead of the jittered backoff", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/adsb/aircraft`,
      status: 429,
      headers: { "retry-after": "2" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: { aircraft: [], total_count: 0 } });

    await client().request({ method: "GET", path: "/adsb/aircraft" });

    expect(delays).toEqual([2000]);
  });

  it("honours Retry-After as an HTTP-date", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/adsb/aircraft`,
      status: 429,
      headers: { "retry-after": new Date(Date.now() + 4000).toUTCString() },
    });
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: { aircraft: [], total_count: 0 } });

    await client().request({ method: "GET", path: "/adsb/aircraft" });

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(2000);
    expect(delays[0]).toBeLessThanOrEqual(4000);
  });

  it("caps an absurd Retry-After at 60s", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/adsb/aircraft`,
      status: 429,
      headers: { "retry-after": "3600" },
    });
    mockJson({ path: `${DIRECT_PREFIX}/adsb/aircraft`, body: { aircraft: [] } });

    await client().request({ method: "GET", path: "/adsb/aircraft" });

    expect(delays).toEqual([RETRY_AFTER_MAX_MS]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    mockError({ path: `${DIRECT_PREFIX}/delays/faa`, status: 503, times: 4 });

    await expect(
      client({ maxRetries: 3 }).request({ method: "GET", path: "/delays/faa" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(requests).toHaveLength(4);
    expect(delays).toEqual([250, 500, 1000]);
  });

  it("does not retry at all when maxRetries is 0", async () => {
    mockError({ path: `${DIRECT_PREFIX}/delays/faa`, status: 500 });

    await expect(
      client({ maxRetries: 0 }).request({ method: "GET", path: "/delays/faa" }),
    ).rejects.toBeInstanceOf(InternalServerError);

    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("never retries a 404", async () => {
    mockError({ path: `${DIRECT_PREFIX}/routes/callsign/XXX999`, status: 404 });

    await expect(
      client().request({ method: "GET", path: "/routes/callsign/XXX999" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("does not retry a POST that failed with 500", async () => {
    mockError({ path: `${DIRECT_PREFIX}/webhooks`, method: "POST", status: 500 });

    await expect(
      client().request({
        method: "POST",
        path: "/webhooks",
        body: { url: "https://example.com/hook", event_types: ["flight_landed"] },
      }),
    ).rejects.toBeInstanceOf(InternalServerError);

    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("does retry a POST that failed with 429", async () => {
    mockError({ path: `${DIRECT_PREFIX}/webhooks`, method: "POST", status: 429 });
    mockJson({
      path: `${DIRECT_PREFIX}/webhooks`,
      method: "POST",
      status: 201,
      body: { id: "wh_1", active: true },
    });

    const created = await client().request<{ id: string }>({
      method: "POST",
      path: "/webhooks",
      body: { url: "https://example.com/hook" },
    });

    expect(created.id).toBe("wh_1");
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([250]);
  });

  it("surfaces RateLimitError once the retry budget is spent", async () => {
    mockError({ path: `${DIRECT_PREFIX}/adsb/aircraft`, status: 429, times: 2 });

    await expect(
      client({ maxRetries: 1 }).request({ method: "GET", path: "/adsb/aircraft" }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(requests).toHaveLength(2);
  });

  it("respects a per-call maxRetries override", async () => {
    mockError({ path: `${DIRECT_PREFIX}/delays/faa`, status: 500, times: 2 });
    mockJson({ path: `${DIRECT_PREFIX}/delays/faa`, body: { total_alerts: 0 } });

    await client({ maxRetries: 0 }).request(
      { method: "GET", path: "/delays/faa" },
      { maxRetries: 2 },
    );

    expect(requests).toHaveLength(3);
  });
});
