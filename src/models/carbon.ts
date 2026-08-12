/**
 * Carbon emission models for `GET /carbon/estimate`.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

// ---------------------------------------------------------------------------
// Literal unions
// ---------------------------------------------------------------------------

/**
 * How much the estimate can be trusted.
 *
 * `high` — the aircraft type was recognised and mapped to a specific emission
 * category; `medium` — no aircraft type was supplied, so the default category was
 * used; `low` — a type was supplied but is unknown to the factor table.
 */
export type CarbonConfidence = "high" | "medium" | "low";

/**
 * Where `distance_km` came from.
 *
 * `haversine` — great-circle distance between the two airports; `adsb_track` —
 * distance actually flown, summed from the ADS-B position track of the most recent
 * matching flight; `historical_flight` — the pre-computed `distance_nm` of that
 * flight row. The latter two only occur when a `callsign` was supplied.
 */
export type CarbonDistanceSource = "haversine" | "adsb_track" | "historical_flight";

/**
 * Where `passengers` came from: `provided` — the caller's `passengers` value;
 * `category_default` — the typical seat count of the aircraft category.
 */
export type CarbonPassengersSource = "provided" | "category_default";

/**
 * Confidence of the callsign→route resolution, echoed from the routes dataset.
 *
 * `high` for an exact VRS callsign match, `low` for an airline-level fallback.
 * Mirrors `RouteConfidence` in `models/routes.ts`.
 */
export type CarbonRouteConfidence = "high" | "low";

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Response of `carbon.estimate()`.
 *
 * ### Conditionally **absent** keys
 *
 * `callsign`, `callsign_resolved` and `route_confidence` are not part of the body
 * unless a `callsign` was supplied — the backend omits the keys entirely rather
 * than sending `null`, so they are optional here. Prefer an `in` check or an
 * `undefined` comparison over a truthiness test:
 *
 * ```ts
 * if ("callsign_resolved" in estimate) {
 *   // the estimate was made from a callsign
 * }
 * ```
 *
 * `route_confidence` is narrower still: it appears only when the route itself was
 * resolved from the routes dataset, so a callsign whose distance came straight from
 * the history database carries `callsign`/`callsign_resolved` but no
 * `route_confidence`.
 */
export interface CarbonEstimate {
  /** Departure airport ICAO, upper-cased (resolved from the callsign when not supplied). */
  departure_icao: string;
  /** Arrival airport ICAO, upper-cased (resolved from the callsign when not supplied). */
  arrival_icao: string;
  /** ICAO type code the estimate used, `null` when neither supplied nor inferred. */
  aircraft_type: string | null;
  /** Emission-factor bucket, e.g. `"widebody"`, `"narrow_body_medium"`, `"turboprop"`. */
  aircraft_category: string;
  distance_km: number;
  distance_nm: number;
  /** Passenger count the per-passenger figure was divided by. */
  passengers: number;
  passengers_source: CarbonPassengersSource;
  /** Total CO₂ for the whole aircraft, in kilograms. */
  co2_kg_total: number;
  /** CO₂ attributed to one passenger, in kilograms. */
  co2_kg_per_passenger: number;
  /** `true` when `include_rfi` was requested and the `co2_equivalent_*` fields are filled. */
  rfi_applied: boolean;
  /** Radiative Forcing Index multiplier (IPCC value, 1.9), reported even when unused. */
  rfi_factor: number;
  /** CO₂-equivalent total in kilograms; `null` unless `include_rfi` was requested. */
  co2_equivalent_kg_total: number | null;
  /** CO₂-equivalent per passenger in kilograms; `null` unless `include_rfi` was requested. */
  co2_equivalent_kg_per_passenger: number | null;
  /** Always the literal `"ICAO-Doc9988"`. */
  methodology: "ICAO-Doc9988";
  confidence: CarbonConfidence;
  distance_source: CarbonDistanceSource;
  /** Free-text caveat describing what the numbers do and do not include. */
  notes: string;
  /** Callsign that was queried, upper-cased. **Key absent** when none was supplied. */
  callsign?: string;
  /**
   * `true` when the callsign produced a route or a historical distance.
   * **Key absent** when no callsign was supplied; `false` means the lookup failed
   * and the airports the caller passed were used instead.
   */
  callsign_resolved?: boolean;
  /** Confidence of the callsign→route lookup. **Key absent** when the route was not resolved. */
  route_confidence?: CarbonRouteConfidence;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters of `carbon.estimate()`.
 *
 * The endpoint needs either `callsign` or **both** `departure_icao` and
 * `arrival_icao`; the SDK rejects any other combination before issuing a request.
 */
export interface CarbonEstimateParams {
  /** Departure airport ICAO, e.g. `"EGLL"`. Required unless `callsign` is given. */
  departure_icao?: string;
  /** Arrival airport ICAO, e.g. `"KJFK"`. Required unless `callsign` is given. */
  arrival_icao?: string;
  /** Flight callsign, e.g. `"BAW117"`. Resolves the route and the flown distance. */
  callsign?: string;
  /** ICAO type code, e.g. `"B77W"`. Omit to infer from the callsign or use the category average. */
  aircraft_type?: string;
  /** Passenger count, 1–900. Omit to use the aircraft category's typical seat count. */
  passengers?: number;
  /** Include non-CO₂ climate effects (contrails, ozone) via the RFI factor. Defaults to `false`. */
  include_rfi?: boolean;
}
