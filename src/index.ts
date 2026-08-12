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

export { SkyLink } from "./client.js";
export type { ClientOptions, ResolvedConfig } from "./core/config.js";
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
export type { RateLimitInfo } from "./core/ratelimit.js";
export type { APIResponse } from "./core/transport.js";
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
export type * from "./models/index.js";
export { VERSION } from "./version.js";
