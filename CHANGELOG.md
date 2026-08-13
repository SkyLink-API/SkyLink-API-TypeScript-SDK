# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

First public release. Covers the SkyLink API v3.1 surface.

### Added

**Client**

- `SkyLink` client with eager readonly namespaces, resolved configuration on
  `client.config` and `client.baseUrl`.
- Two distribution channels via `provider`: `"rapidapi"` — **the default** —
  (`https://skylink-api.p.rapidapi.com`, `X-RapidAPI-Key` + `X-RapidAPI-Host`,
  `RAPIDAPI_KEY` falling back to `SKYLINK_API_KEY`) and `"direct"`
  (`https://data.skylinkapi.com/v3.1`, `x-api-key`, `SKYLINK_API_KEY` only). Both
  expose an identical method surface.
- `baseUrl` override for staging and local backends; supplying it makes the API key
  optional, so keyless `DISABLE_AUTH` deployments work.
- Options: `apiKey`, `provider` (`"rapidapi"`), `baseUrl`, `timeout` (30 000 ms),
  `maxRetries` (3), `historyPlan` (`"ultra"`), `defaultHeaders`, `fetch`.
- Per-request `RequestOptions`: `timeout`, `maxRetries`, `headers`, `signal`.
- `client.lastRateLimit` from the quota headers of every response, error responses
  included — `X-RateLimit-Requests-{Limit,Remaining,Reset}` on RapidAPI and
  `X-RateLimit-{Limit,Remaining,Reset}` on the direct channel, the former taking
  precedence. RapidAPI's `X-RateLimit-rapid-free-plans-hard-limit-*` headers are
  ignored: they report the marketplace's free-tier ceiling, not the plan's quota.
- `client.request()` / `client.requestWithResponse()` as escape hatches for untyped
  endpoints.

**Namespaces** (21) — `weather`, `airports`, `airlines`, `navaids`, `geo`, `adsb`,
`aircraft`, `charts`, `delays`, `notams`, `schedules`, `ml`, `carbon`, `briefing`,
`routes`, `tickets`, `webhooks`, `history`, plus the three client-side ones
(`batch`, `poll`, `compose`) — and the client-level shortcuts `flightStatus()` and
`distance()`.

- `weather` — `metar`, `taf` (both overloaded on `parsed`), `windsAloft`, `pireps`,
  `airsigmet`.
- `airports` — `search`, `nearby`, `byIp`, `searchText`.
- `airlines` — `search`. `navaids` — `list` (client-side "at least one filter" check).
- `geo` — `countries`, `country`, `regions`, `region`.
- `adsb` — `aircraft` (the one paginated endpoint), `statistics`, `health`.
- `aircraft` — `byRegistration`, `byIcao24` (discriminated union on `found`),
  `performance`, `databaseStats`.
- `charts` — `byAirport`, `byCategory`, `sources`; charts typed as
  `Partial<Record<ChartCategory, Chart[]>>`.
- `delays` — `faa` (nationwide and per airport). `notams` — `byAirport`.
- `schedules` — `departures`, `arrivals`; flight rows keep their PascalCase wire keys.
- `ml` — `flightTime` with the wire parameter names `from` / `to`.
- `carbon` — `estimate`. `tickets` — `search`.
- `briefing` — `flight` overloaded on `format` (`"json"` → object, text formats →
  `string`) and `pdf` → `Uint8Array`.
- `routes` — `byCallsign` (union on `source`), `byAirport`, `pairs`.
- `webhooks` — `create` (201), `list`, `update`, `delete` (204 → `void`), `eventTypes`;
  envelopes unwrapped to arrays.
- `history` — `flights`, `flight`, `track`, `positions` (dispatches ICAO24 vs
  registration by shape), `positionsByIcao24`, `positionsByRegistration`,
  `airportTraffic`, all parameterized by the `ultra` / `mega` plan prefix.

**Developer experience**

- `sky.batch` — `metars`, `tafs`, `notams`, `airports` (IATA/ICAO classified per code),
  `flightStatuses`: one entry per input identifier holding the response *or* its
  `SkyLinkError`, five requests in flight by default, duplicates collapsed. Helpers
  `successes`, `failures`, `isBatchError`, `throwForErrors`, `mapConcurrent`.
- `sky.compose` — `airportBrief`, `flightBrief`, `routeBrief`, `enrichAdsb`,
  `schedulesWithStatus`, `northAmericaCountries`. Parts are fetched in parallel and a
  failed part is collected into `brief.errors` under its own name instead of throwing;
  only the primary call (airport lookup, flight status, schedule board) propagates.
  `include`/`exclude` decide what is *requested*, so a deselected part costs no quota.
  Briefs fetch weather with `parsed: true`; `flightBrief` prices CO₂ from the route's
  ICAO pair and falls back to the callsign; `schedulesWithStatus` accepts IATA or ICAO
  and requests each distinct flight number once.
- `sky.poll` — `flightStatus` (changes only, stops on a terminal status) and `adsb`
  (appeared/updated/disappeared diffs plus the full snapshot) as async generators;
  429 and 5xx are waited out, `interval`/`maxIterations`/`AbortSignal` end the loop.
- Async iterators over the two paginated shapes: `adsb.iterAircraft()` (`limit`/`offset`,
  with a repeated-page guard) and `history.iterFlights()` (time windows clamped to the
  plan's retention).
- Zero-dependency helper modules, also published as subpath entry points
  (`skylink-api/units`, `/spatial`, `/idents`, `/weather`, `/geojson`, `/sentinels`,
  `/batch`, `/cache`, `/csv`): unit conversions and the prose/`P6SM` parsers,
  great-circle and bounding-box maths, track statistics and RDP simplification,
  flight-category/ceiling/wind components, identifier classification, sentinel
  narrowing, RFC 7946 GeoJSON exporters and RFC 4180 `toCsv()`.
- Opt-in response cache (`MemoryCache`, `CacheProtocol`, `resolveTtl`,
  `CACHE_HIT_HEADER`): **off unless configured**, per-operation TTLs in milliseconds,
  successful GETs only, LRU eviction on a monotonic clock.
- Quota observers `client.onRateLimit()` (every response that carried the headers) and
  `client.onQuotaLow()` (once per crossing, re-armed on reset), plus `SkyLink.fromEnv()`
  and `client.withOptions()` for clones that share the connection pool but not state.
- `webhooks.ensure()` for idempotent subscription setup.

**Transport**

- Zero runtime dependencies: native `fetch`, `AbortController`, `URLSearchParams`.
- Retry policy: 429/500/502/503/504 and transport failures, full-jitter exponential
  backoff (`random() * min(8 s, 500 ms * 2^attempt)`), `Retry-After` honoured in both
  the seconds and HTTP-date forms (capped at 60 s). `POST` retried only on 429.
- Overall per-attempt deadline enforced with `AbortController`; external `AbortSignal`
  cancels immediately without retrying.
- Query serialization that drops nullish values, lower-cases booleans, comma-joins
  bounding boxes and CSV filters, and formats dates per endpoint (`DD-MM-YYYY` for
  schedules, `YYYY-MM-DD` for tickets, ISO 8601 for history).
- Response decoding for JSON, text, binary (`Uint8Array`) and empty (204) bodies.

**Errors**

- `SkyLinkError` → `APIConnectionError` / `APITimeoutError` and `APIStatusError`
  (`status`, `statusCode`, `headers`, `body`, `code`) → `BadRequestError`,
  `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`,
  `UnprocessableEntityError` (`errors[]`), `RateLimitError` (`rateLimit`,
  `retryAfter`), `InternalServerError`, `ServiceUnavailableError`.
- One parser for the three error-body shapes the API emits: gateway
  `{ error, message, code }`, `HTTPException` `{ detail }` and validation
  `{ detail: [{ loc, msg, type }] }`.
- HTTP 200 "not found" sentinels are modelled as types, not exceptions: the
  `found: true | false` union on aircraft lookup, `error` on IP airport search and
  `note` on history search.

**Types**

- Compile-time-only interfaces mirroring the wire exactly — `snake_case` fields,
  PascalCase schedules rows, `usageType` on navaids — with no index signatures and no
  runtime validation. ISO 8601 values are typed `string`; scraped/opaque times
  (flight status, NOTAM validity, delay durations) are left unparsed.

**Packaging**

- Dual ESM + CJS build with declaration files for both, `exports` map, `sideEffects:
  false`, Node >= 20.
- CI on Node 20/22/24 (Biome, `tsc --noEmit`, build, vitest) and tag-triggered
  publishing with npm provenance.
- Ten runnable examples in `examples/` — weather, ADS-B, briefings, history, webhooks,
  batch, compose, polling, helper exports, cache and quota — and an env-gated
  integration suite.

[Unreleased]: https://github.com/skylinkapi/TypeScript-SDK/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/skylinkapi/TypeScript-SDK/releases/tag/v0.1.0
