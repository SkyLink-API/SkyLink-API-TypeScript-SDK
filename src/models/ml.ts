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
 * The endpoint's own query keys are `from` and `to`; this SDK names them
 * `origin`/`destination`. The "fields exactly as they appear on the wire" rule
 * governs **response** fields — for a route, every other entry point in both SDKs
 * already says origin/destination (`compose.routeBrief(origin, destination)`,
 * Python's `ml.flight_time(origin=, destination=)`), and one endpoint spelling it
 * differently is a divergence, not fidelity. The wire names are still accepted:
 * see {@link FlightTimeParamsLegacy}.
 */
export interface FlightTimeParams {
  /** Origin airport, ICAO or IATA code, e.g. `"KJFK"` or `"JFK"`. */
  origin: string;
  /** Destination airport, ICAO or IATA code, e.g. `"EGLL"` or `"LHR"`. */
  destination: string;
  /** Aircraft type code, e.g. `"B738"`, `"A320"`, `"C172"`. Max 4 characters. */
  aircraft?: string;
}

/**
 * The pre-0.2 spelling of {@link FlightTimeParams}, kept so existing callers
 * compile unchanged.
 *
 * @deprecated Use `origin`/`destination`. `from`/`to` are the endpoint's query
 * keys, not this SDK's vocabulary, and they disagree with every other route
 * method.
 */
export interface FlightTimeParamsLegacy {
  /** @deprecated Renamed to `origin`. */
  from: string;
  /** @deprecated Renamed to `destination`. */
  to: string;
  /** Aircraft type code, e.g. `"B738"`, `"A320"`, `"C172"`. Max 4 characters. */
  aircraft?: string;
}

/** What `ml.flightTime()` accepts: the current names, or the deprecated ones. */
export type FlightTimeParamsInput = FlightTimeParams | FlightTimeParamsLegacy;

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
