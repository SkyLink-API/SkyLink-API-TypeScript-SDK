/**
 * `sky.weather` — aviation weather: METAR, TAF, winds aloft, PIREPs, AIRMET/SIGMET.
 *
 * ```ts
 * const metar = await sky.weather.metar("KJFK", { parsed: true });
 * console.log(metar.parsed?.flight_rules, metar.raw);
 * ```
 */

import { formatBBox } from "../core/query.js";
import type { RequestOptions } from "../core/types.js";
import type {
  AirSigmetParams,
  AirSigmetResponse,
  MetarParams,
  MetarResponse,
  ParsedMetarResponse,
  ParsedTafResponse,
  PirepsParams,
  PirepsResponse,
  TafParams,
  TafResponse,
  WindsAloftParams,
  WindsAloftResponse,
} from "../models/weather.js";
import { APIResource, encodePathParam } from "./base.js";

/** Aviation weather endpoints. */
export class Weather extends APIResource {
  /**
   * Current METAR observation for an airport, decoded into structured fields.
   *
   * `parsed` is `null` when the upstream decoder could not read the raw report.
   *
   * `GET /weather/metar/{icao}?parsed=true`
   *
   * @param icao - Four-letter ICAO code, e.g. `"KJFK"`.
   */
  metar(
    icao: string,
    params: MetarParams & { parsed: true },
    options?: RequestOptions,
  ): Promise<ParsedMetarResponse>;
  /**
   * Current METAR observation for an airport, as raw text.
   *
   * Pass `{ parsed: true }` to also receive the decoded fields.
   *
   * `GET /weather/metar/{icao}`
   *
   * @param icao - Four-letter ICAO code, e.g. `"KJFK"`.
   */
  metar(icao: string, params?: MetarParams, options?: RequestOptions): Promise<MetarResponse>;
  metar(
    icao: string,
    params: MetarParams = {},
    options?: RequestOptions,
  ): Promise<MetarResponse | ParsedMetarResponse> {
    return this.get(
      `/weather/metar/${encodePathParam(icao, "icao")}`,
      { parsed: params.parsed },
      options,
    );
  }

  /**
   * Terminal Aerodrome Forecast for an airport, decoded into forecast periods.
   *
   * `parsed` is `null` when the upstream decoder could not read the raw forecast.
   *
   * `GET /weather/taf/{icao}?parsed=true`
   *
   * @param icao - Four-letter ICAO code, e.g. `"KJFK"`.
   */
  taf(
    icao: string,
    params: TafParams & { parsed: true },
    options?: RequestOptions,
  ): Promise<ParsedTafResponse>;
  /**
   * Terminal Aerodrome Forecast for an airport, as raw text.
   *
   * Pass `{ parsed: true }` to also receive the decoded forecast periods.
   *
   * `GET /weather/taf/{icao}`
   *
   * @param icao - Four-letter ICAO code, e.g. `"KJFK"`.
   */
  taf(icao: string, params?: TafParams, options?: RequestOptions): Promise<TafResponse>;
  taf(
    icao: string,
    params: TafParams = {},
    options?: RequestOptions,
  ): Promise<TafResponse | ParsedTafResponse> {
    return this.get(
      `/weather/taf/${encodePathParam(icao, "icao")}`,
      { parsed: params.parsed },
      options,
    );
  }

  /**
   * Winds and temperatures aloft (FAA FB winds) for every station in a bounding box.
   *
   * US coverage only. Responds 404 when no station falls inside the box.
   *
   * `GET /weather/winds-aloft?bbox&forecast&level`
   */
  windsAloft(params: WindsAloftParams, options?: RequestOptions): Promise<WindsAloftResponse> {
    return this.get(
      "/weather/winds-aloft",
      {
        bbox: formatBBox(params.bbox),
        forecast: params.forecast,
        level: params.level,
      },
      options,
    );
  }

  /**
   * Pilot reports (turbulence, icing, sky conditions) filed inside a bounding box.
   *
   * `GET /weather/pireps?bbox&hours`
   */
  pireps(params: PirepsParams, options?: RequestOptions): Promise<PirepsResponse> {
    return this.get(
      "/weather/pireps",
      {
        bbox: formatBBox(params.bbox),
        hours: params.hours,
      },
      options,
    );
  }

  /**
   * AIRMET/SIGMET advisories whose affected area intersects a bounding box.
   *
   * Omit `type` to receive both kinds.
   *
   * `GET /weather/airsigmet?bbox&type`
   */
  airsigmet(params: AirSigmetParams, options?: RequestOptions): Promise<AirSigmetResponse> {
    return this.get(
      "/weather/airsigmet",
      {
        bbox: formatBBox(params.bbox),
        type: params.type,
      },
      options,
    );
  }
}
