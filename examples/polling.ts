/**
 * Polling: watch the live ADS-B feed as diffs, and follow one flight to the gate.
 *
 * The API has no streaming and no push for live positions, so "watch this" means
 * "call it on a timer". `sky.poll.*` are async generators that yield immediately,
 * then every `interval` milliseconds, and that ride out the errors which say nothing
 * about the subject (429 and 5xx) instead of ending the loop.
 *
 * Both loops here are bounded with `maxIterations` so the example finishes on its
 * own; in a real service you would `break`, or hand in an `AbortSignal`.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, RateLimitError, SkyLink, spatial } from "../src/index.js";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

// Heathrow. Pin the feed down before polling it: without a filter every tick pulls
// the whole world, which is thousands of aircraft and a large slice of the quota.
const LHR = { lat: 51.4706, lon: -0.4619 };

async function watchTraffic(): Promise<void> {
  const box = spatial.bboxAround(LHR.lat, LHR.lon, 40); // "lat1,lon1,lat2,lon2"
  const seen = new Map<string, string>(); // icao24 → label, for the disappearance log

  // The first iteration is a baseline: `isFirst`, everything in `appeared`.
  for await (const diff of sky.poll.adsb(
    { bbox: box, photos: false, limit: 100 },
    { interval: 5_000, maxIterations: 4 },
  )) {
    if (diff.isFirst) {
      console.log(`baseline: ${diff.appeared.length} aircraft in the box`);
    } else {
      console.log(
        `+${diff.appeared.length} new, ~${diff.updated.length} moved, ` +
          `-${diff.disappeared.length} gone (${Object.keys(diff.snapshot).length} tracked)`,
      );
    }

    for (const state of diff.appeared) {
      const label = state.callsign?.trim() || state.registration || state.icao24;
      seen.set(state.icao24, label);
      console.log(`  + ${label} at ${state.altitude ?? "?"} ft`);
    }
    // `disappeared` is addresses, not states: the aircraft is out of the feed, so
    // there is nothing newer than the state you already saw.
    for (const icao24 of diff.disappeared) {
      console.log(`  - ${seen.get(icao24) ?? icao24} left the box`);
      seen.delete(icao24);
    }
    for (const state of diff.updated.slice(0, 3)) {
      console.log(
        `  ~ ${state.callsign?.trim() || state.icao24}: ` +
          `${state.altitude ?? "?"} ft, ${state.ground_speed ?? "?"} kt`,
      );
    }
  }
}

async function followFlight(flightNumber: string): Promise<void> {
  // Defaults: only actual changes are emitted (`changesOnly`), and the generator
  // finishes by itself once the status turns terminal (`untilTerminal`) — landed,
  // arrived, cancelled or diverted. `maxIterations` bounds the example instead.
  for await (const status of sky.poll.flightStatus(flightNumber, {
    interval: 30_000,
    maxIterations: 5,
  })) {
    console.log(
      `${status.flight_number}: ${status.status} — gate ${status.departure.gate || "?"}, ` +
        `ETA ${status.arrival.estimated_time || status.arrival.scheduled_time || "?"}`,
    );
  }
  console.log(`stopped following ${flightNumber}`);
}

async function stopEarly(): Promise<void> {
  // An external signal cancels both the wait and the request in flight.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  // Node only: do not hold the process open for the rest of the wait.
  (timer as unknown as { unref?: () => void }).unref?.();

  let ticks = 0;
  for await (const diff of sky.poll.adsb(
    { lat: LHR.lat, lon: LHR.lon, radius: 30, limit: 50 },
    { interval: 4_000, signal: controller.signal },
  )) {
    ticks += 1;
    console.log(`tick ${ticks}: ${Object.keys(diff.snapshot).length} aircraft`);
    // `break` is the other way out — the generator's `finally` runs either way.
    if (ticks >= 10) break;
  }
  console.log(`aborted after ${ticks} tick(s)`);
}

async function main(): Promise<void> {
  await watchTraffic();
  console.log();
  await followFlight("BA117");
  console.log();
  await stopEarly();
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof APIStatusError) {
    // 429 and 5xx are waited out by the poller itself; anything else (401, 403, 404)
    // will not fix itself on the next tick and reaches you here.
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: RAPIDAPI_KEY=... npx tsx examples/polling.ts ---
