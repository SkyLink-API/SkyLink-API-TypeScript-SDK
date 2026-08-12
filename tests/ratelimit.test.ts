/**
 * Quota header parsing across the two channels.
 *
 * The bug this file pins: the SDK originally knew only the RapidAPI spelling
 * (`X-RateLimit-Requests-*`), so on the direct channel — which sends the plain
 * `X-RateLimit-*` — `lastRateLimit` stayed `null` forever and `onRateLimit` /
 * `onQuotaLow` never fired once. Verified against a live Ultra key.
 *
 * The other half of the contract is what must **not** be picked up: RapidAPI
 * decorates its responses with `X-RateLimit-rapid-free-plans-hard-limit-*`, the
 * marketplace's free-tier ceiling, which has nothing to do with the plan's quota.
 * Reading those would make every RapidAPI number quietly wrong — worse than the
 * original bug, because it looks like it works.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import { parseRateLimit, type RateLimitInfo } from "../src/core/ratelimit.js";
import {
  DIRECT_PREFIX,
  mockJson,
  RAPIDAPI_ORIGIN,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

/** Exactly what APISIX puts on a direct-channel response (observed live). */
const DIRECT_HEADERS = {
  "x-ratelimit-limit": "750000",
  "x-ratelimit-remaining": "749996",
  "x-ratelimit-reset": "86385",
} as const;

/** Exactly what the RapidAPI proxy puts on a response, decoys included (observed live). */
const RAPIDAPI_HEADERS = {
  "x-ratelimit-requests-limit": "10000",
  "x-ratelimit-requests-remaining": "8938",
  "x-ratelimit-requests-reset": "319216",
  "x-ratelimit-rapid-free-plans-hard-limit-limit": "500",
  "x-ratelimit-rapid-free-plans-hard-limit-remaining": "497",
  "x-ratelimit-rapid-free-plans-hard-limit-reset": "86400",
} as const;

describe("parseRateLimit", () => {
  it("reads the direct channel's plain X-RateLimit-* triple", () => {
    expect(parseRateLimit({ ...DIRECT_HEADERS })).toEqual({
      limit: 750_000,
      remaining: 749_996,
      reset: 86_385,
    });
  });

  it("reads the RapidAPI channel's X-RateLimit-Requests-* triple", () => {
    expect(parseRateLimit({ ...RAPIDAPI_HEADERS })).toEqual({
      limit: 10_000,
      remaining: 8_938,
      reset: 319_216,
    });
  });

  it("prefers Requests-* when all three families are on the same response", () => {
    // The regression that matters most: a fallback that is too eager reports the
    // gateway's or the marketplace's numbers instead of the plan's quota.
    const info = parseRateLimit({
      ...RAPIDAPI_HEADERS,
      ...DIRECT_HEADERS,
    });

    expect(info).toEqual({ limit: 10_000, remaining: 8_938, reset: 319_216 });
  });

  it("never mistakes the rapid-free-plans decoys for a quota", () => {
    const decoysOnly = {
      "x-ratelimit-rapid-free-plans-hard-limit-limit": "500",
      "x-ratelimit-rapid-free-plans-hard-limit-remaining": "497",
      "x-ratelimit-rapid-free-plans-hard-limit-reset": "86400",
    };

    // Not "a quota of 500": no quota at all. Prefix matching would answer 500 here.
    expect(parseRateLimit(decoysOnly)).toBeNull();
  });

  it("is case-insensitive — the live direct gateway sends X-Ratelimit-Limit", () => {
    expect(
      parseRateLimit({
        "X-Ratelimit-Limit": "750000",
        "X-RateLimit-Remaining": "749996",
        "X-RATELIMIT-RESET": "86385",
      }),
    ).toEqual({ limit: 750_000, remaining: 749_996, reset: 86_385 });
  });

  it("returns null when no family is present", () => {
    expect(parseRateLimit({})).toBeNull();
    expect(parseRateLimit({ "content-type": "application/json", "retry-after": "30" })).toBeNull();
  });

  it("keeps a partial family partial instead of borrowing from the other spelling", () => {
    // A family is chosen whole. Pairing RapidAPI's remaining with APISIX's limit
    // would invent a ratio that describes neither gateway's accounting.
    expect(
      parseRateLimit({
        "x-ratelimit-requests-remaining": "8938",
        "x-ratelimit-limit": "750000",
        "x-ratelimit-reset": "86385",
      }),
    ).toEqual({ limit: null, remaining: 8_938, reset: null });
  });

  it("falls through to the plain family when the Requests family is unreadable", () => {
    // A family is picked on parsed numbers, not on header presence. A gateway that
    // emits the Requests names with blank or garbled values must not shadow a
    // perfectly readable plain triple sitting right next to it: reporting three
    // nulls there would throw away quota numbers the response actually carries.
    expect(
      parseRateLimit({
        "x-ratelimit-requests-limit": "",
        "x-ratelimit-requests-remaining": "abc",
        "x-ratelimit-requests-reset": "   ",
        ...DIRECT_HEADERS,
      }),
    ).toEqual({ limit: 750_000, remaining: 749_996, reset: 86_385 });

    // One unreadable Requests header and no other member of that family, either.
    expect(parseRateLimit({ "x-ratelimit-requests-limit": "abc", ...DIRECT_HEADERS })).toEqual({
      limit: 750_000,
      remaining: 749_996,
      reset: 86_385,
    });
  });

  it("still prefers Requests-* when it is readable and the plain family is too", () => {
    // The other side of the fall-through: degrading must stay conditional on the
    // Requests family being unreadable, never on the plain one merely being present.
    expect(parseRateLimit({ ...RAPIDAPI_HEADERS, ...DIRECT_HEADERS })).toEqual({
      limit: 10_000,
      remaining: 8_938,
      reset: 319_216,
    });

    // Readable down to a single member: the family still wins, still whole.
    expect(
      parseRateLimit({
        "x-ratelimit-requests-limit": "10000",
        "x-ratelimit-requests-remaining": "n/a",
        ...DIRECT_HEADERS,
      }),
    ).toEqual({ limit: 10_000, remaining: null, reset: null });
  });

  it("returns null when every family is present but unreadable", () => {
    // Not a quota of zero, and not a fall-through to the decoys: no data.
    expect(
      parseRateLimit({
        "x-ratelimit-requests-limit": "",
        "x-ratelimit-limit": "unlimited",
        "x-ratelimit-remaining": "  ",
        "x-ratelimit-rapid-free-plans-hard-limit-limit": "500",
      }),
    ).toBeNull();
  });

  it("treats blank and unparseable values as absent", () => {
    expect(parseRateLimit({ "x-ratelimit-limit": "   ", "x-ratelimit-remaining": "" })).toBeNull();
    expect(parseRateLimit({ "x-ratelimit-limit": "unlimited" })).toBeNull();
    // A garbled member does not discard the family's readable ones.
    expect(parseRateLimit({ "x-ratelimit-limit": "n/a", "x-ratelimit-remaining": "42" })).toEqual({
      limit: null,
      remaining: 42,
      reset: null,
    });
  });

  it("reports a spent quota as zero, not as missing", () => {
    expect(
      parseRateLimit({
        "x-ratelimit-limit": "750000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "12",
      }),
    ).toEqual({ limit: 750_000, remaining: 0, reset: 12 });
  });
});

describe("quota reporting end to end", () => {
  beforeEach(() => {
    setupMockAgent();
  });

  afterEach(async () => {
    await teardownMockAgent();
  });

  function client(provider: "direct" | "rapidapi"): SkyLink {
    return new SkyLink({ apiKey: "test-key", provider, sleep: async () => undefined });
  }

  it("fills lastRateLimit and fires the hooks on the direct channel", async () => {
    const sky = client("direct");
    const seen: RateLimitInfo[] = [];
    const low: RateLimitInfo[] = [];
    sky.onRateLimit((info) => seen.push(info));
    // 749_996 / 750_000 is nowhere near low; a threshold of 1 fires on any reading,
    // which is what proves the hook is reachable on this channel at all.
    sky.onQuotaLow((info) => low.push(info), { threshold: 1 });

    mockJson({ path: `${DIRECT_PREFIX}/health`, body: {}, headers: { ...DIRECT_HEADERS } });
    await sky.request({ method: "GET", path: "/health" });

    const expected = { limit: 750_000, remaining: 749_996, reset: 86_385 };
    expect(sky.lastRateLimit).toEqual(expected);
    expect(seen).toEqual([expected]);
    expect(low).toEqual([expected]);
  });

  it("still reports the plan quota, not the decoys, on the RapidAPI channel", async () => {
    const sky = client("rapidapi");
    const seen: RateLimitInfo[] = [];
    sky.onRateLimit((info) => seen.push(info));

    mockJson({
      origin: RAPIDAPI_ORIGIN,
      path: "/health",
      body: {},
      headers: { ...RAPIDAPI_HEADERS },
    });
    await sky.request({ method: "GET", path: "/health" });

    const expected = { limit: 10_000, remaining: 8_938, reset: 319_216 };
    expect(sky.lastRateLimit).toEqual(expected);
    expect(seen).toEqual([expected]);
  });

  it("attaches the direct channel's quota to a 429 error too", async () => {
    const sky = client("direct");

    mockJson({
      path: `${DIRECT_PREFIX}/health`,
      status: 429,
      body: { detail: "Rate limit exceeded" },
      headers: { ...DIRECT_HEADERS, "x-ratelimit-remaining": "0" },
    });

    await expect(
      sky.request({ method: "GET", path: "/health" }, { maxRetries: 0 }),
    ).rejects.toMatchObject({
      status: 429,
      rateLimit: { limit: 750_000, remaining: 0, reset: 86_385 },
    });
  });
});
