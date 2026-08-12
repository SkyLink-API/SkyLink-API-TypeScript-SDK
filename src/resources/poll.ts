/**
 * `sky.poll` — the two endpoints worth asking again, wrapped in async generators.
 *
 * The API has no streaming and no webhooks for live positions, so "watch this" means
 * "call it on a timer". Both generators emit their first value **immediately**, then
 * wait `interval` between iterations, and both stop the way an async generator should:
 * the consumer `break`s, the `signal` aborts, or `maxIterations` runs out.
 *
 * ```ts
 * const controller = new AbortController();
 * for await (const status of sky.poll.flightStatus("BA123", { signal: controller.signal })) {
 *   console.log(status.status);          // only when something actually changed
 * }                                      // ends by itself once the flight has landed
 * ```
 */

import { APIStatusError, RateLimitError } from "../core/errors.js";
import type { RequestOptions } from "../core/types.js";
import type { AdsbAircraft, AdsbAircraftParams } from "../models/adsb.js";
import type {
  FlightStatusArrival,
  FlightStatusDeparture,
  FlightStatusResponse,
} from "../models/flight-status.js";
import type { AdsbDiff } from "../models/poll.js";
import { APIResource } from "./base.js";

/** Default gap between flight-status polls, in milliseconds. */
export const DEFAULT_FLIGHT_STATUS_INTERVAL_MS = 60_000;

/** Default gap between ADS-B polls, in milliseconds. */
export const DEFAULT_ADSB_INTERVAL_MS = 10_000;

/**
 * Status fragments that end a `flightStatus` poll when `untilTerminal` is on.
 *
 * Matched case-insensitively **as substrings**, because the upstream status is scraped
 * prose rather than an enum: `"Landed 14:32"`, `"Cancelled by airline"` and
 * `"Diverted to EINN"` all have to count.
 *
 * Both spellings of "cancel" are listed on purpose: the backend scrapes several
 * sources, so the British `"Cancelled"` and the American `"Canceled"` both occur, and
 * neither string contains the other.
 */
export const TERMINAL_FLIGHT_STATUSES = [
  "landed",
  "arrived",
  "cancelled",
  "canceled",
  "diverted",
] as const;

/** A `sleep` implementation; the second argument cuts the wait short. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Options shared by every `sky.poll` method. */
export interface PollOptions extends RequestOptions {
  /**
   * Delay between iterations in **milliseconds** (the Python SDK takes seconds here;
   * this SDK is milliseconds throughout, like `timeout`).
   *
   * The first iteration does not wait. The delay is measured between the end of one
   * request and the start of the next, so it is a floor on the interval, not a
   * schedule.
   */
  interval?: number;
  /**
   * Stop after this many iterations. Unlimited by default.
   *
   * A poll that failed with a survivable error (see below) counts as an iteration, so
   * this is also the bound on how long a broken upstream is retried.
   */
  maxIterations?: number;
  /**
   * Test seam: replaces the wait between iterations.
   * @internal
   */
  sleep?: SleepFn;
}

/** Options of {@link Poll.flightStatus}. */
export interface PollFlightStatusOptions extends PollOptions {
  /**
   * Emit only when something meaningful changed. Defaults to `true`.
   *
   * "Meaningful" is a deliberate whitelist rather than a deep comparison: the free-text
   * `status`, and each leg's times, dates, terminal, gate, check-in desk and baggage
   * belt. Identity fields (`flight_number`, `airline`, the airport names) are excluded
   * because they never change within a poll, and anything the API adds later is
   * excluded because unknown fields are exactly the ones that tend to carry
   * scrape timestamps — which would make every single poll look like a change.
   */
  changesOnly?: boolean;
  /**
   * Stop once the flight reaches a terminal status. Defaults to `true`.
   *
   * The terminal response is yielded first and the generator finishes after it, so the
   * consumer always sees the landing.
   *
   * @see TERMINAL_FLIGHT_STATUSES
   */
  untilTerminal?: boolean;
}

/**
 * Options of {@link Poll.adsb}.
 *
 * There is no `changesOnly` here: an unchanged feed still yields a diff (three empty
 * lists plus the snapshot), which is the tick a live map needs to know it is current.
 */
export type PollAdsbOptions = PollOptions;

/**
 * Wait `ms`, or until `signal` aborts — whichever happens first.
 *
 * Resolves either way (the caller decides what an abort means) and always removes its
 * listener, so a long-running poll cannot accumulate them on a caller-owned signal.
 * The timer is `unref`'d where the runtime supports it, so a generator abandoned
 * mid-wait does not hold a Node process open for the rest of the interval.
 */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();

    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Does this status text mean the flight is over?
 *
 * @see TERMINAL_FLIGHT_STATUSES
 */
export function isTerminalFlightStatus(status: string | null | undefined): boolean {
  if (typeof status !== "string") return false;
  const text = status.toLowerCase();
  return TERMINAL_FLIGHT_STATUSES.some((terminal) => text.includes(terminal));
}

/**
 * Errors a poller rides out instead of propagating: quota exhaustion and server-side
 * failures. Everything else — 401, 403, 404, 422, a bad `fetch` — is a problem that
 * will not fix itself on the next tick, so it reaches the caller.
 */
function isSurvivable(error: unknown): error is APIStatusError {
  if (error instanceof RateLimitError) return true;
  return error instanceof APIStatusError && error.status >= 500;
}

/** How long to wait after a survivable failure: the server's hint, or the poll interval. */
function backoffFor(error: APIStatusError, interval: number): number {
  const retryAfter = error instanceof RateLimitError ? error.retryAfter : null;
  return retryAfter !== null && retryAfter !== undefined ? retryAfter : interval;
}

/** The fields of a flight status a change is judged by. @see PollFlightStatusOptions.changesOnly */
function flightStatusKey(status: FlightStatusResponse): string {
  const departure: FlightStatusDeparture = status.departure ?? {};
  const arrival: FlightStatusArrival = status.arrival ?? {};
  return JSON.stringify([
    status.status,
    departure.scheduled_time,
    departure.scheduled_date,
    departure.actual_time,
    departure.actual_date,
    departure.terminal,
    departure.gate,
    departure.checkin,
    arrival.scheduled_time,
    arrival.scheduled_date,
    arrival.estimated_time,
    arrival.estimated_date,
    arrival.terminal,
    arrival.gate,
    arrival.baggage,
  ]);
}

/** Has this aircraft moved? @see AdsbDiff.updated */
function hasMoved(previous: AdsbAircraft, next: AdsbAircraft): boolean {
  return (
    previous.latitude !== next.latitude ||
    previous.longitude !== next.longitude ||
    previous.altitude !== next.altitude ||
    previous.ground_speed !== next.ground_speed
  );
}

function toSnapshot(aircraft: readonly AdsbAircraft[]): Map<string, AdsbAircraft> {
  const snapshot = new Map<string, AdsbAircraft>();
  for (const state of aircraft) {
    if (typeof state?.icao24 === "string") snapshot.set(state.icao24, state);
  }
  return snapshot;
}

/** Repeated calls to the two endpoints whose answers change while you watch them. */
export class Poll extends APIResource {
  /**
   * Poll one flight's status until it lands (or you stop asking).
   *
   * Yields immediately, then every `interval` milliseconds. With the defaults, only
   * actual changes are emitted and the generator finishes by itself once the status
   * turns terminal — so a bare `for await` over it is a complete "track this flight to
   * the gate" loop.
   *
   * `GET /flight_status/{flight_number}` once per iteration.
   *
   * ```ts
   * for await (const status of sky.poll.flightStatus("BA123", { interval: 30_000 })) {
   *   console.log(status.status, status.arrival.estimated_time);
   * }
   * ```
   *
   * @param flightNumber IATA (`"BA123"`) or ICAO (`"BAW123"`) flight number.
   * @throws {APIStatusError} On anything other than a 429 or a 5xx — those are waited
   * out and retried, since they say nothing about the flight.
   */
  async *flightStatus(
    flightNumber: string,
    options: PollFlightStatusOptions = {},
  ): AsyncGenerator<FlightStatusResponse, void, undefined> {
    const {
      interval = DEFAULT_FLIGHT_STATUS_INTERVAL_MS,
      maxIterations,
      changesOnly = true,
      untilTerminal = true,
      sleep = interruptibleSleep,
      ...requestOptions
    } = options;
    const signal = requestOptions.signal;

    let previousKey: string | null = null;

    for (let iteration = 0; maxIterations === undefined || iteration < maxIterations; iteration++) {
      if (signal?.aborted) return;

      let status: FlightStatusResponse;
      try {
        status = await this.client.flightStatus(flightNumber, requestOptions);
      } catch (error) {
        if (signal?.aborted) return;
        if (!isSurvivable(error)) throw error;
        await sleep(backoffFor(error, interval), signal);
        continue;
      }

      const key = flightStatusKey(status);
      const changed = key !== previousKey;
      previousKey = key;
      if (changed || !changesOnly) yield status;

      if (untilTerminal && isTerminalFlightStatus(status.status)) return;
      if (maxIterations !== undefined && iteration + 1 >= maxIterations) return;

      await sleep(interval, signal);
      if (signal?.aborted) return;
    }
  }

  /**
   * Poll the live ADS-B feed and yield what changed between snapshots.
   *
   * Takes the same filters as `sky.adsb.aircraft()` — pin them down (`bbox`, `lat`/
   * `lon`/`radius`) before pointing this at the live feed, or every tick pulls the
   * whole world. The first iteration is a baseline: `isFirst: true`, everything in
   * `appeared`. Every later iteration is a diff plus the full `snapshot`, so a map can
   * be redrawn from `snapshot` or patched from the three lists.
   *
   * `GET /adsb/aircraft` once per iteration.
   *
   * ```ts
   * const box = { bbox: [51, -1, 52, 0] } as const;
   * for await (const diff of sky.poll.adsb(box, { interval: 5_000, maxIterations: 10 })) {
   *   for (const state of diff.appeared) addMarker(state);
   *   for (const icao24 of diff.disappeared) removeMarker(icao24);
   *   for (const state of diff.updated) moveMarker(state);
   * }
   * ```
   *
   * @throws {APIStatusError} On anything other than a 429 or a 5xx.
   */
  async *adsb(
    params: AdsbAircraftParams = {},
    options: PollAdsbOptions = {},
  ): AsyncGenerator<AdsbDiff, void, undefined> {
    const {
      interval = DEFAULT_ADSB_INTERVAL_MS,
      maxIterations,
      sleep = interruptibleSleep,
      ...requestOptions
    } = options;
    const signal = requestOptions.signal;

    let previous: Map<string, AdsbAircraft> | null = null;

    for (let iteration = 0; maxIterations === undefined || iteration < maxIterations; iteration++) {
      if (signal?.aborted) return;

      let current: Map<string, AdsbAircraft>;
      try {
        const feed = await this.client.adsb.aircraft(params, requestOptions);
        current = toSnapshot(feed?.aircraft ?? []);
      } catch (error) {
        if (signal?.aborted) return;
        if (!isSurvivable(error)) throw error;
        await sleep(backoffFor(error, interval), signal);
        continue;
      }

      const appeared: AdsbAircraft[] = [];
      const updated: AdsbAircraft[] = [];
      const disappeared: string[] = [];

      for (const [icao24, state] of current) {
        const before = previous?.get(icao24);
        if (before === undefined) appeared.push(state);
        else if (hasMoved(before, state)) updated.push(state);
      }
      if (previous) {
        for (const icao24 of previous.keys()) {
          if (!current.has(icao24)) disappeared.push(icao24);
        }
      }

      yield {
        appeared,
        disappeared,
        updated,
        snapshot: Object.fromEntries(current),
        isFirst: previous === null,
      };
      previous = current;

      if (maxIterations !== undefined && iteration + 1 >= maxIterations) return;

      await sleep(interval, signal);
      if (signal?.aborted) return;
    }
  }
}
