import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import type { FlightTimePrediction } from "../src/models/ml.js";
import { Ml } from "../src/resources/ml.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const predictionBody = {
  origin: "KJFK",
  destination: "EGLL",
  aircraft_type: "B772",
  distance_nm: 3006.4,
  estimated_minutes: 443,
  estimated_hours_display: "7h 23m",
  min_minutes: 421,
  max_minutes: 465,
  model_version: "flight-time-v1.3.0",
};

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    sleep: async () => undefined,
    ...options,
  });
}

/** The namespace is attached to the client in a later task; instantiate it directly. */
function ml(options: ClientOptions = {}): Ml {
  return new Ml(client(options));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("ml.flightTime", () => {
  it("takes origin/destination and maps them onto the from/to wire keys", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    const prediction: FlightTimePrediction = await ml().flightTime({
      origin: "KJFK",
      destination: "EGLL",
    });

    expect(prediction.origin).toBe("KJFK");
    expect(prediction.destination).toBe("EGLL");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/ml/flight-time");
    expect(request?.fullPath).toBe("/v3.1/ml/flight-time?from=KJFK&to=EGLL");
    expect(request?.query.get("from")).toBe("KJFK");
    expect(request?.query.get("to")).toBe("EGLL");
    expect(request?.query.has("origin")).toBe(false);
    expect(request?.query.has("destination")).toBe(false);
    expect(request?.query.has("aircraft")).toBe(false);
  });

  it("still accepts the deprecated from/to spelling", async () => {
    // The rename is additive on purpose: code written against 0.1 keeps working,
    // and both spellings reach the endpoint as its own from/to keys.
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    await ml().flightTime({ from: "KJFK", to: "EGLL" });

    expect(requests[0]?.fullPath).toBe("/v3.1/ml/flight-time?from=KJFK&to=EGLL");
  });

  it("prefers origin/destination when a caller passes both spellings", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    await ml().flightTime({
      origin: "KJFK",
      destination: "EGLL",
      from: "WRONG",
      to: "WRONG",
    } as never);

    expect(requests[0]?.query.get("from")).toBe("KJFK");
    expect(requests[0]?.query.get("to")).toBe("EGLL");
  });

  it("sends the aircraft type when supplied", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    await ml().flightTime({ from: "JFK", to: "LHR", aircraft: "B772" });

    expect(requests[0]?.fullPath).toBe("/v3.1/ml/flight-time?from=JFK&to=LHR&aircraft=B772");
  });

  it("returns every prediction field", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    const prediction = await ml().flightTime({ from: "KJFK", to: "EGLL", aircraft: "B772" });

    expect(prediction.aircraft_type).toBe("B772");
    expect(prediction.distance_nm).toBeCloseTo(3006.4);
    expect(prediction.estimated_minutes).toBe(443);
    expect(prediction.min_minutes).toBe(421);
    expect(prediction.max_minutes).toBe(465);
    expect(prediction.model_version).toBe("flight-time-v1.3.0");
  });

  it("reports estimated_hours_display as a formatted string", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    const prediction = await ml().flightTime({ from: "KJFK", to: "EGLL" });

    expect(typeof prediction.estimated_hours_display).toBe("string");
    expect(prediction.estimated_hours_display).toBe("7h 23m");
    expect(prediction.estimated_hours_display).toMatch(/^\d+h \d+m$/);
  });

  it("returns aircraft_type: null when no type was supplied", async () => {
    mockJson({
      path: /^\/v3\.1\/ml\/flight-time\?/,
      body: { ...predictionBody, aircraft_type: null },
    });

    const prediction = await ml().flightTime({ from: "KJFK", to: "EGLL" });

    expect(prediction.aircraft_type).toBeNull();
    // Everything else stays populated — only aircraft_type is optional.
    expect(prediction.estimated_minutes).toBe(443);
    expect(prediction.model_version).toBe("flight-time-v1.3.0");
  });

  it("keeps the same shape when the formula fallback answers", async () => {
    mockJson({
      path: /^\/v3\.1\/ml\/flight-time\?/,
      body: { ...predictionBody, aircraft_type: null, model_version: "fallback-haversine" },
    });

    const prediction = await ml().flightTime({ from: "KJFK", to: "EGLL" });

    expect(prediction.model_version).toBe("fallback-haversine");
    expect(prediction.estimated_hours_display).toBe("7h 23m");
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/ml\/flight-time\?/,
      status: 404,
      body: { detail: "Unknown airport code: ZZZZ" },
    });

    await expect(ml().flightTime({ from: "ZZZZ", to: "EGLL" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/ml\/flight-time\?/, body: predictionBody });

    await ml().flightTime({ from: "KJFK", to: "EGLL" }, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("ml wiring", () => {
  it("exposes flightTime", () => {
    expect(typeof ml().flightTime).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/ml\/flight-time\?/,
      body: predictionBody,
    });

    await ml({ provider: "rapidapi", apiKey: "rapid-key" }).flightTime({
      from: "KJFK",
      to: "EGLL",
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/ml/flight-time");
  });
});
