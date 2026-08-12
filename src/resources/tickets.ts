/**
 * `sky.tickets` — one-way ticket availability and pricing.
 *
 * ```ts
 * const results = await sky.tickets.search({ origin: "LHR", destination: "JFK" });
 * console.log(results.flights[0]?.price_usd, results.flights[0]?.stops);
 * ```
 */

import { formatDateYMD } from "../core/query.js";
import type { RequestOptions } from "../core/types.js";
import type { TicketSearchParams, TicketSearchResponse } from "../models/tickets.js";
import { APIResource } from "./base.js";

/** Flight-ticket endpoints. */
export class Tickets extends APIResource {
  /**
   * Search one-way ticket offers between two airports, cheapest first.
   *
   * `origin` and `destination` are three-letter **IATA** codes (`"LHR"`, not
   * `"EGLL"`) and must differ. `date` accepts a `Date` or a string and goes on the
   * wire as `YYYY-MM-DD`; omitting it lets the API default to seven days out.
   *
   * Offers are cached upstream for an hour, so two calls a few minutes apart return
   * identical prices.
   *
   * `GET /tickets/search?origin&destination&date&passengers`
   */
  search(params: TicketSearchParams, options?: RequestOptions): Promise<TicketSearchResponse> {
    return this.get(
      "/tickets/search",
      {
        origin: params.origin,
        destination: params.destination,
        date: params.date === undefined ? undefined : formatDateYMD(params.date),
        passengers: params.passengers,
      },
      options,
    );
  }
}
