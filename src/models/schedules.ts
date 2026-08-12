/**
 * Airport schedule models: departure and arrival boards.
 *
 * The rows inside `flights[]` are the only place in the whole API where keys are
 * **PascalCase** (`Time`, `Date`, `IATA`, `Destination`/`Origin`, `Flight`,
 * `Airline`, `Status`) — they come straight from the scraped board table. The SDK
 * rule is "fields exactly as they appear on the wire", so they are left untouched
 * rather than normalized to snake_case.
 *
 * Every type here is compile-time only — the SDK never validates or reshapes a
 * response body.
 */

/** Board direction, echoed back in the response. */
export type ScheduleDirection = "departures" | "arrivals";

/**
 * One row of a **departure** board.
 *
 * Carries `Destination` (where the flight is going). The arrival board's rows carry
 * `Origin` instead — see {@link ScheduleArrivalFlight}. The two are separate types,
 * because a board never mixes them.
 *
 * All values are display strings taken verbatim from the board: `Time` is a local
 * clock time at the airport (`"16:05"`), `Date` has no year (`"11 Feb"`), and
 * `Status` is prose (`"Estimated 16:39"`, `"Departed 16:12"`, `"Cancelled"`).
 */
export interface ScheduleDepartureFlight {
  /** Local clock time at the airport, e.g. `"16:05"`. Not ISO 8601. */
  Time: string;
  /** Date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  Date: string;
  /** IATA code of the destination airport, e.g. `"ICN"`. */
  IATA: string;
  /** Destination city name, e.g. `"Seoul"`. Departure boards only. */
  Destination: string;
  /** Flight number, e.g. `"C84093"`. */
  Flight: string;
  /** Operating airline name, e.g. `"Federal Airlines"`. */
  Airline: string;
  /** Free-text status, e.g. `"Estimated 16:39"`, `"Departed 16:12"`, `"Cancelled"`. */
  Status: string;
}

/**
 * One row of an **arrival** board.
 *
 * Carries `Origin` (where the flight is coming from) where the departure board's
 * rows carry `Destination` — see {@link ScheduleDepartureFlight}.
 *
 * All values are display strings taken verbatim from the board: `Time` is a local
 * clock time at the airport (`"16:20"`), `Date` has no year (`"11 Feb"`), and
 * `Status` is prose (`"Landed 16:15"`, `"Delayed 17:05"`).
 */
export interface ScheduleArrivalFlight {
  /** Local clock time at the airport, e.g. `"16:20"`. Not ISO 8601. */
  Time: string;
  /** Date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  Date: string;
  /** IATA code of the origin airport, e.g. `"RAK"`. */
  IATA: string;
  /** Origin city name, e.g. `"Marrakech"`. Arrival boards only. */
  Origin: string;
  /** Flight number, e.g. `"EC3929"`. */
  Flight: string;
  /** Operating airline name, e.g. `"easyJet Europe"`. */
  Airline: string;
  /** Free-text status, e.g. `"Landed 16:15"`, `"Delayed 17:05"`. */
  Status: string;
}

/** Envelope common to both schedule boards. */
export interface ScheduleBoard {
  /** IATA code the board was fetched for, upper-cased. */
  iata: string;
  direction: ScheduleDirection;
  /** The code the caller supplied (ICAO when queried by `icao`, IATA otherwise). */
  airport_code: string;
  /** Number of rows returned. */
  total_flights: number;
  /** How many board pages were walked upstream to assemble the result. */
  pages_fetched: number;
}

/** Response of `schedules.departures()`. */
export interface DeparturesResponse extends ScheduleBoard {
  direction: "departures";
  flights: ScheduleDepartureFlight[];
}

/** Response of `schedules.arrivals()`. */
export interface ArrivalsResponse extends ScheduleBoard {
  direction: "arrivals";
  flights: ScheduleArrivalFlight[];
}

/**
 * Parameters shared by `schedules.departures()` and `schedules.arrivals()`.
 *
 * Exactly one of `icao` / `iata` must be given; the SDK rejects zero or both before
 * issuing the request. Without a date the board covers roughly the next 12 hours;
 * history reaches 5 days back and 1 day forward.
 */
export interface SchedulesParams {
  /** Four-letter ICAO code, e.g. `"LIMC"`. Mutually exclusive with `iata`. */
  icao?: string;
  /** Three-letter IATA code, e.g. `"MXP"`. Mutually exclusive with `icao`. */
  iata?: string;
  /**
   * Board date. A `Date` is formatted as `DD-MM-YYYY` in UTC; a string already in
   * that shape is passed through untouched.
   */
  date?: Date | string;
  /**
   * Board time, `HH:MM`. Only meaningful together with `date`. A `Date` is formatted
   * in UTC; a string already in that shape is passed through untouched.
   */
  time?: Date | string;
  /**
   * Unix timestamp in **milliseconds**. Takes priority over `date`/`time` upstream.
   */
  ts?: number;
}
