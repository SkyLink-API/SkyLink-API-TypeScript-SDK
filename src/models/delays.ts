/**
 * FAA National Airspace System delay alerts.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 *
 * Two conventions are worth knowing before consuming these types:
 * durations and times are **prose strings** scraped from the FAA status page
 * (`"1 hour and 30 minutes"`, `"until 22:00 UTC"`), never numbers or ISO
 * timestamps; and `airport` carries whatever identifier the FAA published — an
 * ICAO code such as `"KEWR"` for most entries, a bare FAA identifier for some.
 */

/** An active ground delay program: departures to the airport are metered. */
export interface GroundDelay {
  /** Airport ICAO or FAA identifier, e.g. `"KEWR"`. */
  airport: string;
  airport_name: string | null;
  /** Cause as published, e.g. `"WEATHER / THUNDERSTORMS"`. */
  reason: string;
  /** Prose duration, e.g. `"1 hour and 30 minutes"`. Not a number. */
  avg_delay: string | null;
  /** Prose duration, e.g. `"2 hours"`. Not a number. */
  max_delay: string | null;
}

/** An active ground stop: departures to the airport are halted entirely. */
export interface GroundStop {
  /** Airport ICAO or FAA identifier. */
  airport: string;
  airport_name: string | null;
  reason: string;
  /** Expected end time as published (UTC). An opaque string, not ISO 8601. */
  end_time: string | null;
}

/** An airport closure. */
export interface AirportClosure {
  /** Airport ICAO or FAA identifier. */
  airport: string;
  airport_name: string | null;
  reason: string;
  /** Closure start as published (UTC). An opaque string, not ISO 8601. */
  begin: string | null;
  /** Expected reopening as published (UTC). An opaque string, not ISO 8601. */
  reopen: string | null;
}

/** An airspace flow program metering traffic through a constrained area. */
export interface AirspaceFlowProgram {
  /** ATC facility (ARTCC) identifier, e.g. `"ZNY"`. */
  facility: string;
  reason: string;
  /** Flow-constrained-area start as published (UTC). An opaque string. */
  fca_start: string | null;
  /** Flow-constrained-area end as published (UTC). An opaque string. */
  fca_end: string | null;
}

/**
 * Response of `delays.faa()`.
 *
 * All four arrays are always present and default to empty. The per-airport variant
 * filters the airport-scoped arrays but leaves `airspace_flow_programs` unfiltered,
 * since a flow program covers a whole ARTCC rather than a single field.
 */
export interface FaaDelaysResponse {
  ground_delays: GroundDelay[];
  ground_stops: GroundStop[];
  closures: AirportClosure[];
  airspace_flow_programs: AirspaceFlowProgram[];
  /** Alerts across all four categories. */
  total_alerts: number;
  /** Set only when there are no delays at all, e.g. `"No delays reported"`. */
  message: string | null;
}
