import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import {
  APIStatusError,
  AuthenticationError,
  BadRequestError,
  createStatusError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  parseErrorBody,
  RateLimitError,
  ServiceUnavailableError,
  SkyLinkError,
  UnprocessableEntityError,
} from "../src/core/errors.js";
import { DIRECT_PREFIX, mockError, setupMockAgent, teardownMockAgent } from "./helpers/mock.js";

describe("parseErrorBody", () => {
  it("parses form A — gateway 401 { error, message, code }", () => {
    const parsed = parseErrorBody(
      {
        error: "Unauthorized",
        message: "Marketplace access required",
        code: "MARKETPLACE_ACCESS_REQUIRED",
      },
      401,
    );
    expect(parsed.message).toBe("Marketplace access required");
    expect(parsed.code).toBe("MARKETPLACE_ACCESS_REQUIRED");
    expect(parsed.errors).toBeNull();
  });

  it("parses form B — HTTPException { detail: string }", () => {
    const parsed = parseErrorBody({ detail: "Airport not found" }, 404);
    expect(parsed.message).toBe("Airport not found");
    expect(parsed.code).toBeNull();
    expect(parsed.errors).toBeNull();
  });

  it("parses form C — validation { detail: [{ loc, msg, type }] }", () => {
    const parsed = parseErrorBody(
      {
        detail: [
          { loc: ["query", "icao"], msg: "field required", type: "value_error.missing" },
          { loc: ["query", "limit"], msg: "ensure this value is <= 500", type: "value_error" },
        ],
      },
      422,
    );
    expect(parsed.message).toBe(
      "query.icao: field required; query.limit: ensure this value is <= 500",
    );
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors?.[0]).toEqual({
      loc: ["query", "icao"],
      msg: "field required",
      type: "value_error.missing",
    });
  });

  it("falls back to a raw string body", () => {
    expect(parseErrorBody("Bad Gateway", 502).message).toBe("Bad Gateway");
  });

  it("falls back to the status code for unknown shapes", () => {
    expect(parseErrorBody({ unexpected: true }, 500).message).toBe("HTTP 500");
    expect(parseErrorBody(null, 500).message).toBe("HTTP 500");
    expect(parseErrorBody("", 500).message).toBe("HTTP 500");
  });
});

describe("createStatusError", () => {
  const cases: [number, new (...args: never[]) => APIStatusError][] = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [422, UnprocessableEntityError],
    [429, RateLimitError],
    [500, InternalServerError],
    [503, ServiceUnavailableError],
  ];

  for (const [status, ctor] of cases) {
    it(`maps ${status} to ${ctor.name}`, () => {
      const error = createStatusError(status, { detail: "boom" });
      expect(error).toBeInstanceOf(ctor);
      expect(error).toBeInstanceOf(APIStatusError);
      expect(error).toBeInstanceOf(SkyLinkError);
      expect(error.status).toBe(status);
      expect(error.statusCode).toBe(status);
      expect(error.message).toBe("boom");
    });
  }

  it("maps unmapped 5xx codes to InternalServerError", () => {
    expect(createStatusError(502, { detail: "bad gateway" })).toBeInstanceOf(InternalServerError);
    expect(createStatusError(504, { detail: "timeout" })).toBeInstanceOf(InternalServerError);
  });

  it("keeps 503 distinguishable from a generic 500", () => {
    const error = createStatusError(503, { detail: "upstream unavailable" });
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toBeInstanceOf(InternalServerError);
  });

  it("exposes validation details on 422", () => {
    const error = createStatusError(422, {
      detail: [{ loc: ["query", "icao"], msg: "field required", type: "missing" }],
    }) as UnprocessableEntityError;
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]?.msg).toBe("field required");
  });

  it("carries the gateway code, headers and raw body", () => {
    const body = { error: "Unauthorized", message: "nope", code: "INVALID_GATEWAY_KEY" };
    const error = createStatusError(401, body, { headers: { "x-request-id": "abc" } });
    expect(error.code).toBe("INVALID_GATEWAY_KEY");
    expect(error.headers["x-request-id"]).toBe("abc");
    expect(error.body).toBe(body);
  });

  it("attaches rate-limit context to 429", () => {
    const error = createStatusError(
      429,
      { detail: "Too many requests" },
      { rateLimit: { limit: 100, remaining: 0, reset: 30 }, retryAfter: 3000 },
    ) as RateLimitError;
    expect(error.rateLimit).toEqual({ limit: 100, remaining: 0, reset: 30 });
    expect(error.retryAfter).toBe(3000);
  });

  it("produces errors that behave like Error instances", () => {
    const error = createStatusError(404, { detail: "missing" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotFoundError");
    expect(String(error)).toContain("missing");
    expect(typeof error.stack).toBe("string");
  });
});

describe("error mapping over the wire", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  function client(): SkyLink {
    return new SkyLink({
      apiKey: "key",
      provider: "direct",
      maxRetries: 0,
      sleep: async () => undefined,
    });
  }

  it("throws AuthenticationError with the gateway code on 401", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/weather/metar/KJFK`,
      status: 401,
      body: {
        error: "Unauthorized",
        message: "Marketplace access required",
        code: "MARKETPLACE_ACCESS_REQUIRED",
      },
    });

    await expect(
      client().request({ method: "GET", path: "/weather/metar/KJFK" }),
    ).rejects.toMatchObject({
      name: "AuthenticationError",
      status: 401,
      code: "MARKETPLACE_ACCESS_REQUIRED",
      message: "Marketplace access required",
    });
  });

  it("throws NotFoundError with the detail string on 404", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/airports/search?icao=ZZZZ`,
      status: 404,
      body: { detail: "Airport ZZZZ not found" },
    });

    const promise = client().request({
      method: "GET",
      path: "/airports/search",
      query: { icao: "ZZZZ" },
    });
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(promise).rejects.toThrow("Airport ZZZZ not found");
  });

  it("throws UnprocessableEntityError carrying parsed validation items on 422", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/navaids`,
      status: 422,
      body: {
        detail: [{ loc: ["query", "ident"], msg: "field required", type: "missing" }],
      },
    });

    try {
      await client().request({ method: "GET", path: "/navaids" });
      expect.unreachable("expected the request to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityError);
      const typed = error as UnprocessableEntityError;
      expect(typed.errors[0]?.loc).toEqual(["query", "ident"]);
      expect(typed.status).toBe(422);
    }
  });

  it("exposes RateLimitInfo on RateLimitError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/adsb/aircraft`,
      status: 429,
      body: { detail: "Too many requests" },
      headers: {
        "x-ratelimit-requests-limit": "1000",
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "42",
        "retry-after": "2",
      },
    });

    try {
      await client().request({ method: "GET", path: "/adsb/aircraft" });
      expect.unreachable("expected the request to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      const typed = error as RateLimitError;
      expect(typed.rateLimit).toEqual({ limit: 1000, remaining: 0, reset: 42 });
      expect(typed.retryAfter).toBe(2000);
    }
  });

  it("throws a non-retryable BadRequestError on 400", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/navaids`,
      status: 400,
      body: { detail: "At least one filter is required" },
    });

    await expect(client().request({ method: "GET", path: "/navaids" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("throws PermissionDeniedError on 403", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/webhooks`,
      method: "POST",
      status: 403,
      body: { detail: "Webhooks are not available on the BASIC plan" },
    });

    await expect(
      client().request({ method: "POST", path: "/webhooks", body: { url: "https://x.dev" } }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("handles a non-JSON error body", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/health`,
      status: 502,
      body: "upstream boom",
    });

    await expect(client().request({ method: "GET", path: "/health" })).rejects.toThrow(
      "upstream boom",
    );
  });
});
