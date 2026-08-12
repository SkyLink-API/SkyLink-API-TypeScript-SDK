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

/** Every namespace promised by the README and the marketing site. */
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

  it("constructs from an explicit api key", () => {
    const sky = newClient();
    expect(sky).toBeInstanceOf(SkyLink);
    expect(sky.config.apiKey).toBe("test");
    expect(sky.baseUrl).toBe("https://data.skylinkapi.com/v3.1");
    expect(sky.lastRateLimit).toBeNull();
  });
});

describe("namespace wiring", () => {
  const sky = newClient();

  it.each(NAMESPACES)("exposes sky.%s as an object", (name) => {
    const namespace = (sky as unknown as Record<string, unknown>)[name];
    expect(namespace, `sky.${name} is not wired up on the client`).toBeDefined();
    expect(typeof namespace).toBe("object");
  });

  it("attaches all 18 namespaces", () => {
    expect(NAMESPACES).toHaveLength(18);
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
