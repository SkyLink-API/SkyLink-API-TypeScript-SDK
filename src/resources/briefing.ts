/**
 * `sky.briefing` — AI-generated preflight briefings, structured or as a PDF.
 *
 * ```ts
 * const briefing = await sky.briefing.flight({ origin: "KJFK", destination: "EGLL" });
 * console.log(briefing.summary, briefing.origin_briefing.notams?.length);
 *
 * const markdown = await sky.briefing.flight({
 *   origin: "KJFK",
 *   destination: "EGLL",
 *   format: "markdown",
 * });
 * ```
 *
 * Both calls carry their own deadline. A briefing is written by a language model over
 * the weather and NOTAMs of two airports and takes tens of seconds — well past the
 * client-wide 30 s default — so every spec here sets {@link BRIEFING_TIMEOUT_MS}. It is
 * a default, not a ceiling: a per-call `{ timeout }` still wins.
 */

import { BRIEFING_TIMEOUT_MS } from "../core/config.js";
import type { RequestOptions } from "../core/types.js";
import type {
  BriefingParams,
  BriefingPdfParams,
  BriefingTextFormat,
  FlightBriefing,
  FlightBriefingText,
} from "../models/briefing.js";
import { APIResource } from "./base.js";

/** Preflight briefing endpoints. */
export class Briefing extends APIResource {
  /**
   * Briefing for a route, rendered as one block of text in the requested format.
   *
   * The API answers `application/json` for every format; this overload unwraps the
   * envelope and resolves to its `briefing` field. Use `client.request()` with
   * {@link FlightBriefingText} when the surrounding metadata is needed.
   *
   * `GET /briefing/flight?origin&destination&format=markdown`
   */
  flight(
    params: BriefingParams & { format: BriefingTextFormat },
    options?: RequestOptions,
  ): Promise<string>;
  /**
   * Structured briefing for a route: summary, critical restrictions and a
   * per-airport section for origin and destination.
   *
   * Note that `origin_briefing.notams` / `.pireps` are `null` — not `[]` — when the
   * matching source was excluded from the request.
   *
   * At least one of `include_weather`, `include_notams`, `include_pireps` must stay
   * enabled; the API answers 400 otherwise.
   *
   * **This is the slowest call in the SDK** — 30-85 s live, depending on `format`. It
   * runs with a 180 s deadline instead of the client's 30 s so a healthy request is not
   * aborted, retried three times, and failed after two minutes. Cap it yourself where
   * waiting that long is worse than no briefing:
   *
   * ```ts
   * await sky.briefing.flight(
   *   { origin: "KJFK", destination: "KLAX" },
   *   { timeout: 90_000, maxRetries: 0 },
   * );
   * ```
   *
   * `GET /briefing/flight?origin&destination&include_weather&include_notams&include_pireps`
   */
  flight(
    params: BriefingParams & { format?: "json" },
    options?: RequestOptions,
  ): Promise<FlightBriefing>;
  async flight(params: BriefingParams, options?: RequestOptions): Promise<FlightBriefing | string> {
    const body = await this.request<FlightBriefing | FlightBriefingText>(
      {
        method: "GET",
        path: "/briefing/flight",
        query: {
          origin: params.origin,
          destination: params.destination,
          include_weather: params.include_weather,
          include_notams: params.include_notams,
          include_pireps: params.include_pireps,
          format: params.format,
        },
        timeout: BRIEFING_TIMEOUT_MS,
      },
      options,
    );

    if (params.format === undefined || params.format === "json") {
      return body as FlightBriefing;
    }
    return (body as FlightBriefingText).briefing;
  }

  /**
   * Complete preflight briefing as a PDF document.
   *
   * The only binary endpoint in the API: the body is buffered, not streamed, and
   * resolves to the raw bytes (a `%PDF` magic number opens the file). The two
   * airports must differ, otherwise the API answers 422.
   *
   * Slow for the same reason as {@link flight} — ~50 s live — and runs with the same
   * 180 s deadline.
   *
   * `GET /briefing/pdf?departure_icao&arrival_icao&flight_number`
   */
  pdf(params: BriefingPdfParams, options?: RequestOptions): Promise<Uint8Array> {
    return this.request<Uint8Array>(
      {
        method: "GET",
        path: "/briefing/pdf",
        query: {
          departure_icao: params.departure_icao,
          arrival_icao: params.arrival_icao,
          flight_number: params.flight_number,
        },
        responseKind: "bytes",
        timeout: BRIEFING_TIMEOUT_MS,
      },
      options,
    );
  }
}
