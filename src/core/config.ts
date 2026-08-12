/**
 * Client configuration: provider defaults, credential resolution and validation.
 */

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

/** Overall request deadline in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of retries after the initial attempt. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default history plan, used when a call does not pass one explicitly. */
export const DEFAULT_HISTORY_PLAN: HistoryPlan = "ultra";

/** User-Agent sent on every request. */
export const USER_AGENT = `skylink-api-node/${VERSION}`;

/** Options accepted by the `SkyLink` constructor. */
export interface ClientOptions {
  /**
   * API key. Falls back to `SKYLINK_API_KEY` (direct) or `RAPIDAPI_KEY` (rapidapi).
   * Optional only when an explicit {@link baseUrl} is given (staging with auth disabled).
   */
  apiKey?: string;
  /** Distribution channel. Defaults to `"direct"`. */
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
  /** Custom `fetch` implementation. Defaults to the global `fetch` (Node >= 18). */
  fetch?: FetchLike;
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
 * Throws {@link AuthenticationError} when no key can be found — unless an explicit
 * `baseUrl` was supplied, which is how the staging backend (`DISABLE_AUTH=true`)
 * and integration tests run keyless.
 */
export function resolveConfig(options: ClientOptions = {}): ResolvedConfig {
  const provider: Provider = options.provider ?? "direct";
  if (provider !== "direct" && provider !== "rapidapi") {
    throw new SkyLinkError(
      `Unknown provider: ${String(provider)}. Expected 'direct' or 'rapidapi'.`,
    );
  }

  const envVar = provider === "rapidapi" ? RAPIDAPI_ENV_VAR : DIRECT_ENV_VAR;
  const apiKey = options.apiKey?.trim() || readEnv(envVar) || null;

  const explicitBaseUrl = typeof options.baseUrl === "string" && options.baseUrl.trim() !== "";
  const baseUrl = explicitBaseUrl
    ? (options.baseUrl as string).trim().replace(/\/+$/, "")
    : provider === "rapidapi"
      ? RAPIDAPI_BASE_URL
      : DIRECT_BASE_URL;

  if (!apiKey && !explicitBaseUrl) {
    throw new AuthenticationError(
      `Missing API key. Pass { apiKey } to the SkyLink constructor or set the ${envVar} environment variable.`,
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
    fetch: resolveFetch(options.fetch),
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  };
}
