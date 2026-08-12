/**
 * Aviation weather models: METAR, TAF, winds aloft, PIREPs and AIRMET/SIGMET.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

import type { BBoxInput } from "./common.js";

// ---------------------------------------------------------------------------
// METAR / TAF
// ---------------------------------------------------------------------------

/**
 * Flight rules category derived from ceiling and visibility.
 *
 * `VFR` > 3000 ft / 5 sm, `MVFR` 1000–3000 ft / 3–5 sm, `IFR` 500–1000 ft / 1–3 sm,
 * `LIFR` below that.
 */
export type FlightRules = "VFR" | "MVFR" | "IFR" | "LIFR";

/**
 * A decoded numeric token as emitted by the upstream parser: the original text
 * (`repr`), its numeric value and a spoken-word rendering.
 */
export interface DecodedNumber {
  repr: string | null;
  value: number | null;
  spoken: string | null;
}

/** Wind group of a METAR or of a single TAF forecast period. */
export interface ParsedWind {
  /** Direction in degrees true, `null` when variable or missing. */
  direction: number | null;
  /** Sustained speed in knots. */
  speed: number | null;
  /** Gust speed in knots, `null` when no gusts were reported. */
  gust: number | null;
  /**
   * Variable-direction bounds (the `180V240` group), as decoded numbers.
   * Empty when the wind is steady.
   */
  variable: DecodedNumber[] | null;
}

/** Visibility group: the numeric value plus the original encoded text. */
export interface ParsedVisibility {
  /** Statute miles (US) or meters (ICAO), matching the source report. */
  value: number | null;
  /** Original encoded token, e.g. `"10SM"` or `"9999"`. */
  repr: string | null;
}

/** A single reported cloud layer. */
export interface CloudLayer {
  /** Coverage code, e.g. `"FEW"`, `"SCT"`, `"BKN"`, `"OVC"`. */
  type: string | null;
  /** Layer base in hundreds of feet AGL, e.g. `24` for 2 400 ft. */
  base: number | null;
  /** Original encoded token, e.g. `"FEW024"`. */
  repr: string | null;
}

/** A present-weather code such as `-RA` or `BR`, with its expanded meaning. */
export interface WeatherCode {
  /** Original encoded token, e.g. `"-RA"`. */
  repr: string | null;
  /** Expanded description, e.g. `"Light Rain"`. */
  value: string | null;
}

/** Decoded METAR body, returned under `parsed` when `{ parsed: true }` is requested. */
export interface ParsedMetar {
  wind: ParsedWind;
  visibility: ParsedVisibility | null;
  clouds: CloudLayer[];
  /** Degrees Celsius. */
  temperature: number | null;
  /** Degrees Celsius. */
  dewpoint: number | null;
  /** Altimeter setting: inHg (US) or hPa (ICAO), matching the source report. */
  altimeter: number | null;
  flight_rules: FlightRules | null;
  wx_codes: WeatherCode[];
  /** Free-text remarks section (everything after `RMK`). */
  remarks: string | null;
  /** ISO 8601 observation time. */
  time: string | null;
  /** Feet. */
  density_altitude: number | null;
  /** Feet. */
  pressure_altitude: number | null;
  /** Percent. */
  relative_humidity: number | null;
}

/** One forecast period of a TAF (the `FM`/`BECMG`/`TEMPO` groups). */
export interface TafForecastPeriod {
  /** Period type, e.g. `"FROM"`, `"BECMG"`, `"TEMPO"`. */
  type: string | null;
  /** ISO 8601 */
  start_time: string | null;
  /** ISO 8601 */
  end_time: string | null;
  wind: ParsedWind;
  visibility: ParsedVisibility | null;
  clouds: CloudLayer[];
  wx_codes: WeatherCode[];
  flight_rules: FlightRules | null;
  /** Probability group (`PROB30`/`PROB40`) as a decoded number, `null` when absent. */
  probability: DecodedNumber | null;
  /** Turbulence groups, rendered as text. */
  turbulence: string[];
  /** Icing groups, rendered as text. */
  icing: string[];
}

/** Decoded TAF body, returned under `parsed` when `{ parsed: true }` is requested. */
export interface ParsedTaf {
  /** ISO 8601 start of the forecast validity window. */
  start_time: string | null;
  /** ISO 8601 end of the forecast validity window. */
  end_time: string | null;
  forecast: TafForecastPeriod[];
}

/** Envelope common to the METAR and TAF endpoints. */
export interface WeatherReport {
  /** Raw report text, `null` when the station reported nothing. */
  raw: string | null;
  /** ICAO code that was queried, upper-cased by the API. */
  icao: string;
  airport_name: string | null;
  /** ISO 8601 time the report was retrieved. */
  timestamp: string | null;
}

/** Response of `weather.metar(icao)`. */
export type MetarResponse = WeatherReport;

/**
 * Response of `weather.metar(icao, { parsed: true })`.
 *
 * `parsed` is `null` when the upstream decoder could not make sense of the raw
 * report — the raw text is still returned.
 */
export interface ParsedMetarResponse extends WeatherReport {
  parsed: ParsedMetar | null;
}

/** Response of `weather.taf(icao)`. */
export type TafResponse = WeatherReport;

/**
 * Response of `weather.taf(icao, { parsed: true })`.
 *
 * `parsed` is `null` when the upstream decoder could not make sense of the raw
 * forecast — the raw text is still returned.
 */
export interface ParsedTafResponse extends WeatherReport {
  parsed: ParsedTaf | null;
}

/** Parameters of `weather.metar()`. */
export interface MetarParams {
  /** Include the decoded `parsed` block alongside the raw text. Defaults to `false`. */
  parsed?: boolean;
}

/** Parameters of `weather.taf()`. */
export interface TafParams {
  /** Include the decoded `parsed` block alongside the raw text. Defaults to `false`. */
  parsed?: boolean;
}

// ---------------------------------------------------------------------------
// Winds aloft
// ---------------------------------------------------------------------------

/** Forecast period of the FB winds product, in hours. */
export type WindsAloftForecastHour = 6 | 12 | 24;

/** Altitude band: `low` covers 3 000–39 000 ft, `high` covers 6 000–45 000 ft. */
export type WindsAloftLevel = "low" | "high";

/** Wind and temperature forecast at one altitude. */
export interface WindLevel {
  /** Altitude in feet MSL. */
  altitude_ft: number;
  /** Direction in degrees true. */
  wind_direction: number | null;
  wind_speed_kt: number | null;
  temperature_c: number | null;
  /** `true` when the level was encoded as light and variable (< 5 kt). */
  light_and_variable: boolean;
  /** Raw encoded group for this level, e.g. `"2709"`. */
  raw: string;
}

/** One FB winds reporting station and its forecast levels. */
export interface WindsAloftStation {
  /** Three-letter FB winds station identifier, e.g. `"JFK"`. */
  station: string;
  latitude: number;
  longitude: number;
  winds: WindLevel[];
  /** Full raw FB winds line for this station. */
  raw_text: string | null;
}

/** Response of `weather.windsAloft()`. */
export interface WindsAloftResponse {
  /** Bounding box that was queried, as `"lat1,lon1,lat2,lon2"`. */
  bbox: string;
  forecast_hour: WindsAloftForecastHour;
  level: WindsAloftLevel;
  /** Forecast validity time in the FB format, e.g. `"130000Z"`. Not ISO 8601. */
  valid_time: string | null;
  stations: WindsAloftStation[];
  total: number;
}

/** Parameters of `weather.windsAloft()`. */
export interface WindsAloftParams {
  /** Required bounding box, south-west corner first. */
  bbox: BBoxInput;
  /** Forecast period in hours. Defaults to `12`. */
  forecast?: WindsAloftForecastHour;
  /** Altitude band. Defaults to `"low"`. */
  level?: WindsAloftLevel;
}

// ---------------------------------------------------------------------------
// PIREPs
// ---------------------------------------------------------------------------

/** `UA` = routine pilot report, `UUA` = urgent (significant hazard). */
export type PirepReportType = "UA" | "UUA";

/**
 * A single pilot report.
 *
 * Every decoded field is an opaque string: altitudes (`"FL085"`), temperatures and
 * winds are reported in their encoded form and are deliberately not parsed here.
 */
export interface PirepReport {
  /** Raw PIREP text. */
  raw: string;
  report_type: PirepReportType | null;
  /** Station identifier, or a bearing/distance from a navaid. */
  location: string | null;
  /** Observation time as reported (UTC); format varies by source. */
  time: string | null;
  /** Flight level or altitude, e.g. `"FL085"`. */
  altitude: string | null;
  /** Aircraft type code, e.g. `"B738"`. */
  aircraft_type: string | null;
  sky_conditions: string | null;
  /** Turbulence intensity and type, e.g. `"Moderate"`. */
  turbulence: string | null;
  /** Icing intensity and type. */
  icing: string | null;
  /** Outside air temperature as reported. */
  temperature: string | null;
  /** Wind direction and speed as reported. */
  wind: string | null;
  remarks: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Response of `weather.pireps()`. */
export interface PirepsResponse {
  /** Bounding box that was queried, as `"lat1,lon1,lat2,lon2"`. */
  bbox: string;
  hours: number;
  reports: PirepReport[];
  total: number;
}

/** Parameters of `weather.pireps()`. */
export interface PirepsParams {
  /** Required bounding box, south-west corner first. */
  bbox: BBoxInput;
  /** How far back to look, in hours (1–24). Defaults to `2`. */
  hours?: number;
}

// ---------------------------------------------------------------------------
// AIRMET / SIGMET
// ---------------------------------------------------------------------------

/** Advisory kind accepted by the `type` filter. */
export type AirSigmetType = "airmet" | "sigmet";

/** One vertex of an advisory boundary polygon. */
export interface AirSigmetCoord {
  lat: number;
  lon: number;
}

/** Movement of the affected area. Both fields are reported as text. */
export interface AirSigmetMovement {
  /** Direction in degrees or as a compass token. */
  direction: string | null;
  speed: string | null;
}

/**
 * Conditions attached to an advisory. The same shape fills two roles: `observation`
 * (currently observed) and `forecast` (expected).
 */
export interface AirSigmetObservation {
  /** Phenomenon, e.g. `"TURB"`, `"ICE"`, `"IFR"`. */
  type: string | null;
  /** Intensity, e.g. `"MOD"`, `"SEV"`. */
  intensity: string | null;
  /** Lower altitude bound, e.g. `"SFC"`. */
  floor: string | null;
  /** Upper altitude bound, e.g. `"FL180"`. */
  ceiling: string | null;
  coords: AirSigmetCoord[];
  movement: AirSigmetMovement | null;
}

/** A single AIRMET, SIGMET or Convective SIGMET advisory. */
export interface AirSigmetReport {
  /** Raw advisory text. */
  raw: string;
  /** Bulletin type, e.g. `"AIRMET"` or `"SIGMET"`. */
  bulletin_type: string | null;
  /** Issuing country code. */
  country: string | null;
  /** Issuing authority. */
  issuer: string | null;
  /** Affected area identifier, e.g. `"S"`. */
  area: string | null;
  /** Advisory type, e.g. `"AIRMET"`, `"SIGMET"`, `"CONVECTIVE SIGMET"`. */
  report_type: string | null;
  /** Valid-from time as reported (UTC); format varies by issuer. */
  start_time: string | null;
  /** Valid-until time as reported (UTC); format varies by issuer. */
  end_time: string | null;
  /** Advisory body text. */
  body: string | null;
  /** Affected FIR or region. */
  region: string | null;
  observation: AirSigmetObservation | null;
  forecast: AirSigmetObservation | null;
}

/** Response of `weather.airsigmet()`. */
export interface AirSigmetResponse {
  /** Bounding box that was queried, as `"lat1,lon1,lat2,lon2"`. */
  bbox: string;
  reports: AirSigmetReport[];
  total: number;
  /** Type filter that was applied, `null` when unfiltered. */
  filter_type: AirSigmetType | null;
}

/** Parameters of `weather.airsigmet()`. */
export interface AirSigmetParams {
  /** Required bounding box, south-west corner first. */
  bbox: BBoxInput;
  /** Restrict the result to one advisory kind. Unset returns both. */
  type?: AirSigmetType;
}
