/**
 * `sky.carbon` — ICAO Doc 9988 CO₂ estimates for a flight.
 *
 * ```ts
 * const estimate = await sky.carbon.estimate({ callsign: "BAW117", include_rfi: true });
 * console.log(estimate.co2_kg_per_passenger, estimate.distance_source);
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import type { RequestOptions } from "../core/types.js";
import type { CarbonEstimate, CarbonEstimateParams } from "../models/carbon.js";
import { APIResource } from "./base.js";

/** Trim a filter, collapsing a blank value to `undefined` so it is dropped from the query. */
function trimFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Carbon emission endpoints. */
export class Carbon extends APIResource {
  /**
   * Estimate the CO₂ emissions of a flight.
   *
   * There are two ways to identify the flight and **one of them is required**:
   *
   * - `departure_icao` **and** `arrival_icao` — distance is the great-circle
   *   (haversine) distance between the two airports.
   * - `callsign` — the route is resolved from the VRS standing data and the distance
   *   comes from the most recent matching flight of the last seven days, falling
   *   back to haversine. Check `distance_source` to see which applied.
   *
   * Anything else (neither, or only one airport) is rejected here without a request,
   * because the API answers it with a 422.
   *
   * Passing `include_rfi` fills `co2_equivalent_kg_total` and
   * `co2_equivalent_kg_per_passenger`, which are `null` otherwise.
   *
   * `GET /carbon/estimate?departure_icao&arrival_icao&callsign&aircraft_type&passengers&include_rfi`
   *
   * @throws {SkyLinkError} When neither a callsign nor both airports are supplied.
   */
  estimate(params: CarbonEstimateParams, options?: RequestOptions): Promise<CarbonEstimate> {
    const callsign = trimFilter(params.callsign);
    const departure = trimFilter(params.departure_icao);
    const arrival = trimFilter(params.arrival_icao);

    if (!callsign && (!departure || !arrival)) {
      throw new SkyLinkError(
        "carbon.estimate() needs either 'callsign' or both 'departure_icao' and 'arrival_icao'.",
      );
    }

    return this.get(
      "/carbon/estimate",
      {
        departure_icao: departure,
        arrival_icao: arrival,
        callsign: callsign,
        aircraft_type: params.aircraft_type,
        passengers: params.passengers,
        include_rfi: params.include_rfi,
      },
      options,
    );
  }
}
