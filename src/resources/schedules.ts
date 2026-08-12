/**
 * `sky.schedules` — airport departure and arrival boards.
 *
 * ```ts
 * const board = await sky.schedules.departures({ icao: "LIMC", date: new Date() });
 * for (const flight of board.flights) {
 *   console.log(flight.Time, flight.Destination, flight.Status);
 * }
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import { formatDateDMY, formatTimeHM } from "../core/query.js";
import type { QueryParams, RequestOptions } from "../core/types.js";
import type { ArrivalsResponse, DeparturesResponse, SchedulesParams } from "../models/schedules.js";
import { APIResource } from "./base.js";

/**
 * Turn the shared schedule parameters into a query bag.
 *
 * The API requires exactly one airport code, so zero or both is rejected here rather
 * than spending a request on a guaranteed 400. Dates are normalized to the
 * endpoint's `DD-MM-YYYY` / `HH:MM` wire formats; `ts` passes through untouched
 * because it is already the unix-millisecond integer the API expects.
 */
function buildScheduleQuery(params: SchedulesParams): QueryParams {
  const hasIcao = params.icao !== undefined && params.icao !== null;
  const hasIata = params.iata !== undefined && params.iata !== null;

  if (hasIcao && hasIata) {
    throw new SkyLinkError("Provide either icao or iata, not both.");
  }
  if (!hasIcao && !hasIata) {
    throw new SkyLinkError("Either icao or iata must be provided.");
  }

  return {
    icao: params.icao,
    iata: params.iata,
    date: params.date === undefined ? undefined : formatDateDMY(params.date),
    time: params.time === undefined ? undefined : formatTimeHM(params.time),
    ts: params.ts,
  };
}

/** Airport schedule endpoints. */
export class Schedules extends APIResource {
  /**
   * Departure board for an airport — roughly the next 12 hours by default.
   *
   * Pass `date` (plus optional `time`) or a raw `ts` to move the window; upstream
   * history reaches 5 days back and 1 day forward, and `ts` wins over `date`/`time`.
   *
   * Rows use **PascalCase** keys (`Time`, `Date`, `IATA`, `Destination`, `Flight`,
   * `Airline`, `Status`) — that is the wire format, kept verbatim.
   *
   * `GET /schedules/departures?icao|iata&date&time&ts`
   *
   * @param params - Exactly one of `icao` / `iata`, plus an optional time window.
   * @throws {SkyLinkError} When neither or both of `icao` / `iata` are supplied.
   */
  departures(params: SchedulesParams, options?: RequestOptions): Promise<DeparturesResponse> {
    return this.get("/schedules/departures", buildScheduleQuery(params), options);
  }

  /**
   * Arrival board for an airport — roughly the next 12 hours by default.
   *
   * Pass `date` (plus optional `time`) or a raw `ts` to move the window; upstream
   * history reaches 5 days back and 1 day forward, and `ts` wins over `date`/`time`.
   *
   * Rows use **PascalCase** keys and carry `Origin` where the departure board carries
   * `Destination`.
   *
   * `GET /schedules/arrivals?icao|iata&date&time&ts`
   *
   * @param params - Exactly one of `icao` / `iata`, plus an optional time window.
   * @throws {SkyLinkError} When neither or both of `icao` / `iata` are supplied.
   */
  arrivals(params: SchedulesParams, options?: RequestOptions): Promise<ArrivalsResponse> {
    return this.get("/schedules/arrivals", buildScheduleQuery(params), options);
  }
}
