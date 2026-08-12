/**
 * Geography models: ISO countries and regions from the OurAirports reference dataset.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * Continent code, as accepted by the `continent` filter and returned in records.
 *
 * `AF` Africa, `AN` Antarctica, `AS` Asia, `EU` Europe, `NA` North America,
 * `OC` Oceania, `SA` South America.
 *
 * **`NA` never comes back and never matches.** The API loads the reference CSV with
 * pandas, which reads the literal `NA` as "not available": every North-American
 * record arrives with `continent: null`, and `{ continent: "NA" }` filters down to
 * an empty list. Filter by `iso_country` instead when you mean North America.
 */
export type Continent = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** One country as it appears inside the list response of `geo.countries()`. */
export interface Country {
  /** OurAirports row id. */
  id: number | null;
  /** ISO 3166-1 alpha-2 code, e.g. `"US"`. */
  code: string | null;
  name: string | null;
  continent: Continent | null;
  wikipedia_link: string | null;
  /** Comma-separated alternate names, `null` when the dataset has none. */
  keywords: string | null;
}

/**
 * Response of `geo.country(code)`.
 *
 * The record is returned **flat** — its fields sit at the top level rather than
 * under a `country` key. Unlike a list element, `code` is always present: it is
 * the code that was looked up.
 */
export interface CountryDetail {
  id: number | null;
  /** ISO 3166-1 alpha-2 code, upper-cased by the API. */
  code: string;
  name: string | null;
  continent: Continent | null;
  wikipedia_link: string | null;
  keywords: string | null;
}

/** Response of `geo.countries()`. */
export interface CountriesResponse {
  countries: Country[];
  total: number;
}

/** Parameters of `geo.countries()`. */
export interface CountriesParams {
  /** Restrict the result to one continent. Unset returns every country. */
  continent?: Continent;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/** One region (state, province, territory) as it appears inside `geo.regions()`. */
export interface Region {
  /** OurAirports row id. */
  id: number | null;
  /** ISO 3166-2 code, e.g. `"US-CA"`. */
  code: string | null;
  /** Subdivision part of the code without the country prefix, e.g. `"CA"`. */
  local_code: string | null;
  name: string | null;
  continent: Continent | null;
  /** ISO 3166-1 alpha-2 code of the owning country. */
  iso_country: string | null;
  wikipedia_link: string | null;
  keywords: string | null;
}

/**
 * Response of `geo.region(code)`.
 *
 * Flat, like {@link CountryDetail}: the record's fields sit at the top level and
 * `code` is always present.
 */
export interface RegionDetail {
  id: number | null;
  /** ISO 3166-2 code, upper-cased by the API. */
  code: string;
  local_code: string | null;
  name: string | null;
  continent: Continent | null;
  iso_country: string | null;
  wikipedia_link: string | null;
  keywords: string | null;
}

/** Response of `geo.regions()`. */
export interface RegionsResponse {
  regions: Region[];
  total: number;
}

/** Parameters of `geo.regions()`. */
export interface RegionsParams {
  /** ISO 3166-1 alpha-2 country code, e.g. `"US"`. */
  country?: string;
  /** Restrict the result to one continent. */
  continent?: Continent;
}
