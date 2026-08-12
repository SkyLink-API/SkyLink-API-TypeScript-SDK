/**
 * Types shared by more than one resource namespace.
 *
 * Domain-specific shapes live in `src/models/<namespace>.ts`; only genuinely
 * cross-cutting aliases belong here.
 */

import type { BBox } from "../core/types.js";

export type { BBox } from "../core/types.js";

/**
 * A bounding box as accepted by every `bbox` parameter.
 *
 * Either the `[lat1, lon1, lat2, lon2]` tuple (south-west corner first) or the
 * pre-joined wire string `"lat1,lon1,lat2,lon2"`. Both serialize identically.
 */
export type BBoxInput = BBox | string;
