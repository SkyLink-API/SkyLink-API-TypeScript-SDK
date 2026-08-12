/**
 * Results of the `sky.compose` aggregators.
 *
 * Unlike the rest of `src/models`, none of these shapes comes back from the API:
 * each one is assembled client-side out of several responses, so its fields are
 * camelCase like the rest of the SDK's own vocabulary (`originMetar`, not
 * `origin_metar`). The responses *inside* them keep their wire field names.
 *
 * Two rules run through every brief:
 *
 * - **A missing part is `null`, never a throw.** Whatever went wrong is parked in
 *   `errors`, keyed by the field it belongs to, so one 403 does not cost you the
 *   other six calls.
 * - **The part names are the field names.** `include`/`exclude` take exactly the
 *   keys listed in {@link AIRPORT_BRIEF_PARTS}, {@link FLIGHT_BRIEF_PARTS} and
 *   {@link ROUTE_BRIEF_PARTS}, and the part types are derived from those arrays, so
 *   a typo is a compile error rather than a silently skipped request.
 *
 * This module is the one exception to "models carry no runtime footprint": the three
 * part lists exist at runtime, because they are also the documented, iterable set of
 * things a brief can ask for.
 */

import type { SkyLinkError } from "../core/errors.js";
import type { AdsbAircraft } from "./adsb.js";
import type { AircraftLookupResponse } from "./aircraft.js";
import type { EnrichedAirport } from "./airports.js";
import type { CarbonEstimate } from "./carbon.js";
import type { ChartsResponse } from "./charts.js";
import type { FaaDelaysResponse } from "./delays.js";
import type { DistanceResponse } from "./distance.js";
import type { FlightStatusResponse } from "./flight-status.js";
import type { FlightTimePrediction } from "./ml.js";
import type { NotamsResponse } from "./notams.js";
import type { CallsignRoute } from "./routes.js";
import type {
  ArrivalsResponse,
  DeparturesResponse,
  ScheduleArrivalFlight,
  ScheduleDepartureFlight,
} from "./schedules.js";
import type { ParsedMetarResponse, ParsedTafResponse } from "./weather.js";

/**
 * The failures a brief collected, keyed by the result field they belong to.
 *
 * Only {@link SkyLinkError}s land here: a `TypeError` from a caller-supplied `fetch`
 * is a bug, not a degraded part, and is thrown rather than filed away. A part that
 * was not requested leaves no entry — an absent key means "not asked", a present one
 * means "asked and failed".
 */
export type ComposeErrors<Part extends string> = Partial<Record<Part, SkyLinkError>>;

// ---------------------------------------------------------------------------
// compose.airportBrief
// ---------------------------------------------------------------------------

/**
 * The parts of an {@link AirportBrief}, in the order they appear on the result.
 *
 * `"airport"` is the primary part: when it is requested (the default) its failure is
 * thrown instead of collected, since the other six calls describe an airport that
 * does not exist. Exclude it to skip the call entirely.
 */
export const AIRPORT_BRIEF_PARTS = [
  "airport",
  "metar",
  "taf",
  "notams",
  "delays",
  "charts",
  "departures",
  "arrivals",
] as const;

/** One part name accepted by `compose.airportBrief()`'s `include`/`exclude`. */
export type AirportBriefPart = (typeof AIRPORT_BRIEF_PARTS)[number];

/**
 * Everything worth knowing about an airport right now, from eight endpoints.
 *
 * Weather is fetched **decoded** (`parsed: true`), because a brief exists to be read
 * and `weatherHelpers.flightCategory()` needs the decoded block.
 *
 * ```ts
 * const brief = await sky.compose.airportBrief("KJFK");
 * console.log(brief.airport?.name, brief.metar?.parsed?.flight_rules, brief.notams?.total);
 * if (brief.errors.delays) console.warn("no FAA delay feed:", brief.errors.delays.message);
 * ```
 */
export interface AirportBrief {
  /** Full airport record — the primary part. `null` only when excluded. */
  airport: EnrichedAirport | null;
  /** Current observation, decoded (`parsed: true`); `parsed` is `null` if the decoder failed. */
  metar: ParsedMetarResponse | null;
  /** Current forecast, decoded (`parsed: true`); `parsed` is `null` if the decoder failed. */
  taf: ParsedTafResponse | null;
  notams: NotamsResponse | null;
  /**
   * FAA NAS delays for this airport.
   *
   * US airports only: everywhere else the endpoint answers 404, which lands in
   * `errors.delays` rather than failing the brief. Exclude the part outside the US.
   */
  delays: FaaDelaysResponse | null;
  charts: ChartsResponse | null;
  /** Departure board, truncated to `schedulesLimit` rows. */
  departures: DeparturesResponse | null;
  /** Arrival board, truncated to `schedulesLimit` rows. */
  arrivals: ArrivalsResponse | null;
  errors: ComposeErrors<AirportBriefPart>;
}

// ---------------------------------------------------------------------------
// compose.flightBrief
// ---------------------------------------------------------------------------

/**
 * The parts of a {@link FlightBrief}, in the order they appear on the result.
 *
 * `"status"` is the primary part (its failure is thrown), and the chain behind it is
 * real: `aircraft` needs the registration from `status`, `route` needs its callsign,
 * and `carbon` is priced from the route's airport pair — falling back to the callsign
 * when the route did not supply one, so excluding `route` costs the pair, not the
 * estimate.
 */
export const FLIGHT_BRIEF_PARTS = ["status", "aircraft", "route", "carbon"] as const;

/** One part name accepted by `compose.flightBrief()`'s `include`/`exclude`. */
export type FlightBriefPart = (typeof FLIGHT_BRIEF_PARTS)[number];

/**
 * A flight number resolved as far as the API can take it: live status, the airframe
 * flying it, the route it flies and what that costs the atmosphere.
 *
 * ```ts
 * const brief = await sky.compose.flightBrief("BA123");
 * if (brief.aircraft?.found) console.log(brief.aircraft.aircraft.manufacturer_and_model);
 * ```
 */
export interface FlightBrief {
  /** Live status — the primary part. `null` only when excluded. */
  status: FlightStatusResponse | null;
  /**
   * Registry lookup of the airframe, envelope and all.
   *
   * Kept as the whole response rather than as `response.aircraft` for the same reason
   * as {@link EnrichedAircraft.info}: `{ found: false }` — "this tail number is not in
   * the registry" — has to stay distinguishable from `null`, which here means the
   * lookup never happened. It usually did not: the live status payload carries no
   * registration (its upstream has no airframe in it), and that is not a failure, so
   * `null` with no entry in `errors` is the ordinary outcome.
   */
  aircraft: AircraftLookupResponse | null;
  /** Route the callsign flies; a union discriminated by `source`. */
  route: CallsignRoute | null;
  /**
   * CO₂ estimate for the flight.
   *
   * Priced from the route's **ICAO pair** when the exact-match branch
   * (`source: "vrs"`) supplied a usable one, and from the **callsign** otherwise —
   * the airline-level fallback names the airline's network, not this flight, so it
   * contributes nothing. `null` only when neither was available (no callsign, and no
   * pair), or when the part was not requested.
   */
  carbon: CarbonEstimate | null;
  errors: ComposeErrors<FlightBriefPart>;
}

// ---------------------------------------------------------------------------
// compose.routeBrief
// ---------------------------------------------------------------------------

/**
 * The parts of a {@link RouteBrief}, in the order they appear on the result.
 *
 * There is no primary part here: every one of the seven calls is independent, so a
 * route brief never throws on a part failure.
 */
export const ROUTE_BRIEF_PARTS = [
  "distance",
  "flightTime",
  "originMetar",
  "destinationMetar",
  "originTaf",
  "destinationTaf",
  "carbon",
] as const;

/** One part name accepted by `compose.routeBrief()`'s `include`/`exclude`. */
export type RouteBriefPart = (typeof ROUTE_BRIEF_PARTS)[number];

/**
 * Pre-flight planning for a city pair: how far, how long, what the weather is at
 * both ends and what the flight emits.
 *
 * Weather is fetched **decoded** (`parsed: true`), like {@link AirportBrief}'s.
 *
 * ```ts
 * const brief = await sky.compose.routeBrief("EGLL", "KJFK");
 * console.log(brief.distance?.distance, brief.flightTime?.estimated_hours_display);
 * ```
 */
export interface RouteBrief {
  /** Great-circle distance and bearing between the two airports. */
  distance: DistanceResponse | null;
  /** Predicted gate-to-gate time. */
  flightTime: FlightTimePrediction | null;
  /** Departure field observation, decoded (`parsed: true`). */
  originMetar: ParsedMetarResponse | null;
  /** Arrival field observation, decoded (`parsed: true`). */
  destinationMetar: ParsedMetarResponse | null;
  /** Departure field forecast, decoded (`parsed: true`). */
  originTaf: ParsedTafResponse | null;
  /** Arrival field forecast, decoded (`parsed: true`). */
  destinationTaf: ParsedTafResponse | null;
  /** CO₂ estimate. Needs ICAO codes — IATA input lands a 422 in `errors.carbon`. */
  carbon: CarbonEstimate | null;
  errors: ComposeErrors<RouteBriefPart>;
}

// ---------------------------------------------------------------------------
// compose.enrichAdsb
// ---------------------------------------------------------------------------

/**
 * One live ADS-B state joined with its registry record.
 *
 * The three fields are mutually exclusive in the obvious way: `info` and `error` are
 * never both set, and both being `null` means no lookup was made — the state had no
 * usable `icao24`, or the call's `maxLookups` budget was already spent.
 */
export interface EnrichedAircraft {
  /** The state exactly as it came out of the feed. */
  state: AdsbAircraft;
  /**
   * The registry lookup, envelope and all.
   *
   * Kept as the full response rather than the details, so `{ found: false }` — a
   * genuine "this address is not in the registry" — stays distinguishable from
   * `null`, which means the lookup never happened.
   */
  info: AircraftLookupResponse | null;
  /** Why the lookup failed, when it did. */
  error: SkyLinkError | null;
}

// ---------------------------------------------------------------------------
// compose.schedulesWithStatus
// ---------------------------------------------------------------------------

/**
 * One row of a schedule board joined with the live status of that flight.
 *
 * `entry` keeps the board's **PascalCase** wire keys (`Time`, `Flight`, `Status`);
 * `status` is the separate `GET /flight_status/{number}` response for the number in
 * `entry.Flight`. A row whose `Flight` cell is empty is returned with both `status`
 * and `error` `null` and costs no request.
 */
export interface ScheduleWithStatus<Row = ScheduleDepartureFlight | ScheduleArrivalFlight> {
  /** The board row, verbatim. */
  entry: Row;
  /** Live status of the flight, or `null` when it could not be fetched. */
  status: FlightStatusResponse | null;
  /** Why the status lookup failed, when it did. */
  error: SkyLinkError | null;
}
