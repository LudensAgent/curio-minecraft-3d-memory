/**
 * Historical geometry — path fragments (design §3.1).
 *
 * Current blockage never deletes a fragment; it only splits the currently
 * passable segments and disconnects the affected navigation edges.
 */

import type { JsonObject } from '../json-value.js';
import type { MoveMode, Vec3Like } from '../types.js';

export { jsonEscapedByteLength } from '../bytes.js';

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
  /** Host identity for the same geometry (e.g. legacy passage id), opaque to the library. */
  externalRef?: string;
  /** Opaque host metadata; never interpreted by the library. */
  metadata?: JsonObject;
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
  /**
   * Movement mode the caller knows was used for this traversal. Absent = unknown;
   * it is never defaulted to `walk`, inferred from `source`/`type`, or guessed from
   * coordinate deltas. It participates in idempotency and conflict comparison, but
   * adds no execution capability or authorization.
   */
  mode?: MoveMode;
}

export const MOVE_MODES: readonly MoveMode[] = ['walk', 'jump', 'sneak', 'swim', 'climb', 'ladder', 'drop'];

/** Whether a `MoveMode` string is one of the known modes (kept internal — consumers validate via the store). */
function isMoveMode(value: unknown): value is MoveMode {
  return typeof value === 'string' && (MOVE_MODES as readonly string[]).includes(value);
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Deep-copy a `TraversalEvidence`, reading every field explicitly so a
 * prototype-getter-provided input is honored (object spread skips getters).
 * The result owns plain data objects; mutating it never reaches the source.
 */
export function cloneTraversalEvidence(e: TraversalEvidence): TraversalEvidence {
  return {
    id: e.id,
    fragmentId: e.fragmentId,
    from: { x: e.from.x, y: e.from.y, z: e.from.z },
    to: { x: e.to.x, y: e.to.y, z: e.to.z },
    worldId: e.worldId,
    dim: e.dim,
    sessionId: e.sessionId,
    observedAt: e.observedAt,
    source: e.source,
    executionId: e.executionId,
    actionId: e.actionId,
    mode: e.mode,
  };
}

/**
 * Field-for-field equality over every declared `TraversalEvidence` field:
 * identity, fragment, scope, endpoints, session, time, source, execution/action
 * association, and the optional `mode`. Used for idempotency/conflict detection
 * and, in the topology layer, for deciding whether a still-present record still
 * matches the evidence an edge was bound to.
 */
export function traversalEvidenceEqual(a: TraversalEvidence, b: TraversalEvidence): boolean {
  return (
    a.id === b.id &&
    a.fragmentId === b.fragmentId &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    a.sessionId === b.sessionId &&
    a.observedAt === b.observedAt &&
    a.source === b.source &&
    a.executionId === b.executionId &&
    a.actionId === b.actionId &&
    a.mode === b.mode &&
    pointsEqual(a.from, b.from) &&
    pointsEqual(a.to, b.to)
  );
}

/** Validate that an optional `mode`, when present, is a known movement mode. */
export function assertValidMode(mode: MoveMode | undefined): void {
  if (mode !== undefined && !isMoveMode(mode)) {
    throw new Error(`mode "${String(mode)}" is not a known movement mode`);
  }
}
