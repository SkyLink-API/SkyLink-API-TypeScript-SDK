/**
 * `sky.ml` — machine-learning predictions.
 *
 * ```ts
 * const eta = await sky.ml.flightTime({ origin: "KJFK", destination: "EGLL", aircraft: "B772" });
 * console.log(eta.estimated_hours_display); // "6h 41m"
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  FlightTimeParams,
  FlightTimeParamsInput,
  FlightTimePrediction,
} from "../models/ml.js";
import { APIResource } from "./base.js";

/** ML prediction endpoints. */
export class Ml extends APIResource {
  /**
   * Predict gate-to-gate flight time between two airports.
   *
   * Both codes may be ICAO or IATA. Supplying `aircraft` conditions the estimate on
   * that type's cruise performance. When the trained model is unavailable the API
   * falls back to a distance/speed formula — the response shape is identical and
   * `model_version` identifies which produced it.
   *
   * The endpoint's own query keys are `from` and `to`; this method takes
   * `origin`/`destination` instead, matching `compose.routeBrief(origin,
   * destination)`, the Python SDK's `ml.flight_time(origin=, destination=)` and the
   * rest of this SDK's route vocabulary. The wire names are still accepted as
   * deprecated aliases so existing callers keep compiling.
   *
   * `GET /ml/flight-time?from&to&aircraft`
   *
   * @param params - Origin, destination and an optional aircraft type.
   */
  flightTime(
    params: FlightTimeParamsInput,
    options?: RequestOptions,
  ): Promise<FlightTimePrediction> {
    const { origin, destination } = normalizeRoute(params);
    return this.get(
      "/ml/flight-time",
      {
        from: origin,
        to: destination,
        aircraft: params.aircraft,
      },
      options,
    );
  }
}

/**
 * Read the route out of either spelling, preferring the documented one.
 *
 * A caller who somehow passes both wins with `origin`/`destination`: that is the
 * spelling this SDK documents, so it is the one that should decide.
 */
function normalizeRoute(params: FlightTimeParamsInput): FlightTimeParams {
  const origin =
    "origin" in params && params.origin ? params.origin : (params as { from?: string }).from;
  const destination =
    "destination" in params && params.destination
      ? params.destination
      : (params as { to?: string }).to;
  return {
    origin: origin ?? "",
    destination: destination ?? "",
    aircraft: params.aircraft,
  };
}
