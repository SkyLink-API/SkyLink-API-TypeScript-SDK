/**
 * Query-string serialization plus the per-endpoint date formatters.
 *
 * The API has no single date convention: schedules want `DD-MM-YYYY`, tickets want
 * `YYYY-MM-DD`, history wants ISO 8601. Resources normalize their inputs with the
 * matching formatter before handing the query to the transport.
 */

import type { BBox, QueryParams, QueryValue } from "./types.js";

/** Serialize a bounding box to the wire form `"lat1,lon1,lat2,lon2"`. Strings pass through. */
export function formatBBox(bbox: BBox | readonly number[] | string): string {
  if (typeof bbox === "string") return bbox;
  return bbox.join(",");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDate(value: string | number | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date value: ${String(value)}`);
  }
  return date;
}

/**
 * `YYYY-MM-DD` (UTC) — used by `/tickets/search`.
 * A string already in that shape is passed through untouched.
 */
export function formatDateYMD(value: string | number | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = toDate(value);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * `DD-MM-YYYY` (UTC) — used by `/schedules/departures` and `/schedules/arrivals`.
 * A string already in that shape is passed through untouched.
 */
export function formatDateDMY(value: string | number | Date): string {
  if (typeof value === "string" && /^\d{2}-\d{2}-\d{4}$/.test(value)) return value;
  const date = toDate(value);
  return `${pad2(date.getUTCDate())}-${pad2(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`;
}

/**
 * ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) — used by the history endpoints' `start`/`end`.
 * Any string is passed through untouched, since the API accepts several ISO variants.
 */
export function formatDateTimeISO(value: string | number | Date): string {
  if (typeof value === "string") return value;
  return toDate(value)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/** `HH:MM` (UTC) — used by the schedules `time` parameter. */
export function formatTimeHM(value: string | number | Date): string {
  if (typeof value === "string" && /^\d{2}:\d{2}$/.test(value)) return value;
  const date = toDate(value);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function serializeValue(value: Exclude<QueryValue, null | undefined>): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return value as string;
}

/**
 * Turn a parameter bag into `URLSearchParams`.
 *
 * - `undefined` and `null` entries are dropped entirely (never sent as empty strings).
 * - Booleans become `true`/`false`, matching FastAPI's parser.
 * - Arrays (bbox tuples, CSV filters such as `exclude_qcode`) are comma-joined.
 * - Keys are emitted in insertion order, so query strings are stable and testable.
 */
export function buildSearchParams(query?: QueryParams): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, serializeValue(value));
  }
  return params;
}

/** Serialize a parameter bag to a query string without the leading `?` (empty when no params). */
export function buildQueryString(query?: QueryParams): string {
  return buildSearchParams(query).toString();
}
