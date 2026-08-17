/**
 * `sky.compose` — the joins you would otherwise write by hand.
 *
 * Every screen that shows an airport, a flight or a route needs half a dozen
 * endpoints at once, and writing that by hand means writing the boring half twice:
 * fan the calls out in parallel, and make sure the one that 403s does not take the
 * other five with it. That is all this namespace is.
 *
 * Two rules hold everywhere here:
 *
 * - **Degrade, do not fail.** A failed part is `null` and its {@link SkyLinkError}
 *   goes into `errors[part]`. The exceptions are the primary calls — `airports.search`
 *   for an airport brief, `flight_status` for a flight brief — whose failure makes the
 *   whole aggregate meaningless, so they are thrown. Anything that is not a
 *   `SkyLinkError` is a bug in the SDK or in a caller's `fetch` and is always thrown.
 * - **Only fetch what was asked for.** `include` lists the parts to fetch; `exclude`
 *   subtracts from the full set. Passing both is an error, and so is a part name that
 *   is not on the list — at compile time via the part unions, and at runtime for
 *   JavaScript callers.
 *
 * ```ts
 * const brief = await sky.compose.airportBrief("KJFK", { exclude: ["charts", "arrivals"] });
 * console.log(brief.metar?.raw, Object.keys(brief.errors));
 * ```
 */

import { SkyLinkError } from "../core/errors.js";
import type { RequestOptions } from "../core/types.js";
import { mapConcurrent } from "../helpers/batch.js";
import { classifyAirportCode, normalizeIcao24, normalizeRegistration } from "../helpers/idents.js";
import type { AdsbAircraft } from "../models/adsb.js";
import type { AircraftLookupResponse } from "../models/aircraft.js";
import type { CarbonEstimateParams } from "../models/carbon.js";
import {
  AIRPORT_BRIEF_PARTS,
  type AirportBrief,
  type AirportBriefPart,
  type ComposeErrors,
  type EnrichedAircraft,
  FLIGHT_BRIEF_PARTS,
  type FlightBrief,
  type FlightBriefPart,
  ROUTE_BRIEF_PARTS,
  type RouteBrief,
  type RouteBriefPart,
  type ScheduleWithStatus,
} from "../models/compose.js";
import type { FlightStatusResponse } from "../models/flight-status.js";
import type { Country } from "../models/geo.js";
import type { CallsignRoute } from "../models/routes.js";
import type {
  ArrivalsResponse,
  DeparturesResponse,
  ScheduleArrivalFlight,
  ScheduleDepartureFlight,
  ScheduleDirection,
  SchedulesParams,
} from "../models/schedules.js";
import { APIResource } from "./base.js";

/** Rows kept from each schedule board when the caller does not say. */
export const DEFAULT_SCHEDULES_LIMIT = 10;

/**
 * Registry lookups a single {@link Compose.enrichAdsb} call may issue.
 *
 * Deliberately small: a busy bounding box holds thousands of aircraft, and one
 * unguarded enrichment of it would spend a month's quota in a minute.
 */
export const DEFAULT_MAX_LOOKUPS = 50;

/** `include`/`exclude` selection shared by the three brief methods. */
export interface PartSelection<Part extends string> {
  /**
   * Fetch **only** these parts. Mutually exclusive with `exclude`.
   *
   * The names are the field names of the result, so `include: ["metar", "taf"]`
   * issues exactly two requests and leaves every other field `null`.
   */
  include?: readonly Part[];
  /** Fetch everything except these parts. Mutually exclusive with `include`. */
  exclude?: readonly Part[];
}

/** Options of {@link Compose.airportBrief}. */
export interface AirportBriefOptions extends RequestOptions, PartSelection<AirportBriefPart> {
  /**
   * Rows to keep from each schedule board. Defaults to
   * {@link DEFAULT_SCHEDULES_LIMIT}.
   *
   * The boards have no server-side limit — they come back whole, several hundred rows
   * deep — so this truncates `flights` client-side. The envelope's `total_flights`
   * still reports the full board, which is how you tell there is more.
   */
  schedulesLimit?: number;
}

/** Options of {@link Compose.flightBrief}. */
export type FlightBriefOptions = RequestOptions & PartSelection<FlightBriefPart>;

/** Options of {@link Compose.routeBrief}. */
export interface RouteBriefOptions extends RequestOptions, PartSelection<RouteBriefPart> {
  /**
   * ICAO type designator (`"B77W"`) conditioning both models: the block-time
   * prediction and the CO₂ estimate.
   *
   * Omit to let each endpoint use its own default — a category average for carbon,
   * a fleet-wide cruise profile for the time.
   */
  aircraftType?: string;
  /**
   * Seats to divide the emissions over, passed to `/carbon/estimate`.
   *
   * Omit for the aircraft category's typical seat count. Affects the per-passenger
   * figures only; the total is the same flight either way.
   */
  passengers?: number;
}

/** Options of {@link Compose.enrichAdsb}. */
export interface EnrichAdsbOptions extends RequestOptions {
  /** Lookups in flight at once. Defaults to 5, sized for RapidAPI's per-second rate. */
  concurrency?: number;
  /**
   * Fetch photo URLs with each lookup. Defaults to **`false`**, unlike
   * `sky.aircraft.byIcao24()` where the endpoint's own default (`true`) applies.
   *
   * Photos are the slow path of that endpoint — an extra upstream call per airframe —
   * and this method makes up to `maxLookups` of them. Opt back in when the pictures
   * are the point.
   */
  photos?: boolean;
  /**
   * Hard cap on registry lookups for this call. Defaults to
   * {@link DEFAULT_MAX_LOOKUPS}.
   *
   * States beyond the cap come back with `info: null` and **no request is made** —
   * the cap is a quota guard, not a pagination knob. Distinct `icao24` addresses are
   * what is counted; duplicates are free. `0` disables lookups entirely.
   */
  maxLookups?: number;
}

/** Options of {@link Compose.schedulesWithStatus}. */
export interface SchedulesWithStatusOptions extends RequestOptions {
  /** Which board to read. Defaults to `"departures"`. */
  direction?: ScheduleDirection;
  /**
   * Rows to take from the board — and therefore status calls to make. Defaults to
   * {@link DEFAULT_SCHEDULES_LIMIT}. The board is truncated **before** any status
   * call, so this is a quota bound, not a display bound.
   */
  limit?: number;
  /** Status calls in flight at once. Defaults to 5. */
  concurrency?: number;
}

/**
 * Resolve `include`/`exclude` into the set of parts to fetch.
 *
 * @throws {SkyLinkError} When both lists are given, or a name is not a known part.
 */
function selectParts<Part extends string>(
  all: readonly Part[],
  selection: PartSelection<Part>,
  method: string,
): ReadonlySet<Part> {
  const { include, exclude } = selection;
  if (include && exclude) {
    throw new SkyLinkError(`${method}: pass either 'include' or 'exclude', not both.`);
  }

  const known = new Set<string>(all);
  const validate = (names: readonly Part[], which: string): void => {
    for (const name of names) {
      if (!known.has(name)) {
        throw new SkyLinkError(
          `${method}: unknown part '${String(name)}' in '${which}'. Valid parts: ${all.join(", ")}.`,
        );
      }
    }
  };

  if (include) {
    validate(include, "include");
    return new Set(include);
  }
  if (exclude) {
    validate(exclude, "exclude");
    const removed = new Set<string>(exclude);
    return new Set(all.filter((part) => !removed.has(part)));
  }
  return new Set(all);
}

/**
 * Run one part, filing a {@link SkyLinkError} under its name instead of throwing.
 *
 * Anything else propagates: a `TypeError` is a bug, and burying it in a result field
 * would turn it into a silent `null`.
 */
async function capture<Part extends string, T>(
  errors: ComposeErrors<Part>,
  part: Part,
  call: () => Promise<T>,
): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SkyLinkError) {
      errors[part] = error;
      return null;
    }
    throw error;
  }
}

/** Reject a bound that would silently do nothing sane. */
function requireCount(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new SkyLinkError(`${name} must be an integer >= ${minimum}, received ${String(value)}.`);
  }
  return value;
}

/**
 * The same rule (and message) as {@link mapConcurrent}'s own check.
 *
 * Repeated here so a method that makes a request *before* it fans out —
 * {@link Compose.schedulesWithStatus} reads the board first — refuses an unusable
 * `concurrency` without spending that request.
 */
function requireConcurrency(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || Math.floor(value) !== value || value < 1) {
    throw new SkyLinkError(`concurrency must be a positive integer, received ${String(value)}.`);
  }
}

/** Reject a misspelled board direction from a JavaScript caller, before the request. */
function requireDirection(direction: string): ScheduleDirection {
  if (direction !== "departures" && direction !== "arrivals") {
    throw new SkyLinkError(
      `direction must be 'departures' or 'arrivals', received ${String(direction)}.`,
    );
  }
  return direction;
}

/** Input order, duplicates removed — one request per distinct identifier. */
function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/**
 * Keep the first `limit` rows of a board.
 *
 * The cast is safe by construction — only `flights` is replaced, with a slice of
 * itself — but TypeScript cannot see that through the generic spread.
 */
function truncateBoard<Board extends DeparturesResponse | ArrivalsResponse>(
  board: Board,
  limit: number,
): Board {
  const flights = board?.flights;
  if (!Array.isArray(flights) || flights.length <= limit) return board;
  return { ...board, flights: flights.slice(0, limit) } as Board;
}

/**
 * Dig a registration out of a flight status response.
 *
 * The typed response has no registration field, and the live upstream (a scrape of
 * flightera's JSON-LD) does not send one — but the endpoint's own OpenAPI example
 * documents `aircraft.registration`, and the SDK never reshapes a body, so the field
 * may simply appear. Every documented and plausible spelling is probed, and finding
 * none is a normal outcome, not an error.
 */
function extractRegistration(status: FlightStatusResponse | null): string | null {
  if (!status) return null;
  const raw = status as unknown as Record<string, unknown> & {
    aircraft?: Record<string, unknown> | null;
  };
  // Same spellings, in the same order, as the Python SDK's `_REGISTRATION_KEYS`.
  const keys = ["registration", "aircraft_registration", "tail_number", "tail", "reg"];
  const nested = typeof raw.aircraft === "object" && raw.aircraft !== null ? raw.aircraft : {};
  const candidates = [...keys.map((key) => raw[key]), ...keys.map((key) => nested[key])];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeRegistration(candidate);
    // The scraped placeholders ("--", "N/A") are "no data" dressed as a value.
    if (normalized && normalized !== "N/A" && !/^-+$/.test(normalized)) return normalized;
  }
  return null;
}

/**
 * `"BA 123"` → `"BA123"`; blanks and the scraper's dashes → `null`.
 *
 * Flight numbers arrive spaced on a status payload (`"BA 123"`, the display form of
 * the source page) and bare on a schedule row (`"C84093"`), while both the status and
 * the route endpoints want them unspaced. `"--"` and `"..."` are the scraper's way of
 * writing "no value" and are not flight numbers.
 */
function normalizeFlightNumber(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (compact === "" || /^[-.]+$/.test(compact)) return null;
  return compact;
}

/** The row's flight number, unspaced — wire key `Flight`, PascalCase like the rest of the row. */
function flightOfRow(row: ScheduleDepartureFlight | ScheduleArrivalFlight): string | null {
  return normalizeFlightNumber(row?.Flight);
}

/** The ICAO type designator of a registry lookup, when it found anything. */
function aircraftTypeOf(lookup: AircraftLookupResponse | null): string | null {
  if (lookup === null || lookup.found !== true) return null;
  const icaoType = lookup.aircraft?.icao_type;
  if (typeof icaoType !== "string") return null;
  const trimmed = icaoType.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * The CO₂ request of a flight brief, or `null` when there is nothing to price.
 *
 * `/carbon/estimate` accepts an **ICAO airport pair** or a **callsign**, and the two
 * answers are not the same: the pair is priced on the great-circle distance, the
 * callsign is resolved against VRS standing data and, when a matching flight exists,
 * priced on the distance actually flown. So the pair from a `"vrs"` route wins when
 * there is one, and the callsign is the fallback — including when `route` was
 * excluded, or came back as the airline-level variant, whose IATA airports belong to
 * the airline's network rather than to this flight.
 *
 * Equal departure and arrival are a 422 on the endpoint, so that pair is skipped and
 * the callsign used instead.
 */
function flightCarbonParams(
  route: CallsignRoute | null,
  callsign: string | null,
  aircraftType: string | null,
): CarbonEstimateParams | null {
  if (route?.source === "vrs") {
    const departure = route.departure_icao?.trim().toUpperCase() ?? "";
    const arrival = route.arrival_icao?.trim().toUpperCase() ?? "";
    if (departure !== "" && arrival !== "" && departure !== arrival) {
      return {
        departure_icao: departure,
        arrival_icao: arrival,
        aircraft_type: aircraftType ?? undefined,
      };
    }
  }
  if (callsign !== null) return { callsign, aircraft_type: aircraftType ?? undefined };
  return null;
}

/**
 * Is this row North America? Tolerant of every spelling the API has used.
 *
 * Three count: `"NA"` (what the backend sends today, and the correct value), `null`
 * (what it sent until the 2026-08 release, pandas having read the literal `NA` as
 * not-a-number), and `""` (the other shape a fixed loader could produce). Keeping the
 * two historical spellings costs nothing and means the method answers correctly
 * against an older deployment instead of returning `[]`.
 */
function isNorthAmerican(country: Country): boolean {
  const continent = country?.continent;
  if (continent === null || continent === undefined) return true;
  if (typeof continent !== "string") return false;
  const trimmed = continent.trim();
  return trimmed === "" || trimmed.toUpperCase() === "NA";
}

/** Multi-endpoint aggregates: one call in, one assembled answer out. */
export class Compose extends APIResource {
  /**
   * Everything about an airport right now, in one call: the airport record, METAR,
   * TAF, NOTAMs, FAA delays, charts and both schedule boards.
   *
   * All eight requests go out in parallel. `airports.search` is the primary one — its
   * failure is thrown, because the rest of the brief describes an airport that does
   * not exist. Every other failure lands in `errors` keyed by its field name, so a
   * non-US airport (no FAA delay feed) or one with no published charts still returns
   * a usable brief.
   *
   * METAR and TAF are requested **decoded** (`parsed: true`), so `brief.metar.parsed`
   * is there for `weatherHelpers.flightCategory()` without a second call.
   *
   * ```ts
   * const brief = await sky.compose.airportBrief("KJFK", { schedulesLimit: 5 });
   * console.log(brief.metar?.parsed?.flight_rules, brief.departures?.flights.length); // 5
   * ```
   *
   * @param icao Four-letter ICAO code. The schedule boards and the weather endpoints
   * all take ICAO, so an IATA code will fail most of the parts.
   * @throws {SkyLinkError} When `include` and `exclude` are both given, when a part
   * name is unknown, or when the airport lookup itself fails.
   */
  async airportBrief(icao: string, options: AirportBriefOptions = {}): Promise<AirportBrief> {
    const {
      include,
      exclude,
      schedulesLimit = DEFAULT_SCHEDULES_LIMIT,
      ...requestOptions
    } = options;
    const parts = selectParts(AIRPORT_BRIEF_PARTS, { include, exclude }, "compose.airportBrief()");
    const rows = requireCount(schedulesLimit, "schedulesLimit", 0);

    const errors: ComposeErrors<AirportBriefPart> = {};
    const brief: AirportBrief = {
      airport: null,
      metar: null,
      taf: null,
      notams: null,
      delays: null,
      charts: null,
      departures: null,
      arrivals: null,
      errors,
    };

    const jobs: Promise<unknown>[] = [];

    if (parts.has("airport")) {
      // Primary: not wrapped in capture(), so a 404 here rejects the whole brief.
      jobs.push(
        this.client.airports.search({ icao }, requestOptions).then((value) => {
          brief.airport = value;
        }),
      );
    }
    if (parts.has("metar")) {
      jobs.push(
        capture(errors, "metar", () =>
          // Decoded, not raw: a brief exists to be read, and `flightCategory()` and
          // friends work off the `parsed` block.
          this.client.weather.metar(icao, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.metar = value;
        }),
      );
    }
    if (parts.has("taf")) {
      jobs.push(
        capture(errors, "taf", () =>
          this.client.weather.taf(icao, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.taf = value;
        }),
      );
    }
    if (parts.has("notams")) {
      jobs.push(
        capture(errors, "notams", () =>
          this.client.notams.byAirport(icao, {}, requestOptions),
        ).then((value) => {
          brief.notams = value;
        }),
      );
    }
    if (parts.has("delays")) {
      jobs.push(
        capture(errors, "delays", () => this.client.delays.faa(icao, requestOptions)).then(
          (value) => {
            brief.delays = value;
          },
        ),
      );
    }
    if (parts.has("charts")) {
      jobs.push(
        capture(errors, "charts", () =>
          this.client.charts.byAirport(icao, {}, requestOptions),
        ).then((value) => {
          brief.charts = value;
        }),
      );
    }
    if (parts.has("departures")) {
      jobs.push(
        capture(errors, "departures", async () =>
          truncateBoard(await this.client.schedules.departures({ icao }, requestOptions), rows),
        ).then((value) => {
          brief.departures = value;
        }),
      );
    }
    if (parts.has("arrivals")) {
      jobs.push(
        capture(errors, "arrivals", async () =>
          truncateBoard(await this.client.schedules.arrivals({ icao }, requestOptions), rows),
        ).then((value) => {
          brief.arrivals = value;
        }),
      );
    }

    await Promise.all(jobs);
    return brief;
  }

  /**
   * A flight number resolved as far as the API can take it.
   *
   * The chain is `flight_status` → (registration) → `aircraft.byRegistration` and, in
   * parallel with it, `routes.byCallsign` → `carbon.estimate`. Independent steps run
   * together; dependent ones cannot.
   *
   * A status response with no registration in it — the usual case, the live source
   * does not publish one — is **not** an error: `aircraft` is simply `null` with no
   * entry in `errors`. When there is one, the whole lookup is kept, so the registry's
   * `found: false` sentinel arrives as `aircraft.found === false` rather than as a
   * second kind of `null`.
   *
   * The route is looked up by **what you passed**, spaces removed (`"BA 123"` →
   * `"BA123"`), and only falls back to the status payload's own flight number when the
   * argument is not a usable designator. An IATA number usually resolves through the
   * airline-level fallback, so `route.source` is often `"airline_routes"`; pass the
   * ICAO callsign (`"BAW123"`) for the exact `"vrs"` match.
   *
   * `carbon` is priced from the route's ICAO pair when the `"vrs"` branch supplied a
   * usable one, and **from the callsign otherwise** — so excluding `route`, or getting
   * the airline-level fallback, still produces an estimate. The `aircraft_type` from
   * the registry lookup is passed along when there was one, which is why the estimate
   * waits for both of the parallel steps.
   *
   * ```ts
   * const brief = await sky.compose.flightBrief("BA123");
   * if (brief.route?.source === "vrs") console.log(brief.route.departure_icao);
   * ```
   *
   * @param flightNumber IATA (`"BA123"`) or ICAO (`"BAW123"`) flight number.
   * @throws {SkyLinkError} When the selection is invalid, or the status lookup fails.
   */
  async flightBrief(flightNumber: string, options: FlightBriefOptions = {}): Promise<FlightBrief> {
    const { include, exclude, ...requestOptions } = options;
    const parts = selectParts(FLIGHT_BRIEF_PARTS, { include, exclude }, "compose.flightBrief()");

    const errors: ComposeErrors<FlightBriefPart> = {};
    const brief: FlightBrief = { status: null, aircraft: null, route: null, carbon: null, errors };

    if (parts.has("status")) {
      // Primary: a brief for a flight number the API does not know is not a brief.
      brief.status = await this.client.flightStatus(flightNumber, requestOptions);
    }

    const registration = extractRegistration(brief.status);
    // What the caller passed wins; the payload's number is only the fallback. The order
    // matters and is the opposite of what looks natural: `/flight_status` normalizes the
    // designator to its IATA form ("BAW117" in, "BA117" out), while `/routes/callsign`
    // only finds the exact VRS match — the one carrying the airport pair that also
    // prices the CO₂ — under the **ICAO** callsign. Preferring the payload downgraded
    // every ICAO callsign to the airline-level fallback and made the documented "pass
    // BAW117 for the exact match" impossible (found on the live API, 2026-08-12).
    const callsign =
      normalizeFlightNumber(flightNumber) ?? normalizeFlightNumber(brief.status?.flight_number);

    const jobs: Promise<unknown>[] = [];

    if (parts.has("aircraft") && registration) {
      jobs.push(
        // The whole lookup is kept, sentinel included: `{ found: false }` is the
        // registry saying "not mine", which is different from never having asked.
        capture(errors, "aircraft", () =>
          this.client.aircraft.byRegistration(registration, {}, requestOptions),
        ).then((value) => {
          brief.aircraft = value;
        }),
      );
    }

    if (parts.has("route") && callsign !== null) {
      jobs.push(
        capture(errors, "route", () =>
          this.client.routes.byCallsign(callsign, requestOptions),
        ).then((value) => {
          brief.route = value;
        }),
      );
    }

    await Promise.all(jobs);

    if (parts.has("carbon")) {
      const params = flightCarbonParams(brief.route, callsign, aircraftTypeOf(brief.aircraft));
      if (params !== null) {
        brief.carbon = await capture(errors, "carbon", () =>
          this.client.carbon.estimate(params, requestOptions),
        );
      }
    }

    return brief;
  }

  /**
   * Mini flight-planning for a city pair: distance, predicted block time, weather at
   * both ends and the CO₂ of flying it.
   *
   * All seven requests are independent and go out at once. There is no primary part —
   * every failure is collected, so this method only throws on an invalid selection or
   * on a non-API bug. Both ends' weather is requested **decoded** (`parsed: true`).
   *
   * ```ts
   * const brief = await sky.compose.routeBrief("EGLL", "KJFK", {
   *   include: ["distance", "flightTime"],
   * });
   * ```
   *
   * @param origin Origin airport. ICAO throughout — `weather.*` and `carbon.estimate`
   * reject IATA codes, and those failures would land in `errors`.
   * @param destination Destination airport, same caveat.
   * @throws {SkyLinkError} When `include` and `exclude` are both given, or a part name
   * is unknown.
   */
  async routeBrief(
    origin: string,
    destination: string,
    options: RouteBriefOptions = {},
  ): Promise<RouteBrief> {
    const { include, exclude, aircraftType, passengers, ...requestOptions } = options;
    const parts = selectParts(ROUTE_BRIEF_PARTS, { include, exclude }, "compose.routeBrief()");

    const errors: ComposeErrors<RouteBriefPart> = {};
    const brief: RouteBrief = {
      distance: null,
      flightTime: null,
      originMetar: null,
      destinationMetar: null,
      originTaf: null,
      destinationTaf: null,
      carbon: null,
      errors,
    };

    const jobs: Promise<unknown>[] = [];

    if (parts.has("distance")) {
      jobs.push(
        capture(errors, "distance", () =>
          this.client.distance({ from_icao: origin, to_icao: destination }, requestOptions),
        ).then((value) => {
          brief.distance = value;
        }),
      );
    }
    if (parts.has("flightTime")) {
      jobs.push(
        capture(errors, "flightTime", () =>
          this.client.ml.flightTime(
            { origin, destination, aircraft: aircraftType },
            requestOptions,
          ),
        ).then((value) => {
          brief.flightTime = value;
        }),
      );
    }
    if (parts.has("originMetar")) {
      jobs.push(
        // Decoded, like the airport brief's weather: the numbers are the point.
        capture(errors, "originMetar", () =>
          this.client.weather.metar(origin, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.originMetar = value;
        }),
      );
    }
    if (parts.has("destinationMetar")) {
      jobs.push(
        capture(errors, "destinationMetar", () =>
          this.client.weather.metar(destination, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.destinationMetar = value;
        }),
      );
    }
    if (parts.has("originTaf")) {
      jobs.push(
        capture(errors, "originTaf", () =>
          this.client.weather.taf(origin, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.originTaf = value;
        }),
      );
    }
    if (parts.has("destinationTaf")) {
      jobs.push(
        capture(errors, "destinationTaf", () =>
          this.client.weather.taf(destination, { parsed: true }, requestOptions),
        ).then((value) => {
          brief.destinationTaf = value;
        }),
      );
    }
    if (parts.has("carbon")) {
      jobs.push(
        capture(errors, "carbon", () =>
          this.client.carbon.estimate(
            {
              departure_icao: origin,
              arrival_icao: destination,
              aircraft_type: aircraftType,
              passengers,
            },
            requestOptions,
          ),
        ).then((value) => {
          brief.carbon = value;
        }),
      );
    }

    await Promise.all(jobs);
    return brief;
  }

  /**
   * Join live ADS-B states with the aircraft registry: type, operator, owner, photos.
   *
   * The feed only resolves `registration`, `aircraft_type` and `airline` for aircraft
   * it happens to know; this fills in the rest from `GET /aircraft/icao24/{hex}`.
   *
   * Three guards make that affordable. Repeated `icao24` addresses within one call are
   * looked up **once** (the same airframe appears in every snapshot of a live feed),
   * no more than `maxLookups` distinct addresses are looked up at all — the remainder
   * come back with `info: null` and cost nothing — and `photos` defaults to `false`
   * here, since it is the slow half of the lookup endpoint. Lookups run
   * `concurrency`-at-a-time, and a failed one is reported on its own aircraft.
   *
   * ```ts
   * const feed = await sky.adsb.aircraft({ bbox: [51, -1, 52, 0] });
   * const enriched = await sky.compose.enrichAdsb(feed.aircraft, { maxLookups: 20 });
   * for (const { state, info } of enriched) {
   *   if (info?.found) console.log(state.callsign, info.aircraft.manufacturer_and_model);
   * }
   * ```
   *
   * @param states Any iterable of ADS-B states — typically `response.aircraft`.
   * @returns One entry per input state, in input order.
   * @throws {SkyLinkError} When `maxLookups` or `concurrency` is not a usable count.
   */
  async enrichAdsb(
    states: Iterable<AdsbAircraft>,
    options: EnrichAdsbOptions = {},
  ): Promise<EnrichedAircraft[]> {
    const {
      concurrency,
      maxLookups = DEFAULT_MAX_LOOKUPS,
      photos = false,
      ...requestOptions
    } = options;
    const budget = requireCount(maxLookups, "maxLookups", 0);

    const list = [...states];
    // Normalized: the feed sends lower-case hex and the registry echoes upper-case,
    // so the same airframe would otherwise be two memo keys and two requests.
    const keys = list.map((state) => normalizeIcao24(state?.icao24));
    const targets = unique(keys.filter((key): key is string => key !== null)).slice(0, budget);

    const settled = await mapConcurrent(
      targets,
      (icao24) => this.client.aircraft.byIcao24(icao24, { photos }, requestOptions),
      { concurrency, signal: requestOptions.signal },
    );

    const byKey = new Map<string, AircraftLookupResponse | Error>();
    targets.forEach((key, index) => {
      const result = settled[index];
      if (result !== undefined) byKey.set(key, result);
    });

    return list.map((state, index) => {
      const key = keys[index];
      const result = key === null || key === undefined ? undefined : byKey.get(key);
      if (result === undefined) return { state, info: null, error: null };
      if (result instanceof Error) {
        if (!(result instanceof SkyLinkError)) throw result;
        return { state, info: null, error: result };
      }
      return { state, info: result, error: null };
    });
  }

  /**
   * A schedule board with the live status of each flight on it.
   *
   * The board is fetched first and truncated to `limit` **before** any status call, so
   * the request count is bounded by `limit` plus one. The flight number comes from the
   * row's `Flight` cell — schedule rows are the one place in the API with PascalCase
   * keys — with the spaces removed, and a row without one costs no request. A number
   * that appears twice on the board is requested **once**.
   *
   * The board fetch is the primary call and its failure is thrown: there is nowhere in
   * a list of rows to report "there were no rows". A failed status lookup is reported
   * on its own row, in `error`.
   *
   * ```ts
   * const board = await sky.compose.schedulesWithStatus("LHR", { limit: 5 });
   * for (const { entry, status } of board) {
   *   console.log(entry.Time, entry.Destination, status?.status ?? entry.Status);
   * }
   * ```
   *
   * @param icao Airport code — ICAO (`"EGLL"`) or IATA (`"LHR"`). This method only
   * touches `/schedules`, which accepts both, so the parameter is picked from the
   * code's shape: three letters go out as `iata`, anything else as `icao`.
   * @throws {SkyLinkError} When `limit` is not a positive integer, `concurrency` is not
   * usable, `direction` is misspelled, or the board request fails.
   */
  schedulesWithStatus(
    icao: string,
    options: SchedulesWithStatusOptions & { direction: "arrivals" },
  ): Promise<ScheduleWithStatus<ScheduleArrivalFlight>[]>;
  schedulesWithStatus(
    icao: string,
    options?: SchedulesWithStatusOptions & { direction?: "departures" },
  ): Promise<ScheduleWithStatus<ScheduleDepartureFlight>[]>;
  async schedulesWithStatus(
    icao: string,
    options: SchedulesWithStatusOptions = {},
  ): Promise<ScheduleWithStatus[]> {
    const {
      direction = "departures",
      limit = DEFAULT_SCHEDULES_LIMIT,
      concurrency,
      ...requestOptions
    } = options;
    const rowLimit = requireCount(limit, "limit", 0);
    // Checked before the board request, not by mapConcurrent afterwards: a useless
    // concurrency should not cost a call.
    requireConcurrency(concurrency);
    const board = await this.board(icao, requireDirection(direction), requestOptions);

    const rows: (ScheduleDepartureFlight | ScheduleArrivalFlight)[] = Array.isArray(board?.flights)
      ? board.flights.slice(0, rowLimit)
      : [];

    // One request per distinct number: a board routinely lists the same flight twice
    // (a codeshare row, a rescheduled row), and the status of a number is the status
    // of that number however many rows mention it.
    const numbers = unique(
      rows.map(flightOfRow).filter((number): number is string => number !== null),
    );
    const settled = await mapConcurrent(
      numbers,
      (number) => this.client.flightStatus(number, requestOptions),
      { concurrency, signal: requestOptions.signal },
    );

    const byNumber = new Map<string, FlightStatusResponse | Error>();
    numbers.forEach((number, index) => {
      const result = settled[index];
      if (result !== undefined) byNumber.set(number, result);
    });

    return rows.map((entry) => {
      const number = flightOfRow(entry);
      const result = number === null ? undefined : byNumber.get(number);
      if (result === undefined) return { entry, status: null, error: null };
      if (result instanceof Error) {
        if (!(result instanceof SkyLinkError)) throw result;
        return { entry, status: null, error: result };
      }
      return { entry, status: result, error: null };
    });
  }

  /**
   * One schedule board, addressed by whichever code parameter fits.
   *
   * `/schedules/{direction}` takes `icao=` **or** `iata=` and rejects the wrong one,
   * so the choice is made from the code's shape — three letters is IATA. This is the
   * only place `schedulesWithStatus` touches the airport code, which is why it can be
   * more forgiving than `airportBrief`, where METAR, NOTAMs and charts are ICAO-only.
   */
  private board(
    code: string,
    direction: ScheduleDirection,
    options: RequestOptions,
  ): Promise<DeparturesResponse | ArrivalsResponse> {
    const params: SchedulesParams =
      classifyAirportCode(code) === "iata" ? { iata: code } : { icao: code };
    return direction === "arrivals"
      ? this.client.schedules.arrivals(params, options)
      : this.client.schedules.departures(params, options);
  }

  /**
   * The 41 North-American countries, whatever the backend calls them.
   *
   * ```ts
   * const na = await sky.compose.northAmericaCountries();
   * console.log(na.length); // 41
   * ```
   *
   * This began as a workaround: the reference dataset was loaded with pandas, which
   * reads the literal `NA` as "not available", so every North-American row arrived
   * with `continent: null` and `geo.countries({ continent: "NA" })` answered with an
   * empty list.
   *
   * **That backend bug is fixed.** As of 2026-08-15 the filter returns the same 41
   * countries in one small response, and it is the call to reach for. This method is
   * kept because it is public API and because it still answers correctly against a
   * deployment predating the fix; the cost is downloading all ~250 countries and
   * filtering client side.
   *
   * @see {@link Geo.countries} — the direct route.
   */
  async northAmericaCountries(options?: RequestOptions): Promise<Country[]> {
    const response = await this.client.geo.countries({}, options);
    const countries = response?.countries;
    if (!Array.isArray(countries)) return [];
    return countries.filter(isNorthAmerican);
  }
}
