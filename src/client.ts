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
import type { RateLimitInfo } from "./core/ratelimit.js";
import { type APIResponse, execute } from "./core/transport.js";
import type { RequestOptions, RequestSpec } from "./core/types.js";
import type { DistanceParams, DistanceResponse } from "./models/distance.js";
import type { FlightStatusResponse } from "./models/flight-status.js";
import { Adsb } from "./resources/adsb.js";
import { Aircraft } from "./resources/aircraft.js";
import { Airlines } from "./resources/airlines.js";
import { Airports } from "./resources/airports.js";
import { Briefing } from "./resources/briefing.js";
import { Carbon } from "./resources/carbon.js";
import { Charts } from "./resources/charts.js";
import { Delays } from "./resources/delays.js";
import { Distance } from "./resources/distance.js";
import { FlightStatus } from "./resources/flight-status.js";
import { Geo } from "./resources/geo.js";
import { History } from "./resources/history.js";
import { Ml } from "./resources/ml.js";
import { Navaids } from "./resources/navaids.js";
import { Notams } from "./resources/notams.js";
import { Routes } from "./resources/routes.js";
import { Schedules } from "./resources/schedules.js";
import { Tickets } from "./resources/tickets.js";
import { Weather } from "./resources/weather.js";
import { Webhooks } from "./resources/webhooks.js";

export type { ClientOptions } from "./core/config.js";

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

  constructor(options: ClientOptions = {}) {
    this.config = resolveConfig(options);
  }

  /** Quota snapshot from the most recent response that carried `X-RateLimit-Requests-*` headers. */
  get lastRateLimit(): RateLimitInfo | null {
    return this._lastRateLimit;
  }

  /** Base URL every request is issued against. */
  get baseUrl(): string {
    return this.config.baseUrl;
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
        this._lastRateLimit = info;
      },
    });
  }
}
