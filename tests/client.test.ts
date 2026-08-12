import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import {
  type ClientOptions,
  DEFAULT_MAX_RETRIES,
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

  it("defaults to the direct provider", () => {
    const config = resolveConfig({ apiKey: "secret" });
    expect(config.provider).toBe("direct");
    expect(config.baseUrl).toBe(DIRECT_BASE_URL);
    expect(config.baseUrl).toBe("https://data.skylinkapi.com/v3.1");
    expect(config.defaultHeaders["x-api-key"]).toBe("secret");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBeUndefined();
    expect(config.timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(config.historyPlan).toBe("ultra");
  });

  it("configures the RapidAPI channel with both marketplace headers", () => {
    const config = resolveConfig({ apiKey: "rapid-secret", provider: "rapidapi" });
    expect(config.baseUrl).toBe(RAPIDAPI_BASE_URL);
    expect(config.baseUrl).toBe("https://skylink-api.p.rapidapi.com");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("rapid-secret");
    expect(config.defaultHeaders["X-RapidAPI-Host"]).toBe(RAPIDAPI_HOST);
    expect(config.defaultHeaders["x-api-key"]).toBeUndefined();
  });

  it("sends the node User-Agent", () => {
    expect(USER_AGENT).toBe(`skylink-api-node/${VERSION}`);
    expect(resolveConfig({ apiKey: "k" }).defaultHeaders["User-Agent"]).toBe(
      "skylink-api-node/0.1.0",
    );
  });

  it("falls back to SKYLINK_API_KEY for the direct provider", () => {
    process.env.SKYLINK_API_KEY = "env-direct";
    expect(resolveConfig().apiKey).toBe("env-direct");
    expect(resolveConfig().defaultHeaders["x-api-key"]).toBe("env-direct");
  });

  it("falls back to RAPIDAPI_KEY for the rapidapi provider", () => {
    process.env.RAPIDAPI_KEY = "env-rapid";
    const config = resolveConfig({ provider: "rapidapi" });
    expect(config.apiKey).toBe("env-rapid");
    expect(config.defaultHeaders["X-RapidAPI-Key"]).toBe("env-rapid");
  });

  it("does not read the other provider's environment variable", () => {
    process.env.SKYLINK_API_KEY = "env-direct";
    expect(() => resolveConfig({ provider: "rapidapi" })).toThrow(AuthenticationError);
  });

  it("prefers an explicit key over the environment", () => {
    process.env.SKYLINK_API_KEY = "env-direct";
    expect(resolveConfig({ apiKey: "explicit" }).apiKey).toBe("explicit");
  });

  it("throws AuthenticationError when no key can be found", () => {
    expect(() => resolveConfig()).toThrow(AuthenticationError);
    expect(() => resolveConfig()).toThrow(/SKYLINK_API_KEY/);
    expect(() => resolveConfig({ provider: "rapidapi" })).toThrow(/RAPIDAPI_KEY/);
  });

  it("allows a keyless client when baseUrl is explicit (staging with auth disabled)", () => {
    const config = resolveConfig({ baseUrl: "http://localhost:8081/v3.1" });
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe("http://localhost:8081/v3.1");
    expect(config.defaultHeaders["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders["User-Agent"]).toBe(USER_AGENT);
  });

  it("trims trailing slashes from baseUrl", () => {
    expect(
      resolveConfig({ apiKey: "k", baseUrl: "https://staging.example.com/v3.1//" }).baseUrl,
    ).toBe("https://staging.example.com/v3.1");
  });

  it("keeps auth headers when baseUrl is overridden with a key present", () => {
    const config = resolveConfig({ apiKey: "k", baseUrl: "http://localhost:8081" });
    expect(config.defaultHeaders["x-api-key"]).toBe("k");
  });

  it("merges caller-supplied default headers", () => {
    const config = resolveConfig({ apiKey: "k", defaultHeaders: { "X-Trace": "1" } });
    expect(config.defaultHeaders["X-Trace"]).toBe("1");
    expect(config.defaultHeaders["x-api-key"]).toBe("k");
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

  function client(options: ClientOptions = {}): SkyLink {
    return new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options });
  }

  it("issues a direct-channel request with the versioned path and x-api-key", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: { raw: "METAR KJFK 121751Z" } });

    const data = await client().request<{ raw: string }>({
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

  it("issues a RapidAPI request without the version prefix and with both marketplace headers", async () => {
    mockJson({
      origin: RAPIDAPI_ORIGIN,
      path: "/weather/metar/KJFK",
      body: { raw: "METAR KJFK" },
    });

    await client({ provider: "rapidapi", apiKey: "rapid-key" }).request({
      method: "GET",
      path: "/weather/metar/KJFK",
    });

    const request = requests[0];
    expect(request?.origin).toBe(RAPIDAPI_ORIGIN);
    expect(request?.path).toBe("/weather/metar/KJFK");
    expect(request?.headers["x-rapidapi-key"]).toBe("rapid-key");
    expect(request?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
    expect(request?.headers["x-api-key"]).toBeUndefined();
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

    const data = await new SkyLink({ apiKey: "k", fetch: customFetch }).request<{ ok: boolean }>({
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
