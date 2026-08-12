/**
 * Live webhook CRUD against a real deployment — the one mutating corner of the API.
 *
 * `live.test.ts` already runs a create → list → toggle → delete cycle as part of its
 * one-call-per-namespace sweep. This file exists for what that sweep cannot cover:
 *
 * - **`ensure()`**, whose three branches are the reason the method exists at all, and
 *   whose "recreate" branch depends on a backend fact (`PATCH` accepts nothing but
 *   `active`) that no unit test can confirm;
 * - **the plan cap**, which is enforced server side from a header the SDK never sends
 *   and cannot see, so its value is discoverable only by walking into it.
 *
 * Note there is no `GET /webhooks/{id}`: a single subscription is read back through
 * `list()`, which is what `ensure()` does internally too.
 *
 * **Gating.** Webhooks are plan-gated (BASIC → `403`), and the only key with the
 * entitlement is a direct-channel one, so the suite arms on `direct` + a key, or on an
 * explicit `baseUrl` (a `DISABLE_AUTH` staging box). On RapidAPI it reports as skipped
 * rather than failing on a `403` that is correct behaviour.
 *
 * ```sh
 * SKYLINK_TEST_PROVIDER=direct SKYLINK_TEST_API_KEY=... npm run test:integration
 * ```
 *
 * **Cleanup.** Every subscription this file creates carries {@link MARKER} in its URL,
 * and `afterEach` deletes every marked subscription the key owns, whatever the test
 * did or how it failed. The URLs point at `example.com`, which is not ours and never
 * answers, so the dispatcher's delivery attempts go nowhere by design — a subscription
 * left behind would still be litter, hence the sweep.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import {
  APIStatusError,
  AuthenticationError,
  type ClientOptions,
  type FetchLike,
  PermissionDeniedError,
  type Provider,
  ServiceUnavailableError,
  SkyLink,
  type WebhookEventType,
  type WebhookSubscription,
} from "../../src/index.js";

/** Endpoint under test, e.g. `http://localhost:8081/v3.1`. Empty → provider default. */
const BASE_URL = (process.env.SKYLINK_TEST_BASE_URL ?? "").trim();

/** Optional key. Empty → the client falls back to its own environment variables. */
const API_KEY = (process.env.SKYLINK_TEST_API_KEY ?? "").trim();

/** Channel to exercise: `rapidapi` (the SDK default) or `direct`. */
const PROVIDER: Provider =
  (process.env.SKYLINK_TEST_PROVIDER ?? "").trim() === "direct" ? "direct" : "rapidapi";

/** Only a direct key carries the webhook entitlement; a staging box needs no key. */
const ARMED = (Boolean(API_KEY) && PROVIDER === "direct") || Boolean(BASE_URL);

/** Every URL this file registers contains it, and the sweep deletes on it. */
const MARKER = "skylink-sdk-test";

/** A flight number to filter on. Never contacted — nothing here waits for a delivery. */
const FLIGHT = "BA117";

/**
 * Ceiling on the plan-cap probe.
 *
 * The documented caps top out at 10 (MEGA), and an unmetered deployment answers the
 * `WEBHOOK_MAX_PER_KEY` default, also 10. Twelve therefore finds the cap on any known
 * configuration while keeping a runaway loop impossible.
 */
const MAX_PROBE = 12;

/** Outcomes that mean "this key's plan has no webhooks", not "the SDK is broken". */
const PLAN_ERRORS: readonly (typeof APIStatusError)[] = [
  AuthenticationError,
  PermissionDeniedError,
  ServiceUnavailableError,
];

/** One request as it left the process — enough to count writes. */
interface Call {
  method: string;
  path: string;
}

const calls: Call[] = [];

/** Records method and path, then performs the request for real. */
const recordingFetch: FetchLike = (input, init) => {
  calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: new URL(input).pathname });
  return globalThis.fetch(input, init);
};

/** Writes issued since the last {@link resetCalls} — `ensure()`'s whole contract. */
function writes(): Call[] {
  return calls.filter((call) => call.method !== "GET");
}

function resetCalls(): void {
  calls.length = 0;
}

/** A destination that is syntactically valid, publicly resolvable, and inert. */
function testUrl(suffix: string): string {
  return `https://example.com/${MARKER}-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
}

function describeError(error: unknown): string {
  if (error instanceof APIStatusError) {
    const body = error.body;
    const detail =
      body !== null && typeof body === "object" && "detail" in body
        ? (body as { detail: unknown }).detail
        : body;
    return `HTTP ${error.status}: ${typeof detail === "string" && detail ? detail : error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function report(title: string, lines: readonly string[]): void {
  const body = lines.length > 0 ? lines.map((line) => `    ${line}`).join("\n") : "    (nothing)";
  console.info(`\n  [live-webhooks] ${title}\n${body}`);
}

describe.skipIf(!ARMED)("live webhooks", () => {
  let sky: SkyLink;
  /** Set when the probe below says this key cannot use webhooks; skips every test. */
  let unavailable: string | null = null;

  beforeAll(async () => {
    const options: ClientOptions = { provider: PROVIDER, fetch: recordingFetch };
    if (BASE_URL) options.baseUrl = BASE_URL;
    if (API_KEY) options.apiKey = API_KEY;
    sky = new SkyLink(options);

    // One probe decides the whole file: a key whose plan has no webhooks answers 403
    // here, and every test below would otherwise fail identically for that one reason.
    // Recorded rather than thrown — a plan without the entitlement is a skip.
    try {
      await sky.webhooks.list();
    } catch (error) {
      if (!PLAN_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) throw error;
      unavailable = `webhooks are not available to this key — ${describeError(error)}`;
    }
  });

  beforeEach((ctx: TestContext) => {
    if (unavailable !== null) ctx.skip(unavailable);
  });

  /** Delete every subscription this file could have created. Never throws. */
  async function sweep(): Promise<number> {
    let removed = 0;
    let existing: WebhookSubscription[];
    try {
      existing = await sky.webhooks.list();
    } catch (error) {
      console.warn(
        `  [live-webhooks] cleanup could not list subscriptions: ${describeError(error)}`,
      );
      return 0;
    }
    for (const hook of existing) {
      if (!hook.url.includes(MARKER)) continue;
      try {
        await sky.webhooks.delete(hook.id);
        removed += 1;
      } catch (error) {
        // A 404 means someone (the test itself) already deleted it — not a problem.
        console.warn(
          `  [live-webhooks] cleanup could not delete ${hook.id}: ${describeError(error)}`,
        );
      }
    }
    return removed;
  }

  afterEach(async () => {
    if (unavailable === null) await sweep();
    resetCalls();
  });

  afterAll(async () => {
    // Belt and braces: `afterEach` already ran, but a failure inside it would
    // otherwise leave the account holding subscriptions.
    if (sky !== undefined && unavailable === null) {
      const removed = await sweep();
      if (removed > 0) report("final sweep", [`deleted ${removed} leftover subscription(s)`]);
    }
  });

  // ── 1. the event catalogue ─────────────────────────────────────────────────

  it("webhooks.eventTypes lists exactly the six events the SDK types", async () => {
    const events = await sky.webhooks.eventTypes();

    report("eventTypes", [events.join(", ")]);

    // The server sorts them, and the SDK's `WebhookEventType` union must be the same
    // set — a seventh event added server side should show up as a failure here, not as
    // a silently untypeable string in someone's config.
    expect([...events].sort()).toEqual([
      "flight_boarding",
      "flight_cancelled",
      "flight_delayed",
      "flight_landed",
      "gate_changed",
      "status_changed",
    ]);
  });

  // ── 2. the plain cycle ─────────────────────────────────────────────────────

  it("create → list → update → delete, with the documented status codes", async () => {
    const url = testUrl("crud");
    const created = await sky.webhooks.create({
      url,
      event_types: ["status_changed", "gate_changed"],
      filters: { flight_number: FLIGHT },
    });

    report("create", [
      `id: ${created.id}`,
      `url: ${created.url}`,
      `event_types: ${created.event_types.join(", ")}`,
      `filters: ${JSON.stringify(created.filters)}`,
      `active: ${created.active}, created_at: ${created.created_at}`,
    ]);

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.url).toBe(url);
    expect(created.active).toBe(true);
    expect([...created.event_types].sort()).toEqual(["gate_changed", "status_changed"]);
    // The service upper-cases and trims the flight number before storing it.
    expect(created.filters.flight_number).toBe(FLIGHT);
    expect(typeof created.created_at).toBe("string");
    // The create response is the narrow shape: the delivery bookkeeping is list-only.
    expect(created).not.toHaveProperty("failure_count");
    expect(created).not.toHaveProperty("last_triggered_at");

    // Read back through `list()` — the API has no per-id GET.
    const listed = (await sky.webhooks.list()).find((hook) => hook.id === created.id);
    expect(listed).toBeDefined();
    expect(listed?.url).toBe(url);
    // The wider shape the list endpoint adds, on a subscription that never fired.
    expect(listed?.failure_count).toBe(0);
    expect(listed?.last_triggered_at).toBeNull();
    expect(listed?.event_types).toEqual(created.event_types);

    // PATCH echoes only the toggled state, not the subscription.
    const toggled = await sky.webhooks.update(created.id, { active: false });
    expect(toggled).toEqual({ id: created.id, active: false });

    const afterToggle = (await sky.webhooks.list()).find((hook) => hook.id === created.id);
    expect(afterToggle?.active).toBe(false);
    // …and nothing else moved.
    expect(afterToggle?.url).toBe(url);
    expect(afterToggle?.event_types).toEqual(created.event_types);

    // 204 No Content: the SDK resolves to void rather than choking on an empty body.
    await expect(sky.webhooks.delete(created.id)).resolves.toBeUndefined();

    expect((await sky.webhooks.list()).map((hook) => hook.id)).not.toContain(created.id);

    // Deleting it twice is a 404, which is how "already gone" is reported.
    await expect(sky.webhooks.delete(created.id)).rejects.toMatchObject({ status: 404 });
  });

  // ── 3. ensure(): the create branch ─────────────────────────────────────────

  it("ensure creates the subscription when nothing matches the URL", async () => {
    const url = testUrl("ensure-create");
    resetCalls();

    const hook = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: FLIGHT },
    });

    expect(hook.url).toBe(url);
    expect(hook.active).toBe(true);
    expect(hook.event_types).toEqual(["status_changed"]);
    // Exactly one write: the POST. (The GET that looks for a match is not a write.)
    expect(writes().map((call) => call.method)).toEqual(["POST"]);
    expect((await sky.webhooks.list()).map((item) => item.id)).toContain(hook.id);
  });

  // ── 4. ensure(): the no-op branch ──────────────────────────────────────────

  it("ensure is idempotent — a second identical call issues no write at all", async () => {
    const url = testUrl("ensure-noop");
    const events: WebhookEventType[] = ["status_changed", "gate_changed"];
    const first = await sky.webhooks.ensure(url, events, { filters: { flight_number: FLIGHT } });

    resetCalls();
    // Same set, different order, and the flight number in the other case: neither may
    // count as a difference, or every re-deploy would churn the subscription.
    const second = await sky.webhooks.ensure(url, ["gate_changed", "status_changed"], {
      filters: { flight_number: FLIGHT.toLowerCase() },
    });

    report("ensure (no-op)", [
      `id before: ${first.id}`,
      `id after:  ${second.id}`,
      `writes: ${writes().length}`,
    ]);

    expect(second.id).toBe(first.id);
    expect(writes()).toEqual([]);
    // And the account holds one subscription for this URL, not two.
    expect((await sky.webhooks.list()).filter((hook) => hook.url === url)).toHaveLength(1);
  });

  // ── 5. ensure(): the active-only branch ────────────────────────────────────

  it("ensure patches when only `active` differs", async () => {
    const url = testUrl("ensure-toggle");
    const first = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: FLIGHT },
    });

    resetCalls();
    const paused = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: FLIGHT },
      active: false,
    });

    // Same subscription, one PATCH, no re-creation: the id survives, which is the
    // whole difference between this branch and the next one.
    expect(paused.id).toBe(first.id);
    expect(paused.active).toBe(false);
    expect(writes().map((call) => call.method)).toEqual(["PATCH"]);

    const stored = (await sky.webhooks.list()).find((hook) => hook.id === first.id);
    expect(stored?.active).toBe(false);
  });

  // ── 6. ensure(): the recreate branch ───────────────────────────────────────

  it("ensure recreates when event_types change, because PATCH cannot edit them", async () => {
    const url = testUrl("ensure-events");
    const first = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: FLIGHT },
    });

    resetCalls();
    const second = await sky.webhooks.ensure(url, ["status_changed", "flight_landed"], {
      filters: { flight_number: FLIGHT },
    });

    report("ensure (event_types changed)", [
      `id before: ${first.id} events: ${first.event_types.join(", ")}`,
      `id after:  ${second.id} events: ${second.event_types.join(", ")}`,
      `writes: ${writes()
        .map((call) => call.method)
        .join(" → ")}`,
    ]);

    // DELETE then POST, in that order — reversing them would trip the plan cap.
    expect(writes().map((call) => call.method)).toEqual(["DELETE", "POST"]);
    // A new subscription, and the documented consequence: a new id.
    expect(second.id).not.toBe(first.id);
    expect([...second.event_types].sort()).toEqual(["flight_landed", "status_changed"]);

    const listed = await sky.webhooks.list();
    expect(listed.map((hook) => hook.id)).toContain(second.id);
    expect(listed.map((hook) => hook.id)).not.toContain(first.id);
    // One subscription for the URL, not two — the point of the DELETE.
    expect(listed.filter((hook) => hook.url === url)).toHaveLength(1);
  });

  it("ensure recreates when the filter changes", async () => {
    const url = testUrl("ensure-filters");
    const first = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: FLIGHT },
    });

    resetCalls();
    const second = await sky.webhooks.ensure(url, ["status_changed"], {
      filters: { flight_number: "LH400" },
    });

    expect(writes().map((call) => call.method)).toEqual(["DELETE", "POST"]);
    expect(second.id).not.toBe(first.id);
    expect(second.filters.flight_number).toBe("LH400");
    expect((await sky.webhooks.list()).filter((hook) => hook.url === url)).toHaveLength(1);
  });

  // ── 7. the plan cap ────────────────────────────────────────────────────────

  it("the plan cap is enforced server side and reported as a status error", async (ctx) => {
    const created: string[] = [];
    let rejection: unknown = null;

    try {
      for (let index = 0; index < MAX_PROBE; index++) {
        try {
          const hook = await sky.webhooks.create({
            url: testUrl(`cap-${index}`),
            event_types: ["status_changed"],
            filters: { flight_number: FLIGHT },
          });
          created.push(hook.id);
        } catch (error) {
          rejection = error;
          break;
        }
      }

      report("plan cap", [
        `subscriptions created before rejection: ${created.length}`,
        `rejection: ${rejection === null ? "(none within the probe ceiling)" : describeError(rejection)}`,
        `error class: ${rejection instanceof Error ? rejection.constructor.name : "—"}`,
      ]);

      if (rejection === null) {
        // An unmetered deployment (staging, or a plan above the probe ceiling) has no
        // cap to walk into; nothing to assert, and the sweep still runs.
        ctx.skip(`no cap reached within ${MAX_PROBE} subscriptions`);
        return;
      }

      // What the cap costs a caller is that the *next* create fails — as a typed
      // status error carrying the server's explanation, never as a transport failure
      // or a silent success.
      expect(rejection).toBeInstanceOf(APIStatusError);
      const status = (rejection as APIStatusError).status;
      // 422 when the store enforces the count, 403 when the plan has no entitlement
      // at all; both are documented, anything else is news.
      expect([403, 422]).toContain(status);
      expect(created.length).toBeGreaterThanOrEqual(1);

      // …and the failed create really did not create anything: the account holds
      // exactly the subscriptions that succeeded.
      const marked = (await sky.webhooks.list()).filter((hook) => hook.url.includes(MARKER));
      expect(marked).toHaveLength(created.length);

      // Freeing one slot makes room again — the cap is a live count, not a high-water
      // mark, which is what makes `ensure()`'s DELETE + POST safe at the limit.
      const victim = created.pop();
      if (victim !== undefined) {
        await sky.webhooks.delete(victim);
        const replacement = await sky.webhooks.create({
          url: testUrl("cap-refill"),
          event_types: ["status_changed"],
          filters: { flight_number: FLIGHT },
        });
        created.push(replacement.id);
      }
    } finally {
      // The sweep in `afterEach` covers this too; doing it here as well keeps the
      // account clean even if the listing there fails.
      for (const id of created) {
        await sky.webhooks.delete(id).catch(() => undefined);
      }
    }
  });
});
