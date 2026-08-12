/**
 * Unit converters and tolerant parsers (`src/helpers/units.ts`).
 *
 * Pure functions: no client, no network, no mocks. The cases that matter are the
 * ones the live API forced on us — numbers arriving as strings, an altimeter with
 * no unit attached, humidity as a fraction, and `P6SM` arriving as
 * `{ value: null, repr: "P6" }`.
 */

import { describe, expect, it } from "vitest";
import {
  cToF,
  FEET_PER_METER,
  fpmToMs,
  fToC,
  ftToM,
  hpaToInhg,
  humidityToPercent,
  inhgToHpa,
  kmToNm,
  ktToKmh,
  ktToMph,
  ktToMs,
  METERS_PER_FOOT,
  mToFt,
  nmToKm,
  normalizeAltimeter,
  parseDurationMinutes,
  parseVisibility,
  smToKm,
  toNumber,
} from "../src/helpers/units.js";

describe("toNumber", () => {
  it("passes finite numbers through", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-1.5)).toBe(-1.5);
  });

  it("parses the numeric strings the CSV pass-through columns send", () => {
    // `lighted` is `1` on the live API and `"1"` in the published examples.
    expect(toNumber("1")).toBe(1);
    expect(toNumber(" 125.7 ")).toBe(125.7);
    expect(toNumber("-3")).toBe(-3);
  });

  it("answers null instead of throwing on anything else", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("   ")).toBeNull();
    expect(toNumber("n/a")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("length and distance converters", () => {
  it("converts feet and metres", () => {
    expect(ftToM(1000)).toBeCloseTo(304.8, 6);
    expect(mToFt(304.8)).toBeCloseTo(1000, 6);
    expect(METERS_PER_FOOT).toBe(0.3048);
    expect(FEET_PER_METER).toBeCloseTo(3.280839895, 6);
  });

  it("converts nautical miles, kilometres and statute miles", () => {
    expect(nmToKm(100)).toBeCloseTo(185.2, 6);
    expect(kmToNm(185.2)).toBeCloseTo(100, 6);
    expect(smToKm(10)).toBeCloseTo(16.09344, 6);
  });

  it("round-trips", () => {
    expect(mToFt(ftToM(35000))).toBeCloseTo(35000, 6);
    expect(kmToNm(nmToKm(3451))).toBeCloseTo(3451, 6);
  });
});

describe("speed converters", () => {
  it("converts knots", () => {
    expect(ktToKmh(100)).toBeCloseTo(185.2, 6);
    expect(ktToMs(100)).toBeCloseTo(51.4444, 3);
    expect(ktToMph(100)).toBeCloseTo(115.0779, 3);
  });

  it("keeps the sign of a descent rate", () => {
    expect(fpmToMs(-1200)).toBeCloseTo(-6.096, 6);
    expect(fpmToMs(1000)).toBeCloseTo(5.08, 6);
  });
});

describe("pressure and temperature converters", () => {
  it("converts inHg and hPa", () => {
    expect(inhgToHpa(29.92)).toBeCloseTo(1013.21, 1);
    expect(hpaToInhg(1013.25)).toBeCloseTo(29.9213, 3);
  });

  it("converts Celsius and Fahrenheit", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(-40)).toBe(-40);
    expect(fToC(212)).toBeCloseTo(100, 9);
  });
});

describe("every converter is null-tolerant", () => {
  const converters = [
    ftToM,
    mToFt,
    ktToKmh,
    ktToMs,
    ktToMph,
    nmToKm,
    kmToNm,
    smToKm,
    inhgToHpa,
    hpaToInhg,
    cToF,
    fToC,
    fpmToMs,
  ];

  it("returns null for null, undefined and garbage", () => {
    for (const convert of converters) {
      expect(convert(null)).toBeNull();
      expect(convert(undefined)).toBeNull();
      expect(convert("not a number")).toBeNull();
    }
  });

  it("accepts numeric strings everywhere", () => {
    for (const convert of converters) {
      expect(convert("10")).toBe(convert(10));
    }
  });
});

describe("normalizeAltimeter", () => {
  it("reads a value below 40 as inches of mercury", () => {
    const altimeter = normalizeAltimeter(29.92);
    expect(altimeter).not.toBeNull();
    expect(altimeter?.unit).toBe("inHg");
    expect(altimeter?.inHg).toBe(29.92);
    expect(altimeter?.hPa).toBeCloseTo(1013.2, 1);
  });

  it("reads a value at or above 500 as hectopascals", () => {
    const altimeter = normalizeAltimeter(1013);
    expect(altimeter?.unit).toBe("hPa");
    expect(altimeter?.hPa).toBe(1013);
    expect(altimeter?.inHg).toBeCloseTo(29.9139, 3);
  });

  it("refuses to guess in the ambiguous band", () => {
    expect(normalizeAltimeter(100)).toBeNull();
    expect(normalizeAltimeter(499.9)).toBeNull();
  });

  it("accepts strings and rejects non-numbers", () => {
    expect(normalizeAltimeter("1013")?.unit).toBe("hPa");
    expect(normalizeAltimeter("29.92")?.unit).toBe("inHg");
    expect(normalizeAltimeter(null)).toBeNull();
    expect(normalizeAltimeter("")).toBeNull();
  });
});

describe("humidityToPercent", () => {
  it("scales the fraction the API actually sends", () => {
    expect(humidityToPercent(0.62)).toBeCloseTo(62, 9);
    expect(humidityToPercent(1)).toBeCloseTo(100, 9);
    expect(humidityToPercent(0)).toBe(0);
  });

  it("leaves an already-percentage value alone", () => {
    expect(humidityToPercent(62)).toBe(62);
    expect(humidityToPercent(humidityToPercent(0.62))).toBeCloseTo(62, 9);
  });

  it("is null-tolerant", () => {
    expect(humidityToPercent(null)).toBeNull();
    expect(humidityToPercent("x")).toBeNull();
  });
});

describe("parseDurationMinutes", () => {
  it("parses the English display strings ml.flightTime() returns", () => {
    expect(parseDurationMinutes("7h 23m")).toBe(443);
    expect(parseDurationMinutes("45m")).toBe(45);
    expect(parseDurationMinutes("2h")).toBe(120);
    expect(parseDurationMinutes("1 h 5 min")).toBe(65);
    expect(parseDurationMinutes("1 hour 30 minutes")).toBe(90);
    expect(parseDurationMinutes("1d 2h")).toBe(24 * 60 + 120);
  });

  it("treats a bare number as minutes", () => {
    expect(parseDurationMinutes(90)).toBe(90);
    expect(parseDurationMinutes("90")).toBe(90);
  });

  it("returns null when nothing is recognizable", () => {
    expect(parseDurationMinutes(null)).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("soon")).toBeNull();
  });
});

describe("parseVisibility", () => {
  it("handles the P6SM sentinel that arrives with a null value", () => {
    // The trap: `value` is null exactly for the best visibility there is.
    const visibility = parseVisibility({ value: null, repr: "P6" });
    expect(visibility).not.toBeNull();
    expect(visibility?.statuteMiles).toBe(6);
    expect(visibility?.atLeast).toBe(true);
    expect(visibility?.meters).toBeCloseTo(9656.06, 1);
  });

  it("parses statute-mile tokens", () => {
    expect(parseVisibility("10SM")?.statuteMiles).toBe(10);
    expect(parseVisibility("10SM")?.atLeast).toBe(false);
    expect(parseVisibility("P6SM")?.atLeast).toBe(true);
  });

  it("parses fractions and the M (less than) prefix", () => {
    const quarter = parseVisibility("M1/4SM");
    expect(quarter?.statuteMiles).toBe(0.25);
    expect(quarter?.atLeast).toBe(false);
    expect(parseVisibility("1 1/2SM")?.statuteMiles).toBe(1.5);
  });

  it("reads ICAO metre reports", () => {
    const vis = parseVisibility("9999");
    expect(vis?.meters).toBe(9999);
    expect(vis?.statuteMiles).toBeCloseTo(6.21, 2);
    expect(parseVisibility(9999)?.meters).toBe(9999);
  });

  it("reads a bare small number as statute miles", () => {
    expect(parseVisibility(10)?.statuteMiles).toBe(10);
    expect(parseVisibility({ value: 10, repr: "10SM" })?.statuteMiles).toBe(10);
  });

  it("falls back to the numeric value when repr is unusable", () => {
    expect(parseVisibility({ value: 3, repr: null })?.statuteMiles).toBe(3);
    expect(parseVisibility({ value: 3, repr: "" })?.statuteMiles).toBe(3);
  });

  it("returns null when there is nothing to parse", () => {
    expect(parseVisibility(null)).toBeNull();
    expect(parseVisibility(undefined)).toBeNull();
    expect(parseVisibility({ value: null, repr: null })).toBeNull();
    expect(parseVisibility("clear")).toBeNull();
  });
});
