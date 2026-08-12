/**
 * `sky.adsb` — live ADS-B aircraft tracking.
 *
 * ```ts
 * const feed = await sky.adsb.aircraft({ bbox: [51, -1, 52, 0], min_alt: 10000 });
 * console.log(feed.total_count, feed.aircraft[0]?.callsign);
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import { formatBBox } from "../core/query.js";
import type { RequestOptions } from "../core/types.js";
import type {
  AdsbAircraft,
  AdsbAircraftParams,
  AdsbAircraftResponse,
  AdsbHealthResponse,
  AdsbStatisticsResponse,
} from "../models/adsb.js";
import { APIResource } from "./base.js";

/** Page size {@link Adsb.iterAircraft} uses when the caller does not pass one. */
export const DEFAULT_ITER_PAGE_SIZE = 100;

/**
 * Largest page {@link Adsb.iterAircraft} will request.
 *
 * `/adsb/aircraft` enforces `limit >= 1` and **no upper bound**, so a typo in a page
 * size is a five-figure response rather than a validation error. Larger values are
 * clamped to this ceiling; ask for the whole feed with a bare `adsb.aircraft()` if
 * that is really what you want.
 */
export const MAX_ITER_PAGE_SIZE = 1_000;

/** Options of {@link Adsb.iterAircraft}. */
export interface IterAircraftOptions extends RequestOptions {
  /**
   * Aircraft per request. Defaults to {@link DEFAULT_ITER_PAGE_SIZE}, clamped to
   * {@link MAX_ITER_PAGE_SIZE}. Must be a positive integer.
   */
  pageSize?: number;
  /** Stop after yielding this many aircraft. Unlimited by default. */
  maxItems?: number;
}

function resolvePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ITER_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1) {
    throw new SkyLinkError(`pageSize must be a positive integer, received ${String(value)}.`);
  }
  return Math.min(value, MAX_ITER_PAGE_SIZE);
}

function resolveMaxItems(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new SkyLinkError(`maxItems must be a non-negative integer, received ${String(value)}.`);
  }
  return value;
}

/** Live ADS-B aircraft tracking endpoints. */
export class Adsb extends APIResource {
  /**
   * Currently tracked aircraft, with optional filtering and pagination.
   *
   * All filters combine with AND. Pagination is opt-in: with neither `limit` nor
   * `offset` set the full matched set comes back, which on the live feed can be
   * five figures' worth of aircraft. `total_count` always reports the size of the
   * match before paging, so it can exceed `aircraft.length`.
   *
   * `GET /adsb/aircraft?icao24&callsign&lat&lon&radius&bbox&min_alt&max_alt&min_speed&max_speed&registration&airline&photos&limit&offset`
   */
  aircraft(
    params: AdsbAircraftParams = {},
    options?: RequestOptions,
  ): Promise<AdsbAircraftResponse> {
    return this.get(
      "/adsb/aircraft",
      {
        icao24: params.icao24,
        callsign: params.callsign,
        lat: params.lat,
        lon: params.lon,
        radius: params.radius,
        bbox: params.bbox === undefined ? undefined : formatBBox(params.bbox),
        min_alt: params.min_alt,
        max_alt: params.max_alt,
        min_speed: params.min_speed,
        max_speed: params.max_speed,
        registration: params.registration,
        airline: params.airline,
        photos: params.photos,
        limit: params.limit,
        offset: params.offset,
      },
      options,
    );
  }

  /**
   * Every aircraft matching the filters, one at a time, paging behind your back.
   *
   * `/adsb/aircraft` is the only paginated endpoint in the API. This walks it with
   * `limit`/`offset` and stops on the first short or empty page. Note that the live
   * feed moves under the cursor: aircraft that appear or drop out between pages can be
   * seen twice or missed, which is inherent to offset paging over live data and is why
   * a tight `bbox` beats a large `maxItems`.
   *
   * Both `limit` and `offset` of `params` are managed by the iterator: `offset` is
   * honoured as the starting point, `limit` is ignored in favour of `pageSize`.
   *
   * If the API ever stops honouring `offset` — answering the same page forever — the
   * iterator notices the repeated set of `icao24` addresses and finishes instead of
   * looping.
   *
   * ```ts
   * for await (const state of sky.adsb.iterAircraft({ bbox: [51, -1, 52, 0] }, { maxItems: 500 })) {
   *   console.log(state.icao24, state.callsign);
   * }
   * ```
   *
   * `GET /adsb/aircraft?…&limit&offset` once per page.
   *
   * @throws {SkyLinkError} Synchronously, before any request, when `pageSize` or
   * `maxItems` is not a usable integer.
   */
  iterAircraft(
    params: AdsbAircraftParams = {},
    options: IterAircraftOptions = {},
  ): AsyncGenerator<AdsbAircraft, void, undefined> {
    const { pageSize, maxItems, ...requestOptions } = options;
    return this.pageAircraft(
      params,
      resolvePageSize(pageSize),
      resolveMaxItems(maxItems),
      requestOptions,
    );
  }

  /** Paging loop behind {@link iterAircraft}, split out so argument checks throw eagerly. */
  private async *pageAircraft(
    params: AdsbAircraftParams,
    pageSize: number,
    maxItems: number | undefined,
    options: RequestOptions,
  ): AsyncGenerator<AdsbAircraft, void, undefined> {
    let offset = params.offset ?? 0;
    let yielded = 0;
    let previousPageKey: string | null = null;

    while (maxItems === undefined || yielded < maxItems) {
      const limit = maxItems === undefined ? pageSize : Math.min(pageSize, maxItems - yielded);
      const page = await this.aircraft({ ...params, limit, offset }, options);
      const batch = page?.aircraft ?? [];
      if (batch.length === 0) return;

      const pageKey = batch.map((state) => state.icao24).join(",");
      if (pageKey === previousPageKey) return;
      previousPageKey = pageKey;

      for (const state of batch) {
        yield state;
        yielded += 1;
        if (maxItems !== undefined && yielded >= maxItems) return;
      }

      // A short page is the last page: the endpoint always fills a page it can fill.
      if (batch.length < limit) return;
      offset += batch.length;
    }
  }

  /**
   * Aggregate counts over the whole feed: how many aircraft are tracked, how many
   * have a position, and the altitude spread of the airborne ones.
   *
   * `altitude_stats` is an empty object when nothing airborne reported an altitude.
   *
   * `GET /adsb/aircraft/statistics`
   */
  statistics(options?: RequestOptions): Promise<AdsbStatisticsResponse> {
    return this.get("/adsb/aircraft/statistics", undefined, options);
  }

  /**
   * Health of the ADS-B ingestion pipeline — use it to tell "no aircraft match your
   * filters" apart from "the feed is down".
   *
   * `GET /adsb/health`
   */
  health(options?: RequestOptions): Promise<AdsbHealthResponse> {
    return this.get("/adsb/health", undefined, options);
  }
}
