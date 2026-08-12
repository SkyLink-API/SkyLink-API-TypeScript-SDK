/**
 * The `SkyLink` client.
 *
 * It owns configuration, the shared request entry point and quota tracking, and
 * exposes every resource namespace (`sky.weather`, `sky.adsb`, …) as an eager
 * readonly field. Two single-operation endpoints — flight status and distance —
 * are surfaced as methods (`sky.flightStatus(…)`, `sky.distance(…)`) rather than
 * namespaces, since a namespace with one member reads worse than a verb.
 */

import { type ClientOptions, type ResolvedConfig, resolveConfig } from "./core/config.js";
import { SkyLinkError } from "./core/errors.js";
import type { RateLimitInfo } from "./core/ratelimit.js";
import { type APIResponse, execute } from "./core/transport.js";
import type { RequestOptions, RequestSpec } from "./core/types.js";
import { warn } from "./core/warn.js";
import type { DistanceParams, DistanceResponse } from "./models/distance.js";
import type { FlightStatusResponse } from "./models/flight-status.js";
import { Adsb } from "./resources/adsb.js";
import { Aircraft } from "./resources/aircraft.js";
import { Airlines } from "./resources/airlines.js";
import { Airports } from "./resources/airports.js";
import { Batch } from "./resources/batch.js";
import { Briefing } from "./resources/briefing.js";
import { Carbon } from "./resources/carbon.js";
import { Charts } from "./resources/charts.js";
import { Compose } from "./resources/compose.js";
import { Delays } from "./resources/delays.js";
import { Distance } from "./resources/distance.js";
import { FlightStatus } from "./resources/flight-status.js";
import { Geo } from "./resources/geo.js";
import { History } from "./resources/history.js";
import { Ml } from "./resources/ml.js";
import { Navaids } from "./resources/navaids.js";
import { Notams } from "./resources/notams.js";
import { Poll } from "./resources/poll.js";
import { Routes } from "./resources/routes.js";
import { Schedules } from "./resources/schedules.js";
import { Tickets } from "./resources/tickets.js";
import { Weather } from "./resources/weather.js";
import { Webhooks } from "./resources/webhooks.js";

export type { ClientOptions } from "./core/config.js";

/** Observer of the quota headers of a single response. */
export type RateLimitListener = (info: RateLimitInfo) => void;

/** Options of {@link SkyLink.onQuotaLow}. */
export interface QuotaLowOptions {
  /**
   * Fraction of the quota at or below which the callback fires, between `0` and `1`.
   * Defaults to `0.1` — ten percent left.
   */
  threshold?: number;
}

/**
 * The options {@link SkyLink.withOptions} can change.
 *
 * Credentials, the channel and the base URL are deliberately absent: those define
 * *which API you are talking to*, and a clone that silently talks to a different one
 * is a debugging nightmare. Construct a new client for that.
 */
export type ClientCloneOptions = Pick<
  ClientOptions,
  "timeout" | "maxRetries" | "historyPlan" | "defaultHeaders" | "cache"
>;

interface QuotaLowSubscription {
  listener: RateLimitListener;
  threshold: number;
  /** Whether the last usable reading was already at or below the threshold. */
  below: boolean;
}

/**
 * Fraction of the quota still available, or `null` when it cannot be computed.
 *
 * The gateway sends the three headers independently and any of them can be missing;
 * a `limit` of zero would also make the ratio meaningless rather than "empty".
 */
function quotaRatio(info: RateLimitInfo): number | null {
  const { limit, remaining } = info;
  if (limit === null || remaining === null || !Number.isFinite(limit) || limit <= 0) return null;
  return remaining / limit;
}

/**
 * Render an API key for display: the last four characters, nothing else.
 *
 * Enough to tell two keys apart in a log, useless to anyone who finds the log.
 */
function maskApiKey(apiKey: string | null): string {
  if (!apiKey) return "none";
  return apiKey.length <= 4 ? "****" : `****${apiKey.slice(-4)}`;
}

/**
 * SkyLink API client.
 *
 * ```ts
 * const sky = new SkyLink({ apiKey: process.env.SKYLINK_API_KEY });
 * const metar = await sky.weather.metar("KJFK", { parsed: true });
 * ```
 */
export class SkyLink {
  /** Fully resolved configuration (base URL, headers, timeout, retry budget, history plan). */
  readonly config: ResolvedConfig;

  /** Aviation weather: METAR, TAF, winds aloft, PIREPs, AIRMET/SIGMET. */
  readonly weather: Weather = new Weather(this);

  /** Airport lookup by code, by proximity, by IP and by free-text query. */
  readonly airports: Airports = new Airports(this);

  /** Airline lookup by IATA/ICAO code, callsign or name. */
  readonly airlines: Airlines = new Airlines(this);

  /** Radio navigation aids (VOR, NDB, DME, TACAN) with country/type filters. */
  readonly navaids: Navaids = new Navaids(this);

  /** Reference geography: countries and ISO 3166-2 regions. */
  readonly geo: Geo = new Geo(this);

  /** Live ADS-B traffic, feed statistics and feed health. */
  readonly adsb: Adsb = new Adsb(this);

  /** Aircraft registry lookup, type performance data and database statistics. */
  readonly aircraft: Aircraft = new Aircraft(this);

  /** Terminal procedure charts by airport and by category. */
  readonly charts: Charts = new Charts(this);

  /** FAA ground delays, ground stops, closures and airspace flow programs. */
  readonly delays: Delays = new Delays(this);

  /** NOTAMs for an airport. */
  readonly notams: Notams = new Notams(this);

  /** Departure and arrival boards for an airport. */
  readonly schedules: Schedules = new Schedules(this);

  /** Machine-learning predictions (flight time). */
  readonly ml: Ml = new Ml(this);

  /** CO2 emission estimates for a route or flight. */
  readonly carbon: Carbon = new Carbon(this);

  /** Pre-flight briefings as structured JSON, formatted text or PDF. */
  readonly briefing: Briefing = new Briefing(this);

  /** Route lookup by callsign, by airport and as origin/destination pairs. */
  readonly routes: Routes = new Routes(this);

  /** Ticket price search. */
  readonly tickets: Tickets = new Tickets(this);

  /** Webhook subscription CRUD. */
  readonly webhooks: Webhooks = new Webhooks(this);

  /** Historical flights, tracks, positions and airport traffic. */
  readonly history: History = new History(this);

  /** The same call for many identifiers at once, with a concurrency limit. */
  readonly batch: Batch = new Batch(this);

  /** Repeated calls on a timer: flight status until landing, ADS-B feed diffs. */
  readonly poll: Poll = new Poll(this);

  /** Multi-endpoint aggregates: airport, flight and route briefs in one call. */
  readonly compose: Compose = new Compose(this);

  /**
   * Backing resource for {@link flightStatus}.
   *
   * Kept private so the public surface is the method, not a one-member namespace.
   */
  private readonly _flightStatus: FlightStatus = new FlightStatus(this);

  /**
   * Backing resource for {@link distance}.
   *
   * Kept private so the public surface is the method, not a one-member namespace.
   */
  private readonly _distance: Distance = new Distance(this);

  private _lastRateLimit: RateLimitInfo | null = null;

  private readonly _rateLimitListeners = new Set<RateLimitListener>();

  private readonly _quotaLowListeners = new Set<QuotaLowSubscription>();

  /** The options this client was built from, kept so {@link withOptions} can clone them. */
  private readonly _options: ClientOptions;

  constructor(options: ClientOptions = {}) {
    this._options = { ...options };
    this.config = resolveConfig(options);
  }

  /**
   * Build a client from the environment alone.
   *
   * Identical to `new SkyLink()` — the constructor already falls back to
   * `RAPIDAPI_KEY` and `SKYLINK_API_KEY` — but it says so out loud, which is worth a
   * lot in an example or a script someone else has to read.
   *
   * ```ts
   * const sky = SkyLink.fromEnv();                        // RAPIDAPI_KEY / SKYLINK_API_KEY
   * const direct = SkyLink.fromEnv({ provider: "direct" }); // SKYLINK_API_KEY only
   * ```
   *
   * @param overrides Anything except the key, which by definition comes from the
   * environment.
   * @throws {AuthenticationError} When the channel's variable is unset or blank.
   */
  static fromEnv(overrides: Omit<ClientOptions, "apiKey"> = {}): SkyLink {
    return new SkyLink(overrides);
  }

  /**
   * Quota snapshot from the most recent response that carried quota headers —
   * `X-RateLimit-Requests-*` on RapidAPI, `X-RateLimit-*` on the direct channel.
   */
  get lastRateLimit(): RateLimitInfo | null {
    return this._lastRateLimit;
  }

  /** Base URL every request is issued against. */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Observe the quota headers of **every** response, success or failure.
   *
   * The callback is handed that response's own {@link RateLimitInfo}, not
   * {@link lastRateLimit}: with requests in flight in parallel the shared field is
   * last-writer-wins and can already describe a different call by the time a
   * callback reads it.
   *
   * Responses without quota headers (a cache hit, a gateway that does not send them)
   * do not fire it. An exception thrown by the callback is reported on `console.warn`
   * and never fails the request.
   *
   * ```ts
   * const off = sky.onRateLimit(({ remaining, limit }) => metrics.gauge("quota", remaining / limit));
   * off(); // stop listening
   * ```
   *
   * @returns An unsubscribe function.
   */
  onRateLimit(listener: RateLimitListener): () => void {
    this._rateLimitListeners.add(listener);
    return () => {
      this._rateLimitListeners.delete(listener);
    };
  }

  /**
   * Fire once when the remaining quota crosses down through `threshold`.
   *
   * **Once per crossing, not once per response.** A client that spends the last ten
   * percent of its quota over an hour would otherwise call this a few thousand times;
   * here it fires on the response that took it below the line and stays quiet until
   * the quota window resets above it again.
   *
   * ```ts
   * sky.onQuotaLow((info) => alert(`${info.remaining} of ${info.limit} left`), { threshold: 0.05 });
   * ```
   *
   * @param options.threshold `remaining / limit` at or below which to fire. Defaults
   * to `0.1`.
   * @returns An unsubscribe function.
   * @throws {SkyLinkError} When `threshold` is outside `[0, 1]`.
   */
  onQuotaLow(listener: RateLimitListener, options: QuotaLowOptions = {}): () => void {
    const threshold = options.threshold ?? 0.1;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new SkyLinkError(
        `Invalid threshold: ${String(options.threshold)}. Expected a fraction between 0 and 1.`,
      );
    }
    const subscription: QuotaLowSubscription = { listener, threshold, below: false };
    this._quotaLowListeners.add(subscription);
    return () => {
      this._quotaLowListeners.delete(subscription);
    };
  }

  /**
   * A second client with some options changed, sharing this one's `fetch`.
   *
   * The point is the sharing: a clone made for one slow call reuses the same
   * connection pool, so it costs nothing. What it does **not** inherit is state —
   * `lastRateLimit`, the quota listeners and the namespace objects are all fresh, so
   * a clone never reports another client's quota and never fires another client's
   * callbacks. `defaultHeaders` are *merged* over this client's, so adding one header
   * does not mean restating the rest, and the cache **store** is shared unless it is
   * overridden — pass `{ cache: null }` for a clone that always goes to the network.
   *
   * ```ts
   * const patient = sky.withOptions({ timeout: 120_000, maxRetries: 5 });
   * const pdf = await patient.briefing.pdf({ from: "EGLL", to: "KJFK" });
   * ```
   */
  withOptions(overrides: ClientCloneOptions = {}): SkyLink {
    const defaultHeaders = overrides.defaultHeaders
      ? { ...this._options.defaultHeaders, ...overrides.defaultHeaders }
      : this._options.defaultHeaders;

    return new SkyLink({
      ...this._options,
      ...overrides,
      // Pinned rather than re-resolved: a clone must talk to the same API as its
      // parent even if the environment has changed since the parent was built.
      apiKey: this.config.apiKey ?? "",
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      defaultHeaders,
      fetch: this.config.fetch,
      sleep: this.config.sleep,
      random: this.config.random,
    });
  }

  /** One-line description of the client. The API key is masked to its last four characters. */
  toString(): string {
    const parts = [
      `provider=${this.config.provider}`,
      `baseUrl=${this.config.baseUrl}`,
      `apiKey=${maskApiKey(this.config.apiKey)}`,
      `timeout=${this.config.timeout}ms`,
      `maxRetries=${this.config.maxRetries}`,
      `historyPlan=${this.config.historyPlan}`,
      `cache=${this.config.cache ? (this.config.cache.constructor?.name ?? "custom") : "off"}`,
    ];
    return `SkyLink { ${parts.join(", ")} }`;
  }

  /** Same text as {@link toString}, for `console.log(sky)` and `util.inspect`. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * Update the quota snapshot and run the listeners for one response.
   *
   * A listener that throws is reported and skipped: an observer is not allowed to
   * fail the call it is observing, and it is not allowed to disappear either.
   */
  private emitRateLimit(info: RateLimitInfo): void {
    this._lastRateLimit = info;

    for (const listener of [...this._rateLimitListeners]) {
      try {
        listener(info);
      } catch (cause) {
        warn("an onRateLimit() listener threw", cause);
      }
    }

    const ratio = quotaRatio(info);
    if (ratio === null) return;
    for (const subscription of [...this._quotaLowListeners]) {
      const low = ratio <= subscription.threshold;
      if (low === subscription.below) continue;
      subscription.below = low;
      if (!low) continue; // Rearmed for the next crossing; nothing to announce.
      try {
        subscription.listener(info);
      } catch (cause) {
        warn("an onQuotaLow() listener threw", cause);
      }
    }
  }

  /**
   * Current status of a flight: airline, phase of flight, gates, terminals and the
   * scheduled/actual/estimated times of both legs.
   *
   * Accepts IATA (`"BA123"`) and ICAO (`"BAW123"`) flight numbers. Every time and
   * date in the response is a **display string** — a local clock time without a
   * timezone, a date without a year. Do not feed them to `new Date()`.
   *
   * `GET /flight_status/{flight_number}`
   *
   * ```ts
   * const flight = await sky.flightStatus("BA123");
   * console.log(flight.status, flight.arrival.estimated_time);
   * ```
   */
  flightStatus(flightNumber: string, options?: RequestOptions): Promise<FlightStatusResponse> {
    return this._flightStatus.get(flightNumber, options);
  }

  /**
   * Great-circle distance, initial bearing and midpoint between two points.
   *
   * Each endpoint of the route is given either as an airport code (ICAO or IATA)
   * or as a lat/lon pair; the two forms can be mixed within one call.
   *
   * `GET /distance`
   *
   * ```ts
   * const leg = await sky.distance({ from_icao: "KJFK", to_icao: "EGLL", unit: "km" });
   * console.log(leg.distance, leg.bearing_cardinal);
   * ```
   */
  distance(params: DistanceParams, options?: RequestOptions): Promise<DistanceResponse> {
    return this._distance.calculate(params, options);
  }

  /**
   * Escape hatch for endpoints the typed resources do not cover yet.
   *
   * Resolves to the decoded body; use {@link requestWithResponse} when the raw
   * `Response` or the quota headers are needed.
   */
  async request<T = unknown>(spec: RequestSpec, options?: RequestOptions): Promise<T> {
    const result = await this.requestWithResponse<T>(spec, options);
    return result.data;
  }

  /** Like {@link request}, but returns the decoded body together with response metadata. */
  async requestWithResponse<T = unknown>(
    spec: RequestSpec,
    options?: RequestOptions,
  ): Promise<APIResponse<T>> {
    return execute<T>(spec, this.config, options, {
      onRateLimit: (info) => {
        this.emitRateLimit(info);
      },
    });
  }
}
