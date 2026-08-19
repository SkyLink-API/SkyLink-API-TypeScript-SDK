# SkyLink API — TypeScript SDK

[![CI](https://github.com/SkyLink-API/SkyLink-API-TypeScript-SDK/actions/workflows/ci.yml/badge.svg)](https://github.com/SkyLink-API/SkyLink-API-TypeScript-SDK/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/skylink-api.svg)](https://www.npmjs.com/package/skylink-api)
[![types](https://img.shields.io/npm/types/skylink-api.svg)](https://www.npmjs.com/package/skylink-api)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official TypeScript/JavaScript client for the [SkyLink API](https://skylinkapi.com) — live
ADS-B tracking, aviation weather, airports and navaids, aerodrome charts, NOTAMs, FAA
delays, flight status, schedules, preflight briefings, historical flights and more.

**Zero runtime dependencies.** Native `fetch` and `AbortController` only, so it runs
unchanged on Node 20+, Bun, Deno, Cloudflare Workers and Vercel Edge. Every endpoint is
typed, retries and quota tracking are built in, and both ESM and CJS builds ship with
declaration files.

## Install

```bash
npm install skylink-api
```

```bash
pnpm add skylink-api      # or: yarn add skylink-api / bun add skylink-api
```

Requires Node.js 20 or newer (any runtime with a global `fetch`).

## Quickstart

**RapidAPI** — the default channel. Key from the marketplace listing, read from
`RAPIDAPI_KEY` (or `SKYLINK_API_KEY`) when you do not pass one:

```ts
import { SkyLink } from "skylink-api";

const sky = new SkyLink({ apiKey: process.env.RAPIDAPI_KEY });

const metar = await sky.weather.metar("KJFK", { parsed: true });
console.log(metar.raw, metar.parsed?.flight_rules);

const flight = await sky.flightStatus("BA117");
console.log(flight.status, flight.arrival.estimated_time);
```

**Direct** — key from [skylinkapi.com](https://skylinkapi.com), read from
`SKYLINK_API_KEY`:

```ts
import { SkyLink } from "skylink-api";

const sky = new SkyLink({
  provider: "direct",
  apiKey: process.env.SKYLINK_API_KEY,
});

const metar = await sky.weather.metar("KJFK", { parsed: true });
```

Both channels expose the identical method surface. The provider only decides the base URL
(`https://skylink-api.p.rapidapi.com` vs `https://data.skylinkapi.com/v3.1`) and which
auth headers are sent (`X-RapidAPI-Key` + `X-RapidAPI-Host` vs `x-api-key`).

## Configuration

```ts
const sky = new SkyLink({
  provider: "rapidapi",
  apiKey: process.env.RAPIDAPI_KEY,
  timeout: 30_000,
  maxRetries: 3,
  historyPlan: "ultra",
  defaultHeaders: { "X-Request-Source": "dispatch-tool" },
});
```

| Option           | Type                            | Default                                  | Notes |
| ---------------- | ------------------------------- | ---------------------------------------- | ----- |
| `provider`       | `"direct" \| "rapidapi"`        | `"rapidapi"`                             | Picks the base URL and the auth header pair. |
| `apiKey`         | `string`                        | `RAPIDAPI_KEY` → `SKYLINK_API_KEY` (rapidapi), `SKYLINK_API_KEY` (direct) | Env var chosen by `provider`; the RapidAPI channel falls back to `SKYLINK_API_KEY`, the direct channel never reads `RAPIDAPI_KEY`. Missing key throws `AuthenticationError` at construction — unless `baseUrl` is set explicitly. |
| `baseUrl`        | `string`                        | per provider                             | Staging, proxies, a local backend. Trailing slashes are trimmed. Setting it makes `apiKey` optional (for `DISABLE_AUTH` deployments). |
| `timeout`        | `number` (ms)                   | `30_000`                                 | Overall deadline **per attempt**, enforced with `AbortController`. |
| `maxRetries`     | `number`                        | `3`                                      | Retries *after* the first attempt. `0` disables retrying. |
| `historyPlan`    | `"ultra" \| "mega"`             | `"ultra"`                                | Default path prefix for `sky.history.*`. Overridable per call. |
| `defaultHeaders` | `Record<string, string>`        | `{}`                                     | Merged into every request; per-request headers win. |
| `fetch`          | `(url, init) => Promise<Response>` | global `fetch`                        | Inject an implementation — `undici`, a proxy agent, a test double. |

Every method also takes a trailing `RequestOptions` argument:

```ts
await sky.adsb.aircraft(
  { lat: 40.64, lon: -73.78, radius: 80 },
  { timeout: 5_000, maxRetries: 0, headers: { "X-Trace": "abc" }, signal: controller.signal },
);
```

Read-only client members:

```ts
sky.config;          // ResolvedConfig — baseUrl, timeout, retry budget, history plan
sky.baseUrl;         // string
sky.lastRateLimit;   // RateLimitInfo | null — refreshed from every response
```

Escape hatches for endpoints this SDK does not type yet:

```ts
const data = await sky.request<MyShape>({ method: "GET", path: "/some/new/endpoint" });
const full = await sky.requestWithResponse<MyShape>({ method: "GET", path: "/health" });
full.data; full.response; full.rateLimit;
```

## Method index

Every method below exists on the client. Parameter and response fields are named exactly
as they appear **on the wire** (`snake_case`, `PascalCase` in schedules rows, `usageType`
in navaids); only method names are camelCase.

### `sky.weather` — aviation weather

| Method | Endpoint |
| --- | --- |
| `metar(icao: string, params?: { parsed?: boolean }, options?): Promise<MetarResponse>` | `GET /weather/metar/{icao}` |
| `metar(icao: string, params: { parsed: true }, options?): Promise<ParsedMetarResponse>` | `GET /weather/metar/{icao}?parsed=true` |
| `taf(icao: string, params?: { parsed?: boolean }, options?): Promise<TafResponse>` | `GET /weather/taf/{icao}` |
| `taf(icao: string, params: { parsed: true }, options?): Promise<ParsedTafResponse>` | `GET /weather/taf/{icao}?parsed=true` |
| `windsAloft(params: WindsAloftParams, options?): Promise<WindsAloftResponse>` | `GET /weather/winds-aloft?bbox&forecast&level` |
| `pireps(params: PirepsParams, options?): Promise<PirepsResponse>` | `GET /weather/pireps?bbox&hours` |
| `airsigmet(params: AirSigmetParams, options?): Promise<AirSigmetResponse>` | `GET /weather/airsigmet?bbox&type` |

### `sky.airports` — airport lookup

| Method | Endpoint |
| --- | --- |
| `search(params: { icao } \| { iata }, options?): Promise<EnrichedAirport>` | `GET /airports/search?icao\|iata` |
| `nearby(params: AirportsNearbyParams, options?): Promise<AirportsNearbyResponse>` | `GET /airports/search/location?lat&lon&radius&type&limit` |
| `byIp(params?: AirportsByIpParams, options?): Promise<AirportsByIpResponse>` | `GET /airports/search/ip?ip&radius&type&limit` |
| `searchText(params: AirportsTextSearchParams, options?): Promise<AirportsTextSearchResponse>` | `GET /airports/search/text?q&limit&type` |

### `sky.airlines` — airline lookup

| Method | Endpoint |
| --- | --- |
| `search(params: { icao } \| { iata }, options?): Promise<Airline[]>` | `GET /airlines/search?icao\|iata` |

### `sky.navaids` — radio navigation aids

| Method | Endpoint |
| --- | --- |
| `list(params: NavaidsListParams, options?): Promise<NavaidsResponse>` | `GET /navaids?ident&airport&type&country&bbox&limit` |

At least one filter is required; the SDK throws `SkyLinkError` before issuing a request
if none is given.

### `sky.geo` — countries and regions

| Method | Endpoint |
| --- | --- |
| `countries(params?: { continent? }, options?): Promise<CountriesResponse>` | `GET /countries?continent` |
| `country(code: string, options?): Promise<CountryDetail>` | `GET /countries/{code}` |
| `regions(params?: { country?, continent? }, options?): Promise<RegionsResponse>` | `GET /regions?country&continent` |
| `region(code: string, options?): Promise<RegionDetail>` | `GET /regions/{code}` |

### `sky.adsb` — live traffic

| Method | Endpoint |
| --- | --- |
| `aircraft(params?: AdsbAircraftParams, options?): Promise<AdsbAircraftResponse>` | `GET /adsb/aircraft?icao24&callsign&lat&lon&radius&bbox&min_alt&max_alt&min_speed&max_speed&registration&airline&photos&limit&offset` |
| `statistics(options?): Promise<AdsbStatisticsResponse>` | `GET /adsb/aircraft/statistics` |
| `health(options?): Promise<AdsbHealthResponse>` | `GET /adsb/health` |

The only paginated endpoint in the API (`limit` / `offset`).

### `sky.aircraft` — registry and performance

| Method | Endpoint |
| --- | --- |
| `byRegistration(registration: string, params?: { photos? }, options?): Promise<AircraftLookupResponse>` | `GET /aircraft/registration/{registration}?photos` |
| `byIcao24(icao24: string, params?: { photos? }, options?): Promise<AircraftLookupResponse>` | `GET /aircraft/icao24/{icao24}?photos` |
| `performance(icaoType: string, options?): Promise<AircraftPerformance>` | `GET /aircraft/performance/{icao_type}` |
| `databaseStats(options?): Promise<AircraftDatabaseStats>` | `GET /aircraft/database/stats` |

`AircraftLookupResponse` is a discriminated union on `found` — see [Sentinels](#sentinels-on-200).

### `sky.charts` — terminal procedure charts

| Method | Endpoint |
| --- | --- |
| `byAirport(icao: string, params?: { source? }, options?): Promise<ChartsResponse>` | `GET /charts/{icao}?source` |
| `byCategory(icao: string, category: ChartCategory, params?: { source? }, options?): Promise<ChartsResponse>` | `GET /charts/{icao}/{category}?source` |
| `sources(options?): Promise<ChartSourcesResponse>` | `GET /charts/sources` |

`ChartCategory` is `"GEN" \| "GND" \| "SID" \| "STAR" \| "APP"`; `charts` comes back as
`Partial<Record<ChartCategory, Chart[]>>`, so index it defensively.

### `sky.delays` — FAA delay programs

| Method | Endpoint |
| --- | --- |
| `faa(icao?: string, options?): Promise<FaaDelaysResponse>` | `GET /delays/faa` · `GET /delays/faa/{icao}` |

### `sky.notams` — NOTAMs

| Method | Endpoint |
| --- | --- |
| `byAirport(icao: string, params?: NotamsParams, options?): Promise<NotamsResponse>` | `GET /notams/{icao}?exclude_qcode&exclude_scope&include_future` |

### `sky.schedules` — departure and arrival boards

| Method | Endpoint |
| --- | --- |
| `departures(params: SchedulesParams, options?): Promise<DeparturesResponse>` | `GET /schedules/departures?icao\|iata&date&time&ts` |
| `arrivals(params: SchedulesParams, options?): Promise<ArrivalsResponse>` | `GET /schedules/arrivals?icao\|iata&date&time&ts` |

Exactly one of `icao` / `iata` must be given; `date` accepts a `Date` or a `DD-MM-YYYY`
string. Flight rows use **PascalCase** keys — see [Gotchas](#gotchas).

### `sky.ml` — predictions

| Method | Endpoint |
| --- | --- |
| `flightTime(params: { origin, destination, aircraft? }, options?): Promise<FlightTimePrediction>` | `GET /ml/flight-time?from&to&aircraft` |

The properties really are `from` and `to`, matching the wire names.

### `sky.carbon` — emissions

| Method | Endpoint |
| --- | --- |
| `estimate(params: CarbonEstimateParams, options?): Promise<CarbonEstimate>` | `GET /carbon/estimate?departure_icao&arrival_icao&callsign&aircraft_type&passengers&include_rfi` |

Supply either `callsign` or both airports; the SDK throws `SkyLinkError` otherwise.

### `sky.briefing` — preflight briefings

| Method | Endpoint |
| --- | --- |
| `flight(params: BriefingParams & { format?: "json" }, options?): Promise<FlightBriefing>` | `GET /briefing/flight?origin&destination&include_weather&include_notams&include_pireps` |
| `flight(params: BriefingParams & { format: "markdown" \| "plain_text" \| "html" }, options?): Promise<string>` | `GET /briefing/flight?...&format` |
| `pdf(params: { departure_icao, arrival_icao, flight_number? }, options?): Promise<Uint8Array>` | `GET /briefing/pdf?departure_icao&arrival_icao&flight_number` |

> **These are the slowest calls in the SDK.** A briefing is composed by a language model
> over both airports' weather and NOTAMs: measured live on 2026-08-15, `flight()` took
> 30–85 s and `pdf()` about 50 s. Both therefore run with their own 180 s deadline
> (`BRIEFING_TIMEOUT_MS`) instead of the client-wide 30 s — under that default a healthy
> request aborts, gets retried three times, and fails after two minutes. It is a default,
> not a ceiling; pass `{ timeout }` when a slow page is worse than no briefing.
>
> ```ts
> await sky.briefing.flight(
>   { origin: "KJFK", destination: "KLAX" },
>   { timeout: 60_000, maxRetries: 0 },
> );
> ```

### `sky.routes` — route lookup

| Method | Endpoint |
| --- | --- |
| `byCallsign(callsign: string, options?): Promise<CallsignRoute>` | `GET /routes/callsign/{callsign}` |
| `byAirport(code: string, params?: { direction?, limit? }, options?): Promise<AirportRoutesResponse>` | `GET /routes/airport/{code}?direction&limit` |
| `pairs(params?: { departure?, arrival?, limit? }, options?): Promise<RoutePairsResponse>` | `GET /routes/pairs?departure&arrival&limit` |

`CallsignRoute` is a union discriminated by `source: "vrs" \| "airline_routes"`.

### `sky.tickets` — fares

| Method | Endpoint |
| --- | --- |
| `search(params: TicketSearchParams, options?): Promise<TicketSearchResponse>` | `GET /tickets/search?origin&destination&date&passengers` |

`date` accepts a `Date` or a `YYYY-MM-DD` string.

Offers are cheapest first and there is **no small cap** — a busy city pair returns 100+, so
slice before rendering. `price_usd` is the converted total; `original_price` and
`original_currency` carry the upstream quote (e.g. `137 CHF` behind `168.52`) and are how you
spot the case where conversion failed and `price_usd` is silently *not* USD.

### `sky.webhooks` — push subscriptions

| Method | Endpoint |
| --- | --- |
| `create(params: WebhookCreateParams, options?): Promise<Webhook>` | `POST /webhooks` → 201 |
| `list(options?): Promise<WebhookSubscription[]>` | `GET /webhooks` |
| `update(id: string, params: { active: boolean }, options?): Promise<WebhookToggleResult>` | `PATCH /webhooks/{id}` |
| `delete(id: string, options?): Promise<void>` | `DELETE /webhooks/{id}` → 204 |
| `eventTypes(options?): Promise<WebhookEventType[]>` | `GET /webhooks/events` |

`list()` and `eventTypes()` unwrap the `{ count, webhooks }` / `{ event_types }` envelopes
and resolve to the arrays directly.

### `sky.history` — archived ADS-B

Every path is prefixed by the plan: `/ultra/history/...` or `/mega/history/...`.

| Method | Endpoint |
| --- | --- |
| `flights(params: HistoryFlightsParams, options?): Promise<HistoryFlightsResponse>` | `GET /{plan}/history/flights?start&end&icao24&registration&callsign&departure_icao&arrival_icao&limit` |
| `flight(flightId: string, params?: { plan? }, options?): Promise<HistoryFlight>` | `GET /{plan}/history/flight/{flightId}` |
| `track(flightId: string, params?: { plan?, limit? }, options?): Promise<HistoryTrackResponse>` | `GET /{plan}/history/flight/{flightId}/track?limit` |
| `positions(ident: string, params?: HistoryPositionsParams, options?): Promise<HistoryPositionsResponse>` | dispatches on the shape of `ident` |
| `positionsByIcao24(icao24: string, params?: HistoryPositionsParams, options?): Promise<HistoryPositionsResponse>` | `GET /{plan}/history/positions/{icao24}?start&end&limit` |
| `positionsByRegistration(registration: string, params?: HistoryPositionsParams, options?): Promise<HistoryPositionsResponse>` | `GET /{plan}/history/positions/registration/{registration}?start&end&limit` |
| `airportTraffic(icao: string, params?: HistoryAirportTrafficParams, options?): Promise<HistoryAirportTrafficResponse>` | `GET /{plan}/history/airport/{icao}/traffic?start&end&direction&limit` |

`positions(ident)` treats six hexadecimal characters as an ICAO24 address and anything else
as a registration. Call the explicit method when the identifier kind is known.

`flights()` needs at least one of `icao24`, `registration`, `callsign`, `departure_icao`,
`arrival_icao` — a time window alone is a `422` from the API, so the SDK throws
`SkyLinkError` before issuing the request.

### Client-level shortcuts

Two endpoints have a single operation each, so they are methods on the client rather than
one-member namespaces.

| Method | Endpoint |
| --- | --- |
| `sky.flightStatus(flightNumber: string, options?): Promise<FlightStatusResponse>` | `GET /flight_status/{flight_number}` |
| `sky.distance(params: DistanceParams, options?): Promise<DistanceResponse>` | `GET /distance?from_icao&to_icao&from_lat&from_lon&to_lat&to_lon&unit` |

```ts
const leg = await sky.distance({ from_icao: "KJFK", to_icao: "EGLL", unit: "km" });
const mixed = await sky.distance({ from_lat: 40.64, from_lon: -73.78, to_icao: "EGLL" });
```

Each endpoint of `distance` is either an airport code **or** a lat/lon pair; the types
prevent mixing both forms on the same endpoint.

## Developer experience

Everything below is built on the endpoints above — no new API surface, just the code you
would otherwise write yourself. All of it is optional and none of it changes how a plain
call behaves.

### `sky.batch` — the same call for many identifiers

The API has no bulk endpoint, so twenty airports are twenty calls. `sky.batch` keeps five
in flight (per-second rate limits are real) and returns **one entry per input**, holding
either the response or the error that call failed with — one bad code costs you that
airport, not the board.

```ts
import { batch, SkyLink } from "skylink-api";

const results = await sky.batch.metars(["KJFK", "EGLL", "ZZZZ"], { concurrency: 5 });
for (const [icao, result] of Object.entries(results)) {
  if (batch.isBatchError(result)) console.warn(icao, result.message);
  else console.log(icao, result.raw);
}

const ok = batch.successes(results);   // { KJFK: …, EGLL: … }
const bad = batch.failures(results);   // { ZZZZ: NotFoundError }
batch.throwForErrors(results);         // or make it all-or-nothing
```

Methods: `metars`, `tafs`, `notams`, `airports` (classifies each code as IATA or ICAO),
`flightStatuses`. Duplicate inputs collapse into a single request.

### `sky.compose` — multi-endpoint aggregates

One call where an application would make seven, in parallel. **A brief degrades into
`errors`, it does not throw**: a part that fails is `null` and its `SkyLinkError` is filed
under that part's own name. Only the primary call throws — the airport lookup of an
airport brief, the flight status of a flight brief, the board of `schedulesWithStatus` —
because without it the aggregate is meaningless.

```ts
const brief = await sky.compose.airportBrief("EGLL", { schedulesLimit: 5 });
console.log(brief.metar?.parsed?.flight_rules, brief.notams?.total);
for (const [part, error] of Object.entries(brief.errors)) {
  console.warn(`${part} unavailable:`, error.message);   // e.g. delays: EGLL is not FAA
}
```

| Method | Joins |
| --- | --- |
| `airportBrief(icao, { include?, exclude?, schedulesLimit? })` | airport, METAR, TAF, NOTAMs, FAA delays, charts, both boards — eight requests at once |
| `flightBrief(flightNumber, { include?, exclude? })` | status → registry lookup, callsign → route → CO₂ |
| `routeBrief(origin, destination, { aircraftType?, passengers? })` | distance, block time, both ends' weather, CO₂ |
| `enrichAdsb(states, { maxLookups?, concurrency?, photos? })` | live ADS-B rows × the airframe registry, one lookup per distinct `icao24` |
| `schedulesWithStatus(code, { direction?, limit?, concurrency? })` | a board × the live status of each flight number on it |
| `northAmericaCountries()` | the 41 NA countries, tolerant of every spelling the API has used |

`include`/`exclude` decide what is **requested**, so a part you do not want costs no
quota; the names are the result's own field names (`AIRPORT_BRIEF_PARTS`,
`FLIGHT_BRIEF_PARTS`, `ROUTE_BRIEF_PARTS`). Weather in the briefs is fetched decoded
(`parsed: true`), so `brief.metar.parsed` is there for `flightCategory()`.

`northAmericaCountries()` was written as a workaround: the reference CSV was read with
pandas, which parses the literal `NA` as not-a-number, so every North-American row arrived
with `continent: null` and the server-side filter matched nothing. **That is fixed** — as of
2026-08-15 `geo.countries({ continent: "NA" })` returns the 41 countries (and
`geo.regions({ continent: "NA" })` 440 regions) directly, and that is the call to prefer.
The method stays because it is public API and because it accepts the old `null`/`""`
spellings as well as `"NA"`, so it answers correctly against an older deployment; the price
is a full ~250-row download.

### Iterators and pollers

`sky.adsb.iterAircraft()` and `sky.history.iterFlights()` hide the two kinds of paging the
API has — `limit`/`offset` and time windows — behind an async generator:

```ts
for await (const state of sky.adsb.iterAircraft({ bbox: [51, -1, 52, 0] }, { maxItems: 500 })) {
  console.log(state.icao24, state.callsign);
}

for await (const flight of sky.history.iterFlights(
  { registration: "G-STBA" },
  { windowDays: 7, maxItems: 500 },
)) {
  console.log(flight.flight_id, flight.takeoff_time);
}
```

`sky.poll.*` re-asks the two endpoints whose answers change while you watch them. Both
yield immediately, then every `interval` **milliseconds**, and both ride out 429s and 5xx
(which say nothing about the subject) instead of ending the loop:

```ts
// Ends by itself on "Landed"/"Cancelled"/"Diverted"; emits only actual changes.
for await (const status of sky.poll.flightStatus("BA117", { interval: 30_000 })) {
  console.log(status.status, status.arrival.estimated_time);
}

// Diffs against the previous snapshot; the first iteration is the baseline.
for await (const diff of sky.poll.adsb({ bbox }, { interval: 5_000, maxIterations: 10 })) {
  diff.appeared.forEach(addMarker);
  diff.disappeared.forEach(removeMarker);
  diff.updated.forEach(moveMarker);
}
```

Stop them with `break`, with `maxIterations`, or with an `AbortSignal` in the options.

### Helpers

Pure functions — no client, no network — each one there for a specific trap in this API.

```ts
import { geojson, idents, sentinels, spatial, units, weatherHelpers } from "skylink-api";

spatial.bboxAround(51.47, -0.45, 60);          // "lat1,lon1,lat2,lon2" for the bbox params
spatial.haversineNm(51.47, -0.45, 40.64, -73.78);
spatial.trackStats(track.positions);           // distance, duration, altitude/speed extremes
spatial.simplifyTrack(track.positions, { toleranceKm: 0.5 });

weatherHelpers.flightCategory(metar);          // "VFR" | "MVFR" | "IFR" | "LIFR" | null
weatherHelpers.ceilingFt(metar);               // lowest BKN/OVC layer, in feet (not hundreds)
weatherHelpers.isStale(metar);                 // older than 90 minutes
weatherHelpers.windComponents(metar, 270);     // head/cross component for a runway

units.parseDurationMinutes("7h 23m");          // the ML endpoint's prose → 443
units.normalizeAltimeter(30.2);                // → { inHg, hPa } whichever unit came in
units.parseVisibility({ value: null, repr: "P6" });  // P6SM → 6 sm

idents.classifyAirportCode("LHR");             // "iata" — picks between the icao/iata params
idents.isIcao24("4ca1fb");                     // dispatch for history.positions()
idents.splitFlightNumber("U21234");            // { airline: "U2", number: "1234" } — not "U21"

sentinels.isFound(lookup);                     // narrows the found:true|false union
geojson.adsbToGeojson(feed.aircraft);          // [longitude, latitude], the GeoJSON order
```

### CSV and GeoJSON export

`toCsv` is RFC 4180: a value containing the delimiter, a quote or a line break is quoted
and escaped rather than silently shifting every column after it. Column names are the
API's own field names, `null`/`undefined` are empty cells, and nested values become JSON.

```ts
import { toCsv } from "skylink-api/csv";
import { writeFile } from "node:fs/promises";

const feed = await sky.adsb.aircraft({ bbox });
await writeFile("traffic.csv", toCsv(feed.aircraft, {
  columns: ["icao24", "callsign", "altitude", "ground_speed"],
}));
// `delimiter: ";"` for spreadsheets in comma-decimal locales, `"\t"` for a TSV.

await writeFile("traffic.geojson", JSON.stringify(geojson.adsbToGeojson(feed.aircraft)));
```

`geojson` also exports `trackToGeojson` (a `LineString`, optionally with a point per fix),
`airportsToGeojson` and `navaidsToGeojson`.

### Cache and quota hooks

**Nothing is cached by default.** A store has to be handed in, *and* the operation needs a
non-zero TTL — a METAR is worth five minutes, an airport record a day, live ADS-B nothing
at all, so there is no sane global number. Only successful `GET`s are stored, and expiry
uses a monotonic clock so a wall-clock jump cannot freeze an entry.

```ts
import { CACHE_HIT_HEADER, MemoryCache, SkyLink } from "skylink-api";

const sky = new SkyLink({
  cache: new MemoryCache({
    ttls: { "weather.metar": 300_000, "airports.*": 86_400_000, "adsb.*": 0 },
    maxEntries: 200,
  }),
});

const res = await sky.requestWithResponse({ method: "GET", path: "/weather/metar/KJFK", responseKind: "json" });
res.response.headers.get(CACHE_HIT_HEADER); // "hit" when it came from the store
```

TTLs are milliseconds and resolve most-specific-first: exact name, then `"weather.*"`, then
`"*"`, then `defaultTtl`. Implement `CacheProtocol` (three synchronous methods) to back it
with Redis or a KV store.

```ts
const off = sky.onRateLimit((info) => metrics.gauge("quota", info.remaining ?? 0));
sky.onQuotaLow((info) => alert(`${info.remaining} of ${info.limit} left`), { threshold: 0.05 });
off(); // both return an unsubscribe function
```

`onRateLimit` fires for every response that carried quota headers, with **that response's**
snapshot rather than the shared `lastRateLimit`. `onQuotaLow` fires **once per crossing**,
not once per response, and re-arms when the quota window resets.

### `fromEnv` and `withOptions`

```ts
const sky = SkyLink.fromEnv();                       // RAPIDAPI_KEY / SKYLINK_API_KEY
const direct = SkyLink.fromEnv({ provider: "direct" });

const patient = sky.withOptions({ timeout: 120_000, maxRetries: 5 });
const live = sky.withOptions({ cache: null });       // this one always hits the network
```

A clone keeps the channel, the credentials, the `fetch` and the connection pool, and merges
`defaultHeaders` over the parent's. It does **not** inherit state: `lastRateLimit` and the
quota listeners are fresh, so a clone never reports another client's quota. The cache store
is shared unless overridden. Credentials and `baseUrl` cannot be changed by a clone — build
a new client for a different API.

### Subpath imports

Every helper module is also its own entry point, for bundles where tree-shaking matters:

```ts
import { bboxAround } from "skylink-api/spatial";
import { toCsv } from "skylink-api/csv";
import { flightCategory } from "skylink-api/weather";
import { adsbToGeojson } from "skylink-api/geojson";
```

Available: `skylink-api/units`, `/spatial`, `/idents`, `/weather`, `/geojson`, `/sentinels`,
`/batch`, `/cache`, `/csv`. Each ships ESM, CJS and declarations, and none of them imports
the client.

## Error handling

### Hierarchy

```
Error
└── SkyLinkError                 base of everything this SDK throws
    ├── APIConnectionError       no HTTP response (DNS, socket, abort)
    │   └── APITimeoutError      the deadline elapsed
    └── APIStatusError           non-2xx response — .status, .headers, .body, .code
        ├── BadRequestError            400
        ├── AuthenticationError        401  (also thrown at construction with no key)
        ├── PermissionDeniedError      403
        ├── NotFoundError              404
        ├── UnprocessableEntityError   422  — .errors: ValidationErrorItem[]
        ├── RateLimitError             429  — .rateLimit, .retryAfter (ms)
        └── InternalServerError        5xx
            └── ServiceUnavailableError 503
```

```ts
import { APIStatusError, RateLimitError, SkyLink } from "skylink-api";

try {
  await sky.weather.metar("KJFK");
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error(`retry in ${error.retryAfter} ms, ${error.rateLimit?.remaining} left`);
  } else if (error instanceof APIStatusError) {
    console.error(error.status, error.code, error.message, error.body);
  } else {
    throw error;
  }
}
```

### Three body shapes on the wire

The API emits three different error payloads. The SDK normalizes all of them into
`error.message`, and keeps the untouched payload on `error.body`.

| Shape | Example | Where it comes from |
| --- | --- | --- |
| A | `{ "error": "Unauthorized", "message": "Invalid API key", "code": "INVALID_KEY" }` | gateway 401 — populates `error.code` |
| B | `{ "detail": "Airport not found" }` | FastAPI `HTTPException` |
| C | `{ "detail": [{ "loc": ["query", "lat"], "msg": "field required", "type": "missing" }] }` | 422 validation — populates `error.errors` |

```ts
if (error instanceof UnprocessableEntityError) {
  for (const item of error.errors) console.error(item.loc.join("."), item.msg, item.type);
}
```

### Sentinels on 200

Some "not found" cases arrive as a successful response with a marker field. These are part
of the type, never an exception:

```ts
// Aircraft lookup — discriminated union on `found`.
const result = await sky.aircraft.byRegistration("G-STBA");
if (result.found) {
  console.log(result.aircraft.icao24);   // narrowed to AircraftFound
} else {
  console.log(`${result.query} is not in the registry`);
}

// IP-based airport search — `error` is a string field of a 200 body.
const nearMe = await sky.airports.byIp();
if (nearMe.error) console.warn(nearMe.error);

// History search — an unknown registration answers 200 with count 0 and a note.
const found = await sky.history.flights({ registration: "ZZ-ZZZ" });
if (found.note) console.warn(found.note);
```

### Quota

`lastRateLimit` is refreshed from the quota headers of every response, error responses
included, and stays `null` until a response actually carries them.

The two channels spell those headers differently, and the SDK reads both:
`X-RateLimit-Requests-{Limit,Remaining,Reset}` on RapidAPI,
`X-RateLimit-{Limit,Remaining,Reset}` on the direct channel. When both are present the
`Requests-` family wins. RapidAPI's decorative
`X-RateLimit-rapid-free-plans-hard-limit-*` headers describe the marketplace's free-tier
ceiling rather than your plan and are deliberately ignored.

```ts
await sky.adsb.statistics();
console.log(sky.lastRateLimit); // { limit: 10000, remaining: 9987, reset: 3600 } | null
```

`RateLimitError` carries the same snapshot on `.rateLimit`, plus `.retryAfter` in
milliseconds derived from the `Retry-After` header.

## Retries and timeouts

Retried: **429, 500, 502, 503, 504** and transport-level failures. Never retried: 400, 401,
403, 404, 422 — repeating them cannot help.

- Backoff is full jitter: `random() * min(8000 ms, 500 ms * 2^attempt)`.
- A `Retry-After` header wins over the computed backoff. Both the seconds form and the
  HTTP-date form are understood, capped at 60 s.
- `POST` is only retried on 429, where the server states it did not process the request —
  every other failure mode could have created a webhook subscription already. Transport
  failures on `POST` are never retried either.
- Default budget is 3 retries after the first attempt (4 attempts total).

Timeouts are an overall deadline **per attempt**, enforced with `AbortController`; the
default is 30 000 ms. Exceeding it throws `APITimeoutError` (a subclass of
`APIConnectionError`, so it is retryable on idempotent methods). `/briefing/*` overrides
that default with 180 000 ms of its own, because a healthy briefing takes longer than
30 s — see [`sky.briefing`](#skybriefing--preflight-briefings).

Both can be overridden per request, and an external `AbortSignal` cancels immediately
without retrying:

```ts
await sky.briefing.flight({ origin: "KJFK", destination: "EGLL" }, { timeout: 120_000 });
await sky.adsb.health({ maxRetries: 0 });

const controller = new AbortController();
setTimeout(() => controller.abort(), 2_000);
await sky.adsb.aircraft({ lat: 51.5, lon: -0.1 }, { signal: controller.signal });
```

## Gotchas

Real-world quirks of the API that the SDK surfaces rather than hides.

- **Schedules rows use PascalCase.** `DeparturesResponse.flights[]` has `Time`, `Date`,
  `IATA`, `Destination`, `Flight`, `Airline`, `Status` (arrivals use `Origin` instead of
  `Destination`). The envelope around them is snake_case. Field names follow the wire, so
  the two casings coexist.
- **Some times are opaque display strings.** `flightStatus()` returns local clock times and
  dates without a year (`"14:35"`, `"12 Aug"`); NOTAM `effective` / `expiration` and the FAA
  delay durations are scraped text. They are typed `string` and are **not** parsed — do not
  feed them to `new Date()`. Fields documented as ISO 8601 (`timestamp`, `last_seen`,
  `created_at`, history times) are safe to parse.
- **`ml.flightTime` takes `origin` / `destination`.** The endpoint's own query keys are
  `from` / `to`, and the method maps onto them — but every other route entry point in both
  SDKs says origin/destination (`compose.routeBrief(origin, destination)`, Python's
  `ml.flight_time(origin=, destination=)`), so this one spelling it differently was a
  divergence rather than fidelity. `{ from, to }` still compiles and still works; it is
  deprecated.
- **`ultra` vs `mega`.** The history plans expose identical routes and response shapes; they
  differ only in retention window and limit caps. The prefix is resolved per call —
  `params.plan` wins, then the client's `historyPlan`, then `"ultra"`. A plan your key does
  not own answers 403.
- **The PDF is a `Uint8Array`.** `briefing.pdf()` buffers the body (there is no streaming
  endpoint in the API) and resolves to raw bytes, which `fs.writeFileSync` accepts as-is.
- **No runtime validation.** Response types are a compile-time, best-effort description
  written against the backend. Nothing is parsed or checked at runtime: a field the API
  stops sending fails where you use it, not where it is decoded. There are no index
  signatures on the models, so unexpected extra fields are simply invisible to the types —
  reach for `sky.request()` when you need them.
- **Bounding boxes** are `[lat1, lon1, lat2, lon2]` tuples serialized to
  `"lat1,lon1,lat2,lon2"`; a pre-formatted string is passed through unchanged.
- **Date inputs are normalized per endpoint**, because the API has no single convention:
  schedules want `DD-MM-YYYY`, tickets want `YYYY-MM-DD`, history wants ISO 8601. Pass a
  `Date` and the SDK formats it; pass a string already in the right shape and it is left
  alone.

## Examples

Runnable scripts live in [`examples/`](examples):

| File | Shows |
| --- | --- |
| [`weather.ts`](examples/weather.ts) | raw and parsed METAR, TAF, winds aloft over a bbox |
| [`adsb-tracking.ts`](examples/adsb-tracking.ts) | live traffic in a radius, `lastRateLimit`, feed statistics and health |
| [`flight-briefing.ts`](examples/flight-briefing.ts) | the `format` overloads and writing the PDF to disk |
| [`history.ts`](examples/history.ts) | flight search, tracks, both `positions` dispatch forms, `plan: "mega"` |
| [`webhooks.ts`](examples/webhooks.ts) | the full create → list → update → delete cycle |
| [`batch.ts`](examples/batch.ts) | many identifiers per call, successes and failures split apart |
| [`compose-briefs.ts`](examples/compose-briefs.ts) | airport / flight / route briefs, and printing `errors` |
| [`polling.ts`](examples/polling.ts) | ADS-B diffs and a flight followed to the gate, bounded and abortable |
| [`helpers-export.ts`](examples/helpers-export.ts) | `bboxAround` + `flightCategory` + GeoJSON and CSV written to disk |
| [`cache-and-quota.ts`](examples/cache-and-quota.ts) | per-operation cache TTLs, quota hooks, `fromEnv` / `withOptions` |

```bash
RAPIDAPI_KEY=... npx tsx examples/weather.ts
```

## Documentation

Full API reference: <https://skylinkapi.com/docs>

## Contributing

```bash
npm install
npm test          # vitest, unit suite
npm run typecheck # tsc --noEmit over src, tests and examples
npm run lint      # biome check
npm run build     # tsup → ESM + CJS + .d.ts
```

Integration tests hit a real API instance and are gated behind an environment variable, so
they never run in the default suite:

```bash
# RapidAPI channel (the default) — a key alone is enough
SKYLINK_TEST_API_KEY=...msh...jsn... npm run test:integration

# direct channel, or a staging container
SKYLINK_TEST_PROVIDER=direct SKYLINK_TEST_API_KEY=sk_live_... npm run test:integration
SKYLINK_TEST_BASE_URL=http://localhost:8081/v3.1 npm run test:integration
```

The backend's `docker-compose.test.yml` brings up a keyless instance (`DISABLE_AUTH=true`)
on port 8081 for exactly this purpose.

`tests/integration/live-webhooks.test.ts` is the one suite that writes: it runs the full
subscription CRUD, all three `ensure()` branches and the plan cap. Webhooks are plan-gated,
so it arms only on the direct channel (or an explicit `baseUrl`) and reports as skipped
otherwise. Everything it creates points at an unreachable `example.com` URL and is deleted
afterwards, pass or fail.

Publishing is automated: a push to `main` (or a `v*` tag) lints, type-checks, tests and
builds the package, then publishes it when `package.json` holds a version that is not on
npm yet — so merging a version bump releases it and any other merge is a no-op. Provenance
attestation is attached when the repository is public; npm cannot mint it from a private
source. Authentication comes from the `NPM_ACCESS_TOKEN` secret, or from npm trusted
publishing (OIDC) once it is configured for `SkyLink-API/SkyLink-API-TypeScript-SDK`.

## License

MIT — see [LICENSE](LICENSE).
