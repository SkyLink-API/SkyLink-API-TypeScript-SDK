/**
 * Classification and normalization of the identifiers the API keys off.
 *
 * Airport codes, ICAO 24-bit addresses, registrations and flight numbers all arrive
 * as bare strings, in whatever case and shape the caller's data source used, and
 * the endpoints are picky in different ways: `airports.search()` takes `icao` **or**
 * `iata` and rejects the wrong one, `history.positions()` dispatches on whether the
 * identifier looks like an ICAO24, and `airports.nearby()` hands back OurAirports
 * pseudo-codes that no lookup endpoint resolves.
 *
 * Pure functions — no client, no network, no state.
 */

/** What kind of identifier a string looks like. */
export type AirportCodeKind = "iata" | "icao" | "local" | "unknown";

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Guess which kind of airport code a string is.
 *
 * `airports.search()` needs the caller to pick between the `icao` and `iata`
 * parameters up front, and answers 400 when the code does not match the parameter
 * it was passed under. Rules: three letters is IATA (`"JFK"`); four alphanumerics
 * starting with a letter is ICAO (`"KJFK"`, `"EGLL"`, `"K7B2"`); anything
 * containing a hyphen is an OurAirports local pseudo-code (`"GB-0888"`).
 *
 * @param code Airport code in any case, surrounding whitespace ignored.
 */
export function classifyAirportCode(code: string | null | undefined): AirportCodeKind {
  const cleaned = clean(code);
  if (cleaned === null) return "unknown";
  const text = cleaned.toUpperCase();
  if (/^[A-Z]{3}$/.test(text)) return "iata";
  if (/^[A-Z][A-Z0-9]{3}$/.test(text)) return "icao";
  if (text.includes("-")) return "local";
  return "unknown";
}

/**
 * Whether a code is an OurAirports local pseudo-code such as `"GB-0888"`.
 *
 * The trap this exists for: `airports.nearby()` and the text search return rows
 * straight out of the OurAirports dataset, and small fields have no ICAO code — the
 * dataset invents `"<ISO country>-<number>"` instead. Feeding one of those to
 * `airports.search()` is guaranteed to fail, so filter them out before joining.
 */
export function isLocalPseudocode(code: string | null | undefined): boolean {
  const text = clean(code);
  return text !== null && /^[A-Za-z]{2}-[A-Za-z0-9]+$/.test(text);
}

/**
 * Whether a value is a well-formed ICAO 24-bit address: exactly six hex digits.
 *
 * Used to decide between an ICAO24 and a registration before calling
 * `history.positions()`, which dispatches to a different route for each. Case is
 * ignored; a leading `"~"` (a non-ICAO/TIS-B address) makes this `false` — run
 * {@link normalizeIcao24} first if you want those accepted.
 */
export function isIcao24(value: string | null | undefined): boolean {
  const text = clean(value);
  return text !== null && /^[0-9a-fA-F]{6}$/.test(text);
}

/**
 * Normalize an ICAO 24-bit address to the form the API expects: lower-case hex.
 *
 * Responses are inconsistent about case — the ADS-B feed and history position rows
 * send lower-case, while history flight rows and the aircraft registry send
 * upper-case, so the same aircraft looks like two keys unless normalized. A leading
 * `"~"`, which some feeds prepend to non-ICAO (TIS-B / ADS-R) addresses, is
 * stripped.
 *
 * @returns Six lower-case hex digits, or `null` when the value is not an address.
 */
export function normalizeIcao24(value: string | null | undefined): string | null {
  const text = clean(value);
  if (text === null) return null;
  const stripped = text.replace(/^~+/, "").trim();
  return /^[0-9a-fA-F]{6}$/.test(stripped) ? stripped.toLowerCase() : null;
}

/**
 * Normalize a registration (tail number) to the API's form: upper-case, trimmed.
 *
 * `aircraft.byRegistration()` and `history.positionsByRegistration()` echo the
 * registration back upper-cased, so lower-case input produces results that no
 * longer match the key it was looked up by.
 *
 * @returns The upper-cased registration, or `null` when the input was empty.
 */
export function normalizeRegistration(value: string | null | undefined): string | null {
  const text = clean(value);
  return text === null ? null : text.toUpperCase();
}

/** A flight designator split into its carrier and numeric parts. */
export interface FlightNumber {
  /** Carrier code: two characters for IATA (`"BA"`, `"U2"`), three letters for ICAO (`"BAW"`). */
  airline: string;
  /** The numeric part, verbatim — leading zeros are kept (`"0123"`). */
  number: string;
  /** Which designator scheme matched. */
  kind: "iata" | "icao";
}

/**
 * Split a flight designator into carrier code and number.
 *
 * The trap this exists for: `flightStatus()` takes commercial flight numbers
 * (`"BA1403"`) while ADS-B and `routes.callsign()` speak ATC callsigns
 * (`"BAW175"`), and telling them apart is not as simple as counting characters —
 * an IATA carrier code may contain a digit (`"U2"` for easyJet, `"9W"`), so
 * `"U21234"` splits as `U2` + `1234`, not `U21` + `234`. The three-letter ICAO
 * form is tried first, then the two-character IATA form.
 *
 * Whitespace and hyphens are ignored, so `"BA 1403"` and `"BA-1403"` work.
 *
 * @returns The split designator, or `null` when the string is not one.
 */
export function splitFlightNumber(value: string | null | undefined): FlightNumber | null {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const text = cleaned.replace(/[\s-]/g, "").toUpperCase();
  if (text === "") return null;

  const icao = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(text);
  if (icao?.[1] !== undefined && icao[2] !== undefined) {
    return { airline: icao[1], number: icao[2], kind: "icao" };
  }

  const iata = /^([A-Z][A-Z0-9]|\d[A-Z])(\d{1,4}[A-Z]?)$/.exec(text);
  if (iata?.[1] !== undefined && iata[2] !== undefined) {
    return { airline: iata[1], number: iata[2], kind: "iata" };
  }

  return null;
}
