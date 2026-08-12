/**
 * Unit converters and tolerant parsers for the mixed units the API speaks.
 *
 * A single response can carry feet, knots, nautical miles, kilometres, inches of
 * mercury and hectopascals side by side, and the numbers themselves are not always
 * numbers: values forwarded from the upstream CSVs (`lighted`, `frequency_mhz`,
 * runway headings) arrive as `1` on one deployment and `"1"` on the next. Every
 * function here therefore accepts `number | string | null | undefined` and answers
 * `null` instead of throwing when the input is not numeric.
 *
 * Pure functions — no client, no network, no state.
 */

/** Anything the API might put in a numeric field. */
export type NumericInput = number | string | null | undefined;

// ---------------------------------------------------------------------------
// Coefficients
// ---------------------------------------------------------------------------

/** Metres in one international foot (exact). */
export const METERS_PER_FOOT = 0.3048;
/** Feet in one metre (exact reciprocal of {@link METERS_PER_FOOT}). */
export const FEET_PER_METER = 1 / METERS_PER_FOOT;
/** Kilometres in one nautical mile (exact). */
export const KM_PER_NM = 1.852;
/** Kilometres in one statute mile (exact). */
export const KM_PER_SM = 1.609344;
/** Metres in one statute mile (exact). */
export const METERS_PER_SM = 1609.344;
/** Kilometres per hour in one knot (exact). */
export const KMH_PER_KT = 1.852;
/** Metres per second in one knot (exact). */
export const MS_PER_KT = 1852 / 3600;
/** Miles per hour in one knot (exact). */
export const MPH_PER_KT = 1.852 / 1.609344;
/** Hectopascals in one inch of mercury (exact, at 0 °C standard gravity). */
export const HPA_PER_INHG = 33.86388666666671;
/** Metres per second in one foot per minute (exact). */
export const MS_PER_FPM = 0.3048 / 60;

// ---------------------------------------------------------------------------
// Core coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a wire value to a finite number, or `null`.
 *
 * The trap this exists for: the OurAirports pass-through columns (`lighted`,
 * `closed`, `frequency_mhz`, `frequency_khz`, `le_heading_degT`) are typed
 * `string | number | null` because the live API sends both forms depending on how
 * pandas parsed that particular CSV snapshot. `""`, `"n/a"`, `NaN` and `Infinity`
 * all collapse to `null`.
 *
 * @param value Number, numeric string, `null` or `undefined`.
 * @returns The finite number, or `null` when the input is not one.
 */
export function toNumber(value: NumericInput): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scale(value: NumericInput, factor: number): number | null {
  const n = toNumber(value);
  return n === null ? null : n * factor;
}

// ---------------------------------------------------------------------------
// Length / distance
// ---------------------------------------------------------------------------

/**
 * Feet → metres. Altitudes (`altitude`, `altitude_baro`, `elevation_ft`) and runway
 * dimensions are always feet on this API.
 */
export function ftToM(value: NumericInput): number | null {
  return scale(value, METERS_PER_FOOT);
}

/** Metres → feet. */
export function mToFt(value: NumericInput): number | null {
  return scale(value, FEET_PER_METER);
}

/**
 * Nautical miles → kilometres. `distance_nm` (history) and `max_range_nm`
 * (performance) are nautical; `distance_km` (airport search) is not.
 */
export function nmToKm(value: NumericInput): number | null {
  return scale(value, KM_PER_NM);
}

/** Kilometres → nautical miles. */
export function kmToNm(value: NumericInput): number | null {
  return scale(value, 1 / KM_PER_NM);
}

/**
 * Statute miles → kilometres. METAR visibility from US stations is statute miles
 * (`10SM`), while ICAO stations report metres (`9999`).
 */
export function smToKm(value: NumericInput): number | null {
  return scale(value, KM_PER_SM);
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/** Knots → kilometres per hour. `ground_speed`, `wind_speed_kt` and `cruise_speed_ktas` are knots. */
export function ktToKmh(value: NumericInput): number | null {
  return scale(value, KMH_PER_KT);
}

/** Knots → metres per second. */
export function ktToMs(value: NumericInput): number | null {
  return scale(value, MS_PER_KT);
}

/** Knots → miles per hour. */
export function ktToMph(value: NumericInput): number | null {
  return scale(value, MPH_PER_KT);
}

/**
 * Feet per minute → metres per second. `vertical_rate` is feet per minute and is
 * negative while descending; the sign is preserved.
 */
export function fpmToMs(value: NumericInput): number | null {
  return scale(value, MS_PER_FPM);
}

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

/** Inches of mercury → hectopascals (millibars). */
export function inhgToHpa(value: NumericInput): number | null {
  return scale(value, HPA_PER_INHG);
}

/** Hectopascals (millibars) → inches of mercury. */
export function hpaToInhg(value: NumericInput): number | null {
  return scale(value, 1 / HPA_PER_INHG);
}

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

/** Degrees Celsius → degrees Fahrenheit. Every temperature on this API is Celsius. */
export function cToF(value: NumericInput): number | null {
  const n = toNumber(value);
  return n === null ? null : n * 1.8 + 32;
}

/** Degrees Fahrenheit → degrees Celsius. */
export function fToC(value: NumericInput): number | null {
  const n = toNumber(value);
  return n === null ? null : (n - 32) / 1.8;
}

// ---------------------------------------------------------------------------
// Altimeter
// ---------------------------------------------------------------------------

/** An altimeter setting resolved to a unit, with both renderings pre-computed. */
export interface Altimeter {
  /** Which unit the raw value was in. */
  unit: "inHg" | "hPa";
  /** Setting in inches of mercury. */
  inHg: number;
  /** Setting in hectopascals (millibars). */
  hPa: number;
}

/** Below this an altimeter reading can only be inches of mercury. */
const INHG_MAX = 40;
/** At or above this an altimeter reading can only be hectopascals. */
const HPA_MIN = 500;

/**
 * Resolve a bare `altimeter` value to a unit.
 *
 * The trap this exists for: `parsed.altimeter` comes back as a plain number **with
 * no unit** — US stations report inches of mercury (`29.92`) and ICAO stations
 * hectopascals (`1013`), and nothing in the payload says which. The magnitude is
 * the only signal: below 40 it must be inHg, at 500 or above it must be hPa. A
 * value in between is genuinely ambiguous and yields `null` rather than a guess.
 *
 * @param value Altimeter reading as sent, number or numeric string.
 * @returns Both renderings plus the detected unit, or `null` when non-numeric or ambiguous.
 */
export function normalizeAltimeter(value: NumericInput): Altimeter | null {
  const n = toNumber(value);
  if (n === null) return null;
  if (n < INHG_MAX) {
    return { unit: "inHg", inHg: n, hPa: n * HPA_PER_INHG };
  }
  if (n >= HPA_MIN) {
    return { unit: "hPa", inHg: n / HPA_PER_INHG, hPa: n };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Humidity
// ---------------------------------------------------------------------------

/** Above this a humidity reading is already a percentage, not a fraction. */
const HUMIDITY_FRACTION_MAX = 1.5;

/**
 * Normalize a relative humidity reading to percent (0–100).
 *
 * The trap this exists for: `parsed.relative_humidity` is documented as a percent
 * but arrives as a **fraction** (`0.62` for 62 %). Anything above 1.5 is passed
 * through unchanged, so already-correct percentages survive a double call.
 *
 * @param value Fraction (0–1) or percentage.
 * @returns Percentage 0–100, or `null` when non-numeric.
 */
export function humidityToPercent(value: NumericInput): number | null {
  const n = toNumber(value);
  if (n === null) return null;
  return n > HUMIDITY_FRACTION_MAX ? n : n * 100;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const DURATION_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/(\d+(?:\.\d+)?)\s*(?:days?|d)(?![a-z])/gi, 24 * 60],
  [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/gi, 60],
  [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)(?![a-z])/gi, 1],
  [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)(?![a-z])/gi, 1 / 60],
];

/**
 * Parse a human duration string to minutes.
 *
 * The trap this exists for: `ml.flightTime()` returns `estimated_hours_display`
 * as **English prose** (`"7h 23m"`), not a number — the machine-readable field
 * next to it is hours, so anything rendering the display string has to parse it.
 * Understands `"7h 23m"`, `"45m"`, `"2h"`, `"1 h 5 min"`, `"1d 2h"` and bare
 * numbers (already minutes).
 *
 * @param value Duration text, or a number already expressed in minutes.
 * @returns Total minutes, or `null` when nothing recognizable was found.
 */
export function parseDurationMinutes(value: NumericInput): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;

  let total = 0;
  let matched = false;
  for (const [pattern, factor] of DURATION_UNITS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount)) {
        total += amount * factor;
        matched = true;
      }
    }
  }
  if (matched) return total;

  // A bare number is taken to be minutes, matching the numeric overload.
  return toNumber(text);
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/** A visibility reading resolved to both units, with the "or more / or less" marker kept. */
export interface Visibility {
  /** Metres, converted when the source reported statute miles. */
  meters: number | null;
  /** Statute miles, converted when the source reported metres. */
  statuteMiles: number | null;
  /** `true` when the report said "or greater" (the `P` prefix, as in `P6SM`). */
  atLeast: boolean;
}

/** Structural shape of the `visibility` group of a parsed METAR or TAF period. */
export interface VisibilityLike {
  /** Numeric value, `null` when the token had no plain number (`P6SM`). */
  value?: NumericInput;
  /** Original encoded token, e.g. `"10SM"`, `"P6"`, `"9999"`. */
  repr?: string | null;
}

/** Below this a bare visibility number is read as statute miles, at or above it as metres. */
const VISIBILITY_METERS_MIN = 100;

function fromStatuteMiles(sm: number, atLeast: boolean): Visibility {
  return { meters: sm * METERS_PER_SM, statuteMiles: sm, atLeast };
}

function fromMeters(meters: number, atLeast: boolean): Visibility {
  return { meters, statuteMiles: meters / METERS_PER_SM, atLeast };
}

function fromBareNumber(n: number, atLeast: boolean): Visibility {
  return n >= VISIBILITY_METERS_MIN ? fromMeters(n, atLeast) : fromStatuteMiles(n, atLeast);
}

function parseFraction(text: string): number | null {
  // "1 1/2" — a whole part followed by a fraction.
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);
  if (mixed?.[1] !== undefined && mixed[2] !== undefined && mixed[3] !== undefined) {
    const denominator = Number(mixed[3]);
    if (denominator === 0) return null;
    return Number(mixed[1]) + Number(mixed[2]) / denominator;
  }
  const simple = /^(\d+)\/(\d+)$/.exec(text);
  if (simple?.[1] !== undefined && simple[2] !== undefined) {
    const denominator = Number(simple[2]);
    if (denominator === 0) return null;
    return Number(simple[1]) / denominator;
  }
  return toNumber(text);
}

function parseVisibilityText(raw: string): Visibility | null {
  let text = raw.trim().toUpperCase();
  if (text === "") return null;

  let atLeast = false;
  if (text.startsWith("P")) {
    // `P6SM` — six statute miles or more.
    atLeast = true;
    text = text.slice(1);
  } else if (text.startsWith("M")) {
    // `M1/4SM` — less than a quarter of a statute mile.
    text = text.slice(1);
  }

  let unit: "sm" | "m" | null = null;
  if (text.endsWith("SM")) {
    unit = "sm";
    text = text.slice(0, -2);
  } else if (text.endsWith("KM")) {
    const km = toNumber(text.slice(0, -2).trim());
    return km === null ? null : fromMeters(km * 1000, atLeast);
  } else if (text.endsWith("M")) {
    unit = "m";
    text = text.slice(0, -1);
  }

  const value = parseFraction(text.trim());
  if (value === null) return null;
  if (unit === "sm") return fromStatuteMiles(value, atLeast);
  if (unit === "m") return fromMeters(value, atLeast);
  return fromBareNumber(value, atLeast);
}

/**
 * Parse a METAR/TAF visibility group into metres and statute miles.
 *
 * The trap this exists for: `P6SM` arrives as `{ value: null, repr: "P6" }` — the
 * numeric field is empty precisely for the reports that say "six miles or more",
 * so code reading only `value` silently loses the best visibility there is. The
 * `repr` is parsed first for that reason; `M` (less than) and fractions
 * (`M1/4SM`, `1 1/2SM`) are handled too.
 *
 * A bare number without a unit is read as statute miles below 100 and as metres at
 * or above it — US reports top out at 10 SM while ICAO reports run to 9999 m.
 *
 * @param value The `visibility` group (`{ value, repr }`), a raw token, or a number.
 * @returns Both units plus the "or more" flag, or `null` when nothing was parseable.
 */
export function parseVisibility(
  value: number | string | VisibilityLike | null | undefined,
): Visibility | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? fromBareNumber(value, false) : null;
  }
  if (typeof value === "string") {
    return parseVisibilityText(value);
  }

  if (typeof value.repr === "string" && value.repr.trim() !== "") {
    const fromRepr = parseVisibilityText(value.repr);
    if (fromRepr !== null) return fromRepr;
  }
  const numeric = toNumber(value.value);
  return numeric === null ? null : fromBareNumber(numeric, false);
}
