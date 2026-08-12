/**
 * Parsing of the quota headers the gateways attach to every response.
 *
 * The two channels do not agree on the spelling, which is the whole reason this
 * file is more than three lookups:
 *
 * - **RapidAPI** sends `X-RateLimit-Requests-{Limit,Remaining,Reset}` — and, on top
 *   of them, a second decorative family, `X-RateLimit-rapid-free-plans-hard-limit-*`,
 *   which describes the marketplace's own free-tier ceiling and *not* the plan's
 *   quota. Reporting those numbers as the quota is worse than reporting nothing.
 * - **Direct** (`data.skylinkapi.com`, APISIX) sends the plain
 *   `X-RateLimit-{Limit,Remaining,Reset}` and nothing else.
 *
 * So: the `Requests` family wins when it carries a readable number, the plain family
 * is the fallback, and every lookup is by exact (lower-cased) name — which is what
 * keeps the `rapid-*` decoys out, since none of them spell `x-ratelimit-limit` exactly.
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

/** One spelling of the quota triple, in the order it is tried. */
interface HeaderFamily {
  limit: string;
  remaining: string;
  reset: string;
}

/**
 * Header families in priority order: the marketplace's request quota first, the
 * gateway's plain triple second.
 *
 * Order matters and is not arbitrary. A RapidAPI response carries the `Requests`
 * family; were the plain family ever added alongside it by a future gateway, the
 * plan quota — the number a caller can act on — must still be the one reported.
 */
const HEADER_FAMILIES: readonly HeaderFamily[] = [
  {
    limit: "x-ratelimit-requests-limit",
    remaining: "x-ratelimit-requests-remaining",
    reset: "x-ratelimit-requests-reset",
  },
  {
    limit: "x-ratelimit-limit",
    remaining: "x-ratelimit-remaining",
    reset: "x-ratelimit-reset",
  },
];

function readNumber(headers: Headers, name: string): number | null {
  const raw = headers[name];
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Lower-cased view of a header bag.
 *
 * The transport already lower-cases what it hands over, and that is the hot path, so
 * this only allocates when it finds a name that needs it — a live direct response
 * arrives as `X-Ratelimit-Limit`, and a caller passing raw headers to a re-exported
 * parser must not silently get `null`.
 */
function lowerCased(headers: Headers): Headers {
  let needsCopy = false;
  for (const name in headers) {
    if (name !== name.toLowerCase()) {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return headers;

  const copy: Headers = {};
  for (const [name, value] of Object.entries(headers)) {
    copy[name.toLowerCase()] = value;
  }
  return copy;
}

/**
 * Build a {@link RateLimitInfo} from a header bag, case-insensitively.
 *
 * Returns `null` when no family yields a number at all, so callers can distinguish
 * "no quota information" from "quota reported as zero".
 *
 * A family is chosen as a whole, and it is chosen on *parsed numbers*, not on header
 * presence: the first family that yields at least one readable number wins, and its
 * unreadable or missing members stay `null` rather than being back-filled from the
 * other spelling — mixing a limit from one gateway's accounting with a remaining from
 * another's produces a number that describes nothing. A family that is present but
 * entirely unreadable (blank or garbled values, as a misconfigured gateway emits) is
 * skipped, so the other spelling still gets its chance to report real numbers.
 *
 * This matches `RateLimitInfo.from_headers` in the Python SDK exactly.
 */
export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const bag = lowerCased(headers);

  for (const family of HEADER_FAMILIES) {
    const limit = readNumber(bag, family.limit);
    const remaining = readNumber(bag, family.remaining);
    const reset = readNumber(bag, family.reset);
    if (limit === null && remaining === null && reset === null) continue;
    return { limit, remaining, reset };
  }

  return null;
}
