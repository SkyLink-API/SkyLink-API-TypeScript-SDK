/**
 * Geodesic helpers: bounding boxes, great-circle maths and track statistics.
 *
 * Two reasons this module exists. First, `adsb.aircraft()`, `weather.pireps()`,
 * `weather.windsAloft()` and `weather.airsigmet()` all take their area of interest
 * as the **string** `"lat1,lon1,lat2,lon2"` — every caller ends up gluing that
 * together by hand, usually forgetting to normalize the corners. Second, distances
 * along an ADS-B track do not need a round trip: `sky.distance()` costs quota and
 * only understands airport codes, while a track is just coordinates.
 *
 * All distances are kilometres unless the name says otherwise; all angles are
 * degrees. Pure functions — no client, no network, no state.
 */

import { type NumericInput, toNumber } from "./units.js";

/** Mean Earth radius in kilometres (IUGG mean radius, the value used by the API). */
export const EARTH_RADIUS_KM = 6371.0088;

/** Kilometres spanned by one degree of latitude on the sphere above. */
export const KM_PER_DEGREE_LAT = (EARTH_RADIUS_KM * Math.PI) / 180;

const KM_PER_NM = 1.852;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Trim float noise off a coordinate so bbox strings stay readable. */
function formatCoord(value: number): string {
  return String(Number(value.toFixed(6)));
}

// ---------------------------------------------------------------------------
// Point extraction
// ---------------------------------------------------------------------------

/**
 * Structural shape of anything that might carry a position.
 *
 * Deliberately not an index signature: this stays assignable from
 * {@link import("../models/history.js").HistoryPosition},
 * {@link import("../models/adsb.js").AdsbAircraft}, airport and navaid records and
 * plain objects, while keeping autocompletion useful.
 */
export interface PointObject {
  latitude?: NumericInput;
  longitude?: NumericInput;
  lat?: NumericInput;
  lon?: NumericInput;
  lng?: NumericInput;
  /** OurAirports and navaid records spell the columns out. */
  latitude_deg?: NumericInput;
  longitude_deg?: NumericInput;
  /** Live ADS-B altitude, feet. */
  altitude?: NumericInput;
  /** Archived ADS-B altitude, feet — the same quantity under a different name. */
  altitude_baro?: NumericInput;
  altitude_ft?: NumericInput;
  alt?: NumericInput;
  /** Knots. */
  ground_speed?: NumericInput;
  speed?: NumericInput;
  velocity?: NumericInput;
  /** ISO 8601 */
  timestamp?: string | null;
  /** ISO 8601 */
  time?: string | null;
  /** ISO 8601 */
  seen_at?: string | null;
  /** ISO 8601 */
  last_seen?: string | null;
}

/** A coordinate pair as `[latitude, longitude]`. */
export type LatLon = [latitude: number, longitude: number];

/** Anything {@link pointCoords} can read a position out of. */
export type PointLike = PointObject | readonly NumericInput[];

/**
 * Read a `[latitude, longitude]` pair out of whatever the caller has.
 *
 * Field names are tried in order: `latitude`/`longitude` (ADS-B, PIREPs),
 * `lat`/`lon` (AIR/SIGMET coords), `lat`/`lng`, `latitude_deg`/`longitude_deg`
 * (OurAirports rows), then index `0`/`1` for bare pairs. Values are coerced with
 * {@link toNumber}, so string coordinates are fine.
 *
 * @param point A model instance, a plain object or a `[lat, lon]` pair.
 * @returns `[latitude, longitude]` in degrees, or `null` when no usable pair was found.
 */
export function pointCoords(point: PointLike | null | undefined): LatLon | null {
  if (point === null || point === undefined) return null;

  if (Array.isArray(point)) {
    const pair = point as readonly NumericInput[];
    const lat = toNumber(pair[0]);
    const lon = toNumber(pair[1]);
    return lat === null || lon === null ? null : [lat, lon];
  }

  const obj = point as PointObject;
  const candidates: ReadonlyArray<readonly [NumericInput, NumericInput]> = [
    [obj.latitude, obj.longitude],
    [obj.lat, obj.lon],
    [obj.lat, obj.lng],
    [obj.latitude_deg, obj.longitude_deg],
  ];
  for (const [rawLat, rawLon] of candidates) {
    const lat = toNumber(rawLat);
    const lon = toNumber(rawLon);
    if (lat !== null && lon !== null) return [lat, lon];
  }
  return null;
}

function pointAltitudeFt(point: PointLike): number | null {
  if (Array.isArray(point)) return null;
  const obj = point as PointObject;
  for (const raw of [obj.altitude, obj.altitude_baro, obj.altitude_ft, obj.alt]) {
    const value = toNumber(raw);
    if (value !== null) return value;
  }
  return null;
}

function pointSpeedKt(point: PointLike): number | null {
  if (Array.isArray(point)) return null;
  const obj = point as PointObject;
  for (const raw of [obj.ground_speed, obj.speed, obj.velocity]) {
    const value = toNumber(raw);
    if (value !== null) return value;
  }
  return null;
}

function pointTimestamp(point: PointLike): string | null {
  if (Array.isArray(point)) return null;
  const obj = point as PointObject;
  for (const raw of [obj.timestamp, obj.time, obj.seen_at, obj.last_seen]) {
    if (typeof raw === "string" && raw.trim() !== "") return raw;
  }
  return null;
}

/**
 * Epoch milliseconds of an API timestamp.
 *
 * ADS-B timestamps are serialized **without** a `Z` suffix even though they are
 * UTC; left alone, the runtime would read them as local time. A naive ISO string
 * is therefore pinned to UTC before parsing.
 */
function toEpochMs(value: string): number | null {
  const text = value.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const parsed = Date.parse(naive ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

/** A bounding box with its corners named, as produced by {@link parseBbox}. */
export interface BBox {
  /** Minimum latitude. */
  south: number;
  /** Minimum longitude. */
  west: number;
  /** Maximum latitude. */
  north: number;
  /** Maximum longitude. */
  east: number;
}

/**
 * Build the `"lat1,lon1,lat2,lon2"` string the bbox parameters expect.
 *
 * The trap this exists for: every bbox-taking endpoint wants the **south-west**
 * corner first, and answers 400 (or, worse, an empty result) when the corners are
 * swapped. Any two opposite corners may be passed in any order — they are sorted
 * here.
 *
 * @returns `"south,west,north,east"`, ready to hand to `bbox:`.
 */
export function bbox(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const south = Math.min(lat1, lat2);
  const north = Math.max(lat1, lat2);
  const west = Math.min(lon1, lon2);
  const east = Math.max(lon1, lon2);
  return [south, west, north, east].map(formatCoord).join(",");
}

/**
 * Build a bbox string covering a square of `±radiusKm` around a point.
 *
 * Longitude degrees shrink with `cos(latitude)`, so a naive `radius / 111` on both
 * axes gives a box that is far too narrow near the equator and far too wide near
 * the poles. Latitude is clamped to ±90 and longitude to ±180 rather than wrapped:
 * the API does not accept an antimeridian-crossing box.
 *
 * @param lat Centre latitude in degrees.
 * @param lon Centre longitude in degrees.
 * @param radiusKm Half-width of the box in kilometres.
 */
export function bboxAround(lat: number, lon: number, radiusKm: number): string {
  const dLat = Math.abs(radiusKm) / KM_PER_DEGREE_LAT;
  const cosLat = Math.cos(toRad(clamp(lat, -90, 90)));
  const dLon =
    Math.abs(cosLat) < 1e-12 ? 180 : Math.abs(radiusKm) / (KM_PER_DEGREE_LAT * Math.abs(cosLat));
  return bbox(
    clamp(lat - dLat, -90, 90),
    clamp(lon - dLon, -180, 180),
    clamp(lat + dLat, -90, 90),
    clamp(lon + dLon, -180, 180),
  );
}

/**
 * Parse a bbox back into named corners, normalizing the order.
 *
 * Accepts the wire string `"lat1,lon1,lat2,lon2"`, the `[lat1, lon1, lat2, lon2]`
 * tuple the SDK takes for `bbox:` parameters, and an already-parsed {@link BBox}.
 * Useful for echoing a request back (responses return `bbox` as a string) or for
 * splitting an area into tiles.
 *
 * @throws TypeError when the value is not four finite numbers.
 */
export function parseBbox(value: string | readonly number[] | BBox): BBox {
  let parts: number[];

  if (typeof value === "string") {
    parts = value
      .split(",")
      .map((part) => toNumber(part))
      .filter((n): n is number => n !== null);
  } else if (Array.isArray(value)) {
    parts = (value as readonly number[])
      .map((part) => toNumber(part))
      .filter((n): n is number => n !== null);
  } else {
    const box = value as BBox;
    parts = [box.south, box.west, box.north, box.east]
      .map((part) => toNumber(part))
      .filter((n): n is number => n !== null);
  }

  const [a, b, c, d] = parts;
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  )
    throw new TypeError(
      `Invalid bounding box: expected four numbers as "lat1,lon1,lat2,lon2", got ${JSON.stringify(value)}`,
    );

  return {
    south: Math.min(a, c),
    west: Math.min(b, d),
    north: Math.max(a, c),
    east: Math.max(b, d),
  };
}

// ---------------------------------------------------------------------------
// Great-circle maths
// ---------------------------------------------------------------------------

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Use this instead of `sky.distance()` when you already have coordinates: the
 * endpoint only understands airport codes and costs a request against the quota.
 * Spherical model, `R = 6371.0088 km`, so expect up to ~0.5 % error against WGS-84.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle distance between two points, in nautical miles. */
export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) / KM_PER_NM;
}

/**
 * Initial bearing (forward azimuth) from the first point to the second, in degrees
 * true, normalized to `[0, 360)`.
 *
 * A great circle is not a straight line on a map: the bearing changes along the
 * route, so this is only the heading at the departure end.
 */
export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Point reached by travelling `distanceKm` from `(lat, lon)` along `bearingDeg`.
 *
 * Handy for building search areas around a fix, or for extrapolating an aircraft
 * position from its last `track` and `ground_speed`.
 *
 * @returns `[latitude, longitude]` in degrees; longitude is wrapped to `[-180, 180]`.
 */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceKm: number,
): LatLon {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(clamp(sinPhi2, -1, 1));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );

  return [toDeg(phi2), ((toDeg(lambda2) + 540) % 360) - 180];
}

/** Options of {@link greatCirclePoints}. */
export interface GreatCirclePointsOptions {
  /** How many points to emit, both ends included. Minimum 2, default 64. */
  count?: number;
}

/**
 * Sample a great circle between two points.
 *
 * Drawing a route as a straight two-point line on a Mercator map is wrong by
 * hundreds of kilometres on long legs — feed these intermediate points to the
 * polyline instead. The first and last entries are exactly the inputs.
 *
 * @returns `count` `[latitude, longitude]` pairs, evenly spaced along the arc.
 */
export function greatCirclePoints(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  options: GreatCirclePointsOptions = {},
): LatLon[] {
  const count = Math.max(2, Math.floor(options.count ?? 64));
  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);
  const delta = haversineKm(lat1, lon1, lat2, lon2) / EARTH_RADIUS_KM;

  if (delta < 1e-12) {
    return Array.from({ length: count }, () => [lat1, lon1] as LatLon);
  }

  const sinDelta = Math.sin(delta);
  const points: LatLon[] = [];
  for (let i = 0; i < count; i += 1) {
    const f = i / (count - 1);
    const a = Math.sin((1 - f) * delta) / sinDelta;
    const b = Math.sin(f * delta) / sinDelta;
    const x = a * Math.cos(phi1) * Math.cos(lambda1) + b * Math.cos(phi2) * Math.cos(lambda2);
    const y = a * Math.cos(phi1) * Math.sin(lambda1) + b * Math.cos(phi2) * Math.sin(lambda2);
    const z = a * Math.sin(phi1) + b * Math.sin(phi2);
    points.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Track statistics
// ---------------------------------------------------------------------------

/** Summary of a position track, as produced by {@link trackStats}. */
export interface TrackStats {
  /** Path length along the track, kilometres. */
  distanceKm: number;
  /** Path length along the track, nautical miles. */
  distanceNm: number;
  /** Seconds between the earliest and the latest timestamp, `null` when fewer than two are present. */
  durationSeconds: number | null;
  /** Highest reported altitude, feet. */
  maxAltitudeFt: number | null;
  /** Lowest reported altitude, feet. */
  minAltitudeFt: number | null;
  /** Mean of the reported ground speeds, knots. `null` when none were reported. */
  averageGroundSpeedKt: number | null;
  /** Points that carried usable coordinates. */
  pointCount: number;
  /** Earliest timestamp seen, verbatim as the API sent it. ISO 8601. */
  start: string | null;
  /** Latest timestamp seen, verbatim as the API sent it. ISO 8601. */
  end: string | null;
}

/**
 * Summarize a position track: distance flown, duration, altitude band, mean speed.
 *
 * Built for `history.track()` and `history.positions()`, both of which return
 * points **newest first** — the order does not matter here, since the duration is
 * taken from the extreme timestamps and the distance from consecutive pairs.
 * Points without coordinates (an aircraft heard but not located) are skipped, not
 * counted and not treated as a gap.
 *
 * Altitudes are feet, speeds knots, distances kilometres and nautical miles.
 *
 * @param points Any iterable of position-like objects or `[lat, lon]` pairs.
 */
export function trackStats(points: Iterable<PointLike>): TrackStats {
  let distanceKm = 0;
  let previous: LatLon | null = null;
  let pointCount = 0;
  let maxAltitudeFt: number | null = null;
  let minAltitudeFt: number | null = null;
  let speedSum = 0;
  let speedCount = 0;
  let startMs: number | null = null;
  let endMs: number | null = null;
  let start: string | null = null;
  let end: string | null = null;

  for (const point of points) {
    const coords = pointCoords(point);
    if (coords === null) continue;
    pointCount += 1;
    if (previous !== null) {
      distanceKm += haversineKm(previous[0], previous[1], coords[0], coords[1]);
    }
    previous = coords;

    const altitude = pointAltitudeFt(point);
    if (altitude !== null) {
      maxAltitudeFt = maxAltitudeFt === null ? altitude : Math.max(maxAltitudeFt, altitude);
      minAltitudeFt = minAltitudeFt === null ? altitude : Math.min(minAltitudeFt, altitude);
    }

    const speed = pointSpeedKt(point);
    if (speed !== null) {
      speedSum += speed;
      speedCount += 1;
    }

    const timestamp = pointTimestamp(point);
    if (timestamp !== null) {
      const ms = toEpochMs(timestamp);
      if (ms !== null) {
        if (startMs === null || ms < startMs) {
          startMs = ms;
          start = timestamp;
        }
        if (endMs === null || ms > endMs) {
          endMs = ms;
          end = timestamp;
        }
      }
    }
  }

  const durationSeconds =
    startMs !== null && endMs !== null && endMs !== startMs ? (endMs - startMs) / 1000 : null;

  return {
    distanceKm,
    distanceNm: distanceKm / KM_PER_NM,
    durationSeconds,
    maxAltitudeFt,
    minAltitudeFt,
    averageGroundSpeedKt: speedCount > 0 ? speedSum / speedCount : null,
    pointCount,
    start,
    end,
  };
}

// ---------------------------------------------------------------------------
// Track simplification
// ---------------------------------------------------------------------------

/** Perpendicular distance from `p` to the segment `a`–`b`, in kilometres. */
function perpendicularDistanceKm(p: LatLon, a: LatLon, b: LatLon): number {
  // Equirectangular projection around the segment: over a few hundred kilometres
  // the error is far below any sensible simplification tolerance.
  const lat0 = toRad((a[0] + b[0]) / 2);
  const x = (q: LatLon): number => toRad(q[1]) * Math.cos(lat0) * EARTH_RADIUS_KM;
  const y = (q: LatLon): number => toRad(q[0]) * EARTH_RADIUS_KM;

  const px = x(p);
  const py = y(p);
  const ax = x(a);
  const ay = y(a);
  const bx = x(b);
  const by = y(b);

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);

  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Options of {@link simplifyTrack}. */
export interface SimplifyTrackOptions {
  /** Maximum deviation the simplified line may have from the original, kilometres. Default `0.5`. */
  toleranceKm?: number;
}

/**
 * Thin out a track with the Ramer–Douglas–Peucker algorithm.
 *
 * A single `history.track()` call returns up to 10 000 points sampled every ~5
 * seconds; handing all of them to a map is what makes the map stutter. This keeps
 * the points that carry the shape of the route and drops the rest. The **original
 * objects** are returned, not copies, so their other fields survive.
 *
 * Points without coordinates are dropped, as they cannot be placed on the line.
 *
 * @param points Positions in order (either direction).
 * @param options `toleranceKm` — how far the simplified line may stray, default 0.5 km.
 */
export function simplifyTrack<T extends PointLike>(
  points: readonly T[],
  options: SimplifyTrackOptions = {},
): T[] {
  const tolerance = options.toleranceKm ?? 0.5;
  const kept: { item: T; coords: LatLon }[] = [];
  for (const item of points) {
    const coords = pointCoords(item);
    if (coords !== null) kept.push({ item, coords });
  }
  if (kept.length <= 2 || tolerance <= 0) return kept.map((entry) => entry.item);

  const keep = new Array<boolean>(kept.length).fill(false);
  keep[0] = true;
  keep[kept.length - 1] = true;

  const stack: [number, number][] = [[0, kept.length - 1]];
  while (stack.length > 0) {
    const segment = stack.pop();
    if (segment === undefined) break;
    const [first, last] = segment;
    const a = kept[first];
    const b = kept[last];
    if (a === undefined || b === undefined) continue;

    let farthest = -1;
    let maxDistance = 0;
    for (let i = first + 1; i < last; i += 1) {
      const entry = kept[i];
      if (entry === undefined) continue;
      const distance = perpendicularDistanceKm(entry.coords, a.coords, b.coords);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }

    if (farthest !== -1 && maxDistance > tolerance) {
      keep[farthest] = true;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  return kept.filter((_, index) => keep[index]).map((entry) => entry.item);
}
