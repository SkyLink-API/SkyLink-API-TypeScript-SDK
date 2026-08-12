/**
 * Aircraft registry lookup, performance profiles and database statistics.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/** A photo of the aircraft, sourced from airport-data.com. */
export interface AircraftPhoto {
  /** Direct image URL. */
  image: string;
  /** Page the photo is published on — link back to it when displaying the image. */
  link: string;
  photographer: string;
}

/**
 * Registry record of a single airframe.
 *
 * Every scalar is nullable: the underlying database is a merge of public registries
 * and coverage varies wildly between countries.
 */
export interface AircraftDetails {
  /** Tail number, e.g. `"G-STBA"`. */
  registration: string | null;
  /** ICAO 24-bit transponder address as hex, upper-cased. */
  icao24: string | null;
  /** ICAO aircraft type designator, e.g. `"B77W"`. */
  icao_type: string | null;
  /** Model name, e.g. `"777-336(ER)"`. */
  type_name: string | null;
  manufacturer: string | null;
  /** Manufacturer and model joined, e.g. `"Boeing 777-336(ER)"`. */
  manufacturer_and_model: string | null;
  owner_operator: string | null;
  /** Operator code as recorded in the registry, e.g. `"BAW"`. */
  airline_code: string | null;
  is_private_operator: boolean | null;
  /** Manufacturer serial number (MSN). */
  serial_number: string | null;
  /** Year of manufacture — a **string**, e.g. `"2010"`, not a number. */
  year_built: string | null;
  /** Empty when the lookup ran with `{ photos: false }` or no photo exists. */
  photos: AircraftPhoto[];
}

/** A lookup that matched a registry record. */
export interface AircraftFound {
  /** The registration or ICAO24 that was looked up, upper-cased. */
  query: string;
  found: true;
  aircraft: AircraftDetails;
}

/** A lookup that matched nothing — still an HTTP 200. */
export interface AircraftNotFound {
  /** The registration or ICAO24 that was looked up, upper-cased. */
  query: string;
  found: false;
  aircraft: null;
}

/**
 * Response of `aircraft.byRegistration()` and `aircraft.byIcao24()`.
 *
 * These endpoints **never** respond 404 — a miss comes back as HTTP 200 with
 * `found: false`. Narrow on `found` before touching `aircraft`:
 *
 * ```ts
 * const result = await sky.aircraft.byRegistration("G-STBA");
 * if (result.found) console.log(result.aircraft.manufacturer);
 * ```
 */
export type AircraftLookupResponse = AircraftFound | AircraftNotFound;

/** Parameters of `aircraft.byRegistration()` and `aircraft.byIcao24()`. */
export interface AircraftLookupParams {
  /**
   * Include photos in the response. Defaults to `true`.
   *
   * Pass `false` to skip the airport-data.com round trip and shave latency.
   */
  photos?: boolean;
}

/**
 * ICAO wake turbulence category: `L`ight, `M`edium, `H`eavy, `J` (super, A388 only).
 */
export type WakeCategory = "L" | "M" | "H" | "J";

/**
 * Performance profile of an aircraft **type** (not of an individual airframe).
 *
 * Every field is optional: the data is scraped from public type registers and a
 * given type may be missing any subset of it.
 */
export interface AircraftPerformance {
  /** ICAO type designator that was looked up, e.g. `"B77W"`. */
  icao_type?: string;
  /** Full type name, e.g. `"BOEING 777-300ER"`. */
  name?: string;
  /** Engine type in words, e.g. `"Jet"`. */
  engine_type?: string;
  /** ICAO engine code, e.g. `"L2J"` (landplane, 2 jets). */
  engine_code?: string;
  wake_category?: WakeCategory;
  /** Cruise speed in knots true airspeed. */
  cruise_speed_ktas?: number;
  service_ceiling_ft?: number;
  /** Maximum range in nautical miles. */
  max_range_nm?: number;
  wing_span_m?: number;
  length_m?: number;
  /** Maximum take-off weight in metric tonnes. */
  mtow_t?: number;
  /** Typical maximum passenger count. */
  max_passengers?: number;
}

/** Response of `aircraft.databaseStats()`. */
export interface AircraftDatabaseStats {
  /** Whether the registry snapshot finished loading into memory. */
  loaded: boolean;
  total_icao_entries: number;
  total_registration_entries: number;
  /** Where the snapshot was loaded from. */
  source_url: string;
}
