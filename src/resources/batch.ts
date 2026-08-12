/**
 * `sky.batch` — the same call for many identifiers, with a concurrency limit.
 *
 * Every method resolves to one entry per input string, keyed by the string **exactly
 * as it was passed**, holding either the response or the {@link SkyLinkError} that
 * call failed with. One unknown ICAO therefore costs you that airport, not the board.
 *
 * ```ts
 * const metars = await sky.batch.metars(["KJFK", "EGLL", "ZZZZ"]);
 * for (const [icao, result] of Object.entries(metars)) {
 *   if (isBatchError(result)) console.warn(icao, result.message);
 *   else console.log(icao, result.raw);
 * }
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import type { RequestOptions } from "../core/types.js";
import { type BatchResult, mapConcurrent } from "../helpers/batch.js";
import { classifyAirportCode } from "../helpers/idents.js";
import type { EnrichedAirport } from "../models/airports.js";
import type { FlightStatusResponse } from "../models/flight-status.js";
import type { NotamsResponse } from "../models/notams.js";
import type { MetarResponse, TafResponse } from "../models/weather.js";
import { APIResource } from "./base.js";

/** Per-call options of every `sky.batch` method. */
export interface BatchOptions extends RequestOptions {
  /**
   * Requests in flight at once. Defaults to 5, which is deliberately low: RapidAPI
   * enforces a per-second rate on top of the monthly quota, and a batch that trips it
   * spends its retry budget on `429`s. Must be a positive integer.
   */
  concurrency?: number;
}

/** Concurrency-limited fan-out over the single-item endpoints. */
export class Batch extends APIResource {
  /**
   * Run one request per unique key, keeping the caller's strings as the result keys.
   *
   * Duplicate inputs collapse into a single request. Only {@link SkyLinkError}s are
   * captured into the result — anything else is a bug in the SDK or in a caller's
   * `fetch`, and is rethrown rather than buried in a value.
   */
  private async run<T>(
    keys: Iterable<string>,
    call: (key: string, options: RequestOptions) => Promise<T>,
    options: BatchOptions,
  ): Promise<BatchResult<T>> {
    const { concurrency, ...requestOptions } = options;
    // Set preserves insertion order, which is the order the keys are requested in
    // and, below, the order they appear in the returned object.
    const unique = [...new Set(keys)];
    const settled = await mapConcurrent(unique, (key) => call(key, requestOptions), {
      concurrency,
      signal: requestOptions.signal,
    });

    const results: BatchResult<T> = {};
    for (const [index, key] of unique.entries()) {
      const value = settled[index] as T | Error;
      if (value instanceof Error && !(value instanceof SkyLinkError)) throw value;
      results[key] = value as T | SkyLinkError;
    }
    return results;
  }

  /**
   * Current METAR for each airport.
   *
   * `GET /weather/metar/{icao}` once per unique ICAO.
   *
   * @param icaos Four-letter ICAO codes. Keys are kept verbatim, so `"kjfk"` and
   * `"KJFK"` are two entries and two requests.
   */
  metars(icaos: Iterable<string>, options: BatchOptions = {}): Promise<BatchResult<MetarResponse>> {
    return this.run(
      icaos,
      (icao, requestOptions) => this.client.weather.metar(icao, {}, requestOptions),
      options,
    );
  }

  /**
   * Current TAF for each airport.
   *
   * `GET /weather/taf/{icao}` once per unique ICAO.
   */
  tafs(icaos: Iterable<string>, options: BatchOptions = {}): Promise<BatchResult<TafResponse>> {
    return this.run(
      icaos,
      (icao, requestOptions) => this.client.weather.taf(icao, {}, requestOptions),
      options,
    );
  }

  /**
   * Active NOTAMs for each airport.
   *
   * `GET /notams/{icao}` once per unique ICAO. This is the slowest endpoint in the
   * batch surface — the FAA SWIM query behind it regularly takes seconds — so raise
   * `timeout` rather than `concurrency` if a large board times out.
   */
  notams(
    icaos: Iterable<string>,
    options: BatchOptions = {},
  ): Promise<BatchResult<NotamsResponse>> {
    return this.run(
      icaos,
      (icao, requestOptions) => this.client.notams.byAirport(icao, {}, requestOptions),
      options,
    );
  }

  /**
   * Full airport record for each code.
   *
   * `GET /airports/search` once per unique code. The endpoint takes `icao` **or**
   * `iata` and rejects the wrong one, so each code is classified first: three letters
   * are sent as `iata`, anything else as `icao`.
   */
  airports(
    codes: Iterable<string>,
    options: BatchOptions = {},
  ): Promise<BatchResult<EnrichedAirport>> {
    return this.run(
      codes,
      (code, requestOptions) =>
        this.client.airports.search(
          classifyAirportCode(code) === "iata" ? { iata: code } : { icao: code },
          requestOptions,
        ),
      options,
    );
  }

  /**
   * Live status for each flight number.
   *
   * `GET /flight_status/{flight_number}` once per unique number. Unknown numbers
   * answer `404`, which lands in the result as a `NotFoundError` — a scheduled flight
   * that has not been published yet is indistinguishable from a typo here.
   */
  flightStatuses(
    flightNumbers: Iterable<string>,
    options: BatchOptions = {},
  ): Promise<BatchResult<FlightStatusResponse>> {
    return this.run(
      flightNumbers,
      (number, requestOptions) => this.client.flightStatus(number, requestOptions),
      options,
    );
  }
}
