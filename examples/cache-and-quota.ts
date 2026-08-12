/**
 * Staying inside the quota: the opt-in response cache, the quota hooks, and the two
 * client constructors that exist for readability (`fromEnv`, `withOptions`).
 *
 * **Nothing is cached by default.** The SDK stores a response only when a cache is
 * handed to it *and* the operation has a non-zero TTL — because a METAR is worth five
 * minutes, an airport record is worth a day and live ADS-B is worth nothing at all,
 * and one global number would have to be the smallest of the three.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import {
  APIStatusError,
  CACHE_HIT_HEADER,
  MemoryCache,
  RateLimitError,
  SkyLink,
} from "../src/index.js";

// Per-operation TTLs in milliseconds, by exact name ("weather.metar"), by prefix
// ("geo.*") or as a catch-all ("*"). More specific wins; 0 means "do not cache".
const cache = new MemoryCache({
  defaultTtl: 0, // everything not listed below still goes to the network
  ttls: {
    "weather.metar": 5 * 60_000, // an observation changes twice an hour at most
    "weather.taf": 30 * 60_000,
    "airports.*": 24 * 60 * 60_000, // reference data; it changes on dataset releases
    "geo.*": 24 * 60 * 60_000,
    "adsb.*": 0, // live positions: caching them would be a bug
  },
  maxEntries: 200,
});

// `fromEnv()` is `new SkyLink()` said out loud: the key comes from RAPIDAPI_KEY, or
// SKYLINK_API_KEY on the direct channel.
const sky = SkyLink.fromEnv({ cache });

async function main(): Promise<void> {
  // --- Quota hooks ------------------------------------------------------------
  // Fires for every response that carried quota headers, successful or not —
  // X-RateLimit-Requests-* on RapidAPI, X-RateLimit-* on the direct channel. The
  // callback gets *that* response's snapshot, not a shared field, so it stays correct
  // with requests in flight in parallel.
  const offRateLimit = sky.onRateLimit((info) => {
    if (info.remaining !== null && info.remaining % 100 === 0) {
      console.log(`  [quota] ${info.remaining}/${info.limit ?? "?"} left`);
    }
  });

  // Fires **once per crossing**, not once per response: spending the last ten percent
  // over an hour would otherwise call this a few thousand times.
  const offQuotaLow = sky.onQuotaLow(
    (info) => console.warn(`  [quota] low: ${info.remaining} of ${info.limit} left`),
    { threshold: 0.1 },
  );

  // --- Cache hits are visible, not magic --------------------------------------
  const first = await sky.requestWithResponse({
    method: "GET",
    path: "/weather/metar/KJFK",
    responseKind: "json",
  });
  const second = await sky.requestWithResponse({
    method: "GET",
    path: "/weather/metar/KJFK",
    responseKind: "json",
  });
  console.log(`first:  cache ${first.response.headers.get(CACHE_HIT_HEADER) ?? "miss"}`);
  console.log(`second: cache ${second.response.headers.get(CACHE_HIT_HEADER) ?? "miss"}`);
  // A cache hit costs no request, so it carries no quota headers either — which is
  // why `lastRateLimit` does not move on the second call.
  console.log(`quota after two reads: ${sky.lastRateLimit?.remaining ?? "?"}`);

  // Typed calls use the same cache; only successful GETs are ever stored.
  await sky.weather.metar("KJFK", { parsed: true });
  const airport = await sky.airports.search({ icao: "KJFK" });
  console.log(`${airport.name}: cached for a day`);

  // --- Clones: same connection, different policy ------------------------------
  // `withOptions` keeps the channel, the credentials and the `fetch`, and shares the
  // cache store unless you override it. Quota state and listeners are *not* shared.
  const patient = sky.withOptions({ timeout: 120_000, maxRetries: 5 });
  const pdf = await patient.briefing.pdf({ departure_icao: "KJFK", arrival_icao: "EGLL" });
  console.log(`briefing PDF: ${pdf.byteLength} bytes`);

  // A clone that always goes to the network — for the one call where staleness hurts.
  const live = sky.withOptions({ cache: null });
  const feed = await live.adsb.aircraft({ lat: 40.64, lon: -73.78, radius: 40, limit: 10 });
  console.log(`live feed: ${feed.total_count} aircraft`);

  // Headers are merged, not replaced: adding one does not mean restating the rest.
  const traced = sky.withOptions({ defaultHeaders: { "X-Request-Source": "example" } });
  console.log(traced.toString()); // the api key is masked to its last four characters

  offRateLimit();
  offQuotaLow();
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

// --- Run: RAPIDAPI_KEY=... npx tsx examples/cache-and-quota.ts ---
