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
 * The walk executor's existing default route-point ceiling. `maxRoutePoints`
 * can only be used to apply an equal or stricter pre-check here; it cannot
 * loosen or inspect an executor constructed with a different `maxRouteLength`.
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
  /** `maxRoutePoints` is invalid, exceeds the executor default, or the polyline is longer. */
  | 'route_budget';

/** Input to {@link startKnownWalkRoute}: the normal walk request minus `points`, plus a fragment identity. */
export type KnownWalkRouteRequest = Omit<WalkRouteRequest, 'points'> & {
  /** Historical fragment whose stored polyline becomes the ordered route. */
  fragmentId: string;
  /** Host action attribution only; it never wires cancellation or any control handle. */
  parentActionId?: string;
  /**
   * Pre-start point budget, inclusive, default 1024. Must be an integer in
   * `[2, 1024]`; a lower value only rejects longer routes here. It does not
   * control the executor's own `maxRouteLength` setting.
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
  if (request.worldId !== history.worldId) {
    return rejected(
      'wrong_scope',
      `request worldId "${request.worldId}" does not match history worldId "${history.worldId}"`,
    );
  }

  const fragment = history.getFragment(request.fragmentId);
  if (fragment === null) {
    return rejected(
      'missing_history',
      `history for world "${history.worldId}" has no fragment "${request.fragmentId}"`,
    );
  }
  if (fragment.dim !== request.dim) {
    return rejected(
      'wrong_scope',
      `fragment "${fragment.id}" is in dimension "${fragment.dim}", not "${request.dim}"`,
    );
  }
  if (request.mode !== 'walk') {
    return rejected(
      'unsupported_mode',
      `mode "${request.mode}" is not supported; only walk can start a historical route`,
    );
  }
  if (request.arrival.kind !== 'exact') {
    return rejected(
      'unsupported_arrival',
      `arrival kind "${request.arrival.kind}" is not supported; only exact foot-position arrival is executed`,
    );
  }
  if ((request.constraints?.avoid?.length ?? 0) > 0) {
    return rejected(
      'unsupported_constraint',
      'a non-empty avoid constraint is not consumed by the walk evaluator and cannot be silently ignored',
    );
  }

  const maxRoutePoints = request.maxRoutePoints ?? DEFAULT_MAX_ROUTE_POINTS;
  if (!Number.isInteger(maxRoutePoints) || maxRoutePoints < 2 || maxRoutePoints > DEFAULT_MAX_ROUTE_POINTS) {
    return rejected(
      'route_budget',
      `maxRoutePoints must be an integer in [2, ${DEFAULT_MAX_ROUTE_POINTS}]: ${maxRoutePoints}`,
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

  const start = points[0]!;
  if (!pointsEqual(request.body.feet, start)) {
    return rejected(
      'wrong_start',
      `body.feet ${fmt(request.body.feet)} must equal the historical route start ${fmt(start)}`,
    );
  }

  // Fresh copies: neither the executor's stored request nor the returned
  // snapshot may alias the store record or the caller's mutable objects.
  const routePoints = points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  const status = executor.start({
    worldId: request.worldId,
    dim: request.dim,
    sessionId: request.sessionId,
    mode: request.mode,
    body: {
      feet: { x: request.body.feet.x, y: request.body.feet.y, z: request.body.feet.z },
      width: request.body.width,
      height: request.body.height,
      pose: request.body.pose,
    },
    points: routePoints,
    arrival: { ...request.arrival },
    ...(request.bodyArrival === undefined ? {} : { bodyArrival: { ...request.bodyArrival } }),
    ...(request.constraints === undefined
      ? {}
      : { constraints: { avoid: (request.constraints.avoid ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z })) } }),
    shapeProvider: request.shapeProvider,
    deadlineMs: request.deadlineMs,
    timeoutMs: request.timeoutMs,
  });

  return {
    kind: 'STARTED',
    status,
    route: {
      fragmentId: fragment.id,
      geometrySource: fragment.geometrySource,
      kind: fragment.kind,
      ...(request.parentActionId === undefined ? {} : { parentActionId: request.parentActionId }),
      worldId: request.worldId,
      dim: request.dim,
      sessionId: request.sessionId,
      mode: request.mode,
      arrival: { ...request.arrival },
      points: routePoints.map((p) => ({ ...p })),
      target: { ...routePoints[routePoints.length - 1]! },
    },
  };
}

/**
 * The route verifier's exact one-cell contract, checked before `executor.start`
 * so malformed stored geometry becomes a structured REJECTED instead of a
 * thrown boundary error. Returns a problem phrase, or `null` when the polyline
 * is a sequence of same-height unit X/Z steps.
 */
function polylineProblem(points: readonly Vec3Like[]): string | null {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      return `point ${i} has non-finite coordinates ${fmt(p)}`;
    }
  }
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

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
