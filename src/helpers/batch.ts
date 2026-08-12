/**
 * A concurrency-limited `map` and the helpers for reading a batch result.
 *
 * The API has no bulk endpoint: a board of twenty airports is twenty METAR calls.
 * Firing them all at once is the obvious thing to write and the wrong thing to run —
 * RapidAPI quotas are per-second as well as per-month, so an unbounded `Promise.all`
 * turns half the batch into `429`s. {@link mapConcurrent} keeps a small fixed number
 * of calls in flight (five by default) and, unlike `Promise.all`, never abandons the
 * rest of the work because one item failed: failures are *returned*, in place, so a
 * partial answer stays usable.
 *
 * Pure functions — no client, no network, no state. `sky.batch` is the sugar built
 * on top of them.
 */

import { APIConnectionError, SkyLinkError } from "../core/errors.js";

/** Requests in flight at once when the caller does not say. Sized for RapidAPI quotas. */
export const DEFAULT_CONCURRENCY = 5;

/** Options of {@link mapConcurrent}. */
export interface MapConcurrentOptions {
  /**
   * Maximum number of `fn` calls running at the same time. Defaults to
   * {@link DEFAULT_CONCURRENCY}; must be a positive integer.
   */
  concurrency?: number;
  /**
   * Abort the run. Items not yet started resolve to an {@link APIConnectionError}
   * instead of calling `fn`; already-running calls are only interrupted if `fn`
   * itself honours the signal — `sky.batch` forwards it to the transport, which does.
   */
  signal?: AbortSignal;
}

/**
 * Result of a batch call: one entry per input string, in input order, holding either
 * the response or the error that call failed with.
 */
export type BatchResult<T> = Record<string, T | SkyLinkError>;

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new SkyLinkError(`Task threw a non-Error value: ${String(value)}`, { cause: value });
}

function abortError(signal: AbortSignal): APIConnectionError {
  return new APIConnectionError("Batch was aborted before this item started.", {
    cause: signal.reason,
  });
}

function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1) {
    throw new SkyLinkError(`concurrency must be a positive integer, received ${String(value)}.`);
  }
  return value;
}

/**
 * Map over `items` with at most `concurrency` calls in flight, collecting failures
 * instead of throwing them.
 *
 * The returned array is index-aligned with `items` — position `i` holds either the
 * value `fn(items[i], i)` resolved to, or the `Error` it rejected with. A thrown
 * non-`Error` value is wrapped in a {@link SkyLinkError} so every failure slot is an
 * `Error`. The promise itself only rejects on a bad `concurrency`.
 *
 * ```ts
 * const results = await mapConcurrent(icaos, (icao) => sky.weather.metar(icao), {
 *   concurrency: 3,
 * });
 * const ok = results.filter((r): r is MetarResponse => !(r instanceof Error));
 * ```
 *
 * @param items Anything iterable; consumed eagerly so the length is known up front.
 * @param fn Called once per item with the item and its index.
 * @throws {SkyLinkError} When `concurrency` is not a positive integer.
 */
export async function mapConcurrent<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => R | Promise<R>,
  options: MapConcurrentOptions = {},
): Promise<(R | Error)[]> {
  const concurrency = resolveConcurrency(options.concurrency);
  const list = Array.from(items);
  const results = new Array<R | Error>(list.length);
  const signal = options.signal;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      if (signal?.aborted) {
        results[index] = abortError(signal);
        continue;
      }
      try {
        results[index] = await fn(list[index] as T, index);
      } catch (error) {
        results[index] = toError(error);
      }
    }
  };

  const workers = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Whether a batch entry is the failure case.
 *
 * Narrows `T | SkyLinkError` to the error, so a `filter`/`if` over the values of a
 * {@link BatchResult} keeps its types.
 */
export function isBatchError(value: unknown): value is SkyLinkError {
  return value instanceof SkyLinkError;
}

/**
 * The entries of a batch result that succeeded, keyed as they were requested.
 *
 * ```ts
 * const results = await sky.batch.metars(["KJFK", "EGLL"]);
 * for (const [icao, metar] of Object.entries(successes(results))) console.log(icao, metar.raw);
 * ```
 */
export function successes<T>(results: BatchResult<T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(results)) {
    if (!isBatchError(value)) out[key] = value;
  }
  return out;
}

/** The entries of a batch result that failed, keyed as they were requested. */
export function failures<T>(results: BatchResult<T>): Record<string, SkyLinkError> {
  const out: Record<string, SkyLinkError> = {};
  for (const [key, value] of Object.entries(results)) {
    if (isBatchError(value)) out[key] = value;
  }
  return out;
}

/**
 * Turn a partially-failed batch back into an all-or-nothing call.
 *
 * Throws the first error in key order — for callers that would rather not branch and
 * consider any missing airport a failed request. The message of the thrown error is
 * left untouched; the key it belongs to is available via {@link failures}.
 *
 * @returns The successful entries, when there were no failures.
 * @throws {SkyLinkError} The first failure, in input order.
 */
export function throwForErrors<T>(results: BatchResult<T>): Record<string, T> {
  for (const value of Object.values(results)) {
    if (isBatchError(value)) throw value;
  }
  return successes(results);
}
