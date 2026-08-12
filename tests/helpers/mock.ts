/**
 * undici `MockAgent` plumbing shared by every test file.
 *
 * `setupMockAgent()` installs a global dispatcher with net-connect disabled, so a
 * request that no interceptor matches fails loudly instead of hitting the network.
 * Every intercepted request is recorded in {@link requests} for assertions on the
 * URL, query string, headers and body the SDK actually produced.
 */

import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

/** Origin of the direct channel (`https://data.skylinkapi.com/v3.1` minus the path). */
export const DIRECT_ORIGIN = "https://data.skylinkapi.com";

/** Origin of the RapidAPI channel. */
export const RAPIDAPI_ORIGIN = "https://skylink-api.p.rapidapi.com";

/** Path prefix of the direct channel. */
export const DIRECT_PREFIX = "/v3.1";

/** A request as it reached the mock server. */
export interface RecordedRequest {
  method: string;
  origin: string;
  /** Path including the query string, exactly as sent. */
  fullPath: string;
  /** Path without the query string. */
  path: string;
  query: URLSearchParams;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: string | null;
}

/** Every request the mock agent has seen since the last `setupMockAgent()`. */
export const requests: RecordedRequest[] = [];

let agent: MockAgent | null = null;
let previousDispatcher: Dispatcher | null = null;

/** Install a fresh MockAgent as the global dispatcher and clear recorded requests. */
export function setupMockAgent(): MockAgent {
  previousDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  requests.length = 0;
  return agent;
}

/** Restore the previous dispatcher and close the mock agent. */
export async function teardownMockAgent(): Promise<void> {
  if (agent) {
    await agent.close();
    agent = null;
  }
  if (previousDispatcher) {
    setGlobalDispatcher(previousDispatcher);
    previousDispatcher = null;
  }
  requests.length = 0;
}

function currentAgent(): MockAgent {
  if (!agent) throw new Error("Mock agent is not set up — call setupMockAgent() first.");
  return agent;
}

/** Assert every registered interceptor was consumed. */
export function assertNoPendingInterceptors(): void {
  currentAgent().assertNoPendingInterceptors();
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i];
      const value = raw[i + 1];
      if (typeof name === "string" && value !== undefined) {
        headers[name.toLowerCase()] = String(value);
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
    }
  }
  return headers;
}

function record(opts: unknown, origin: string): void {
  const o = opts as {
    path?: string;
    method?: string;
    headers?: unknown;
    body?: unknown;
  };
  const fullPath = o.path ?? "";
  const queryIndex = fullPath.indexOf("?");
  requests.push({
    method: (o.method ?? "GET").toUpperCase(),
    origin,
    fullPath,
    path: queryIndex === -1 ? fullPath : fullPath.slice(0, queryIndex),
    query: new URLSearchParams(queryIndex === -1 ? "" : fullPath.slice(queryIndex + 1)),
    headers: normalizeHeaders(o.headers),
    body: typeof o.body === "string" ? o.body : null,
  });
}

/** Shared options of every `mock*` helper. */
export interface MockOptions {
  /** Path to match; include the query string, or pass a RegExp for loose matching. */
  path: string | RegExp;
  method?: string;
  status?: number;
  /** Response headers. */
  headers?: Record<string, string>;
  /** Origin to intercept. Defaults to the direct channel. */
  origin?: string;
  /** How many requests this interceptor answers. Defaults to 1. */
  times?: number;
  /** Answer an unlimited number of requests. */
  persist?: boolean;
}

function register(
  options: MockOptions,
  status: number,
  data: string | Buffer,
  responseHeaders: Record<string, string>,
): void {
  const origin = options.origin ?? DIRECT_ORIGIN;
  const interceptor = currentAgent()
    .get(origin)
    .intercept({ path: options.path, method: options.method ?? "GET" })
    .reply(
      status,
      (opts: unknown) => {
        record(opts, origin);
        return data;
      },
      { headers: { ...responseHeaders, ...(options.headers ?? {}) } },
    );

  if (options.persist) {
    interceptor.persist();
  } else if (options.times && options.times > 1) {
    interceptor.times(options.times);
  }
}

/** Reply with a JSON body (status 200 by default). */
export function mockJson(options: MockOptions & { body: unknown }): void {
  register(options, options.status ?? 200, JSON.stringify(options.body ?? null), {
    "content-type": "application/json",
  });
}

/** Reply with a plain-text body. */
export function mockText(options: MockOptions & { body: string }): void {
  register(options, options.status ?? 200, options.body, { "content-type": "text/plain" });
}

/** Reply with binary content (defaults to `application/pdf`). */
export function mockBytes(options: MockOptions & { body: Uint8Array | Buffer | string }): void {
  const data =
    typeof options.body === "string" ? Buffer.from(options.body) : Buffer.from(options.body);
  register(options, options.status ?? 200, data, { "content-type": "application/pdf" });
}

/** Reply with an empty body (for 204 responses). */
export function mockEmpty(options: MockOptions): void {
  register(options, options.status ?? 204, "", {});
}

/**
 * Reply with an error status.
 *
 * `body` accepts any of the three documented error shapes; when omitted, a
 * FastAPI-style `{ detail }` body is generated.
 */
export function mockError(options: MockOptions & { status: number; body?: unknown }): void {
  const body = options.body ?? { detail: `Error ${options.status}` };
  register(options, options.status, JSON.stringify(body), {
    "content-type": "application/json",
  });
}
