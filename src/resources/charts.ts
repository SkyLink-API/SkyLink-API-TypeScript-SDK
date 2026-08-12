/**
 * `sky.charts` — aerodrome chart links from 90+ national AIP sources.
 *
 * ```ts
 * const result = await sky.charts.byAirport("KJFK");
 * for (const chart of result.charts.APP ?? []) console.log(chart.name, chart.url);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  ChartCategory,
  ChartSourcesResponse,
  ChartsParams,
  ChartsResponse,
} from "../models/charts.js";
import { APIResource, encodePathParam } from "./base.js";

/** Aerodrome chart endpoints. */
export class Charts extends APIResource {
  /**
   * Every chart published for an airport, grouped by category.
   *
   * The source is auto-detected from the ICAO prefix unless `source` overrides it.
   * `charts` is a partial map — categories with no charts are absent rather than
   * empty. Responds 404 when the airport is not covered by any source, or when its
   * source returned nothing.
   *
   * `GET /charts/{icao}?source`
   *
   * @param icao - ICAO airport code, 3–4 characters, e.g. `"KJFK"`.
   */
  byAirport(
    icao: string,
    params: ChartsParams = {},
    options?: RequestOptions,
  ): Promise<ChartsResponse> {
    return this.get(`/charts/${encodePathParam(icao, "icao")}`, { source: params.source }, options);
  }

  /**
   * Charts for one category only.
   *
   * The envelope is the same as {@link byAirport}, with `charts` holding at most
   * the requested key and `total_count` counting only it. Responds 404 when the
   * airport has no chart in that category.
   *
   * `GET /charts/{icao}/{category}?source`
   *
   * @param icao - ICAO airport code, 3–4 characters.
   * @param category - One of `GEN`, `GND`, `SID`, `STAR`, `APP`.
   */
  byCategory(
    icao: string,
    category: ChartCategory,
    params: ChartsParams = {},
    options?: RequestOptions,
  ): Promise<ChartsResponse> {
    return this.get(
      `/charts/${encodePathParam(icao, "icao")}/${encodePathParam(category, "category")}`,
      { source: params.source },
      options,
    );
  }

  /**
   * Supported chart sources and the ICAO prefixes each one covers — the values
   * accepted by the `source` override.
   *
   * `GET /charts/sources`
   */
  sources(options?: RequestOptions): Promise<ChartSourcesResponse> {
    return this.get("/charts/sources", undefined, options);
  }
}
