/**
 * Route models for the `/routes/*` endpoints.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

// ---------------------------------------------------------------------------
// Literal unions
// ---------------------------------------------------------------------------

/**
 * Which dataset answered a callsign lookup — the discriminant of
 * {@link CallsignRoute}.
 */
export type RouteSource = "vrs" | "airline_routes";

/** Confidence of a callsign lookup: `high` for an exact match, `low` for the airline fallback. */
export type RouteConfidence = "high" | "low";

/** Direction filter of `routes.byAirport()`. */
export type RouteDirection = "dep" | "arr" | "both";

// ---------------------------------------------------------------------------
// routes.byCallsign — a real union
// ---------------------------------------------------------------------------

/** One route of an airline's network, as returned inside {@link AirlineCallsignRoute}. */
export interface AirlineNetworkRoute {
  /** Origin airport IATA code. */
  src: string;
  /** Destination airport IATA code. */
  dst: string;
  /** Great-circle distance in kilometres. */
  km: number | null;
  /** Typical block time in minutes. */
  duration_min: number | null;
}

/**
 * Exact-match branch of `routes.byCallsign()`: the callsign was found in the VRS
 * standing data, so the specific airport pair is known.
 */
export interface VrsCallsignRoute {
  /** The callsign that was queried, upper-cased. Present **only** on this branch. */
  callsign: string;
  /** Callsign with the trailing digits stripped, e.g. `"BAW"`. */
  callsign_prefix: string;
  /** Airline code as recorded by VRS. */
  airline_code: string;
  /** Departure airport ICAO code. */
  departure_icao: string;
  /** Arrival airport ICAO code. */
  arrival_icao: string;
  /** Every airport of the routing, in order — longer than two for multi-leg callsigns. */
  airports: string[];
  confidence: "high";
  source: "vrs";
}

/**
 * Fallback branch of `routes.byCallsign()`: the exact callsign is unknown, so the
 * airline's whole published network is returned instead.
 *
 * **There is no `callsign` key on this branch** — narrow on `source` (or on
 * `confidence`) before reaching for one.
 */
export interface AirlineCallsignRoute {
  /** Callsign with the trailing digits stripped, e.g. `"BAW"`. */
  callsign_prefix: string;
  /** Airline IATA code the prefix resolved to. */
  airline_code: string;
  airline_name: string | null;
  /** At most 20 routes; `total_routes` reports how many exist. */
  routes: AirlineNetworkRoute[];
  /** Size of the airline's full route list, which `routes` truncates. */
  total_routes: number;
  confidence: "low";
  source: "airline_routes";
}

/**
 * Response of `routes.byCallsign()` — a discriminated union on `source`.
 *
 * The two branches share only `callsign_prefix`, `airline_code`, `confidence` and
 * `source`; everything else, including `callsign` itself, is branch-specific.
 *
 * ```ts
 * const route = await sky.routes.byCallsign("BAW117");
 * if (route.source === "vrs") {
 *   console.log(route.callsign, route.departure_icao, "→", route.arrival_icao);
 * } else {
 *   console.log(route.airline_name, "flies", route.total_routes, "routes");
 * }
 * ```
 */
export type CallsignRoute = VrsCallsignRoute | AirlineCallsignRoute;

// ---------------------------------------------------------------------------
// routes.byAirport / routes.pairs
// ---------------------------------------------------------------------------

/**
 * A directed airport pair with the carriers serving it.
 *
 * The same shape backs both `routes.byAirport()` and `routes.pairs()`; both sort
 * by the number of airlines, busiest first.
 */
export interface RoutePair {
  /** Departure airport IATA code. */
  departure: string;
  /** Arrival airport IATA code. */
  arrival: string;
  /** Airline names (not codes) serving the pair. */
  airlines: string[];
  /** Great-circle distance in kilometres. */
  km: number | null;
  /** Typical block time in minutes. */
  duration_min: number | null;
}

/** Response of `routes.byAirport()`. */
export interface AirportRoutesResponse {
  /** The airport code as queried, upper-cased — IATA or ICAO, echoed unresolved. */
  code: string;
  /** The direction filter that was applied. */
  direction: RouteDirection;
  /** Number of routes in `routes`, after the `limit` cut. */
  count: number;
  routes: RoutePair[];
}

/** Response of `routes.pairs()`. */
export interface RoutePairsResponse {
  /** Number of pairs in `routes`, after the `limit` cut. */
  count: number;
  routes: RoutePair[];
}

/** Parameters of `routes.byAirport()`. */
export interface AirportRoutesParams {
  /** Restrict to departures or arrivals. Defaults to `"both"`. */
  direction?: RouteDirection;
  /** Maximum routes to return, 1–500. Defaults to `100`. */
  limit?: number;
}

/** Parameters of `routes.pairs()`. */
export interface RoutePairsParams {
  /** Filter by departure airport, IATA or ICAO. */
  departure?: string;
  /** Filter by arrival airport, IATA or ICAO. */
  arrival?: string;
  /** Maximum pairs to return, 1–500. Defaults to `50`. */
  limit?: number;
}
