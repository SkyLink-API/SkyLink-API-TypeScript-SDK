/**
 * The `fetch` injection seam.
 *
 * `tests/client.test.ts` already covers the failure modes of a custom
 * implementation (network errors, deadlines, external abort). This file covers the
 * other half: that the injected implementation is the *only* one used, that it
 * receives exactly the URL, headers and body the SDK promises, that the retry loop
 * runs on top of it, and that typed resource methods — not just `request()` — go
 * through it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkyLink } from "../src/client.js";
import { RateLimitError, ServiceUnavailableError } from "../src/core/errors.js";
import type { FetchLike, Headers } from "../src/core/types.js";
import { VERSION } from "../src/version.js";

/** One call as it reached the injected implementation. */
interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/** A canned reply for the fake fetch to hand back. */
interface CannedReply {
  status?: number;
  body?: unknown;
  text?: string;
  bytes?: ArrayBuffer;
  headers?: Record<string, string>;
}

function toResponse(reply: CannedReply): Response {
  const status = reply.status ?? 200;
  if (status === 204) {
    return new Response(null, { status, headers: reply.headers });
  }
  if (reply.bytes) {
    return new Response(reply.bytes, {
      status,
      headers: { "content-type": "application/pdf", ...reply.headers },
    });
  }
  if (reply.text !== undefined) {
    return new Response(reply.text, {
      status,
      headers: { "content-type": "text/plain", ...reply.headers },
    });
  }
  return new Response(JSON.stringify(reply.body ?? null), {
    status,
    headers: { "content-type": "application/json", ...reply.headers },
  });
}

function normalizeHeaders(init: RequestInit | undefined): Headers {
  const headers: Headers = {};
  const raw = init?.headers;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

/**
 * Build a fake `fetch` that answers the given replies in order (the last one
 * repeats forever) and records every call it received.
 */
function recorder(...replies: CannedReply[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init),
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal ?? undefined,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    return toResponse(reply);
  };
  return { fetch: fetchImpl, calls };
}

describe("injected fetch", () => {
  let globalFetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Any leak to the global implementation must fail loudly rather than hit the network.
    globalFetchSpy = vi.fn(() => {
      throw new Error("the global fetch must not be called when a custom fetch is injected");
    });
    globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("serves a typed resource call without ever touching the global fetch", async () => {
    const { fetch, calls } = recorder({
      body: { raw: "METAR KJFK 121751Z 27012KT", icao: "KJFK", parsed: { flight_rules: "VFR" } },
    });
    const sky = new SkyLink({ apiKey: "test-key", fetch });

    const metar = await sky.weather.metar("KJFK", { parsed: true });

    expect(metar.raw).toBe("METAR KJFK 121751Z 27012KT");
    expect(globalFetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // No provider given → the default RapidAPI channel, hence no version prefix.
    expect(calls[0]?.url).toBe("https://skylink-api.p.rapidapi.com/weather/metar/KJFK?parsed=true");
    expect(calls[0]?.method).toBe("GET");
  });

  it("hands the injected implementation the full header set", async () => {
    const { fetch, calls } = recorder({ body: {} });
    const sky = new SkyLink({
      apiKey: "test-key",
      fetch,
      defaultHeaders: { "X-Trace": "client", "X-Keep": "yes" },
    });

    await sky.adsb.statistics({ headers: { "X-Trace": "call" } });

    const headers = calls[0]?.headers ?? {};
    expect(headers["x-rapidapi-key"]).toBe("test-key");
    expect(headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
    expect(headers["user-agent"]).toBe(`skylink-api-node/${VERSION}`);
    expect(headers.accept).toBe("application/json");
    expect(headers["x-keep"]).toBe("yes");
    expect(headers["x-trace"]).toBe("call");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("keeps the direct channel intact behind a custom fetch", async () => {
    const { fetch, calls } = recorder({ body: { aircraft: [], total_count: 0 } });
    const sky = new SkyLink({ provider: "direct", apiKey: "direct-key", fetch });

    await sky.adsb.aircraft({ lat: 40.64, lon: -73.78, radius: 50, photos: false });

    expect(calls[0]?.url).toBe(
      "https://data.skylinkapi.com/v3.1/adsb/aircraft?lat=40.64&lon=-73.78&radius=50&photos=false",
    );
    expect(calls[0]?.headers["x-api-key"]).toBe("direct-key");
    expect(calls[0]?.headers["x-rapidapi-key"]).toBeUndefined();
    expect(calls[0]?.headers["x-rapidapi-host"]).toBeUndefined();
  });

  it("passes the JSON body and content-type of a POST", async () => {
    const { fetch, calls } = recorder({ status: 201, body: { id: "wh_1", active: true } });
    const sky = new SkyLink({ apiKey: "k", fetch });

    const hook = await sky.webhooks.create({
      url: "https://hooks.example.com/skylink",
      event_types: ["flight_landed"],
      filters: { flight_number: "BA117" },
    });

    expect(hook.id).toBe("wh_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      url: "https://hooks.example.com/skylink",
      event_types: ["flight_landed"],
      filters: { flight_number: "BA117" },
    });
  });

  it("decodes a binary response produced by the injected fetch", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 briefing").buffer as ArrayBuffer;
    const { fetch, calls } = recorder({ bytes: pdf });
    const sky = new SkyLink({ apiKey: "k", fetch });

    const bytes = await sky.briefing.pdf({ departure_icao: "KJFK", arrival_icao: "EGLL" });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf8").startsWith("%PDF")).toBe(true);
    expect(calls[0]?.headers.accept).toContain("application/pdf");
  });

  it("gives every attempt its own abort signal", async () => {
    const { fetch, calls } = recorder({ status: 503 }, { status: 503 }, { body: { status: "ok" } });
    const sky = new SkyLink({
      apiKey: "k",
      fetch,
      sleep: async () => undefined,
      random: () => 0.5,
    });

    await sky.request({ method: "GET", path: "/adsb/health" });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBe(false);
    }
    expect(new Set(calls.map((c) => c.signal)).size).toBe(3);
  });
});

describe("retries on top of an injected fetch", () => {
  it("replays a 503 until it succeeds, backing off between attempts", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = recorder(
      { status: 503, body: { detail: "upstream unavailable" } },
      { status: 503, body: { detail: "upstream unavailable" } },
      { body: { status: "healthy", connected: true, active_aircraft_count: 4210 } },
    );
    const sky = new SkyLink({
      apiKey: "k",
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });

    const health = await sky.adsb.health();

    expect(health.status).toBe("healthy");
    expect(calls).toHaveLength(3);
    // full jitter with random() pinned to 0.5: 0.5 * min(8000, 500 * 2^attempt)
    expect(sleeps).toEqual([250, 500]);
  });

  it("prefers Retry-After over the computed backoff", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = recorder(
      { status: 429, body: { detail: "quota exceeded" }, headers: { "retry-after": "2" } },
      { body: { total_aircraft: 1 } },
    );
    const sky = new SkyLink({
      apiKey: "k",
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });

    await sky.adsb.statistics();

    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("stops after the retry budget and throws the mapped error", async () => {
    const { fetch, calls } = recorder({ status: 503, body: { detail: "upstream unavailable" } });
    const sky = new SkyLink({ apiKey: "k", fetch, maxRetries: 2, sleep: async () => undefined });

    await expect(sky.adsb.health()).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it("honours a per-request maxRetries override", async () => {
    const { fetch, calls } = recorder({ status: 503, body: { detail: "nope" } });
    const sky = new SkyLink({ apiKey: "k", fetch, maxRetries: 3, sleep: async () => undefined });

    await expect(
      sky.request({ method: "GET", path: "/adsb/health" }, { maxRetries: 0 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("does not replay a POST on 500 but does on 429", async () => {
    const failing = recorder({ status: 500, body: { detail: "boom" } });
    const skyFailing = new SkyLink({
      apiKey: "k",
      fetch: failing.fetch,
      sleep: async () => undefined,
    });

    await expect(
      skyFailing.webhooks.create({ url: "https://example.com/h", event_types: ["flight_landed"] }),
    ).rejects.toThrow();
    expect(failing.calls).toHaveLength(1);

    const throttled = recorder(
      { status: 429, body: { detail: "slow down" } },
      { status: 201, body: { id: "wh_2" } },
    );
    const skyThrottled = new SkyLink({
      apiKey: "k",
      fetch: throttled.fetch,
      sleep: async () => undefined,
    });

    const hook = await skyThrottled.webhooks.create({
      url: "https://example.com/h",
      event_types: ["flight_landed"],
    });
    expect(hook.id).toBe("wh_2");
    expect(throttled.calls).toHaveLength(2);
  });

  it("surfaces the quota snapshot the injected fetch reported", async () => {
    const { fetch } = recorder({
      status: 429,
      body: { detail: "quota exceeded" },
      headers: {
        "retry-after": "30",
        "x-ratelimit-requests-limit": "1000",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "900",
      },
    });
    const sky = new SkyLink({ apiKey: "k", fetch, maxRetries: 0 });

    const error = await sky.adsb.statistics().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    const rateLimitError = error as RateLimitError;
    expect(rateLimitError.retryAfter).toBe(30_000);
    expect(rateLimitError.rateLimit).toEqual({ limit: 1000, remaining: 0, reset: 900 });
    expect(sky.lastRateLimit).toEqual({ limit: 1000, remaining: 0, reset: 900 });
  });
});
