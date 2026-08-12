/**
 * Navaid models: VOR, NDB, ILS, DME and TACAN records from the OurAirports dataset.
 *
 * Field names mirror the wire format exactly — including `usageType`, the single
 * camelCase field in the whole API. Every type here is compile-time only: the SDK
 * never validates or reshapes a response body.
 */

import type { BBoxInput } from "./common.js";

/** One navigation aid. */
export interface Navaid {
  /** OurAirports row id. */
  id: number | null;
  /** Navaid identifier, e.g. `"JFK"`. */
  ident: string | null;
  name: string | null;
  /** Navaid type, e.g. `"VOR"`, `"NDB"`, `"ILS"`, `"DME"`, `"TACAN"`, `"VOR-DME"`. */
  type: string | null;
  /** Kilohertz, e.g. `115900` for 115.9 MHz. */
  frequency_khz: number | null;
  latitude_deg: number | null;
  longitude_deg: number | null;
  /** Feet above mean sea level. */
  elevation_ft: number | null;
  /** ISO 3166-1 alpha-2 code. */
  iso_country: string | null;
  /** Kilohertz of the collocated DME, `null` when there is none. */
  dme_frequency_khz: number | null;
  /** DME channel, e.g. `"106X"`. */
  dme_channel: string | null;
  slaved_variation_deg: number | null;
  magnetic_variation_deg: number | null;
  /**
   * Usage class, e.g. `"HI"`, `"LO"`, `"TERMINAL"`, `"BOTH"`.
   *
   * The only camelCase field the API sends; kept verbatim rather than renamed.
   */
  usageType: string | null;
  /** Transmitter power class, e.g. `"HIGH"`, `"MEDIUM"`, `"LOW"`. */
  power: string | null;
  /** ICAO code of the airport this navaid serves. */
  associated_airport: string | null;
}

/**
 * Echo of the filters the search actually applied.
 *
 * Only the filters that were supplied appear as keys, normalized the way the API
 * matched them: `airport`, `type` and `country` come back upper-cased. `limit` is
 * never echoed here.
 */
export interface NavaidFiltersApplied {
  /** The `ident` substring as sent (matching is case-insensitive). */
  ident?: string;
  /** Associated airport ICAO code, upper-cased. */
  airport?: string;
  /** Navaid type, upper-cased. */
  type?: string;
  /** ISO country code, upper-cased. */
  country?: string;
  /** Re-joined from the parsed floats, e.g. `"40.0,-74.5,41.0,-73.5"`. */
  bbox?: string;
}

/** Response of `navaids.list()`. */
export interface NavaidsResponse {
  navaids: Navaid[];
  /** Matches before `limit` was applied, so it can exceed `navaids.length`. */
  total: number;
  filters_applied: NavaidFiltersApplied;
}

/**
 * Parameters of `navaids.list()`.
 *
 * At least one of `ident`, `airport`, `type`, `country` or `bbox` is required —
 * the SDK rejects an unfiltered call before it reaches the network, matching the
 * API's own 400.
 */
export interface NavaidsListParams {
  /** Identifier substring, case-insensitive, e.g. `"JFK"`. */
  ident?: string;
  /** Associated airport ICAO code, exact match, e.g. `"KJFK"`. */
  airport?: string;
  /** Navaid type, exact and case-insensitive, e.g. `"VOR"`. */
  type?: string;
  /** ISO 3166-1 alpha-2 country code, exact match, e.g. `"US"`. */
  country?: string;
  /** Bounding box, south-west corner first. */
  bbox?: BBoxInput;
  /** Maximum results, 1–500. Defaults to `100`. */
  limit?: number;
}
