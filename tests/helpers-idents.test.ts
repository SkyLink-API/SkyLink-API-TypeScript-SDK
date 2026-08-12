/**
 * Identifier classification and normalization (`src/helpers/idents.ts`).
 *
 * Pure functions: no client, no network, no mocks.
 */

import { describe, expect, it } from "vitest";
import {
  classifyAirportCode,
  isIcao24,
  isLocalPseudocode,
  normalizeIcao24,
  normalizeRegistration,
  splitFlightNumber,
} from "../src/helpers/idents.js";

describe("classifyAirportCode", () => {
  it("calls three letters IATA", () => {
    expect(classifyAirportCode("JFK")).toBe("iata");
    expect(classifyAirportCode("lhr")).toBe("iata");
    expect(classifyAirportCode("  SVO  ")).toBe("iata");
  });

  it("calls four alphanumerics starting with a letter ICAO", () => {
    expect(classifyAirportCode("KJFK")).toBe("icao");
    expect(classifyAirportCode("egll")).toBe("icao");
    expect(classifyAirportCode("K7B2")).toBe("icao");
  });

  it("calls a hyphenated code a local pseudo-code", () => {
    expect(classifyAirportCode("GB-0888")).toBe("local");
    expect(classifyAirportCode("US-1234")).toBe("local");
  });

  it("gives up on anything else", () => {
    expect(classifyAirportCode("")).toBe("unknown");
    expect(classifyAirportCode(null)).toBe("unknown");
    expect(classifyAirportCode(undefined)).toBe("unknown");
    expect(classifyAirportCode("HEATHROW")).toBe("unknown");
    expect(classifyAirportCode("12")).toBe("unknown");
  });
});

describe("isLocalPseudocode", () => {
  it("recognizes the OurAirports pseudo-codes airports.nearby() returns", () => {
    // The trap: airports.search() cannot resolve these, so they must be filtered
    // out before any join back to the enriched lookup.
    expect(isLocalPseudocode("GB-0888")).toBe(true);
    expect(isLocalPseudocode("us-1234")).toBe(true);
  });

  it("rejects real codes", () => {
    expect(isLocalPseudocode("KJFK")).toBe(false);
    expect(isLocalPseudocode("JFK")).toBe(false);
    expect(isLocalPseudocode(null)).toBe(false);
    expect(isLocalPseudocode("")).toBe(false);
  });
});

describe("isIcao24", () => {
  it("accepts exactly six hex digits in either case", () => {
    expect(isIcao24("4ca1d3")).toBe(true);
    expect(isIcao24("4CA1D3")).toBe(true);
    expect(isIcao24(" 4ca1d3 ")).toBe(true);
  });

  it("rejects everything else, including the ~ form", () => {
    expect(isIcao24("4ca1d")).toBe(false);
    expect(isIcao24("4ca1d33")).toBe(false);
    expect(isIcao24("G-STBA")).toBe(false);
    expect(isIcao24("zzzzzz")).toBe(false);
    expect(isIcao24("~4ca1d3")).toBe(false);
    expect(isIcao24(null)).toBe(false);
  });
});

describe("normalizeIcao24", () => {
  it("lower-cases, since responses disagree on case", () => {
    // History flight rows send 4CA1D3, position rows send 4ca1d3.
    expect(normalizeIcao24("4CA1D3")).toBe("4ca1d3");
    expect(normalizeIcao24("  4ca1d3  ")).toBe("4ca1d3");
  });

  it("strips the leading ~ of a non-ICAO address", () => {
    expect(normalizeIcao24("~4ca1d3")).toBe("4ca1d3");
  });

  it("returns null when the value is not an address", () => {
    expect(normalizeIcao24("G-STBA")).toBeNull();
    expect(normalizeIcao24("")).toBeNull();
    expect(normalizeIcao24(null)).toBeNull();
    expect(normalizeIcao24(undefined)).toBeNull();
  });
});

describe("normalizeRegistration", () => {
  it("upper-cases and trims", () => {
    expect(normalizeRegistration("g-stba")).toBe("G-STBA");
    expect(normalizeRegistration("  n12345 ")).toBe("N12345");
  });

  it("returns null for an empty value", () => {
    expect(normalizeRegistration("")).toBeNull();
    expect(normalizeRegistration("   ")).toBeNull();
    expect(normalizeRegistration(null)).toBeNull();
  });
});

describe("splitFlightNumber", () => {
  it("splits an IATA flight number", () => {
    expect(splitFlightNumber("BA1403")).toEqual({
      airline: "BA",
      number: "1403",
      kind: "iata",
    });
  });

  it("splits an ICAO callsign", () => {
    expect(splitFlightNumber("BAW175")).toEqual({
      airline: "BAW",
      number: "175",
      kind: "icao",
    });
  });

  it("keeps a digit inside a two-character carrier code", () => {
    // The trap: easyJet is "U2", so U21234 is U2 + 1234, not U21 + 234.
    expect(splitFlightNumber("U21234")).toEqual({
      airline: "U2",
      number: "1234",
      kind: "iata",
    });
    expect(splitFlightNumber("9W123")).toEqual({
      airline: "9W",
      number: "123",
      kind: "iata",
    });
  });

  it("ignores case, spaces and hyphens", () => {
    expect(splitFlightNumber("ba 1403")?.airline).toBe("BA");
    expect(splitFlightNumber("BA-1403")?.number).toBe("1403");
  });

  it("keeps leading zeros and a trailing suffix letter", () => {
    expect(splitFlightNumber("DL0123")?.number).toBe("0123");
    expect(splitFlightNumber("BAW175A")).toEqual({
      airline: "BAW",
      number: "175A",
      kind: "icao",
    });
  });

  it("returns null for anything that is not a designator", () => {
    expect(splitFlightNumber("")).toBeNull();
    expect(splitFlightNumber(null)).toBeNull();
    expect(splitFlightNumber("BA")).toBeNull();
    expect(splitFlightNumber("1403")).toBeNull();
    expect(splitFlightNumber("G-STBA")).toBeNull();
  });
});
