/**
 * `sky.routes` — which airports a callsign or an airline connects.
 *
 * ```ts
 * const route = await sky.routes.byCallsign("BAW117");
 * if (route.source === "vrs") console.log(route.departure_icao, "→", route.arrival_icao);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  AirportRoutesParams,
  AirportRoutesResponse,
  CallsignRoute,
  RoutePairsParams,
  RoutePairsResponse,
} from "../models/routes.js";
import { APIResource, encodePathParam } from "./base.js";

/** Route lookup endpoints. */
export class Routes extends APIResource {
  /**
   * Resolve a flight callsign to the airports it connects.
   *
   * The response is a **union discriminated by `source`**: an exact VRS match
   * (`source: "vrs"`) carries the specific `departure_icao`/`arrival_icao` pair,
   * while the airline-level fallback (`source: "airline_routes"`) carries the
   * carrier's whole published network and **no `callsign` field at all**. Narrow on
   * `source` before touching a branch-specific field.
   *
   * Responds 404 when neither dataset knows the callsign's airline prefix, and 503
   * while the route dataset is still loading (retried automatically).
   *
   * `GET /routes/callsign/{callsign}`
   *
   * @param callsign - Flight callsign, e.g. `"BAW117"`. Case-insensitive.
   */
  byCallsign(callsign: string, options?: RequestOptions): Promise<CallsignRoute> {
    return this.get(
      `/routes/callsign/${encodePathParam(callsign, "callsign")}`,
      undefined,
      options,
    );
  }

  /**
   * Every known route touching an airport, busiest first (most airlines served).
   *
   * The code may be IATA (`"MXP"`) or ICAO (`"LIMC"`) — ICAO is resolved to IATA
   * server-side, but `code` in the response echoes what was sent.
   *
   * `GET /routes/airport/{code}?direction&limit`
   *
   * @param code - Airport IATA (3 letters) or ICAO (4 letters) code.
   */
  byAirport(
    code: string,
    params: AirportRoutesParams = {},
    options?: RequestOptions,
  ): Promise<AirportRoutesResponse> {
    return this.get(
      `/routes/airport/${encodePathParam(code, "code")}`,
      { direction: params.direction, limit: params.limit },
      options,
    );
  }

  /**
   * Directed airport pairs with the carriers serving them, busiest first.
   *
   * Both filters are optional, but an unfiltered call walks the entire dataset —
   * pass at least `departure` or `arrival` unless you really want a global sample.
   *
   * `GET /routes/pairs?departure&arrival&limit`
   */
  pairs(params: RoutePairsParams = {}, options?: RequestOptions): Promise<RoutePairsResponse> {
    return this.get(
      "/routes/pairs",
      {
        departure: params.departure,
        arrival: params.arrival,
        limit: params.limit,
      },
      options,
    );
  }
}
