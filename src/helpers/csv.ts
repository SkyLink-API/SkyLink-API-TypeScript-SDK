/**
 * RFC 4180 CSV for the list responses that end up in a spreadsheet.
 *
 * Every "export this" feature starts as three lines of `map(row => row.join(","))`
 * and breaks on the first airport called `Paris, Charles de Gaulle` — or on a NOTAM
 * body, which is prose full of line breaks and quotes. This does the boring part
 * properly: a field containing the delimiter, a double quote, a carriage return or a
 * line feed is wrapped in double quotes with its own quotes doubled, exactly as RFC
 * 4180 says, and nothing else is touched.
 *
 * Rules worth knowing before you pipe an API response into it:
 *
 * - **Columns keep the wire's own names.** `icao24`, `is_on_ground`, `total_count`,
 *   the PascalCase schedule keys (`Time`, `Flight`) and the one camelCase field in
 *   the API (`usageType`) all appear as they arrived. Pass `columns` to pick a subset
 *   and an order.
 * - **`null` and `undefined` are empty cells**, not the strings `"null"`/`"undefined"`
 *   — a missing altitude has to stay missing when the file is read back.
 * - **Nested values become JSON.** A cell is one value; `photos`, `parsed` and
 *   `routes` are structures, and a JSON string is the only lossless thing to put in
 *   a single cell. Flatten them yourself if the spreadsheet has to read them.
 *
 * ```ts
 * import { toCsv } from "skylink-api/csv";
 *
 * const feed = await sky.adsb.aircraft({ lat: 51.47, lon: -0.45, radius: 50 });
 * const csv = toCsv(feed.aircraft, { columns: ["icao24", "callsign", "altitude"] });
 * ```
 *
 * Pure functions — no client, no network, no state.
 */

import { SkyLinkError } from "../core/errors.js";

/** Options of {@link toCsv}. */
export interface ToCsvOptions {
  /**
   * Columns to emit, in this order.
   *
   * Defaults to the union of the keys of every row, in the order they are first
   * seen — which is the API's own field order for a homogeneous list. A named column
   * that no row has is emitted as an empty cell, so a fixed header stays fixed even
   * when the API stops sending a field.
   */
  columns?: readonly string[];
  /**
   * Single character between fields. Defaults to `","`.
   *
   * `";"` is what Excel expects in locales where the comma is the decimal separator,
   * and `"\t"` gives a TSV. The double quote, CR and LF cannot be delimiters — they
   * are the format's own syntax.
   */
  delimiter?: string;
  /**
   * String between records. Defaults to `"\n"`.
   *
   * RFC 4180 specifies CRLF and Excel is happiest with it; `"\n"` is what every
   * parser, `git diff` and Unix tool prefer, so it is the default here. Line breaks
   * *inside* a value are preserved verbatim (the value is quoted), whichever this is.
   */
  newline?: string;
}

/** Reject a delimiter that would produce a file no parser can read back. */
function checkDelimiter(delimiter: string): string {
  if (typeof delimiter !== "string" || [...delimiter].length !== 1) {
    throw new SkyLinkError(
      `delimiter must be a single character, received ${JSON.stringify(delimiter)}.`,
    );
  }
  if (delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new SkyLinkError(
      `delimiter must not be a quote or a line break, received ${JSON.stringify(delimiter)}.`,
    );
  }
  return delimiter;
}

/**
 * One value as its cell text, before escaping.
 *
 * `Date` is included because callers build rows by hand and a `Date` stringified by
 * `String()` is a locale-dependent mess; ISO 8601 is what the rest of the SDK speaks.
 */
function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "function" || typeof value === "symbol") return "";
  try {
    // Structures are the only thing left: JSON keeps them readable and reversible.
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular, or a `toJSON` that threw — the row is still worth emitting.
    return String(value);
  }
}

/** Quote a cell if, and only if, RFC 4180 requires it. */
function escapeCell(cell: string, delimiter: string): string {
  const needsQuotes =
    cell.includes('"') || cell.includes(delimiter) || cell.includes("\r") || cell.includes("\n");
  return needsQuotes ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** The union of the keys of every row, in first-appearance order. */
function collectColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

/**
 * Render records as an RFC 4180 CSV document, header row included.
 *
 * ```ts
 * const board = await sky.schedules.departures({ icao: "EGLL" });
 * // PascalCase columns, because that is what the board sends.
 * await writeFile("departures.csv", toCsv(board.flights, { delimiter: ";" }));
 * ```
 *
 * Rows are heterogeneous-tolerant: the header is the union of every row's keys, and
 * a row missing one of them gets an empty cell. An empty input with no `columns`
 * produces an empty string — not a stray newline — so it can be concatenated safely.
 *
 * @param rows Any iterable of plain records: a response's `aircraft`, `flights`,
 * `positions`, `navaids`, `countries`, or objects you assembled yourself.
 * @param options Column selection, delimiter and record separator.
 * @returns The whole document as a string. There is no trailing newline.
 * @throws {SkyLinkError} When `delimiter` is not a single, non-syntactic character.
 */
export function toCsv(rows: Iterable<object>, options: ToCsvOptions = {}): string {
  const delimiter = checkDelimiter(options.delimiter ?? ",");
  const newline = options.newline ?? "\n";
  // `object` in, records out: the response models are interfaces, which TypeScript
  // does not consider assignable to `Record<string, unknown>` even though they are.
  const list = [...rows].filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );

  const columns = options.columns === undefined ? collectColumns(list) : [...options.columns];
  if (columns.length === 0) return "";

  const lines: string[] = [columns.map((column) => escapeCell(column, delimiter)).join(delimiter)];
  for (const row of list) {
    lines.push(columns.map((column) => escapeCell(render(row[column]), delimiter)).join(delimiter));
  }
  return lines.join(newline);
}
