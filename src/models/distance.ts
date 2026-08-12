/**
 * Great-circle distance and bearing between two aviation waypoints.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/** Unit the distance is reported in: nautical miles, kilometers or statute miles. */
export type DistanceUnit = "nm" | "km" | "mi";

/**
 * A point on the route.
 *
 * The three identifier fields are populated only when the point was resolved from
 * an airport code; a computed midpoint or a raw lat/lon input leaves them `null`.
 */
export interface Coordinates {
  /** Decimal degrees. */
  latitude: number;
  /** Decimal degrees. */
  longitude: number;
  icao_code: string | null;
  iata_code: string | null;
  /** Airport or waypoint name. */
  name: string | null;
}

/** Response of `distance.calculate()`. */
export interface DistanceResponse {
  from_point: Coordinates;
  to_point: Coordinates;
  /** Great-circle distance, expressed in `unit`. */
  distance: number;
  unit: DistanceUnit;
  /** Initial bearing in degrees from true north (0–360). */
  bearing: number;
  /** Cardinal rendering of `bearing`, e.g. `"NE"`. */
  bearing_cardinal: string;
  /** Geographic midpoint of the great-circle route. */
  midpoint: Coordinates;
}

/** Origin given as an airport code. */
export interface DistanceFromAirport {
  /** Origin airport ICAO or IATA code, e.g. `"KJFK"` or `"JFK"`. */
  from_icao: string;
  from_lat?: never;
  from_lon?: never;
}

/** Origin given as raw coordinates. */
export interface DistanceFromCoordinates {
  /** Origin latitude in decimal degrees (-90 to 90). */
  from_lat: number;
  /** Origin longitude in decimal degrees (-180 to 180). */
  from_lon: number;
  from_icao?: never;
}

/** Destination given as an airport code. */
export interface DistanceToAirport {
  /** Destination airport ICAO or IATA code, e.g. `"EGLL"` or `"LHR"`. */
  to_icao: string;
  to_lat?: never;
  to_lon?: never;
}

/** Destination given as raw coordinates. */
export interface DistanceToCoordinates {
  /** Destination latitude in decimal degrees (-90 to 90). */
  to_lat: number;
  /** Destination longitude in decimal degrees (-180 to 180). */
  to_lon: number;
  to_icao?: never;
}

/** The `unit` selector, shared by every parameter combination. */
export interface DistanceUnitParam {
  /** Unit to report the distance in. Defaults to `"nm"`. */
  unit?: DistanceUnit;
}

/**
 * Parameters of `distance.calculate()`.
 *
 * Each endpoint of the route is specified independently, as either an airport code
 * or a lat/lon pair — mixing the two forms is allowed:
 *
 * ```ts
 * await sky.distance({ from_icao: "KJFK", to_icao: "EGLL" });
 * await sky.distance({ from_lat: 40.64, from_lon: -73.78, to_icao: "EGLL", unit: "km" });
 * ```
 */
export type DistanceParams = (DistanceFromAirport | DistanceFromCoordinates) &
  (DistanceToAirport | DistanceToCoordinates) &
  DistanceUnitParam;
