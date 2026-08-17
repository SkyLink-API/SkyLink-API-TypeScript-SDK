/**
 * Official TypeScript SDK for the SkyLink API.
 *
 * ```ts
 * import { SkyLink } from "skylink-api";
 *
 * const sky = new SkyLink({ apiKey: process.env.SKYLINK_API_KEY });
 * const metar = await sky.weather.metar("KJFK", { parsed: true });
 * const flight = await sky.flightStatus("BA123");
 * ```
 *
 * The response types are compile-time only: the SDK performs no runtime
 * validation, so a field the API stops sending fails at use, not at parse.
 */

export {
  type ClientCloneOptions,
  type QuotaLowOptions,
  type RateLimitListener,
  SkyLink,
} from "./client.js";
export type { ClientOptions, ResolvedConfig } from "./core/config.js";
export {
  CHART_CATEGORIES,
  CONTINENTS,
  FLIGHT_CATEGORIES,
  HISTORY_PLANS,
  WEBHOOK_EVENTS,
} from "./core/constants.js";
export {
  APIConnectionError,
  APIStatusError,
  type APIStatusErrorInit,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  type ParsedErrorBody,
  PermissionDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  SkyLinkError,
  UnprocessableEntityError,
  type ValidationErrorItem,
} from "./core/errors.js";
export { deriveOperation } from "./core/operations.js";
export type { RateLimitInfo } from "./core/ratelimit.js";
export { type APIResponse, CACHE_HIT_HEADER } from "./core/transport.js";
export type {
  BBox,
  FetchLike,
  Headers,
  HistoryPlan,
  HttpMethod,
  Provider,
  QueryParams,
  QueryValue,
  RequestOptions,
  RequestSpec,
  ResponseKind,
} from "./core/types.js";
export type { BatchResult, MapConcurrentOptions } from "./helpers/batch.js";
export * as batch from "./helpers/batch.js";
export {
  type CacheProtocol,
  DEFAULT_CACHE_MAX_ENTRIES,
  MemoryCache,
  type MemoryCacheOptions,
  resolveTtl,
} from "./helpers/cache.js";
export type { ToCsvOptions } from "./helpers/csv.js";
export * as csv from "./helpers/csv.js";
export type {
  Feature,
  FeatureCollection,
  FeatureProperties,
  Geometry,
  LineStringGeometry,
  PointGeometry,
  Position,
} from "./helpers/geojson.js";
export * as geojson from "./helpers/geojson.js";
export type { AirportCodeKind, FlightNumber } from "./helpers/idents.js";
export * as idents from "./helpers/idents.js";
export * as sentinels from "./helpers/sentinels.js";
export type {
  /**
   * Named-corner bounding box returned by `spatial.parseBbox()`.
   *
   * Aliased because the root already exports {@link BBox}, the `[lat1, lon1, lat2,
   * lon2]` tuple accepted by the `bbox` request parameters; inside
   * `skylink-api/spatial` this type is simply `BBox`.
   */
  BBox as SpatialBBox,
  LatLon,
  PointLike,
  PointObject,
  TrackStats,
} from "./helpers/spatial.js";
export * as spatial from "./helpers/spatial.js";
export type { Altimeter, NumericInput, Visibility } from "./helpers/units.js";
export * as units from "./helpers/units.js";
export type { FlightCategory, WindComponents } from "./helpers/weather.js";
export * as weatherHelpers from "./helpers/weather.js";
export {
  AIRPORT_BRIEF_PARTS,
  FLIGHT_BRIEF_PARTS,
  ROUTE_BRIEF_PARTS,
} from "./models/compose.js";
export type * from "./models/index.js";
export {
  DEFAULT_ITER_PAGE_SIZE,
  type IterAircraftOptions,
  MAX_ITER_PAGE_SIZE,
} from "./resources/adsb.js";
export type { BatchOptions, BatchWeatherOptions } from "./resources/batch.js";
export {
  type AirportBriefOptions,
  Compose,
  DEFAULT_MAX_LOOKUPS,
  DEFAULT_SCHEDULES_LIMIT,
  type EnrichAdsbOptions,
  type FlightBriefOptions,
  type PartSelection,
  type RouteBriefOptions,
  type SchedulesWithStatusOptions,
} from "./resources/compose.js";
export {
  DEFAULT_ITER_WINDOW_DAYS,
  HISTORY_MAX_WINDOW_DAYS,
  type IterFlightsOptions,
} from "./resources/history.js";
export {
  DEFAULT_ADSB_INTERVAL_MS,
  DEFAULT_FLIGHT_STATUS_INTERVAL_MS,
  isTerminalFlightStatus,
  Poll,
  type PollAdsbOptions,
  type PollFlightStatusOptions,
  type PollOptions,
  type SleepFn,
  TERMINAL_FLIGHT_STATUSES,
} from "./resources/poll.js";
export type { WebhookEnsureOptions } from "./resources/webhooks.js";
export { VERSION } from "./version.js";
