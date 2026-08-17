/**
 * The API's closed value sets, as runtime tuples.
 *
 * The models already spell these out as literal unions, which covers autocomplete
 * and type checking — but a union cannot be iterated, and "fetch every chart
 * category" or "render a continent picker" needs the values at runtime. Each tuple
 * here is `as const` and `satisfies` its model type, so a value that drifts away from
 * the type fails to compile in both directions.
 *
 * Values are taken from the backend, not from the OpenAPI document (which is stale).
 */

import type { FlightCategory } from "../helpers/weather.js";
import type { ChartCategory } from "../models/charts.js";
import type { Continent } from "../models/geo.js";
import type { WebhookEventType } from "../models/webhooks.js";
import type { HistoryPlan } from "./types.js";

/**
 * Every aerodrome chart category, in the order the API documents them.
 *
 * `GEN` general information, `GND` ground/taxi diagrams, `SID` standard instrument
 * departures, `STAR` standard terminal arrival routes, `APP` approach procedures.
 * Accepted by `charts.byCategory()`; the categories with no charts are dropped from
 * a `charts.byAirport()` response entirely, so iterate this rather than the response.
 */
export const CHART_CATEGORIES = [
  "GEN",
  "GND",
  "SID",
  "STAR",
  "APP",
] as const satisfies readonly ChartCategory[];

/**
 * Every webhook event type a subscription may listen for.
 *
 * Ordered alphabetically to match `GET /webhooks/events`, which sorts the server-side
 * set before answering. The compile-time counterpart is {@link WebhookEventType}.
 */
export const WEBHOOK_EVENTS = [
  "flight_boarding",
  "flight_cancelled",
  "flight_delayed",
  "flight_landed",
  "gate_changed",
  "status_changed",
] as const satisfies readonly WebhookEventType[];

/**
 * Every continent code the `continent` filter of `geo.countries()` / `geo.regions()`
 * validates against: `AF` Africa, `AN` Antarctica, `AS` Asia, `EU` Europe,
 * `NA` North America, `OC` Oceania, `SA` South America.
 *
 * `"NA"` used to be accepted and then match nothing: the reference CSV was loaded with
 * pandas, which reads the literal `NA` as "not available", so every North-American row
 * arrived with `continent: null` and filtering by `"NA"` returned an empty list. **That
 * is fixed** — verified live on 2026-08-15, `geo.countries({ continent: "NA" })` returns
 * 41 countries and `geo.regions({ continent: "NA" })` 440 regions.
 */
export const CONTINENTS = [
  "AF",
  "AN",
  "AS",
  "EU",
  "NA",
  "OC",
  "SA",
] as const satisfies readonly Continent[];

/**
 * Historical-data plans, each a different path prefix (`/ultra/history/…`,
 * `/mega/history/…`) and a different retention window: ULTRA 90 days, MEGA 365 days.
 * `ultra` is the client default.
 */
export const HISTORY_PLANS = ["ultra", "mega"] as const satisfies readonly HistoryPlan[];

/**
 * VFR flight categories, worst conditions last.
 *
 * `LIFR` below 1 SM visibility or a ceiling below 500 ft, `IFR` below 3 SM or below
 * 1 000 ft, `MVFR` at or below 5 SM or 3 000 ft, `VFR` above that. Computed locally
 * by `weatherHelpers.flightCategory()`; a parsed METAR also reports it as
 * `parsed.flight_rules`.
 */
export const FLIGHT_CATEGORIES = [
  "VFR",
  "MVFR",
  "IFR",
  "LIFR",
] as const satisfies readonly FlightCategory[];
