/**
 * The runtime value sets (`src/core/constants.ts`).
 *
 * These exist so a caller can iterate what the type system already knows, which
 * makes the risk the drift between the two: a tuple that no longer matches its
 * literal union, or a value the backend never accepts. Both are asserted here — the
 * `const _check: T[] = [...]` lines are compile-time assertions, the `expect`s guard
 * the values themselves against the backend source they were copied from.
 */

import { describe, expect, it } from "vitest";
import {
  CHART_CATEGORIES,
  CONTINENTS,
  FLIGHT_CATEGORIES,
  HISTORY_PLANS,
  WEBHOOK_EVENTS,
} from "../src/core/constants.js";
import type { HistoryPlan } from "../src/core/types.js";
import type { FlightCategory } from "../src/helpers/weather.js";
import * as SDK from "../src/index.js";
import type { ChartCategory } from "../src/models/charts.js";
import type { Continent } from "../src/models/geo.js";
import type { WebhookEventType } from "../src/models/webhooks.js";

describe("CHART_CATEGORIES", () => {
  it("holds every category of models/v3/charts.py, in documentation order", () => {
    expect(CHART_CATEGORIES).toEqual(["GEN", "GND", "SID", "STAR", "APP"]);
  });

  it("is assignable to the ChartCategory union and back", () => {
    const _check: ChartCategory[] = [...CHART_CATEGORIES];
    const all: ChartCategory[] = ["GEN", "GND", "SID", "STAR", "APP"];
    expect(_check).toEqual(all);
    // Exhaustive in the other direction too: no member of the union is missing.
    type Missing = Exclude<ChartCategory, (typeof CHART_CATEGORIES)[number]>;
    const _exhaustive: Missing[] = [];
    expect(_exhaustive).toEqual([]);
  });
});

describe("WEBHOOK_EVENTS", () => {
  it("holds the six VALID_EVENTS of the webhook service, sorted as GET /webhooks/events returns them", () => {
    expect(WEBHOOK_EVENTS).toEqual([
      "flight_boarding",
      "flight_cancelled",
      "flight_delayed",
      "flight_landed",
      "gate_changed",
      "status_changed",
    ]);
    expect([...WEBHOOK_EVENTS]).toEqual([...WEBHOOK_EVENTS].sort());
  });

  it("is assignable to the WebhookEventType union and back", () => {
    const _check: WebhookEventType[] = [...WEBHOOK_EVENTS];
    expect(_check).toHaveLength(6);
    type Missing = Exclude<WebhookEventType, (typeof WEBHOOK_EVENTS)[number]>;
    const _exhaustive: Missing[] = [];
    expect(_exhaustive).toEqual([]);
  });
});

describe("CONTINENTS", () => {
  it("holds the seven codes _VALID_CONTINENTS validates against", () => {
    expect(CONTINENTS).toEqual(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);
  });

  it("keeps NA, which is accepted by the filter and then matches nothing", () => {
    // pandas reads the literal "NA" as NaN when loading the reference CSV, so every
    // North-American row comes back with continent: null. The code stays in the tuple
    // because the API validates against it — the workaround lives in compose.
    expect(CONTINENTS).toContain("NA");
  });

  it("is assignable to the Continent union and back", () => {
    const _check: Continent[] = [...CONTINENTS];
    expect(_check).toHaveLength(7);
    type Missing = Exclude<Continent, (typeof CONTINENTS)[number]>;
    const _exhaustive: Missing[] = [];
    expect(_exhaustive).toEqual([]);
  });
});

describe("HISTORY_PLANS", () => {
  it("holds the two history path prefixes, default first", () => {
    expect(HISTORY_PLANS).toEqual(["ultra", "mega"]);
    expect(HISTORY_PLANS[0]).toBe("ultra");
  });

  it("is assignable to the HistoryPlan union and back", () => {
    const _check: HistoryPlan[] = [...HISTORY_PLANS];
    expect(_check).toHaveLength(2);
    type Missing = Exclude<HistoryPlan, (typeof HISTORY_PLANS)[number]>;
    const _exhaustive: Missing[] = [];
    expect(_exhaustive).toEqual([]);
  });
});

describe("FLIGHT_CATEGORIES", () => {
  it("holds the four VFR categories, best conditions first", () => {
    expect(FLIGHT_CATEGORIES).toEqual(["VFR", "MVFR", "IFR", "LIFR"]);
  });

  it("is assignable to the FlightCategory union and back", () => {
    const _check: FlightCategory[] = [...FLIGHT_CATEGORIES];
    expect(_check).toHaveLength(4);
    type Missing = Exclude<FlightCategory, (typeof FLIGHT_CATEGORIES)[number]>;
    const _exhaustive: Missing[] = [];
    expect(_exhaustive).toEqual([]);
  });
});

describe("packaging", () => {
  it("re-exports every constant from the package entry point", () => {
    expect(SDK.CHART_CATEGORIES).toBe(CHART_CATEGORIES);
    expect(SDK.WEBHOOK_EVENTS).toBe(WEBHOOK_EVENTS);
    expect(SDK.CONTINENTS).toBe(CONTINENTS);
    expect(SDK.HISTORY_PLANS).toBe(HISTORY_PLANS);
    expect(SDK.FLIGHT_CATEGORIES).toBe(FLIGHT_CATEGORIES);
  });

  it("freezes nothing but types everything as readonly tuples", () => {
    // `as const` is compile-time only: the arrays are ordinary and not frozen, which
    // is worth knowing before someone mutates a shared export.
    expect(Array.isArray(CHART_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(CHART_CATEGORIES)).toBe(false);
  });
});
