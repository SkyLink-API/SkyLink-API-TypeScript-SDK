/**
 * Airline models: the OpenFlights-derived airline directory.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/** `active` flag — the dataset encodes it as a letter, not a boolean. */
export type AirlineActive = "Y" | "N";

/** One airline record. */
export interface Airline {
  /** Row id in the airline dataset. */
  id: number;
  name: string;
  /** Alternative trading name, `null` when the dataset has none. */
  alias: string | null;
  /** Two-letter IATA code, e.g. `"BA"`. */
  iata: string | null;
  /** Three-letter ICAO code, e.g. `"BAW"`. */
  icao: string | null;
  /** Radio callsign, e.g. `"SPEEDBIRD"`. */
  callsign: string | null;
  /** Country of registration, as a name rather than a code. */
  country: string | null;
  /** `"Y"` when the airline still operates, `"N"` when defunct. */
  active: AirlineActive | null;
  /**
   * Logo URL (`https://media.skylinkapi.com/logos/{IATA}.png`), `null` when the
   * airline has no IATA code.
   */
  logo: string | null;
}

/** Response of `airlines.search()` — a bare array, not an envelope. */
export type AirlineSearchResponse = Airline[];

/**
 * Parameters of `airlines.search()` — exactly one of `icao` / `iata`.
 *
 * Passing neither is a 400 from the API, so the union rules it out at compile time.
 */
export type AirlineSearchParams =
  | {
      /** Three-letter ICAO airline code, e.g. `"BAW"`. */
      icao: string;
      iata?: never;
    }
  | {
      /** Two-letter IATA airline code, e.g. `"BA"`. */
      iata: string;
      icao?: never;
    };
