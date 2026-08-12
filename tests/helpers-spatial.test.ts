/**
 * Geodesic helpers (`src/helpers/spatial.ts`).
 *
 * Pure functions: no client, no network, no mocks. Reference distances come from
 * published great-circle figures (JFK–LHR ≈ 5 555 km / 3 000 nm).
 */

import { describe, expect, it } from "vitest";
import {
  bbox,
  bboxAround,
  destinationPoint,
  EARTH_RADIUS_KM,
  greatCirclePoints,
  haversineKm,
  haversineNm,
  initialBearing,
  KM_PER_DEGREE_LAT,
  parseBbox,
  pointCoords,
  simplifyTrack,
  trackStats,
} from "../src/helpers/spatial.js";
import type { AdsbAircraft } from "../src/models/adsb.js";
import type { HistoryPosition } from "../src/models/history.js";

const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.47, lon: -0.4543 };

describe("bbox", () => {
  it("emits the south-west corner first", () => {
    expect(bbox(40, -74, 41, -73)).toBe("40,-74,41,-73");
  });

  it("normalizes corners given in any order", () => {
    // The trap: every bbox endpoint wants lat1 <= lat2 and lon1 <= lon2.
    expect(bbox(41, -73, 40, -74)).toBe("40,-74,41,-73");
    expect(bbox(41, -74, 40, -73)).toBe("40,-74,41,-73");
  });

  it("trims float noise", () => {
    expect(bbox(40.1 + 0.2, -74, 41, -73)).toBe("40.3,-74,41,-73");
  });
});

describe("bboxAround", () => {
  it("produces a box whose half-height is the requested radius", () => {
    const box = parseBbox(bboxAround(51.47, -0.4543, 50));
    expect(haversineKm(box.south, -0.4543, 51.47, -0.4543)).toBeCloseTo(50, 1);
    expect(haversineKm(box.north, -0.4543, 51.47, -0.4543)).toBeCloseTo(50, 1);
  });

  it("widens longitude by cos(latitude)", () => {
    // The trap: a naive radius/111 on both axes is far too narrow away from the equator.
    const atEquator = parseBbox(bboxAround(0, 0, 100));
    const atSixty = parseBbox(bboxAround(60, 0, 100));
    const equatorWidth = atEquator.east - atEquator.west;
    const sixtyWidth = atSixty.east - atSixty.west;
    expect(sixtyWidth / equatorWidth).toBeCloseTo(2, 1);
    expect(haversineKm(60, atSixty.west, 60, 0)).toBeCloseTo(100, 0);
  });

  it("clamps latitude at the poles instead of wrapping", () => {
    const box = parseBbox(bboxAround(89, 0, 500));
    expect(box.north).toBeLessThanOrEqual(90);
    expect(box.south).toBeGreaterThanOrEqual(-90);
    expect(box.west).toBeGreaterThanOrEqual(-180);
    expect(box.east).toBeLessThanOrEqual(180);
  });
});

describe("parseBbox", () => {
  it("parses the wire string", () => {
    expect(parseBbox("40.0,-74.5,41.0,-73.5")).toEqual({
      south: 40,
      west: -74.5,
      north: 41,
      east: -73.5,
    });
  });

  it("parses the tuple the request parameters take", () => {
    expect(parseBbox([41, -73.5, 40, -74.5])).toEqual({
      south: 40,
      west: -74.5,
      north: 41,
      east: -73.5,
    });
  });

  it("round-trips a BBox object", () => {
    const box = { south: 40, west: -74.5, north: 41, east: -73.5 };
    expect(parseBbox(box)).toEqual(box);
    expect(parseBbox(bbox(box.south, box.west, box.north, box.east))).toEqual(box);
  });

  it("throws on anything that is not four numbers", () => {
    expect(() => parseBbox("40,-74,41")).toThrow(TypeError);
    expect(() => parseBbox("a,b,c,d")).toThrow(TypeError);
    expect(() => parseBbox([1, 2, 3, 4, 5])).toThrow(TypeError);
  });
});

describe("haversine", () => {
  it("matches the published JFK–LHR great-circle distance", () => {
    const km = haversineKm(JFK.lat, JFK.lon, LHR.lat, LHR.lon);
    expect(km).toBeGreaterThan(5530);
    expect(km).toBeLessThan(5580);
    expect(haversineNm(JFK.lat, JFK.lon, LHR.lat, LHR.lon)).toBeCloseTo(km / 1.852, 6);
  });

  it("is zero for identical points and symmetric otherwise", () => {
    expect(haversineKm(JFK.lat, JFK.lon, JFK.lat, JFK.lon)).toBe(0);
    expect(haversineKm(LHR.lat, LHR.lon, JFK.lat, JFK.lon)).toBeCloseTo(
      haversineKm(JFK.lat, JFK.lon, LHR.lat, LHR.lon),
      9,
    );
  });

  it("measures a quarter of the circumference from equator to pole", () => {
    expect(haversineKm(0, 0, 90, 0)).toBeCloseTo((Math.PI / 2) * EARTH_RADIUS_KM, 6);
  });
});

describe("initialBearing", () => {
  it("returns due north, east, south and west", () => {
    expect(initialBearing(0, 0, 10, 0)).toBeCloseTo(0, 6);
    expect(initialBearing(0, 0, 0, 10)).toBeCloseTo(90, 6);
    expect(initialBearing(10, 0, 0, 0)).toBeCloseTo(180, 6);
    expect(initialBearing(0, 10, 0, 0)).toBeCloseTo(270, 6);
  });

  it("normalizes to [0, 360)", () => {
    const bearing = initialBearing(JFK.lat, JFK.lon, LHR.lat, LHR.lon);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
    // The North Atlantic track leaves JFK heading north-east.
    expect(bearing).toBeGreaterThan(40);
    expect(bearing).toBeLessThan(60);
  });
});

describe("destinationPoint", () => {
  it("lands the requested distance away on the requested bearing", () => {
    const [lat, lon] = destinationPoint(51.47, -0.4543, 90, 100);
    expect(haversineKm(51.47, -0.4543, lat, lon)).toBeCloseTo(100, 6);
    expect(initialBearing(51.47, -0.4543, lat, lon)).toBeCloseTo(90, 6);
  });

  it("returns [latitude, longitude], not GeoJSON order", () => {
    const [lat, lon] = destinationPoint(0, 0, 0, KM_PER_DEGREE_LAT);
    expect(lat).toBeCloseTo(1, 6);
    expect(lon).toBeCloseTo(0, 6);
  });
});

describe("greatCirclePoints", () => {
  it("starts and ends exactly at the endpoints", () => {
    const points = greatCirclePoints(JFK.lat, JFK.lon, LHR.lat, LHR.lon, { count: 8 });
    expect(points).toHaveLength(8);
    expect(points[0]?.[0]).toBeCloseTo(JFK.lat, 6);
    expect(points[0]?.[1]).toBeCloseTo(JFK.lon, 6);
    expect(points[7]?.[0]).toBeCloseTo(LHR.lat, 6);
    expect(points[7]?.[1]).toBeCloseTo(LHR.lon, 6);
  });

  it("bows north of the rhumb line on a transatlantic leg", () => {
    const points = greatCirclePoints(JFK.lat, JFK.lon, LHR.lat, LHR.lon, { count: 3 });
    const middle = points[1];
    expect(middle?.[0]).toBeGreaterThan((JFK.lat + LHR.lat) / 2);
  });

  it("defaults to 64 points and never returns fewer than two", () => {
    expect(greatCirclePoints(0, 0, 1, 1)).toHaveLength(64);
    expect(greatCirclePoints(0, 0, 1, 1, { count: 1 })).toHaveLength(2);
  });

  it("survives identical endpoints", () => {
    const points = greatCirclePoints(10, 20, 10, 20, { count: 4 });
    expect(points).toHaveLength(4);
    expect(points.every((p) => p[0] === 10 && p[1] === 20)).toBe(true);
  });
});

describe("pointCoords", () => {
  it("reads latitude/longitude, lat/lon, lat/lng and *_deg", () => {
    expect(pointCoords({ latitude: 1, longitude: 2 })).toEqual([1, 2]);
    expect(pointCoords({ lat: 1, lon: 2 })).toEqual([1, 2]);
    expect(pointCoords({ lat: 1, lng: 2 })).toEqual([1, 2]);
    expect(pointCoords({ latitude_deg: 1, longitude_deg: 2 })).toEqual([1, 2]);
  });

  it("reads a bare pair and coerces string coordinates", () => {
    expect(pointCoords([1, 2])).toEqual([1, 2]);
    expect(pointCoords({ latitude: "40.64", longitude: "-73.78" })).toEqual([40.64, -73.78]);
  });

  it("returns null when there is no usable pair", () => {
    expect(pointCoords(null)).toBeNull();
    expect(pointCoords(undefined)).toBeNull();
    expect(pointCoords({})).toBeNull();
    expect(pointCoords({ latitude: 1, longitude: null })).toBeNull();
    expect(pointCoords({ latitude: null, longitude: null })).toBeNull();
  });

  it("accepts the SDK's own models without a cast", () => {
    const state: AdsbAircraft = {
      icao24: "4ca1fb",
      callsign: "BAW117",
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
    };
    expect(pointCoords(state)).toEqual([51.5, -0.45]);
  });
});

/** A `history.track()` row, newest first as the API returns them. */
function position(
  timestamp: string,
  latitude: number,
  longitude: number,
  altitudeBaro: number | null,
  groundSpeed: number | null,
): HistoryPosition {
  return {
    timestamp,
    icao24: "4ca1fb",
    latitude,
    longitude,
    altitude_baro: altitudeBaro,
    ground_speed: groundSpeed,
    track: null,
    vertical_rate: null,
    callsign: "BAW117",
    is_on_ground: null,
    registration: "G-STBA",
    aircraft_type: "B77W",
    gps_spoofed: null,
  };
}

describe("trackStats", () => {
  const track: HistoryPosition[] = [
    position("2026-08-12T10:20:00", 40.9, -74.2, 30000, 480),
    position("2026-08-12T10:10:00", 40.8, -74.1, 20000, 420),
    position("2026-08-12T10:00:00", 40.7, -74.0, 1000, 180),
  ];

  it("sums the distance along the track", () => {
    const stats = trackStats(track);
    const expected = haversineKm(40.9, -74.2, 40.8, -74.1) + haversineKm(40.8, -74.1, 40.7, -74.0);
    expect(stats.distanceKm).toBeCloseTo(expected, 9);
    expect(stats.distanceNm).toBeCloseTo(expected / 1.852, 9);
    expect(stats.pointCount).toBe(3);
  });

  it("takes the duration from the extreme timestamps, whatever the order", () => {
    // history.track() returns positions newest first.
    const stats = trackStats(track);
    expect(stats.durationSeconds).toBe(1200);
    expect(stats.start).toBe("2026-08-12T10:00:00");
    expect(stats.end).toBe("2026-08-12T10:20:00");
  });

  it("reports the altitude band and mean ground speed", () => {
    const stats = trackStats(track);
    expect(stats.maxAltitudeFt).toBe(30000);
    expect(stats.minAltitudeFt).toBe(1000);
    expect(stats.averageGroundSpeedKt).toBeCloseTo((480 + 420 + 180) / 3, 9);
  });

  it("skips points with no coordinates rather than counting them", () => {
    const stats = trackStats([
      ...track,
      position("2026-08-12T10:30:00", Number.NaN, Number.NaN, null, null),
    ]);
    expect(stats.pointCount).toBe(3);
  });

  it("handles an empty track and a single point", () => {
    const empty = trackStats([]);
    expect(empty.pointCount).toBe(0);
    expect(empty.distanceKm).toBe(0);
    expect(empty.durationSeconds).toBeNull();
    expect(empty.maxAltitudeFt).toBeNull();
    expect(empty.averageGroundSpeedKt).toBeNull();
    expect(empty.start).toBeNull();

    const single = trackStats([position("2026-08-12T10:00:00", 40.7, -74, 1000, 180)]);
    expect(single.pointCount).toBe(1);
    expect(single.distanceKm).toBe(0);
    expect(single.durationSeconds).toBeNull();
  });

  it("works on bare coordinate pairs too", () => {
    const stats = trackStats([
      [40.7, -74.0],
      [40.8, -74.1],
    ]);
    expect(stats.pointCount).toBe(2);
    expect(stats.distanceKm).toBeGreaterThan(0);
    expect(stats.averageGroundSpeedKt).toBeNull();
  });
});

describe("simplifyTrack", () => {
  it("drops the points that lie on the line and keeps the ends", () => {
    const straight = Array.from({ length: 21 }, (_, i) => ({
      latitude: 40 + i * 0.01,
      longitude: -74,
    }));
    const simplified = simplifyTrack(straight, { toleranceKm: 0.5 });
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toBe(straight[0]);
    expect(simplified[1]).toBe(straight[20]);
  });

  it("keeps a corner that exceeds the tolerance", () => {
    const corner = [
      { latitude: 40, longitude: -74 },
      { latitude: 40.5, longitude: -73.5 },
      { latitude: 41, longitude: -74 },
    ];
    expect(simplifyTrack(corner, { toleranceKm: 0.5 })).toHaveLength(3);
    expect(simplifyTrack(corner, { toleranceKm: 500 })).toHaveLength(2);
  });

  it("returns the original objects, not copies", () => {
    const points = [
      { latitude: 40, longitude: -74, callsign: "BAW117" },
      { latitude: 40.5, longitude: -73.5, callsign: "BAW117" },
      { latitude: 41, longitude: -74, callsign: "BAW117" },
    ];
    const simplified = simplifyTrack(points);
    expect(simplified[0]).toBe(points[0]);
    expect(simplified[0]?.callsign).toBe("BAW117");
  });

  it("drops points without coordinates and tolerates short inputs", () => {
    expect(simplifyTrack([])).toHaveLength(0);
    expect(simplifyTrack([{ latitude: 40, longitude: -74 }])).toHaveLength(1);
    expect(
      simplifyTrack([
        { latitude: 40, longitude: -74 },
        { latitude: null, longitude: null },
        { latitude: 41, longitude: -74 },
      ]),
    ).toHaveLength(2);
  });
});
