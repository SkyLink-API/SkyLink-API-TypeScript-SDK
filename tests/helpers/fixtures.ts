/**
 * Loader for the JSON fixtures in `tests/fixtures/`, which are captured verbatim
 * from the backend routers' OpenAPI examples (see `tests/fixtures/SOURCES.md`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = new URL("../fixtures/", import.meta.url);

/**
 * Read and parse a fixture by name, with or without the `.json` suffix.
 *
 * ```ts
 * const metar = loadFixture<WeatherReport>("weather_metar");
 * ```
 */
export function loadFixture<T = unknown>(name: string): T {
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  const path = fileURLToPath(new URL(fileName, FIXTURES_DIR));
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (cause) {
    throw new Error(
      `Could not load fixture "${fileName}" from tests/fixtures/: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}
