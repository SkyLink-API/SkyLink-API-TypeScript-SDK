/**
 * Opt-in response cache.
 *
 * The SDK never caches anything unless a store is handed to it
 * (`new SkyLink({ cache: new MemoryCache({ ttls: { … } }) })`), and even then only
 * **successful GET responses** are stored — a POST changes state and an error is a
 * fact about one moment, not about a resource.
 *
 * Two things are deliberate:
 *
 * - **TTLs are per operation, not global.** A METAR is worth five minutes, an airport
 *   record is worth a day, and live ADS-B is worth nothing at all; one global number
 *   would have to be the smallest of them. The lookup is exact name
 *   (`"weather.metar"`), then the `.*` prefixes (`"weather.*"`), then `defaultTtl`,
 *   and a resolved TTL of `0` means "do not cache this call" — which is why the
 *   default configuration changes no behaviour whatsoever.
 * - **Time is monotonic.** Expiry is measured with `performance.now()` rather than
 *   `Date.now()`: a wall clock can jump backwards (NTP, a VM resuming from a
 *   snapshot, a user changing the system time) and freeze an entry for hours.
 *
 * ```ts
 * import { MemoryCache, SkyLink } from "skylink-api";
 *
 * const sky = new SkyLink({
 *   apiKey: process.env.SKYLINK_API_KEY,
 *   cache: new MemoryCache({ ttls: { "weather.metar": 300_000, "airports.*": 86_400_000 } }),
 * });
 * ```
 *
 * All durations in this module are **milliseconds**, like every other duration in
 * this SDK (`timeout`, `maxAgeMs`, the poll intervals). The Python SDK uses seconds
 * there, because that is what Python durations are.
 */

import { SkyLinkError } from "../core/errors.js";

/** Entries a {@link MemoryCache} keeps before it starts evicting. */
export const DEFAULT_CACHE_MAX_ENTRIES = 500;

/**
 * The store the transport talks to.
 *
 * Deliberately tiny, so a Redis/KV wrapper is a few lines. `get` returns the stored
 * value or `undefined` for a miss; `set` is handed the resolved TTL in milliseconds.
 *
 * ```ts
 * class RedisCache implements CacheProtocol {
 *   ttlFor(operation: string) { return resolveTtl(operation, { "weather.*": 300_000 }, 0); }
 *   get(key: string) { return this.local.get(key); }        // must be synchronous
 *   set(key: string, value: unknown, ttl: number) { … }
 * }
 * ```
 *
 * `get`/`set` are **synchronous** on purpose: an async store would put a network hop
 * on the fast path of every request, which is the thing the cache exists to avoid.
 * Back an async store with an in-process mirror and populate it out of band.
 */
export interface CacheProtocol {
  /** Stored value, or `undefined` when the key is absent or expired. */
  get(key: string): unknown | undefined;
  /** Store a value under `key` for `ttl` milliseconds. */
  set(key: string, value: unknown, ttl: number): void;
  /**
   * TTL in milliseconds for an operation such as `"weather.metar"`; `0` disables
   * caching for it.
   *
   * **A store that does not implement this caches nothing**: the transport has no
   * other source for the policy, and defaulting to "cache everything" would be a
   * surprising, correctness-affecting default. Implement it with {@link resolveTtl}.
   */
  ttlFor?(operation: string): number;
}

/** Options of {@link MemoryCache}. */
export interface MemoryCacheOptions {
  /**
   * TTL in milliseconds for operations not matched by {@link ttls}. Defaults to `0`,
   * i.e. an unconfigured cache stores nothing.
   */
  defaultTtl?: number;
  /**
   * Per-operation TTLs in milliseconds, by exact name (`"weather.metar"`), by prefix
   * (`"weather.*"`) or as a catch-all (`"*"`). More specific wins.
   */
  ttls?: Readonly<Record<string, number>>;
  /**
   * Entries kept before the least recently used one is evicted. Defaults to
   * {@link DEFAULT_CACHE_MAX_ENTRIES}.
   */
  maxEntries?: number;
  /**
   * Test seam: the monotonic millisecond clock. Defaults to `performance.now()`.
   * @internal
   */
  now?: () => number;
}

/** The default monotonic clock, with a wall-clock fallback for exotic runtimes. */
function defaultClock(): () => number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") return () => (perf.now as () => number)();
  return () => Date.now();
}

function checkTtl(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SkyLinkError(
      `Invalid cache TTL for ${label}: ${String(value)}. Expected a non-negative number of milliseconds.`,
    );
  }
  return value;
}

/**
 * TTL in milliseconds for `operation`, by exact name, then by `.*` prefix, then
 * `defaultTtl`.
 *
 * The walk is from the most specific name outwards, so with
 * `{ "weather.*": 60_000, "weather.metar": 300_000 }` a METAR gets five minutes and a
 * PIREP gets one. Exported so a custom {@link CacheProtocol} can reuse the exact
 * lookup the built-in cache uses.
 *
 * @param operation Dotted operation name, e.g. `"weather.metar"`.
 * @param ttls Configured TTLs, in milliseconds.
 * @param defaultTtl Fallback when nothing matches.
 * @returns Milliseconds; `0` means "do not cache".
 */
export function resolveTtl(
  operation: string,
  ttls: Readonly<Record<string, number>> = {},
  defaultTtl = 0,
): number {
  if (operation !== "") {
    const exact = ttls[operation];
    if (exact !== undefined) return exact;

    const parts = operation.split(".");
    for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
      const wildcard = ttls[`${parts.slice(0, depth).join(".")}.*`];
      if (wildcard !== undefined) return wildcard;
    }
  }
  const catchAll = ttls["*"];
  if (catchAll !== undefined) return catchAll;
  return defaultTtl;
}

interface Entry {
  value: unknown;
  /** Monotonic timestamp after which the entry is dead. */
  expiresAt: number;
}

/**
 * An in-process TTL cache with LRU eviction. Zero dependencies, no timers.
 *
 * Expiry is lazy — an entry is dropped when it is read or when the size limit
 * evicts it — so an idle cache holds no `setTimeout` and never keeps the process
 * alive. Eviction order is least-recently-*used*: `get` moves an entry to the back
 * of the `Map`, and `Map` iteration order is insertion order.
 *
 * ```ts
 * const cache = new MemoryCache({
 *   defaultTtl: 0,                              // everything else: no caching
 *   ttls: { "weather.metar": 300_000, "geo.*": 86_400_000 },
 *   maxEntries: 200,
 * });
 * ```
 */
export class MemoryCache implements CacheProtocol {
  private readonly entries = new Map<string, Entry>();
  private readonly defaultTtl: number;
  private readonly ttls: Readonly<Record<string, number>>;
  private readonly maxEntries: number;
  private readonly now: () => number;

  /**
   * @throws {SkyLinkError} When a TTL is negative or not finite, or `maxEntries` is
   * not a positive integer — a typo in the configuration should be loud, not a cache
   * that silently never stores anything.
   */
  constructor(options: MemoryCacheOptions = {}) {
    this.defaultTtl = checkTtl(options.defaultTtl ?? 0, "defaultTtl");
    const ttls = options.ttls ?? {};
    for (const [name, value] of Object.entries(ttls)) checkTtl(value, `'${name}'`);
    this.ttls = { ...ttls };

    const maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new SkyLinkError(
        `Invalid maxEntries: ${String(options.maxEntries)}. Expected a positive integer.`,
      );
    }
    this.maxEntries = maxEntries;
    this.now = options.now ?? defaultClock();
  }

  /** TTL in milliseconds for an operation name. See {@link resolveTtl}. */
  ttlFor(operation: string): number {
    return resolveTtl(operation, this.ttls, this.defaultTtl);
  }

  /** Stored value, or `undefined` when absent or expired. Refreshes LRU position. */
  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the most recently used entry sits at the back of the eviction queue.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Store a value for `ttl` milliseconds. A `ttl` of `0` or less stores nothing. */
  set(key: string, value: unknown, ttl: number): void {
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop one entry. Returns whether it was there. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }

  /** Entries currently held, expired ones included (expiry is lazy). */
  get size(): number {
    return this.entries.size;
  }
}
