/**
 * The full webhook lifecycle: discover the event types, create a subscription,
 * list it, disable it, delete it.
 *
 * Webhooks are the only mutating namespace in the API. How many subscriptions a key
 * may hold depends on its plan (BASIC 0 → 403, PRO 1, ULTRA 3, MEGA 10); exceeding
 * the cap answers 422.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import {
  APIStatusError,
  PermissionDeniedError,
  RateLimitError,
  SkyLink,
  UnprocessableEntityError,
} from "../src/index.js";

// No provider given → the default RapidAPI channel, keyed by RAPIDAPI_KEY.
const sky = new SkyLink();

const TARGET_URL = process.env.WEBHOOK_URL ?? "https://hooks.example.com/skylink";

async function main(): Promise<void> {
  // --- What can be subscribed to ----------------------------------------------
  // The endpoint answers an `{ event_types }` envelope; the SDK unwraps it. The
  // same set exists at compile time as the `WebhookEventType` union.
  const eventTypes = await sky.webhooks.eventTypes();
  console.log(`server advertises ${eventTypes.length} event type(s): ${eventTypes.join(", ")}`);

  // --- Create (201) ------------------------------------------------------------
  const created = await sky.webhooks.create({
    url: TARGET_URL,
    event_types: ["flight_delayed", "gate_changed", "flight_landed"],
    filters: { flight_number: "BA117" },
  });
  console.log(
    `\ncreated ${created.id}\n` +
      `  url:     ${created.url}\n` +
      `  events:  ${created.event_types.join(", ")}\n` +
      `  filter:  flight ${created.filters.flight_number}\n` +
      `  active:  ${created.active}\n` +
      `  created: ${created.created_at}`,
  );

  // Everything below runs against a live subscription, so make sure it is removed
  // even if a step in between fails.
  try {
    // --- List --------------------------------------------------------------------
    // The list response carries two fields `create` does not: delivery health.
    const subscriptions = await sky.webhooks.list();
    console.log(`\n${subscriptions.length} subscription(s) on this key:`);
    for (const sub of subscriptions) {
      console.log(
        `  ${sub.id}  ${sub.active ? "active " : "paused "}  ${sub.url}\n` +
          `    events: ${sub.event_types.join(", ")}\n` +
          `    last triggered: ${sub.last_triggered_at ?? "never"}, ` +
          `failures: ${sub.failure_count}`,
      );
    }

    // --- Update ------------------------------------------------------------------
    // The only mutable field is `active`; the API echoes just `{ id, active }`,
    // not the whole subscription.
    const paused = await sky.webhooks.update(created.id, { active: false });
    console.log(`\npaused ${paused.id} → active: ${paused.active}`);

    const resumed = await sky.webhooks.update(created.id, { active: true });
    console.log(`resumed ${resumed.id} → active: ${resumed.active}`);
  } finally {
    // --- Delete (204 → void) -----------------------------------------------------
    await sky.webhooks.delete(created.id);
    console.log(`\ndeleted ${created.id}`);
  }

  const remaining = await sky.webhooks.list();
  console.log(`${remaining.length} subscription(s) left`);
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof PermissionDeniedError) {
    console.error(`Your plan does not include webhooks: ${error.message}`);
  } else if (error instanceof UnprocessableEntityError) {
    // Field-level details from the 422 body, when the API sent the list form.
    console.error(`Rejected: ${error.message}`);
    for (const item of error.errors) {
      console.error(`  ${item.loc.join(".")}: ${item.msg} (${item.type})`);
    }
  } else if (error instanceof APIStatusError) {
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: RAPIDAPI_KEY=... WEBHOOK_URL=https://... npx tsx examples/webhooks.ts ---
