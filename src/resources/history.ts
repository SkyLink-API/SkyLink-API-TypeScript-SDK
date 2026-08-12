/**
 * `sky.history` — archived ADS-B: flight search, per-flight detail and tracks,
 * raw position history and airport traffic.
 *
 * Every path is prefixed by the data plan (`/ultra/history/...` or
 * `/mega/history/...`). The plan is resolved per call: the `plan` parameter wins,
 * then the client's `historyPlan` option, and `"ultra"` is the final fallback. The
 * two plans expose the same routes and differ only in retention window and limit
 * caps.
 *
 * ```ts
 * const found = await sky.history.flights({ registration: "G-STBA", limit: 10 });
 * const track = await sky.history.track(found.flights[0]!.flight_id!);
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import { formatDateTimeISO } from "../core/query.js";
import type { HistoryPlan, RequestOptions } from "../core/types.js";
import type {
  DateTimeInput,
  HistoryAirportTrafficParams,
  HistoryAirportTrafficResponse,
  HistoryFlight,
  HistoryFlightsParams,
  HistoryFlightsResponse,
  HistoryPlanParams,
  HistoryPositionsParams,
  HistoryPositionsResponse,
  HistoryTrackParams,
  HistoryTrackResponse,
} from "../models/history.js";
import { APIResource, encodePathParam } from "./base.js";

/** An ICAO24 transponder address: exactly six hexadecimal characters. */
const ICAO24_PATTERN = /^[0-9a-fA-F]{6}$/;

/** The filters that satisfy the API's "at least one" requirement on `/flights`. */
const REQUIRED_FLIGHT_FILTERS = [
  "icao24",
  "registration",
  "callsign",
  "departure_icao",
  "arrival_icao",
] as const;

function toIso(value: DateTimeInput | undefined): string | undefined {
  return value === undefined ? undefined : formatDateTimeISO(value);
}

/** Historical ADS-B endpoints. */
export class History extends APIResource {
  /**
   * Path prefix for this call: `/ultra/history` or `/mega/history`.
   *
   * @param plan - Per-call override; falls back to the client's `historyPlan`.
   */
  private prefix(plan?: HistoryPlan): string {
    return `/${plan ?? this.client.config.historyPlan}/history`;
  }

  /**
   * Search archived flights.
   *
   * At least one of `icao24`, `registration`, `callsign`, `departure_icao`,
   * `arrival_icao` must be supplied — the API answers 422 otherwise, so the check
   * runs client-side and an unfiltered call never leaves the process. Supplying both
   * `icao24` and `registration` is allowed as long as they resolve to the same
   * aircraft.
   *
   * An unknown `registration` is **not** an error: the response comes back `200`
   * with `count: 0`, `flights: []` and a `note` explaining the miss.
   *
   * `GET /{plan}/history/flights?start&end&icao24&registration&callsign&departure_icao&arrival_icao&limit`
   *
   * @throws {SkyLinkError} When no identifying filter is supplied.
   */
  flights(params: HistoryFlightsParams, options?: RequestOptions): Promise<HistoryFlightsResponse> {
    const hasFilter = REQUIRED_FLIGHT_FILTERS.some(
      (name) => params[name] !== undefined && params[name] !== null,
    );
    if (!hasFilter) {
      throw new SkyLinkError(
        `history.flights() requires at least one filter: ${REQUIRED_FLIGHT_FILTERS.join(", ")}. ` +
          "Searching the whole archive by time window alone is not supported.",
      );
    }

    return this.get(
      `${this.prefix(params.plan)}/flights`,
      {
        start: toIso(params.start),
        end: toIso(params.end),
        icao24: params.icao24?.toLowerCase(),
        registration: params.registration,
        callsign: params.callsign,
        departure_icao: params.departure_icao,
        arrival_icao: params.arrival_icao,
        limit: params.limit,
      },
      options,
    );
  }

  /**
   * Full metadata for one flight.
   *
   * Returns a superset of the rows in {@link flights}: block times, the duration
   * source, the remaining arrival distance and the record timestamps.
   *
   * `GET /{plan}/history/flight/{flightId}`
   *
   * @param flightId - Flight UUID from {@link flights}.
   */
  flight(
    flightId: string,
    params: HistoryPlanParams = {},
    options?: RequestOptions,
  ): Promise<HistoryFlight> {
    return this.get(
      `${this.prefix(params.plan)}/flight/${encodePathParam(flightId, "flight id")}`,
      undefined,
      options,
    );
  }

  /**
   * Position track of one flight, auto-bounded to its takeoff → landing window
   * (padded by 5 minutes on each side).
   *
   * For an arbitrary time window regardless of flight boundaries, use
   * {@link positions} instead.
   *
   * `GET /{plan}/history/flight/{flightId}/track?limit`
   *
   * @param flightId - Flight UUID from {@link flights}.
   */
  track(
    flightId: string,
    params: HistoryTrackParams = {},
    options?: RequestOptions,
  ): Promise<HistoryTrackResponse> {
    return this.get(
      `${this.prefix(params.plan)}/flight/${encodePathParam(flightId, "flight id")}/track`,
      { limit: params.limit },
      options,
    );
  }

  /**
   * Position history of one aircraft, addressed by either identifier.
   *
   * `ident` is dispatched by shape: six hexadecimal characters are treated as an
   * ICAO24 address, anything else as a registration (which the API resolves to an
   * ICAO24 server side, answering 404 when it is unknown). Call
   * {@link positionsByIcao24} or {@link positionsByRegistration} directly when the
   * kind is known and the ambiguity is unwelcome.
   *
   * `GET /{plan}/history/positions/{icao24}` or
   * `GET /{plan}/history/positions/registration/{registration}`
   *
   * @param ident - ICAO24 hex address (e.g. `"4ca1fb"`) or registration (e.g. `"G-STBA"`).
   */
  positions(
    ident: string,
    params: HistoryPositionsParams = {},
    options?: RequestOptions,
  ): Promise<HistoryPositionsResponse> {
    return ICAO24_PATTERN.test(ident.trim())
      ? this.positionsByIcao24(ident, params, options)
      : this.positionsByRegistration(ident, params, options);
  }

  /**
   * Position history of one aircraft by ICAO24 transponder address.
   *
   * The address is lower-cased before it is sent; the response echoes it
   * upper-cased.
   *
   * `GET /{plan}/history/positions/{icao24}?start&end&limit`
   */
  positionsByIcao24(
    icao24: string,
    params: HistoryPositionsParams = {},
    options?: RequestOptions,
  ): Promise<HistoryPositionsResponse> {
    const segment = encodePathParam(icao24.toLowerCase(), "icao24");
    return this.get(
      `${this.prefix(params.plan)}/positions/${segment}`,
      {
        start: toIso(params.start),
        end: toIso(params.end),
        limit: params.limit,
      },
      options,
    );
  }

  /**
   * Position history of one aircraft by registration / tail number.
   *
   * The API resolves the registration to an ICAO24 and answers 404 when it is not in
   * the aircraft database. This is the only positions route whose response carries a
   * `registration` key.
   *
   * `GET /{plan}/history/positions/registration/{registration}?start&end&limit`
   */
  positionsByRegistration(
    registration: string,
    params: HistoryPositionsParams = {},
    options?: RequestOptions,
  ): Promise<HistoryPositionsResponse> {
    const segment = encodePathParam(registration, "registration");
    return this.get(
      `${this.prefix(params.plan)}/positions/registration/${segment}`,
      {
        start: toIso(params.start),
        end: toIso(params.end),
        limit: params.limit,
      },
      options,
    );
  }

  /**
   * Archived departures and/or arrivals for an airport.
   *
   * `GET /{plan}/history/airport/{icao}/traffic?start&end&direction&limit`
   *
   * @param icao - Four-letter airport ICAO code, e.g. `"EGLL"`.
   */
  airportTraffic(
    icao: string,
    params: HistoryAirportTrafficParams = {},
    options?: RequestOptions,
  ): Promise<HistoryAirportTrafficResponse> {
    return this.get(
      `${this.prefix(params.plan)}/airport/${encodePathParam(icao, "icao")}/traffic`,
      {
        start: toIso(params.start),
        end: toIso(params.end),
        direction: params.direction,
        limit: params.limit,
      },
      options,
    );
  }
}
