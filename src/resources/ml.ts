/**
 * `sky.ml` — machine-learning predictions.
 *
 * ```ts
 * const eta = await sky.ml.flightTime({ from: "KJFK", to: "EGLL", aircraft: "B772" });
 * console.log(eta.estimated_hours_display); // "6h 41m"
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type { FlightTimeParams, FlightTimePrediction } from "../models/ml.js";
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
   * The parameters are named `from` and `to` because those are the literal query
   * keys of the endpoint; both are valid TypeScript property names.
   *
   * `GET /ml/flight-time?from&to&aircraft`
   *
   * @param params - Origin (`from`), destination (`to`) and an optional aircraft type.
   */
  flightTime(params: FlightTimeParams, options?: RequestOptions): Promise<FlightTimePrediction> {
    return this.get(
      "/ml/flight-time",
      {
        from: params.from,
        to: params.to,
        aircraft: params.aircraft,
      },
      options,
    );
  }
}
