/**
 * Airport models: enriched code lookup plus the three search modes
 * (coordinates, IP geolocation, free text).
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 *
 * The enriched lookup passes whole OurAirports CSV rows through untouched. Columns
 * the API documents are typed as always-present (`T | null`); the remaining
 * pass-through columns are marked optional, since the dataset owns them.
 *
 * **Numbers that may arrive as strings.** The enriched payload is forwarded from the
 * upstream CSVs with no normalization: the API loads them with pandas, so a column
 * that parses cleanly as a number (`frequency_mhz`, `frequency_khz`, `lighted`,
 * `closed`) comes back as one, while the published examples — and any deployment
 * whose CSV snapshot has a stray non-numeric row — show the same fields as strings.
 * Those fields are therefore typed `string | number | null` and handed over exactly
 * as received; coerce at the call site:
 *
 * ```ts
 * const mhz = freq.frequency_mhz === null ? null : Number(freq.frequency_mhz);
 * ```
 *
 * `scheduled_service` is the same story with `"yes"` / `"no"` instead of a boolean.
 */

import type { Country, Region } from "./geo.js";

/**
 * Airport classification, as used by the `type` filter and reported on every record.
 *
 * These are the seven values of the OurAirports `type` column.
 */
export type AirportType =
  | "large_airport"
  | "medium_airport"
  | "small_airport"
  | "heliport"
  | "seaplane_base"
  | "closed"
  | "balloonport";

/** `scheduled_service` flag — the dataset encodes it as a string, not a boolean. */
export type ScheduledService = "yes" | "no";

/** Which kind of code the enriched search matched on. */
export type AirportSearchType = "ICAO" | "IATA";

// ---------------------------------------------------------------------------
// Base record
// ---------------------------------------------------------------------------

/** An airport record as stored in the OurAirports dataset. */
export interface Airport {
  /** OurAirports row id. */
  id: number;
  /** Airport identifier, usually the ICAO code, e.g. `"KJFK"`. */
  ident: string;
  type: AirportType;
  name: string;
  latitude_deg: number | null;
  longitude_deg: number | null;
  /** Feet above mean sea level. */
  elevation_ft: number | null;
  continent: string | null;
  /** ISO 3166-1 alpha-2 code, e.g. `"US"`. */
  iso_country: string | null;
  /** ISO 3166-2 code, e.g. `"US-NY"`. */
  iso_region: string | null;
  municipality: string | null;
  /** `"yes"` / `"no"` — a boolean delivered as a string. */
  scheduled_service: ScheduledService | null;
  /** Official ICAO code, when the dataset distinguishes it from `ident`. */
  icao_code: string | null;
  gps_code: string | null;
  /** Three-letter IATA code, e.g. `"JFK"`. */
  iata_code: string | null;
  local_code: string | null;
  home_link: string | null;
  wikipedia_link: string | null;
  /** Comma-separated alternate names and search keywords. */
  keywords: string | null;
}

// ---------------------------------------------------------------------------
// Enriched lookup (`airports.search`)
// ---------------------------------------------------------------------------

/**
 * One runway of an airport.
 *
 * `lighted` and `closed` are `1` / `0` flags rather than booleans — the CSV values
 * are passed through as they are stored, which makes them a number on the live API
 * and a numeric string (`"1"` / `"0"`) in the published examples. Compare with
 * `String(runway.lighted) === "1"`.
 */
export interface AirportRunway {
  length_ft: number | null;
  width_ft: number | null;
  /** Surface code, e.g. `"ASP"` (asphalt), `"CON"`, `"PEM"`. */
  surface: string | null;
  /** `1` when lit, `0` when not. A boolean delivered as a number, or as `"1"`/`"0"`. */
  lighted: string | number | null;
  /** `1` when closed, `0` when in use. A boolean delivered as a number, or as `"1"`/`"0"`. */
  closed: string | number | null;
  /** Low-end designator, e.g. `"04L"`. */
  le_ident: string | null;
  /** High-end designator, e.g. `"22R"`. */
  he_ident: string | null;
  /** OurAirports row id. */
  id?: number | null;
  airport_ref?: number | null;
  airport_ident?: string | null;
  le_latitude_deg?: number | null;
  le_longitude_deg?: number | null;
  le_elevation_ft?: number | null;
  /** Low-end true heading in degrees. */
  le_heading_degT?: number | null;
  le_displaced_threshold_ft?: number | null;
  he_latitude_deg?: number | null;
  he_longitude_deg?: number | null;
  he_elevation_ft?: number | null;
  /** High-end true heading in degrees. */
  he_heading_degT?: number | null;
  he_displaced_threshold_ft?: number | null;
}

/** One communication frequency of an airport. */
export interface AirportFrequency {
  /** OurAirports row id. */
  id: number | null;
  /** Service code, e.g. `"TWR"`, `"GND"`, `"ATIS"`. */
  type: string | null;
  description: string | null;
  /** Megahertz, e.g. `125.7` — or `"119.1"` as a string. Never coerced. */
  frequency_mhz: string | number | null;
  airport_ref: number | null;
}

/**
 * A navaid as embedded in an enriched airport record.
 *
 * Distinct from the `Navaid` of the `/navaids` endpoint: this one is a raw CSV
 * pass-through, so its frequencies may arrive as strings rather than numbers.
 */
export interface EnrichedNavaid {
  /** Navaid identifier, e.g. `"JFK"`. */
  ident: string | null;
  name: string | null;
  /** Navaid type, e.g. `"VOR-DME"`, `"NDB"`, `"ILS"`. */
  type: string | null;
  /** Kilohertz, e.g. `112300` — or `"115900"` as a string. Never coerced. */
  frequency_khz: string | number | null;
  /** OurAirports row id. */
  id?: number | null;
  filename?: string | null;
  latitude_deg?: number | null;
  longitude_deg?: number | null;
  elevation_ft?: number | null;
  iso_country?: string | null;
  dme_frequency_khz?: string | number | null;
  dme_channel?: string | null;
  dme_latitude_deg?: number | null;
  dme_longitude_deg?: number | null;
  dme_elevation_ft?: number | null;
  slaved_variation_deg?: number | null;
  magnetic_variation_deg?: number | null;
  /** The single camelCase field in the whole API — kept as sent. */
  usageType?: string | null;
  /** Transmitter power class, e.g. `"HIGH"`, `"MEDIUM"`. */
  power?: string | null;
  /** ICAO code of the airport this navaid serves. */
  associated_airport?: string | null;
}

/**
 * Response of `airports.search()` — the base airport record enriched with its
 * runways, frequencies, navaids and the country/region it belongs to.
 */
export interface EnrichedAirport extends Airport {
  runways: AirportRunway[];
  frequencies: AirportFrequency[];
  /** Country record for `iso_country`, `null` when the code is not in the dataset. */
  country: Country | null;
  /** Region record for `iso_region`, `null` when the code is not in the dataset. */
  region: Region | null;
  navaids: EnrichedNavaid[];
  /** The code that was searched for, upper-cased and trimmed by the API. */
  search_code: string;
  /** Which parameter the lookup used. */
  search_type: AirportSearchType;
}

/**
 * Parameters of `airports.search()` — exactly one of `icao` / `iata`.
 *
 * Passing both (or neither) is a 400 from the API, so the union rules it out at
 * compile time.
 */
export type AirportSearchParams =
  | {
      /** Four-letter ICAO code, e.g. `"KJFK"`. */
      icao: string;
      iata?: never;
    }
  | {
      /** Three-letter IATA code, e.g. `"JFK"`. */
      iata: string;
      icao?: never;
    };

// ---------------------------------------------------------------------------
// Search by location
// ---------------------------------------------------------------------------

/** An airport plus its great-circle distance from the search point. */
export interface AirportWithDistance {
  id: number;
  ident: string;
  type: AirportType;
  name: string;
  latitude_deg: number | null;
  longitude_deg: number | null;
  elevation_ft: number | null;
  municipality: string | null;
  iso_country: string | null;
  iso_region: string | null;
  iata_code: string | null;
  /** Kilometers from the search location. Results are sorted by this, nearest first. */
  distance_km: number;
}

/** Echo of the coordinates and filters a location search ran with. */
export interface AirportSearchLocation {
  latitude: number;
  longitude: number;
  radius_km: number;
  /** The `type` filter that was applied, `null` when unfiltered. */
  type_filter: AirportType | null;
}

/** Response of `airports.nearby()`. */
export interface AirportsNearbyResponse {
  search_location: AirportSearchLocation;
  airports: AirportWithDistance[];
  airports_found: number;
}

/** Parameters of `airports.nearby()`. */
export interface AirportsNearbyParams {
  /** Latitude in decimal degrees, −90 to 90. */
  lat: number;
  /** Longitude in decimal degrees, −180 to 180. */
  lon: number;
  /** Search radius in kilometers, over 0 and up to 500. Defaults to `50`. */
  radius?: number;
  /** Restrict the result to one airport type. */
  type?: AirportType;
  /** Maximum results, 1–200. Defaults to `50`. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Search by IP
// ---------------------------------------------------------------------------

/** Geolocation of an IP address, as resolved by the upstream provider. */
export interface LocationData {
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  /** Region or state name (not an ISO code). */
  region: string | null;
  /** Country name. */
  country: string | null;
  /** ISO 3166-1 alpha-2 code. */
  country_code: string | null;
  postal: string | null;
  /** IANA timezone identifier, e.g. `"America/Chicago"`. */
  timezone: string | null;
  ip: string | null;
}

/**
 * Response of `airports.byIp()`.
 *
 * A failed geolocation is **not** an exception: the API answers 200 with `error`
 * set, `location` `null` and an empty `airports` list.
 */
export interface AirportsByIpResponse {
  /** The IP that was geolocated — the explicit `ip` parameter, or the caller's own. */
  ip_address: string;
  location: LocationData | null;
  airports: AirportWithDistance[];
  search_radius_km: number;
  airports_found: number;
  /** Why geolocation failed, `null` on success. Delivered inside a 200 response. */
  error: string | null;
}

/** Parameters of `airports.byIp()`. */
export interface AirportsByIpParams {
  /** IP address to geolocate. Defaults to the IP the request came from. */
  ip?: string;
  /** Search radius in kilometers, over 0 and up to 500. Defaults to `100`. */
  radius?: number;
  /** Restrict the result to one airport type. */
  type?: AirportType;
  /** Maximum results, 1–200. Defaults to `50`. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Free-text search
// ---------------------------------------------------------------------------

/** An airport plus the score that ranked it in a text search. */
export interface AirportWithRelevance {
  id: number;
  ident: string;
  type: AirportType;
  name: string;
  latitude_deg: number | null;
  longitude_deg: number | null;
  municipality: string | null;
  iso_country: string | null;
  iata_code: string | null;
  /** Higher is a better match; exact code matches rank highest. */
  relevance_score: number;
}

/** Response of `airports.searchText()`. */
export interface AirportsTextSearchResponse {
  /** The query that was searched for. */
  query: string;
  airports: AirportWithRelevance[];
  airports_found: number;
}

/** Parameters of `airports.searchText()`. */
export interface AirportsTextSearchParams {
  /** Free-text query: name, city, ICAO/IATA code, country or keyword. 2–100 characters. */
  q: string;
  /** Maximum results, 1–100. Defaults to `20`. */
  limit?: number;
  /** Restrict the result to one airport type. */
  type?: AirportType;
}
