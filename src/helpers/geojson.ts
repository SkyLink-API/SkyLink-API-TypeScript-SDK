/**
 * RFC 7946 GeoJSON exporters for the list responses worth putting on a map.
 *
 * The output is plain objects — no dependency, nothing to install — and is accepted
 * as-is by Leaflet, Mapbox GL, MapLibre and deck.gl.
 *
 * **Coordinates are always `[longitude, latitude]`.** That is the single most
 * common GeoJSON bug: every model in this SDK names latitude first, GeoJSON wants
 * it second, and a swapped pair does not error — it silently puts London in the
 * Indian Ocean.
 *
 * `properties` are copied straight from the wire, keeping the API's own field names
 * (`icao24`, `ground_speed`, `usageType`), and `null`/`undefined` values are
 * dropped rather than emitted, so map styling expressions do not have to guard for
 * them. Records without usable coordinates are skipped.
 *
 * Pure functions — no client, no network, no state.
 */

import { type LatLon, type PointObject, pointCoords } from "./spatial.js";
import { type NumericInput, toNumber } from "./units.js";

/** A GeoJSON position: `[longitude, latitude]`, in that order. */
export type Position = [longitude: number, latitude: number];

/** A GeoJSON `Point` geometry. */
export interface PointGeometry {
  type: "Point";
  coordinates: Position;
}

/** A GeoJSON `LineString` geometry. */
export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}

/** The geometry kinds this module emits. */
export type Geometry = PointGeometry | LineStringGeometry;

/**
 * Feature properties.
 *
 * The index signature is deliberate here — unlike the response models, this is an
 * *output* format, and consumers routinely add their own styling keys to it.
 */
export type FeatureProperties = Record<string, string | number | boolean>;

/** A GeoJSON `Feature`. */
export interface Feature<G extends Geometry = Geometry> {
  type: "Feature";
  geometry: G;
  properties: FeatureProperties;
}

/** A GeoJSON `FeatureCollection`. */
export interface FeatureCollection<G extends Geometry = Geometry> {
  type: "FeatureCollection";
  features: Feature<G>[];
}

/** Anything that may be offered as a property value before the empty ones are dropped. */
type PropertyInput = string | number | boolean | null | undefined;

function properties(entries: ReadonlyArray<readonly [string, PropertyInput]>): FeatureProperties {
  const out: FeatureProperties = {};
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

function position(coords: LatLon): Position {
  // [lat, lon] in, [lon, lat] out — the whole reason this helper exists.
  return [coords[1], coords[0]];
}

function pointFeature(coords: LatLon, props: FeatureProperties): Feature<PointGeometry> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: position(coords) },
    properties: props,
  };
}

// ---------------------------------------------------------------------------
// Live ADS-B
// ---------------------------------------------------------------------------

/** Structural shape of a live ADS-B state vector. */
export interface AdsbStateLike extends PointObject {
  icao24?: string | null;
  callsign?: string | null;
  /** Degrees true. */
  track?: NumericInput;
  /** Feet per minute. */
  vertical_rate?: NumericInput;
  is_on_ground?: boolean | null;
  registration?: string | null;
  aircraft_type?: string | null;
  airline?: string | null;
  photo_url?: string | null;
}

/**
 * One `Point` feature per aircraft, for a live traffic layer.
 *
 * Aircraft that have been heard but not located — `latitude`/`longitude` `null`,
 * which is normal for an identification-only message — are skipped, since a
 * feature without a geometry is not valid GeoJSON.
 *
 * Properties: `icao24`, `callsign`, `altitude` (ft), `ground_speed` (kt), `track`
 * (degrees true), `vertical_rate` (ft/min), `is_on_ground`, `registration`,
 * `aircraft_type`, `airline`, `last_seen`, `photo_url` — whichever are present.
 */
export function adsbToGeojson(states: Iterable<AdsbStateLike>): FeatureCollection<PointGeometry> {
  const features: Feature<PointGeometry>[] = [];
  for (const state of states) {
    const coords = pointCoords(state);
    if (coords === null) continue;
    features.push(
      pointFeature(
        coords,
        properties([
          ["icao24", state.icao24],
          ["callsign", state.callsign?.trim() ?? null],
          ["altitude", toNumber(state.altitude)],
          ["ground_speed", toNumber(state.ground_speed)],
          ["track", toNumber(state.track)],
          ["vertical_rate", toNumber(state.vertical_rate)],
          ["is_on_ground", state.is_on_ground],
          ["registration", state.registration],
          ["aircraft_type", state.aircraft_type],
          ["airline", state.airline],
          ["last_seen", state.last_seen],
          ["photo_url", state.photo_url],
        ]),
      ),
    );
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Structural shape of one archived position row. */
export interface TrackPointLike extends PointObject {
  /** Degrees true. */
  track?: NumericInput;
  callsign?: string | null;
  is_on_ground?: boolean | null;
}

/** Structural shape of a `history.track()` envelope. */
export interface TrackEnvelopeLike {
  positions?: readonly TrackPointLike[] | null;
  flight_id?: string | null;
  icao24?: string | null;
  callsign?: string | null;
  registration?: string | null;
  aircraft_type_icao?: string | null;
  departure_airport_icao?: string | null;
  arrival_airport_icao?: string | null;
}

/** Options of {@link trackToGeojson}. */
export interface TrackToGeojsonOptions {
  /** Also emit one `Point` feature per position. Default `false`. */
  includePoints?: boolean;
}

function isIterable(value: unknown): value is Iterable<TrackPointLike> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Iterable<TrackPointLike>)[Symbol.iterator] === "function"
  );
}

/**
 * A `LineString` for a flight track, optionally with a `Point` per fix.
 *
 * Accepts either the `history.track()` envelope or a bare array of positions. The
 * points are emitted **in the order given** — `history.track()` returns them newest
 * first, so reverse the array if the line has to run departure → arrival (it looks
 * identical either way, but arrow decorators and animations follow the order).
 *
 * Fewer than two located positions produce an empty collection: a one-point
 * `LineString` is not valid GeoJSON.
 *
 * LineString properties: `flight_id`, `icao24`, `callsign`, `registration`,
 * `aircraft_type_icao`, `departure_airport_icao`, `arrival_airport_icao`,
 * `point_count`. Point properties: `timestamp`, `altitude_baro` (ft),
 * `ground_speed` (kt), `track`, `callsign`, `is_on_ground`.
 */
export function trackToGeojson(
  track: TrackEnvelopeLike | Iterable<TrackPointLike>,
  options: TrackToGeojsonOptions = {},
): FeatureCollection {
  const fromEnvelope = !isIterable(track);
  const envelope: TrackEnvelopeLike = fromEnvelope ? (track as TrackEnvelopeLike) : {};
  const rows: readonly TrackPointLike[] = fromEnvelope
    ? (envelope.positions ?? [])
    : [...(track as Iterable<TrackPointLike>)];

  const located: { row: TrackPointLike; coords: LatLon }[] = [];
  for (const row of rows) {
    const coords = pointCoords(row);
    if (coords !== null) located.push({ row, coords });
  }

  const features: Feature[] = [];
  if (located.length >= 2) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: located.map((entry) => position(entry.coords)),
      },
      properties: properties([
        ["flight_id", envelope.flight_id],
        ["icao24", envelope.icao24],
        ["callsign", envelope.callsign?.trim() ?? null],
        ["registration", envelope.registration],
        ["aircraft_type_icao", envelope.aircraft_type_icao],
        ["departure_airport_icao", envelope.departure_airport_icao],
        ["arrival_airport_icao", envelope.arrival_airport_icao],
        ["point_count", located.length],
      ]),
    });
  }

  if (options.includePoints) {
    for (const entry of located) {
      features.push(
        pointFeature(
          entry.coords,
          properties([
            ["timestamp", entry.row.timestamp],
            ["altitude_baro", toNumber(entry.row.altitude_baro)],
            ["ground_speed", toNumber(entry.row.ground_speed)],
            ["track", toNumber(entry.row.track)],
            ["callsign", entry.row.callsign?.trim() ?? null],
            ["is_on_ground", entry.row.is_on_ground],
          ]),
        ),
      );
    }
  }

  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Airports and navaids
// ---------------------------------------------------------------------------

/** Structural shape of an airport row, in any of the shapes the API returns one. */
export interface AirportLike extends PointObject {
  ident?: string | null;
  name?: string | null;
  type?: string | null;
  /** Feet above mean sea level. */
  elevation_ft?: NumericInput;
  iata_code?: string | null;
  icao_code?: string | null;
  municipality?: string | null;
  iso_country?: string | null;
  iso_region?: string | null;
  /** Present on `airports.nearby()` rows. */
  distance_km?: NumericInput;
  /** Present on `airports.searchText()` rows. */
  relevance_score?: NumericInput;
}

/**
 * One `Point` feature per airport.
 *
 * Works with every airport shape the API returns — the enriched `airports.search()`
 * record, the `airports.nearby()` row (whose `distance_km` is carried through) and
 * the text-search row. Rows whose `latitude_deg`/`longitude_deg` are `null`, which
 * the OurAirports dataset does contain, are skipped.
 *
 * Properties: `ident`, `name`, `type`, `iata_code`, `icao_code`, `municipality`,
 * `iso_country`, `iso_region`, `elevation_ft` (ft MSL), `distance_km`,
 * `relevance_score`.
 */
export function airportsToGeojson(
  airports: Iterable<AirportLike>,
): FeatureCollection<PointGeometry> {
  const features: Feature<PointGeometry>[] = [];
  for (const airport of airports) {
    const coords = pointCoords(airport);
    if (coords === null) continue;
    features.push(
      pointFeature(
        coords,
        properties([
          ["ident", airport.ident],
          ["name", airport.name],
          ["type", airport.type],
          ["iata_code", airport.iata_code],
          ["icao_code", airport.icao_code],
          ["municipality", airport.municipality],
          ["iso_country", airport.iso_country],
          ["iso_region", airport.iso_region],
          ["elevation_ft", toNumber(airport.elevation_ft)],
          ["distance_km", toNumber(airport.distance_km)],
          ["relevance_score", toNumber(airport.relevance_score)],
        ]),
      ),
    );
  }
  return { type: "FeatureCollection", features };
}

/** Structural shape of a navaid row. */
export interface NavaidLike extends PointObject {
  ident?: string | null;
  name?: string | null;
  type?: string | null;
  /** Feet above mean sea level. */
  elevation_ft?: NumericInput;
  /** Kilohertz — `115900` is 115.9 MHz. */
  frequency_khz?: NumericInput;
  dme_frequency_khz?: NumericInput;
  dme_channel?: string | null;
  iso_country?: string | null;
  /** The one camelCase field in the whole API — kept as sent. */
  usageType?: string | null;
  power?: string | null;
  associated_airport?: string | null;
}

/**
 * One `Point` feature per navaid.
 *
 * Properties keep the API's own names, including `usageType` — the single camelCase
 * field the API emits, renaming which would break a join back to the response.
 * `frequency_khz` is kilohertz and may arrive as a string in the enriched-airport
 * form, so it is coerced.
 */
export function navaidsToGeojson(navaids: Iterable<NavaidLike>): FeatureCollection<PointGeometry> {
  const features: Feature<PointGeometry>[] = [];
  for (const navaid of navaids) {
    const coords = pointCoords(navaid);
    if (coords === null) continue;
    features.push(
      pointFeature(
        coords,
        properties([
          ["ident", navaid.ident],
          ["name", navaid.name],
          ["type", navaid.type],
          ["frequency_khz", toNumber(navaid.frequency_khz)],
          ["dme_frequency_khz", toNumber(navaid.dme_frequency_khz)],
          ["dme_channel", navaid.dme_channel],
          ["elevation_ft", toNumber(navaid.elevation_ft)],
          ["iso_country", navaid.iso_country],
          ["usageType", navaid.usageType],
          ["power", navaid.power],
          ["associated_airport", navaid.associated_airport],
        ]),
      ),
    );
  }
  return { type: "FeatureCollection", features };
}
