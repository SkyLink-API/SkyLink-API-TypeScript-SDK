/**
 * Preflight briefings in all three shapes: structured JSON, rendered markdown, and
 * a PDF written to disk.
 *
 * `briefing.flight()` is overloaded on `format`: omitting it (or passing `"json"`)
 * resolves to a `FlightBriefing` object, any text format resolves to a `string`.
 *
 * In your own project the import is `from "skylink-api"`; inside this repository it
 * points at the sources so the examples type-check with the rest of the tree.
 */

import { writeFileSync } from "node:fs";
import { APIStatusError, RateLimitError, SkyLink } from "../src/index.js";

const sky = new SkyLink({ apiKey: process.env.SKYLINK_API_KEY });

const ORIGIN = "KJFK";
const DESTINATION = "EGLL";

async function main(): Promise<void> {
  // --- Structured briefing (format omitted → FlightBriefing) -------------------
  const briefing = await sky.briefing.flight({
    origin: ORIGIN,
    destination: DESTINATION,
    include_weather: true,
    include_notams: true,
    include_pireps: true,
  });

  console.log(`${briefing.origin} → ${briefing.destination}`);
  console.log(briefing.summary);
  console.log(`data included: ${briefing.data_included.join(", ")}`);

  if (briefing.critical_restrictions.length > 0) {
    console.log("\ncritical restrictions:");
    for (const restriction of briefing.critical_restrictions) {
      console.log(
        `  [${restriction.icao}] ${restriction.description}` +
          (restriction.notam_id ? ` (NOTAM ${restriction.notam_id})` : ""),
      );
    }
  }

  // `notams` / `pireps` are null — not [] — when that source was excluded.
  const originSection = briefing.origin_briefing;
  console.log(
    `\n${originSection.icao}: ` +
      `${originSection.notams?.length ?? "no"} NOTAM section, ` +
      `${originSection.pireps?.length ?? "no"} PIREP section, ` +
      `weather ${originSection.weather ? "included" : "excluded"}`,
  );

  // --- Same call, markdown (format: text → string) -----------------------------
  // The API wraps text formats in an envelope; the SDK unwraps it and hands back
  // the document itself. `"plain_text"` and `"html"` behave the same way.
  const markdown = await sky.briefing.flight({
    origin: ORIGIN,
    destination: DESTINATION,
    format: "markdown",
  });

  console.log("\n--- markdown ---");
  console.log(markdown.split("\n").slice(0, 12).join("\n"));
  console.log(`... (${markdown.length} characters total)`);

  // --- PDF --------------------------------------------------------------------
  // The only binary endpoint: the body is buffered and resolves to `Uint8Array`,
  // which `fs.writeFileSync` accepts as-is. Origin and destination must differ.
  const pdf = await sky.briefing.pdf({
    departure_icao: ORIGIN,
    arrival_icao: DESTINATION,
    flight_number: "BA178",
  });

  const path = `briefing-${ORIGIN}-${DESTINATION}.pdf`;
  writeFileSync(path, pdf);
  const magic = new TextDecoder().decode(pdf.subarray(0, 5));
  console.log(`\nwrote ${path} — ${pdf.byteLength} bytes, magic "${magic}"`);
}

main().catch((error: unknown) => {
  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Retry in ${error.retryAfter ?? "?"} ms; ` +
        `${error.rateLimit?.remaining ?? "?"} of ${error.rateLimit?.limit ?? "?"} requests left.`,
    );
  } else if (error instanceof APIStatusError) {
    // Briefings are the slowest endpoint in the API; a 400 here usually means every
    // data source was excluded, and a 422 means both airports were the same.
    console.error(`SkyLink API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// --- Run: SKYLINK_API_KEY=... npx tsx examples/flight-briefing.ts ---
