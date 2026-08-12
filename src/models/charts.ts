/**
 * Aerodrome chart models: links to official AIP chart PDFs, grouped by category.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * Chart category.
 *
 * `GEN` general information, `GND` ground/taxi diagrams, `SID` standard instrument
 * departures, `STAR` standard terminal arrival routes, `APP` approach procedures.
 */
export type ChartCategory = "GEN" | "GND" | "SID" | "STAR" | "APP";

/** A single chart. */
export interface Chart {
  /** Chart title as published, e.g. `"KJFK - Airport Diagram"`. */
  name: string;
  /**
   * Direct URL to the chart PDF.
   *
   * The API does not proxy chart documents — this points at the publishing
   * authority's own AIP host and is fetched outside the SDK.
   */
  url: string;
  category: ChartCategory;
}

/**
 * Response of `charts.byAirport()` and `charts.byCategory()`.
 *
 * `charts` is a **partial** map: categories with no charts are dropped from the
 * object entirely, so index access yields `Chart[] | undefined`.
 *
 * ```ts
 * const result = await sky.charts.byAirport("KJFK");
 * for (const chart of result.charts.APP ?? []) console.log(chart.name);
 * ```
 */
export interface ChartsResponse {
  /** ICAO code that was queried, upper-cased by the API. */
  icao_code: string;
  /** Source the charts came from, e.g. `"faa"`. */
  source: string;
  /** Charts grouped by category; empty categories are omitted. */
  charts: Partial<Record<ChartCategory, Chart[]>>;
  /** Charts across every returned category. */
  total_count: number;
  /**
   * When the charts were scraped.
   *
   * ISO 8601 in UTC, but serialized from a naive timestamp — so a live response
   * carries **no** `Z` suffix or offset, even though the API reference example
   * shows one. Typed as a plain string for that reason.
   */
  fetched_at: string;
}

/** One of the country-specific chart scrapers. */
export interface ChartSource {
  /** Identifier accepted by the `source` parameter, e.g. `"faa"`. */
  source_id: string;
  /** Human-readable name, e.g. `"FAA (United States)"`. */
  name: string;
  /**
   * ICAO prefixes this source covers.
   *
   * Entries are not always bare prefixes — a source may publish a prose exclusion
   * such as `"U* (except UA,UC,UG,UM,UT,UZ)"`.
   */
  icao_prefixes: string[];
}

/** Response of `charts.sources()`. */
export interface ChartSourcesResponse {
  sources: ChartSource[];
  total_count: number;
}

/** Parameters of `charts.byAirport()` and `charts.byCategory()`. */
export interface ChartsParams {
  /**
   * Override the source auto-detected from the ICAO prefix, e.g. `"faa"`, `"uk"`,
   * `"france"`. Call `charts.sources()` for the full list.
   */
  source?: string;
}
