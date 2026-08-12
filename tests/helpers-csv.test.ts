/**
 * CSV export (`src/helpers/csv.ts`).
 *
 * Pure functions: no client, no network, no mocks. The load-bearing assertions here
 * are the RFC 4180 escapes — a comma inside an airport name, a quote inside a NOTAM
 * body, a line break inside anything scraped — because a broken escape does not
 * throw, it silently shifts every column after it.
 */

import { describe, expect, it } from "vitest";
import { SkyLinkError } from "../src/core/errors.js";
import { toCsv } from "../src/helpers/csv.js";
import * as SDK from "../src/index.js";
import type { AdsbAircraft } from "../src/models/adsb.js";

function state(overrides: Partial<AdsbAircraft> = {}): AdsbAircraft {
  return {
    icao24: "4ca1fb",
    callsign: "BAW117 ",
    latitude: 51.5,
    longitude: -0.45,
    altitude: 3000,
    ground_speed: 250,
    track: 90,
    vertical_rate: -1200,
    is_on_ground: false,
    last_seen: "2026-08-12T10:00:00",
    first_seen: "2026-08-12T09:00:00",
    registration: "G-STBA",
    aircraft_type: "B77W",
    airline: "British Airways",
    photo_url: null,
    ...overrides,
  };
}

describe("toCsv — columns", () => {
  it("writes a header and one line per row", () => {
    const csv = toCsv([
      { icao: "KJFK", name: "John F Kennedy" },
      { icao: "EGLL", name: "Heathrow" },
    ]);

    expect(csv).toBe("icao,name\nKJFK,John F Kennedy\nEGLL,Heathrow");
    // No trailing newline: the result concatenates without producing a blank record.
    expect(csv.endsWith("\n")).toBe(false);
  });

  it("takes the union of every row's keys, in first-appearance order", () => {
    const csv = toCsv([
      { b: 1, a: 2 },
      { c: 3, a: 4 },
    ]);

    expect(csv.split("\n")[0]).toBe("b,a,c");
    // A row without a column gets an empty cell, not a shifted one.
    expect(csv.split("\n")[2]).toBe(",4,3");
  });

  it("emits exactly the requested columns, in the requested order", () => {
    const csv = toCsv([state()], { columns: ["callsign", "altitude", "icao24"] });

    expect(csv).toBe("callsign,altitude,icao24\nBAW117 ,3000,4ca1fb");
  });

  it("emits an empty cell for a column no row has", () => {
    const csv = toCsv([{ icao: "KJFK" }], { columns: ["icao", "iata"] });

    expect(csv).toBe("icao,iata\nKJFK,");
  });

  it("keeps the wire's own field names, whatever their casing", () => {
    // PascalCase schedule rows and the one camelCase field in the API (navaids).
    const csv = toCsv([{ Time: "10:30", Flight: "BA123", usageType: "BOTH" }]);

    expect(csv.split("\n")[0]).toBe("Time,Flight,usageType");
  });

  it("returns an empty string for no rows and no columns", () => {
    expect(toCsv([])).toBe("");
  });

  it("returns the header alone when columns are named but there are no rows", () => {
    expect(toCsv([], { columns: ["icao", "raw"] })).toBe("icao,raw");
  });

  it("accepts any iterable, not just arrays", () => {
    const rows = new Set([{ icao: "KJFK" }, { icao: "EGLL" }]);

    expect(toCsv(rows)).toBe("icao\nKJFK\nEGLL");
  });
});

describe("toCsv — RFC 4180 escaping", () => {
  it("quotes a field containing the delimiter", () => {
    const csv = toCsv([{ name: "Paris, Charles de Gaulle" }]);

    expect(csv).toBe('name\n"Paris, Charles de Gaulle"');
  });

  it("doubles embedded quotes and wraps the field", () => {
    const csv = toCsv([{ remarks: 'RWY 04L/22R CLSD "WIP"' }]);

    expect(csv).toBe('remarks\n"RWY 04L/22R CLSD ""WIP"""');
  });

  it("quotes a field containing a line break and keeps the break verbatim", () => {
    const csv = toCsv([{ body: "LINE ONE\r\nLINE TWO" }]);

    expect(csv).toBe('body\n"LINE ONE\r\nLINE TWO"');
  });

  it("quotes a header whose name needs it", () => {
    const csv = toCsv([{ 'odd,"name': 1 }]);

    expect(csv.split("\n")[0]).toBe('"odd,""name"');
  });

  it("leaves a field that needs no quoting unquoted", () => {
    expect(toCsv([{ raw: "METAR KJFK 271851Z 16013KT 10SM" }])).toBe(
      "raw\nMETAR KJFK 271851Z 16013KT 10SM",
    );
  });
});

describe("toCsv — values", () => {
  it("writes null and undefined as empty cells", () => {
    const csv = toCsv([{ altitude: null, callsign: undefined, icao24: "4ca1fb" }]);

    // Not the strings "null"/"undefined": a missing altitude must read back missing.
    expect(csv).toBe("altitude,callsign,icao24\n,,4ca1fb");
  });

  it("writes booleans and numbers unquoted", () => {
    expect(toCsv([{ is_on_ground: false, altitude: 3000, latitude: -0.45 }])).toBe(
      "is_on_ground,altitude,latitude\nfalse,3000,-0.45",
    );
  });

  it("JSON-encodes a nested object or array, quoting it as the escape rules demand", () => {
    const csv = toCsv([{ photos: [{ image: "a.jpg" }], parsed: { flight_rules: "VFR" } }]);

    expect(csv).toBe('photos,parsed\n"[{""image"":""a.jpg""}]","{""flight_rules"":""VFR""}"');
  });

  it("writes a Date as ISO 8601 and an invalid one as empty", () => {
    const csv = toCsv([{ at: new Date("2026-08-12T10:00:00Z") }, { at: new Date("not a date") }]);

    expect(csv).toBe("at\n2026-08-12T10:00:00.000Z\n");
  });

  it("survives a circular structure instead of throwing", () => {
    const circular: Record<string, unknown> = { icao: "KJFK" };
    circular.self = circular;

    const csv = toCsv([circular]);

    expect(csv.split("\n")[0]).toBe("icao,self");
    expect(csv.split("\n")[1]?.startsWith("KJFK,")).toBe(true);
  });

  it("writes a bigint in full rather than losing it", () => {
    expect(toCsv([{ id: 90071992547409910n }])).toBe("id\n90071992547409910");
  });
});

describe("toCsv — delimiter and newline", () => {
  it("uses a semicolon when asked, and quotes on it instead of on the comma", () => {
    const csv = toCsv([{ name: "Paris, Charles de Gaulle", iata: "CDG" }], { delimiter: ";" });

    // The comma is now ordinary text; only the semicolon forces quotes.
    expect(csv).toBe("name;iata\nParis, Charles de Gaulle;CDG");
  });

  it("produces a TSV with a tab", () => {
    const csv = toCsv([{ a: "x\ty", b: "z" }], { delimiter: "\t" });

    expect(csv).toBe('a\tb\n"x\ty"\tz');
  });

  it("writes CRLF records when asked, as RFC 4180 prefers", () => {
    expect(toCsv([{ a: 1 }, { a: 2 }], { newline: "\r\n" })).toBe("a\r\n1\r\n2");
  });

  it("rejects a delimiter that is not a single character", () => {
    expect(() => toCsv([{ a: 1 }], { delimiter: "||" })).toThrow(SkyLinkError);
    expect(() => toCsv([{ a: 1 }], { delimiter: "" })).toThrow(/single character/);
  });

  it("rejects a delimiter that is part of the format's own syntax", () => {
    expect(() => toCsv([{ a: 1 }], { delimiter: '"' })).toThrow(/quote or a line break/);
    expect(() => toCsv([{ a: 1 }], { delimiter: "\n" })).toThrow(SkyLinkError);
  });
});

describe("toCsv — packaging", () => {
  it("is reachable from the barrel, like every other helper namespace", () => {
    // Users import it either as `import { csv } from "skylink-api"` or from the
    // tree-shakeable subpath `skylink-api/csv`; the subpath is wired in tsup.config.ts.
    expect(SDK.csv.toCsv).toBe(toCsv);
  });
});

describe("toCsv — real response shapes", () => {
  it("exports an ADS-B feed with the model's own field names", () => {
    const csv = toCsv([state(), state({ icao24: "406a3d", callsign: null, altitude: null })], {
      columns: ["icao24", "callsign", "altitude", "is_on_ground"],
    });

    expect(csv.split("\n")).toEqual([
      "icao24,callsign,altitude,is_on_ground",
      "4ca1fb,BAW117 ,3000,false",
      "406a3d,,,false",
    ]);
  });
});
