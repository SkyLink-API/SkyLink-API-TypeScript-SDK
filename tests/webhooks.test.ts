import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { NotFoundError, PermissionDeniedError, SkyLinkError } from "../src/core/errors.js";
import type {
  Webhook,
  WebhookEventType,
  WebhookListResponse,
  WebhookSubscription,
} from "../src/models/webhooks.js";
import { Webhooks } from "../src/resources/webhooks.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  DIRECT_PREFIX,
  mockEmpty,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const createdFixture = loadFixture<Webhook>("webhook_created");
const listFixture = loadFixture<WebhookListResponse>("webhooks_list");

const WEBHOOK_ID = "0a4f9c2e-7b31-4d85-9f60-31c8a2b7e410";

function webhooks(options: ClientOptions = {}): Webhooks {
  return new Webhooks(
    new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("webhooks.create", () => {
  it("POSTs a JSON body and returns the 201 subscription", async () => {
    mockJson({
      method: "POST",
      path: `${DIRECT_PREFIX}/webhooks`,
      status: 201,
      body: createdFixture,
    });

    const hook: Webhook = await webhooks().create({
      url: "https://hooks.example.com/skylink",
      event_types: ["status_changed", "flight_delayed"],
      filters: { flight_number: "BA117" },
    });

    expect(hook.id).toBe(WEBHOOK_ID);
    expect(hook.url).toBe("https://hooks.example.com/skylink");
    expect(hook.event_types).toEqual(["status_changed", "flight_delayed"]);
    expect(hook.filters.flight_number).toBe("BA117");
    expect(hook.active).toBe(true);
    expect(hook.created_at).toBe("2026-02-11T12:00:00+00:00");

    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.fullPath).toBe("/v3.1/webhooks");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "null")).toEqual({
      url: "https://hooks.example.com/skylink",
      event_types: ["status_changed", "flight_delayed"],
      filters: { flight_number: "BA117" },
    });
  });

  it("defaults filters to an empty object when omitted", async () => {
    mockJson({
      method: "POST",
      path: `${DIRECT_PREFIX}/webhooks`,
      status: 201,
      body: createdFixture,
    });

    await webhooks().create({
      url: "https://hooks.example.com/skylink",
      event_types: ["flight_landed"],
    });

    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual({
      url: "https://hooks.example.com/skylink",
      event_types: ["flight_landed"],
      filters: {},
    });
  });

  it("maps a 403 (plan without webhook support) to PermissionDeniedError", async () => {
    mockError({
      method: "POST",
      path: `${DIRECT_PREFIX}/webhooks`,
      status: 403,
      body: {
        detail: "Webhook subscriptions require PRO, ULTRA, or MEGA plan (current plan: BASIC).",
      },
    });

    await expect(
      webhooks().create({
        url: "https://hooks.example.com/skylink",
        event_types: ["flight_landed"],
        filters: { flight_number: "BA117" },
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("webhooks.list", () => {
  it("unwraps the {count, webhooks} envelope to the array", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/webhooks`, body: listFixture });

    const hooks: WebhookSubscription[] = await webhooks().list();

    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]?.id).toBe(WEBHOOK_ID);

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.fullPath).toBe("/v3.1/webhooks");
    expect(requests[0]?.body).toBeNull();
  });

  it("carries the three delivery fields the create response omits", async () => {
    mockJson({ path: `${DIRECT_PREFIX}/webhooks`, body: listFixture });

    const hooks = await webhooks().list();

    // Superset of the create shape: same six fields …
    expect(hooks[0]?.url).toBe(createdFixture.url);
    expect(hooks[0]?.filters.flight_number).toBe("BA117");
    // … plus the delivery bookkeeping.
    expect(hooks[0]?.last_triggered_at).toBe("2026-02-11T13:05:22+00:00");
    expect(hooks[0]?.failure_count).toBe(0);
    expect(hooks[1]?.last_triggered_at).toBeNull();
    expect(hooks[1]?.failure_count).toBe(10);
    expect(hooks[1]?.active).toBe(false);
  });
});

describe("webhooks.update", () => {
  it("PATCHes {active} and returns the echoed pair", async () => {
    mockJson({
      method: "PATCH",
      path: `${DIRECT_PREFIX}/webhooks/${WEBHOOK_ID}`,
      body: { id: WEBHOOK_ID, active: false },
    });

    const result = await webhooks().update(WEBHOOK_ID, { active: false });

    expect(result).toEqual({ id: WEBHOOK_ID, active: false });

    const request = requests[0];
    expect(request?.method).toBe("PATCH");
    expect(request?.fullPath).toBe(`/v3.1/webhooks/${WEBHOOK_ID}`);
    expect(JSON.parse(request?.body ?? "null")).toEqual({ active: false });
  });

  it("maps a 404 (unknown or foreign subscription) to NotFoundError", async () => {
    mockError({
      method: "PATCH",
      path: `${DIRECT_PREFIX}/webhooks/${WEBHOOK_ID}`,
      status: 404,
      body: { detail: "Webhook not found or not owned by you" },
    });

    await expect(webhooks().update(WEBHOOK_ID, { active: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("webhooks.delete", () => {
  it("resolves to undefined on a 204 with no body", async () => {
    mockEmpty({ method: "DELETE", path: `${DIRECT_PREFIX}/webhooks/${WEBHOOK_ID}`, status: 204 });

    // Typed as Promise<void>: a 204 carries no body to resolve to.
    const pending: Promise<void> = webhooks().delete(WEBHOOK_ID);
    const result = await pending;

    expect(result).toBeUndefined();
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.fullPath).toBe(`/v3.1/webhooks/${WEBHOOK_ID}`);
    expect(requests[0]?.body).toBeNull();
  });

  it("percent-encodes the id and rejects an empty one", async () => {
    mockEmpty({ method: "DELETE", path: `${DIRECT_PREFIX}/webhooks/a%2Fb`, status: 204 });

    await webhooks().delete("a/b");
    expect(requests[0]?.path).toBe("/v3.1/webhooks/a%2Fb");

    expect(() => webhooks().delete("   ")).toThrow(SkyLinkError);
    expect(() => webhooks().delete("")).toThrow(/webhook id/);
  });
});

describe("webhooks.eventTypes", () => {
  it("unwraps the {event_types} envelope and covers all six values", async () => {
    const all: WebhookEventType[] = [
      "flight_boarding",
      "flight_cancelled",
      "flight_delayed",
      "flight_landed",
      "gate_changed",
      "status_changed",
    ];
    mockJson({ path: `${DIRECT_PREFIX}/webhooks/events`, body: { event_types: all } });

    const types: WebhookEventType[] = await webhooks().eventTypes();

    expect(types).toEqual(all);
    expect(types).toHaveLength(6);
    expect(requests[0]?.fullPath).toBe("/v3.1/webhooks/events");
  });
});

describe("webhooks namespace behaviour", () => {
  it("exposes the full CRUD surface", () => {
    const ns = webhooks();
    expect(typeof ns.create).toBe("function");
    expect(typeof ns.list).toBe("function");
    expect(typeof ns.update).toBe("function");
    expect(typeof ns.delete).toBe("function");
    expect(typeof ns.eventTypes).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      method: "POST",
      path: "/webhooks",
      status: 201,
      body: createdFixture,
    });

    await webhooks({ provider: "rapidapi", apiKey: "rapid-key" }).create({
      url: "https://hooks.example.com/skylink",
      event_types: ["gate_changed"],
      filters: { flight_number: "LH400" },
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/webhooks");
    expect(requests[0]?.headers["x-rapidapi-host"]).toBe("skylink-api.p.rapidapi.com");
  });
});
