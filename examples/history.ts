/**
 * Historical ADS-B: flight search, per-flight track, raw position history through
 * both dispatch forms, and a call pinned to the `mega` plan.
 *
 * Every history path is prefixed by the data plan: `/ultra/history/...` or
 * `/mega/history/...`. The plan is resolved per call — the `plan` parameter wins,
 * then the client's `historyPlan` option, then `"ultra"`.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, NotFoundError, RateLimitError, SkyLink } from "../src/index.js";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
// `historyPlan` sets the default prefix for every history call on this client.
const sky = new SkyLink({ historyPlan: "ultra" });

const REGISTRATION = "G-STBA";
const ICAO24 = "4ca1fb";

async function main(): Promise<void> {
  // --- Flight search ----------------------------------------------------------
  // At least one identifying filter is required; `start` / `end` accept a `Date`
  // or any ISO 8601 string and are normalized for you.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const found = await sky.history.flights({
    registration: REGISTRATION,
    start: dayAgo,
    end: new Date(),
    limit: 10,
  });

  // An unknown registration is not an error: the API answers 200 with count 0 and
  // an explanatory `note`. Check for it before treating an empty list as "no flights".
  if (found.note) {
    console.log(`note from the API: ${found.note}`);
  }
  console.log(`${found.count} flight(s) for ${found.filters.registration ?? REGISTRATION}`);

  for (const flight of found.flights) {
    console.log(
      `  ${flight.flight_id ?? "?"}  ${flight.callsign?.trim() ?? "------"}  ` +
        `${flight.departure_airport_icao ?? "????"} → ${flight.arrival_airport_icao ?? "????"}  ` +
        `${flight.takeoff_time ?? "?"} → ${flight.landing_time ?? "?"}  ` +
        `${flight.flight_duration_min ?? "?"} min`,
    );
  }

  // --- Track of one flight ----------------------------------------------------
  // `track` auto-bounds the window to takeoff → landing (padded five minutes each
  // side). Use `positions` when you want an arbitrary window instead.
  const first = found.flights[0];
  if (first?.flight_id) {
    const track = await sky.history.track(first.flight_id, { limit: 500 });
    console.log(
      `\ntrack ${track.flight_id}: ${track.count} position(s), ` +
        `${track.departure_airport_icao ?? "????"} → ${track.arrival_airport_icao ?? "????"}`,
    );
    for (const point of track.positions.slice(0, 5)) {
      console.log(
        `  ${point.timestamp ?? "?"}  ${point.latitude ?? "?"}, ${point.longitude ?? "?"}  ` +
          `${point.altitude_baro ?? "?"} ft  ${point.ground_speed ?? "?"} kt`,
      );
    }
  }

  // --- Positions, dispatched by shape -----------------------------------------
  // `positions(ident)` looks at the string: six hex characters go to the ICAO24
  // route, anything else to the registration route.
  const byHex = await sky.history.positions(ICAO24, { limit: 5 });
  console.log(`\npositions(${ICAO24}) → icao24 route: ${byHex.count} position(s)`);

  const byReg = await sky.history.positions(REGISTRATION, { limit: 5 });
  console.log(
    `positions(${REGISTRATION}) → registration route: ${byReg.count} position(s) ` +
      `for ${byReg.registration ?? byReg.icao24}`,
  );

  // Call the explicit methods when the identifier kind is known and the ambiguity
  // would be unwelcome (a six-character registration would be read as an address).
  const explicit = await sky.history.positionsByRegistration(REGISTRATION, { limit: 5 });
  console.log(`positionsByRegistration(${REGISTRATION}): ${explicit.count} position(s)`);

  // --- A single call on the mega plan ------------------------------------------
  // `plan` overrides the client default for this call only: the request goes to
  // `/mega/history/airport/EGLL/traffic`. `mega` widens the retention window and
  // the limit caps; the routes and the response shape are identical.
  const traffic = await sky.history.airportTraffic("EGLL", {
    plan: "mega",
    direction: "dep",
    start: new Date(Date.now() - 6 * 60 * 60 * 1000),
    limit: 10,
  });
  console.log(`\nEGLL ${traffic.direction}: ${traffic.count} flight(s) on the mega plan`);
  for (const flight of traffic.flights.slice(0, 5)) {
    console.log(
      `  ${flight.callsign?.trim() ?? "------"} → ${flight.arrival_airport_icao ?? "????"} ` +
        `at ${flight.takeoff_time ?? "?"}`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof NotFoundError) {
    // The registration route answers 404 when the tail number is not in the
    // aircraft database — unlike `flights`, which answers 200 with a `note`.
    console.error(`Not found: ${error.message}`);
  } else if (error instanceof APIStatusError) {
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: RAPIDAPI_KEY=... npx tsx examples/history.ts ---
