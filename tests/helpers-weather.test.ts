/**
 * Derived weather values (`src/helpers/weather.ts`).
 *
 * Pure functions: no client, no network, no mocks. The shapes used here are the
 * real ones — `ParsedMetar`, `TafForecastPeriod` and the METAR envelope — so a
 * change to the models breaks this file rather than a user's app.
 */

import { describe, expect, it } from "vitest";
import {
  ceilingFt,
  DEFAULT_MAX_METAR_AGE_MS,
  flightCategory,
  isStale,
  metarAgeMs,
  windComponents,
} from "../src/helpers/weather.js";
import type { ParsedMetar, ParsedMetarResponse, TafForecastPeriod } from "../src/models/weather.js";

function metar(overrides: Partial<ParsedMetar> = {}): ParsedMetar {
  return {
    wind: { direction: 250, speed: 12, gust: null, variable: null },
    visibility: { value: 10, repr: "10SM" },
    clouds: [],
    temperature: 18,
    dewpoint: 9,
    altimeter: 29.92,
    flight_rules: null,
    wx_codes: [],
    remarks: null,
    time: "2026-08-12T10:00:00Z",
    density_altitude: null,
    pressure_altitude: null,
    relative_humidity: 0.55,
    ...overrides,
  };
}

/** A TAF period carries no temperature or altimeter at all — nothing may assume them. */
function tafPeriod(overrides: Partial<TafForecastPeriod> = {}): TafForecastPeriod {
  return {
    type: "FROM",
    start_time: "2026-08-12T12:00:00Z",
    end_time: "2026-08-12T18:00:00Z",
    wind: { direction: 270, speed: 15, gust: 25, variable: null },
    visibility: { value: 6, repr: "6SM" },
    clouds: [{ type: "BKN", base: 20, repr: "BKN020" }],
    wx_codes: [],
    flight_rules: null,
    probability: null,
    turbulence: [],
    icing: [],
    ...overrides,
  };
}

describe("ceilingFt", () => {
  it("converts the base from hundreds of feet", () => {
    // The trap: `base: 24` means 2 400 ft, not 24 ft.
    expect(ceilingFt(metar({ clouds: [{ type: "BKN", base: 24, repr: "BKN024" }] }))).toBe(2400);
  });

  it("ignores layers that are not a ceiling", () => {
    expect(
      ceilingFt(
        metar({
          clouds: [
            { type: "FEW", base: 5, repr: "FEW005" },
            { type: "SCT", base: 10, repr: "SCT010" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("takes the lowest broken/overcast/VV layer regardless of order", () => {
    expect(
      ceilingFt(
        metar({
          clouds: [
            { type: "OVC", base: 80, repr: "OVC080" },
            { type: "FEW", base: 2, repr: "FEW002" },
            { type: "BKN", base: 15, repr: "BKN015" },
          ],
        }),
      ),
    ).toBe(1500);
    expect(ceilingFt(metar({ clouds: [{ type: "VV", base: 2, repr: "VV002" }] }))).toBe(200);
  });

  it("falls back to the repr when type is missing", () => {
    expect(ceilingFt(metar({ clouds: [{ type: null, base: 7, repr: "OVC007" }] }))).toBe(700);
  });

  it("reads through the METAR envelope", () => {
    const response: ParsedMetarResponse = {
      raw: "KJFK 121051Z 25012KT 10SM OVC007 18/09 A2992",
      icao: "KJFK",
      airport_name: "John F Kennedy Intl",
      timestamp: "2026-08-12T10:51:00Z",
      parsed: metar({ clouds: [{ type: "OVC", base: 7, repr: "OVC007" }] }),
    };
    expect(ceilingFt(response)).toBe(700);
  });

  it("survives missing data", () => {
    expect(ceilingFt(null)).toBeNull();
    expect(ceilingFt(undefined)).toBeNull();
    expect(ceilingFt({})).toBeNull();
    expect(ceilingFt(metar({ clouds: [] }))).toBeNull();
    expect(ceilingFt(metar({ clouds: [{ type: "BKN", base: null, repr: "BKN///" }] }))).toBeNull();
  });
});

describe("flightCategory", () => {
  it("returns VFR on a clear day", () => {
    expect(flightCategory(metar())).toBe("VFR");
  });

  it("classifies by ceiling", () => {
    expect(flightCategory(metar({ clouds: [{ type: "OVC", base: 4, repr: "OVC004" }] }))).toBe(
      "LIFR",
    );
    expect(flightCategory(metar({ clouds: [{ type: "OVC", base: 8, repr: "OVC008" }] }))).toBe(
      "IFR",
    );
    expect(flightCategory(metar({ clouds: [{ type: "BKN", base: 25, repr: "BKN025" }] }))).toBe(
      "MVFR",
    );
    expect(flightCategory(metar({ clouds: [{ type: "BKN", base: 50, repr: "BKN050" }] }))).toBe(
      "VFR",
    );
  });

  it("classifies by visibility", () => {
    expect(flightCategory(metar({ visibility: { value: 0.5, repr: "1/2SM" } }))).toBe("LIFR");
    expect(flightCategory(metar({ visibility: { value: 2, repr: "2SM" } }))).toBe("IFR");
    expect(flightCategory(metar({ visibility: { value: 4, repr: "4SM" } }))).toBe("MVFR");
    expect(flightCategory(metar({ visibility: { value: 10, repr: "10SM" } }))).toBe("VFR");
  });

  it("takes the worse of the two", () => {
    expect(
      flightCategory(
        metar({
          visibility: { value: 10, repr: "10SM" },
          clouds: [{ type: "OVC", base: 3, repr: "OVC003" }],
        }),
      ),
    ).toBe("LIFR");
  });

  it("treats P6SM as six miles, not as a missing observation", () => {
    // The trap: `value` is null and only `repr` carries the reading.
    expect(flightCategory(metar({ visibility: { value: null, repr: "P6" } }))).toBe("VFR");
  });

  it("works on a TAF period, which has no temperature or altimeter", () => {
    expect(flightCategory(tafPeriod())).toBe("MVFR");
    expect(flightCategory(tafPeriod({ clouds: [{ type: "OVC", base: 3, repr: "OVC003" }] }))).toBe(
      "LIFR",
    );
  });

  it("reads through the METAR envelope", () => {
    const response: ParsedMetarResponse = {
      raw: "KJFK 121051Z 25012KT 1/2SM OVC003 18/09 A2992",
      icao: "KJFK",
      airport_name: null,
      timestamp: "2026-08-12T10:51:00Z",
      parsed: metar({
        visibility: { value: 0.5, repr: "1/2SM" },
        clouds: [{ type: "OVC", base: 3, repr: "OVC003" }],
      }),
    };
    expect(flightCategory(response)).toBe("LIFR");
  });

  it("returns null when neither visibility nor ceiling is known", () => {
    expect(flightCategory(null)).toBeNull();
    expect(flightCategory({})).toBeNull();
    expect(flightCategory(metar({ visibility: null, clouds: [] }))).toBeNull();
    expect(
      flightCategory(
        metar({ visibility: null, clouds: [{ type: "FEW", base: 5, repr: "FEW005" }] }),
      ),
    ).toBeNull();
  });
});

describe("metarAgeMs", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  it("measures from the decoded observation time", () => {
    expect(metarAgeMs(metar(), { now })).toBe(2 * 60 * 60 * 1000);
  });

  it("prefers an explicit observed_time", () => {
    expect(metarAgeMs({ observed_time: "2026-08-12T11:30:00Z" }, { now })).toBe(30 * 60 * 1000);
  });

  it("falls back to the envelope timestamp", () => {
    expect(metarAgeMs({ timestamp: "2026-08-12T11:00:00Z", parsed: { time: null } }, { now })).toBe(
      60 * 60 * 1000,
    );
  });

  it("treats a naive timestamp as UTC, not as local time", () => {
    // ADS-B and several weather envelopes serialize without a Z suffix.
    expect(metarAgeMs({ observed_time: "2026-08-12T11:00:00" }, { now })).toBe(60 * 60 * 1000);
  });

  it("returns null when there is no usable time", () => {
    expect(metarAgeMs(null, { now })).toBeNull();
    expect(metarAgeMs({}, { now })).toBeNull();
    expect(metarAgeMs({ observed_time: "not a date" }, { now })).toBeNull();
  });
});

describe("isStale", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  it("defaults to a 90 minute window", () => {
    expect(DEFAULT_MAX_METAR_AGE_MS).toBe(90 * 60 * 1000);
    expect(isStale({ observed_time: "2026-08-12T11:00:00Z" }, { now })).toBe(false);
    expect(isStale({ observed_time: "2026-08-12T10:00:00Z" }, { now })).toBe(true);
  });

  it("honours an explicit window", () => {
    expect(
      isStale({ observed_time: "2026-08-12T11:00:00Z" }, { now, maxAgeMs: 30 * 60 * 1000 }),
    ).toBe(true);
  });

  it("counts a report with no timestamp as stale", () => {
    expect(isStale({}, { now })).toBe(true);
    expect(isStale(null, { now })).toBe(true);
  });
});

describe("windComponents", () => {
  it("resolves a direct headwind", () => {
    const wind = windComponents(90, 90, 20);
    expect(wind?.headwindKt).toBeCloseTo(20, 9);
    expect(wind?.crosswindKt).toBeCloseTo(0, 9);
  });

  it("reports a tailwind as a negative headwind", () => {
    const wind = windComponents(90, 270, 20);
    expect(wind?.headwindKt).toBeCloseTo(-20, 9);
    expect(wind?.crosswindKt).toBeCloseTo(0, 9);
  });

  it("resolves a pure crosswind and names the side", () => {
    const fromRight = windComponents(360, 90, 15);
    expect(fromRight?.crosswindKt).toBeCloseTo(15, 9);
    expect(fromRight?.headwindKt).toBeCloseTo(0, 9);
    expect(fromRight?.fromRight).toBe(true);

    const fromLeft = windComponents(360, 270, 15);
    expect(fromLeft?.crosswindKt).toBeCloseTo(15, 9);
    expect(fromLeft?.fromRight).toBe(false);
  });

  it("splits a 45 degree wind evenly", () => {
    const wind = windComponents(40, 85, 20);
    expect(wind?.headwindKt).toBeCloseTo(20 * Math.SQRT1_2, 6);
    expect(wind?.crosswindKt).toBeCloseTo(20 * Math.SQRT1_2, 6);
    expect(wind?.fromRight).toBe(true);
  });

  it("accepts the string headings the CSV pass-through columns send", () => {
    // The trap: EnrichedAirport.runways[].le_heading_degT is `string | number | null`.
    expect(windComponents("40", "85", "20")?.crosswindKt).toBeCloseTo(20 * Math.SQRT1_2, 6);
  });

  it("returns null when an input is missing, including a variable wind direction", () => {
    expect(windComponents(null, 90, 20)).toBeNull();
    expect(windComponents(90, null, 20)).toBeNull();
    expect(windComponents(90, 90, null)).toBeNull();
    expect(windComponents(90, "VRB", 20)).toBeNull();
  });
});
