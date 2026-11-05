/**
 * Explicit historical-route execution seam (`follow_known_path` first step).
 *
 * `startKnownWalkRoute` selects one caller-named historical fragment and starts
 * it on an existing `WalkRouteExecutor`. It is deliberately *only* a start
 * boundary:
 *
 * - The fragment's stored polyline is the route — taken in its original order,
 *   without rounding, reversing, interpolating, or dropping duplicate points.
 * - History is geometry, not current passability. A STARTED delegation still
 *   verifies every segment against current evidence inside the executor; the
 *   fragment's `kind` and `geometrySource` never become traversal evidence or a
 *   movement mode.
 * - The caller keeps driving the SAME executor (`onSample`, `observe`,
 *   `advance`, `checkTimeout`, `cancel`). This function neither owns an async
 *   control loop nor registers host cancellation.
 *
 * Rejections that this boundary can prove from the request and the stored
 * geometry happen BEFORE `executor.start`, so an existing delegation is left
 * untouched. Malformed numeric/body/clock values that only the execution
 * boundary can judge still surface as the executor's own exceptions; this
 * function does not promise to convert them.
 */

import type { WalkRouteExecutor } from '../execution/walk-route-executor.js';
import type { WalkRouteRequest, WalkRouteStatus } from '../execution/types.js';
import type { FragmentStore } from '../topology/fragment-store.js';
import type { PathFragment } from '../topology/path-fragment.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type { ArrivalSpec } from './types.js';

/**
 * Default pre-start point budget, matching the walk executor's existing default.
 * It is a default, not a capability ceiling: callers may request any safe
 * integer ≥ 2, while the executor's own `maxRouteLength` still applies.
 */
const DEFAULT_MAX_ROUTE_POINTS = 1024;

/** Matches the route verifier's tolerance for classifying a delta as exactly one cell. */
const UNIT_EPS = 1e-9;

/**
 * Structured rejection categories. They are the pre-start boundary's verdict,
 * not a world fact: `unsupported_geometry` says the stored polyline is outside
 * the walk executor's one-cell contract, and `wrong_scope` says the request and
 * the selected fragment cannot be combined — neither claims a block is blocked.
 */
export type KnownWalkRouteRejectionReason =
  /** Neither `pathId` nor the `fragmentId` alias was supplied. */
  | 'missing_path_id'
  /** `pathId` and `fragmentId` were both supplied with different values. */
  | 'ambiguous_path'
  /** No fragment with the requested id exists in this history store. */
  | 'missing_history'
  /** Request worldId differs from the history worldId, or the fragment's dimension differs from the request. */
  | 'wrong_scope'
  /** The stored polyline is not a sequence of same-height, one-cell X/Z steps. */
  | 'unsupported_geometry'
  /** Only `walk` historical routes can start on the walk executor. */
  | 'unsupported_mode'
  /** Only exact foot-position arrival is supported this round. */
  | 'unsupported_arrival'
  /** The walk evaluator does not consume `avoid`; a non-empty one cannot be silently ignored. */
  | 'unsupported_constraint'
  /** The fixed body's feet do not equal the historical route's first point. */
  | 'wrong_start'
  /** `maxRoutePoints` is not a safe integer ≥ 2, or the polyline is longer than the requested budget. */
  | 'route_budget';

/** Input to {@link startKnownWalkRoute}: the normal walk request minus `points`, plus a fragment identity. */
export type KnownWalkRouteRequest = Omit<WalkRouteRequest, 'points'> & {
  /** Historical fragment whose stored polyline becomes the ordered route. */
  pathId?: string;
  /** Older alias for `pathId`; both may be supplied only when they are equal. */
  fragmentId?: string;
  /** Host action attribution only; it never wires cancellation or any control handle. */
  parentActionId?: string;
  /**
   * Pre-start point budget, inclusive, default 1024. Must be a safe integer ≥ 2.
   * This is only this start boundary's requested budget; it does not control
   * the executor's own `maxRouteLength`, which may reject a stricter limit.
   */
  maxRoutePoints?: number;
};

/** Identity/context of the historical route a STARTED delegation is executing. */
export interface KnownWalkRouteSnapshot {
  fragmentId: string;
  /** Geometry provenance; `legacy` is still geometry, never walked evidence. */
  geometrySource: PathFragment['geometrySource'];
  /** Historical geometry kind; never treated as a known movement mode. */
  kind: PathFragment['kind'];
  parentActionId?: string;
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  arrival: ArrivalSpec;
  /** Exact original ordered polyline (fresh copy; never aliases the store). */
  points: Vec3Like[];
  /** Original selected final point (fresh copy). */
  target: Vec3Like;
}

export type KnownWalkRouteStart =
  | {
      /** The executor accepted the delegation; this is neither OPEN nor ARRIVED. */
      kind: 'STARTED';
      /** Actual status returned by `executor.start`. */
      status: WalkRouteStatus;
      route: KnownWalkRouteSnapshot;
    }
  | {
      kind: 'REJECTED';
      reason: KnownWalkRouteRejectionReason;
      /** Human-readable counterpart to `reason`; never a world-fact claim. */
      message: string;
    };

/**
 * Start exactly one selected historical fragment on `executor`.
 *
 * Reading the fragment is side-effect free: it never updates the stored record,
 * its timestamps/uses, or creates traversal evidence. The caller remains
 * responsible for verified progress, measured arrival, observation reports,
 * cancellation and persistence through the same executor instance.
 */
export function startKnownWalkRoute(
  history: FragmentStore,
  executor: WalkRouteExecutor,
  request: KnownWalkRouteRequest,
): KnownWalkRouteStart {
  // Metadata-only fields do not belong on the walk request. `getFragment`
  // already returned a deep snapshot, and `executor.start` snapshots the
  // request it receives, so the polyline needs no intermediate copies.
  const {
    pathId: explicitPathId,
    fragmentId: fragmentAlias,
    parentActionId,
    maxRoutePoints: requestedMaxRoutePoints,
    ...walk
  } = request;

  if (explicitPathId !== undefined && fragmentAlias !== undefined && explicitPathId !== fragmentAlias) {
    return rejected(
      'ambiguous_path',
      `pathId "${explicitPathId}" and fragmentId "${fragmentAlias}" name different fragments`,
    );
  }
  const fragmentId = explicitPathId ?? fragmentAlias;
  if (fragmentId === undefined) {
    return rejected('missing_path_id', 'either pathId or fragmentId must name one historical fragment');
  }

  if (walk.worldId !== history.worldId) {
    return rejected(
      'wrong_scope',
      `request worldId "${walk.worldId}" does not match history worldId "${history.worldId}"`,
    );
  }

  const fragment = history.getFragment(fragmentId);
  if (fragment === null) {
    return rejected(
      'missing_history',
      `history for world "${history.worldId}" has no fragment "${fragmentId}"`,
    );
  }
  if (fragment.dim !== walk.dim) {
    return rejected(
      'wrong_scope',
      `fragment "${fragment.id}" is in dimension "${fragment.dim}", not "${walk.dim}"`,
    );
  }
  if (walk.mode !== 'walk') {
    return rejected(
      'unsupported_mode',
      `mode "${walk.mode}" is not supported; only walk can start a historical route`,
    );
  }
  if (walk.arrival.kind !== 'exact') {
    return rejected(
      'unsupported_arrival',
      `arrival kind "${walk.arrival.kind}" is not supported; only exact foot-position arrival is executed`,
    );
  }
  if ((walk.constraints?.avoid?.length ?? 0) > 0) {
    return rejected(
      'unsupported_constraint',
      'a non-empty avoid constraint is not consumed by the walk evaluator and cannot be silently ignored',
    );
  }

  const maxRoutePoints = requestedMaxRoutePoints ?? DEFAULT_MAX_ROUTE_POINTS;
  if (!Number.isSafeInteger(maxRoutePoints) || maxRoutePoints < 2) {
    return rejected(
      'route_budget',
      `maxRoutePoints must be a safe integer ≥ 2: ${maxRoutePoints}`,
    );
  }

  const points = fragment.polyline;
  if (points.length > maxRoutePoints) {
    return rejected(
      'route_budget',
      `historical route "${fragment.id}" has ${points.length} points, exceeding maxRoutePoints ${maxRoutePoints}`,
    );
  }
  if (points.length < 2) {
    return rejected(
      'unsupported_geometry',
      `historical route "${fragment.id}" has ${points.length} point(s); at least two are required`,
    );
  }

  const geometryProblem = polylineProblem(points);
  if (geometryProblem !== null) {
    return rejected('unsupported_geometry', `historical route "${fragment.id}" ${geometryProblem}`);
  }

  const feet = walk.body.feet;
  const start = points[0]!;
  if (feet.x !== start.x || feet.y !== start.y || feet.z !== start.z) {
    return rejected(
      'wrong_start',
      `body.feet ${fmt(feet)} must equal the historical route start ${fmt(start)}`,
    );
  }

  const status = executor.start({ ...walk, points });

  return {
    kind: 'STARTED',
    status,
    route: {
      fragmentId: fragment.id,
      geometrySource: fragment.geometrySource,
      kind: fragment.kind,
      ...(parentActionId === undefined ? {} : { parentActionId }),
      worldId: walk.worldId,
      dim: walk.dim,
      sessionId: walk.sessionId,
      mode: walk.mode,
      // Caller-mutable input must not alias the returned snapshot.
      arrival: { ...walk.arrival },
      points,
      target: { ...points[points.length - 1]! },
    },
  };
}

/**
 * The route verifier's exact one-cell capability contract, checked before
 * `executor.start` so unsupported stored geometry becomes a structured REJECTED
 * instead of a thrown boundary error. Coordinate schema (finite numbers,
 * non-empty ids) is already guaranteed by `FragmentStore`. Returns a problem
 * phrase, or `null` when the polyline is a sequence of same-height unit X/Z
 * steps.
 */
function polylineProblem(points: readonly Vec3Like[]): string | null {
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to.y !== from.y) {
      return `step ${i} changes height (Δy=${to.y - from.y}); only same-height walk steps are supported`;
    }
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const xZero = Math.abs(dx) < UNIT_EPS;
    const zZero = Math.abs(dz) < UNIT_EPS;
    const xUnit = Math.abs(Math.abs(dx) - 1) < UNIT_EPS;
    const zUnit = Math.abs(Math.abs(dz) - 1) < UNIT_EPS;
    if (xUnit && zZero) continue;
    if (zUnit && xZero) continue;
    if (xZero && zZero) {
      return `step ${i} duplicates point ${fmt(from)}`;
    }
    if (xUnit && zUnit) {
      return `step ${i} is diagonal (Δx=${dx}, Δz=${dz})`;
    }
    if (xZero) {
      return `step ${i} is not a one-cell move (Δz=${dz})`;
    }
    return `step ${i} is not a one-cell move (Δx=${dx})`;
  }
  return null;
}

function rejected(reason: KnownWalkRouteRejectionReason, message: string): KnownWalkRouteStart {
  return { kind: 'REJECTED', reason, message };
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
