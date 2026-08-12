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
  WebhookListResponse,
  WebhookSubscription,
  WebhookToggleResult,
  WebhookUpdateParams,
} from "../models/webhooks.js";
import { APIResource, encodePathParam } from "./base.js";

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
