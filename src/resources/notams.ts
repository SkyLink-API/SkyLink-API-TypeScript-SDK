/**
 * `sky.notams` — Notices to Air Missions for an airport, live from the FAA SWIM feed.
 *
 * ```ts
 * const { notams } = await sky.notams.byAirport("KJFK", {
 *   exclude_qcode: ["QK"],
 *   exclude_scope: ["FIR"],
 * });
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type { NotamsParams, NotamsResponse } from "../models/notams.js";
import { APIResource, encodePathParam } from "./base.js";

/** NOTAM endpoints. */
export class Notams extends APIResource {
  /**
   * NOTAMs filed for an airport (and, unless excluded, for its FIR).
   *
   * Only currently-active notices are returned by default; expired ones never are.
   * `exclude_qcode` and `exclude_scope` drop categories server-side, which is the
   * cheapest way to cut a large response — both accept an array or a ready-made CSV
   * string.
   *
   * `effective` and `expiration` come back as **opaque strings in one of two
   * formats** (the `[YY]YYMMDDHHMM` NOTAM date group, or ISO 8601) and are never
   * parsed by the SDK.
   *
   * `GET /notams/{icao}?exclude_qcode&exclude_scope&include_future`
   *
   * @param icao - Four-letter ICAO code, e.g. `"KJFK"`.
   */
  byAirport(
    icao: string,
    params: NotamsParams = {},
    options?: RequestOptions,
  ): Promise<NotamsResponse> {
    return this.get(
      `/notams/${encodePathParam(icao, "icao")}`,
      {
        exclude_qcode: params.exclude_qcode,
        exclude_scope: params.exclude_scope,
        include_future: params.include_future,
      },
      options,
    );
  }
}
