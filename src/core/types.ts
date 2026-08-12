/**
 * Shared primitive types used across the SDK core and every resource namespace.
 *
 * Nothing in here has a runtime footprint beyond plain constants — the SDK ships
 * zero runtime dependencies and performs no response validation.
 */

/** HTTP verbs used by the SkyLink API (everything is GET except the webhooks CRUD). */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** How the transport should decode a successful response body. */
export type ResponseKind = "json" | "text" | "bytes" | "none";

/** Distribution channel: the direct `data.skylinkapi.com` API or the RapidAPI marketplace proxy. */
export type Provider = "direct" | "rapidapi";

/** History data plan — selects the `/ultra/history/...` or `/mega/history/...` path prefix. */
export type HistoryPlan = "ultra" | "mega";

/**
 * Geographic bounding box as `[lat1, lon1, lat2, lon2]` (south-west corner, then north-east).
 * Serialized on the wire as the comma-joined string `"lat1,lon1,lat2,lon2"`.
 */
export type BBox = [lat1: number, lon1: number, lat2: number, lon2: number];

/** A single query-parameter value before serialization. `undefined`/`null` are dropped. */
export type QueryValue =
  | string
  | number
  | boolean
  | BBox
  | readonly string[]
  | readonly number[]
  | null
  | undefined;

/** Query parameters of a request, prior to serialization. */
export type QueryParams = Record<string, QueryValue>;

/** Plain header bag. Header names are compared case-insensitively by the transport. */
export type Headers = Record<string, string>;

/**
 * Minimal structural type of the global `fetch`, so a custom implementation
 * (undici, node-fetch, a test double, an edge-runtime shim) can be injected.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Everything the transport needs in order to issue one HTTP request. */
export interface RequestSpec {
  method: HttpMethod;
  /** Path relative to the configured base URL, always starting with `/`. */
  path: string;
  /** Query parameters; `undefined`/`null` entries are dropped during serialization. */
  query?: QueryParams;
  /** Request body, JSON-encoded when present. */
  body?: unknown;
  /** How to decode the success response. Defaults to `"json"`. */
  responseKind?: ResponseKind;
  /**
   * Dotted operation name (`"weather.metar"`) used to look up this call's cache TTL.
   *
   * Optional: when omitted it is derived from {@link path}, which is what every
   * built-in resource relies on. Set it when calling {@link RequestSpec} directly
   * through `client.request()` and you want the call to match a configured TTL.
   */
  operation?: string;
}

/** Per-call overrides accepted by every SDK method. */
export interface RequestOptions {
  /** Overall deadline in milliseconds for this call (overrides the client default). */
  timeout?: number;
  /** Maximum retry attempts for this call (overrides the client default). */
  maxRetries?: number;
  /** Extra headers merged over (and winning against) the client defaults. */
  headers?: Headers;
  /** Caller-owned abort signal; aborting it cancels the call immediately without retrying. */
  signal?: AbortSignal;
}
