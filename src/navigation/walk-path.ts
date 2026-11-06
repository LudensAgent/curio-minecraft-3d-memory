/**
 * `walkPath` entry: consume a plan-registry `routeId` and run the start
 * prechecks (contract §6.6, §7.5 items 1–4; implementation plan M4.2).
 *
 * This module does not execute the route itself. A caller-supplied `execute`
 * callback receives the prechecked plan; M4.3 binds `WalkRouteExecutor` there.
 * The entry:
 *
 * - consumes the single-use handle before any other check, so a failed start
 *   still needs a fresh `planRoute`;
 * - re-checks scope/session/expiry/executability through the registry and keeps
 *   each rejection distinguishable in `invalidation.reason`;
 * - requires a fresh measured sample in the same scope and within 0.05 blocks
 *   of the planned start, failing closed when no start can be measured;
 * - keeps the consumed handle pinned until the bound executor settles; and
 * - never calls `bodyPort.move`/`stop`, never searches, never writes memory and
 *   never mutates the plan; only the registry's own consume/release bookkeeping
 *   changes.
 */

import type { BodySample } from '../execution/types.js';
import type { Vec3Like } from '../types.js';
import type { RoutePlanRegistry, RoutePlanRegistryProblem } from './route-plan-registry.js';
import { clonePoint, isFinitePoint } from './route-plan-support.js';
import type { RoutePlan } from './route-plan-types.js';
import type { LastObservation, NavProblem } from './types.js';
import type { WalkPathEnvironment, WalkPathRequest, WalkPathResult } from './walk-path-types.js';

/** Default Euclidean distance allowed between `plan.start` and the measured feet. */
export const DEFAULT_START_TOLERANCE = 0.05;

const CONTRACT = 'memory-host-contract/1';

/** Reason codes reported in `WalkPathResult.invalidation.reason`. */
export type WalkPathInvalidationReason =
  | 'invalid_request'
  | 'route_not_found'
  | 'route_consumed'
  | 'route_expired'
  | 'scope_mismatch'
  | 'route_not_executable'
  | 'route_start_changed'
  | 'route_start_unmeasured'
  | 'route_body_unavailable';

/** Everything a bound executor needs after the start prechecks passed. */
export interface WalkPathStartContext {
  plan: RoutePlan;
  executionId: string;
  /** The exact measured sample the start check accepted. */
  sample: BodySample;
  request: WalkPathRequest;
  environment: WalkPathEnvironment;
}

/**
 * Bound execution hook. M4.3 supplies a `WalkRouteExecutor` driver; the entry
 * only invokes it after every precheck passes and returns its terminal result
 * unchanged. The consumed handle stays pinned until this promise settles.
 */
export type WalkPathExecute = (start: WalkPathStartContext) => Promise<WalkPathResult>;

export interface WalkPathOptions {
  /** Executor invoked only after every start precheck passes. */
  execute: WalkPathExecute;
}

/** Registry handle operations the entry needs; narrower than the full registry. */
export type WalkPathRegistry = Pick<RoutePlanRegistry, 'consume' | 'release'>;

/** Contract §7.1 execution-port shape. */
export type WalkPath = (
  request: WalkPathRequest,
  environment: WalkPathEnvironment,
) => Promise<WalkPathResult>;

/**
 * Bind `walkPath` to a plan registry and an executor. The returned function
 * consumes one registry-issued `routeId` per call; it cannot be given a
 * hand-built point sequence and never synthesizes an execution outcome.
 */
export function createWalkPath(registry: WalkPathRegistry, options: WalkPathOptions): WalkPath {
  return async (request, environment) => {
    const executionId = `exec_${request.routeId}`;
    const now = environment.now?.() ?? Date.now();
    // Consume first: the handle is single-use even when every later check fails.
    const consumed = registry.consume(
      request.routeId,
      { worldId: environment.worldId, dim: environment.dim, sessionId: environment.sessionId },
      now,
    );

    if (!('points' in consumed)) {
      return registryFailure(request.routeId, executionId, consumed, environment);
    }
    const plan = consumed;
    const sample = environment.sample();
    if (sample === null) {
      registry.release(plan.routeId);
      return planInvalidated(plan, executionId, null, 'route_start_unmeasured', {
        kind: 'unavailable',
        detail: 'no measured body sample is available; the execution start is unconfirmed',
      });
    }

    const startProblem = checkStart(plan, sample, environment);
    if (startProblem !== null) {
      registry.release(plan.routeId);
      return planInvalidated(plan, executionId, sample, startProblem.reason, startProblem.problem);
    }

    // Every precheck passed. The executor owns the run; the handle stays pinned
    // until it settles and is released even if the executor rejects.
    return await options.execute({ plan, executionId, sample, request, environment }).finally(() => {
      registry.release(plan.routeId);
    });
  };
}

function checkStart(
  plan: RoutePlan,
  sample: BodySample,
  environment: WalkPathEnvironment,
): { reason: WalkPathInvalidationReason; problem: NavProblem } | null {
  if (!isFinitePoint(sample.pos) || !Number.isFinite(sample.observedAt)) {
    return {
      reason: 'route_start_unmeasured',
      problem: {
        kind: 'unavailable',
        detail: 'the measured body sample has a non-finite position or observation time',
      },
    };
  }
  if (
    sample.worldId !== environment.worldId ||
    sample.dim !== environment.dim ||
    sample.sessionId !== environment.sessionId
  ) {
    return {
      reason: 'scope_mismatch',
      problem: {
        kind: 'scope_changed',
        detail: 'the measured sample world/dim/session does not match the consumed route scope',
      },
    };
  }
  if (!sample.alive || !sample.connected || !sample.observationReady) {
    return {
      reason: 'route_body_unavailable',
      problem: {
        kind: 'unavailable',
        detail: `the measured body is not usable: alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
      },
    };
  }

  const distance = Math.hypot(
    sample.pos.x - plan.start.x,
    sample.pos.y - plan.start.y,
    sample.pos.z - plan.start.z,
  );
  if (distance > DEFAULT_START_TOLERANCE) {
    return {
      reason: 'route_start_changed',
      problem: {
        kind: 'route_invalidated',
        detail: `measured feet are ${distance} blocks from the planned start (tolerance ${DEFAULT_START_TOLERANCE})`,
      },
    };
  }
  return null;
}

function registryFailure(
  routeId: string,
  executionId: string,
  problem: RoutePlanRegistryProblem,
  environment: WalkPathEnvironment,
): WalkPathResult {
  const sample = environment.sample();
  switch (problem.kind) {
    case 'invalid_request':
      return invalidated(routeId, executionId, sample, 'invalid_request', {
        kind: 'invalid_request',
        detail: problem.detail,
      });
    case 'route_not_found':
      return invalidated(routeId, executionId, sample, 'route_not_found', {
        kind: 'invalid_request',
        detail: 'routeId was not issued by the plan registry; a new planRoute is required',
      });
    case 'route_consumed':
      return invalidated(routeId, executionId, sample, 'route_consumed', {
        kind: 'route_invalidated',
        detail: 'routeId was already consumed; a new planRoute is required',
      });
    case 'route_expired':
      return invalidated(routeId, executionId, sample, 'route_expired', {
        kind: 'route_invalidated',
        detail: `routeId expired at ${problem.expiresAt}; a new planRoute is required`,
      });
    case 'scope_mismatch':
      return invalidated(routeId, executionId, sample, 'scope_mismatch', {
        kind: 'scope_changed',
        detail: `route scope is ${scopeLabel(problem.expected)}; environment is ${scopeLabel(problem.actual)}`,
      });
    case 'route_not_executable':
      return invalidated(routeId, executionId, sample, 'route_not_executable', {
        kind: 'route_invalidated',
        detail: problem.reason,
      });
  }
}

/** Precheck failure after the handle was consumed, so the plan is known. */
function planInvalidated(
  plan: RoutePlan,
  executionId: string,
  sample: BodySample | null,
  reason: WalkPathInvalidationReason,
  problem: NavProblem,
): WalkPathResult {
  return {
    outcome: 'INVALIDATED',
    contract: CONTRACT,
    routeId: plan.routeId,
    executionId,
    ...measuredEvidence(sample),
    confirmedSegments: 0,
    remainingPoints: plan.points.map(clonePoint),
    invalidation: { segment: 0, reason },
    problem,
    consumption: { placed: [] },
    confirmed: false,
    trace: [],
  };
}

/** Precheck failure before a plan could be consumed (registry rejection). */
function invalidated(
  routeId: string,
  executionId: string,
  sample: BodySample | null,
  reason: WalkPathInvalidationReason,
  problem: NavProblem,
): WalkPathResult {
  return {
    outcome: 'INVALIDATED',
    contract: CONTRACT,
    routeId,
    executionId,
    ...measuredEvidence(sample),
    confirmedSegments: 0,
    remainingPoints: [],
    invalidation: { segment: 0, reason },
    problem,
    consumption: { placed: [] },
    confirmed: false,
    trace: [],
  };
}

/** Last measured position/observation, or nothing when the host supplied none. */
function measuredEvidence(
  sample: BodySample | null,
): { lastPosition?: Vec3Like; lastObservation?: LastObservation } {
  if (sample === null || !isFinitePoint(sample.pos)) return {};
  return {
    lastPosition: clonePoint(sample.pos),
    lastObservation: {
      worldId: sample.worldId,
      dim: sample.dim,
      sessionId: sample.sessionId,
      observedAt: sample.observedAt,
      onGround: sample.onGround,
      inWater: sample.inWater,
    },
  };
}

function scopeLabel(scope: { worldId: string; dim: string; sessionId: string }): string {
  return `${scope.worldId}/${scope.dim}/${scope.sessionId}`;
}
