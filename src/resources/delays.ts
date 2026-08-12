/**
 * `sky.delays` — FAA National Airspace System delay alerts.
 *
 * ```ts
 * const nas = await sky.delays.faa();
 * for (const gdp of nas.ground_delays) console.log(gdp.airport, gdp.avg_delay);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type { FaaDelaysResponse } from "../models/delays.js";
import { APIResource, encodePathParam } from "./base.js";

/** FAA delay endpoints. US airports only. */
export class Delays extends APIResource {
  /**
   * Active FAA NAS delays — ground delay programs, ground stops, closures and
   * airspace flow programs.
   *
   * Without an argument the whole national picture comes back; with one, the
   * airport-scoped arrays are filtered to that field while
   * `airspace_flow_programs` stays unfiltered (a flow program covers an entire
   * ARTCC, not one airport).
   *
   * Durations and times in the response are prose strings such as
   * `"1 hour and 30 minutes"`, never numbers or ISO timestamps.
   *
   * `GET /delays/faa` · `GET /delays/faa/{icao}`
   *
   * @param icao - Optional four-letter ICAO code, e.g. `"KEWR"`.
   */
  faa(icao?: string, options?: RequestOptions): Promise<FaaDelaysResponse> {
    const path =
      icao === undefined ? "/delays/faa" : `/delays/faa/${encodePathParam(icao, "icao")}`;
    return this.get(path, undefined, options);
  }
}
