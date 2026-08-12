/**
 * Vitest configuration for the live integration suite.
 *
 * Deliberately a separate config from `vitest.config.ts`, which excludes
 * `tests/integration/**`: the two suites have incompatible needs. The unit suite
 * runs offline behind an undici `MockAgent` with `disableNetConnect()` and must
 * stay fast; this one talks to a real deployment over the real network.
 *
 * ```sh
 * SKYLINK_TEST_BASE_URL=http://localhost:8081/v3.1 npm run test:integration
 * SKYLINK_TEST_PROVIDER=rapidapi SKYLINK_TEST_API_KEY=... npm run test:integration
 * ```
 *
 * Without `SKYLINK_TEST_BASE_URL` — or `SKYLINK_TEST_PROVIDER=rapidapi` together
 * with `SKYLINK_TEST_API_KEY` — every test reports as skipped, so the command is
 * safe to wire into any pipeline.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The only difference that matters: this suite is the integration tests, and
    // nothing else.
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    globals: false,
    // Live endpoints scrape third parties; the SDK's own 30 s deadline plus up to
    // three retries can legitimately outlast Vitest's 5 s default.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One file, one connection pool, no thundering herd against a staging box.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
