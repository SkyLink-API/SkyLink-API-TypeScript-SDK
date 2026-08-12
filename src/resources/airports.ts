/**
 * `sky.airports` — airport lookup by code, plus search by coordinates, IP or free text.
 *
 * ```ts
 * const jfk = await sky.airports.search({ icao: "KJFK" });
 * console.log(jfk.runways.length, jfk.search_type);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  AirportSearchParams,
  AirportsByIpParams,
  AirportsByIpResponse,
  AirportsNearbyParams,
  AirportsNearbyResponse,
  AirportsTextSearchParams,
  AirportsTextSearchResponse,
  EnrichedAirport,
} from "../models/airports.js";
import { APIResource } from "./base.js";

/** Airport endpoints. */
export class Airports extends APIResource {
  /**
   * Full airport record for one code, enriched with runways, frequencies, navaids
   * and the country/region it belongs to.
   *
   * Supply exactly one of `icao` (4 letters) or `iata` (3 letters); the response
   * echoes which one was used in `search_type`.
   *
   * `GET /airports/search?icao=KJFK`
   *
   * @throws {NotFoundError} When no airport carries that code.
   */
  search(params: AirportSearchParams, options?: RequestOptions): Promise<EnrichedAirport> {
    return this.get(
      "/airports/search",
      {
        icao: params.icao,
        iata: params.iata,
      },
      options,
    );
  }

  /**
   * Airports within a radius of a coordinate pair, nearest first.
   *
   * `GET /airports/search/location?lat&lon&radius&type&limit`
   */
  nearby(params: AirportsNearbyParams, options?: RequestOptions): Promise<AirportsNearbyResponse> {
    return this.get(
      "/airports/search/location",
      {
        lat: params.lat,
        lon: params.lon,
        radius: params.radius,
        type: params.type,
        limit: params.limit,
      },
      options,
    );
  }

  /**
   * Airports near an IP address, geolocating the caller's own IP by default.
   *
   * A failed geolocation is not an error: the API answers 200 with `error` set and
   * no airports, so check `result.error` before reading `result.airports`.
   *
   * `GET /airports/search/ip?ip&radius&type&limit`
   */
  byIp(params: AirportsByIpParams = {}, options?: RequestOptions): Promise<AirportsByIpResponse> {
    return this.get(
      "/airports/search/ip",
      {
        ip: params.ip,
        radius: params.radius,
        type: params.type,
        limit: params.limit,
      },
      options,
    );
  }

  /**
   * Free-text airport search over names, cities, codes, countries and keywords,
   * ranked by `relevance_score`.
   *
   * `GET /airports/search/text?q&limit&type`
   */
  searchText(
    params: AirportsTextSearchParams,
    options?: RequestOptions,
  ): Promise<AirportsTextSearchResponse> {
    return this.get(
      "/airports/search/text",
      {
        q: params.q,
        limit: params.limit,
        type: params.type,
      },
      options,
    );
  }
}
