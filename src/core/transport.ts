/**
 * The single HTTP path of the SDK: URL assembly, headers, deadline, retry loop and
 * response decoding. Every resource method ultimately funnels through {@link execute}.
 */

import type { ResolvedConfig } from "./config.js";
import { APIConnectionError, APITimeoutError, createStatusError, SkyLinkError } from "./errors.js";
import { buildQueryString } from "./query.js";
import { parseRateLimit, type RateLimitInfo } from "./ratelimit.js";
import {
  backoffDelay,
  parseRetryAfter,
  shouldRetryNetworkError,
  shouldRetryStatus,
} from "./retry.js";
import type { Headers, RequestOptions, RequestSpec, ResponseKind } from "./types.js";

/** Envelope returned by {@link execute}: decoded payload plus response metadata. */
export interface APIResponse<T> {
  data: T;
  response: Response;
  rateLimit: RateLimitInfo | null;
}

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

async function decodeBody<T>(response: Response, kind: ResponseKind): Promise<T> {
  if (kind === "none" || response.status === 204) {
    // Drain so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    return undefined as T;
  }
  if (kind === "bytes") {
    return new Uint8Array(await response.arrayBuffer()) as T;
  }
  if (kind === "text") {
    return (await response.text()) as T;
  }

  const text = await response.text();
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SkyLinkError(
      `Could not parse JSON response from ${response.url || "the API"} (status ${response.status}).`,
      { cause },
    );
  }
}

/**
 * Issue one API request, retrying according to the policy in `./retry.ts`.
 *
 * The deadline is enforced per attempt with an `AbortController`; an externally
 * supplied `options.signal` aborts the call immediately and is never retried.
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

    const data = await decodeBody<T>(response, responseKind);
    return { data, response, rateLimit };
  }
}
