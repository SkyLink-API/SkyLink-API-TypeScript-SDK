/**
 * `sky.poll` — the polling namespace (`src/resources/poll.ts`).
 *
 * The contract under test: the first iteration is immediate; the wait between
 * iterations is interruptible and injectable; `429`/5xx are waited out rather than
 * thrown, while 401/403/422 reach the caller; a terminal status is yielded and *then*
 * ends the generator; and the ADS-B diff is taken on `icao24` with movement — not a
 * ticking `last_seen` — deciding what counts as "updated".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { PermissionDeniedError, UnprocessableEntityError } from "../src/core/errors.js";
import type { AdsbAircraft, AdsbAircraftResponse } from "../src/models/adsb.js";
import type { FlightStatusResponse } from "../src/models/flight-status.js";
import type { AdsbDiff } from "../src/models/poll.js";
import {
  DEFAULT_ADSB_INTERVAL_MS,
  DEFAULT_FLIGHT_STATUS_INTERVAL_MS,
  interruptibleSleep,
  isTerminalFlightStatus,
  TERMINAL_FLIGHT_STATUSES,
} from "../src/resources/poll.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_PREFIX,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const statusFixture = loadFixture<FlightStatusResponse>("flight_status");
const feedFixture = loadFixture<AdsbAircraftResponse>("adsb_aircraft");

const STATUS_PATH = `${DIRECT_PREFIX}/flight_status/BA123`;
const FEED_PATH = `${DIRECT_PREFIX}/adsb/aircraft`;

/** A client whose transport never retries, so the poller sees the failure itself. */
function client(options: ClientOptions = {}): SkyLink {
  return new SkyLink({
    apiKey: "test-key",
    provider: "direct",
    maxRetries: 0,
    sleep: async () => undefined,
    ...options,
  });
}

/** Records every wait the poller asks for, without performing it. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

async function collect<T>(source: AsyncIterable<T>, limit = 50): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function statusBody(status: string, overrides: Partial<FlightStatusResponse> = {}) {
  return { ...statusFixture, status, ...overrides };
}

/** One interceptor per response, consumed in registration order. */
function mockStatuses(bodies: unknown[]): void {
  for (const body of bodies) mockJson({ path: STATUS_PATH, body });
}

function state(icao24: string, overrides: Partial<AdsbAircraft> = {}): AdsbAircraft {
  return { ...(feedFixture.aircraft[0] as AdsbAircraft), icao24, ...overrides };
}

function feed(aircraft: AdsbAircraft[]): AdsbAircraftResponse {
  return { aircraft, total_count: aircraft.length, timestamp: feedFixture.timestamp };
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("terminal status detection", () => {
  it("matches case-insensitively, by substring", () => {
    expect(isTerminalFlightStatus("Landed 14:32")).toBe(true);
    expect(isTerminalFlightStatus("LANDED")).toBe(true);
    expect(isTerminalFlightStatus("Cancelled by airline")).toBe(true);
    // Both spellings are real: the backend scrapes several sources.
    expect(isTerminalFlightStatus("Canceled")).toBe(true);
    expect(isTerminalFlightStatus("Diverted to EINN")).toBe(true);
    expect(isTerminalFlightStatus("Arrived at gate B15")).toBe(true);
  });

  it("leaves live statuses alone", () => {
    for (const status of ["En Route", "Scheduled", "Delayed", "Unknown", "Boarding", ""]) {
      expect(isTerminalFlightStatus(status)).toBe(false);
    }
    expect(isTerminalFlightStatus(null)).toBe(false);
    expect(isTerminalFlightStatus(undefined)).toBe(false);
  });

  it("exports the five documented fragments", () => {
    expect([...TERMINAL_FLIGHT_STATUSES]).toEqual([
      "landed",
      "arrived",
      "cancelled",
      "canceled",
      "diverted",
    ]);
  });
});

describe("interruptibleSleep", () => {
  it("resolves as soon as the signal aborts, well before the deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const started = Date.now();
    await interruptibleSleep(30_000, controller.signal);

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns immediately for an already-aborted signal", async () => {
    const started = Date.now();
    await interruptibleSleep(30_000, AbortSignal.abort());
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("removes its abort listener when the timer wins, so long polls do not leak", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await interruptibleSleep(1, controller.signal);

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("works without a signal at all", async () => {
    await expect(interruptibleSleep(1)).resolves.toBeUndefined();
  });
});

describe("poll.flightStatus", () => {
  it("polls immediately and emits only changes by default", async () => {
    mockStatuses([
      statusBody("Scheduled"),
      statusBody("Scheduled"),
      statusBody("En Route"),
      statusBody("En Route", { arrival: { ...statusFixture.arrival, gate: "B22" } }),
    ]);
    const { waits, sleep } = recordingSleep();

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 4, interval: 1_000, sleep }),
    );

    expect(requests).toHaveLength(4);
    expect(seen.map((s) => s.status)).toEqual(["Scheduled", "En Route", "En Route"]);
    expect(seen[2]?.arrival.gate).toBe("B22");
    // Three gaps between four polls, none after the last one.
    expect(waits).toEqual([1_000, 1_000, 1_000]);
  });

  it("ignores fields outside the significant set", async () => {
    // A response identical except for an airport label the SDK does not compare.
    mockStatuses([
      statusBody("En Route"),
      statusBody("En Route", {
        departure: { ...statusFixture.departure, airport_full: "London Heathrow" },
      }),
    ]);

    const seen = await collect(
      client().poll.flightStatus("BA123", {
        maxIterations: 2,
        sleep: async () => undefined,
      }),
    );

    expect(seen).toHaveLength(1);
  });

  it("emits every poll when changesOnly is off", async () => {
    mockStatuses([statusBody("En Route"), statusBody("En Route"), statusBody("En Route")]);

    const seen = await collect(
      client().poll.flightStatus("BA123", {
        maxIterations: 3,
        changesOnly: false,
        sleep: async () => undefined,
      }),
    );

    expect(seen).toHaveLength(3);
  });

  it("yields the terminal status and then finishes, without waiting again", async () => {
    mockStatuses([statusBody("En Route"), statusBody("Landed 14:32")]);
    const { waits, sleep } = recordingSleep();

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 10, interval: 500, sleep }),
    );

    expect(seen.map((s) => s.status)).toEqual(["En Route", "Landed 14:32"]);
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it("keeps polling past a terminal status when untilTerminal is off", async () => {
    mockStatuses([statusBody("Landed"), statusBody("Landed 14:32")]);

    const seen = await collect(
      client().poll.flightStatus("BA123", {
        maxIterations: 2,
        untilTerminal: false,
        sleep: async () => undefined,
      }),
    );

    expect(seen.map((s) => s.status)).toEqual(["Landed", "Landed 14:32"]);
    expect(requests).toHaveLength(2);
  });

  it("stops after maxIterations even when nothing ever changes", async () => {
    mockStatuses([statusBody("En Route"), statusBody("En Route")]);

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(seen).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("survives a 429 in the middle and honours Retry-After", async () => {
    mockJson({ path: STATUS_PATH, body: statusBody("Scheduled") });
    mockError({
      path: STATUS_PATH,
      status: 429,
      headers: { "retry-after": "2" },
      body: { detail: "Rate limit exceeded" },
    });
    mockJson({ path: STATUS_PATH, body: statusBody("En Route") });
    const { waits, sleep } = recordingSleep();

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 3, interval: 1_000, sleep }),
    );

    expect(seen.map((s) => s.status)).toEqual(["Scheduled", "En Route"]);
    expect(requests).toHaveLength(3);
    // The interval after the first poll, then the server's own 2s hint.
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("falls back to the interval when a 429 carries no Retry-After", async () => {
    mockError({ path: STATUS_PATH, status: 429, body: { detail: "Rate limit exceeded" } });
    mockJson({ path: STATUS_PATH, body: statusBody("En Route") });
    const { waits, sleep } = recordingSleep();

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 2, interval: 750, sleep }),
    );

    expect(seen.map((s) => s.status)).toEqual(["En Route"]);
    expect(waits).toEqual([750]);
  });

  it("survives a 5xx and keeps the loop alive", async () => {
    mockError({ path: STATUS_PATH, status: 503, body: { detail: "Upstream unavailable" } });
    mockJson({ path: STATUS_PATH, body: statusBody("En Route") });

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(seen.map((s) => s.status)).toEqual(["En Route"]);
    expect(requests).toHaveLength(2);
  });

  it("gives up when every poll of the budget fails", async () => {
    mockError({ path: STATUS_PATH, status: 500, body: { detail: "boom" }, times: 2 });

    const seen = await collect(
      client().poll.flightStatus("BA123", { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(seen).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("propagates a 403 instead of retrying it forever", async () => {
    mockError({ path: STATUS_PATH, status: 403, body: { detail: "Plan does not include this" } });

    await expect(
      collect(client().poll.flightStatus("BA123", { sleep: async () => undefined })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(requests).toHaveLength(1);
  });

  it("propagates a 422 instead of retrying it forever", async () => {
    mockError({
      path: STATUS_PATH,
      status: 422,
      body: { detail: [{ loc: ["path", "flight_number"], msg: "invalid", type: "value_error" }] },
    });

    await expect(
      collect(client().poll.flightStatus("BA123", { sleep: async () => undefined })),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("ends quickly when the signal aborts mid-wait", async () => {
    mockJson({ path: STATUS_PATH, body: statusBody("En Route"), persist: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const started = Date.now();
    // No injected sleep: this exercises the real interruptible wait.
    const seen = await collect(
      client().poll.flightStatus("BA123", { interval: 30_000, signal: controller.signal }),
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("issues nothing at all for an already-aborted signal", async () => {
    const seen = await collect(
      client().poll.flightStatus("BA123", { signal: AbortSignal.abort() }),
    );

    expect(seen).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("stops requesting as soon as the consumer breaks out", async () => {
    mockJson({ path: STATUS_PATH, body: statusBody("En Route"), persist: true });

    const seen = await collect(
      client().poll.flightStatus("BA123", { sleep: async () => undefined }),
      1,
    );

    expect(seen).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("forwards per-call request options to the endpoint", async () => {
    mockJson({ path: STATUS_PATH, body: statusBody("En Route") });

    await collect(
      client().poll.flightStatus("BA123", {
        maxIterations: 1,
        headers: { "X-Trace": "poll" },
        sleep: async () => undefined,
      }),
    );

    expect(requests[0]?.headers["x-trace"]).toBe("poll");
  });

  it("defaults to a one-minute interval", async () => {
    mockStatuses([statusBody("En Route"), statusBody("Landed")]);
    const { waits, sleep } = recordingSleep();

    await collect(client().poll.flightStatus("BA123", { maxIterations: 2, sleep }));

    expect(waits).toEqual([DEFAULT_FLIGHT_STATUS_INTERVAL_MS]);
  });
});

describe("poll.adsb", () => {
  const alpha = state("4ca1fb", { altitude: 36000, latitude: 51.47, longitude: -0.45 });
  const bravo = state("a1b2c3", { altitude: 12000, latitude: 51.2, longitude: -0.3 });
  const charlie = state("c0ffee", { altitude: 5000, latitude: 50.9, longitude: -0.1 });

  it("reports the whole feed as appeared on the first iteration", async () => {
    mockJson({ path: /^\/v3\.1\/adsb\/aircraft\?/, body: feed([alpha, bravo]) });

    const [first] = await collect(
      client().poll.adsb(
        { bbox: [51, -1, 52, 0] },
        { maxIterations: 1, sleep: async () => undefined },
      ),
    );

    expect(first?.isFirst).toBe(true);
    expect(first?.appeared.map((a) => a.icao24)).toEqual(["4ca1fb", "a1b2c3"]);
    expect(first?.disappeared).toEqual([]);
    expect(first?.updated).toEqual([]);
    expect(Object.keys(first?.snapshot ?? {})).toEqual(["4ca1fb", "a1b2c3"]);
    expect(requests[0]?.query.get("bbox")).toBe("51,-1,52,0");
  });

  it("diffs appeared, disappeared and updated on later iterations", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha, bravo]) });
    mockJson({
      path: FEED_PATH,
      body: feed([{ ...alpha, altitude: 37000 }, charlie]),
    });

    const diffs: AdsbDiff[] = await collect(
      client().poll.adsb({}, { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(diffs).toHaveLength(2);
    const second = diffs[1];
    expect(second?.isFirst).toBe(false);
    expect(second?.appeared.map((a) => a.icao24)).toEqual(["c0ffee"]);
    expect(second?.disappeared).toEqual(["a1b2c3"]);
    expect(second?.updated.map((a) => a.icao24)).toEqual(["4ca1fb"]);
    expect(second?.updated[0]?.altitude).toBe(37000);
    expect(Object.keys(second?.snapshot ?? {})).toEqual(["4ca1fb", "c0ffee"]);
  });

  it("counts a moved position or a changed speed as updated", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha, bravo]) });
    mockJson({
      path: FEED_PATH,
      body: feed([
        { ...alpha, latitude: 51.5, longitude: -0.4 },
        { ...bravo, ground_speed: 300 },
      ]),
    });

    const diffs = await collect(
      client().poll.adsb({}, { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(diffs[1]?.updated.map((a) => a.icao24)).toEqual(["4ca1fb", "a1b2c3"]);
  });

  it("does not call a ticking last_seen an update", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha]) });
    mockJson({
      path: FEED_PATH,
      body: feed([{ ...alpha, last_seen: "2026-02-11T12:00:33.000000", track: 291.4 }]),
    });

    const diffs = await collect(
      client().poll.adsb({}, { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(diffs[1]?.updated).toEqual([]);
    expect(diffs[1]?.appeared).toEqual([]);
    expect(diffs[1]?.disappeared).toEqual([]);
    // The snapshot still carries the newest state, ticking timestamp and all.
    expect(diffs[1]?.snapshot["4ca1fb"]?.last_seen).toBe("2026-02-11T12:00:33.000000");
  });

  it("yields an empty diff for an unchanged feed", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha, bravo]), times: 2 });

    const diffs = await collect(
      client().poll.adsb({}, { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(diffs).toHaveLength(2);
    expect(diffs[1]).toMatchObject({ appeared: [], disappeared: [], updated: [], isFirst: false });
  });

  it("treats an empty feed as everything disappearing", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha]) });
    mockJson({ path: FEED_PATH, body: feed([]) });

    const diffs = await collect(
      client().poll.adsb({}, { maxIterations: 2, sleep: async () => undefined }),
    );

    expect(diffs[1]?.disappeared).toEqual(["4ca1fb"]);
    expect(diffs[1]?.snapshot).toEqual({});
  });

  it("survives a 429 and a 5xx between snapshots", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha]) });
    mockError({ path: FEED_PATH, status: 429, headers: { "retry-after": "1" } });
    mockError({ path: FEED_PATH, status: 502 });
    mockJson({ path: FEED_PATH, body: feed([alpha, charlie]) });
    const { waits, sleep } = recordingSleep();

    const diffs = await collect(client().poll.adsb({}, { maxIterations: 4, interval: 200, sleep }));

    expect(diffs).toHaveLength(2);
    expect(diffs[1]?.appeared.map((a) => a.icao24)).toEqual(["c0ffee"]);
    expect(waits).toEqual([200, 1_000, 200]);
  });

  it("propagates a 403", async () => {
    mockError({ path: FEED_PATH, status: 403, body: { detail: "Plan does not include ADS-B" } });

    await expect(
      collect(client().poll.adsb({}, { sleep: async () => undefined })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("propagates a non-status error unchanged", async () => {
    const sky = client();
    (sky.adsb as unknown as { aircraft: () => Promise<never> }).aircraft = () =>
      Promise.reject(new TypeError("bug in a caller-supplied fetch"));

    await expect(
      collect(sky.poll.adsb({}, { sleep: async () => undefined })),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("ends quickly when the signal aborts mid-wait", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha]), persist: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const started = Date.now();
    const diffs = await collect(
      client().poll.adsb({}, { interval: 30_000, signal: controller.signal }),
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(diffs).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("defaults to a ten-second interval", async () => {
    mockJson({ path: FEED_PATH, body: feed([alpha]), times: 2 });
    const { waits, sleep } = recordingSleep();

    await collect(client().poll.adsb({}, { maxIterations: 2, sleep }));

    expect(waits).toEqual([DEFAULT_ADSB_INTERVAL_MS]);
  });
});

describe("poll namespace wiring", () => {
  it("hangs off the client as a readonly namespace", () => {
    const sky = client();
    expect(typeof sky.poll.flightStatus).toBe("function");
    expect(typeof sky.poll.adsb).toBe("function");
    expect(sky.poll).toBe(sky.poll);
  });

  it("does not touch the network when maxIterations is 0", async () => {
    const seen = await collect(client().poll.adsb({}, { maxIterations: 0 }));
    expect(seen).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
