/**
 * NOTAM models: Notices to Air Missions filed for an airport or its FIR.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/** NOTAM record kind: `N` new, `R` replacement, `C` cancellation. */
export type NotamType = "N" | "R" | "C";

/** Where a NOTAM applies: filed at the airport itself, or FIR-wide (en route). */
export type NotamScope = "AERODROME" | "FIR";

/**
 * Whether a NOTAM is already in effect or still ahead.
 *
 * Always populated. `FUTURE` entries are only returned when the request asked for
 * `include_future: true`; expired NOTAMs are never returned at all, so a default
 * call sees nothing but `ACTIVE`.
 */
export type NotamStatus = "ACTIVE" | "FUTURE";

/** A single NOTAM. */
export interface NotamEntry {
  /**
   * Full NOTAM text in standard ICAO format: the identification line followed by
   * the Q), A), B), C), D), E) and F)/G) items.
   */
  raw: string;
  /** ICAO NOTAM identifier, e.g. `"A2161/2026"`. */
  notam_id: string | null;
  /** FAA domestic identifier as shown on notams.aim.faa.gov, e.g. `"07/2161"`. */
  notam_id_domestic: string | null;
  type: NotamType | null;
  /** Affected location identifier, usually the ICAO code. */
  location: string | null;
  /**
   * Start of validity, UTC — **an opaque string in one of two formats**, depending on
   * what the originating authority filed: the NOTAM date group (`"202607162130"` /
   * `"2607162130"`, i.e. `[YY]YYMMDDHHMM`) or an ISO 8601 timestamp.
   *
   * Deliberately typed as `string` and never parsed into a `Date`: the two formats
   * are ambiguous with each other and carry no timezone marker beyond "UTC by
   * convention". Sniff the format yourself before converting.
   */
  effective: string | null;
  /**
   * End of validity, UTC — same two-format caveat as {@link NotamEntry.effective}.
   * May also carry the literal `"PERM"` for permanent notices.
   *
   * Deliberately typed as `string` and never parsed into a `Date`.
   */
  expiration: string | null;
  /** NOTAM body text (the E item), e.g. `"RWY 12L/30R CLSD"`. */
  body: string | null;
  /** Activation schedule (the D item), e.g. `"MON-FRI 0600-1800"`. */
  schedule: string | null;
  /** Lower altitude limit (the F item), e.g. `"SFC"`, `"FL050"`. */
  lower_limit: string | null;
  /** Upper altitude limit (the G item), e.g. `"FL195"`, `"UNL"`. */
  upper_limit: string | null;
  /** FIR/ARTCC the NOTAM is filed under, e.g. `"KZKC"`, `"EGTT"`. */
  affected_fir: string | null;
  /** ICAO NOTAM selection code, e.g. `"QFTAS"`. */
  q_code: string | null;
  /** Full ICAO Q-line, when the feed supplied one. US domestic NOTAMs often omit it. */
  qline: string | null;
  scope: NotamScope | null;
  /**
   * `ACTIVE` or `FUTURE` — the API classifies every NOTAM it returns. Without
   * `include_future: true` the result holds `ACTIVE` entries only.
   */
  status: NotamStatus | null;
}

/** Response of `notams.byAirport()`. */
export interface NotamsResponse {
  /** ICAO code that was queried, upper-cased by the API. */
  icao: string;
  notams: NotamEntry[];
  total: number;
}

/** Parameters of `notams.byAirport()`. */
export interface NotamsParams {
  /**
   * Q-code prefixes to drop server-side. Either an array (`["QK", "QFA"]`) or a
   * pre-joined CSV string (`"QK,QFA"`) — both are sent as CSV.
   *
   * Accepts an exact code (`"QKKKK"`) or a whole subject category (`"QK"`, which
   * drops every `QK*` checklist NOTAM).
   */
  exclude_qcode?: readonly string[] | string;
  /**
   * Scopes to drop server-side. Either an array (`["FIR"]`) or a pre-joined CSV
   * string (`"FIR"`) — both are sent as CSV. `exclude_scope: ["FIR"]` leaves only
   * aerodrome-specific notices.
   */
  exclude_scope?: readonly NotamScope[] | string;
  /**
   * Also return NOTAMs whose effective date has not been reached yet, tagged
   * `status: "FUTURE"`. Defaults to `false` (currently-active only, matching a live
   * AIS briefing). Expired NOTAMs are never returned either way.
   */
  include_future?: boolean;
}
