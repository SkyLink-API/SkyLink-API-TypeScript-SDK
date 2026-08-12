/**
 * The single HTTP path of the SDK: URL assembly, headers, deadline, retry loop and
 * response decoding. Every resource method ultimately funnels through {@link execute}.
 */

import type { CacheProtocol } from "../helpers/cache.js";
import type { ResolvedConfig } from "./config.js";
import { APIConnectionError, APITimeoutError, createStatusError, SkyLinkError } from "./errors.js";
import { operationOf } from "./operations.js";
import { buildQueryString, buildSearchParams } from "./query.js";
import { parseRateLimit, type RateLimitInfo } from "./ratelimit.js";
import {
  backoffDelay,
  parseRetryAfter,
  shouldRetryNetworkError,
  shouldRetryStatus,
} from "./retry.js";
import type { Headers, RequestOptions, RequestSpec, ResponseKind } from "./types.js";
import { warn } from "./warn.js";

/** Envelope returned by {@link execute}: decoded payload plus response metadata. */
export interface APIResponse<T> {
  data: T;
  response: Response;
  rateLimit: RateLimitInfo | null;
}

/**
 * Response header the transport puts on a synthetic response served from the cache.
 *
 * A cache hit has no real `Response` behind it, so one is constructed from the stored
 * body; this header is how `requestWithResponse()` can tell the two apart.
 */
export const CACHE_HIT_HEADER = "x-skylink-cache";

/** Callbacks the client uses to observe every response, successful or not. */
export interface TransportHooks {
  onRateLimit?: (info: RateLimitInfo) => void;
}

const ACCEPT_BY_KIND: Record<ResponseKind, string> = {
  json: "application/json",
  text: "text/plain, */*;q=0.8",
  bytes: "application/pdf, */*;q=0.8",
  none: "*/*",
};

/** Merge header bags left-to-right, de-duplicating case-insensitively (last wins). */
export function mergeHeaders(...bags: (Headers | undefined)[]): Headers {
  const byLower = new Map<string, [string, string]>();
  for (const bag of bags) {
    if (!bag) continue;
    for (const [name, value] of Object.entries(bag)) {
      if (value === undefined || value === null) continue;
      byLower.set(name.toLowerCase(), [name, value]);
    }
  }
  const merged: Headers = {};
  for (const [name, value] of byLower.values()) {
    merged[name] = value;
  }
  return merged;
}

/** Join the base URL, path and serialized query into the final request URL. */
export function buildUrl(baseUrl: string, path: string, query?: RequestSpec["query"]): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl.replace(/\/+$/, "")}${normalizedPath}`;
  const qs = buildQueryString(query);
  return qs ? `${url}?${qs}` : url;
}

function headersToRecord(headers: globalThis.Headers): Headers {
  const record: Headers = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const value = contentType.toLowerCase();
  return value.includes("application/json") || value.includes("+json");
}

async function readErrorBody(response: Response, headers: Headers): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;
  if (isJsonContentType(headers["content-type"])) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  // Some proxies answer with JSON but no content-type; give it one cheap try.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function parseJsonBody<T>(text: string, where: string, status: number): T {
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SkyLinkError(`Could not parse JSON response from ${where} (status ${status}).`, {
      cause,
    });
  }
}

/**
 * Decode a success body, and hand back the raw text when there is one.
 *
 * The raw text is what the cache stores (see {@link readCachedBody}); `null` for the
 * kinds that are not cached.
 */
async function decodeBody<T>(
  response: Response,
  kind: ResponseKind,
): Promise<{ data: T; raw: string | null }> {
  if (kind === "none" || response.status === 204) {
    // Drain so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    return { data: undefined as T, raw: null };
  }
  if (kind === "bytes") {
    return { data: new Uint8Array(await response.arrayBuffer()) as T, raw: null };
  }
  if (kind === "text") {
    const text = await response.text();
    return { data: text as T, raw: text };
  }

  const text = await response.text();
  return { data: parseJsonBody<T>(text, response.url || "the API", response.status), raw: text };
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

/** What a cache entry holds: the raw body plus the kind it was decoded as. */
interface CachedBody {
  kind: "json" | "text";
  body: string;
}

/** The response kinds worth caching: immutable strings, decoded fresh on every hit. */
function cacheableKind(kind: ResponseKind): kind is "json" | "text" {
  return kind === "json" || kind === "text";
}

/**
 * Cache key for one request: method, path, **sorted** query, provider and base URL.
 *
 * Sorting the query makes `?a=1&b=2` and `?b=2&a=1` one entry, which they are. The
 * provider and base URL are in the key because two clients can share a store and a
 * staging response must never be served to a production client.
 *
 * The API key is deliberately **not** part of the key: it is not part of the
 * response's identity, and putting a credential into a key that may be logged or
 * persisted to Redis is how credentials leak. Do not share one store between clients
 * whose keys see different data.
 */
export function buildCacheKey(
  method: string,
  path: string,
  query: RequestSpec["query"],
  provider: string,
  baseUrl: string,
): string {
  const sorted = [...buildSearchParams(query).entries()]
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return `${method} ${path}?${sorted}|${provider}|${baseUrl}`;
}

/**
 * Read an entry and turn it back into a body.
 *
 * The store is user-supplied and may hold anything (a stale format, another
 * library's key, a corrupted Redis value), so the entry is validated before use.
 * A mismatch is treated as a miss, never as an error.
 */
function readCachedBody(value: unknown, kind: "json" | "text"): string | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<CachedBody>;
  if (entry.kind !== kind || typeof entry.body !== "string") return null;
  return entry.body;
}

/** The synthetic `Response` handed back on a cache hit. */
function cachedResponse(body: string, kind: "json" | "text"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": kind === "json" ? "application/json" : "text/plain",
      [CACHE_HIT_HEADER]: "hit",
    },
  });
}

/** TTL for this call, in milliseconds; `0` when the store has no policy for it. */
function cacheTtl(cache: CacheProtocol, spec: RequestSpec): number {
  if (typeof cache.ttlFor !== "function") return 0;
  try {
    const ttl = cache.ttlFor(operationOf(spec));
    return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  } catch (cause) {
    warn("cache.ttlFor() threw; the response will not be cached", cause);
    return 0;
  }
}

/**
 * Issue one API request, retrying according to the policy in `./retry.ts`.
 *
 * The deadline is enforced per attempt with an `AbortController`; an externally
 * supplied `options.signal` aborts the call immediately and is never retried.
 *
 * When the client was given a cache, this is the **one** place it is consulted: a
 * successful GET whose operation has a non-zero TTL is looked up before the request
 * and stored after it. Nothing else is cached — not POSTs, not errors, not PDFs.
 */
export async function execute<T>(
  spec: RequestSpec,
  config: ResolvedConfig,
  options: RequestOptions = {},
  hooks: TransportHooks = {},
): Promise<APIResponse<T>> {
  const responseKind: ResponseKind = spec.responseKind ?? "json";
  const method = spec.method;
  const url = buildUrl(config.baseUrl, spec.path, spec.query);

  // Cache lookup. `ttl > 0` is the whole opt-in: with no cache, or no TTL configured
  // for this operation, `cacheKey` stays null and not a line below changes.
  const cache = config.cache;
  const cacheKind = cacheableKind(responseKind) ? responseKind : null;
  const ttl = cache && cacheKind && method === "GET" ? cacheTtl(cache, spec) : 0;
  const cacheKey =
    cache && cacheKind && ttl > 0
      ? buildCacheKey(method, spec.path, spec.query, config.provider, config.baseUrl)
      : null;

  if (cache && cacheKey !== null && cacheKind !== null) {
    let stored: unknown;
    try {
      stored = cache.get(cacheKey);
    } catch (cause) {
      warn("cache.get() threw; falling through to the network", cause);
    }
    const body = stored === undefined ? null : readCachedBody(stored, cacheKind);
    if (body !== null) {
      const data =
        cacheKind === "text" ? (body as T) : parseJsonBody<T>(body, "the response cache", 200);
      // No response means no quota headers: a cache hit costs nothing, so it must not
      // look like a request in `lastRateLimit` or in the quota hooks.
      return { data, response: cachedResponse(body, cacheKind), rateLimit: null };
    }
  }

  const timeout = options.timeout ?? config.timeout;
  const maxRetries = options.maxRetries ?? config.maxRetries;
  const hasBody = spec.body !== undefined && spec.body !== null;

  const headers = mergeHeaders(
    config.defaultHeaders,
    { Accept: ACCEPT_BY_KIND[responseKind] },
    hasBody ? { "Content-Type": "application/json" } : undefined,
    options.headers,
  );
  const body = hasBody ? JSON.stringify(spec.body) : undefined;

  let attempt = 0;
  // Loop control: every branch either returns, throws, or continues after a sleep.
  for (;;) {
    const external = options.signal;
    if (external?.aborted) {
      throw new APIConnectionError("Request was aborted.", { cause: external.reason });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onExternalAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await config.fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      if (external?.aborted) {
        throw new APIConnectionError("Request was aborted.", { cause });
      }
      const error = timedOut
        ? new APITimeoutError(`Request timed out after ${timeout}ms.`, { cause })
        : new APIConnectionError(
            cause instanceof Error ? `Connection error: ${cause.message}` : "Connection error.",
            { cause },
          );
      if (attempt < maxRetries && shouldRetryNetworkError(method)) {
        await config.sleep(backoffDelay(attempt, config.random));
        attempt += 1;
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }

    const responseHeaders = headersToRecord(response.headers);
    const rateLimit = parseRateLimit(responseHeaders);
    if (rateLimit && hooks.onRateLimit) hooks.onRateLimit(rateLimit);

    if (!response.ok) {
      const errorBody = await readErrorBody(response, responseHeaders);
      const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
      const error = createStatusError(response.status, errorBody, {
        headers: responseHeaders,
        rateLimit,
        retryAfter,
      });

      if (attempt < maxRetries && shouldRetryStatus(response.status, method)) {
        await config.sleep(retryAfter ?? backoffDelay(attempt, config.random));
        attempt += 1;
        continue;
      }
      throw error;
    }

    const { data, raw } = await decodeBody<T>(response, responseKind);

    if (cache && cacheKey !== null && cacheKind !== null && raw !== null) {
      // The *raw body* is stored, not the decoded object, and every hit re-parses it.
      // Handing the same object graph to two callers is a real bug: the SDK does not
      // freeze responses, so the first caller's `delete row.foo` would silently corrupt
      // the second one's. Re-parsing is a few microseconds against a saved round trip.
      try {
        cache.set(cacheKey, { kind: cacheKind, body: raw } satisfies CachedBody, ttl);
      } catch (cause) {
        warn("cache.set() threw; the response was not cached", cause);
      }
    }

    return { data, response, rateLimit };
  }
}
