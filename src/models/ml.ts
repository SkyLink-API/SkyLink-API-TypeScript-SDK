/**
 * Machine-learning prediction models. Currently one product: gate-to-gate flight
 * time between two airports.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * Parameters of `ml.flightTime()`.
 *
 * `from` and `to` are the literal query-parameter names of the endpoint. They are
 * reserved words in some languages but perfectly valid property names in
 * TypeScript, so — following the "fields exactly as they appear on the wire" rule —
 * they are kept as-is rather than renamed to origin/destination.
 */
export interface FlightTimeParams {
  /** Origin airport, ICAO or IATA code, e.g. `"KJFK"` or `"JFK"`. */
  from: string;
  /** Destination airport, ICAO or IATA code, e.g. `"EGLL"` or `"LHR"`. */
  to: string;
  /** Aircraft type code, e.g. `"B738"`, `"A320"`, `"C172"`. Max 4 characters. */
  aircraft?: string;
}

/**
 * Response of `ml.flightTime()`.
 *
 * The shape is identical whether the trained model or the distance/speed fallback
 * produced the estimate — `model_version` is what tells the two apart.
 */
export interface FlightTimePrediction {
  /** Origin airport, resolved to its ICAO code. */
  origin: string;
  /** Destination airport, resolved to its ICAO code. */
  destination: string;
  /** Aircraft type the estimate was conditioned on, `null` when none was supplied. */
  aircraft_type: string | null;
  /** Great-circle distance in nautical miles. */
  distance_nm: number;
  /** Point estimate of gate-to-gate time, in minutes. */
  estimated_minutes: number;
  /** Human-readable rendering of `estimated_minutes`, e.g. `"7h 23m"`. */
  estimated_hours_display: string;
  /** Lower bound of the estimate, in minutes. */
  min_minutes: number;
  /** Upper bound of the estimate, in minutes. */
  max_minutes: number;
  /** Model artifact version, or the marker of the formula fallback. */
  model_version: string;
}
