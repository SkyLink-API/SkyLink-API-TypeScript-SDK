/**
 * Webhook subscription models — the only mutating corner of the API.
 *
 * Field names mirror the wire format exactly (`snake_case`); only method names are
 * camelCase. Every type here is compile-time only — the SDK never validates or
 * reshapes a response body.
 */

/**
 * Flight-status event a subscription can fire on.
 *
 * - `status_changed` — catch-all: any tracked field changed
 * - `flight_delayed` — status indicates a delay, or the actual departure time moved
 * - `flight_cancelled` — the flight was cancelled
 * - `flight_boarding` — boarding is in progress
 * - `flight_landed` — the flight has landed / arrived
 * - `gate_changed` — the departure or arrival gate changed
 */
export type WebhookEventType =
  | "status_changed"
  | "flight_delayed"
  | "flight_cancelled"
  | "flight_boarding"
  | "flight_landed"
  | "gate_changed";

/** Delivery filter narrowing which flight a subscription watches. */
export interface WebhookFilters {
  /**
   * IATA flight number to monitor, e.g. `"BA117"`.
   *
   * Documented as optional by the schema but required in practice — the API answers
   * 422 when it is missing or blank.
   */
  flight_number: string;
}

/**
 * A webhook subscription as returned by `webhooks.create()`.
 *
 * The list endpoint returns a strict superset of this shape; see
 * {@link WebhookSubscription}.
 */
export interface Webhook {
  /** Subscription UUID; pass it to `update()` / `delete()`. */
  id: string;
  /** Destination URL. HTTPS only, and never a private address (SSRF-checked server side). */
  url: string;
  event_types: WebhookEventType[];
  filters: WebhookFilters;
  /** `false` after the subscription was disabled, manually or by delivery failures. */
  active: boolean;
  /** ISO 8601 */
  created_at: string;
}

/**
 * A webhook subscription as returned by `webhooks.list()`: everything
 * {@link Webhook} carries plus the delivery bookkeeping the create response omits.
 */
export interface WebhookSubscription extends Webhook {
  /** ISO 8601 time of the last delivery attempt; `null` when it never fired. */
  last_triggered_at: string | null;
  /** Consecutive delivery failures. The API disables the subscription at 10. */
  failure_count: number;
}

/** Raw envelope of `GET /webhooks`; `webhooks.list()` unwraps it to the array. */
export interface WebhookListResponse {
  count: number;
  webhooks: WebhookSubscription[];
}

/** Raw envelope of `GET /webhooks/events`; `webhooks.eventTypes()` unwraps it. */
export interface WebhookEventTypesResponse {
  event_types: WebhookEventType[];
}

/** Response of `webhooks.update()` — the API echoes only the toggled state. */
export interface WebhookToggleResult {
  id: string;
  active: boolean;
}

/** Body of `webhooks.create()`. */
export interface WebhookCreateParams {
  /** HTTPS destination URL. Private and loopback hosts are rejected with 422. */
  url: string;
  /** At least one event type; an empty array is rejected with 422. */
  event_types: WebhookEventType[];
  /** Defaults to `{}` server side, which then fails validation — pass a flight number. */
  filters?: WebhookFilters;
}

/** Body of `webhooks.update()`. */
export interface WebhookUpdateParams {
  /** `false` pauses deliveries without deleting the subscription. */
  active: boolean;
}
