/**
 * Client configuration: provider defaults, credential resolution and validation.
 */

import type { CacheProtocol } from "../helpers/cache.js";
import { VERSION } from "../version.js";
import { AuthenticationError, SkyLinkError } from "./errors.js";
import type { FetchLike, Headers, HistoryPlan, Provider } from "./types.js";

/** Base URL of the direct channel (the API version lives in the path). */
export const DIRECT_BASE_URL = "https://data.skylinkapi.com/v3.1";

/** Base URL of the RapidAPI channel (no version prefix — the proxy pins it). */
export const RAPIDAPI_BASE_URL = "https://skylink-api.p.rapidapi.com";

/** Value of the mandatory `X-RapidAPI-Host` header. */
export const RAPIDAPI_HOST = "skylink-api.p.rapidapi.com";

/** Environment variable holding the direct-channel key. */
export const DIRECT_ENV_VAR = "SKYLINK_API_KEY";

/** Environment variable holding the RapidAPI key. */
export const RAPIDAPI_ENV_VAR = "RAPIDAPI_KEY";

/**
 * Channel used when the caller does not pass `provider`.
 *
 * RapidAPI is the default because that is how most subscriptions reach the API.
 * Pass `{ provider: "direct" }` for a key issued by skylinkapi.com itself.
 */
export const DEFAULT_PROVIDER: Provider = "rapidapi";

/** Overall request deadline in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Request deadline for `/briefing/*`, the one family {@link DEFAULT_TIMEOUT_MS} is wrong for.
 *
 * Briefings are composed by a language model over METAR, TAF, NOTAMs and (optionally)
 * PIREPs for both airports. Measured against the live API on 2026-08-15: `format: "json"`
 * took 37-58 s, `"markdown"` 30-50 s, `"plain_text"` up to 85 s, and `briefing.pdf()`
 * about 50 s. Under the 30 s default every one of those is an `APITimeoutError` — and
 * because a timeout is retried, the caller waits ~120 s to be told a working endpoint
 * failed.
 *
 * Applied as the *spec* default (`RequestSpec.timeout`), so a per-call
 * `{ timeout }` in `RequestOptions` still overrides it.
 */
export const BRIEFING_TIMEOUT_MS = 180_000;

/** Default number of retries after the initial attempt. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default history plan, used when a call does not pass one explicitly. */
export const DEFAULT_HISTORY_PLAN: HistoryPlan = "ultra";

/** User-Agent sent on every request. */
export const USER_AGENT = `skylink-api-node/${VERSION}`;

/** Options accepted by the `SkyLink` constructor. */
export interface ClientOptions {
  /**
   * API key.
   *
   * When omitted it is read from the environment: `RAPIDAPI_KEY`, falling back to
   * `SKYLINK_API_KEY`, on the `rapidapi` channel; strictly `SKYLINK_API_KEY` on the
   * `direct` channel.
   *
   * Optional only when an explicit {@link baseUrl} is given (staging with auth disabled).
   */
  apiKey?: string;
  /** Distribution channel. Defaults to `"rapidapi"`. */
  provider?: Provider;
  /** Override the base URL (staging, proxies, local backend). Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Overall deadline per request in milliseconds. Defaults to 30 000. */
  timeout?: number;
  /** Retries after the initial attempt. Defaults to 3. Set to 0 to disable retries. */
  maxRetries?: number;
  /** Default plan for the history endpoints. Defaults to `"ultra"`. */
  historyPlan?: HistoryPlan;
  /** Extra headers merged into every request. */
  defaultHeaders?: Headers;
  /** Custom `fetch` implementation. Defaults to the global `fetch` (Node >= 20). */
  fetch?: FetchLike;
  /**
   * Response cache. **Off by default**, and off for every operation the store gives
   * a TTL of `0` — so adding one changes nothing until TTLs are configured.
   *
   * Only successful GET responses are stored. See {@link CacheProtocol} and
   * {@link MemoryCache}.
   *
   * ```ts
   * new SkyLink({ cache: new MemoryCache({ ttls: { "weather.metar": 300_000 } }) })
   * ```
   */
  cache?: CacheProtocol | null;
  /**
   * Test seam: replaces the delay between retries.
   * @internal
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: replaces the jitter RNG used by the backoff calculation.
   * @internal
   */
  random?: () => number;
}

/** Fully resolved configuration used by the transport. */
export interface ResolvedConfig {
  apiKey: string | null;
  provider: Provider;
  /** Base URL without a trailing slash. */
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  historyPlan: HistoryPlan;
  /** Auth headers, User-Agent and any caller-supplied defaults. */
  defaultHeaders: Headers;
  /** Response cache, or `null` when the client does not cache (the default). */
  cache: CacheProtocol | null;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

function readEnv(name: string): string | undefined {
  // Deliberately defensive: `process` does not exist in browsers, Deno without
  // --allow-env, or some edge runtimes.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read the key of a channel from the environment.
 *
 * `rapidapi` accepts `SKYLINK_API_KEY` as a fallback so that an existing
 * environment keeps working now that it is the default channel; `direct` stays
 * strict — a RapidAPI key is not a valid `x-api-key` and would only produce a
 * confusing 401.
 */
function readApiKeyFromEnv(provider: Provider): string | undefined {
  if (provider === "rapidapi") {
    return readEnv(RAPIDAPI_ENV_VAR) ?? readEnv(DIRECT_ENV_VAR);
  }
  return readEnv(DIRECT_ENV_VAR);
}

function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof globalFetch !== "function") {
    throw new SkyLinkError(
      "No global fetch available. Use Node.js >= 18 or pass a custom `fetch` implementation.",
    );
  }
  return globalFetch.bind(globalThis) as FetchLike;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize {@link ClientOptions} into a {@link ResolvedConfig}.
 *
 * The channel defaults to {@link DEFAULT_PROVIDER} (`rapidapi`). Its key is read
 * from `RAPIDAPI_KEY` and then from `SKYLINK_API_KEY`; the `direct` channel only
 * ever reads `SKYLINK_API_KEY`.
 *
 * Throws {@link AuthenticationError} when no key can be found — unless an explicit
 * `baseUrl` was supplied, which is how the staging backend (`DISABLE_AUTH=true`)
 * and integration tests run keyless.
 */
export function resolveConfig(options: ClientOptions = {}): ResolvedConfig {
  const provider: Provider = options.provider ?? DEFAULT_PROVIDER;
  if (provider !== "direct" && provider !== "rapidapi") {
    throw new SkyLinkError(
      `Unknown provider: ${String(provider)}. Expected 'direct' or 'rapidapi'.`,
    );
  }

  // Wording kept in sync with the Python SDK's AuthenticationError.
  const envVars =
    provider === "rapidapi" ? `${RAPIDAPI_ENV_VAR} (or ${DIRECT_ENV_VAR})` : DIRECT_ENV_VAR;
  // An *omitted* key falls back to the environment; an explicitly passed blank
  // one does not. Passing `apiKey: ""` almost always means an unset variable was
  // interpolated, and silently reaching for a different variable would hide it.
  // The Python SDK draws the line in the same place.
  const apiKey =
    options.apiKey === undefined
      ? readApiKeyFromEnv(provider) || null
      : options.apiKey.trim() || null;

  const explicitBaseUrl = typeof options.baseUrl === "string" && options.baseUrl.trim() !== "";
  const baseUrl = explicitBaseUrl
    ? (options.baseUrl as string).trim().replace(/\/+$/, "")
    : provider === "rapidapi"
      ? RAPIDAPI_BASE_URL
      : DIRECT_BASE_URL;

  if (!apiKey && !explicitBaseUrl) {
    throw new AuthenticationError(
      `Missing API key for the '${provider}' provider. Pass { apiKey } to the SkyLink constructor or set the ${envVars} environment variable.`,
    );
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new SkyLinkError(
      `Invalid timeout: ${String(options.timeout)}. Expected a positive number of milliseconds.`,
    );
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new SkyLinkError(
      `Invalid maxRetries: ${String(options.maxRetries)}. Expected a non-negative integer.`,
    );
  }

  const authHeaders: Headers = {};
  if (provider === "rapidapi") {
    authHeaders["X-RapidAPI-Host"] = RAPIDAPI_HOST;
    if (apiKey) authHeaders["X-RapidAPI-Key"] = apiKey;
  } else if (apiKey) {
    authHeaders["x-api-key"] = apiKey;
  }

  return {
    apiKey,
    provider,
    baseUrl,
    timeout,
    maxRetries,
    historyPlan: options.historyPlan ?? DEFAULT_HISTORY_PLAN,
    defaultHeaders: {
      "User-Agent": USER_AGENT,
      ...authHeaders,
      ...(options.defaultHeaders ?? {}),
    },
    cache: options.cache ?? null,
    fetch: resolveFetch(options.fetch),
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  };
}
