/**
 * Flight status models: live status of a single flight by flight number.
 *
 * The upstream data is scraped from a flight-tracking site, so **every value is an
 * opaque display string** — local clock times without a timezone (`"10:30"`), dates
 * without a year (`"11 Feb"`), and placeholder text (`"--:--"`, `"--"`) where the
 * source had nothing. Nothing here is parsed into a `Date`, and callers should not
 * assume otherwise.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * Departure leg of a flight.
 *
 * Deliberately **not** the same type as {@link FlightStatusArrival}: the departure
 * card reports `actual_time`/`actual_date` and a `checkin` desk, the arrival card
 * reports `estimated_time`/`estimated_date` and a `baggage` belt. The two shapes are
 * asymmetric on the wire and are kept asymmetric here.
 *
 * Every field is optional: when the upstream page has no departure card at all, the
 * whole object arrives as `{}`. Missing individual values arrive as the **empty
 * string** (or the `"--"` / `"--:--"` placeholders), never as `null`.
 */
export interface FlightStatusDeparture {
  /** Airport code, usually rendered as `"CODE • City"`, e.g. `"LHR • London"`. */
  airport?: string;
  /** Full airport name, e.g. `"London Heathrow Airport"`. */
  airport_full?: string;
  /** Scheduled departure, local clock time at the origin, e.g. `"10:30"`. Not ISO 8601. */
  scheduled_time?: string;
  /** Scheduled departure date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  scheduled_date?: string;
  /** Actual departure, local clock time at the origin, e.g. `"10:35"`. Not ISO 8601. */
  actual_time?: string;
  /** Actual departure date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  actual_date?: string;
  /** Departure terminal as displayed, e.g. `"5"`. */
  terminal?: string;
  /** Departure gate as displayed, e.g. `"A12"`. */
  gate?: string;
  /** Check-in desk range as displayed. Departure-only — the arrival leg has `baggage`. */
  checkin?: string;
}

/**
 * Arrival leg of a flight.
 *
 * Deliberately **not** the same type as {@link FlightStatusDeparture}: the arrival
 * card reports `estimated_time`/`estimated_date` and a `baggage` belt where the
 * departure card reports `actual_time`/`actual_date` and a `checkin` desk.
 *
 * Every field is optional: when the upstream page has no arrival card at all, the
 * whole object arrives as `{}`. Missing individual values arrive as the **empty
 * string** (or the `"--"` / `"--:--"` placeholders), never as `null`.
 */
export interface FlightStatusArrival {
  /** Airport code, usually rendered as `"CODE • City"`, e.g. `"JFK • New York"`. */
  airport?: string;
  /** Full airport name, e.g. `"John F Kennedy International Airport"`. */
  airport_full?: string;
  /** Scheduled arrival, local clock time at the destination, e.g. `"14:45"`. Not ISO 8601. */
  scheduled_time?: string;
  /** Scheduled arrival date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  scheduled_date?: string;
  /** Estimated arrival, local clock time at the destination, e.g. `"14:50"`. Not ISO 8601. */
  estimated_time?: string;
  /** Estimated arrival date without a year, e.g. `"11 Feb"`. Not ISO 8601. */
  estimated_date?: string;
  /** Arrival terminal as displayed, e.g. `"7"`. */
  terminal?: string;
  /** Arrival gate as displayed, e.g. `"B15"`. */
  gate?: string;
  /** Baggage belt as displayed. Arrival-only — the departure leg has `checkin`. */
  baggage?: string;
}

/**
 * Response of `sky.flightStatus()`.
 *
 * `status` is prose from the source page (`"En Route"`, `"Landed"`, `"Unknown"`),
 * not an enumerated code.
 */
export interface FlightStatusResponse {
  /** Flight number as displayed by the source, e.g. `"BA 123"` (note the space). */
  flight_number: string;
  /** Operating airline name, or `"Unknown"` when the source did not report one. */
  airline: string;
  /** Free-text status, e.g. `"En Route"`, `"Scheduled"`, `"Landed"`, `"Unknown"`. */
  status: string;
  /** Departure leg. Arrives as `{}` when the source page carried no departure card. */
  departure: FlightStatusDeparture;
  /** Arrival leg. Arrives as `{}` when the source page carried no arrival card. */
  arrival: FlightStatusArrival;
}
