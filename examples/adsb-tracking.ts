/**
 * Live ADS-B: aircraft within a radius, feed statistics, feed health, and the
 * quota snapshot the SDK keeps from the last response.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, RateLimitError, SkyLink } from "../src/index.js";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

// JFK.
const LAT = 40.6413;
const LON = -73.7781;

async function main(): Promise<void> {
  // --- Live traffic in a radius ----------------------------------------------
  // `photos: false` keeps the response small; it is the default for this endpoint.
  // This is the only paginated endpoint in the API (`limit` / `offset`).
  const live = await sky.adsb.aircraft({
    lat: LAT,
    lon: LON,
    radius: 80,
    min_alt: 1000,
    photos: false,
    limit: 25,
  });

  console.log(`${live.total_count} aircraft within 80 km of JFK at ${live.timestamp}`);
  for (const ac of live.aircraft) {
    if (ac.latitude === null || ac.longitude === null) continue;
    const label = ac.callsign?.trim() || ac.registration || ac.icao24;
    console.log(
      `  ${label.padEnd(9)} ${ac.aircraft_type ?? "----"} ` +
        `${ac.altitude ?? "?"} ft  ${ac.ground_speed ?? "?"} kt  ` +
        `hdg ${ac.track ?? "?"}  ${ac.is_on_ground ? "on ground" : "airborne"}`,
    );
  }

  // A few derived numbers, straight off the wire fields.
  const airborne = live.aircraft.filter((ac) => ac.is_on_ground === false);
  const withAltitude = airborne.filter((ac) => ac.altitude !== null);
  if (withAltitude.length > 0) {
    const altitudes = withAltitude.map((ac) => ac.altitude ?? 0);
    const mean = Math.round(altitudes.reduce((a, b) => a + b, 0) / altitudes.length);
    console.log(`\n${airborne.length} airborne, mean altitude ${mean} ft`);
  }

  // --- Quota tracking --------------------------------------------------------
  // `lastRateLimit` is refreshed from the channel's quota headers on every response —
  // successful or not. It stays null if the deployment sends no quota headers.
  const quota = sky.lastRateLimit;
  if (quota) {
    console.log(
      `quota: ${quota.remaining ?? "?"}/${quota.limit ?? "?"} requests left, ` +
        `resets in ${quota.reset ?? "?"} s`,
    );
  }

  // --- Feed-wide statistics ---------------------------------------------------
  const stats = await sky.adsb.statistics();
  console.log(
    `\nfeed: ${stats.total_aircraft} tracked, ${stats.positioned_aircraft} positioned, ` +
      `${stats.airborne} airborne, ${stats.on_ground} on ground`,
  );
  console.log(
    `  altitude min/avg/max: ${stats.altitude_stats.min_altitude ?? "?"} / ` +
      `${stats.altitude_stats.avg_altitude ?? "?"} / ${stats.altitude_stats.max_altitude ?? "?"} ft`,
  );

  // --- Feed health ------------------------------------------------------------
  const health = await sky.adsb.health();
  console.log(
    `health: ${health.status} (connected: ${health.connected}), ` +
      `${health.active_aircraft_count} active, uptime ${health.connection_uptime ?? "?"} s`,
  );
  if (health.status !== "healthy") {
    console.warn(`  last message received: ${health.last_message_received ?? "never"}`);
  }
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

// --- Run: RAPIDAPI_KEY=... npx tsx examples/adsb-tracking.ts ---
