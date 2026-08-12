/**
 * `sky.compose` — one command, one finished summary.
 *
 * An "airport page" is eight endpoints (search, METAR, TAF, NOTAMs, FAA delays,
 * charts and both schedule boards). This namespace fires them in parallel and, most
 * of the point, **degrades instead of failing**: a part that errors comes back `null`
 * with its error filed in `brief.errors` under the part's own name, so a non-US
 * airport with no FAA delay feed still gives you a usable brief.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, RateLimitError, SkyLink, weatherHelpers } from "../src/index.js";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

async function main(): Promise<void> {
  // --- The whole airport, in one call ----------------------------------------
  // `schedulesLimit` truncates each board client-side (the endpoint has no limit of
  // its own and returns hundreds of rows); `total_flights` still reports the full
  // board, which is how you know there is more.
  const brief = await sky.compose.airportBrief("EGLL", { schedulesLimit: 5 });

  console.log(`${brief.airport?.name ?? "EGLL"} — ${brief.airport?.municipality ?? "?"}`);
  console.log(`  runways: ${brief.airport?.runways.length ?? 0}`);

  // Weather arrives decoded (`parsed: true`), so the helpers work on it directly.
  console.log(`  METAR: ${brief.metar?.raw ?? "none"}`);
  console.log(`  category: ${weatherHelpers.flightCategory(brief.metar) ?? "unknown"}`);
  console.log(`  TAF periods: ${brief.taf?.parsed?.forecast.length ?? 0}`);
  console.log(`  NOTAMs: ${brief.notams?.total ?? 0}`);
  console.log(`  charts: ${brief.charts?.total_count ?? 0}`);
  console.log(`  FAA alerts: ${brief.delays?.total_alerts ?? "n/a"}`);

  for (const row of brief.departures?.flights ?? []) {
    // Schedule rows are the one place in the API with PascalCase keys.
    console.log(`  ${row.Time} ${row.Flight} → ${row.Destination} (${row.Status})`);
  }

  // --- The failures, out loud -------------------------------------------------
  // An empty object means every requested part worked. EGLL is not an FAA field, so
  // `delays` is normally in here with a 404 that means "not in the FAA feed".
  const failed = Object.entries(brief.errors);
  if (failed.length === 0) {
    console.log("\nall parts available");
  } else {
    console.log(`\n${failed.length} part(s) unavailable — the brief is still usable:`);
    for (const [part, error] of failed) {
      const status = error instanceof APIStatusError ? error.status : "transport";
      console.warn(`  ${part}: ${status} — ${error.message}`);
    }
  }

  // Skip the parts you do not need: `exclude` (or `include`) decides what is
  // *requested*, so a deselected part costs no quota.
  const cheap = await sky.compose.airportBrief("EGLL", {
    exclude: ["delays", "charts", "arrivals", "notams"],
  });
  console.log(`\ncheap brief: ${cheap.charts === null ? "no charts requested" : "charts"}`);

  // --- One flight, resolved as far as the API goes ----------------------------
  // status → registration → registry lookup, and in parallel callsign → route → CO2.
  const flight = await sky.compose.flightBrief("BA117");
  console.log(`\n${flight.status?.flight_number ?? "?"}: ${flight.status?.status ?? "?"}`);
  if (flight.route?.source === "vrs") {
    console.log(`  route: ${flight.route.departure_icao} → ${flight.route.arrival_icao}`);
  } else if (flight.route) {
    console.log(`  route: airline-level fallback, ${flight.route.total_routes} routes`);
  }
  // Priced from the route's ICAO pair when there is one, from the callsign otherwise.
  console.log(`  CO2: ${flight.carbon?.co2_kg_per_passenger ?? "?"} kg per passenger`);
  // Usually null and that is not an error: the live status carries no tail number.
  console.log(`  airframe: ${flight.aircraft?.found ? flight.aircraft.aircraft.type_name : "n/a"}`);

  // --- A city pair, briefed ---------------------------------------------------
  const route = await sky.compose.routeBrief("EGLL", "KJFK", { aircraftType: "B77W" });
  console.log(`\nEGLL → KJFK: ${route.distance?.distance ?? "?"} ${route.distance?.unit ?? ""}`);
  console.log(`  block time: ${route.flightTime?.estimated_hours_display ?? "?"}`);
  console.log(
    `  weather: ${weatherHelpers.flightCategory(route.originMetar) ?? "?"} → ` +
      `${weatherHelpers.flightCategory(route.destinationMetar) ?? "?"}`,
  );
  console.log(`  errors: ${Object.keys(route.errors).join(", ") || "none"}`);

  // --- A board with each flight's live status ---------------------------------
  // ICAO or IATA — this method only touches /schedules, which takes both.
  const board = await sky.compose.schedulesWithStatus("LHR", { limit: 5 });
  console.log("\ndepartures with live status:");
  for (const { entry, status, error } of board) {
    const live = status?.status ?? (error ? `unavailable (${error.message})` : entry.Status);
    console.log(`  ${entry.Time} ${entry.Flight} → ${entry.Destination}: ${live}`);
  }

  // --- The North America workaround -------------------------------------------
  // `geo.countries({ continent: "NA" })` returns nothing: the backend reads the CSV
  // with pandas, which parses the literal "NA" as not-a-number. This fetches the full
  // list once and filters client-side.
  const northAmerica = await sky.compose.northAmericaCountries();
  console.log(`\n${northAmerica.length} North American countries`);
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof APIStatusError) {
    // Only the primary part of a brief throws: the airport lookup, the flight status
    // and the schedule board. Everything else is in `brief.errors`.
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: RAPIDAPI_KEY=... npx tsx examples/compose-briefs.ts ---
