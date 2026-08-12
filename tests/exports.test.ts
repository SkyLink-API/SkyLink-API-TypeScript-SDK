/**
 * Guards the public surface of the package entry point.
 *
 * A namespace that exists in `src/resources/` but is never attached to the client
 * is invisible to users, and an error class that is not re-exported cannot be
 * caught by name. Both failures are silent — every other test file constructs the
 * pieces it needs directly — so they are asserted here against the barrel.
 */

import { describe, expect, it } from "vitest";
import * as SDK from "../src/index.js";
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  SkyLink,
  SkyLinkError,
  UnprocessableEntityError,
  VERSION,
} from "../src/index.js";

/**
 * Every namespace promised by the README and the marketing site, plus the three
 * client-side ones (`batch`, `poll`, `compose`) that wrap those endpoints rather
 * than adding new ones.
 */
const NAMESPACES = [
  "weather",
  "airports",
  "airlines",
  "navaids",
  "geo",
  "adsb",
  "aircraft",
  "charts",
  "delays",
  "notams",
  "schedules",
  "ml",
  "carbon",
  "briefing",
  "routes",
  "tickets",
  "webhooks",
  "history",
  "batch",
  "poll",
  "compose",
] as const;

function newClient(): SkyLink {
  return new SkyLink({ apiKey: "test" });
}

describe("public entry point", () => {
  it("exports the client class and the version", () => {
    expect(typeof SkyLink).toBe("function");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(SDK.VERSION).toBe(VERSION);
  });

  it("constructs from an explicit api key on the default (RapidAPI) channel", () => {
    const sky = newClient();
    expect(sky).toBeInstanceOf(SkyLink);
    expect(sky.config.apiKey).toBe("test");
    expect(sky.config.provider).toBe("rapidapi");
    expect(sky.baseUrl).toBe("https://skylink-api.p.rapidapi.com");
    expect(sky.lastRateLimit).toBeNull();
  });

  it("constructs the direct channel when asked for it", () => {
    const sky = new SkyLink({ apiKey: "test", provider: "direct" });
    expect(sky.config.provider).toBe("direct");
    expect(sky.baseUrl).toBe("https://data.skylinkapi.com/v3.1");
  });
});

describe("namespace wiring", () => {
  const sky = newClient();

  it.each(NAMESPACES)("exposes sky.%s as an object", (name) => {
    const namespace = (sky as unknown as Record<string, unknown>)[name];
    expect(namespace, `sky.${name} is not wired up on the client`).toBeDefined();
    expect(typeof namespace).toBe("object");
  });

  it("attaches all 21 namespaces", () => {
    expect(NAMESPACES).toHaveLength(21);
  });

  it("gives every namespace at least one callable method", () => {
    for (const name of NAMESPACES) {
      const namespace = (sky as unknown as Record<string, object>)[name] as object;
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(namespace)).filter(
        (key) => key !== "constructor",
      );
      expect(methods.length, `sky.${name} has no methods`).toBeGreaterThan(0);
    }
  });

  it("hands every namespace the same client instance", () => {
    for (const name of NAMESPACES) {
      const namespace = (sky as unknown as Record<string, { client?: SkyLink }>)[name];
      expect(namespace?.client, `sky.${name} holds a foreign client`).toBe(sky);
    }
  });
});

describe("shortcut methods", () => {
  const sky = newClient();

  it("exposes flightStatus as a method, not a namespace", () => {
    expect(typeof sky.flightStatus).toBe("function");
    expect(sky.flightStatus.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes distance as a method, not a namespace", () => {
    expect(typeof sky.distance).toBe("function");
    expect(sky.distance.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes the escape hatches", () => {
    expect(typeof sky.request).toBe("function");
    expect(typeof sky.requestWithResponse).toBe("function");
  });

  it("exposes the DX surface: quota hooks, cloning and the environment constructor", () => {
    expect(typeof SkyLink.fromEnv).toBe("function");
    expect(typeof sky.withOptions).toBe("function");
    expect(typeof sky.onRateLimit).toBe("function");
    expect(typeof sky.onQuotaLow).toBe("function");
  });
});

describe("cache surface", () => {
  it("exports the store, its TTL resolver and the operation namer", () => {
    expect(typeof SDK.MemoryCache).toBe("function");
    expect(typeof SDK.resolveTtl).toBe("function");
    expect(typeof SDK.deriveOperation).toBe("function");
    expect(SDK.DEFAULT_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(SDK.CACHE_HIT_HEADER).toBe("x-skylink-cache");
  });

  it("ships a cache that stores nothing until it is configured", () => {
    const cache = new SDK.MemoryCache();
    expect(cache.ttlFor("weather.metar")).toBe(0);
    cache.set("k", "v", cache.ttlFor("weather.metar"));
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("error hierarchy", () => {
  const classes = {
    SkyLinkError,
    APIConnectionError,
    APITimeoutError,
    APIStatusError,
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    UnprocessableEntityError,
    RateLimitError,
    InternalServerError,
    ServiceUnavailableError,
  };

  it("exports every error class", () => {
    for (const [name, ctor] of Object.entries(classes)) {
      expect(typeof ctor, `${name} is not exported`).toBe("function");
      expect((SDK as unknown as Record<string, unknown>)[name]).toBe(ctor);
    }
  });

  it("roots every error at SkyLinkError", () => {
    for (const [name, ctor] of Object.entries(classes)) {
      const instance = new (ctor as new (message: string) => Error)("boom");
      expect(instance, `${name} does not extend SkyLinkError`).toBeInstanceOf(SkyLinkError);
      expect(instance).toBeInstanceOf(Error);
      expect(instance.name).toBe(name);
    }
  });

  it("keeps the status subclasses under APIStatusError with their default codes", () => {
    const expected: [new (message: string) => APIStatusError, number][] = [
      [BadRequestError, 400],
      [AuthenticationError, 401],
      [PermissionDeniedError, 403],
      [NotFoundError, 404],
      [UnprocessableEntityError, 422],
      [RateLimitError, 429],
      [InternalServerError, 500],
      [ServiceUnavailableError, 503],
    ];
    for (const [ctor, status] of expected) {
      const instance = new ctor("boom");
      expect(instance).toBeInstanceOf(APIStatusError);
      expect(instance.status).toBe(status);
      expect(instance.statusCode).toBe(status);
    }
    expect(new APITimeoutError()).toBeInstanceOf(APIConnectionError);
  });
});
