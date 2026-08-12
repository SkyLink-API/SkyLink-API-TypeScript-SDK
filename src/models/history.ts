/**
 * Historical ADS-B models: archived flights, position tracks and airport traffic.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

import type { HistoryPlan } from "../core/types.js";

export type { HistoryPlan } from "../core/types.js";

/** A date accepted by the history `start`/`end` filters; `Date` is serialized to ISO 8601 UTC. */
export type DateTimeInput = Date | string;

/** Traffic direction filter of `history.airportTraffic()`. */
export type TrafficDirection = "dep" | "arr" | "both";

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

/**
 * One archived flight.
 *
 * Four endpoints return a "flight" and each projects a different subset of the
 * underlying table: the search list (27 columns), the detail route (a superset with
 * `off_block_time`, `on_block_time`, `duration_source`, `arrival_distance_nm`,
 * `created_at`, `updated_at`), the companion array of a positions response (14) and
 * airport traffic (15). Rather than four near-identical types, this is one wide
 * shape with every field optional — check for the ones the endpoint you called
 * documents, and treat the rest as absent.
 *
 * A field can be missing (the endpoint does not project it) or present and `null`
 * (the column is empty), hence `?: T | null` throughout.
 */
export interface HistoryFlight {
  /** Flight UUID; feed it to `history.flight()` and `history.track()`. */
  flight_id?: string;
  /** ICAO24 transponder address, **upper-cased** in responses. */
  icao24?: string | null;
  /** ATC callsign, e.g. `"BAW117"`. */
  callsign?: string | null;
  /** Commercial flight number, e.g. `"BA117"`. */
  flight_number?: string | null;
  /** Registration / tail number, e.g. `"G-STBA"`. */
  tail_number?: string | null;
  aircraft_type_icao?: string | null;
  aircraft_type_name?: string | null;
  airline_icao?: string | null;
  airline_iata?: string | null;
  airline_name?: string | null;
  departure_airport_icao?: string | null;
  departure_airport_iata?: string | null;
  departure_airport_name?: string | null;
  arrival_airport_icao?: string | null;
  arrival_airport_iata?: string | null;
  arrival_airport_name?: string | null;
  /** Lifecycle state; only `ARCHIVED` rows are searchable. */
  flight_state?: string | null;
  /** ISO 8601 — first observation of the flight. */
  flight_start?: string | null;
  /** ISO 8601 — last observation of the flight. */
  flight_end?: string | null;
  /** ISO 8601 */
  takeoff_time?: string | null;
  /** ISO 8601 */
  landing_time?: string | null;
  /** ISO 8601 — detail route only. */
  off_block_time?: string | null;
  /** ISO 8601 — detail route only. */
  on_block_time?: string | null;
  /** Minutes. */
  flight_duration_min?: number | null;
  /** How the duration was derived — detail route only. */
  duration_source?: string | null;
  /** Nautical miles. */
  distance_nm?: number | null;
  /** Nautical miles remaining at the last fix — detail route only. */
  arrival_distance_nm?: number | null;
  /**
   * Confidence of the route reconstruction.
   *
   * The archive stores a **score** (`1`, `0.85`), not the `"high"` / `"low"` label
   * the `/routes` endpoints use — the union keeps both readable, since the column is
   * written by several matchers.
   */
  confidence?: string | number | null;
  /** Where the origin/destination pair came from, e.g. `"vrs_confirmed"`, `"adsb_track"`. */
  route_source?: string | null;
  gps_spoofing_suspected?: boolean | null;
  diversion_suspected?: boolean | null;
  /** ISO 8601 — detail route only. */
  created_at?: string | null;
  /** ISO 8601 — detail route only. */
  updated_at?: string | null;
}

/** Echo of the filters `history.flights()` actually applied. */
export interface HistoryFlightsFilters {
  /** Lower-cased ICAO24 that was queried, after resolving `registration`. */
  icao24: string | null;
  /** Registration as normalized by the API. */
  registration: string | null;
  /** ICAO24 the registration resolved to; `null` when the lookup failed. */
  resolved_icao24: string | null;
  callsign: string | null;
  departure_icao: string | null;
  arrival_icao: string | null;
}

/**
 * Response of `history.flights()`.
 *
 * An unknown `registration` is **not** an error: the API answers `200` with
 * `count: 0`, `flights: []` and an explanatory {@link HistoryFlightsResponse.note}.
 */
export interface HistoryFlightsResponse {
  filters: HistoryFlightsFilters;
  /** Number of rows in {@link HistoryFlightsResponse.flights}. There is no pagination. */
  count: number;
  /** Newest first. */
  flights: HistoryFlight[];
  /** Present only when the requested registration is unknown to the aircraft database. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * One ADS-B position snapshot, sampled roughly every 5 seconds.
 *
 * Note `altitude_baro` — the live ADS-B namespace calls the same quantity
 * `altitude`.
 */
export interface HistoryPosition {
  /** ISO 8601 */
  timestamp: string | null;
  /** ICAO24 address, **lower-cased** inside position rows. */
  icao24: string;
  latitude: number | null;
  longitude: number | null;
  /** Barometric altitude in feet. */
  altitude_baro: number | null;
  /** Knots. */
  ground_speed: number | null;
  /** Degrees true. */
  track: number | null;
  /** Feet per minute; negative when descending. */
  vertical_rate: number | null;
  callsign: string | null;
  is_on_ground: boolean | null;
  registration: string | null;
  /** Aircraft type ICAO code, e.g. `"B77W"`. */
  aircraft_type: string | null;
  gps_spoofed: boolean | null;
}

/** Response of `history.track()` — the positions of one specific flight. */
export interface HistoryTrackResponse {
  flight_id: string;
  /** ICAO24 address, **upper-cased** in this envelope. */
  icao24: string;
  callsign: string | null;
  /** Registration / tail number. */
  registration: string | null;
  aircraft_type_icao: string | null;
  departure_airport_icao: string | null;
  departure_airport_iata: string | null;
  arrival_airport_icao: string | null;
  arrival_airport_iata: string | null;
  /** ISO 8601 */
  takeoff_time: string | null;
  /** ISO 8601 */
  landing_time: string | null;
  count: number;
  /**
   * Newest first, bounded to the takeoff → landing window with a 5-minute pad on
   * each side.
   */
  positions: HistoryPosition[];
}

/**
 * Response of `history.positions()`, `history.positionsByIcao24()` and
 * `history.positionsByRegistration()`.
 */
export interface HistoryPositionsResponse {
  /** ICAO24 address, **upper-cased** in this envelope. */
  icao24: string;
  count: number;
  /** Newest first. */
  positions: HistoryPosition[];
  /**
   * Archived flights whose takeoff → landing window overlaps the queried range, so
   * segments of the track can be attributed to a flight. Capped at 50 rows.
   */
  flights: HistoryFlight[];
  /** Present only on the by-registration route, echoing the normalized registration. */
  registration?: string;
}

/** Response of `history.airportTraffic()`. */
export interface HistoryAirportTrafficResponse {
  /** Airport ICAO code, upper-cased by the API. */
  icao: string;
  direction: TrafficDirection;
  count: number;
  /** Newest first, by takeoff time for `dep` and landing time for `arr`. */
  flights: HistoryFlight[];
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Mixed into every history parameter bag. */
export interface HistoryPlanParams {
  /**
   * Data plan for this call, which selects the `/{plan}/history/...` path prefix and
   * with it the retention window and limit caps (ULTRA: 90 days; MEGA: 365 days).
   *
   * Falls back to the client's `historyPlan` option, and then to `"ultra"`.
   */
  plan?: HistoryPlan;
}

/**
 * Parameters of `history.flights()`.
 *
 * At least one of `icao24`, `registration`, `callsign`, `departure_icao`,
 * `arrival_icao` is required — the API answers 422 to a time-window-only search and
 * the SDK rejects it client-side.
 */
export interface HistoryFlightsParams extends HistoryPlanParams {
  /** Window start. Defaults to 24 h ago. */
  start?: DateTimeInput;
  /** Window end. Defaults to now. */
  end?: DateTimeInput;
  /** ICAO24 hex address; lower-cased before it is sent. */
  icao24?: string;
  /** Registration / tail number, resolved to an ICAO24 server side. */
  registration?: string;
  /** Exact callsign match, e.g. `"BAW117"`. */
  callsign?: string;
  departure_icao?: string;
  arrival_icao?: string;
  /** Max rows, newest first. ULTRA: default 100, max 1000. MEGA: default 200, max 2000. */
  limit?: number;
}

/** Parameters of `history.track()`. */
export interface HistoryTrackParams extends HistoryPlanParams {
  /** Max position rows. ULTRA: default 2000, max 5000. MEGA: default 5000, max 10000. */
  limit?: number;
}

/** Parameters of the `history.positions*()` methods. */
export interface HistoryPositionsParams extends HistoryPlanParams {
  /** Window start. Defaults to 24 h ago. */
  start?: DateTimeInput;
  /** Window end. Defaults to now. */
  end?: DateTimeInput;
  /** Max position rows. Default 1000; max 5000 (ULTRA) or 10000 (MEGA). */
  limit?: number;
}

/** Parameters of `history.airportTraffic()`. */
export interface HistoryAirportTrafficParams extends HistoryPlanParams {
  /** Departures, arrivals or both. Server-side default `"both"`. */
  direction?: TrafficDirection;
  /** Window start. Defaults to 24 h ago. */
  start?: DateTimeInput;
  /** Window end. Defaults to now. */
  end?: DateTimeInput;
  /** Max rows. ULTRA: default 100, max 1000. MEGA: default 200, max 2000. */
  limit?: number;
}
