/**
 * AI-generated preflight briefing models.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

// ---------------------------------------------------------------------------
// Structured briefing (format=json)
// ---------------------------------------------------------------------------

/** Rendering of `briefing.flight()`. `json` yields a structured object, the rest a string. */
export type BriefingFormat = "json" | "markdown" | "plain_text" | "html";

/** The formats that render the briefing as one block of text instead of a structure. */
export type BriefingTextFormat = "markdown" | "plain_text" | "html";

/** Weather block of an airport briefing. Absent sources come back as `null`. */
export interface BriefingWeather {
  /** Raw METAR text. */
  metar_raw: string | null;
  /** Raw TAF text. */
  taf_raw: string | null;
  /** Plain-language summary of the current conditions. */
  conditions: string | null;
}

/** A NOTAM rewritten by the model into operational plain language. */
export interface BriefingNotam {
  /** Short title, e.g. `"Taxiway B closed"`. */
  title: string;
  /** Plain-language operational explanation. */
  description: string;
  /** Affected element, e.g. `"TWY B"`. */
  affected: string | null;
  /** NOTAM identifier, e.g. `"01/234"`. */
  notam_id: string | null;
}

/** A pilot report near the airport, with the model's summary of it. */
export interface BriefingPirep {
  /** Raw PIREP text. */
  raw: string;
  /** Plain-language summary. */
  summary: string;
}

/** An item that could prevent or significantly alter the flight. */
export interface BriefingRestriction {
  /** ICAO code of the airport the restriction applies to. */
  icao: string;
  /** Plain-language description of the restriction. */
  description: string;
  /** Affected element, e.g. `"RWY 29"`. */
  affected: string | null;
  /** NOTAM identifier, when the restriction came from a NOTAM. */
  notam_id: string | null;
}

/**
 * Per-airport section of a structured briefing.
 *
 * `notams` and `pireps` are **nullable arrays**: they are `null` — not `[]` — when
 * the corresponding source was excluded from the request (`include_notams: false`,
 * `include_pireps: false`, the default). An empty array means the source was
 * consulted and had nothing to report. Distinguish the two before rendering.
 */
export interface AirportBriefing {
  /** Airport ICAO code. */
  icao: string;
  /** `null` when `include_weather: false` was requested. */
  weather: BriefingWeather | null;
  /** `null` when NOTAMs were excluded; `[]` when none are active. */
  notams: BriefingNotam[] | null;
  /** `null` when PIREPs were excluded; `[]` when none were filed. */
  pireps: BriefingPirep[] | null;
}

/** Response of `briefing.flight()` with the default `format: "json"`. */
export interface FlightBriefing {
  /** Origin ICAO code, upper-cased by the API. */
  origin: string;
  /** Destination ICAO code, upper-cased by the API. */
  destination: string;
  /** Two to three sentence overview of the flight. */
  summary: string;
  /** Items that could prevent or significantly alter the flight; `[]` when none. */
  critical_restrictions: BriefingRestriction[];
  origin_briefing: AirportBriefing;
  destination_briefing: AirportBriefing;
  /** Sources that fed the briefing, e.g. `["metar", "taf", "notams"]`. */
  data_included: string[];
  /** Legal disclaimer; the API always fills it in. */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Text briefing (format=markdown|plain_text|html)
// ---------------------------------------------------------------------------

/**
 * Raw envelope the API returns for the text formats.
 *
 * `briefing.flight()` unwraps this and resolves to {@link FlightBriefingText.briefing}
 * directly — the type is exported for callers who reach for `client.request()`.
 */
export interface FlightBriefingText {
  /** Origin ICAO code, upper-cased by the API. */
  origin: string;
  /** Destination ICAO code, upper-cased by the API. */
  destination: string;
  /** Format that was requested. */
  format: BriefingTextFormat;
  /** The briefing itself, rendered in the requested format. */
  briefing: string;
  /** Sources that fed the briefing, e.g. `["metar", "taf", "notams"]`. */
  data_included: string[];
  /** Legal disclaimer; the API always fills it in. */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Parameters of `briefing.flight()`. */
export interface BriefingParams {
  /** Origin airport ICAO code (exactly 4 letters), e.g. `"KJFK"`. */
  origin: string;
  /** Destination airport ICAO code (exactly 4 letters), e.g. `"EGLL"`. */
  destination: string;
  /** Include METAR/TAF. Server-side default `true`. */
  include_weather?: boolean;
  /** Include active NOTAMs. Server-side default `true`. */
  include_notams?: boolean;
  /** Include PIREPs within 100 nm over the last 3 h. Server-side default `false`. */
  include_pireps?: boolean;
  /**
   * Output rendering. Server-side default `"json"`.
   *
   * `"json"` resolves to a {@link FlightBriefing}; every other value resolves to a
   * `string`.
   */
  format?: BriefingFormat;
}

/** Parameters of `briefing.pdf()`. */
export interface BriefingPdfParams {
  /** Departure airport ICAO code, e.g. `"EGLL"`. */
  departure_icao: string;
  /** Arrival airport ICAO code, e.g. `"KJFK"`. Must differ from the departure. */
  arrival_icao: string;
  /** Optional flight number printed in the document header, e.g. `"BA117"`. */
  flight_number?: string;
}
