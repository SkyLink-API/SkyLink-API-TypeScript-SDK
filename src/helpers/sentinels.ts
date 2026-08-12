/**
 * Type guards and assertions for the API's HTTP-200 "not found" sentinels.
 *
 * Three endpoints answer a miss with a successful response instead of a 404:
 * `aircraft.byRegistration()` / `aircraft.byIcao24()` return `found: false`,
 * the history search returns `count: 0` with an explanatory `note`, and
 * `airports.byIp()` returns an `error` string with `location: null`. Those shapes
 * are part of the response types on purpose — a miss is not exceptional — but code
 * that would rather branch on an exception can convert here, and the thrown message
 * always quotes the sentinel so the reason is not lost.
 *
 * Pure functions — no client, no network, no state.
 */

import { NotFoundError, SkyLinkError } from "../core/errors.js";
import type { AircraftFound, AircraftLookupResponse } from "../models/aircraft.js";

/**
 * Narrow an aircraft lookup to the hit case.
 *
 * ```ts
 * const lookup = await sky.aircraft.byRegistration("G-STBA");
 * if (isFound(lookup)) console.log(lookup.aircraft.manufacturer);
 * ```
 */
export function isFound(lookup: AircraftLookupResponse): lookup is AircraftFound {
  return lookup.found === true;
}

/**
 * Return an aircraft lookup that matched, or throw.
 *
 * The trap this exists for: `aircraft.byRegistration()` never answers 404 — an
 * unknown tail number comes back as HTTP 200 with `found: false` and
 * `aircraft: null`, so a `try/catch` around the call catches nothing and the
 * `null` surfaces later as a property access on `null`.
 *
 * @throws NotFoundError when `found` is `false`.
 */
export function requireFound(lookup: AircraftLookupResponse): AircraftFound {
  if (isFound(lookup)) return lookup;
  throw new NotFoundError(
    `Aircraft lookup for "${lookup.query}" returned found: false (no registry record).`,
  );
}

/**
 * Structural shape of the list responses that can come back legitimately empty.
 *
 * Covers `history.flights()` (`count`, `flights`, `note`), `history.track()` and
 * `history.positions()` (`count`, `positions`).
 */
export interface ResultsEnvelope {
  /** Rows in the response. There is no pagination on these endpoints. */
  count?: number | null;
  /** Total before any limit, where the endpoint reports one. */
  total?: number | null;
  /** Why the result is empty, when the API bothered to explain. */
  note?: string | null;
  flights?: readonly unknown[] | null;
  positions?: readonly unknown[] | null;
}

/**
 * Whether a list response actually carried rows.
 *
 * An explanatory `note` alone does not count as a result: the API sets it exactly
 * when it has nothing to return.
 */
export function hasResults(response: ResultsEnvelope | null | undefined): boolean {
  if (!response) return false;
  if (response.flights && response.flights.length > 0) return true;
  if (response.positions && response.positions.length > 0) return true;
  if (typeof response.count === "number" && response.count > 0) return true;
  if (typeof response.total === "number" && response.total > 0) return true;
  return false;
}

/**
 * Return a list response that carried rows, or throw.
 *
 * The trap this exists for: an unknown registration is **not** an error to the
 * history search — it answers 200 with `count: 0`, `flights: []` and a `note`
 * explaining that the tail number is not in the aircraft database. The response is
 * returned unchanged so this can be used inline.
 *
 * @throws NotFoundError quoting `note` when the response is empty.
 */
export function requireResults<T extends ResultsEnvelope>(response: T): T {
  if (hasResults(response)) return response;
  const note =
    typeof response.note === "string" && response.note.trim() !== "" ? response.note : null;
  throw new NotFoundError(
    note === null ? "The request matched no records." : `The request matched no records: ${note}`,
  );
}

/** Structural shape of a response carrying an in-band `error` sentinel. */
export interface IpResultEnvelope {
  /** Why the lookup failed, `null` on success — delivered inside a 200 response. */
  error?: string | null;
}

/**
 * Return an IP-geolocation response that succeeded, or throw.
 *
 * The trap this exists for: `airports.byIp()` reports a failed geolocation as HTTP
 * 200 with `error` set, `location: null` and an empty `airports` list — the status
 * code says everything is fine. The response is returned unchanged so this can be
 * used inline.
 *
 * @throws SkyLinkError quoting `error` when the sentinel is set.
 */
export function requireIpResult<T extends IpResultEnvelope>(response: T): T {
  const error = typeof response.error === "string" ? response.error.trim() : "";
  if (error === "") return response;
  throw new SkyLinkError(`IP geolocation failed: ${error}`);
}
