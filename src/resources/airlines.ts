/**
 * `sky.airlines` — the airline directory.
 *
 * ```ts
 * const [ba] = await sky.airlines.search({ iata: "BA" });
 * console.log(ba?.callsign, ba?.active);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type { Airline, AirlineSearchParams } from "../models/airlines.js";
import { APIResource } from "./base.js";

/** Airline endpoints. */
export class Airlines extends APIResource {
  /**
   * Airlines carrying a given code.
   *
   * Supply exactly one of `icao` (3 letters) or `iata` (2 letters). Codes are
   * reused over time, so the response is an array — usually with one element.
   *
   * `GET /airlines/search?iata=BA`
   *
   * @throws {NotFoundError} When no airline carries that code.
   */
  search(params: AirlineSearchParams, options?: RequestOptions): Promise<Airline[]> {
    return this.get(
      "/airlines/search",
      {
        icao: params.icao,
        iata: params.iata,
      },
      options,
    );
  }
}
