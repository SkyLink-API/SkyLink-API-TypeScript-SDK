/**
 * Derived weather values the API does not compute for you.
 *
 * Re-exported from the package root as `weatherHelpers`, so it does not shadow the
 * `sky.weather` resource namespace.
 *
 * Everything here works off the **decoded** report (`{ parsed: true }`) — raw METAR
 * and TAF text is never re-parsed, since the backend already did that and doing it
 * twice is how the two disagree. Every input is accepted as a METAR envelope, a
 * decoded METAR body, a single TAF forecast period or a plain object: `TafPeriod`
 * carries no `temperature`/`altimeter` at all, so nothing here may assume a field
 * exists.
 *
 * Pure functions — no client, no network, no state.
 */

import { type NumericInput, parseVisibility, toNumber } from "./units.js";

/** Flight rules category, in the order the FAA defines them. */
export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

/** Structural shape of one decoded cloud layer. */
export interface CloudLayerLike {
  /** Coverage code: `"FEW"`, `"SCT"`, `"BKN"`, `"OVC"`, `"VV"`. */
  type?: string | null;
  /** Layer base in **hundreds** of feet AGL — `24` means 2 400 ft. */
  base?: NumericInput;
  /** Original token, e.g. `"BKN024"`. */
  repr?: string | null;
}

/** Structural shape of a decoded visibility group. */
export interface VisibilityGroupLike {
  value?: NumericInput;
  repr?: string | null;
}

/**
 * Anything {@link flightCategory} and {@link ceilingFt} can read.
 *
 * Matches `ParsedMetar`, `TafForecastPeriod`, `ParsedMetarResponse` (the envelope,
 * whose decoded body sits under `parsed`) and hand-built objects.
 */
export interface WeatherSourceLike {
  visibility?: number | string | VisibilityGroupLike | null;
  clouds?: readonly CloudLayerLike[] | null;
  /** Present on the METAR/TAF envelope; the decoded body is read from here. */
  parsed?: WeatherSourceLike | null;
}

/** Anything {@link metarAgeMs} and {@link isStale} can read a report time out of. */
export interface TimedReportLike {
  /** ISO 8601 observation time, when the endpoint reports one. */
  observed_time?: string | null;
  /** ISO 8601 observation time of a decoded body. */
  time?: string | null;
  /** ISO 8601 retrieval time of the envelope. */
  timestamp?: string | null;
  parsed?: TimedReportLike | null;
}

/** A cloud layer at or below this coverage does not constitute a ceiling. */
const CEILING_COVERAGE = new Set(["BKN", "OVC", "VV", "OVX"]);

/** Above this a cloud base is already feet rather than hundreds of feet. */
const BASE_HUNDREDS_MAX = 1000;

function body(source: WeatherSourceLike): WeatherSourceLike {
  // A METAR/TAF envelope carries the decoded fields one level down.
  if (source.visibility === undefined && source.clouds === undefined && source.parsed) {
    return source.parsed;
  }
  return source;
}

/**
 * Lowest broken, overcast or vertical-visibility layer, in **feet** AGL.
 *
 * The trap this exists for: `clouds[].base` is in *hundreds* of feet (`24` is
 * 2 400 ft), scattered and few layers are not a ceiling no matter how low they are,
 * and the layers are not guaranteed to be sorted — so the lowest qualifying layer
 * has to be searched for, not taken from index 0. A base above 1 000 is assumed to
 * be feet already (no cloud sits at 100 000 ft) and passed through.
 *
 * @param source A decoded METAR, a TAF period, or the envelope around either.
 * @returns Ceiling in feet AGL, or `null` when nothing broken or worse was reported.
 */
export function ceilingFt(source: WeatherSourceLike | null | undefined): number | null {
  if (!source) return null;
  const layers = body(source).clouds;
  if (!layers) return null;

  let lowest: number | null = null;
  for (const layer of layers) {
    const coverage = (layer.type ?? layer.repr ?? "").trim().toUpperCase().slice(0, 3);
    if (!CEILING_COVERAGE.has(coverage)) continue;
    const base = toNumber(layer.base);
    if (base === null) continue;
    const feet = base > BASE_HUNDREDS_MAX ? base : base * 100;
    if (lowest === null || feet < lowest) lowest = feet;
  }
  return lowest === null ? null : Math.round(lowest);
}

/**
 * Classify a report as VFR, MVFR, IFR or LIFR.
 *
 * The trap this exists for: the API never sends a flight category of its own on
 * TAF periods and only sometimes on METARs, yet colouring stations on a map is the
 * single most common thing anyone does with this data. Computed from visibility and
 * ceiling only — the raw text is never re-parsed:
 *
 * - **LIFR** — visibility under 1 sm, or ceiling under 500 ft
 * - **IFR** — visibility under 3 sm, or ceiling under 1 000 ft
 * - **MVFR** — visibility 5 sm or less, or ceiling 3 000 ft or less
 * - **VFR** — everything better
 *
 * `P6SM` (which arrives as `{ value: null, repr: "P6" }`) counts as 6 sm, so a
 * clear day is not mistaken for a missing observation.
 *
 * @param source A decoded METAR, a TAF period, or the envelope around either.
 * @returns The category, or `null` when neither visibility nor ceiling was reported.
 */
export function flightCategory(
  source: WeatherSourceLike | null | undefined,
): FlightCategory | null {
  if (!source) return null;
  const decoded = body(source);
  const visibility = parseVisibility(decoded.visibility);
  const statuteMiles = visibility?.statuteMiles ?? null;
  const ceiling = ceilingFt(decoded);

  if (statuteMiles === null && ceiling === null) return null;

  if ((statuteMiles !== null && statuteMiles < 1) || (ceiling !== null && ceiling < 500)) {
    return "LIFR";
  }
  if ((statuteMiles !== null && statuteMiles < 3) || (ceiling !== null && ceiling < 1000)) {
    return "IFR";
  }
  if ((statuteMiles !== null && statuteMiles <= 5) || (ceiling !== null && ceiling <= 3000)) {
    return "MVFR";
  }
  return "VFR";
}

/**
 * Epoch milliseconds of an API timestamp.
 *
 * Aviation times are UTC, but several endpoints serialize them naive (no `Z`, no
 * offset); parsed as-is the runtime would read them as local time and the age would
 * be off by the machine's UTC offset.
 */
function toEpochMs(value: string): number | null {
  const text = value.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const parsed = Date.parse(naive ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(parsed) ? null : parsed;
}

function reportTime(report: TimedReportLike): string | null {
  const candidates = [
    report.observed_time,
    report.parsed?.time,
    report.parsed?.observed_time,
    report.time,
    report.timestamp,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/** Options of {@link metarAgeMs}. */
export interface MetarAgeOptions {
  /** Reference instant. Defaults to now; pass a fixed value in tests. */
  now?: Date | number;
}

/**
 * How long ago a report was observed, in **milliseconds**.
 *
 * The trap this exists for: METARs are issued hourly but the endpoint happily
 * serves a report that is six hours old when a station goes quiet, and nothing in
 * the payload flags that. Time is read from `observed_time`, then `parsed.time`,
 * then the envelope `timestamp`; naive timestamps are treated as UTC.
 *
 * @returns Age in milliseconds (negative for a future timestamp), or `null` when
 *   the report carries no parseable time.
 */
export function metarAgeMs(
  report: TimedReportLike | null | undefined,
  options: MetarAgeOptions = {},
): number | null {
  if (!report) return null;
  const observed = reportTime(report);
  if (observed === null) return null;
  const observedMs = toEpochMs(observed);
  if (observedMs === null) return null;
  const now = options.now === undefined ? Date.now() : Number(options.now);
  return now - observedMs;
}

/** Options of {@link isStale}. */
export interface IsStaleOptions extends MetarAgeOptions {
  /** Maximum acceptable age in milliseconds. Defaults to 90 minutes. */
  maxAgeMs?: number;
}

/** 90 minutes — one and a half METAR cycles, the usual "still current" window. */
export const DEFAULT_MAX_METAR_AGE_MS = 90 * 60 * 1000;

/**
 * Whether a report is older than `maxAgeMs` (default 90 minutes).
 *
 * A report with no usable timestamp counts as stale: it cannot be shown to a pilot
 * as current, and silently treating it as fresh is the failure mode worth avoiding.
 */
export function isStale(
  report: TimedReportLike | null | undefined,
  options: IsStaleOptions = {},
): boolean {
  const age = metarAgeMs(report, options);
  if (age === null) return true;
  return age > (options.maxAgeMs ?? DEFAULT_MAX_METAR_AGE_MS);
}

/** Wind resolved into runway-relative components. */
export interface WindComponents {
  /** Knots along the runway; **negative means a tailwind**. */
  headwindKt: number;
  /** Knots across the runway, always positive — {@link fromRight} carries the side. */
  crosswindKt: number;
  /** `true` when the crosswind comes from the right of the runway heading. */
  fromRight: boolean;
}

/**
 * Resolve a wind into head/tail and crosswind components for a runway.
 *
 * The trap this exists for: the runway heading needed here comes from
 * `EnrichedAirport.runways[].le_heading_degT`, which is a raw CSV pass-through and
 * arrives as a number on one deployment and as a string on the next — all three
 * inputs are therefore coerced rather than trusted. Wind direction is degrees true,
 * matching both `le_heading_degT` and `parsed.wind.direction`; magnetic runway
 * designators (`"04L"` → 040 magnetic) are *not* the same thing.
 *
 * @param runwayHeadingDeg Runway heading in degrees true.
 * @param windDirectionDeg Wind direction in degrees true (where the wind is *from*).
 * @param windSpeedKt Wind speed in knots.
 * @returns The components, or `null` when any input is missing or non-numeric —
 *   which includes a variable wind, where `direction` is `null`.
 */
export function windComponents(
  runwayHeadingDeg: NumericInput,
  windDirectionDeg: NumericInput,
  windSpeedKt: NumericInput,
): WindComponents | null {
  const heading = toNumber(runwayHeadingDeg);
  const direction = toNumber(windDirectionDeg);
  const speed = toNumber(windSpeedKt);
  if (heading === null || direction === null || speed === null) return null;

  const angle = ((direction - heading) * Math.PI) / 180;
  return {
    headwindKt: speed * Math.cos(angle),
    crosswindKt: Math.abs(speed * Math.sin(angle)),
    fromRight: Math.sin(angle) > 0,
  };
}
