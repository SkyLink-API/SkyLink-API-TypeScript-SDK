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
 */

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
   * `GET /briefing/flight?origin&destination&include_weather&include_notams&include_pireps`
   */
  flight(
    params: BriefingParams & { format?: "json" },
    options?: RequestOptions,
  ): Promise<FlightBriefing>;
  async flight(params: BriefingParams, options?: RequestOptions): Promise<FlightBriefing | string> {
    const body = await this.get<FlightBriefing | FlightBriefingText>(
      "/briefing/flight",
      {
        origin: params.origin,
        destination: params.destination,
        include_weather: params.include_weather,
        include_notams: params.include_notams,
        include_pireps: params.include_pireps,
        format: params.format,
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
      },
      options,
    );
  }
}
