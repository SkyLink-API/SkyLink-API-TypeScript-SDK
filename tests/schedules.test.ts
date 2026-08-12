import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type { ArrivalsResponse, DeparturesResponse } from "../src/models/schedules.js";
import { Schedules } from "../src/resources/schedules.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const departuresFixture = loadFixture<DeparturesResponse>("schedules_departures");

const arrivalsBody = {
  iata: "MXP",
  direction: "arrivals",
  airport_code: "LIMC",
  flights: [
    {
      Time: "16:20",
      Date: "11 Feb",
      IATA: "RAK",
      Origin: "Marrakech",
      Flight: "EC3929",
      Airline: "easyJet Europe",
      Status: "Landed 16:15",
    },
  ],
  total_flights: 72,
  pages_fetched: 3,
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
function schedules(options: ClientOptions = {}): Schedules {
  return new Schedules(client(options));
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("schedules.departures", () => {
  it("fetches a departure board by ICAO", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    const board: DeparturesResponse = await schedules().departures({ icao: "LIMC" });

    expect(board.iata).toBe("MXP");
    expect(board.direction).toBe("departures");
    expect(board.airport_code).toBe("LIMC");
    expect(board.total_flights).toBe(85);
    expect(board.pages_fetched).toBe(3);

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/schedules/departures");
    expect(request?.fullPath).toBe("/v3.1/schedules/departures?icao=LIMC");
    expect(request?.query.has("iata")).toBe(false);
    expect(request?.query.has("date")).toBe(false);
    expect(request?.query.has("time")).toBe(false);
    expect(request?.query.has("ts")).toBe(false);
  });

  it("fetches a departure board by IATA", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    await schedules().departures({ iata: "MXP" });

    expect(requests[0]?.fullPath).toBe("/v3.1/schedules/departures?iata=MXP");
    expect(requests[0]?.query.has("icao")).toBe(false);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    await schedules().departures({ icao: "LIMC" }, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: /^\/v3\.1\/schedules\/departures\?/,
      status: 404,
      body: { detail: "Departure schedule not available for LIMC" },
    });

    await expect(schedules().departures({ icao: "LIMC" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("schedules.arrivals", () => {
  it("fetches an arrival board", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/arrivals\?/, body: arrivalsBody });

    const board: ArrivalsResponse = await schedules().arrivals({ icao: "LIMC" });

    expect(board.direction).toBe("arrivals");
    expect(board.total_flights).toBe(72);
    expect(requests[0]?.path).toBe("/v3.1/schedules/arrivals");
    expect(requests[0]?.fullPath).toBe("/v3.1/schedules/arrivals?icao=LIMC");
  });
});

describe("schedules rows keep their PascalCase wire keys", () => {
  it("exposes Time/Date/IATA/Destination/Flight/Airline/Status on a departure row", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    const board = await schedules().departures({ icao: "LIMC" });
    const flight = board.flights[0];

    expect(flight?.Time).toBe("16:05");
    expect(flight?.Date).toBe("11 Feb");
    expect(flight?.IATA).toBe("ICN");
    expect(flight?.Destination).toBe("Seoul");
    expect(flight?.Flight).toBe("C84093");
    expect(flight?.Airline).toBe("Federal Airlines");
    expect(flight?.Status).toBe("Estimated 16:39");

    // Nothing was renamed to snake_case on the way through.
    expect(Object.keys(flight ?? {})).toEqual([
      "Time",
      "Date",
      "IATA",
      "Destination",
      "Flight",
      "Airline",
      "Status",
    ]);
  });

  it("uses Origin instead of Destination on an arrival row", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/arrivals\?/, body: arrivalsBody });

    const board = await schedules().arrivals({ icao: "LIMC" });
    const flight = board.flights[0];

    expect(flight?.Origin).toBe("Marrakech");
    expect(flight?.IATA).toBe("RAK");
    expect("Destination" in (flight ?? {})).toBe(false);
  });

  it("keeps departure and arrival rows as separate types at compile time", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });
    mockJson({ path: /^\/v3\.1\/schedules\/arrivals\?/, body: arrivalsBody });

    const departures = await schedules().departures({ icao: "LIMC" });
    const arrivals = await schedules().arrivals({ icao: "LIMC" });

    // @ts-expect-error `Origin` exists on arrival rows only.
    expect(departures.flights[0]?.Origin).toBeUndefined();
    // @ts-expect-error `Destination` exists on departure rows only.
    expect(arrivals.flights[0]?.Destination).toBeUndefined();
  });

  it("treats Status as free-form prose, not an enum", async () => {
    mockJson({
      path: /^\/v3\.1\/schedules\/departures\?/,
      body: {
        ...departuresFixture,
        flights: [
          { ...departuresFixture.flights[0], Status: "Departed 16:12" },
          { ...departuresFixture.flights[0], Status: "Cancelled" },
          { ...departuresFixture.flights[0], Status: "" },
        ],
      },
    });

    const board = await schedules().departures({ icao: "LIMC" });

    expect(board.flights.map((f) => f.Status)).toEqual(["Departed 16:12", "Cancelled", ""]);
  });

  it("leaves Time and Date as local display strings", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    const board = await schedules().departures({ icao: "LIMC" });

    expect(typeof board.flights[0]?.Time).toBe("string");
    expect(board.flights[0]?.Date).not.toBeInstanceOf(Date);
    expect(board.flights[0]?.Date).toBe("11 Feb");
  });
});

describe("schedules date handling", () => {
  it("formats a Date as DD-MM-YYYY in UTC", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    await schedules().departures({ icao: "LIMC", date: new Date("2026-02-11T09:00:00Z") });

    expect(requests[0]?.query.get("date")).toBe("11-02-2026");
    expect(requests[0]?.fullPath).toBe("/v3.1/schedules/departures?icao=LIMC&date=11-02-2026");
  });

  it("passes a DD-MM-YYYY string straight through", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    await schedules().departures({ icao: "LIMC", date: "11-02-2026" });

    expect(requests[0]?.query.get("date")).toBe("11-02-2026");
  });

  it("formats time as HH:MM and sends it alongside the date", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/arrivals\?/, body: arrivalsBody });

    await schedules().arrivals({
      iata: "MXP",
      date: "11-02-2026",
      time: new Date("2026-02-11T14:30:00Z"),
    });

    expect(requests[0]?.query.get("time")).toBe("14:30");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/schedules/arrivals?iata=MXP&date=11-02-2026&time=14%3A30",
    );
  });

  it("passes an HH:MM string straight through", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    await schedules().departures({ icao: "LIMC", date: "11-02-2026", time: "06:05" });

    expect(requests[0]?.query.get("time")).toBe("06:05");
  });

  it("sends ts as unix milliseconds, unchanged", async () => {
    mockJson({ path: /^\/v3\.1\/schedules\/departures\?/, body: departuresFixture });

    const ts = new Date("2026-02-11T14:30:00Z").getTime();
    await schedules().departures({ icao: "LIMC", ts });

    // Milliseconds, not seconds: a seconds-based epoch would be 10 digits here.
    expect(String(ts)).toHaveLength(13);
    expect(requests[0]?.query.get("ts")).toBe(String(ts));
    expect(requests[0]?.fullPath).toBe(`/v3.1/schedules/departures?icao=LIMC&ts=${ts}`);
  });

  it("rejects an unparseable date before spending a request", () => {
    expect(() => schedules().departures({ icao: "LIMC", date: "not-a-date" })).toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("schedules airport-code validation", () => {
  it("rejects supplying neither icao nor iata", () => {
    expect(() => schedules().departures({})).toThrow(SkyLinkError);
    expect(() => schedules().departures({})).toThrow(/either icao or iata/i);
    expect(() => schedules().arrivals({})).toThrow(SkyLinkError);
  });

  it("rejects supplying both icao and iata", () => {
    expect(() => schedules().departures({ icao: "LIMC", iata: "MXP" })).toThrow(SkyLinkError);
    expect(() => schedules().departures({ icao: "LIMC", iata: "MXP" })).toThrow(/not both/i);
    expect(() => schedules().arrivals({ icao: "LIMC", iata: "MXP" })).toThrow(/not both/i);
  });

  it("never reaches the network when validation fails", () => {
    expect(() => schedules().departures({})).toThrow(SkyLinkError);
    expect(requests).toHaveLength(0);
  });
});

describe("schedules wiring", () => {
  it("exposes both board methods", () => {
    const resource = schedules();
    expect(typeof resource.departures).toBe("function");
    expect(typeof resource.arrivals).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/schedules\/departures\?/,
      body: departuresFixture,
    });

    await schedules({ provider: "rapidapi", apiKey: "rapid-key" }).departures({ icao: "LIMC" });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/schedules/departures");
  });
});
