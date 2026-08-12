/**
 * `sky.webhooks` — push subscriptions for flight-status events.
 *
 * The only namespace that mutates state, and therefore the only one that issues
 * anything other than `GET`.
 *
 * ```ts
 * const hook = await sky.webhooks.create({
 *   url: "https://hooks.example.com/skylink",
 *   event_types: ["flight_delayed", "gate_changed"],
 *   filters: { flight_number: "BA117" },
 * });
 * await sky.webhooks.update(hook.id, { active: false });
 * await sky.webhooks.delete(hook.id);
 * ```
 */

import type { RequestOptions } from "../core/types.js";
import type {
  Webhook,
  WebhookCreateParams,
  WebhookEventType,
  WebhookEventTypesResponse,
  WebhookFilters,
  WebhookListResponse,
  WebhookSubscription,
  WebhookToggleResult,
  WebhookUpdateParams,
} from "../models/webhooks.js";
import { APIResource, encodePathParam } from "./base.js";

/** Options of {@link Webhooks.ensure}, on top of the usual per-call request overrides. */
export interface WebhookEnsureOptions extends RequestOptions {
  /** Desired enabled state. Defaults to `true`. */
  active?: boolean;
  /**
   * Desired delivery filter. Required whenever the subscription might have to be
   * created — the API rejects a create without `flight_number` — and compared
   * case-insensitively against an existing subscription when given.
   */
  filters?: WebhookFilters;
}

/** Same event types, order ignored. */
function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const event of left) if (!right.has(event)) return false;
  return true;
}

/** Same flight number, compared the way the API stores it (trimmed, upper-cased). */
function sameFilters(current: WebhookFilters, desired: WebhookFilters | undefined): boolean {
  if (desired === undefined) return true;
  return (
    (current.flight_number ?? "").trim().toUpperCase() ===
    desired.flight_number.trim().toUpperCase()
  );
}

/** Webhook subscription CRUD. */
export class Webhooks extends APIResource {
  /**
   * Create a subscription. Answers `201` on success.
   *
   * The response omits `last_triggered_at` and `failure_count`, which only the list
   * endpoint carries — a fresh subscription has never fired.
   *
   * How many subscriptions a key may hold is decided by its plan (BASIC 0 → `403`,
   * PRO 1, ULTRA 3, MEGA 10); exceeding the cap answers `422`.
   *
   * `POST /webhooks`
   */
  create(params: WebhookCreateParams, options?: RequestOptions): Promise<Webhook> {
    return this.request<Webhook>(
      {
        method: "POST",
        path: "/webhooks",
        body: {
          url: params.url,
          event_types: params.event_types,
          filters: params.filters ?? {},
        },
      },
      options,
    );
  }

  /**
   * Every subscription owned by the current API key.
   *
   * The endpoint answers a `{ count, webhooks }` envelope; the count is just
   * `webhooks.length`, so this resolves to the array directly.
   *
   * `GET /webhooks`
   */
  async list(options?: RequestOptions): Promise<WebhookSubscription[]> {
    const body = await this.get<WebhookListResponse>("/webhooks", undefined, options);
    return body.webhooks;
  }

  /**
   * Enable or disable a subscription without deleting it.
   *
   * The API echoes only `{ id, active }`, not the full subscription.
   *
   * `PATCH /webhooks/{id}`
   *
   * @param id - Subscription UUID from {@link create} or {@link list}.
   */
  update(
    id: string,
    params: WebhookUpdateParams,
    options?: RequestOptions,
  ): Promise<WebhookToggleResult> {
    return this.request<WebhookToggleResult>(
      {
        method: "PATCH",
        path: `/webhooks/${encodePathParam(id, "webhook id")}`,
        body: { active: params.active },
      },
      options,
    );
  }

  /**
   * Delete a subscription permanently.
   *
   * Answers `204` with no body, so there is nothing to resolve to. Deleting a
   * subscription owned by another key answers `404`.
   *
   * `DELETE /webhooks/{id}`
   *
   * @param id - Subscription UUID from {@link create} or {@link list}.
   */
  delete(id: string, options?: RequestOptions): Promise<void> {
    return this.request<void>(
      {
        method: "DELETE",
        path: `/webhooks/${encodePathParam(id, "webhook id")}`,
        responseKind: "none",
      },
      options,
    );
  }

  /**
   * Create the subscription for `url`, or bring the existing one in line with the
   * arguments. Idempotent: calling it twice with the same arguments issues one write.
   *
   * The trap this exists for: plan limits count **active** subscriptions (PRO allows
   * exactly one), so re-running a deploy script that blindly `create()`s fails with a
   * `422` "webhook limit reached" — and the API has no upsert. This lists the
   * subscriptions, matches on the exact `url`, and then does the smallest write:
   *
   * - no match → `POST` (plus a `PATCH` when `active: false` was asked for, since a
   *   fresh subscription is always created enabled);
   * - match, everything equal → **no write at all**, the subscription is returned as it is;
   * - match, only `active` differs → `PATCH`;
   * - match, `event_types` or `filters` differ → `DELETE` + `POST`. The only field
   *   `PATCH /webhooks/{id}` accepts is `active`, so the events of a subscription
   *   cannot be changed in place. **Re-creating gives it a new `id`** and resets
   *   `failure_count` / `last_triggered_at`.
   *
   * Event types are compared as a set, so their order does not trigger a rewrite, and
   * `filters` is compared trimmed and upper-cased, the form the API stores.
   *
   * ```ts
   * const hook = await sky.webhooks.ensure(
   *   "https://hooks.example.com/skylink",
   *   ["flight_delayed", "gate_changed"],
   *   { filters: { flight_number: "BA117" } },
   * );
   * ```
   *
   * @param url Destination URL, matched verbatim — a trailing slash makes it a
   * different subscription.
   * @param eventTypes At least one event type; an empty array is rejected with `422`.
   */
  async ensure(
    url: string,
    eventTypes: WebhookEventType[],
    options: WebhookEnsureOptions = {},
  ): Promise<Webhook> {
    const { active = true, filters, ...requestOptions } = options;
    const existing = (await this.list(requestOptions)).find((hook) => hook.url === url);

    if (existing !== undefined) {
      const settingsMatch =
        sameEvents(existing.event_types, eventTypes) && sameFilters(existing.filters, filters);
      if (settingsMatch && existing.active === active) return existing;
      if (settingsMatch) {
        await this.update(existing.id, { active }, requestOptions);
        return { ...existing, active };
      }
      // event_types / filters are immutable server-side: replace the subscription.
      await this.delete(existing.id, requestOptions);
    }

    const params: WebhookCreateParams = { url, event_types: eventTypes };
    if (filters !== undefined) params.filters = filters;
    const created = await this.create(params, requestOptions);
    if (active) return created;
    await this.update(created.id, { active: false }, requestOptions);
    return { ...created, active: false };
  }

  /**
   * Event types a subscription may listen for, as advertised by the server.
   *
   * The endpoint answers an `{ event_types }` envelope; this resolves to the array.
   * The same set is available at compile time as {@link WebhookEventType}.
   *
   * `GET /webhooks/events`
   */
  async eventTypes(options?: RequestOptions): Promise<WebhookEventType[]> {
    const body = await this.get<WebhookEventTypesResponse>("/webhooks/events", undefined, options);
    return body.event_types;
  }
}
