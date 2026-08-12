import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { SkyLinkError, UnprocessableEntityError } from "../src/core/errors.js";
import type { TicketSearchResponse } from "../src/models/tickets.js";
import { Tickets } from "../src/resources/tickets.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const ticketsFixture = loadFixture<TicketSearchResponse>("tickets_search");

function tickets(options: ClientOptions = {}): Tickets {
  return new Tickets(
    new SkyLink({
      apiKey: "test-key",
      provider: "direct",
      sleep: async () => undefined,
      ...options,
    }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("tickets.search", () => {
  it("searches a route and decodes the offer envelope", async () => {
    mockJson({ path: /^\/v3\.1\/tickets\/search\?/, body: ticketsFixture });

    const results: TicketSearchResponse = await tickets().search({
      origin: "LHR",
      destination: "JFK",
    });

    expect(results.origin).toBe("LHR");
    expect(results.destination).toBe("JFK");
    expect(results.date).toBe("2026-05-01");
    expect(results.passengers).toBe(1);
    // `count` is the upstream offer count; the fixture keeps two of the three.
    expect(results.count).toBe(ticketsFixture.count);
    expect(results.flights).toHaveLength(2);

    const cheapest = results.flights[0];
    expect(cheapest?.price_usd).toBeCloseTo(542.0);
    expect(cheapest?.original_price).toBeCloseTo(498.0);
    expect(cheapest?.original_currency).toBe("EUR");
    expect(cheapest?.total_duration_min).toBe(465);
    expect(cheapest?.stops).toBe(0);

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/tickets/search");
    expect(request?.fullPath).toBe("/v3.1/tickets/search?origin=LHR&destination=JFK");
    expect(request?.query.has("date")).toBe(false);
    expect(request?.query.has("passengers")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("reports layovers as null — not [] — for a direct flight", async () => {
    mockJson({ path: /^\/v3\.1\/tickets\/search\?/, body: ticketsFixture });

    const results = await tickets().search({ origin: "LHR", destination: "JFK" });

    const direct = results.flights[0];
    expect(direct?.stops).toBe(0);
    expect(direct?.layovers).toBeNull();
    expect(direct?.layovers).not.toEqual([]);
    expect(direct?.layovers?.length).toBeUndefined();

    const connecting = results.flights[1];
    expect(connecting?.stops).toBe(1);
    expect(connecting?.layovers).toHaveLength(1);
    expect(connecting?.layovers?.[0]?.airport).toBe("MAD");
    expect(connecting?.layovers?.[0]?.duration_min).toBe(155);
  });

  it("keeps the naive, timezone-less datetimes as strings", async () => {
    mockJson({ path: /^\/v3\.1\/tickets\/search\?/, body: ticketsFixture });

    const results = await tickets().search({ origin: "LHR", destination: "JFK" });
    const leg = results.flights[0]?.legs[0];

    expect(leg?.flight_number).toBe("BA117");
    expect(leg?.airline_code).toBe("BA");
    expect(leg?.departure_airport).toBe("LHR");
    expect(leg?.arrival_airport_name).toBe("John F Kennedy International Airport");
    expect(leg?.duration_min).toBe(465);

    // Handed back verbatim: no `Z`, no offset, never coerced to a Date.
    expect(leg?.departure_datetime).toBe("2026-05-01T09:00:00");
    expect(leg?.arrival_datetime).toBe("2026-05-01T11:45:00");
    expect(typeof leg?.departure_datetime).toBe("string");
    expect(leg?.departure_datetime).not.toMatch(/Z|[+-]\d{2}:\d{2}$/);
    expect(leg?.departure_time).toBe("09:00");
    expect(leg?.arrival_time).toBe("11:45");
  });

  it("formats a Date as YYYY-MM-DD in UTC and passes a formatted string through", async () => {
    mockJson({ path: /^\/v3\.1\/tickets\/search\?/, body: ticketsFixture, times: 3 });

    await tickets().search({
      origin: "LHR",
      destination: "JFK",
      date: new Date(Date.UTC(2026, 4, 1)),
      passengers: 2,
    });
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/tickets/search?origin=LHR&destination=JFK&date=2026-05-01&passengers=2",
    );

    // A late-evening UTC instant must not roll over into the next day.
    await tickets().search({
      origin: "LHR",
      destination: "JFK",
      date: new Date("2026-05-01T23:30:00Z"),
    });
    expect(requests[1]?.query.get("date")).toBe("2026-05-01");

    await tickets().search({ origin: "LHR", destination: "JFK", date: "2026-05-01" });
    expect(requests[2]?.query.get("date")).toBe("2026-05-01");
  });

  it("rejects an unparseable date before touching the network", () => {
    expect(() =>
      tickets().search({ origin: "LHR", destination: "JFK", date: "next tuesday" }),
    ).toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("maps a 422 to UnprocessableEntityError", async () => {
    mockError({
      path: /^\/v3\.1\/tickets\/search\?/,
      status: 422,
      body: { detail: "Origin and destination must be different" },
    });

    const failure = tickets().search({ origin: "LHR", destination: "LHR" });
    await expect(failure).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(failure).rejects.toBeInstanceOf(SkyLinkError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/tickets\/search\?/, body: ticketsFixture });

    await tickets().search(
      { origin: "LHR", destination: "JFK" },
      { headers: { "X-Trace": "abc" } },
    );

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/tickets\/search\?/,
      body: ticketsFixture,
    });

    await tickets({ provider: "rapidapi", apiKey: "rapid-key" }).search({
      origin: "LHR",
      destination: "JFK",
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/tickets/search");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
