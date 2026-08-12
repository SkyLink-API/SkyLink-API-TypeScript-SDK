import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type { FlightStatusResponse } from "../src/models/flight-status.js";
import { FlightStatus } from "../src/resources/flight-status.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const statusFixture = loadFixture<FlightStatusResponse>("flight_status");

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options });
}

/** The namespace is attached to the client in a later task; instantiate it directly. */
function flightStatus(options: ClientOptions = {}): FlightStatus {
  return new FlightStatus(client(options));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("flightStatus.get", () => {
  it("fetches a flight by number and sends no query parameters", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const flight: FlightStatusResponse = await flightStatus().get("BA123");

    expect(flight.flight_number).toBe("BA 123");
    expect(flight.airline).toBe("British Airways");
    expect(flight.status).toBe("En Route");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/flight_status/BA123");
    expect([...(request?.query.keys() ?? [])]).toEqual([]);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("accepts an ICAO flight number just as well as an IATA one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BAW123`, body: statusFixture });

    await flightStatus().get("BAW123");

    expect(requests[0]?.fullPath).toBe("/v3.1/flight_status/BAW123");
  });

  it("percent-encodes the flight number and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA%2F123`, body: statusFixture });

    await flightStatus().get("BA/123");
    expect(requests[0]?.path).toBe("/v3.1/flight_status/BA%2F123");

    expect(() => flightStatus().get("   ")).toThrow(SkyLinkError);
    expect(() => flightStatus().get("")).toThrow(/flightNumber/);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/flight_status/ZZ9999`,
      status: 404,
      body: { detail: "Flight ZZ9999 not found" },
    });

    await expect(flightStatus().get("ZZ9999")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    await flightStatus().get("BA123", { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("flightStatus legs are asymmetric", () => {
  it("gives departure actual_*/checkin and arrival estimated_*/baggage", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const flight = await flightStatus().get("BA123");

    // Departure card: actual times plus a check-in desk.
    expect(flight.departure.actual_time).toBe("10:35");
    expect(flight.departure.actual_date).toBe("11 Feb");
    expect(flight.departure.checkin).toBe("");
    expect("estimated_time" in flight.departure).toBe(false);
    expect("baggage" in flight.departure).toBe(false);

    // Arrival card: estimated times plus a baggage belt.
    expect(flight.arrival.estimated_time).toBe("14:50");
    expect(flight.arrival.estimated_date).toBe("11 Feb");
    expect(flight.arrival.baggage).toBe("");
    expect("actual_time" in flight.arrival).toBe(false);
    expect("checkin" in flight.arrival).toBe(false);
  });

  it("keeps the two legs as separate types at compile time", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const flight = await flightStatus().get("BA123");

    // @ts-expect-error `estimated_time` belongs to the arrival leg only.
    expect(flight.departure.estimated_time).toBeUndefined();
    // @ts-expect-error `baggage` belongs to the arrival leg only.
    expect(flight.departure.baggage).toBeUndefined();
    // @ts-expect-error `actual_time` belongs to the departure leg only.
    expect(flight.arrival.actual_time).toBeUndefined();
    // @ts-expect-error `checkin` belongs to the departure leg only.
    expect(flight.arrival.checkin).toBeUndefined();
  });

  it("shares the fields both legs really do have", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const flight = await flightStatus().get("BA123");

    expect(flight.departure.airport).toBe("EGLL");
    expect(flight.departure.airport_full).toBe("London Heathrow Airport");
    expect(flight.departure.terminal).toBe("5");
    expect(flight.departure.gate).toBe("A12");

    expect(flight.arrival.airport).toBe("KJFK");
    expect(flight.arrival.airport_full).toBe("John F Kennedy International Airport");
    expect(flight.arrival.terminal).toBe("7");
    expect(flight.arrival.gate).toBe("B15");
  });
});

describe("flightStatus times stay opaque strings", () => {
  it("leaves local clock times and year-less dates untouched", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/flight_status/BA123`, body: statusFixture });

    const flight = await flightStatus().get("BA123");

    expect(typeof flight.departure.scheduled_time).toBe("string");
    expect(flight.departure.scheduled_time).toBe("10:30");
    expect(flight.departure.scheduled_date).toBe("11 Feb");
    expect(flight.arrival.scheduled_time).toBe("14:45");
    expect(flight.arrival.scheduled_date).toBe("11 Feb");

    // Nothing is coerced to a Date — these are display strings without a year or zone.
    expect(flight.departure.scheduled_time).not.toBeInstanceOf(Date);
    expect(flight.arrival.estimated_time).not.toBeInstanceOf(Date);
  });

  it("reports missing values as empty strings, not null", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: {
        ...statusFixture,
        departure: { ...statusFixture.departure, gate: "", checkin: "", actual_time: "" },
        arrival: { ...statusFixture.arrival, gate: "", baggage: "", estimated_time: "" },
      },
    });

    const flight = await flightStatus().get("BA123");

    expect(flight.departure.gate).toBe("");
    expect(flight.departure.gate).not.toBeNull();
    expect(flight.departure.actual_time).toBe("");
    expect(flight.arrival.baggage).toBe("");
    expect(flight.arrival.estimated_time).toBe("");
    expect(flight.arrival.gate).not.toBeNull();
  });

  it("keeps the '--' / '--:--' placeholders the source uses for blanks", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: {
        ...statusFixture,
        arrival: { ...statusFixture.arrival, estimated_time: "--:--", baggage: "--" },
      },
    });

    const flight = await flightStatus().get("BA123");

    expect(flight.arrival.estimated_time).toBe("--:--");
    expect(flight.arrival.baggage).toBe("--");
  });
});

describe("flightStatus tolerates empty legs", () => {
  it("survives departure and arrival arriving as {}", async () => {
    mockJson({
      path: `${DIRECT_PREFIX}/flight_status/BA123`,
      body: {
        flight_number: "BA 123",
        airline: "Unknown",
        status: "Unknown",
        departure: {},
        arrival: {},
      },
    });

    const flight = await flightStatus().get("BA123");

    expect(flight.departure).toEqual({});
    expect(flight.arrival).toEqual({});
    expect(flight.departure.airport).toBeUndefined();
    expect(flight.departure.checkin).toBeUndefined();
    expect(flight.arrival.baggage).toBeUndefined();
    expect(flight.status).toBe("Unknown");
  });
});

describe("flightStatus wiring", () => {
  it("takes the client in its constructor, like every other resource", () => {
    const resource = flightStatus();
    expect(typeof resource.get).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/flight_status/BA123",
      body: statusFixture,
    });

    await flightStatus({ provider: "rapidapi", apiKey: "rapid-key" }).get("BA123");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/flight_status/BA123");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
