/**
 * `sky.adsb` — live ADS-B aircraft tracking.
 *
 * ```ts
 * const feed = await sky.adsb.aircraft({ bbox: [51, -1, 52, 0], min_alt: 10000 });
 * console.log(feed.total_count, feed.aircraft[0]?.callsign);
 * ```
 */

import { formatBBox } from "../core/query.js";
import type { RequestOptions } from "../core/types.js";
import type {
  AdsbAircraftParams,
  AdsbAircraftResponse,
  AdsbHealthResponse,
  AdsbStatisticsResponse,
} from "../models/adsb.js";
import { APIResource } from "./base.js";

/** Live ADS-B aircraft tracking endpoints. */
export class Adsb extends APIResource {
  /**
   * Currently tracked aircraft, with optional filtering and pagination.
   *
   * All filters combine with AND. Pagination is opt-in: with neither `limit` nor
   * `offset` set the full matched set comes back, which on the live feed can be
   * five figures' worth of aircraft. `total_count` always reports the size of the
   * match before paging, so it can exceed `aircraft.length`.
   *
   * `GET /adsb/aircraft?icao24&callsign&lat&lon&radius&bbox&min_alt&max_alt&min_speed&max_speed&registration&airline&photos&limit&offset`
   */
  aircraft(
    params: AdsbAircraftParams = {},
    options?: RequestOptions,
  ): Promise<AdsbAircraftResponse> {
    return this.get(
      "/adsb/aircraft",
      {
        icao24: params.icao24,
        callsign: params.callsign,
        lat: params.lat,
        lon: params.lon,
        radius: params.radius,
        bbox: params.bbox === undefined ? undefined : formatBBox(params.bbox),
        min_alt: params.min_alt,
        max_alt: params.max_alt,
        min_speed: params.min_speed,
        max_speed: params.max_speed,
        registration: params.registration,
        airline: params.airline,
        photos: params.photos,
        limit: params.limit,
        offset: params.offset,
      },
      options,
    );
  }

  /**
   * Aggregate counts over the whole feed: how many aircraft are tracked, how many
   * have a position, and the altitude spread of the airborne ones.
   *
   * `altitude_stats` is an empty object when nothing airborne reported an altitude.
   *
   * `GET /adsb/aircraft/statistics`
   */
  statistics(options?: RequestOptions): Promise<AdsbStatisticsResponse> {
    return this.get("/adsb/aircraft/statistics", undefined, options);
  }

  /**
   * Health of the ADS-B ingestion pipeline — use it to tell "no aircraft match your
   * filters" apart from "the feed is down".
   *
   * `GET /adsb/health`
   */
  health(options?: RequestOptions): Promise<AdsbHealthResponse> {
    return this.get("/adsb/health", undefined, options);
  }
}
