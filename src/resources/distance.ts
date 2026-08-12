/**
 * Great-circle distance and bearing between two aviation waypoints.
 *
 * Exposed on the client as the method `sky.distance(...)` rather than as a
 * namespace, since the resource has a single operation:
 *
 * ```ts
 * const leg = await sky.distance({ from_icao: "KJFK", to_icao: "EGLL", unit: "km" });
 * console.log(leg.distance, leg.bearing_cardinal);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type { DistanceParams, DistanceResponse } from "../models/distance.js";
import { APIResource } from "./base.js";

/** Distance and bearing endpoint. */
export class Distance extends APIResource {
  /**
   * Great-circle distance, initial bearing and midpoint between two points.
   *
   * Each endpoint of the route is given either as an airport code (ICAO or IATA)
   * or as a lat/lon pair; the two forms can be mixed within one call. A missing or
   * half-specified endpoint is rejected by the API with a 400, and an airport code
   * that resolves to nothing with a 404.
   *
   * `GET /distance?from_icao&to_icao&from_lat&from_lon&to_lat&to_lon&unit`
   */
  calculate(params: DistanceParams, options?: RequestOptions): Promise<DistanceResponse> {
    return this.get(
      "/distance",
      {
        from_icao: params.from_icao,
        to_icao: params.to_icao,
        from_lat: params.from_lat,
        from_lon: params.from_lon,
        to_lat: params.to_lat,
        to_lon: params.to_lon,
        unit: params.unit,
      },
      options,
    );
  }
}
