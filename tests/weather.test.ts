import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, SkyLinkError } from "../src/core/errors.js";
import type {
  AirSigmetResponse,
  MetarResponse,
  ParsedMetarResponse,
  ParsedTafResponse,
  PirepsResponse,
  TafResponse,
  WindsAloftResponse,
} from "../src/models/weather.js";
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

const metarFixture = loadFixture<MetarResponse>("weather_metar");

function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options });
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("weather.metar", () => {
  it("fetches the raw report and sends no query parameters by default", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: metarFixture });

    const report: MetarResponse = await client().weather.metar("KJFK");

    expect(report.icao).toBe("KJFK");
    expect(report.raw).toBe(metarFixture.raw);
    expect(report.airport_name).toBe("John F Kennedy International Airport");
    expect(report.timestamp).toBe("2025-09-27T12:00:00Z");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/weather/metar/KJFK");
    expect(request?.query.has("parsed")).toBe(false);
    expect(request?.headers["x-api-key"]).toBe("test-key");
  });

  it("returns the decoded block when parsed: true", async () => {
    mockJson({
      path: /^\/v3\.1\/weather\/metar\/KJFK\?/,
      body: {
        ...metarFixture,
        parsed: {
          wind: { direction: 160, speed: 13, gust: null, variable: [] },
          visibility: { value: 10, repr: "10SM" },
          clouds: [{ type: "FEW", base: 24, repr: "FEW024" }],
          temperature: 15,
          dewpoint: 9,
          altimeter: 30.2,
          flight_rules: "VFR",
          wx_codes: [],
          remarks: "AO2 SLP216 T01500089",
          time: "2025-09-27T18:51:00Z",
          density_altitude: 512,
          pressure_altitude: 13,
          relative_humidity: 0.67,
        },
      },
    });

    const report: ParsedMetarResponse = await client().weather.metar("KJFK", { parsed: true });

    expect(report.parsed?.flight_rules).toBe("VFR");
    expect(report.parsed?.wind.direction).toBe(160);
    expect(report.parsed?.wind.gust).toBeNull();
    expect(report.parsed?.visibility?.repr).toBe("10SM");
    expect(report.parsed?.clouds[0]?.type).toBe("FEW");
    expect(report.parsed?.relative_humidity).toBeCloseTo(0.67);

    expect(requests[0]?.fullPath).toBe("/v3.1/weather/metar/KJFK?parsed=true");
    expect(requests[0]?.query.get("parsed")).toBe("true");
  });

  it("survives parsed: null when the upstream decoder fails", async () => {
    mockJson({
      path: /^\/v3\.1\/weather\/metar\/KJFK\?/,
      body: { ...metarFixture, parsed: null },
    });

    const report: ParsedMetarResponse = await client().weather.metar("KJFK", { parsed: true });

    expect(report.parsed).toBeNull();
    expect(report.raw).toBe(metarFixture.raw);
    expect(report.parsed?.flight_rules).toBeUndefined();
  });

  it("sends parsed=false explicitly when asked", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/metar\/EGLL\?/, body: metarFixture });

    await client().weather.metar("EGLL", { parsed: false });

    expect(requests[0]?.fullPath).toBe("/v3.1/weather/metar/EGLL?parsed=false");
  });

  it("percent-encodes the icao path segment and rejects an empty one", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/K%2FFK`, body: metarFixture });

    await client().weather.metar("K/FK");
    expect(requests[0]?.path).toBe("/v3.1/weather/metar/K%2FFK");

    expect(() => client().weather.metar("   ")).toThrow(SkyLinkError);
    expect(() => client().weather.metar("")).toThrow(/icao/);
  });

  it("maps a 404 to NotFoundError", async () => {
    mockError({
      path: `${DIRECT_PREFIX}/weather/metar/ZZZZ`,
      status: 404,
      body: { detail: "Airport not found for ICAO code: ZZZZ" },
    });

    await expect(client().weather.metar("ZZZZ")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forwards per-call request options", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/metar/KJFK`, body: metarFixture });

    await client().weather.metar("KJFK", undefined, { headers: { "X-Trace": "abc" } });

    expect(requests[0]?.headers["x-trace"]).toBe("abc");
  });
});

describe("weather.taf", () => {
  const tafBody = {
    raw: "TAF KJFK 271720Z 2718/2824 16012KT P6SM FEW025 SCT250",
    icao: "KJFK",
    airport_name: "John F Kennedy International Airport",
    timestamp: "2025-09-27T12:00:00Z",
  };

  it("fetches the raw forecast", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/weather/taf/KJFK`, body: tafBody });

    const forecast: TafResponse = await client().weather.taf("KJFK");

    expect(forecast.raw).toContain("TAF KJFK");
    expect(requests[0]?.fullPath).toBe("/v3.1/weather/taf/KJFK");
    expect(requests[0]?.query.has("parsed")).toBe(false);
  });

  it("returns the decoded forecast periods when parsed: true", async () => {
    mockJson({
      path: /^\/v3\.1\/weather\/taf\/KJFK\?/,
      body: {
        ...tafBody,
        parsed: {
          start_time: "2025-09-27T18:00:00Z",
          end_time: "2025-09-28T24:00:00Z",
          forecast: [
            {
              type: "FROM",
              start_time: "2025-09-27T18:00:00Z",
              end_time: "2025-09-27T21:00:00Z",
              wind: { direction: 160, speed: 12, gust: null, variable: [] },
              visibility: { value: 6, repr: "P6SM" },
              clouds: [{ type: "FEW", base: 25, repr: "FEW025" }],
              wx_codes: [],
              flight_rules: "VFR",
              probability: null,
              turbulence: [],
              icing: [],
            },
          ],
        },
      },
    });

    const forecast: ParsedTafResponse = await client().weather.taf("KJFK", { parsed: true });

    expect(forecast.parsed?.forecast).toHaveLength(1);
    expect(forecast.parsed?.forecast[0]?.type).toBe("FROM");
    expect(forecast.parsed?.forecast[0]?.flight_rules).toBe("VFR");
    expect(forecast.parsed?.forecast[0]?.wind.speed).toBe(12);
    expect(forecast.parsed?.forecast[0]?.turbulence).toEqual([]);
    expect(requests[0]?.fullPath).toBe("/v3.1/weather/taf/KJFK?parsed=true");
  });

  it("survives parsed: null when the upstream decoder fails", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/taf\/KJFK\?/, body: { ...tafBody, parsed: null } });

    const forecast: ParsedTafResponse = await client().weather.taf("KJFK", { parsed: true });

    expect(forecast.parsed).toBeNull();
    expect(forecast.raw).toBe(tafBody.raw);
  });
});

describe("weather.windsAloft", () => {
  const windsBody = {
    bbox: "40,-80,42,-73",
    forecast_hour: 12,
    level: "low",
    valid_time: "130000Z",
    stations: [
      {
        station: "JFK",
        latitude: 40.6413,
        longitude: -73.7781,
        winds: [
          {
            altitude_ft: 3000,
            wind_direction: 270,
            wind_speed_kt: 9,
            temperature_c: null,
            light_and_variable: false,
            raw: "2709",
          },
        ],
        raw_text: "JFK      2709 3012+08",
      },
    ],
    total: 1,
  };

  it("serializes a bbox tuple and the optional filters", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/winds-aloft\?/, body: windsBody });

    const winds: WindsAloftResponse = await client().weather.windsAloft({
      bbox: [40, -80, 42, -73],
      forecast: 24,
      level: "high",
    });

    expect(winds.total).toBe(1);
    expect(winds.stations[0]?.station).toBe("JFK");
    expect(winds.stations[0]?.winds[0]?.altitude_ft).toBe(3000);
    expect(winds.stations[0]?.winds[0]?.light_and_variable).toBe(false);
    expect(winds.valid_time).toBe("130000Z");

    expect(requests[0]?.path).toBe("/v3.1/weather/winds-aloft");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/weather/winds-aloft?bbox=40%2C-80%2C42%2C-73&forecast=24&level=high",
    );
    expect(requests[0]?.query.get("bbox")).toBe("40,-80,42,-73");
  });

  it("passes a pre-joined bbox string through and omits unset filters", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/winds-aloft\?/, body: windsBody });

    await client().weather.windsAloft({ bbox: "40,-80,42,-73" });

    expect(requests[0]?.query.get("bbox")).toBe("40,-80,42,-73");
    expect(requests[0]?.query.has("forecast")).toBe(false);
    expect(requests[0]?.query.has("level")).toBe(false);
  });
});

describe("weather.pireps", () => {
  const pirepsBody = {
    bbox: "39,-78,42,-71",
    hours: 2,
    reports: [
      {
        raw: "UA /OV JFK/TM 1845/FL085/TP B738/TB MOD/RM CONT MOD CHOP",
        report_type: "UA",
        location: "JFK",
        time: "2025-01-15T18:45:00Z",
        altitude: "FL085",
        aircraft_type: "B738",
        sky_conditions: null,
        turbulence: "Moderate",
        icing: null,
        temperature: null,
        wind: null,
        remarks: "CONT MOD CHOP",
        latitude: 40.64,
        longitude: -73.78,
      },
    ],
    total: 1,
  };

  it("queries a bounding box with a time window", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/pireps\?/, body: pirepsBody });

    const pireps: PirepsResponse = await client().weather.pireps({
      bbox: [39, -78, 42, -71],
      hours: 6,
    });

    expect(pireps.total).toBe(1);
    expect(pireps.reports[0]?.report_type).toBe("UA");
    expect(pireps.reports[0]?.altitude).toBe("FL085");
    expect(pireps.reports[0]?.icing).toBeNull();
    expect(pireps.reports[0]?.latitude).toBeCloseTo(40.64);

    expect(requests[0]?.path).toBe("/v3.1/weather/pireps");
    expect(requests[0]?.fullPath).toBe("/v3.1/weather/pireps?bbox=39%2C-78%2C42%2C-71&hours=6");
  });

  it("omits hours when it is not supplied", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/pireps\?/, body: pirepsBody });

    await client().weather.pireps({ bbox: [39, -78, 42, -71] });

    expect(requests[0]?.fullPath).toBe("/v3.1/weather/pireps?bbox=39%2C-78%2C42%2C-71");
    expect(requests[0]?.query.has("hours")).toBe(false);
  });
});

describe("weather.airsigmet", () => {
  const airsigmetBody = {
    bbox: "38,-90,45,-80",
    reports: [
      {
        raw: "WAUS46 KKCI 151445 WA6S AIRMET SIERRA",
        bulletin_type: "AIRMET",
        country: "US",
        issuer: "KKCI",
        area: "S",
        report_type: "AIRMET",
        start_time: "2025-01-15T14:45:00Z",
        end_time: "2025-01-15T21:00:00Z",
        body: "AIRMET IFR...",
        region: "SLC",
        observation: {
          type: "IFR",
          intensity: null,
          floor: "SFC",
          ceiling: "FL180",
          coords: [{ lat: 40.1, lon: -85.2 }],
          movement: { direction: "270", speed: "15" },
        },
        forecast: null,
      },
    ],
    total: 1,
    filter_type: "airmet",
  };

  it("filters by advisory type", async () => {
    mockJson({ path: /^\/v3\.1\/weather\/airsigmet\?/, body: airsigmetBody });

    const advisories: AirSigmetResponse = await client().weather.airsigmet({
      bbox: [38, -90, 45, -80],
      type: "airmet",
    });

    expect(advisories.filter_type).toBe("airmet");
    expect(advisories.reports[0]?.report_type).toBe("AIRMET");
    expect(advisories.reports[0]?.observation?.ceiling).toBe("FL180");
    expect(advisories.reports[0]?.observation?.coords[0]?.lat).toBeCloseTo(40.1);
    expect(advisories.reports[0]?.observation?.movement?.speed).toBe("15");
    expect(advisories.reports[0]?.forecast).toBeNull();

    expect(requests[0]?.path).toBe("/v3.1/weather/airsigmet");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/weather/airsigmet?bbox=38%2C-90%2C45%2C-80&type=airmet",
    );
  });

  it("omits the type filter when unset", async () => {
    mockJson({
      path: /^\/v3\.1\/weather\/airsigmet\?/,
      body: { ...airsigmetBody, filter_type: null },
    });

    const advisories = await client().weather.airsigmet({ bbox: "38,-90,45,-80" });

    expect(advisories.filter_type).toBeNull();
    expect(requests[0]?.fullPath).toBe("/v3.1/weather/airsigmet?bbox=38%2C-90%2C45%2C-80");
    expect(requests[0]?.query.has("type")).toBe(false);
  });
});

describe("weather namespace wiring", () => {
  it("is an eager readonly field on the client", () => {
    const sky = client();
    expect(sky.weather).toBe(sky.weather);
    expect(typeof sky.weather.metar).toBe("function");
    expect(typeof sky.weather.taf).toBe("function");
    expect(typeof sky.weather.windsAloft).toBe("function");
    expect(typeof sky.weather.pireps).toBe("function");
    expect(typeof sky.weather.airsigmet).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: "/weather/metar/KJFK",
      body: metarFixture,
    });

    await client({ provider: "rapidapi", apiKey: "rapid-key" }).weather.metar("KJFK");

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/weather/metar/KJFK");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
