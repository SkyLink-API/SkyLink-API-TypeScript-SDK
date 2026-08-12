/**
 * Live ADS-B aircraft tracking models.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

import type { BBoxInput } from "./common.js";

/**
 * One aircraft in the live feed.
 *
 * Only `icao24`, `last_seen` and `first_seen` are always populated: an aircraft that
 * has transmitted an identification message but no position report yet comes back
 * with every positional and enrichment field `null`.
 */
export interface AdsbAircraft {
  /** ICAO 24-bit transponder address as hex, e.g. `"4ca1fb"`. */
  icao24: string;
  /** Flight callsign as broadcast, e.g. `"BAW117"`. */
  callsign: string | null;
  /** Decimal degrees. */
  latitude: number | null;
  /** Decimal degrees. */
  longitude: number | null;
  /** Barometric altitude in feet. */
  altitude: number | null;
  /** Ground speed in knots. */
  ground_speed: number | null;
  /** Track angle in degrees true (0–360). */
  track: number | null;
  /** Vertical rate in feet per minute; negative when descending. */
  vertical_rate: number | null;
  is_on_ground: boolean | null;
  /**
   * Last time the aircraft was observed.
   *
   * ISO 8601 **without** a `Z` suffix or offset — the API serializes a naive
   * timestamp here.
   */
  last_seen: string;
  /**
   * First time the aircraft was observed in the current tracking session.
   *
   * ISO 8601 without a `Z` suffix or offset.
   */
  first_seen: string;
  /** Tail number, when the aircraft database resolved one. */
  registration: string | null;
  /** Aircraft type or model, when resolved. */
  aircraft_type: string | null;
  /** Operating airline, when resolved. */
  airline: string | null;
  /** Thumbnail photo URL; only populated when `{ photos: true }` was requested. */
  photo_url: string | null;
}

/** Response of `adsb.aircraft()`. */
export interface AdsbAircraftResponse {
  /** The requested page of matching aircraft. */
  aircraft: AdsbAircraft[];
  /** Aircraft matching the filters **before** `limit`/`offset` are applied. */
  total_count: number;
  /** ISO 8601 without a `Z` suffix or offset. */
  timestamp: string;
}

/**
 * Altitude summary of the airborne aircraft currently tracked.
 *
 * Every field is optional: when nothing airborne is being tracked the API returns
 * an empty object rather than nulls.
 */
export interface AdsbAltitudeStats {
  /** Feet. */
  min_altitude?: number;
  /** Feet. */
  max_altitude?: number;
  /** Feet. */
  avg_altitude?: number;
}

/** Response of `adsb.statistics()`. */
export interface AdsbStatisticsResponse {
  /** Aircraft in the feed, including those without a position. */
  total_aircraft: number;
  /** Aircraft that have reported a latitude and longitude. */
  positioned_aircraft: number;
  on_ground: number;
  airborne: number;
  /** Empty object when no airborne aircraft reported an altitude. */
  altitude_stats: AdsbAltitudeStats;
  /** ISO 8601 without a `Z` suffix or offset. */
  timestamp: string;
}

/**
 * Health of the ADS-B ingestion pipeline.
 *
 * `connected_no_data` means the upstream feed is connected but silent; `degraded`
 * means the ingester is running while the feed connection is down.
 */
export type AdsbHealthStatus = "healthy" | "offline" | "connected_no_data" | "degraded";

/** Response of `adsb.health()`. */
export interface AdsbHealthResponse {
  status: AdsbHealthStatus;
  /** Whether the ingester currently holds a connection to the ADS-B hub. */
  connected: boolean;
  active_aircraft_count: number;
  /** Seconds the current connection has been up. Currently always `null`. */
  connection_uptime: number | null;
  /** ISO 8601 without a `Z` suffix or offset; `null` when nothing is being tracked. */
  last_message_received: string | null;
}

/**
 * Parameters of `adsb.aircraft()`.
 *
 * Filters combine with AND. `icao24` and `registration` are exact-match lookups that
 * collapse the result to at most one aircraft; `callsign` and `airline` are
 * case-insensitive substring matches.
 */
export interface AdsbAircraftParams {
  /** ICAO 24-bit address, exactly 6 hex characters. Case-insensitive. */
  icao24?: string;
  /** Callsign fragment, matched case-insensitively. */
  callsign?: string;
  /** Center latitude of a radius search (-90 to 90). Requires `lon` and `radius`. */
  lat?: number;
  /** Center longitude of a radius search (-180 to 180). Requires `lat` and `radius`. */
  lon?: number;
  /** Radius in **kilometers** (0–1000]. Requires `lat` and `lon`. */
  radius?: number;
  /** Bounding box, south-west corner first. */
  bbox?: BBoxInput;
  /** Minimum altitude in feet (0–60000). */
  min_alt?: number;
  /** Maximum altitude in feet (0–60000); must exceed `min_alt`. */
  max_alt?: number;
  /** Minimum ground speed in knots (0–1000). */
  min_speed?: number;
  /** Maximum ground speed in knots (0–1000); must exceed `min_speed`. */
  max_speed?: number;
  /** Exact tail number, matched case-insensitively. */
  registration?: string;
  /** Airline name fragment, matched case-insensitively. */
  airline?: string;
  /**
   * Populate `photo_url` from airport-data.com. Defaults to `false`.
   *
   * Noticeably slower, and capped at the first 50 aircraft of the page.
   */
  photos?: boolean;
  /**
   * Page size (minimum 1, **no upper bound**).
   *
   * Omit to receive the full matched set — which can run to five figures on the
   * live feed.
   */
  limit?: number;
  /** Aircraft to skip before the page starts. Defaults to `0`. */
  offset?: number;
}
