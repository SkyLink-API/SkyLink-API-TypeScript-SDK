import { describe, expect, it } from "vitest";
import {
  buildQueryString,
  buildSearchParams,
  formatBBox,
  formatDateDMY,
  formatDateTimeISO,
  formatDateYMD,
  formatTimeHM,
} from "../src/core/query.js";
import type { BBox } from "../src/core/types.js";

describe("buildQueryString", () => {
  it("drops undefined and null values entirely", () => {
    const qs = buildQueryString({ icao: "KJFK", source: undefined, category: null, limit: 10 });
    expect(qs).toBe("icao=KJFK&limit=10");
  });

  it("returns an empty string when there is nothing to serialize", () => {
    expect(buildQueryString()).toBe("");
    expect(buildQueryString({})).toBe("");
    expect(buildQueryString({ a: undefined, b: null })).toBe("");
  });

  it("serializes booleans as true/false rather than 1/0", () => {
    expect(buildQueryString({ photos: false, parsed: true })).toBe("photos=false&parsed=true");
  });

  it("keeps zero and empty-string values", () => {
    expect(buildQueryString({ offset: 0, q: "" })).toBe("offset=0&q=");
  });

  it("comma-joins a bbox tuple", () => {
    const bbox: BBox = [40.5, -74.5, 41.5, -73.5];
    expect(buildQueryString({ bbox })).toBe("bbox=40.5%2C-74.5%2C41.5%2C-73.5");
    expect(buildSearchParams({ bbox }).get("bbox")).toBe("40.5,-74.5,41.5,-73.5");
  });

  it("comma-joins string arrays (CSV filters such as exclude_scope)", () => {
    expect(buildSearchParams({ exclude_scope: ["AERODROME", "FIR"] }).get("exclude_scope")).toBe(
      "AERODROME,FIR",
    );
  });

  it("percent-encodes values", () => {
    expect(buildQueryString({ q: "New York" })).toBe("q=New+York");
  });

  it("preserves insertion order", () => {
    expect(buildQueryString({ b: 1, a: 2 })).toBe("b=1&a=2");
  });
});

describe("formatBBox", () => {
  it("joins a tuple and passes strings through", () => {
    expect(formatBBox([1, 2, 3, 4])).toBe("1,2,3,4");
    expect(formatBBox("1,2,3,4")).toBe("1,2,3,4");
  });
});

describe("date formatters", () => {
  const date = new Date(Date.UTC(2026, 1, 3, 7, 5, 9));

  it("formats tickets dates as YYYY-MM-DD", () => {
    expect(formatDateYMD(date)).toBe("2026-02-03");
    expect(formatDateYMD("2026-02-03")).toBe("2026-02-03");
  });

  it("formats schedules dates as DD-MM-YYYY", () => {
    expect(formatDateDMY(date)).toBe("03-02-2026");
    expect(formatDateDMY("03-02-2026")).toBe("03-02-2026");
  });

  it("does not reinterpret a DD-MM-YYYY string as ISO", () => {
    expect(formatDateDMY("12-08-2026")).toBe("12-08-2026");
  });

  it("formats history timestamps as ISO 8601 UTC", () => {
    expect(formatDateTimeISO(date)).toBe("2026-02-03T07:05:09Z");
    expect(formatDateTimeISO("2026-02-03T07:05:09+02:00")).toBe("2026-02-03T07:05:09+02:00");
  });

  it("formats schedules time as HH:MM", () => {
    expect(formatTimeHM(date)).toBe("07:05");
    expect(formatTimeHM("07:05")).toBe("07:05");
  });

  it("rejects unparseable dates", () => {
    expect(() => formatDateYMD("not a date")).toThrow(TypeError);
  });
});
