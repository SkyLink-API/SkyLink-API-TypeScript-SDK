/**
 * `sky.navaids` — VOR, NDB, ILS, DME and TACAN records.
 *
 * ```ts
 * const { navaids, total } = await sky.navaids.list({ airport: "KJFK" });
 * console.log(total, navaids[0]?.usageType);
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import { formatBBox } from "../core/query.js";
import type { RequestOptions } from "../core/types.js";
import type { NavaidsListParams, NavaidsResponse } from "../models/navaids.js";
import { APIResource } from "./base.js";

/** The filters that satisfy the API's "at least one" requirement. */
const REQUIRED_FILTERS = ["ident", "airport", "type", "country", "bbox"] as const;

/** Navaid endpoints. */
export class Navaids extends APIResource {
  /**
   * Search navigation aids.
   *
   * At least one of `ident`, `airport`, `type`, `country` or `bbox` must be set:
   * the dataset holds ~70 000 navaids and the API refuses to return it unfiltered.
   * The check runs client-side, so an unfiltered call never leaves the process.
   *
   * `GET /navaids?ident&airport&type&country&bbox&limit`
   *
   * @throws {SkyLinkError} When no filter is supplied.
   */
  list(params: NavaidsListParams, options?: RequestOptions): Promise<NavaidsResponse> {
    const hasFilter = REQUIRED_FILTERS.some(
      (name) => params[name] !== undefined && params[name] !== null,
    );
    if (!hasFilter) {
      throw new SkyLinkError(
        `navaids.list() requires at least one filter: ${REQUIRED_FILTERS.join(", ")}. ` +
          "Returning the full navaid dataset unfiltered is not supported.",
      );
    }

    return this.get(
      "/navaids",
      {
        ident: params.ident,
        airport: params.airport,
        type: params.type,
        country: params.country,
        bbox: params.bbox === undefined ? undefined : formatBBox(params.bbox),
        limit: params.limit,
      },
      options,
    );
  }
}
