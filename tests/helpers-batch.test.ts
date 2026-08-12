/**
 * The concurrency primitive and the batch-result readers (`src/helpers/batch.ts`).
 *
 * Pure functions: no client, no network, no mocks. What matters here is that the
 * pool never exceeds its limit, that one rejection does not cancel the rest of the
 * work, and that the result stays index-aligned with the input.
 */

import { describe, expect, it } from "vitest";
import { APIConnectionError, NotFoundError, SkyLinkError } from "../src/core/errors.js";
import {
  type BatchResult,
  DEFAULT_CONCURRENCY,
  failures,
  isBatchError,
  mapConcurrent,
  successes,
  throwForErrors,
} from "../src/helpers/batch.js";

/** Resolve after a macrotask, so the pool has to interleave. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapConcurrent", () => {
  it("maps every item, index-aligned with the input", async () => {
    const results = await mapConcurrent([1, 2, 3, 4], async (n, i) => `${i}:${n * 2}`);
    expect(results).toEqual(["0:2", "1:4", "2:6", "3:8"]);
  });

  it("accepts a synchronous fn and any iterable", async () => {
    const results = await mapConcurrent(new Set(["a", "b"]), (s) => s.toUpperCase());
    expect(results).toEqual(["A", "B"]);
  });

  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0;
    const results = await mapConcurrent([], () => {
      calls += 1;
      return 1;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("never runs more than `concurrency` calls at once", async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapConcurrent(
      items,
      async (n) => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(1);
        running -= 1;
        return n;
      },
      { concurrency: 3 },
    );

    expect(peak).toBe(3);
  });

  it("defaults to five in flight", async () => {
    let running = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(1);
        running -= 1;
      },
    );
    expect(peak).toBe(DEFAULT_CONCURRENCY);
    expect(DEFAULT_CONCURRENCY).toBe(5);
  });

  it("spawns no more workers than there are items", async () => {
    let peak = 0;
    let running = 0;
    await mapConcurrent(
      [1, 2],
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(1);
        running -= 1;
      },
      { concurrency: 50 },
    );
    expect(peak).toBe(2);
  });

  it("collects rejections in place instead of cancelling the run", async () => {
    const seen: number[] = [];
    const results = await mapConcurrent(
      [1, 2, 3],
      async (n) => {
        seen.push(n);
        if (n === 2) throw new NotFoundError("gone");
        return n * 10;
      },
      { concurrency: 1 },
    );

    expect(seen).toEqual([1, 2, 3]);
    expect(results[0]).toBe(10);
    expect(results[1]).toBeInstanceOf(NotFoundError);
    expect(results[2]).toBe(30);
  });

  it("catches a synchronous throw too", async () => {
    const results = await mapConcurrent([1], () => {
      throw new SkyLinkError("sync boom");
    });
    expect(results[0]).toBeInstanceOf(SkyLinkError);
  });

  it("wraps a thrown non-Error value so every failure slot is an Error", async () => {
    const results = await mapConcurrent([1], async () => {
      throw "just a string";
    });
    const failure = results[0];
    expect(failure).toBeInstanceOf(SkyLinkError);
    expect((failure as SkyLinkError).message).toContain("just a string");
    expect((failure as { cause?: unknown }).cause).toBe("just a string");
  });

  it("rejects a concurrency below one, and any non-integer", async () => {
    await expect(mapConcurrent([1], async (n) => n, { concurrency: 0 })).rejects.toBeInstanceOf(
      SkyLinkError,
    );
    await expect(mapConcurrent([1], async (n) => n, { concurrency: -2 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(mapConcurrent([1], async (n) => n, { concurrency: 1.5 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      mapConcurrent([1], async (n) => n, { concurrency: Number.NaN }),
    ).rejects.toBeInstanceOf(SkyLinkError);
  });

  it("does not start items once the signal is aborted", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    const results = await mapConcurrent(
      [1, 2, 3, 4],
      async (n) => {
        started.push(n);
        if (n === 1) controller.abort(new Error("stop"));
        await tick(1);
        return n;
      },
      { concurrency: 1, signal: controller.signal },
    );

    expect(started).toEqual([1]);
    expect(results[0]).toBe(1);
    for (const index of [1, 2, 3]) {
      expect(results[index]).toBeInstanceOf(APIConnectionError);
    }
    expect((results[1] as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("aborts every item when the signal is already aborted", async () => {
    const results = await mapConcurrent([1, 2], async (n) => n, {
      signal: AbortSignal.abort("nope"),
    });
    expect(results.every((r) => r instanceof APIConnectionError)).toBe(true);
  });
});

describe("batch result readers", () => {
  const notFound = new NotFoundError("no METAR for ZZZZ");
  const results: BatchResult<{ raw: string }> = {
    KJFK: { raw: "KJFK 121751Z" },
    ZZZZ: notFound,
    EGLL: { raw: "EGLL 121750Z" },
  };

  it("isBatchError narrows to the error branch", () => {
    const value = results.ZZZZ;
    if (isBatchError(value)) {
      // Narrowed: `.message` would not compile on the response branch.
      expect(value.message).toBe("no METAR for ZZZZ");
    } else {
      throw new Error("expected the error branch");
    }
    expect(isBatchError(results.KJFK)).toBe(false);
    expect(isBatchError(undefined)).toBe(false);
    expect(isBatchError(new Error("plain"))).toBe(false);
  });

  it("splits successes and failures, keeping the requested keys", () => {
    expect(Object.keys(successes(results))).toEqual(["KJFK", "EGLL"]);
    expect(successes(results).KJFK?.raw).toBe("KJFK 121751Z");
    expect(Object.keys(failures(results))).toEqual(["ZZZZ"]);
    expect(failures(results).ZZZZ).toBe(notFound);
  });

  it("throwForErrors throws the first failure in key order", () => {
    expect(() => throwForErrors(results)).toThrow(notFound);
  });

  it("throwForErrors returns the narrowed map when nothing failed", () => {
    const clean: BatchResult<{ raw: string }> = { KJFK: { raw: "x" } };
    const values: Record<string, { raw: string }> = throwForErrors(clean);
    expect(values.KJFK?.raw).toBe("x");
  });

  it("handles an empty result", () => {
    expect(successes({})).toEqual({});
    expect(failures({})).toEqual({});
    expect(throwForErrors({})).toEqual({});
  });
});
