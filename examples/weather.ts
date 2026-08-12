/**
 * Aviation weather: raw and parsed METAR, TAF, and winds aloft over a bounding box.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { APIStatusError, RateLimitError, SkyLink } from "../src/index.js";

const sky = new SkyLink({ apiKey: process.env.SKYLINK_API_KEY });

async function main(): Promise<void> {
  // --- METAR, raw ------------------------------------------------------------
  // Without `parsed`, the response is the observation as the station published it.
  const metar = await sky.weather.metar("KJFK");
  console.log(`${metar.icao} (${metar.airport_name ?? "unknown airport"})`);
  console.log(`  ${metar.raw ?? "no observation"}`);

  // --- METAR, parsed ---------------------------------------------------------
  // `parsed: true` widens the same response with a decoded `parsed` block. The
  // overload picks the richer return type, so `.parsed` is only visible here.
  const decoded = await sky.weather.metar("KJFK", { parsed: true });
  if (decoded.parsed) {
    const { wind, visibility, temperature, dewpoint, altimeter, flight_rules, clouds } =
      decoded.parsed;
    console.log(`  flight rules: ${flight_rules ?? "n/a"}`);
    console.log(`  wind: ${wind.direction ?? "VRB"}° at ${wind.speed ?? "?"} kt`);
    console.log(`  visibility: ${visibility?.repr ?? "n/a"}`);
    console.log(`  temp/dew: ${temperature ?? "?"}/${dewpoint ?? "?"} °C`);
    console.log(`  altimeter: ${altimeter ?? "?"}`);
    for (const layer of clouds) {
      console.log(`  cloud: ${layer.type ?? "?"} at ${layer.base ?? "?"}00 ft`);
    }
  }

  // --- TAF -------------------------------------------------------------------
  const taf = await sky.weather.taf("EGLL", { parsed: true });
  console.log(`\n${taf.icao} TAF`);
  console.log(`  ${taf.raw ?? "no forecast"}`);
  if (taf.parsed) {
    console.log(`  valid ${taf.parsed.start_time ?? "?"} → ${taf.parsed.end_time ?? "?"}`);
    for (const period of taf.parsed.forecast.slice(0, 3)) {
      console.log(
        `  ${period.type ?? "BASE"} from ${period.start_time ?? "?"}: ` +
          `${period.flight_rules ?? "n/a"}, wind ${period.wind.speed ?? "?"} kt`,
      );
    }
  }

  // --- Winds aloft over a bounding box ---------------------------------------
  // `bbox` is [lat1, lon1, lat2, lon2] — the SDK serializes the tuple for you.
  const winds = await sky.weather.windsAloft({
    bbox: [40, -75, 43, -71],
    forecast: 12,
    level: "low",
  });
  console.log(`\nwinds aloft — ${winds.total} station(s), valid ${winds.valid_time ?? "n/a"}`);
  for (const station of winds.stations.slice(0, 5)) {
    const level = station.winds.find((w) => w.altitude_ft === 9000) ?? station.winds[0];
    if (!level) continue;
    console.log(
      `  ${station.station}: ${level.altitude_ft} ft — ` +
        `${level.light_and_variable ? "light and variable" : `${level.wind_direction ?? "?"}° at ${level.wind_speed_kt ?? "?"} kt`}` +
        `, ${level.temperature_c ?? "?"} °C`,
    );
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

// --- Run: SKYLINK_API_KEY=... npx tsx examples/weather.ts ---
