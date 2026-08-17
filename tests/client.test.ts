import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import {
  type ClientOptions,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  DIRECT_BASE_URL,
  RAPIDAPI_BASE_URL,
  RAPIDAPI_HOST,
  resolveConfig,
  USER_AGENT,
} from "../src/core/config.js";
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  SkyLinkError,
} from "../src/core/errors.js";
import type { FetchLike } from "../src/core/types.js";
import { MemoryCache } from "../src/helpers/cache.js";
import { VERSION } from "../src/version.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockBytes,
  mockEmpty,
  mockError,
  mockJson,
  mockText,
  RAPIDAPI_ORIGIN,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const ENV_KEYS = ["SKYLINK_API_KEY", "RAPIDAPI_KEY"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("resolveConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    clearEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to the RapidAPI provider with both marketplace headers", () => {
    const config = resolveConfig({ apiKey: "secret" });
    expect(DEFAULT_PROVIDER).toBe("rapidapi");
    expect(config.provider).toBe("rapidapi");
    expect(config.baseUrl).toBe(RAPIDAPI_BASE_URL);
    expect(config.baseUrl).toBe("https://skylink-api.p.rapidapi.com");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("secret");
    expect(config.defaultHeaders["X-RapidAPI-Host"]).toBe(RAPIDAPI_HOST);
    expect(config.defaultHeaders["x-api-key"]).toBeUndefined();
    expect(config.timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(config.historyPlan).toBe("ultra");
  });

  it("configures the direct channel when it is requested explicitly", () => {
    const config = resolveConfig({ apiKey: "direct-secret", provider: "direct" });
    expect(config.provider).toBe("direct");
    expect(config.baseUrl).toBe(DIRECT_BASE_URL);
    expect(config.baseUrl).toBe("https://data.skylinkapi.com/v3.1");
    expect(config.defaultHeaders["x-api-key"]).toBe("direct-secret");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBeUndefined();
    expect(config.defaultHeaders["X-RapidAPI-Host"]).toBeUndefined();
  });

  it("sends the node User-Agent", () => {
    expect(USER_AGENT).toBe(`skylink-api-node/${VERSION}`);
    expect(resolveConfig({ apiKey: "k" }).defaultHeaders["User-Agent"]).toBe(
      "skylink-api-node/0.1.0",
    );
  });

  it("falls back to RAPIDAPI_KEY on the default provider", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    const config = resolveConfig();
    expect(config.apiKey).toBe("env-rapid");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("env-rapid");
  });

  it("falls back to SKYLINK_API_KEY on the rapidapi provider when RAPIDAPI_KEY is absent", () => {
    process.env.SKYLINK_API_KEY = "env-shared";
    const config = resolveConfig();
    expect(config.provider).toBe("rapidapi");
    expect(config.apiKey).toBe("env-shared");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("env-shared");
  });

  it("prefers RAPIDAPI_KEY over SKYLINK_API_KEY on the rapidapi provider", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    process.env.SKYLINK_API_KEY = "env-direct";
    expect(resolveConfig({ provider: "rapidapi" }).apiKey).toBe("env-rapid");
  });

  it("falls back to SKYLINK_API_KEY for the direct provider", () => {
    process.env.SKYLINK_API_KEY = "env-direct";
    const config = resolveConfig({ provider: "direct" });
    expect(config.apiKey).toBe("env-direct");
    expect(config.defaultHeaders["x-api-key"]).toBe("env-direct");
  });

  it("never reads RAPIDAPI_KEY for the direct provider", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    expect(() => resolveConfig({ provider: "direct" })).toThrow(AuthenticationError);
  });

  it("prefers an explicit key over the environment", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    process.env.SKYLINK_API_KEY = "env-direct";
    expect(resolveConfig({ apiKey: "explicit" }).apiKey).toBe("explicit");
  });

  it("does not fall back to the environment for an explicitly blank key", () => {
    // `apiKey: ""` nearly always means an unset variable was interpolated.
    // Reaching for a *different* variable would hide that, so it is an error —
    // the Python SDK draws the line in the same place.
    process.env.RAPIDAPI_KEY = "env-rapid";
    expect(() => resolveConfig({ apiKey: "" })).toThrow(AuthenticationError);
    expect(() => resolveConfig({ apiKey: "   " })).toThrow(AuthenticationError);
    // Omitting the option entirely is the case that *does* read the environment.
    expect(resolveConfig({}).apiKey).toBe("env-rapid");
  });

  it("throws AuthenticationError when no key can be found", () => {
    expect(() => resolveConfig()).toThrow(AuthenticationError);
    expect(() => resolveConfig()).toThrow(
      /set the RAPIDAPI_KEY \(or SKYLINK_API_KEY\) environment variable/,
    );
    expect(() => resolveConfig({ provider: "direct" })).toThrow(AuthenticationError);
    // The direct branch names one variable only — a RapidAPI key is not an x-api-key.
    expect(() => resolveConfig({ provider: "direct" })).toThrow(
      /set the SKYLINK_API_KEY environment variable/,
    );
  });

  it("allows a keyless client when baseUrl is explicit (staging with auth disabled)", () => {
    const config = resolveConfig({ baseUrl: "http://localhost:8081/v3.1" });
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe("http://localhost:8081/v3.1");
    expect(config.defaultHeaders["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBeUndefined();
    expect(config.defaultHeaders["User-Agent"]).toBe(USER_AGENT);
  });

  it("trims trailing slashes from baseUrl", () => {
    expect(
      resolveConfig({ apiKey: "k", baseUrl: "https://staging.example.com/v3.1//" }).baseUrl,
    ).toBe("https://staging.example.com/v3.1");
  });

  it("keeps auth headers when baseUrl is overridden with a key present", () => {
    expect(
      resolveConfig({ apiKey: "k", baseUrl: "http://localhost:8081" }).defaultHeaders[
        "X-RapidAPI-Key"
      ],
    ).toBe("k");
    expect(
      resolveConfig({ apiKey: "k", provider: "direct", baseUrl: "http://localhost:8081" })
        .defaultHeaders["x-api-key"],
    ).toBe("k");
  });

  it("merges caller-supplied default headers", () => {
    const config = resolveConfig({ apiKey: "k", defaultHeaders: { "X-Trace": "1" } });
    expect(config.defaultHeaders["X-Trace"]).toBe("1");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("k");
  });

  it("honours the historyPlan option", () => {
    expect(resolveConfig({ apiKey: "k", historyPlan: "mega" }).historyPlan).toBe("mega");
  });

  it("rejects invalid timeout and maxRetries", () => {
    expect(() => resolveConfig({ apiKey: "k", timeout: 0 })).toThrow(SkyLinkError);
    expect(() => resolveConfig({ apiKey: "k", timeout: -1 })).toThrow(SkyLinkError);
    expect(() => resolveConfig({ apiKey: "k", maxRetries: -1 })).toThrow(SkyLinkError);
    expect(() => resolveConfig({ apiKey: "k", maxRetries: 1.5 })).toThrow(SkyLinkError);
  });
});

describe("SkyLink over the wire", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  /**
   * The rest of this suite exercises transport behaviour that is identical on both
   * channels, so it pins `direct` and keeps the `/v3.1` mock paths. The two tests
   * below cover the channels themselves.
   */
  function client(options: ClientOptions = {}): SkyLink {
    return new SkyLink({
      apiKey: "test-key",
      provider: "direct",
      sleep: async () => undefined,
      ...options,
    });
  }

  it("issues a RapidAPI request by default: no version prefix, both marketplace headers", async () => {
    mockJson({
      origin: RAPIDAPI_ORIGIN,
      path: "/weather/metar/KJFK",
      body: { raw: "METAR KJFK 121751Z" },
    });

    const data = await new SkyLink({ apiKey: "rapid-key" }).request<{ raw: string }>({
      method: "GET",
      path: "/weather/metar/KJFK",
    });

    expect(data.raw).toBe("METAR KJFK 121751Z");
    const request = requests[0];
    expect(request?.origin).toBe(RAPIDAPI_ORIGIN);
    expect(request?.path).toBe("/weather/metar/KJFK");
    expect(request?.headers["x-rapidapi-key"]).toBe("rapid-key");
    expect(request?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
    expect(request?.headers["user-agent"]).toBe(`skylink-api-node/${VERSION}`);
    expect(request?.headers["x-api-key"]).toBeUndefined();
  });

  it("issues a direct-channel request with the versioned path and x-api-key", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "METAR KJFK 121751Z" } });

    const data = await client({ provider: "direct" }).request<{ raw: string }>({
      method: "GET",
      path: "/weather/metar/KJFK",
    });

    expect(data.raw).toBe("METAR KJFK 121751Z");
    const request = requests[0];
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/weather/metar/KJFK");
    expect(request?.headers["x-api-key"]).toBe("test-key");
    expect(request?.headers["user-agent"]).toBe(`skylink-api-node/${VERSION}`);
    expect(request?.headers["x-rapidapi-key"]).toBeUndefined();
  });

  it("targets a custom baseUrl", async () => {
    mockJson({ origin: "http://localhost:8081", path: "/v3.1/health", body: { status: "ok" } });

    await new SkyLink({ baseUrl: "http://localhost:8081/v3.1" }).request({
      method: "GET",
      path: "/health",
    });

    expect(requests[0]?.origin).toBe("http://localhost:8081");
    expect(requests[0]?.path).toBe("/v3.1/health");
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("serializes the query string, dropping nullish values", async () => {
    mockJson({
      path: /^\/v3\.1\/adsb\/aircraft\?/,
      body: { aircraft: [], total_count: 0 },
    });

    await client().request({
      method: "GET",
      path: "/adsb/aircraft",
      query: {
        bbox: [40, -75, 42, -73],
        photos: false,
        limit: 25,
        callsign: undefined,
        registration: null,
      },
    });

    const query = requests[0]?.query;
    expect(query?.get("bbox")).toBe("40,-75,42,-73");
    expect(query?.get("photos")).toBe("false");
    expect(query?.get("limit")).toBe("25");
    expect(query?.has("callsign")).toBe(false);
    expect(query?.has("registration")).toBe(false);
  });

  it("sends a JSON body with a content-type on POST", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/webhooks`,
      method: "POST",
      status: 201,
      body: { id: "wh_1" },
    });

    await client().request({
      method: "POST",
      path: "/webhooks",
      body: { url: "https://example.com/hook", event_types: ["flight_landed"] },
    });

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "null")).toEqual({
      url: "https://example.com/hook",
      event_types: ["flight_landed"],
    });
  });

  it("merges per-request headers over the client defaults", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {} });

    await client({ defaultHeaders: { "X-Trace": "client", "X-Keep": "yes" } }).request(
      { method: "GET", path: "/health" },
      { headers: { "X-Trace": "call" } },
    );

    expect(requests[0]?.headers["x-trace"]).toBe("call");
    expect(requests[0]?.headers["x-keep"]).toBe("yes");
  });

  it("decodes text responses", async () => {
    mockText({ path: `${DIRECT_PREFIX}/briefing/flight`, body: "# Briefing" });

    const data = await client().request<string>({
      method: "GET",
      path: "/briefing/flight",
      responseKind: "text",
    });

    expect(data).toBe("# Briefing");
  });

  it("decodes binary responses as Uint8Array", async () => {
    mockBytes({ path: `${DIRECT_PREFIX}/briefing/pdf`, body: "%PDF-1.4 fake" });

    const data = await client().request<Uint8Array>({
      method: "GET",
      path: "/briefing/pdf",
      responseKind: "bytes",
    });

    expect(data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(data).toString("utf8").startsWith("%PDF")).toBe(true);
    expect(requests[0]?.headers.accept).toContain("application/pdf");
  });

  it("returns undefined for a 204 with responseKind none", async () => {
    mockEmpty({ path: `${DIRECT_PREFIX}/webhooks/abc`, method: "DELETE", status: 204 });

    const data = await client().request({
      method: "DELETE",
      path: "/webhooks/abc",
      responseKind: "none",
    });

    expect(data).toBeUndefined();
  });

  it("returns undefined for an empty JSON body", async () => {
    mockEmpty({ path: `${DIRECT_PREFIX}/webhooks/abc`, method: "DELETE", status: 204 });

    await expect(
      client().request({ method: "DELETE", path: "/webhooks/abc" }),
    ).resolves.toBeUndefined();
  });

  it("tracks lastRateLimit from the quota headers", async () => {
    const sky = client();
    expect(sky.lastRateLimit).toBeNull();

    mockJson({
      path: `${DIRECT_PREFIX}/health`,
      body: { status: "ok" },
      headers: {
        "x-ratelimit-requests-limit": "10000",
        "x-ratelimit-requests-remaining": "9987",
        "x-ratelimit-requests-reset": "3600",
      },
    });

    await sky.request({ method: "GET", path: "/health" });

    expect(sky.lastRateLimit).toEqual({ limit: 10000, remaining: 9987, reset: 3600 });
  });

  it("leaves lastRateLimit untouched when the response carries no quota headers", async () => {
    const sky = client();
    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {} });
    await sky.request({ method: "GET", path: "/health" });
    expect(sky.lastRateLimit).toBeNull();
  });

  it("updates lastRateLimit from an error response too", async () => {
    const sky = client({ maxRetries: 0 });
    mockError({
      path: `${DIRECT_PREFIX}/health`,
      status: 429,
      headers: {
        "x-ratelimit-requests-limit": "100",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "60",
      },
    });

    await expect(sky.request({ method: "GET", path: "/health" })).rejects.toThrow();
    expect(sky.lastRateLimit).toEqual({ limit: 100, remaining: 0, reset: 60 });
  });

  it("exposes the raw response through requestWithResponse", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/health`, body: { status: "ok" }, status: 200 });

    const result = await client().requestWithResponse<{ status: string }>({
      method: "GET",
      path: "/health",
    });

    expect(result.data).toEqual({ status: "ok" });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("application/json");
  });

  it("exposes config and baseUrl", () => {
    const sky = client({ historyPlan: "mega" });
    expect(sky.baseUrl).toBe(DIRECT_BASE_URL);
    expect(sky.config.historyPlan).toBe("mega");
  });
});

describe("SkyLink.fromEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    clearEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reads the key of the default channel from the environment", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    const sky = SkyLink.fromEnv();
    expect(sky.config.apiKey).toBe("env-rapid");
    expect(sky.config.provider).toBe("rapidapi");
  });

  it("applies overrides other than the key", () => {
    process.env.SKYLINK_API_KEY = "env-direct";
    const sky = SkyLink.fromEnv({ provider: "direct", timeout: 5_000, historyPlan: "mega" });
    expect(sky.config.apiKey).toBe("env-direct");
    expect(sky.config.baseUrl).toBe(DIRECT_BASE_URL);
    expect(sky.config.timeout).toBe(5_000);
    expect(sky.config.historyPlan).toBe("mega");
  });

  it("fails the same way the constructor does when the variable is unset", () => {
    expect(() => SkyLink.fromEnv()).toThrow(AuthenticationError);
  });
});

describe("SkyLink.withOptions", () => {
  function client(options: ClientOptions = {}): SkyLink {
    return new SkyLink({ apiKey: "test-key", provider: "direct", ...options });
  }

  it("overrides only what it is given and keeps the rest", () => {
    const sky = client({ timeout: 1_000, maxRetries: 1, historyPlan: "mega" });
    const clone = sky.withOptions({ timeout: 90_000 });

    expect(clone.config.timeout).toBe(90_000);
    expect(clone.config.maxRetries).toBe(1);
    expect(clone.config.historyPlan).toBe("mega");
    expect(clone.config.provider).toBe("direct");
    expect(clone.config.apiKey).toBe("test-key");
    expect(clone.baseUrl).toBe(sky.baseUrl);
    // The original is untouched.
    expect(sky.config.timeout).toBe(1_000);
  });

  it("reuses the same fetch, so the clone shares one connection pool", () => {
    const fetchImpl: FetchLike = async () => new Response("{}");
    const sky = client({ fetch: fetchImpl });
    expect(sky.withOptions({ maxRetries: 0 }).config.fetch).toBe(sky.config.fetch);
  });

  it("merges defaultHeaders over the original instead of replacing them", () => {
    const sky = client({ defaultHeaders: { "X-Trace": "1", "X-Keep": "yes" } });
    const clone = sky.withOptions({ defaultHeaders: { "X-Trace": "2" } });

    expect(clone.config.defaultHeaders["X-Trace"]).toBe("2");
    expect(clone.config.defaultHeaders["X-Keep"]).toBe("yes");
    expect(clone.config.defaultHeaders["x-api-key"]).toBe("test-key");
    expect(sky.config.defaultHeaders["X-Trace"]).toBe("1");
  });

  it("gives the clone its own namespaces and its own quota state", async () => {
    const sky = client();
    const clone = sky.withOptions({ maxRetries: 0 });

    expect(clone).not.toBe(sky);
    expect(clone.weather).not.toBe(sky.weather);
    expect(clone.compose).not.toBe(sky.compose);
    // Namespaces point at their own client, never at the one they were cloned from.
    expect((clone.weather as unknown as { client: SkyLink }).client).toBe(clone);
    expect(clone.lastRateLimit).toBeNull();
  });

  it("keeps a keyless staging client keyless", () => {
    const sky = new SkyLink({ baseUrl: "http://localhost:8081/v3.1" });
    const clone = sky.withOptions({ timeout: 1_000 });

    expect(clone.config.apiKey).toBeNull();
    expect(clone.baseUrl).toBe("http://localhost:8081/v3.1");
    expect(clone.config.defaultHeaders["x-api-key"]).toBeUndefined();
  });

  it("validates the overrides like the constructor does", () => {
    expect(() => client().withOptions({ timeout: 0 })).toThrow(SkyLinkError);
    expect(() => client().withOptions({ maxRetries: -1 })).toThrow(SkyLinkError);
  });
});

describe("SkyLink inspection", () => {
  it("describes the client without leaking the key", () => {
    const sky = new SkyLink({ apiKey: "super-secret-key-1234", provider: "direct" });
    const text = sky.toString();

    expect(text).not.toContain("super-secret-key-1234");
    expect(text).toContain("apiKey=****1234");
    expect(text).toContain("provider=direct");
    expect(text).toContain(DIRECT_BASE_URL);
    expect(text).toContain("timeout=30000ms");
    expect(text).toContain("maxRetries=3");
    expect(text).toContain("historyPlan=ultra");
    expect(text).toContain("cache=off");
  });

  it("masks a key too short to shorten, and says so when there is none", () => {
    expect(new SkyLink({ apiKey: "abcd", provider: "direct" }).toString()).toContain("apiKey=****");
    expect(new SkyLink({ baseUrl: "http://localhost:8081" }).toString()).toContain("apiKey=none");
  });

  it("names the cache when there is one", () => {
    const sky = new SkyLink({ apiKey: "k", cache: new MemoryCache({ defaultTtl: 1_000 }) });
    expect(sky.toString()).toContain("cache=MemoryCache");
  });

  it("uses the same text for util.inspect and console.log", () => {
    const sky = new SkyLink({ apiKey: "super-secret-key-1234" });
    expect(inspect(sky)).toBe(sky.toString());
    expect(inspect(sky)).not.toContain("super-secret-key-1234");
  });
});

describe("SkyLink with an injected fetch", () => {
  it("uses the custom implementation instead of the global fetch", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const customFetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const data = await new SkyLink({
      apiKey: "k",
      provider: "direct",
      fetch: customFetch,
    }).request<{ ok: boolean }>({
      method: "GET",
      path: "/health",
      query: { verbose: true },
    });

    expect(data).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://data.skylinkapi.com/v3.1/health?verbose=true");
  });

  it("wraps a network failure in APIConnectionError and retries idempotent verbs", async () => {
    let calls = 0;
    const flakyFetch: FetchLike = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const sky = new SkyLink({
      apiKey: "k",
      fetch: flakyFetch,
      sleep: async () => undefined,
    });

    await expect(sky.request({ method: "GET", path: "/health" })).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("does not retry a network failure on POST", async () => {
    let calls = 0;
    const failingFetch: FetchLike = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };

    const sky = new SkyLink({ apiKey: "k", fetch: failingFetch, sleep: async () => undefined });

    await expect(
      sky.request({ method: "POST", path: "/webhooks", body: {} }),
    ).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toBe(1);
  });

  /**
   * A `fetch` that answers after `ms` — and honours the abort signal, the way a real
   * one does. Without the listener the deadline can elapse without anything happening,
   * so a timeout test would pass whatever the SDK did.
   */
  function slowFetch(ms: number, body: unknown): FetchLike {
    return (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }, ms);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
  }

  it("raises APITimeoutError when the deadline elapses", async () => {
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    const sky = new SkyLink({
      apiKey: "k",
      fetch: hangingFetch,
      timeout: 20,
      maxRetries: 0,
    });

    await expect(sky.request({ method: "GET", path: "/health" })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
  });

  it("lets a spec's own timeout override the client default", async () => {
    // `/briefing/*` takes 30-85 s live, so its spec pins 180 s. Proven here by giving
    // the client a 20 ms deadline and answering after 60 ms: the call only survives if
    // the spec's timeout replaced the client's.
    const sky = new SkyLink({
      apiKey: "k",
      fetch: slowFetch(60, { origin: "KJFK", destination: "EGLL" }),
      timeout: 20,
      maxRetries: 0,
      sleep: async () => undefined,
    });

    const briefing = await sky.briefing.flight({ origin: "KJFK", destination: "EGLL" });
    expect(briefing.origin).toBe("KJFK");

    // The same client, on a route without a spec timeout, still honours its 20 ms.
    await expect(sky.weather.metar("KJFK")).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("lets per-call options override a spec's timeout", async () => {
    // The spec default is a default, not a ceiling.
    const sky = new SkyLink({
      apiKey: "k",
      fetch: slowFetch(60, {}),
      maxRetries: 0,
      sleep: async () => undefined,
    });

    await expect(
      sky.briefing.flight({ origin: "KJFK", destination: "EGLL" }, { timeout: 20 }),
    ).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("aborts immediately on an external signal and does not retry", async () => {
    let calls = 0;
    const hangingFetch: FetchLike = (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };

    const controller = new AbortController();
    const sky = new SkyLink({ apiKey: "k", fetch: hangingFetch, sleep: async () => undefined });
    const promise = sky.request({ method: "GET", path: "/health" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toBeInstanceOf(APIConnectionError);
    await expect(promise).rejects.toThrow("Request was aborted");
    expect(calls).toBe(1);
  });

  it("aborts during the retry backoff wait instead of sleeping it out", async () => {
    // A 503 with `Retry-After: 60` would park the default sleep for a minute;
    // the caller's abort must cut that wait short, not just the fetch itself.
    let calls = 0;
    const unavailableFetch: FetchLike = async () => {
      calls += 1;
      return new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    };

    const controller = new AbortController();
    const sky = new SkyLink({ apiKey: "k", fetch: unavailableFetch });
    const promise = sky.request({ method: "GET", path: "/health" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toBeInstanceOf(APIConnectionError);
    await expect(promise).rejects.toThrow("Request was aborted");
    expect(calls).toBe(1);
  });

  it("rejects a request whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sky = new SkyLink({
      apiKey: "k",
      fetch: async () => new Response("{}", { status: 200 }),
    });

    await expect(
      sky.request({ method: "GET", path: "/health" }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(APIConnectionError);
  });
});
