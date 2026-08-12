/**
 * Flight-ticket models for `GET /tickets/search`.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * One flown segment of an itinerary.
 *
 * ### Times carry no timezone
 *
 * `departure_time`/`arrival_time` are bare `"HH:MM"` clock readings and
 * `departure_datetime`/`arrival_datetime` are **naive ISO 8601** — local to the
 * respective airport, with no `Z` and no offset (`"2026-05-01T09:00:00"`). They are
 * typed as `string` on purpose: feeding them to `new Date()` silently reinterprets
 * them in the host's timezone and yields a wrong instant. Combine them with the
 * airport's timezone yourself if you need a real instant.
 */
export interface TicketLeg {
  /** Marketing flight number including the airline prefix, e.g. `"BA117"`. */
  flight_number: string;
  /** Airline name, e.g. `"British Airways"`. */
  airline: string | null;
  /** Airline IATA code, e.g. `"BA"`. Falls back to the upstream enum name when unmapped. */
  airline_code: string;
  /** Departure airport IATA code. */
  departure_airport: string;
  departure_airport_name: string | null;
  /** Arrival airport IATA code. */
  arrival_airport: string;
  arrival_airport_name: string | null;
  /** Local departure clock time as `"HH:MM"`. No date, no timezone. */
  departure_time: string | null;
  /** Local arrival clock time as `"HH:MM"`. No date, no timezone. */
  arrival_time: string | null;
  /** Naive local ISO 8601 (`"2026-05-01T09:00:00"`) — **no timezone**. Do not parse as UTC. */
  departure_datetime: string | null;
  /** Naive local ISO 8601 (`"2026-05-01T11:45:00"`) — **no timezone**. Do not parse as UTC. */
  arrival_datetime: string | null;
  /** Leg duration in minutes. */
  duration_min: number | null;
}

/** A connection between two consecutive legs. */
export interface TicketLayover {
  /** Connecting airport IATA code. */
  airport: string;
  airport_name: string | null;
  /** Ground time in minutes; `null` when the two legs' times could not be differenced. */
  duration_min: number | null;
}

/**
 * One priced itinerary.
 *
 * `layovers` is `null` — **not** an empty array — for a non-stop offer, so test it
 * with `offer.layovers?.length` or an explicit `!== null` check.
 */
export interface TicketOffer {
  /**
   * Total price in US dollars.
   *
   * The upstream price is converted with a cached FX table. When the rate for
   * `original_currency` is unavailable, the conversion is skipped **silently** and
   * this field still holds the amount in that currency — compare
   * `original_currency` against `"USD"` if the distinction matters to you.
   */
  price_usd: number;
  /**
   * Price as quoted upstream, before FX conversion.
   *
   * Documented by the endpoint but not emitted by every deployment — treat as
   * possibly absent.
   */
  original_price?: number | null;
  /**
   * ISO 4217 code of `original_price`, e.g. `"EUR"`.
   *
   * Documented by the endpoint but not emitted by every deployment — treat as
   * possibly absent.
   */
  original_currency?: string | null;
  /** Door-to-door duration in minutes, layovers included. */
  total_duration_min: number | null;
  /** Number of stops; `0` for a non-stop offer. */
  stops: number;
  legs: TicketLeg[];
  /** Connections between the legs. **`null`, not `[]`, for a direct flight.** */
  layovers: TicketLayover[] | null;
}

/** Response of `tickets.search()`. Offers are sorted cheapest first. */
export interface TicketSearchResponse {
  /** Origin IATA code, upper-cased by the API. */
  origin: string;
  /** Destination IATA code, upper-cased by the API. */
  destination: string;
  /** Travel date as `YYYY-MM-DD`. Echoes the default (today + 7 days) when none was sent. */
  date: string;
  passengers: number;
  /** Number of offers in `flights`. */
  count: number;
  flights: TicketOffer[];
}

/** Parameters of `tickets.search()`. */
export interface TicketSearchParams {
  /** Origin airport IATA code (3 letters), e.g. `"LHR"`. */
  origin: string;
  /** Destination airport IATA code (3 letters), e.g. `"JFK"`. Must differ from `origin`. */
  destination: string;
  /**
   * Travel date. A `Date` is formatted as `YYYY-MM-DD` in UTC; a string already in
   * that shape is sent untouched. Defaults server-side to today + 7 days.
   */
  date?: string | Date;
  /** Number of passengers, 1–9. Defaults to `1`. */
  passengers?: number;
}
