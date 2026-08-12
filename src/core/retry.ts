/**
 * Retry policy: which failures are worth repeating, and how long to wait first.
 *
 * Policy (from the published API docs): retry 429/500/502/503/504 with full-jitter
 * exponential backoff, honour `Retry-After` when the server sends one, and never
 * retry 400/401/403/404/422. `POST` is only retried on 429 — every other failure
 * mode could have created a webhook subscription already.
 */

import type { HttpMethod } from "./types.js";

/** Status codes worth retrying. */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Base backoff step in milliseconds; doubled per attempt before jitter. */
export const BACKOFF_INITIAL_MS = 500;

/** Upper bound of the pre-jitter backoff window. */
export const BACKOFF_MAX_MS = 8_000;

/** Longest delay honoured from a `Retry-After` header. */
export const RETRY_AFTER_MAX_MS = 60_000;

/** Methods that can be replayed safely for any retryable failure. */
function isIdempotent(method: HttpMethod): boolean {
  return method !== "POST";
}

/**
 * Should a response with this status be retried?
 *
 * `POST` is deliberately restricted to 429, where the server is telling us it did
 * not process the request at all.
 */
export function shouldRetryStatus(status: number, method: HttpMethod): boolean {
  if (!RETRYABLE_STATUS_CODES.has(status)) return false;
  if (!isIdempotent(method)) return status === 429;
  return true;
}

/** Should a transport-level failure (socket error, timeout) be retried? */
export function shouldRetryNetworkError(method: HttpMethod): boolean {
  return isIdempotent(method);
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Accepts both documented forms — delay in seconds (`"3"`) and an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Past dates clamp to 0, everything is capped
 * at {@link RETRY_AFTER_MAX_MS}, and unparseable values return `null`.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw === "") return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
  }

  const target = Date.parse(raw);
  if (Number.isNaN(target)) return null;
  return Math.min(Math.max(target - now, 0), RETRY_AFTER_MAX_MS);
}

/**
 * Full-jitter exponential backoff: `random() * min(8s, 500ms * 2^attempt)`.
 *
 * `attempt` is zero-based (0 = delay before the first retry). The RNG is injectable
 * so tests can pin the jitter.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt);
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** exponent);
  return random() * ceiling;
}

/** Promise-based `setTimeout` that rejects if the (optional) signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
