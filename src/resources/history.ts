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

/**
 * Reject a flight search that carries no identifying filter.
 *
 * The API answers 422 to one; the SDK says so first, so an unfiltered search never
 * costs a round trip or a quota unit.
 *
 * @throws {SkyLinkError} When none of {@link REQUIRED_FLIGHT_FILTERS} is set.
 */
function assertFlightFilter(params: HistoryFlightsParams, caller: string): void {
  const hasFilter = REQUIRED_FLIGHT_FILTERS.some(
    (name) => params[name] !== undefined && params[name] !== null,
  );
  if (!hasFilter) {
    throw new SkyLinkError(
      `${caller} requires at least one filter: ${REQUIRED_FLIGHT_FILTERS.join(", ")}. ` +
        "Searching the whole archive by time window alone is not supported.",
    );
  }
}

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/** Window {@link History.iterFlights} slices with when the caller does not say. */
export const DEFAULT_ITER_WINDOW_DAYS = 7;

/**
 * Longest range each plan accepts in one request, enforced by the backend routers
 * (`_MAX_DAYS`): a wider `start`/`end` is a 422, not a truncated answer.
 *
 * This is the per-request cap, and also how far back {@link History.iterFlights}
 * defaults to when no `start` is given.
 */
export const HISTORY_MAX_WINDOW_DAYS: Readonly<Record<HistoryPlan, number>> = {
  ultra: 90,
  mega: 365,
};

/** Options of {@link History.iterFlights}. */
export interface IterFlightsOptions extends RequestOptions {
  /**
   * Width of each request's `start`/`end` window in days. Defaults to
   * {@link DEFAULT_ITER_WINDOW_DAYS}, clamped to the plan's maximum
   * ({@link HISTORY_MAX_WINDOW_DAYS}).
   *
   * Narrower windows cost more requests but are far less likely to hit the per-request
   * row cap (`limit`), which the API applies silently — a 90-day search that returns
   * exactly 1000 rows has almost certainly dropped some.
   */
  windowDays?: number;
  /** Stop after yielding this many flights. Unlimited by default. */
  maxItems?: number;
  /** Plan for every request of the walk; wins over `params.plan` and the client option. */
  plan?: HistoryPlan;
}

/**
 * Identity of an archived flight, for de-duplicating the overlap between windows.
 *
 * `flight_id` is the real key; the fallback exists because the positions and traffic
 * projections of the same row do not always carry it. A row with nothing identifying
 * at all is passed through rather than dropped.
 */
function flightKey(flight: HistoryFlight): string | null {
  if (typeof flight.flight_id === "string" && flight.flight_id !== "") return flight.flight_id;
  const parts = [flight.icao24, flight.callsign, flight.flight_start, flight.takeoff_time];
  if (!parts.some((part) => typeof part === "string" && part !== "")) return null;
  return `~${parts.map((part) => part ?? "").join("|")}`;
}

/** ISO 8601 without a zone designator — what the API itself emits and reads as UTC. */
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Epoch milliseconds of a `start`/`end` input.
 *
 * A string without an offset is read as **UTC**, matching the backend, rather than as
 * host-local time the way `new Date("2026-02-10T00:00:00")` would.
 */
function toEpochMs(value: DateTimeInput, name: string): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : Date.parse(NAIVE_ISO.test(value.trim()) ? `${value.trim().replace(" ", "T")}Z` : value);
  if (Number.isNaN(ms)) {
    throw new SkyLinkError(`Invalid ${name}: ${String(value)} is not a parseable date.`);
  }
  return ms;
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
    assertFlightFilter(params, "history.flights()");

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
   * Walk a long time range as one stream of flights, newest first.
   *
   * `history.flights()` has no pagination at all: it takes one window and returns at
   * most `limit` rows (1000 on ULTRA, 2000 on MEGA) with no signal that anything was
   * cut off, and refuses a window wider than the plan's retention (90 / 365 days) with
   * a 422. This iterator hides both: it slices `[start, end]` into `windowDays`-wide
   * requests and walks them from the newest backwards, de-duplicating the flights that
   * straddle a window boundary by `flight_id`.
   *
   * Same filter rule as {@link flights} — at least one of `icao24`, `registration`,
   * `callsign`, `departure_icao`, `arrival_icao`, checked **synchronously**, before any
   * request. `flight_state` is always `ARCHIVED` in this archive, so it is not a filter
   * worth having.
   *
   * With no `start`/`end` the range is the plan's whole retention window ending now:
   * 90 days on ULTRA, 365 on MEGA ({@link HISTORY_MAX_WINDOW_DAYS}).
   *
   * ```ts
   * for await (const flight of sky.history.iterFlights(
   *   { registration: "G-STBA", start: "2026-01-01T00:00:00Z" },
   *   { windowDays: 7, maxItems: 500 },
   * )) {
   *   console.log(flight.flight_id, flight.takeoff_time);
   * }
   * ```
   *
   * `GET /{plan}/history/flights?start&end&…` once per window.
   *
   * @throws {SkyLinkError} Synchronously, before any request, when no identifying
   * filter is supplied, when a date is unparseable, when `start` is not before `end`,
   * or when `windowDays`/`maxItems` are not usable numbers.
   */
  iterFlights(
    params: HistoryFlightsParams,
    options: IterFlightsOptions = {},
  ): AsyncGenerator<HistoryFlight, void, undefined> {
    const { windowDays, maxItems, plan, ...requestOptions } = options;
    assertFlightFilter(params, "history.iterFlights()");

    const effectivePlan: HistoryPlan = plan ?? params.plan ?? this.client.config.historyPlan;
    const maxWindowDays = HISTORY_MAX_WINDOW_DAYS[effectivePlan] ?? HISTORY_MAX_WINDOW_DAYS.ultra;

    const requested = windowDays ?? DEFAULT_ITER_WINDOW_DAYS;
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new SkyLinkError(
        `windowDays must be a positive number, received ${String(windowDays)}.`,
      );
    }
    // Wider than the plan allows is a guaranteed 422, so it is clamped rather than sent.
    const windowMs = Math.min(requested, maxWindowDays) * DAY_MS;

    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 0)) {
      throw new SkyLinkError(
        `maxItems must be a non-negative integer, received ${String(maxItems)}.`,
      );
    }

    const end = params.end === undefined ? Date.now() : toEpochMs(params.end, "end");
    const start =
      params.start === undefined ? end - maxWindowDays * DAY_MS : toEpochMs(params.start, "start");
    if (start >= end) {
      throw new SkyLinkError(
        `history.iterFlights() needs start before end, received start=${new Date(start).toISOString()} end=${new Date(end).toISOString()}.`,
      );
    }

    return this.walkFlights(params, effectivePlan, start, end, windowMs, maxItems, requestOptions);
  }

  /** Window walk behind {@link iterFlights}, split out so argument checks throw eagerly. */
  private async *walkFlights(
    params: HistoryFlightsParams,
    plan: HistoryPlan,
    start: number,
    end: number,
    windowMs: number,
    maxItems: number | undefined,
    options: RequestOptions,
  ): AsyncGenerator<HistoryFlight, void, undefined> {
    const seen = new Set<string>();
    let yielded = 0;
    let cursor = end;

    while (cursor > start && (maxItems === undefined || yielded < maxItems)) {
      const windowStart = Math.max(start, cursor - windowMs);
      const response = await this.flights(
        { ...params, plan, start: new Date(windowStart), end: new Date(cursor) },
        options,
      );

      for (const flight of response?.flights ?? []) {
        const key = flightKey(flight);
        if (key !== null) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        yield flight;
        yielded += 1;
        if (maxItems !== undefined && yielded >= maxItems) return;
      }

      cursor = windowStart;
    }
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
