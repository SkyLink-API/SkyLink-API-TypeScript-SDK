/**
 * Models produced by the polling namespace (`sky.poll`).
 *
 * Unlike the rest of `src/models`, these are **not** wire shapes: nothing here comes
 * back from the API. They are computed client-side by comparing two consecutive
 * responses, so their fields are camelCase like the rest of the SDK's own vocabulary.
 */

import type { AdsbAircraft } from "./adsb.js";

/**
 * What changed in the live ADS-B feed between two polls.
 *
 * Aircraft are matched by `icao24`, the only identifier every state carries — a
 * callsign is absent until the aircraft transmits one, and changes mid-flight.
 *
 * The first iteration is a baseline rather than a diff: `isFirst` is `true`, the whole
 * feed is reported as {@link AdsbDiff.appeared}, and both other lists are empty. An
 * unchanged feed still yields a diff, with three empty lists and the current snapshot.
 */
export interface AdsbDiff {
  /** Aircraft present now that were absent in the previous snapshot. */
  appeared: AdsbAircraft[];
  /**
   * `icao24` addresses that were present in the previous snapshot and are gone now.
   *
   * Addresses, not states: the aircraft is no longer in the feed, so the SDK has
   * nothing newer than the state the caller already saw.
   */
  disappeared: string[];
  /**
   * Aircraft present in both snapshots whose **position, altitude or ground speed**
   * changed — carrying the new state.
   *
   * Deliberately narrower than "the object is not deep-equal": `last_seen` advances
   * with every received message, so a deep comparison would report the entire feed as
   * updated on every poll and make the list useless for redrawing a map.
   */
  updated: AdsbAircraft[];
  /** The full current feed keyed by `icao24` — the baseline the next diff is taken against. */
  snapshot: Record<string, AdsbAircraft>;
  /** Whether this is the first iteration, where everything is reported as `appeared`. */
  isFirst: boolean;
}
