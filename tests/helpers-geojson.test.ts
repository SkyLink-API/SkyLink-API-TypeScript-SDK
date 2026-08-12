/**
 * GeoJSON exporters (`src/helpers/geojson.ts`).
 *
 * Pure functions: no client, no network, no mocks. The load-bearing assertion in
 * this file is coordinate order — GeoJSON is `[longitude, latitude]` while every
 * model in the SDK names latitude first, and a swapped pair fails silently.
 */

import { describe, expect, it } from "vitest";
import {
  adsbToGeojson,
  airportsToGeojson,
  navaidsToGeojson,
  trackToGeojson,
} from "../src/helpers/geojson.js";
import type { AdsbAircraft } from "../src/models/adsb.js";
import type { AirportWithDistance } from "../src/models/airports.js";
import type { HistoryPosition, HistoryTrackResponse } from "../src/models/history.js";
import type { Navaid } from "../src/models/navaids.js";

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

function position(latitude: number | null, longitude: number | null): HistoryPosition {
  return {
    timestamp: "2026-08-12T10:00:00",
    icao24: "4ca1fb",
    latitude,
    longitude,
    altitude_baro: 30000,
    ground_speed: 480,
    track: 90,
    vertical_rate: 0,
    callsign: "BAW117",
    is_on_ground: false,
    registration: "G-STBA",
    aircraft_type: "B77W",
    gps_spoofed: null,
  };
}

describe("coordinate order", () => {
  it("emits [longitude, latitude] everywhere", () => {
    const adsb = adsbToGeojson([state({ latitude: 51.5, longitude: -0.45 })]);
    expect(adsb.features[0]?.geometry.coordinates).toEqual([-0.45, 51.5]);

    const airports = airportsToGeojson([{ latitude_deg: 40.64, longitude_deg: -73.78 }]);
    expect(airports.features[0]?.geometry.coordinates).toEqual([-73.78, 40.64]);

    const navaids = navaidsToGeojson([{ latitude_deg: 40.63, longitude_deg: -73.77 }]);
    expect(navaids.features[0]?.geometry.coordinates).toEqual([-73.77, 40.63]);

    const track = trackToGeojson([position(40.7, -74), position(40.8, -74.1)]);
    expect(track.features[0]?.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-74, 40.7],
        [-74.1, 40.8],
      ],
    });
  });
});

describe("adsbToGeojson", () => {
  it("builds one Point feature per aircraft", () => {
    const collection = adsbToGeojson([state()]);
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(1);
    const feature = collection.features[0];
    expect(feature?.type).toBe("Feature");
    expect(feature?.geometry.type).toBe("Point");
    expect(feature?.properties).toEqual({
      icao24: "4ca1fb",
      callsign: "BAW117",
      altitude: 3000,
      ground_speed: 250,
      track: 90,
      vertical_rate: -1200,
      is_on_ground: false,
      registration: "G-STBA",
      aircraft_type: "B77W",
      airline: "British Airways",
      last_seen: "2026-08-12T10:00:00",
    });
  });

  it("keeps the API's own field names", () => {
    const properties = adsbToGeojson([state()]).features[0]?.properties ?? {};
    expect(Object.keys(properties)).toContain("ground_speed");
    expect(Object.keys(properties)).not.toContain("groundSpeed");
  });

  it("skips aircraft that have been heard but not located", () => {
    // Normal for an identification-only message: every positional field is null.
    const collection = adsbToGeojson([
      state({ latitude: null, longitude: null }),
      state({ icao24: "abc123" }),
    ]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties.icao24).toBe("abc123");
  });

  it("drops null properties instead of emitting them", () => {
    const properties = adsbToGeojson([state({ registration: null, airline: null })]).features[0]
      ?.properties;
    expect(properties).not.toHaveProperty("registration");
    expect(properties).not.toHaveProperty("airline");
  });

  it("returns an empty collection for an empty feed", () => {
    expect(adsbToGeojson([])).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("trackToGeojson", () => {
  const envelope: HistoryTrackResponse = {
    flight_id: "0d2f1f3a-1111-2222-3333-444455556666",
    icao24: "4CA1FB",
    callsign: "BAW117",
    registration: "G-STBA",
    aircraft_type_icao: "B77W",
    departure_airport_icao: "EGLL",
    departure_airport_iata: "LHR",
    arrival_airport_icao: "KJFK",
    arrival_airport_iata: "JFK",
    takeoff_time: "2026-08-12T10:00:00",
    landing_time: "2026-08-12T17:00:00",
    count: 3,
    positions: [position(40.7, -74), position(40.8, -74.1), position(40.9, -74.2)],
  };

  it("accepts the history.track() envelope and carries its identifiers", () => {
    const collection = trackToGeojson(envelope);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry.type).toBe("LineString");
    expect(collection.features[0]?.properties).toMatchObject({
      flight_id: envelope.flight_id,
      icao24: "4CA1FB",
      callsign: "BAW117",
      registration: "G-STBA",
      departure_airport_icao: "EGLL",
      arrival_airport_icao: "KJFK",
      point_count: 3,
    });
  });

  it("accepts a bare array of positions", () => {
    const collection = trackToGeojson(envelope.positions);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties.point_count).toBe(3);
  });

  it("adds a Point per fix when asked", () => {
    const collection = trackToGeojson(envelope, { includePoints: true });
    expect(collection.features).toHaveLength(4);
    expect(collection.features[1]?.geometry.type).toBe("Point");
    expect(collection.features[1]?.properties).toMatchObject({
      timestamp: "2026-08-12T10:00:00",
      altitude_baro: 30000,
      ground_speed: 480,
      is_on_ground: false,
    });
  });

  it("skips positions without coordinates", () => {
    const collection = trackToGeojson([
      position(40.7, -74),
      position(null, null),
      position(41, -74),
    ]);
    expect(collection.features[0]?.geometry.coordinates).toHaveLength(2);
    expect(collection.features[0]?.properties.point_count).toBe(2);
  });

  it("emits nothing for a track that cannot form a line", () => {
    expect(trackToGeojson([]).features).toHaveLength(0);
    expect(trackToGeojson([position(40.7, -74)]).features).toHaveLength(0);
    expect(trackToGeojson({ positions: null }).features).toHaveLength(0);
  });

  it("still emits the points of a one-fix track when asked", () => {
    const collection = trackToGeojson([position(40.7, -74)], { includePoints: true });
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry.type).toBe("Point");
  });
});

describe("airportsToGeojson", () => {
  const airport: AirportWithDistance = {
    id: 3697,
    ident: "KJFK",
    type: "large_airport",
    name: "John F Kennedy International Airport",
    latitude_deg: 40.639447,
    longitude_deg: -73.779317,
    elevation_ft: 13,
    municipality: "New York",
    iso_country: "US",
    iso_region: "US-NY",
    iata_code: "JFK",
    distance_km: 12.4,
  };

  it("carries the identifying columns through", () => {
    const feature = airportsToGeojson([airport]).features[0];
    expect(feature?.geometry.coordinates).toEqual([-73.779317, 40.639447]);
    expect(feature?.properties).toEqual({
      ident: "KJFK",
      name: "John F Kennedy International Airport",
      type: "large_airport",
      iata_code: "JFK",
      municipality: "New York",
      iso_country: "US",
      iso_region: "US-NY",
      elevation_ft: 13,
      distance_km: 12.4,
    });
  });

  it("skips dataset rows with no coordinates", () => {
    expect(
      airportsToGeojson([{ ...airport, latitude_deg: null, longitude_deg: null }]).features,
    ).toHaveLength(0);
  });
});

describe("navaidsToGeojson", () => {
  const navaid: Navaid = {
    id: 87231,
    ident: "JFK",
    name: "Kennedy",
    type: "VOR-DME",
    frequency_khz: 115900,
    latitude_deg: 40.632999,
    longitude_deg: -73.77,
    elevation_ft: 12,
    iso_country: "US",
    dme_frequency_khz: 115900,
    dme_channel: "106X",
    slaved_variation_deg: null,
    magnetic_variation_deg: -13,
    usageType: "BOTH",
    power: "HIGH",
    associated_airport: "KJFK",
  };

  it("keeps usageType in the API's camelCase spelling", () => {
    // The one camelCase field in the whole API; renaming it breaks the join back.
    const properties = navaidsToGeojson([navaid]).features[0]?.properties ?? {};
    expect(properties.usageType).toBe("BOTH");
    expect(Object.keys(properties)).not.toContain("usage_type");
  });

  it("coerces frequencies that arrive as strings in the enriched form", () => {
    const properties =
      navaidsToGeojson([{ latitude_deg: 40.6, longitude_deg: -73.7, frequency_khz: "115900" }])
        .features[0]?.properties ?? {};
    expect(properties.frequency_khz).toBe(115900);
  });

  it("skips navaids without coordinates", () => {
    expect(
      navaidsToGeojson([{ ...navaid, latitude_deg: null, longitude_deg: null }]).features,
    ).toHaveLength(0);
  });
});
