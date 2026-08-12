/**
 * HTTP-200 sentinel helpers (`src/helpers/sentinels.ts`).
 *
 * Pure functions: no client, no network, no mocks. What matters here is that a
 * "not found" delivered inside a 200 response can be converted into an exception
 * without losing the explanation the API attached to it.
 */

import { describe, expect, it } from "vitest";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import {
  hasResults,
  isFound,
  requireFound,
  requireIpResult,
  requireResults,
} from "../src/helpers/sentinels.js";
import type { AircraftLookupResponse } from "../src/models/aircraft.js";
import type { AirportsByIpResponse } from "../src/models/airports.js";
import type { HistoryFlightsResponse } from "../src/models/history.js";

const found: AircraftLookupResponse = {
  query: "G-STBA",
  found: true,
  aircraft: {
    registration: "G-STBA",
    icao24: "4CA1FB",
    icao_type: "B77W",
    type_name: "777-336(ER)",
    manufacturer: "Boeing",
    manufacturer_and_model: "Boeing 777-336(ER)",
    owner_operator: "British Airways",
    airline_code: "BAW",
    is_private_operator: false,
    serial_number: "38593",
    year_built: "2010",
    photos: [],
  },
};

const notFound: AircraftLookupResponse = {
  query: "G-ZZZZ",
  found: false,
  aircraft: null,
};

describe("isFound", () => {
  it("narrows the union so aircraft is no longer nullable", () => {
    expect(isFound(found)).toBe(true);
    expect(isFound(notFound)).toBe(false);
    if (isFound(found)) {
      // Compiles only because the guard narrowed `aircraft` to non-null.
      expect(found.aircraft.manufacturer).toBe("Boeing");
    }
  });
});

describe("requireFound", () => {
  it("returns the hit unchanged", () => {
    expect(requireFound(found)).toBe(found);
  });

  it("throws NotFoundError on the found: false sentinel", () => {
    // The trap: this endpoint answers 200, so a try/catch around the call catches
    // nothing and the null surfaces later.
    expect(() => requireFound(notFound)).toThrow(NotFoundError);
    expect(() => requireFound(notFound)).toThrow(/G-ZZZZ/);
    expect(() => requireFound(notFound)).toThrow(/found: false/);
  });

  it("throws an error rooted at SkyLinkError", () => {
    try {
      requireFound(notFound);
      expect.unreachable("requireFound did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkyLinkError);
      expect((error as NotFoundError).status).toBe(404);
    }
  });
});

const emptyHistory: HistoryFlightsResponse = {
  filters: {
    icao24: null,
    registration: "G-ZZZZ",
    resolved_icao24: null,
    callsign: null,
    departure_icao: null,
    arrival_icao: null,
  },
  count: 0,
  flights: [],
  note: "Registration G-ZZZZ not found in aircraft database",
};

const filledHistory: HistoryFlightsResponse = {
  filters: {
    icao24: "4ca1fb",
    registration: null,
    resolved_icao24: null,
    callsign: null,
    departure_icao: null,
    arrival_icao: null,
  },
  count: 1,
  flights: [{ flight_id: "0d2f1f3a-1111-2222-3333-444455556666", icao24: "4CA1FB" }],
};

describe("hasResults", () => {
  it("is true only when rows came back", () => {
    expect(hasResults(filledHistory)).toBe(true);
    expect(hasResults(emptyHistory)).toBe(false);
    expect(hasResults({ count: 0, positions: [] })).toBe(false);
    expect(hasResults({ count: 2, positions: [{}, {}] })).toBe(true);
  });

  it("does not treat the explanatory note as a result", () => {
    expect(hasResults({ count: 0, flights: [], note: "nothing here" })).toBe(false);
    expect(hasResults(null)).toBe(false);
    expect(hasResults(undefined)).toBe(false);
  });
});

describe("requireResults", () => {
  it("returns the response unchanged when it carried rows", () => {
    expect(requireResults(filledHistory)).toBe(filledHistory);
  });

  it("throws NotFoundError quoting the note", () => {
    expect(() => requireResults(emptyHistory)).toThrow(NotFoundError);
    expect(() => requireResults(emptyHistory)).toThrow(/not found in aircraft database/);
  });

  it("throws a generic message when there is no note", () => {
    expect(() => requireResults({ count: 0, flights: [] })).toThrow(/matched no records/);
  });
});

const ipFailure: AirportsByIpResponse = {
  ip_address: "127.0.0.1",
  location: null,
  airports: [],
  search_radius_km: 100,
  airports_found: 0,
  error: "Unable to geolocate IP address",
};

const ipSuccess: AirportsByIpResponse = {
  ip_address: "8.8.8.8",
  location: {
    latitude: 37.751,
    longitude: -97.822,
    city: "Wichita",
    region: "Kansas",
    country: "United States",
    country_code: "US",
    postal: "67202",
    timezone: "America/Chicago",
    ip: "8.8.8.8",
  },
  airports: [],
  search_radius_km: 100,
  airports_found: 0,
  error: null,
};

describe("requireIpResult", () => {
  it("returns a successful lookup unchanged", () => {
    expect(requireIpResult(ipSuccess)).toBe(ipSuccess);
    expect(requireIpResult({ error: null })).toEqual({ error: null });
    expect(requireIpResult({})).toEqual({});
  });

  it("throws SkyLinkError quoting the in-band error", () => {
    // The trap: geolocation failure arrives as HTTP 200 with error set.
    expect(() => requireIpResult(ipFailure)).toThrow(SkyLinkError);
    expect(() => requireIpResult(ipFailure)).toThrow(/Unable to geolocate IP address/);
  });
});
