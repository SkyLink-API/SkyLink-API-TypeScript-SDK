/**
 * Helpers end to end: build a bounding box, colour the weather, and write the result
 * out as GeoJSON and CSV.
 *
 * Everything here is a pure function — no client, no network — so the helpers can be
 * used on data you already have, and each one exists for a specific trap:
 * `bboxAround` produces the `"lat1,lon1,lat2,lon2"` string the `bbox` parameters
 * want; `flightCategory` computes VFR/MVFR/IFR/LIFR, which the API does not always
 * send; the GeoJSON exporters emit `[longitude, latitude]`, the opposite order from
 * every model in this SDK.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { writeFile } from "node:fs/promises";
import {
  APIStatusError,
  csv,
  geojson,
  RateLimitError,
  SkyLink,
  spatial,
  units,
  weatherHelpers,
} from "../src/index.js";

// Each of these also ships as a tree-shakeable subpath:
//   import { bboxAround } from "skylink-api/spatial";
//   import { toCsv } from "skylink-api/csv";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

// Zurich.
const CENTER = { lat: 47.4647, lon: 8.5492 };

async function main(): Promise<void> {
  // --- A bounding box around a point ------------------------------------------
  // The `bbox` parameters take "lat1,lon1,lat2,lon2"; this builds it from a centre
  // and a radius in kilometres, clamping latitude at the poles and wrapping the
  // antimeridian instead of producing an empty box.
  const box = spatial.bboxAround(CENTER.lat, CENTER.lon, 60);
  console.log(`bbox: ${box}`);

  const feed = await sky.adsb.aircraft({ bbox: box, photos: false, limit: 200 });
  console.log(`${feed.total_count} aircraft in the box`);

  // --- Weather, categorised ---------------------------------------------------
  // `parsed: true` is what makes the report readable by the helpers.
  const metar = await sky.weather.metar("LSZH", { parsed: true });
  const category = weatherHelpers.flightCategory(metar);
  const ceiling = weatherHelpers.ceilingFt(metar);
  console.log(`\nLSZH ${category ?? "unknown"} — ceiling ${ceiling ?? "none"} ft`);
  console.log(`  ${metar.raw ?? "no observation"}`);
  if (weatherHelpers.isStale(metar)) {
    // Older than 90 minutes: the station has stopped reporting, or the cache is cold.
    console.warn("  observation is stale");
  }
  // Altimeters arrive in whichever unit the source station uses.
  const altimeter = units.normalizeAltimeter(metar.parsed?.altimeter);
  if (altimeter) console.log(`  QNH ${altimeter.hPa} hPa / ${altimeter.inHg} inHg`);

  // --- GeoJSON, straight into a file ------------------------------------------
  // Coordinates come out as [longitude, latitude] — the GeoJSON order, not the SDK's.
  const traffic = geojson.adsbToGeojson(feed.aircraft);
  await writeFile("traffic.geojson", JSON.stringify(traffic, null, 2), "utf8");
  console.log(`\nwrote traffic.geojson — ${traffic.features.length} feature(s)`);

  // Airports nearby, as a second layer. Rows without coordinates are skipped, which
  // the OurAirports dataset does contain.
  const nearby = await sky.airports.nearby({ lat: CENTER.lat, lon: CENTER.lon, radius: 60 });
  const airports = geojson.airportsToGeojson(nearby.airports);
  await writeFile("airports.geojson", JSON.stringify(airports), "utf8");
  console.log(`wrote airports.geojson — ${airports.features.length} feature(s)`);

  // --- CSV, for the people who want a spreadsheet -----------------------------
  // Columns keep the API's own field names; a comma or a quote inside a value is
  // escaped per RFC 4180 rather than shifting every column after it.
  const table = csv.toCsv(feed.aircraft, {
    columns: ["icao24", "callsign", "registration", "aircraft_type", "altitude", "ground_speed"],
  });
  await writeFile("traffic.csv", table, "utf8");
  console.log(`wrote traffic.csv — ${table.split("\n").length - 1} row(s)`);

  // Semicolons for spreadsheets in locales where the comma is the decimal separator.
  const board = await sky.schedules.departures({ icao: "LSZH" });
  await writeFile("departures.csv", csv.toCsv(board.flights, { delimiter: ";" }), "utf8");
  console.log(`wrote departures.csv — ${board.flights.length} row(s)`);

  // --- A few numbers off the same data ----------------------------------------
  const distances: number[] = [];
  for (const state of feed.aircraft) {
    // Aircraft heard but not located — an identification-only message — have no
    // position at all, which is why every coordinate in the models is nullable.
    const coords = spatial.pointCoords(state);
    if (coords === null) continue;
    distances.push(spatial.haversineNm(CENTER.lat, CENTER.lon, coords[0], coords[1]));
  }
  if (distances.length > 0) {
    console.log(`\nclosest contact: ${Math.min(...distances).toFixed(1)} nm from the centre`);
  }
  console.log(`60 km is ${units.kmToNm(60)?.toFixed(1)} nm`);
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

// --- Run: RAPIDAPI_KEY=... npx tsx examples/helpers-export.ts ---
