/**
 * `sky.aircraft` — registry lookup by tail number or ICAO24, type performance
 * profiles and database statistics.
 *
 * ```ts
 * const result = await sky.aircraft.byRegistration("G-STBA");
 * if (result.found) console.log(result.aircraft.manufacturer_and_model);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  AircraftDatabaseStats,
  AircraftLookupParams,
  AircraftLookupResponse,
  AircraftPerformance,
} from "../models/aircraft.js";
import { APIResource, encodePathParam } from "./base.js";

/** Aircraft registry and performance endpoints. */
export class Aircraft extends APIResource {
  /**
   * Look up an airframe by registration (tail number).
   *
   * This endpoint **never** responds 404: a miss is an HTTP 200 carrying
   * `{ found: false, aircraft: null }`. Narrow on `found` before reading
   * `aircraft`.
   *
   * `GET /aircraft/registration/{registration}?photos`
   *
   * @param registration - Tail number, 2–10 characters, e.g. `"G-STBA"`, `"N12345"`.
   */
  byRegistration(
    registration: string,
    params: AircraftLookupParams = {},
    options?: RequestOptions,
  ): Promise<AircraftLookupResponse> {
    return this.get(
      `/aircraft/registration/${encodePathParam(registration, "registration")}`,
      { photos: params.photos },
      options,
    );
  }

  /**
   * Look up an airframe by ICAO 24-bit transponder address.
   *
   * Like {@link byRegistration}, a miss is an HTTP 200 with `found: false`.
   *
   * `GET /aircraft/icao24/{icao24}?photos`
   *
   * @param icao24 - Hex address, 4–6 characters, e.g. `"4CA1FB"`.
   */
  byIcao24(
    icao24: string,
    params: AircraftLookupParams = {},
    options?: RequestOptions,
  ): Promise<AircraftLookupResponse> {
    return this.get(
      `/aircraft/icao24/${encodePathParam(icao24, "icao24")}`,
      { photos: params.photos },
      options,
    );
  }

  /**
   * Performance profile of an aircraft **type**: cruise speed, ceiling, range,
   * dimensions and wake category.
   *
   * The data is scraped from public type registers, so every field of the response
   * is optional. Responds 404 for a type that is not in the register.
   *
   * `GET /aircraft/performance/{icao_type}`
   *
   * @param icaoType - ICAO type designator, 2–4 alphanumerics, e.g. `"B77W"`, `"A320"`.
   */
  performance(icaoType: string, options?: RequestOptions): Promise<AircraftPerformance> {
    return this.get(
      `/aircraft/performance/${encodePathParam(icaoType, "icaoType")}`,
      undefined,
      options,
    );
  }

  /**
   * Size and provenance of the registry snapshot backing the lookup endpoints.
   *
   * `GET /aircraft/database/stats`
   */
  databaseStats(options?: RequestOptions): Promise<AircraftDatabaseStats> {
    return this.get("/aircraft/database/stats", undefined, options);
  }
}
