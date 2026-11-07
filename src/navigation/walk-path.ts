/**
 * `walkPath` entry: consume a plan-registry `routeId` and run the start
 * prechecks (contract §6.6, §7.5 items 1–4; implementation plan M4.2).
 *
 * The entry does not execute; the optional M4.3 binding
 * (`createWalkPathExecution`) receives the prechecked plan and drives
 * `WalkRouteExecutor`. The entry:
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

import type { BodySample, GroundedArrival, WalkRouteRequest, WalkRouteStatus } from '../execution/types.js';
import { GROUNDED_ARRIVAL_DEFAULTS } from '../execution/types.js';
import { WalkRouteExecutor } from '../execution/walk-route-executor.js';
import type { Vec3Like } from '../types.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import type { RoutePlanRegistry, RoutePlanRegistryProblem } from './route-plan-registry.js';
import {
  DEFAULT_BUDGET_PER_SLICE,
  DEFAULT_MAX_ROUTE_POINTS,
  clonePoint,
  isFinitePoint,
} from './route-plan-support.js';
import type { RoutePlan } from './route-plan-types.js';
import type { LastObservation, NavProblem, NavResult } from './types.js';
import type { WalkPathEnvironment, WalkPathRequest, WalkPathResult } from './walk-path-types.js';

/** Default Euclidean distance allowed between `plan.start` and the measured feet. */
export const DEFAULT_START_TOLERANCE = 0.05;

/** Per-move timeout budget when the caller does not supply one. */
const DEFAULT_MOVE_TIMEOUT_MS = 20_000;

const CONTRACT = 'memory-host-contract/1';

/**
 * Reason codes reported in `WalkPathResult.invalidation.reason`.
 *
 * The first group is the start/registry rejection set. The second group is the
 * executor's structured `NavProblem.kind` values that stop the route as an
 * invalidation rather than a world blockage; hosts should narrow on this union
 * (or treat unknown strings as a non-arrival failure).
 */
export type WalkPathInvalidationReason =
  | 'invalid_request'
  | 'route_not_found'
  | 'route_consumed'
  | 'route_expired'
  | 'scope_mismatch'
  | 'route_not_executable'
  | 'route_start_changed'
  | 'route_start_unmeasured'
  | 'route_body_unavailable'
  | 'route_budget'
  | 'route_invalidated'
  | 'scope_changed'
  | 'unobserved'
  | 'stale'
  | 'unloaded'
  | 'deviation'
  | 'unconfirmed_arrival'
  | 'unmeasured_position'
  | 'execution_failed'
  | 'unsupported_mode'
  | 'unsupported_target'
  | 'search_budget_exhausted'
  | 'not_authorized';

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

    const startProblem = checkStart(plan, executionId, sample, environment);
    if (startProblem !== null) {
      registry.release(plan.routeId);
      // A sample rejected for execution identity is not this execution's
      // evidence; do not echo it back as lastPosition/lastObservation.
      const evidence = sample.executionId === executionId ? sample : null;
      return planInvalidated(plan, executionId, evidence, startProblem.reason, startProblem.problem);
    }

    // Every precheck passed. The executor owns the run; the handle stays pinned
    // until it settles and is released even if the executor rejects.
    return await options.execute({ plan, executionId, sample, request, environment }).finally(() => {
      registry.release(plan.routeId);
    });
  };
}

/** Configuration for the library's `WalkRouteExecutor` binding (implementation plan M4.3). */
export interface WalkPathExecutionOptions {
  /** Map the bound executor verifies against; the environment's worldId must match it. */
  map: VoxelMap;
  /** Ordered-point budget; a longer plan is rejected before `start`. Defaults to 1024. */
  maxRouteLength?: number;
  /** Per-move timeout budget in ms. Defaults to 20 000. */
  moveTimeoutMs?: number;
  /** Verification edge budget per control slice. Defaults to 256. */
  budget?: number;
  /** Clock fallback when the environment supplies none; defaults to `Date.now`. */
  now?: () => number;
  /** Cooperative yield between control slices; defaults to a macrotask. */
  wait?: () => Promise<void>;
}

/**
 * Bind the library's execution side: build one `WalkRouteRequest` from the
 * prechecked plan and drive a `WalkRouteExecutor` to a terminal result.
 *
 * The returned hook is supplied as `createWalkPath(registry, { execute })`.
 * It only starts the plan it was handed — exactly once — and never searches,
 * re-plans, substitutes points or synthesizes arrival:
 *
 * - points come from the plan in their original order; the host's measured
 *   start sample seeds the executor's measured start. Later `environment.sample()`
 *   readings are forwarded only when their `executionId` equals this walkPath
 *   execution (`exec_<routeId>`); the executor's internal delegation id never
 *   leaves the library. Any other id — including a previous execution's
 *   `walk-<n>` sample — is ignored, never reinterpreted;
 * - every segment is gated by the executor's current-`OPEN` re-verification,
 *   so `UNKNOWN`/`STALE`/`BLOCKED` evidence is never executed;
 * - the environment's `bodyPort` is the executor's `MoveExecutor`, so `move`
 *   and `stop` stay one-step, execution-scoped operations;
 * - `changes` reports are forwarded to the executor before the next control
 *   step, never converted into a new route;
 * - `maxRouteLength` is enforced before `start`, and the executor's deadline is
 *   the request deadline, never reset per segment;
 * - the terminal outcome is mapped by confirmed progress: zero confirmed
 *   segments never become `PARTIAL`; explicit obstacles map to `BLOCKED`,
 *   `no_path` to `NO_PATH`, and body/evidence/session invalidation to
 *   `INVALIDATED` (`ARRIVED` still requires the executor's measured evidence).
 */
export function createWalkPathExecution(options: WalkPathExecutionOptions): WalkPathExecute {
  const maxRouteLength = options.maxRouteLength ?? DEFAULT_MAX_ROUTE_POINTS;
  if (!Number.isInteger(maxRouteLength) || maxRouteLength < 2) {
    throw new Error(`maxRouteLength must be an integer ≥ 2: ${maxRouteLength}`);
  }
  const moveTimeoutMs = options.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
  if (!Number.isFinite(moveTimeoutMs) || moveTimeoutMs <= 0) {
    throw new Error(`moveTimeoutMs must be a positive finite number: ${moveTimeoutMs}`);
  }
  const budget = options.budget ?? DEFAULT_BUDGET_PER_SLICE;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`budget must be a positive safe integer: ${budget}`);
  }
  const wait = options.wait ?? defaultWait;

  return async ({ plan, executionId, sample, request, environment }) => {
    const now = environment.now ?? options.now ?? Date.now;
    const startedAt = now();
    if (!Number.isFinite(startedAt) || !Number.isFinite(request.deadlineMs)) {
      return notStartedResult(plan, executionId, sample, 'INVALIDATED', 'invalid_request', {
        kind: 'invalid_request',
        detail: 'walkPath needs a finite clock and deadline',
      });
    }
    if (plan.points.length > maxRouteLength) {
      return notStartedResult(plan, executionId, sample, 'INVALIDATED', 'route_budget', {
        kind: 'invalid_request',
        detail: `the route has ${plan.points.length} points, exceeding maxRouteLength ${maxRouteLength}`,
      });
    }
    if (startedAt >= request.deadlineMs) {
      return notStartedResult(plan, executionId, sample, 'TIMEOUT', null, { kind: 'timeout' });
    }
    if (options.map.worldId !== environment.worldId) {
      return notStartedResult(plan, executionId, sample, 'INVALIDATED', 'invalid_request', {
        kind: 'invalid_request',
        detail: `map worldId "${options.map.worldId}" does not match environment worldId "${environment.worldId}"`,
      });
    }

    // A verified zero-edge plan is already at its target; returning ARRIVED is
    // permitted by contract §6.5.5 and must not fabricate movement. It still
    // needs a measured, grounded, dry, stable sample that meets bodyArrival.
    if (plan.points.length === 1) {
      return await zeroEdgeArrival(plan, executionId, sample, request, environment, wait, now);
    }

    const executor = new WalkRouteExecutor(
      options.map,
      {
        // Expose one stable identity to the host: exec_<routeId>. The executor's
        // delegation/step ids never leave this module; a sample that comes back
        // under any other identity is rejected instead of rebound.
        move: async (move) => {
          const result = await environment.bodyPort.move({ ...move, executionId });
          if (result.sample === undefined) return result;
          if (result.sample.executionId !== executionId) {
            return {
              failure: {
                kind: 'execution_error',
                detail: 'the move sample executionId does not match the walkPath execution',
              },
            };
          }
          return { ...result, sample: { ...result.sample, executionId: move.executionId } };
        },
        stop: () => environment.bodyPort.stop(executionId),
      },
      { now, maxRouteLength },
    );

    const bodyArrival: GroundedArrival = request.bodyArrival ?? GROUNDED_ARRIVAL_DEFAULTS;
    const routeRequest: WalkRouteRequest = {
      worldId: environment.worldId,
      dim: environment.dim,
      sessionId: environment.sessionId,
      mode: 'walk',
      // The executor's fixed body must sit on the plan's first point; measured
      // feet are supplied separately and may differ within the start tolerance.
      body: { ...environment.body, feet: { ...plan.points[0]! } },
      points: plan.points,
      arrival: { kind: 'exact' },
      bodyArrival,
      startSample: sample,
      shapeProvider: environment.shapeProvider,
      deadlineMs: request.deadlineMs,
      timeoutMs: moveTimeoutMs,
    };

    // Exactly one start for this route; the driver never replaces or re-searches
    // it. `start` throws on malformed plan/body/clock input, which is a request
    // boundary failure here: convert it to the §7.4 envelope instead of letting
    // an exception escape `walkPath` (the route handle was already consumed).
    let started: WalkRouteStatus;
    try {
      started = executor.start(routeRequest);
    } catch (error) {
      return notStartedResult(plan, executionId, sample, 'INVALIDATED', 'invalid_request', {
        kind: 'invalid_request',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (started.result !== null) {
      return toWalkPathResult(plan, executionId, started, started.result);
    }

    // Bind the accepted measurement to this delegation so the executor's
    // association check can reason about it; the host sequence is preserved
    // exactly (the start precheck rejected a non-positive/non-integer one).
    let status = executor.onSample({
      ...sample,
      pos: { ...sample.pos },
      executionId: started.delegationId,
      sequence: sample.sequence,
    });
    let terminal = status.result;
    // The accepted-change report forwarded to the executor immediately before
    // the execution became terminal as a `route_invalidated`/`scope_changed`
    // invalidation. Kept by reference (contract §7.4/§8.1) so `invalidation.changes`
    // names that report under consideration; it is not necessarily the sole
    // cause, since the executor can also stop on TTL, rule-version or residency
    // changes it does not expose. A report delivered after the execution already
    // terminated is ignored below and cannot replace it.
    let invalidationReport: ChangeReport | undefined;

    const unsubscribe = environment.changes?.subscribe((report) => {
      if (status.result !== null) return;
      status = executor.observe(report, budget);
      const result = status.result;
      if (
        invalidationReport === undefined
        && result !== null
        && (result.problem?.kind === 'route_invalidated' || result.problem?.kind === 'scope_changed')
      ) {
        invalidationReport = report;
      }
    });

    try {
      while (terminal === null) {
        if (request.signal?.aborted === true) {
          terminal = executor.cancel(environment.cancellationOrigin ?? 'unknown', 'walk_path signal aborted');
          break;
        }
        if (now() >= request.deadlineMs) {
          // Exhausting the deadline is TIMEOUT, not a caller cancellation; the
          // measured displacement and trace are preserved, nothing is confirmed.
          terminal = asTimeout(executor.cancel('scheduler', 'walk_path deadline exceeded'));
          break;
        }

        status = executor.advance(budget);
        if (status.result !== null) {
          terminal = status.result;
          break;
        }

        // Only this execution's external identity is accepted. The executor's
        // internal delegation id is rebound here and never exposed to the host.
        const measured = environment.sample();
        if (measured === null) {
          const cancelled = executor.cancel('lifecycle', 'no measured body sample during execution');
          const afterCancel = executor.status() ?? status;
          return bodyUnavailableResult(plan, executionId, afterCancel, cancelled);
        }
        if (measured.executionId === executionId) {
          status = executor.onSample({
            ...measured,
            pos: { ...measured.pos },
            executionId: started.delegationId,
          });
          if (status.result !== null) {
            terminal = status.result;
            break;
          }
        }

        await wait();
        const afterWait = executor.status();
        if (afterWait !== null) status = afterWait;
        terminal = status.result;
      }
    } finally {
      unsubscribe?.();
    }

    return toWalkPathResult(plan, executionId, status, terminal, invalidationReport);
  };
}

function defaultWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Convert a deadline-driven stop into the contract's TIMEOUT, keeping measured evidence. */
function asTimeout(cancelled: NavResult): NavResult {
  const base = {
    outcome: 'TIMEOUT' as const,
    message: 'the walkPath deadline was exceeded before arrival was confirmed',
    problem: { kind: 'timeout' } satisfies NavProblem,
    confirmed: false as const,
    trace: cancelled.trace.map((entry) => ({ pos: { ...entry.pos }, ts: entry.ts })),
  };
  if (cancelled.lastPosition === undefined || cancelled.lastObservation === undefined) return base;
  return {
    ...base,
    lastPosition: { ...cancelled.lastPosition },
    lastObservation: { ...cancelled.lastObservation },
  };
}

/** Map a pre-start rejection (nothing moved) into the walk-path result envelope. */
function notStartedResult(
  plan: RoutePlan,
  executionId: string,
  sample: BodySample,
  outcome: 'INVALIDATED' | 'TIMEOUT',
  reason: WalkPathInvalidationReason | null,
  problem: NavProblem,
): WalkPathResult {
  return {
    outcome,
    contract: CONTRACT,
    routeId: plan.routeId,
    executionId,
    ...measuredEvidence(sample),
    confirmedSegments: 0,
    remainingPoints: plan.points.map(clonePoint),
    ...(reason === null ? {} : { invalidation: { segment: 0, reason } }),
    problem,
    consumption: { placed: [] },
    confirmed: false,
    trace: [],
  };
}

/** Project the executor's terminal `NavResult` into the walk-path result contract. */
function toWalkPathResult(
  plan: RoutePlan,
  executionId: string,
  status: WalkRouteStatus,
  result: NavResult,
  invalidationReport?: ChangeReport,
): WalkPathResult {
  const confirmedSegments = Math.max(0, status.nextPointIndex - 1);
  const evidence =
    result.lastPosition !== undefined
      ? {
          lastPosition: { ...result.lastPosition },
          ...(result.lastObservation !== undefined ? { lastObservation: { ...result.lastObservation } } : {}),
        }
      : {};
  const base = {
    contract: CONTRACT as WalkPathResult['contract'],
    routeId: plan.routeId,
    executionId,
    ...evidence,
    confirmedSegments,
    remainingPoints: plan.points.slice(status.nextPointIndex).map(clonePoint),
    consumption: { placed: [] },
    trace: result.trace.map((entry) => ({ pos: { ...entry.pos }, ts: entry.ts })),
  };

  if (result.outcome === 'ARRIVED') {
    return {
      ...base,
      outcome: 'ARRIVED',
      lastPosition: { ...result.lastPosition },
      lastObservation: { ...result.lastObservation },
      remainingPoints: [],
      confirmed: true,
    };
  }

  const kind = result.problem?.kind;
  const zero = confirmedSegments === 0;
  if (kind === 'route_invalidated' || kind === 'scope_changed') {
    return {
      ...base,
      outcome: 'INVALIDATED',
      invalidation: {
        segment: confirmedSegments,
        reason: kind,
        ...(invalidationReport === undefined ? {} : { changes: invalidationReport }),
      },
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  if (kind === 'unavailable') {
    return {
      ...base,
      outcome: 'INVALIDATED',
      invalidation: { segment: confirmedSegments, reason: 'route_body_unavailable' },
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  // Current-evidence gaps and execution failures must not be reported as a
  // world blockage or as confirmed progress (contract §7.5.9).
  if (kind === 'unobserved' || kind === 'stale' || kind === 'unloaded') {
    return {
      ...base,
      outcome: 'INVALIDATED',
      invalidation: { segment: confirmedSegments, reason: kind },
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  if (
    kind === 'blocked' ||
    kind === 'head_blocked' ||
    kind === 'hazard' ||
    kind === 'support_missing' ||
    kind === 'support_out_of_reach' ||
    kind === 'occupied'
  ) {
    return {
      ...base,
      outcome: 'BLOCKED',
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  if (kind === 'no_path') return { ...base, outcome: 'NO_PATH', ...(result.problem === undefined ? {} : { problem: result.problem }), confirmed: false };
  if (kind === 'cancelled') return { ...base, outcome: 'CANCELLED', ...(result.problem === undefined ? {} : { problem: result.problem }), confirmed: false };
  if (kind === 'timeout') return { ...base, outcome: 'TIMEOUT', ...(result.problem === undefined ? {} : { problem: result.problem }), confirmed: false };

  // Non-invalidation execution failures retain confirmed progress as PARTIAL
  // (contract §7.4). With zero confirmed segments there is no partial progress;
  // report the failure as INVALIDATED rather than inventing a PARTIAL/ARRIVED.
  const progressFailure =
    kind === 'deviation' ||
    kind === 'unconfirmed_arrival' ||
    kind === 'unmeasured_position' ||
    kind === 'execution_failed' ||
    kind === 'invalid_request' ||
    kind === 'unsupported_mode' ||
    kind === 'unsupported_target' ||
    kind === 'search_budget_exhausted' ||
    kind === 'not_authorized';
  if (progressFailure) {
    return {
      ...base,
      outcome: zero ? 'INVALIDATED' : 'PARTIAL',
      ...(zero ? { invalidation: { segment: confirmedSegments, reason: kind } } : {}),
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  if (result.outcome === 'FAILED' || (result.outcome === 'PARTIAL' && zero)) {
    return {
      ...base,
      outcome: zero ? 'INVALIDATED' : 'PARTIAL',
      ...(zero ? { invalidation: { segment: confirmedSegments, reason: kind ?? 'execution_failed' } } : {}),
      ...(result.problem === undefined ? {} : { problem: result.problem }),
      confirmed: false,
    };
  }
  return {
    ...base,
    outcome: result.outcome,
    ...(result.problem === undefined ? {} : { problem: result.problem }),
    confirmed: false,
  };
}

/** Match the executor's own bodyArrival validation boundary. */
function validGroundedArrival(a: GroundedArrival): boolean {
  return [a.horizontalTolerance, a.feetTolerance, a.maxHorizontalSpeed, a.maxVerticalSpeed, a.stableMs]
    .every((value) => Number.isFinite(value) && value >= 0)
    && a.horizontalTolerance > 0
    && a.horizontalTolerance < 0.5
    && a.feetTolerance < 0.5
    && a.stableMs > 0;
}

/** A verified zero-edge plan: stabilize a measured sample at the target first. */
async function zeroEdgeArrival(
  plan: RoutePlan,
  executionId: string,
  initial: BodySample,
  request: WalkPathRequest,
  environment: WalkPathEnvironment,
  wait: () => Promise<void>,
  now: () => number,
): Promise<WalkPathResult> {
  const isAborted = (): boolean => request.signal?.aborted === true;
  if (isAborted()) {
    return cancelledResult(plan, executionId, initial, environment, 'walk_path signal aborted before zero-edge arrival');
  }
  const bodyArrival = request.bodyArrival ?? GROUNDED_ARRIVAL_DEFAULTS;
  if (!validGroundedArrival(bodyArrival)) {
    return notStartedResult(plan, executionId, initial, 'INVALIDATED', 'invalid_request', {
      kind: 'invalid_request',
      detail: 'bodyArrival requires finite nonnegative limits, horizontalTolerance in (0, 0.5), feetTolerance < 0.5, and positive stableMs',
    });
  }
  const target = plan.points[0]!;
  const atTarget = (sample: BodySample): boolean =>
    sample.onGround
    && !sample.inWater
    && Math.hypot(sample.pos.x - target.x, sample.pos.z - target.z) <= bodyArrival.horizontalTolerance
    && Math.abs(sample.pos.y - target.y) <= bodyArrival.feetTolerance
    && sample.velocity !== undefined
    && Math.hypot(sample.velocity.x, sample.velocity.z) <= bodyArrival.maxHorizontalSpeed
    && Math.abs(sample.velocity.y) <= bodyArrival.maxVerticalSpeed;

  if (!atTarget(initial)) {
    return notStartedResult(plan, executionId, initial, 'INVALIDATED', 'unconfirmed_arrival', {
      kind: 'unconfirmed_arrival',
      expected: { ...target },
    });
  }

  let previous = initial;
  let settledSince = initial.observedAt;
  let settledSamples = 1;
  for (let i = 0; i < 400; i++) {
    if (isAborted()) {
      return cancelledResult(plan, executionId, previous, environment, 'walk_path signal aborted during zero-edge stabilization');
    }
    if (now() >= request.deadlineMs) {
      return notStartedResult(plan, executionId, previous, 'TIMEOUT', null, { kind: 'timeout' });
    }
    await wait();
    if (isAborted()) {
      return cancelledResult(plan, executionId, previous, environment, 'walk_path signal aborted during zero-edge stabilization');
    }
    if (now() >= request.deadlineMs) {
      return notStartedResult(plan, executionId, previous, 'TIMEOUT', null, { kind: 'timeout' });
    }
    const measured = environment.sample();
    if (measured === null) {
      return planInvalidated(plan, executionId, null, 'route_body_unavailable', {
        kind: 'unavailable',
        detail: 'no measured body sample is available during zero-edge stabilization',
      });
    }
    if (measured.executionId !== executionId) continue;
    if (!isFinitePoint(measured.pos) || !Number.isFinite(measured.observedAt)) continue;
    if (
      measured.worldId !== environment.worldId ||
      measured.dim !== environment.dim ||
      measured.sessionId !== environment.sessionId
    ) {
      return planInvalidated(plan, executionId, null, 'scope_mismatch', {
        kind: 'scope_changed',
        detail: 'the measured sample world/dim/session does not match the zero-edge execution scope',
      });
    }
    if (!measured.alive || !measured.connected || !measured.observationReady) {
      return planInvalidated(plan, executionId, measured, 'route_body_unavailable', {
        kind: 'unavailable',
        detail: `the measured body is not usable: alive=${measured.alive} connected=${measured.connected} observationReady=${measured.observationReady}`,
      });
    }
    if (!Number.isSafeInteger(measured.sequence) || measured.sequence <= previous.sequence) continue;
    if (!atTarget(measured)) {
      settledSince = measured.observedAt;
      settledSamples = 1;
      previous = measured;
      continue;
    }
    const ticks = Math.max(0, measured.observedAt - previous.observedAt) / 50;
    const continuous = measured.observedAt - previous.observedAt <= Math.max(50, bodyArrival.stableMs)
      && Math.hypot(measured.pos.x - previous.pos.x, measured.pos.z - previous.pos.z)
        <= bodyArrival.maxHorizontalSpeed * ticks + 1e-9
      && Math.abs(measured.pos.y - previous.pos.y) <= bodyArrival.maxVerticalSpeed * ticks + 1e-9;
    if (!continuous) {
      settledSince = measured.observedAt;
      settledSamples = 1;
    } else {
      settledSamples += 1;
    }
    previous = measured;
    if (settledSamples >= 2 && measured.observedAt - settledSince >= bodyArrival.stableMs) {
      return zeroEdgeResult(plan, executionId, measured);
    }
  }
  return notStartedResult(plan, executionId, previous, 'TIMEOUT', null, { kind: 'timeout' });
}

/** The measured zero-edge sample is stable at the target. */
function zeroEdgeResult(plan: RoutePlan, executionId: string, sample: BodySample): WalkPathResult {
  return {
    outcome: 'ARRIVED',
    contract: CONTRACT,
    routeId: plan.routeId,
    executionId,
    lastPosition: clonePoint(sample.pos),
    lastObservation: {
      worldId: sample.worldId,
      dim: sample.dim,
      sessionId: sample.sessionId,
      observedAt: sample.observedAt,
      onGround: sample.onGround,
      inWater: sample.inWater,
    },
    confirmedSegments: 0,
    remainingPoints: [],
    consumption: { placed: [] },
    confirmed: true,
    trace: [],
  };
}

/** A pre-start cancellation that still carries the measured evidence. */
function cancelledResult(
  plan: RoutePlan,
  executionId: string,
  sample: BodySample,
  environment: WalkPathEnvironment,
  reason: string,
): WalkPathResult {
  return {
    outcome: 'CANCELLED',
    contract: CONTRACT,
    routeId: plan.routeId,
    executionId,
    ...measuredEvidence(sample),
    confirmedSegments: 0,
    remainingPoints: plan.points.map(clonePoint),
    problem: {
      kind: 'cancelled',
      by: environment.cancellationOrigin ?? 'agent',
      reason,
    },
    consumption: { placed: [] },
    confirmed: false,
    trace: [],
  };
}

/** A missing measured sample during execution is a fail-closed invalidation, not a wait. */
function bodyUnavailableResult(
  plan: RoutePlan,
  executionId: string,
  status: WalkRouteStatus,
  cancelled: NavResult,
): WalkPathResult {
  const projected = toWalkPathResult(plan, executionId, status, cancelled);
  return {
    ...projected,
    outcome: 'INVALIDATED',
    invalidation: { segment: projected.confirmedSegments, reason: 'route_body_unavailable' },
    problem: { kind: 'unavailable', detail: 'no measured body sample is available during execution' },
    confirmed: false,
  };
}

function checkStart(
  plan: RoutePlan,
  executionId: string,
  sample: BodySample,
  environment: WalkPathEnvironment,
): { reason: WalkPathInvalidationReason; problem: NavProblem } | null {
  if (sample.executionId !== executionId) {
    return {
      reason: 'route_start_unmeasured',
      problem: {
        kind: 'unavailable',
        detail: `the start sample executionId "${sample.executionId}" does not match the walkPath execution "${executionId}"`,
      },
    };
  }
  if (!isFinitePoint(sample.pos) || !Number.isFinite(sample.observedAt)) {
    return {
      reason: 'route_start_unmeasured',
      problem: {
        kind: 'unavailable',
        detail: 'the measured body sample has a non-finite position or observation time',
      },
    };
  }
  // The start sample becomes the executor's first piece of evidence. It must
  // carry the same identity contract as later samples; a missing or replayed
  // sequence is not silently replaced with a fabricated one.
  if (!Number.isSafeInteger(sample.sequence) || sample.sequence <= 0) {
    return {
      reason: 'route_start_unmeasured',
      problem: {
        kind: 'unavailable',
        detail: `the measured body sample has no valid strictly-positive sequence: ${sample.sequence}`,
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
