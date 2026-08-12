/**
 * Batch requests: the same call for many identifiers, with a concurrency limit and
 * per-item errors instead of an all-or-nothing throw.
 *
 * The API has no bulk endpoint, so a board of twenty airports is twenty calls. An
 * unbounded `Promise.all` over them trips the per-second rate limit and loses the
 * whole batch to one bad code; `sky.batch` keeps five calls in flight and returns one
 * entry per input, holding either the response or the error that call failed with.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, batch, RateLimitError, SkyLink } from "../src/index.js";

// The helpers also ship as a tree-shakeable subpath:
//   import { failures, isBatchError, successes } from "skylink-api/batch";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

// A realistic mix: two hubs, one field that has no TAF, and one code that does not
// exist at all — so the failure branch actually runs.
const AIRPORTS = ["KJFK", "EGLL", "LFPG", "KSFO", "ZZZZ"];

async function main(): Promise<void> {
  // --- One call per airport, five at a time -----------------------------------
  const metars = await sky.batch.metars(AIRPORTS, { concurrency: 5 });

  // Keys are the strings you passed, verbatim — "kjfk" and "KJFK" would be two
  // entries and two requests.
  for (const [icao, result] of Object.entries(metars)) {
    if (batch.isBatchError(result)) {
      console.warn(`  ${icao}: unavailable — ${result.message}`);
    } else {
      console.log(`  ${icao}: ${result.raw ?? "no observation"}`);
    }
  }

  // --- Splitting the two halves ----------------------------------------------
  const ok = batch.successes(metars);
  const bad = batch.failures(metars);
  console.log(`\n${Object.keys(ok).length} observations, ${Object.keys(bad).length} failures`);
  for (const [icao, error] of Object.entries(bad)) {
    // Every failure is a SkyLinkError; the status tells you whether to retry it.
    const status = error instanceof APIStatusError ? error.status : "transport";
    console.warn(`  ${icao} failed with ${status}`);
  }

  // --- Other batched endpoints ------------------------------------------------
  // `airports` classifies each code and sends it under the right parameter: three
  // letters as `iata`, four as `icao`.
  const records = await sky.batch.airports(["JFK", "EGLL"]);
  for (const [code, record] of Object.entries(batch.successes(records))) {
    console.log(`\n${code} → ${record.name} (${record.iso_country ?? "??"})`);
    console.log(`  ${record.runways.length} runway(s), ${record.frequencies.length} frequencies`);
  }

  // NOTAMs are the slow endpoint of the batch surface (an FAA SWIM query per
  // airport), so give them room rather than more concurrency.
  const notams = await sky.batch.notams(["KJFK", "KLAX"], { timeout: 60_000, concurrency: 2 });
  for (const [icao, result] of Object.entries(batch.successes(notams))) {
    console.log(`${icao}: ${result.total} active NOTAM(s)`);
  }

  // --- All-or-nothing, when a partial answer is useless ------------------------
  try {
    const required = batch.throwForErrors(await sky.batch.flightStatuses(["BA117", "AA100"]));
    for (const [number, status] of Object.entries(required)) {
      console.log(`${number}: ${status.status} → ${status.arrival.estimated_time ?? "?"}`);
    }
  } catch (error) {
    if (!(error instanceof APIStatusError)) throw error;
    console.warn(`\none flight could not be resolved (${error.status}); skipping the board`);
  }

  // Quota is tracked across the whole batch, like any other call.
  console.log(`\nquota left: ${sky.lastRateLimit?.remaining ?? "?"}`);
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof APIStatusError) {
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: RAPIDAPI_KEY=... npx tsx examples/batch.ts ---
