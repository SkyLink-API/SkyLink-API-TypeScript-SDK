/**
 * Parsing of the marketplace quota headers (`X-RateLimit-Requests-Limit`,
 * `-Remaining`, `-Reset`) that the gateway attaches to every response.
 */

import type { Headers } from "./types.js";

/** Snapshot of the request quota as reported by the last response. */
export interface RateLimitInfo {
  /** Total requests allowed in the current window, or `null` when not reported. */
  limit: number | null;
  /** Requests left in the current window, or `null` when not reported. */
  remaining: number | null;
  /** Seconds until the window resets, or `null` when not reported. */
  reset: number | null;
}

const LIMIT_HEADER = "x-ratelimit-requests-limit";
const REMAINING_HEADER = "x-ratelimit-requests-remaining";
const RESET_HEADER = "x-ratelimit-requests-reset";

function readNumber(headers: Headers, name: string): number | null {
  const raw = headers[name];
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Build a {@link RateLimitInfo} from a lower-cased header bag.
 *
 * Returns `null` when none of the three quota headers are present, so callers can
 * distinguish "no quota information" from "quota reported as zero".
 */
export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = readNumber(headers, LIMIT_HEADER);
  const remaining = readNumber(headers, REMAINING_HEADER);
  const reset = readNumber(headers, RESET_HEADER);

  if (limit === null && remaining === null && reset === null) return null;
  return { limit, remaining, reset };
}
