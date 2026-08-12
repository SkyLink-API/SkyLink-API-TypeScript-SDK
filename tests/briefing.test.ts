import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkyLink } from "../src/client.js";
import type { ClientOptions } from "../src/core/config.js";
import { BadRequestError, UnprocessableEntityError } from "../src/core/errors.js";
import type { FlightBriefing, FlightBriefingText } from "../src/models/briefing.js";
import { Briefing } from "../src/resources/briefing.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  DIRECT_ORIGIN,
  mockBytes,
  mockError,
  mockJson,
  requests,
  setupMockAgent,
  teardownMockAgent,
} from "./helpers/mock.js";

const flightFixture = loadFixture<FlightBriefing>("briefing_flight");
const textFixture = loadFixture<FlightBriefingText>("briefing_text");

function briefing(options: ClientOptions = {}): Briefing {
  return new Briefing(
    new SkyLink({ apiKey: "test-key", sleep: async () => undefined, ...options }),
  );
}

beforeEach(() => {
  setupMockAgent();
});

afterEach(async () => {
  await teardownMockAgent();
});

describe("briefing.flight", () => {
  it("returns the structured briefing and sends only the supplied parameters", async () => {
    mockJson({ path: /^\/v3\.1\/briefing\/flight\?/, body: flightFixture });

    const result: FlightBriefing = await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
    });

    expect(result.origin).toBe("KJFK");
    expect(result.destination).toBe("EGLL");
    expect(result.summary).toContain("VFR conditions at KJFK");
    expect(result.critical_restrictions).toEqual([]);
    expect(result.data_included).toEqual(["metar", "taf", "notams"]);
    expect(result.disclaimer).toContain("AI-generated");

    const request = requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.origin).toBe(DIRECT_ORIGIN);
    expect(request?.path).toBe("/v3.1/briefing/flight");
    expect(request?.fullPath).toBe("/v3.1/briefing/flight?origin=KJFK&destination=EGLL");
    expect(request?.query.has("include_weather")).toBe(false);
    expect(request?.query.has("format")).toBe(false);
  });

  it("keeps notams/pireps nullable — null means the source was excluded, [] means nothing to report", async () => {
    mockJson({ path: /^\/v3\.1\/briefing\/flight\?/, body: flightFixture });

    const result = await briefing().flight({ origin: "KJFK", destination: "EGLL" });

    // pireps: null — include_pireps defaults to false, so the source was never consulted.
    expect(result.origin_briefing.pireps).toBeNull();
    expect(result.destination_briefing.pireps).toBeNull();

    // notams: [] at the destination — consulted, nothing active.
    expect(result.destination_briefing.notams).toEqual([]);
    expect(result.origin_briefing.notams).toHaveLength(1);
    expect(result.origin_briefing.notams?.[0]?.notam_id).toBe("01/234");
    expect(result.origin_briefing.notams?.[0]?.affected).toBe("TWY B");

    expect(result.origin_briefing.weather?.metar_raw).toContain("KJFK 151856Z");
    expect(result.destination_briefing.weather?.taf_raw).toContain("TAF EGLL");
  });

  it("serializes the boolean source toggles", async () => {
    mockJson({ path: /^\/v3\.1\/briefing\/flight\?/, body: flightFixture });

    await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
      include_weather: true,
      include_notams: false,
      include_pireps: true,
    });

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/briefing/flight?origin=KJFK&destination=EGLL&include_weather=true&include_notams=false&include_pireps=true",
    );
    expect(requests[0]?.query.get("include_notams")).toBe("false");
  });

  it("sends format=json explicitly when asked and still returns the structure", async () => {
    mockJson({ path: /^\/v3\.1\/briefing\/flight\?/, body: flightFixture });

    const result: FlightBriefing = await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
      format: "json",
    });

    expect(result.summary).toBe(flightFixture.summary);
    expect(requests[0]?.query.get("format")).toBe("json");
  });

  it("unwraps the envelope to a plain string for the text formats", async () => {
    mockJson({ path: /^\/v3\.1\/briefing\/flight\?/, body: textFixture });

    const markdown: string = await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
      format: "markdown",
    });

    expect(typeof markdown).toBe("string");
    expect(markdown).toBe(textFixture.briefing);
    expect(markdown).toContain("<h2>Summary</h2>");
    expect(requests[0]?.fullPath).toBe(
      "/v3.1/briefing/flight?origin=KJFK&destination=EGLL&format=markdown",
    );
  });

  it("unwraps plain_text and html the same way", async () => {
    mockJson({
      path: /^\/v3\.1\/briefing\/flight\?/,
      body: { ...textFixture, format: "plain_text", briefing: "SUMMARY\nVFR at KJFK." },
    });
    const plain: string = await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
      format: "plain_text",
    });
    expect(plain).toBe("SUMMARY\nVFR at KJFK.");

    mockJson({
      path: /^\/v3\.1\/briefing\/flight\?/,
      body: { ...textFixture, format: "html", briefing: "<p>VFR at KJFK.</p>" },
    });
    const html: string = await briefing().flight({
      origin: "KJFK",
      destination: "EGLL",
      format: "html",
    });
    expect(html).toBe("<p>VFR at KJFK.</p>");
    expect(requests[1]?.query.get("format")).toBe("html");
  });

  it("maps a 400 (no data source selected) to BadRequestError", async () => {
    mockError({
      path: /^\/v3\.1\/briefing\/flight\?/,
      status: 400,
      body: { detail: "At least one data source (weather, NOTAMs, or PIREPs) must be included" },
    });

    await expect(
      briefing().flight({
        origin: "KJFK",
        destination: "EGLL",
        include_weather: false,
        include_notams: false,
        include_pireps: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("briefing.pdf", () => {
  // Smallest thing that still looks like a PDF to a magic-byte sniffer.
  const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

  it("returns raw bytes starting with the %PDF magic number", async () => {
    mockBytes({ path: /^\/v3\.1\/briefing\/pdf\?/, body: pdfBytes });

    const pdf: Uint8Array = await briefing().pdf({
      departure_icao: "EGLL",
      arrival_icao: "KJFK",
      flight_number: "BA117",
    });

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.byteLength).toBe(pdfBytes.byteLength);
    expect(Array.from(pdf.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(Buffer.from(pdf).toString("latin1").startsWith("%PDF")).toBe(true);

    expect(requests[0]?.fullPath).toBe(
      "/v3.1/briefing/pdf?departure_icao=EGLL&arrival_icao=KJFK&flight_number=BA117",
    );
    expect(requests[0]?.headers.accept).toContain("application/pdf");
  });

  it("omits the optional flight number", async () => {
    mockBytes({ path: /^\/v3\.1\/briefing\/pdf\?/, body: pdfBytes });

    await briefing().pdf({ departure_icao: "EGLL", arrival_icao: "KJFK" });

    expect(requests[0]?.fullPath).toBe("/v3.1/briefing/pdf?departure_icao=EGLL&arrival_icao=KJFK");
    expect(requests[0]?.query.has("flight_number")).toBe(false);
  });

  it("maps a 422 (identical airports) to UnprocessableEntityError", async () => {
    mockError({
      path: /^\/v3\.1\/briefing\/pdf\?/,
      status: 422,
      body: { detail: "Departure and arrival airports must be different" },
    });

    await expect(
      briefing().pdf({ departure_icao: "EGLL", arrival_icao: "EGLL" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });
});

describe("briefing namespace behaviour", () => {
  it("exposes both methods", () => {
    const ns = briefing();
    expect(typeof ns.flight).toBe("function");
    expect(typeof ns.pdf).toBe("function");
  });

  it("routes through the RapidAPI channel without the version prefix", async () => {
    mockJson({
      origin: "https://skylink-api.p.rapidapi.com",
      path: /^\/briefing\/flight\?/,
      body: flightFixture,
    });

    await briefing({ provider: "rapidapi", apiKey: "rapid-key" }).flight({
      origin: "KJFK",
      destination: "EGLL",
    });

    expect(requests[0]?.origin).toBe("https://skylink-api.p.rapidapi.com");
    expect(requests[0]?.path).toBe("/briefing/flight");
    expect(requests[0]?.headers["x-rapidapi-key"]).toBe("rapid-key");
  });
});
