/**
 * Historical-fragment planning (contract §6.7, plan M3.4).
 *
 * `source:'history'` reads one explicitly named `PathFragment` and re-verifies
 * its stored polyline against current walk evidence. History is read as
 * geometry only:
 *
 * - `FragmentStore.getFragment` returns a snapshot; this module never updates
 *   `uses`, `lastUsedAt`, links or traversal records;
 * - no executor is started and no movement is triggered;
 * - a currently blocked segment keeps the historical geometry and is reported
 *   as a candidate boundary, never as "the history was deleted";
 * - the requested target and the historical endpoint are reported separately.
 *   A historical route that ends somewhere else is not executable as an exact
 *   arrival at the requested target.
 */

import type { PathFragment } from '../topology/path-fragment.js';
import type { Vec3Like } from '../types.js';
import type {
  CancellationOrigin,
  RoutePlanDraft,
  RoutePlanEnvironment,
  RoutePlanRequest,
  RouteUnsupported,
} from './route-plan-types.js';
import type { NavProblem } from './types.js';
import {
  assemblePlan,
  clonePoint,
  emptyVerification,
  planScope,
  positionsEqual,
  routeGeometryProblem,
  verifyRoutePoints,
} from './route-plan-support.js';
import type { MeasuredPlanStart } from './route-plan-support.js';

export interface HistoryPlanInput {
  request: RoutePlanRequest;
  environment: RoutePlanEnvironment;
  start: MeasuredPlanStart;
  now: () => number;
  deadlineMs: number;
  budget: number;
  maxRoutePoints: number;
  planTtlMs: number;
  wait: () => Promise<void>;
  cancellationOrigin: CancellationOrigin;
}

export type HistoryPlanOutcome =
  | { draft: RoutePlanDraft }
  | { problem: NavProblem | RouteUnsupported; message: string };

/**
 * Build (but do not register) one history-sourced plan. The caller decides
 * whether to register it for the explicit `history` request.
 */
export async function buildHistoryPlan(input: HistoryPlanInput): Promise<HistoryPlanOutcome> {
  const { environment, request } = input;
  const pathId = request.pathId;
  if (pathId === undefined) {
    return {
      problem: { kind: 'invalid_request', detail: 'source "history" requires an explicit pathId' },
      message: 'history planning requires an explicit pathId',
    };
  }

  const history = environment.history;
  if (history === undefined) {
    return {
      problem: { kind: 'unavailable', detail: 'no historical fragment store was supplied for history planning' },
      message: 'history planning is unavailable without a fragment store',
    };
  }
  if (history.worldId !== environment.worldId) {
    return {
      problem: {
        kind: 'scope_changed',
        detail: `history worldId "${history.worldId}" does not match planning worldId "${environment.worldId}"`,
      },
      message: 'the history store belongs to a different world',
    };
  }

  const fragment: PathFragment | null = history.getFragment(pathId);
  if (fragment === null) {
    return {
      problem: { kind: 'unavailable', detail: `no fragment "${pathId}" is recorded in world "${environment.worldId}"` },
      message: `history has no fragment "${pathId}"`,
    };
  }
  if (fragment.dim !== environment.dim) {
    return {
      problem: {
        kind: 'scope_changed',
        detail: `fragment "${pathId}" is in dimension "${fragment.dim}", not "${environment.dim}"`,
      },
      message: 'the historical fragment belongs to a different dimension',
    };
  }

  const points = fragment.polyline.map(clonePoint);
  if (points.length === 0) {
    return {
      problem: { kind: 'unsupported_geometry', detail: `historical route "${pathId}" has no points` },
      message: 'the historical route has no geometry',
    };
  }
  if (points.length > input.maxRoutePoints) {
    return {
      problem: {
        kind: 'budget_exhausted',
        limit: 'points',
        detail: `historical route "${pathId}" has ${points.length} points, exceeding maxRoutePoints ${input.maxRoutePoints}`,
      },
      message: 'the historical route exceeds the planning point budget',
    };
  }
  if (points.length >= 2) {
    const geometryProblem = routeGeometryProblem(points);
    if (geometryProblem !== null) {
      return {
        problem: {
          kind: 'unsupported_geometry',
          detail: `historical route "${pathId}" ${geometryProblem}`,
        },
        message: 'the historical polyline is outside the walk planner geometry contract',
      };
    }
  }

  let verification = emptyVerification();
  if (points.length >= 2) {
    const outcome = await verifyRoutePoints({
      verifier: environment.verifier,
      scope: planScope(environment),
      body: environment.body,
      shapeProvider: environment.shapeProvider,
      points,
      now: input.now,
      deadlineMs: input.deadlineMs,
      budget: input.budget,
      wait: input.wait,
      ...(environment.signal === undefined ? {} : { signal: environment.signal }),
      cancellationOrigin: input.cancellationOrigin,
    });
    if (!outcome.ok) return { problem: outcome.problem, message: outcome.message };
    verification = outcome.verification;
  }

  const startedAt = input.now();
  if (startedAt >= input.deadlineMs) {
    return {
      problem: { kind: 'timeout' },
      message: 'the planning deadline was exceeded before the historical route was assembled',
    };
  }

  const resolvedTarget = points[points.length - 1]!;
  const extraUnsupported = historyTargetProblem(input.start.sample.pos, points[0]!, request.to, resolvedTarget);

  const draft = assemblePlan({
    source: 'history',
    kind: fragment.kind,
    pathId: fragment.id,
    points,
    start: input.start.sample.pos,
    requestedTarget: request.to,
    resolvedTarget,
    scope: planScope(environment),
    shapeProvider: environment.shapeProvider,
    verification,
    nowMs: startedAt,
    planTtlMs: input.planTtlMs,
    ...(extraUnsupported === undefined ? {} : { extraUnsupported }),
  });
  return { draft };
}

/** Start/endpoint mismatches make the plan non-executable without rewriting history. */
function historyTargetProblem(
  measuredStart: Vec3Like,
  routeStart: Vec3Like,
  requestedTarget: Vec3Like,
  resolvedTarget: Vec3Like,
): RouteUnsupported | undefined {
  const startMismatch = !positionsEqual(measuredStart, routeStart);
  const targetMismatch = !positionsEqual(resolvedTarget, requestedTarget);
  if (!startMismatch && !targetMismatch) return undefined;

  const facts: string[] = [];
  if (startMismatch) {
    facts.push(
      `the historical route starts at (${routeStart.x}, ${routeStart.y}, ${routeStart.z}) ` +
        `but the measured body is at (${measuredStart.x}, ${measuredStart.y}, ${measuredStart.z})`,
    );
  }
  if (targetMismatch) {
    facts.push(
      `the historical route ends at (${resolvedTarget.x}, ${resolvedTarget.y}, ${resolvedTarget.z}) ` +
        `but the requested exact target is (${requestedTarget.x}, ${requestedTarget.y}, ${requestedTarget.z})`,
    );
  }
  return {
    kind: 'unsupported_geometry',
    detail: `${facts.join('; ')}; the historical geometry is retained but is not an exact execution of this request`,
  };
}
