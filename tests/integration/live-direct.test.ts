/**
 * The direct channel (`data.skylinkapi.com`) is addressed correctly — proven without
 * a valid key.
 *
 * The SDK ships two channels and the live suites only ever exercise one of them:
 * `live.test.ts` and `live-dx.test.ts` need a working key, and the only key on hand
 * is a RapidAPI one, which the direct gateway rejects by design. That leaves the
 * whole direct path — host, version prefix, auth header, gateway error format —
 * unverified against reality, which is exactly the kind of gap that ships broken.
 *
 * It does not have to stay that way. Reachability and addressing are observable
 * *through a rejection*: the APISIX gateway in front of `data.skylinkapi.com`
 * answers `401 {"code":"invalid_api_key"}` to a key it does not know and
 * `401 {"code":"missing_api_key"}` to a request with no key at all. Either answer
 * proves considerably more than it looks:
 *
 * - DNS resolves and the TLS endpoint is up (otherwise: `APIConnectionError`);
 * - the path is right — `/v3.1/weather/metar/KJFK` off the right host (otherwise:
 *   `404`, which APISIX answers for an unrouted path *before* it checks the key);
 * - the key travels in `x-api-key` and is seen (otherwise: `missing_api_key`);
 * - the SDK decodes the gateway's error dialect, `{code, message}`, which is a
 *   different shape from the application's `{detail: ...}` — and which APISIX sends
 *   under `content-type: text/plain`, so it only parses because the transport
 *   sniffs a leading `{`.
 *
 * Gating: the first test builds clients and stubs `fetch`, so it is pure and always
 * runs. The two live ones need the network but **no credentials** — the key they
 * send is invalid on purpose — so they are gated on reachability alone: an
 * `APIConnectionError` (offline CI, blocked egress, DNS hole) becomes a skip, the
 * same way the other live suites turn an unavailable upstream into a skip. They run
 * with `maxRetries: 0` so an offline run reports in a second rather than sitting
 * through three backoffs.
 *
 * ```sh
 * npm run test:integration              # these three need no env at all
 * ```
 */

import { describe, expect, it, type TestContext } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  type FetchLike,
  type Headers as HeaderBag,
  SkyLink,
} from "../../src/index.js";

/**
 * The two channel endpoints, written out as literals.
 *
 * Deliberately not imported from `src/core/config.ts`: a test that asserts a
 * constant against itself passes through any rename of the value it is supposed to
 * pin. These strings are the contract with the deployment.
 */
const DIRECT_BASE_URL = "https://data.skylinkapi.com/v3.1";
const RAPIDAPI_BASE_URL = "https://skylink-api.p.rapidapi.com";
const RAPIDAPI_HOST = "skylink-api.p.rapidapi.com";

/** A cheap, always-routed GET — the endpoint itself is never reached in this file. */
const PROBE_PATH = "/weather/metar/KJFK";

/** Correctly shaped, definitely not issued by anyone. */
const INVALID_KEY = "sk_live_skylink_sdk_integration_definitely_invalid";

/** One captured outbound request. */
interface Captured {
  url: string;
  headers: HeaderBag;
}

/** Lower-cased view of whatever `HeadersInit` the transport handed to `fetch`. */
function headerBag(init?: RequestInit): HeaderBag {
  const bag: HeaderBag = {};
  new globalThis.Headers(init?.headers).forEach((value, name) => {
    bag[name.toLowerCase()] = value;
  });
  return bag;
}

/** A `fetch` that records the request and then performs it for real. */
function recordingFetch(sink: Captured[]): FetchLike {
  return (input, init) => {
    sink.push({ url: input, headers: headerBag(init) });
    return globalThis.fetch(input, init);
  };
}

/** A `fetch` that records the request and answers `{}` without touching the network. */
function stubFetch(sink: Captured[]): FetchLike {
  return (input, init) => {
    sink.push({ url: input, headers: headerBag(init) });
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

function report(title: string, lines: readonly string[]): void {
  console.info(`\n  [live-direct] ${title}\n${lines.map((line) => `    ${line}`).join("\n")}`);
}

/**
 * Run a call that must be rejected by the gateway, converting unreachability into a
 * skip.
 *
 * A transport failure means the network, not the SDK — offline CI must report these
 * as skipped, never as failures. Anything else propagates: a `200` here would mean
 * the "invalid" key is live, and a non-401 status means the gateway is not where or
 * what we think it is.
 */
async function expectGatewayRejection(
  ctx: TestContext,
  what: string,
  call: () => Promise<unknown>,
): Promise<AuthenticationError> {
  let outcome: unknown;
  try {
    outcome = await call();
  } catch (error) {
    // Covers APITimeoutError too — it is a subclass.
    if (error instanceof APIConnectionError) {
      ctx.skip(`${what}: data.skylinkapi.com unreachable — ${error.message}`);
    }
    if (error instanceof AuthenticationError) return error;
    throw error;
  }
  throw new Error(
    `${what}: expected a 401 from the gateway, got a success: ${JSON.stringify(outcome).slice(0, 200)}`,
  );
}

describe("direct channel addressing", () => {
  // ── 1. offline: the two channels are wired to different hosts and headers ───

  it("provider selects the endpoint and the auth header, and nothing bleeds across", async () => {
    const directCalls: Captured[] = [];
    const direct = new SkyLink({
      provider: "direct",
      apiKey: INVALID_KEY,
      fetch: stubFetch(directCalls),
    });

    expect(direct.baseUrl).toBe(DIRECT_BASE_URL);
    expect(direct.config.provider).toBe("direct");
    expect(direct.config.defaultHeaders["x-api-key"]).toBe(INVALID_KEY);
    // The marketplace headers must not appear on the direct channel: APISIX would
    // pass them through and they identify the caller as something it is not.
    const directHeaderNames = Object.keys(direct.config.defaultHeaders).map((name) =>
      name.toLowerCase(),
    );
    expect(directHeaderNames).not.toContain("x-rapidapi-key");
    expect(directHeaderNames).not.toContain("x-rapidapi-host");

    const rapidCalls: Captured[] = [];
    const rapid = new SkyLink({
      provider: "rapidapi",
      apiKey: INVALID_KEY,
      fetch: stubFetch(rapidCalls),
    });

    expect(rapid.baseUrl).toBe(RAPIDAPI_BASE_URL);
    expect(rapid.config.defaultHeaders["X-RapidAPI-Key"]).toBe(INVALID_KEY);
    expect(rapid.config.defaultHeaders["X-RapidAPI-Host"]).toBe(RAPIDAPI_HOST);
    expect(
      Object.keys(rapid.config.defaultHeaders).map((name) => name.toLowerCase()),
    ).not.toContain("x-api-key");

    // Stubbed `fetch`, so this touches nothing: what is under test is the URL the
    // transport assembles and the headers it attaches, not the answer.
    await Promise.all([direct.weather.metar("KJFK"), rapid.weather.metar("KJFK")]);

    // What actually went on the wire, which is the only thing a deployment sees.
    expect(directCalls).toHaveLength(1);
    // The version prefix lives in the direct base URL and the resource path is
    // appended to it — no duplicated and no missing `/v3.1`.
    expect(directCalls[0]?.url).toBe(`${DIRECT_BASE_URL}${PROBE_PATH}`);
    expect(directCalls[0]?.headers["x-api-key"]).toBe(INVALID_KEY);
    expect(directCalls[0]?.headers["x-rapidapi-key"]).toBeUndefined();

    expect(rapidCalls).toHaveLength(1);
    // RapidAPI pins the version itself, so there is no prefix on this channel.
    expect(rapidCalls[0]?.url).toBe(`${RAPIDAPI_BASE_URL}${PROBE_PATH}`);
    expect(rapidCalls[0]?.headers["x-rapidapi-key"]).toBe(INVALID_KEY);
    expect(rapidCalls[0]?.headers["x-rapidapi-host"]).toBe(RAPIDAPI_HOST);
    expect(rapidCalls[0]?.headers["x-api-key"]).toBeUndefined();
  });

  // ── 2. live: the gateway is there and rejects an unknown key ───────────────

  it("an invalid key on the direct channel is a live 401 invalid_api_key", async (ctx) => {
    const calls: Captured[] = [];
    const sky = new SkyLink({
      provider: "direct",
      apiKey: INVALID_KEY,
      // 401 is not retryable, so this only shortens an *offline* run.
      maxRetries: 0,
      timeout: 20_000,
      fetch: recordingFetch(calls),
    });

    const error = await expectGatewayRejection(ctx, "direct 401", () => sky.weather.metar("KJFK"));

    report("invalid key", [
      `url: ${calls[0]?.url ?? "—"}`,
      `x-api-key sent: ${calls[0]?.headers["x-api-key"] === INVALID_KEY}`,
      `status: ${error.status}, code: ${String(error.code)}, message: ${error.message}`,
      `response content-type: ${error.headers["content-type"] ?? "—"}`,
      `body: ${JSON.stringify(error.body)}`,
    ]);

    // Addressing, in the request that actually left the process.
    expect(calls[0]?.url).toBe(`${DIRECT_BASE_URL}${PROBE_PATH}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(INVALID_KEY);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.status).toBe(401);
    expect(error.statusCode).toBe(401);
    // `invalid_api_key`, not `missing_api_key`: the header arrived and was inspected.
    expect(error.code).toBe("invalid_api_key");
    expect(error.message).toBe("Invalid API key");
    // The gateway dialect `{code, message}` decoded into a real object — and it does
    // so despite APISIX labelling the payload `text/plain; charset=utf-8`, which the
    // transport recovers from by sniffing the leading `{`. A regression there would
    // leave `body` a raw string and `code` null.
    expect(error.body).toEqual({ code: "invalid_api_key", message: "Invalid API key" });
    // The application's own dialect is absent, which is how the two are told apart.
    expect(error.body).not.toHaveProperty("detail");
  });

  // ── 3. live: the same gateway, no credentials at all ───────────────────────

  it("no key at all on the direct channel is a live 401 missing_api_key", async (ctx) => {
    const calls: Captured[] = [];
    const sky = new SkyLink({
      provider: "direct",
      // Explicit blank rather than omitted: an omitted key falls back to
      // `SKYLINK_API_KEY`, and this test is about a request that carries none. The
      // explicit base URL is what makes a keyless client legal at all.
      apiKey: "",
      baseUrl: DIRECT_BASE_URL,
      maxRetries: 0,
      timeout: 20_000,
      fetch: recordingFetch(calls),
    });

    expect(sky.config.apiKey).toBeNull();
    expect(Object.keys(sky.config.defaultHeaders).map((name) => name.toLowerCase())).not.toContain(
      "x-api-key",
    );

    const error = await expectGatewayRejection(ctx, "direct 401 (no key)", () =>
      sky.weather.metar("KJFK"),
    );

    report("no key", [
      `url: ${calls[0]?.url ?? "—"}`,
      `auth headers sent: ${JSON.stringify(
        Object.keys(calls[0]?.headers ?? {}).filter((name) => name.includes("api-key")),
      )}`,
      `status: ${error.status}, code: ${String(error.code)}, message: ${error.message}`,
      `body: ${JSON.stringify(error.body)}`,
    ]);

    expect(calls[0]?.url).toBe(`${DIRECT_BASE_URL}${PROBE_PATH}`);
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined();

    // The gateway distinguishes "no key" from "bad key", so this is not merely a
    // second copy of the previous test: it pins that the SDK sends *no* credential
    // header for a blank key rather than an empty one, which APISIX would report as
    // invalid instead.
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("missing_api_key");
    expect(error.message).toBe("API key is required");
    expect(error.body).toEqual({ code: "missing_api_key", message: "API key is required" });
  });
});
