/**
 * Live flight status by flight number.
 *
 * ```ts
 * const flight = await sky.flightStatus("BA123");
 * console.log(flight.status, flight.arrival.estimated_time);
 * ```
 *
 * Unlike the other namespaces this class does **not** extend {@link APIResource}:
 * the endpoint's single method is called `get()`, and `APIResource` already reserves
 * that name for its own protected GET shorthand. The constructor signature is
 * identical, so the class is wired onto the client exactly like every other resource.
 */

import type { SkyLink } from "../client.js";
import type { RequestOptions } from "../core/types.js";
import type { FlightStatusResponse } from "../models/flight-status.js";
import { encodePathParam } from "./base.js";

/** Flight status endpoint. */
export class FlightStatus {
  /** The client this resource issues its requests through. */
  protected readonly client: SkyLink;

  constructor(client: SkyLink) {
    this.client = client;
  }

  /**
   * Current status of a flight: airline, phase of flight, gates, terminals and the
   * scheduled/actual/estimated times of both legs.
   *
   * Accepts IATA (`"BA123"`) and ICAO (`"BAW123"`) flight numbers; ICAO codes are
   * converted upstream. Responds 404 when the flight number is unknown or the
   * upstream source has no page for it.
   *
   * Every time and date in the response is a **display string** — a local clock time
   * without a timezone, a date without a year. Do not feed them to `new Date()`.
   *
   * `GET /flight_status/{flight_number}`
   *
   * @param flightNumber - Flight number, 2–10 characters, e.g. `"BA123"` or `"BAW123"`.
   */
  get(flightNumber: string, options?: RequestOptions): Promise<FlightStatusResponse> {
    return this.client.request<FlightStatusResponse>(
      {
        method: "GET",
        path: `/flight_status/${encodePathParam(flightNumber, "flightNumber")}`,
      },
      options,
    );
  }
}
