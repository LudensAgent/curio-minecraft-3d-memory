/**
 * Historical geometry — path fragments (design §3.1).
 *
 * Current blockage never deletes a fragment; it only splits the currently
 * passable segments and disconnects the affected navigation edges.
 */

import type { Vec3Like } from '../types.js';

export interface PathFragment {
  id: string;
  worldId: string;
  dim: string;
  kind: 'dug' | 'walked' | 'bridge' | 'built';
  /** Surface reference points; not guaranteed to be the actual opening. */
  entrances: Vec3Like[];
  /** Foot-geometry polyline; source is separated from walked evidence. */
  polyline: Vec3Like[];
  geometrySource: 'traversal' | 'observed_structure' | 'legacy';
  /** Actually-walked cell pairs — historical connectivity evidence, not a current guarantee. */
  links?: { a: Vec3Like; b: Vec3Like }[];
  deepestY: number;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
}

/**
 * Confirmed traversal evidence — an actually-walked, continuous passage between
 * two positions, submitted explicitly by the caller (design §3.1, phase 4A).
 *
 * This is a *separate* record from `PathFragment` geometry:
 * - saving a fragment never proves a traversal happened;
 * - a traversal record never proves the route is currently passable.
 *
 * A record is directional (`from` → `to`): confirming A→B never implies B→A,
 * and two distinct real traversals that happen to share coordinates are kept as
 * separate records — identity is the caller-supplied `id`, not the coordinates.
 *
 * Attribution (`executionId` / `actionId`) is optional and only records what the
 * caller already knows; it is never inferred, and its absence is "unknown", not a
 * license to back-fill a current execution or action.
 */
export interface TraversalEvidence {
  /** Stable identity; re-delivering the same id is idempotent, a different id is a distinct traversal. */
  id: string;
  /** Fragment this traversal belongs to. */
  fragmentId: string;
  /** Confirmed continuous passage from → to. */
  from: Vec3Like;
  to: Vec3Like;
  worldId: string;
  dim: string;
  /** Session the traversal actually happened in; null = unknown (never fabricated). */
  sessionId: string | null;
  /** Original acquisition time; null = unknown (never `Date.now()`, receive order, or `0`). */
  observedAt: number | null;
  /** Caller-supplied provenance label (e.g. `"confirmed_walk"`); opaque to the library. */
  source: string;
  /**
   * Execution identity that actually performed this traversal (matches the
   * execution layer's `executionId`). Absent = unknown — never inferred or
   * back-filled from a current execution.
   */
  executionId?: string;
  /**
   * Host action id for a confirmed own-action effect (matches `Observation.actionId`).
   * Absent = unknown — never inferred from temporal proximity.
   */
  actionId?: string;
}
