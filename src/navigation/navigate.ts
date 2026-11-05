/**
 * Integrated navigation pipeline (design §7 `navigate_to` / `follow_known_path`).
 *
 * The caller supplies the environment: a `WalkRouteSearch` (or a caller-computed
 * snapshot), a `WalkRouteExecutor` bound to the same map, the body context, a
 * measured sample provider, a clock, budgets and optional cancellation. This
 * module only:
 *
 * - validates the delegation at the boundary and rejects anything the walk
 *   executor cannot honor (non-walk modes, near/reach_block arrival, digging,
 *   placing, towering, material spend, non-empty avoid, frontier exploration,
 *   unknown fields) instead of silently ignoring it;
 * - echoes the measured start, returns `ARRIVED` when that measured position
 *   already satisfies the exact target, otherwise runs a bounded search;
 * - maps search conclusions to structured `NavProblem`s without presenting a
 *   candidate, an absent route or a budget stop as a world fact;
 * - hands the candidate to `WalkRouteExecutor`, which re-verifies each segment
 *   and confirms arrival from measured body samples;
 * - reports `ARRIVED` only from a confirmed executor result whose measured
 *   last position satisfies the original exact target. Cancellation, timeout,
 *   partial displacement and segmented progress are preserved as measured.
 *
 * It never digs, places, towers, spends materials, observes the world, pins
 * sections, saves storage or chooses a different target. `memoryWrite` is an
 * optional host callback; the library only carries the status the host reports.
 */

import type { MaterialAllowance } from '../adapter/types.js';
import type { WalkRouteExecutor } from '../execution/walk-route-executor.js';
import type { BodySample, WalkRouteStatus } from '../execution/types.js';
import type { ObservationGap } from '../observation/types.js';
import type { FragmentStore } from '../topology/fragment-store.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import type { BodyContext } from '../traversability/step.js';
import type { MoveMode, Vec3Like } from '../types.js';
import { startKnownWalkRoute } from './known-walk-route.js';
import type {
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  KnownWalkRouteStart,
} from './known-walk-route.js';
import type { WalkRouteSearch, WalkSearchSnapshot } from './walk-search.js';
import type {
  ActionRecord,
  ArrivalSpec,
  FollowKnownPathRequest,
  LastObservation,
  NavigateRequest,
  NavProblem,
  NavResult,
} from './types.js';

/** Where the search conclusion comes from: a caller-owned instance or an existing snapshot. */
export type NavigateSearchSource =
  | { kind: 'search'; search: WalkRouteSearch }
  | { kind: 'snapshot'; snapshot: WalkSearchSnapshot };

/** One explicit segment of a segmented delegation. Every segment must be exact. */
export interface NavigateSegment {
  destination: Vec3Like;
  arrival: ArrivalSpec;
}

/** Optional host persistence callback. `saved` must mean a real commit confirmation. */
export type NavigationMemoryWrite = (
  result: NavResult,
  record: ActionRecord,
) => 'saved' | 'pending' | 'failed' | undefined;

/** Caller-driven environment for {@link navigateTo}. */
export interface NavigateEnvironment {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Body dimensions/pose; its feet are replaced by the measured start. */
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /** Latest measured body sample for this world/dim/session, or null when unmeasured. */
  sample(): BodySample | null;
  search: NavigateSearchSource;
  /** Executor bound to the same map as the search source. */
  executor: WalkRouteExecutor;
  /** Clock; configure the same clock on the search and executor. Defaults to `Date.now`. */
  now?: () => number;
  /** Overall delegation budget in ms. Defaults to 20 000. */
  timeoutMs?: number;
  /** Per-move budget in ms. Defaults to `timeoutMs`. */
  moveTimeoutMs?: number;
  /** Absolute delegation deadline; overrides `timeoutMs` when supplied. */
  deadlineMs?: number;
  /** Search/verify edge budget per slice. Defaults to 256. */
  budget?: number;
  /** Explicit segments of the same delegation. The last must equal the target. */
  segments?: readonly NavigateSegment[];
  /** Cancellation signal owned by the caller's task. */
  signal?: AbortSignal;
  /** Provenance for a caller-signal abort; defaults to `unknown`, never `agent`. */
  cancellationOrigin?: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';
  /**
   * Cooperative wait between slices. It must yield a macrotask so body-adapter
   * timers and move results can run; defaults to a macrotask yield.
   */
  wait?: () => Promise<void>;
  /**
   * Per-delegation sequence assigned to the measured start sample. Defaults to 1.
   * The supplied MoveExecutor's own samples must continue above this number; the
   * driver never rewrites a measured observation time.
   */
  startSequence?: number;
  /** Metadata for the ActionRecord; never a control handle. */
  delegationId?: string;
  parentActionId?: string;
  onMemoryWrite?: NavigationMemoryWrite;
}

/** Caller-driven environment for {@link followKnownPath}. */
export interface FollowKnownPathEnvironment {
  history: FragmentStore;
  executor: WalkRouteExecutor;
  worldId: string;
  dim: string;
  sessionId: string;
  /** Body dimensions/pose; its feet are replaced by the measured start. */
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /** Latest measured body sample for this world/dim/session, or null when unmeasured. */
  sample(): BodySample | null;
  /** Clock; configure the same clock on the executor. Defaults to `Date.now`. */
  now?: () => number;
  timeoutMs?: number;
  moveTimeoutMs?: number;
  deadlineMs?: number;
  budget?: number;
  signal?: AbortSignal;
  /** Provenance for a caller-signal abort; defaults to `unknown`, never `agent`. */
  cancellationOrigin?: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';
  wait?: () => Promise<void>;
  /** Per-delegation sequence assigned to the measured start sample. Defaults to 1. */
  startSequence?: number;
  /** False (default) starts the route only; true drives it to a terminal result. */
  drive?: boolean;
  maxRoutePoints?: number;
  delegationId?: string;
  parentActionId?: string;
  onMemoryWrite?: NavigationMemoryWrite;
}

export interface NavigateOutcome {
  result: NavResult;
  /** Present when a measured start existed and a delegation record was built. */
  record: ActionRecord | null;
}

export type FollowKnownPathOutcome =
  | {
      kind: 'rejected';
      start: KnownWalkRouteStart | null;
      result: NavResult;
      record: ActionRecord | null;
    }
  | {
      kind: 'started';
      start: Extract<KnownWalkRouteStart, { kind: 'STARTED' }>;
      result: null;
      record: ActionRecord;
    }
  | {
      kind: 'finished';
      start: Extract<KnownWalkRouteStart, { kind: 'STARTED' }>;
      result: NavResult;
      record: ActionRecord;
    };

type Trace = { pos: Vec3Like; ts: number }[];

interface Scope {
  worldId: string;
  dim: string;
  sessionId: string;
}

interface DriveContext {
  now: () => number;
  wait: () => Promise<void>;
  signal?: AbortSignal;
  deadlineMs: number;
  budget: number;
  startSequence: number;
}

interface MeasuredStart {
  sample: BodySample;
  body: BodyContext;
}

interface SegmentRun {
  result: NavResult;
  executed: boolean;
}

interface SearchRun {
  snapshot: WalkSearchSnapshot;
}

const POS_EPS = 1e-6;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BUDGET = 256;
const KNOWN_NAVIGATE_FIELDS = new Set([
  'destination',
  'arrival',
  'allowedModes',
  'allowDigging',
  'allowPlacing',
  'allowTower',
  'materials',
  'exploration',
  'constraints',
]);
const KNOWN_SEGMENT_FIELDS = new Set(['destination', 'arrival']);
const KNOWN_CONSTRAINT_FIELDS = new Set(['avoid']);
const KNOWN_FOLLOW_FIELDS = new Set(['pathId', 'fragmentId', 'mode', 'arrival', 'constraints']);
const MOVE_MODES: readonly MoveMode[] = ['walk', 'jump', 'sneak', 'swim', 'climb', 'ladder', 'drop'];

let nextActionOrdinal = 0;

/**
 * Run one bounded walk delegation.
 *
 * `ARRIVED` is only returned after `WalkRouteExecutor` confirms a measured
 * `lastPosition` satisfying the original exact target. Search candidates,
 * function completion and coordinator messages are never arrival.
 */
export async function navigateTo(
  request: NavigateRequest,
  environment: NavigateEnvironment,
): Promise<NavigateOutcome> {
  const now = environment.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    return {
      result: failureResult('FAILED', 'the environment clock is unusable', {
        kind: 'invalid_request',
        detail: 'environment.now() must return a finite number',
      }),
      record: null,
    };
  }

  const requestProblem = validateNavigateRequest(request, environment.segments);
  if (requestProblem !== null) {
    return {
      result: failureResult('FAILED', requestMessage(requestProblem), requestProblem),
      record: null,
    };
  }
  if (environment.search.kind === 'snapshot' && (environment.segments?.length ?? 1) > 1) {
    return {
      result: failureResult('FAILED', 'a supplied search snapshot cannot execute multiple segments', {
        kind: 'invalid_request',
        detail: 'segments require a search instance so each segment can be searched from its measured start',
      }),
      record: null,
    };
  }

  const measured = readMeasuredStart(environment);
  if (isProblem(measured)) {
    return {
      result: failureResult('FAILED', measuredMessage(measured), measured),
      record: null,
    };
  }

  const timeoutMs = resolveTimeout(environment.timeoutMs, 'environment.timeoutMs');
  const deadlineMs = environment.deadlineMs ?? startedAt + timeoutMs;
  if (!Number.isFinite(deadlineMs)) {
    return {
      result: failureResult(
        'FAILED',
        'the delegation deadline is unusable',
        { kind: 'invalid_request', detail: 'environment.deadlineMs must be a finite number' },
        measured.sample,
      ),
      record: null,
    };
  }

  const ctx: DriveContext = {
    now,
    wait: environment.wait ?? defaultWait,
    ...(environment.signal === undefined ? {} : { signal: environment.signal }),
    deadlineMs,
    budget: resolveBudget(environment.budget),
    startSequence: resolveStartSequence(environment.startSequence),
  };
  const segments: readonly NavigateSegment[] =
    environment.segments ?? [{ destination: { ...request.destination }, arrival: { ...request.arrival } }];

  const id = makeActionId('nav', startedAt);
  const delegationId = environment.delegationId ?? id;
  const delegation: ActionRecord['delegation'] = {
    requestedTarget: cloneVec(request.destination),
    target: cloneVec(request.destination),
    allowedModes: [...request.allowedModes],
    arrival: cloneArrival(request.arrival),
    allowDigging: request.allowDigging,
    allowPlacing: request.allowPlacing,
    allowTower: request.allowTower,
    materials: request.materials.map(cloneMaterial),
    exploration: request.exploration,
    ...(request.constraints === undefined
      ? {}
      : { constraints: { avoid: (request.constraints.avoid ?? []).map(cloneVec) } }),
  };

  // Cancellation/deadline is checked before the already-at-target shortcut or
  // any executor start: an aborted delegation must not report ARRIVED or replace
  // an active executor delegation.
  if (ctx.signal?.aborted === true) {
    return finishNavigate(
      environment,
      cancelledResult(
        measured.sample,
        abortReason(ctx.signal),
        [],
        environment.cancellationOrigin ?? 'unknown',
      ),
      {
        id,
        delegationId,
        parentActionId: environment.parentActionId,
        startedAt,
        from: measured.sample.pos,
        executed: false,
        delegation,
        scope: environment,
      },
    );
  }
  if (ctx.now() >= ctx.deadlineMs) {
    return finishNavigate(environment, timeoutResult(measured.sample, []), {
      id,
      delegationId,
      parentActionId: environment.parentActionId,
      startedAt,
      from: measured.sample.pos,
      executed: false,
      delegation,
      scope: environment,
    });
  }

  let trace: Trace = [];
  let lastPosition: Vec3Like | undefined;
  let lastObservation: LastObservation | undefined;
  let executed = false;
  let allConfirmed = true;
  let current = measured;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (index > 0) {
      const next = readMeasuredStart(environment);
      if (isProblem(next)) {
        const result = partialOrFail(
          index,
          segments.length,
          failureWithEvidence('FAILED', nextMessage(next), next, trace, lastPosition, lastObservation),
          trace,
          lastPosition,
          lastObservation,
        );
        return finishNavigate(environment, result, {
          id,
          delegationId,
          parentActionId: environment.parentActionId,
          startedAt,
          from: measured.sample.pos,
          executed,
          delegation,
          scope: environment,
        });
      }
      current = next;
    }

    const run = await runSegment(environment, request, segment.destination, current, startedAt, ctx);
    executed ||= run.executed;
    allConfirmed &&= run.result.confirmed;
    trace = trace.concat(copyTrace(run.result.trace));
    lastPosition = run.result.lastPosition === undefined ? lastPosition : cloneVec(run.result.lastPosition);
    lastObservation =
      run.result.lastObservation === undefined ? lastObservation : cloneObservation(run.result.lastObservation);

    if (run.result.outcome === 'ARRIVED') continue;

    const result =
      index === 0
        ? run.result
        : partialOrFail(
            index,
            segments.length,
            run.result,
            trace,
            lastPosition,
            lastObservation,
          );
    return finishNavigate(environment, result, {
      id,
      delegationId,
      parentActionId: environment.parentActionId,
      startedAt,
      from: measured.sample.pos,
      executed,
      delegation,
      scope: environment,
    });
  }

  // All segments reported ARRIVED; rebuild one combined envelope from measured
  // evidence instead of returning only the last segment's trace.
  const finalTarget = segments[segments.length - 1]!.destination;
  const arrivalConfirmed =
    allConfirmed
    && lastPosition !== undefined
    && lastObservation !== undefined
    && positionsEqual(lastPosition, finalTarget);
  if (!arrivalConfirmed) {
    const result = failureWithEvidence(
      'FAILED',
      'the delegation ended without a confirmed measured position at the final target',
      { kind: 'unconfirmed_arrival', expected: cloneVec(finalTarget) },
      trace,
      lastPosition,
      lastObservation,
    );
    return finishNavigate(environment, result, {
      id,
      delegationId,
      parentActionId: environment.parentActionId,
      startedAt,
      from: measured.sample.pos,
      executed,
      delegation,
      scope: environment,
    });
  }
  const arrived: NavResult = {
    outcome: 'ARRIVED',
    message: `arrived at exact target ${fmt(finalTarget)} after ${segments.length} segments`,
    lastPosition: cloneVec(lastPosition!),
    lastObservation: cloneObservation(lastObservation!),
    confirmed: true,
    trace: copyTrace(trace),
    consumption: emptyConsumption(),
  };
  return finishNavigate(environment, arrived, {
    id,
    delegationId,
    parentActionId: environment.parentActionId,
    startedAt,
    from: measured.sample.pos,
    executed,
    delegation,
    scope: environment,
  });
}

/**
 * Follow one caller-named historical fragment (`pathId`, or the older
 * `fragmentId` alias).
 *
 * Without `environment.drive`, this only starts the delegation on the supplied
 * executor; with `drive: true` the same measured driver as {@link navigateTo}
 * runs it to a terminal `NavResult`. Non-walk modes, near/reach_block arrival
 * and non-empty `avoid` are rejected explicitly before the executor starts.
 */
export async function followKnownPath(
  request: FollowKnownPathRequest,
  environment: FollowKnownPathEnvironment,
): Promise<FollowKnownPathOutcome> {
  const requestProblem = validateFollowRequest(request);
  if (requestProblem !== null) {
    return {
      kind: 'rejected',
      start: null,
      result: failureResult('FAILED', `the follow request was rejected: ${problemDetail(requestProblem)}`, requestProblem),
      record: null,
    };
  }

  const explicitPathId = request.pathId;
  const alias = request.fragmentId;
  if (explicitPathId !== undefined && alias !== undefined && explicitPathId !== alias) {
    const message = `pathId "${explicitPathId}" and fragmentId "${alias}" name different fragments`;
    return {
      kind: 'rejected',
      start: null,
      result: failureResult('FAILED', message, { kind: 'invalid_request', detail: message }),
      record: null,
    };
  }
  const pathId = explicitPathId ?? alias;
  if (pathId === undefined) {
    const message = 'either pathId or fragmentId must name one historical fragment';
    return {
      kind: 'rejected',
      start: null,
      result: failureResult('FAILED', message, { kind: 'invalid_request', detail: message }),
      record: null,
    };
  }

  const now = environment.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    const message = 'the environment clock is unusable';
    return {
      kind: 'rejected',
      start: null,
      result: failureResult('FAILED', message, {
        kind: 'invalid_request',
        detail: 'environment.now() must return a finite number',
      }),
      record: null,
    };
  }

  const measured = readMeasuredStart(environment);
  if (isProblem(measured)) {
    return {
      kind: 'rejected',
      start: null,
      result: failureResult('FAILED', measuredMessage(measured), measured),
      record: null,
    };
  }

  const timeoutMs = resolveTimeout(environment.timeoutMs, 'environment.timeoutMs');
  const deadlineMs = environment.deadlineMs ?? startedAt + timeoutMs;
  if (!Number.isFinite(deadlineMs)) {
    const message = 'the delegation deadline is unusable';
    return {
      kind: 'rejected',
      start: null,
      result: failureResult(
        'FAILED',
        message,
        { kind: 'invalid_request', detail: 'environment.deadlineMs must be a finite number' },
        measured.sample,
      ),
      record: null,
    };
  }

  // An already-aborted or expired delegation must not start/replace the executor.
  if (environment.signal?.aborted === true) {
    return {
      kind: 'rejected',
      start: null,
      result: cancelledResult(
        measured.sample,
        abortReason(environment.signal),
        [],
        environment.cancellationOrigin ?? 'unknown',
      ),
      record: null,
    };
  }
  if (now() >= deadlineMs) {
    return {
      kind: 'rejected',
      start: null,
      result: timeoutResult(measured.sample, []),
      record: null,
    };
  }

  const walkRequest: KnownWalkRouteRequest = {
    worldId: environment.worldId,
    dim: environment.dim,
    sessionId: environment.sessionId,
    mode: request.mode,
    body: measured.body,
    arrival: request.arrival,
    shapeProvider: environment.shapeProvider,
    deadlineMs,
    timeoutMs: resolveTimeout(environment.moveTimeoutMs ?? environment.timeoutMs, 'environment.moveTimeoutMs'),
    pathId,
    ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
    ...(environment.parentActionId === undefined ? {} : { parentActionId: environment.parentActionId }),
    ...(environment.maxRoutePoints === undefined ? {} : { maxRoutePoints: environment.maxRoutePoints }),
  };

  const started = startKnownWalkRoute(environment.history, environment.executor, walkRequest);
  if (started.kind === 'REJECTED') {
    const problem = knownRejectionProblem(started.reason, request, pathId, environment, measured.sample.pos, started.message);
    return {
      kind: 'rejected',
      start: started,
      result: failureResult('FAILED', started.message, problem, measured.sample),
      record: null,
    };
  }

  const id = makeActionId('known', startedAt);
  const delegationId = environment.delegationId ?? id;
  const delegation: ActionRecord['delegation'] = {
    requestedTarget: pathId,
    target: cloneVec(started.route.target),
    allowedModes: ['walk'],
    arrival: { kind: 'exact' },
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
  };

  if (environment.drive !== true) {
    const record = buildActionRecord({
      scope: environment,
      id,
      delegationId,
      ...(environment.parentActionId === undefined ? {} : { parentActionId: environment.parentActionId }),
      ts: startedAt,
      from: measured.sample.pos,
      result: null,
      executed: false,
      delegation,
    });
    return { kind: 'started', start: started, result: null, record };
  }

  const ctx: DriveContext = {
    now,
    wait: environment.wait ?? defaultWait,
    ...(environment.signal === undefined ? {} : { signal: environment.signal }),
    deadlineMs,
    budget: resolveBudget(environment.budget),
    startSequence: resolveStartSequence(environment.startSequence),
  };
  const raw = await driveWalkRoute(environment.executor, started.status, measured.sample, started.route.target, ctx);
  const result = finalizeWalkResult(raw, started.route.target);
  const record = buildActionRecord({
    scope: environment,
    id,
    delegationId,
    ...(environment.parentActionId === undefined ? {} : { parentActionId: environment.parentActionId }),
    ts: startedAt,
    from: measured.sample.pos,
    result,
    executed: true,
    delegation,
  });
  const final = applyMemoryWrite(environment.onMemoryWrite, result, record);
  return { kind: 'finished', start: started, result: final, record };
}

// --- segment driver -------------------------------------------------------

async function runSegment(
  environment: NavigateEnvironment,
  request: NavigateRequest,
  destination: Vec3Like,
  measured: MeasuredStart,
  startedAt: number,
  ctx: DriveContext,
): Promise<SegmentRun> {
  if (positionsEqual(measured.sample.pos, destination)) {
    const result: NavResult = {
      outcome: 'ARRIVED',
      message: `already at exact target ${fmt(destination)}; no route was generated or executed`,
      lastPosition: cloneVec(measured.sample.pos),
      lastObservation: observationOf(measured.sample),
      confirmed: true,
      trace: [],
      consumption: emptyConsumption(),
    };
    return { result, executed: false };
  }
  if (ctx.signal?.aborted === true) {
    return {
      result: cancelledResult(measured.sample, abortReason(ctx.signal), []),
      executed: false,
    };
  }
  if (ctx.now() >= ctx.deadlineMs) {
    return {
      result: timeoutResult(measured.sample, []),
      executed: false,
    };
  }

  const searched = await searchForSegment(environment, destination, measured, ctx);
  if ('stopped' in searched) return { result: searched.stopped, executed: false };

  const snapshot = searched.snapshot;
  if (snapshot.state !== 'FOUND') {
    return {
      result: resultFromSearch(snapshot, measured.sample, destination, startedAt, ctx.now()),
      executed: false,
    };
  }

  const candidate = snapshot.candidate;
  if (candidate === null) {
    return {
      result: failureResult('FAILED', 'the search reported a candidate but supplied none', {
        kind: 'invalid_request',
        detail: 'a FOUND search snapshot must carry its candidate route',
      }, measured.sample),
      executed: false,
    };
  }
  if (candidate.points.length < 2) {
    return {
      result: failureResult('FAILED', 'the search reported a zero-edge candidate that was not measured as the target', {
        kind: 'unconfirmed_arrival',
        expected: cloneVec(destination),
      }, measured.sample),
      executed: false,
    };
  }
  const start = candidate.points[0]!;
  if (!positionsEqual(start, measured.sample.pos)) {
    return {
      result: failureResult('FAILED', 'the candidate route starts at a position the body was not measured at', {
        kind: 'deviation',
        expected: cloneVec(start),
        actual: cloneVec(measured.sample.pos),
      }, measured.sample),
      executed: false,
    };
  }
  if (!positionsEqual(candidate.reachedAt, destination) || !positionsEqual(candidate.target, destination)) {
    return {
      result: failureResult('FAILED', 'the candidate does not satisfy the requested exact target', {
        kind: 'unsupported_target',
        detail: 'the supplied search candidate reached a different target than this delegation',
      }, measured.sample),
      executed: false,
    };
  }

  const status = environment.executor.start({
    worldId: environment.worldId,
    dim: environment.dim,
    sessionId: environment.sessionId,
    mode: 'walk',
    body: measured.body,
    points: candidate.points,
    arrival: { kind: 'exact' },
    ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
    shapeProvider: environment.shapeProvider,
    deadlineMs: ctx.deadlineMs,
    timeoutMs: resolveTimeout(environment.moveTimeoutMs ?? environment.timeoutMs, 'environment.moveTimeoutMs'),
    startSample: measured.sample,
  });
  const result = await driveWalkRoute(environment.executor, status, measured.sample, destination, ctx);
  return { result: finalizeWalkResult(result, destination), executed: true };
}

async function searchForSegment(
  environment: NavigateEnvironment,
  destination: Vec3Like,
  measured: MeasuredStart,
  ctx: DriveContext,
): Promise<SearchRun | { stopped: NavResult }> {
  const source = environment.search;
  if (source.kind === 'snapshot') {
    const snapshot = source.snapshot;
    const mismatch = snapshotMismatch(snapshot, environment, destination, measured.sample);
    if (mismatch !== null) {
      return {
        stopped: failureResult('FAILED', mismatch, {
          kind: 'invalid_request',
          detail: mismatch,
        }, measured.sample),
      };
    }
    if (snapshot.state === 'PENDING') {
      return {
        stopped: failureResult('FAILED', 'the supplied search snapshot is still pending', {
          kind: 'unavailable',
          detail: 'a supplied snapshot must be a terminal search conclusion',
        }, measured.sample),
      };
    }
    return { snapshot };
  }

  let snapshot = source.search.start({
    worldId: environment.worldId,
    dim: environment.dim,
    sessionId: environment.sessionId,
    mode: 'walk',
    body: measured.body,
    target: cloneVec(destination),
    arrival: { kind: 'exact' },
    shapeProvider: environment.shapeProvider,
  });
  while (snapshot.state === 'PENDING') {
    if (ctx.signal?.aborted === true) {
      source.search.cancel(abortReason(ctx.signal));
      return {
        stopped: cancelledResult(measured.sample, abortReason(ctx.signal), []),
      };
    }
    if (ctx.now() >= ctx.deadlineMs) {
      source.search.cancel('navigation deadline exceeded');
      return { stopped: timeoutResult(measured.sample, []) };
    }
    snapshot = source.search.advance(ctx.budget);
  }
  if (snapshot.state === 'CANCELLED') {
    return {
      stopped: cancelledResult(
        measured.sample,
        snapshot.cancellation?.reason ?? snapshot.reason,
        [],
      ),
    };
  }
  return { snapshot };
}

function snapshotMismatch(
  snapshot: WalkSearchSnapshot,
  environment: NavigateEnvironment,
  destination: Vec3Like,
  sample: BodySample,
): string | null {
  if (snapshot.worldId !== environment.worldId || snapshot.dim !== environment.dim
    || snapshot.sessionId !== environment.sessionId) {
    return 'the supplied snapshot belongs to a different world/dimension/session';
  }
  if (snapshot.mode !== 'walk') return `the supplied snapshot used mode "${snapshot.mode}", not walk`;
  if (snapshot.arrival.kind !== 'exact') return 'the supplied snapshot used a non-exact arrival condition';
  if (!positionsEqual(snapshot.target, destination)) return 'the supplied snapshot targeted a different destination';
  if (!positionsEqual(snapshot.from, sample.pos)) return 'the supplied snapshot started from a different measured position';
  return null;
}

// --- executor driver ------------------------------------------------------

async function driveWalkRoute(
  executor: WalkRouteExecutor,
  initial: WalkRouteStatus,
  sample: BodySample,
  target: Vec3Like,
  ctx: DriveContext,
): Promise<NavResult> {
  if (initial.result !== null) return finalizeWalkResult(initial.result, target);

  const bound: BodySample = {
    ...sample,
    pos: cloneVec(sample.pos),
    executionId: initial.delegationId,
    sequence: ctx.startSequence,
  };
  let status = executor.onSample(bound);

  while (status.result === null) {
    if (ctx.signal?.aborted === true) {
      return executor.cancel('agent', abortReason(ctx.signal));
    }
    if (ctx.now() >= ctx.deadlineMs) {
      return asTimeout(executor.cancel('scheduler', 'navigation deadline exceeded'));
    }

    status = executor.advance(ctx.budget);
    if (status.result !== null) break;

    await ctx.wait();
    status = executor.status()!;
    if (status.result !== null) break;

    status = executor.checkTimeout();
  }
  return finalizeWalkResult(status.result, target);
}

/** Verify the executor's arrival against the original exact target; never trust the label alone. */
function finalizeWalkResult(result: NavResult, target: Vec3Like): NavResult {
  if (result.outcome !== 'ARRIVED') return withConsumption(result);
  const arrivalOk = result.confirmed === true
    && positionsEqual(result.lastPosition, target)
    && result.lastObservation !== undefined;
  if (arrivalOk) return withConsumption(result);
  return failureWithEvidence(
    'FAILED',
    'the executor reported arrival without a measured position satisfying the exact target',
    { kind: 'unconfirmed_arrival', expected: cloneVec(target) },
    result.trace,
    result.lastPosition,
    result.lastObservation,
  );
}

// --- search result mapping ------------------------------------------------

function resultFromSearch(
  snapshot: WalkSearchSnapshot,
  sample: BodySample,
  destination: Vec3Like,
  startedAt: number,
  now: number,
): NavResult {
  const from = snapshot.from;
  switch (snapshot.state) {
    case 'NO_VERIFIED_PATH':
      return failureResult(
        'NO_PATH',
        `no walk route was found from ${fmt(from)} to ${fmt(destination)} within the currently verified evidence; ` +
          'this does not establish that the target is unreachable in the world',
        { kind: 'no_path' },
        sample,
      );
    case 'INSUFFICIENT_EVIDENCE':
      return failureResult(
        'FAILED',
        `the bounded walk search stopped at ${fmt(from)} with insufficient evidence: ` +
          `${snapshot.counters.edgesUnknown} unknown and ${snapshot.counters.edgesStale} stale edges were not treated as passable`,
        { kind: 'unobserved', gap: searchGap(snapshot, destination) },
        sample,
      );
    case 'UNSUPPORTED': {
      const problem = snapshot.problem;
      if (problem?.kind === 'unsupported_mode') {
        return failureResult('FAILED', `mode "${problem.mode}" is not supported by the walk pipeline: ${problem.detail}`, problem, sample);
      }
      if (problem?.kind === 'unsupported_target') {
        return failureResult('FAILED', `this walk pipeline cannot satisfy the requested target: ${problem.detail}`, problem, sample);
      }
      return failureResult('FAILED', `the walk pipeline cannot represent this request: ${snapshot.reason}`, {
        kind: 'unsupported_target',
        detail: snapshot.reason,
      }, sample);
    }
    case 'BUDGET_EXHAUSTED':
      return failureResult(
        'FAILED',
        'the bounded search exhausted its node/edge budget before finding a route; this is not evidence of a physical obstacle',
        { kind: 'search_budget_exhausted', budgetMs: Math.max(0, now - startedAt) },
        sample,
      );
    case 'CANCELLED':
      return cancelledResult(sample, snapshot.cancellation?.reason ?? snapshot.reason, []);
    case 'INVALIDATED':
      return failureResult('FAILED', `the search was invalidated: ${snapshot.reason}`, {
        kind: 'route_invalidated',
        detail: snapshot.reason,
      }, sample);
    case 'PENDING':
      return failureResult('FAILED', 'the search is still pending', {
        kind: 'unavailable',
        detail: 'a pending search is not a terminal navigation result',
      }, sample);
    case 'FOUND':
      // A found candidate without a usable route is handled by the caller.
      return failureResult('FAILED', 'the search returned a candidate that could not be executed', {
        kind: 'unavailable',
        detail: 'the candidate route is missing or outside the walk executor contract',
      }, sample);
  }
}

function searchGap(snapshot: WalkSearchSnapshot, target: Vec3Like): ObservationGap {
  const diagnostic = snapshot.diagnostics.find(
    (entry) => entry.status === 'UNKNOWN' || entry.status === 'STALE' || entry.status === 'UNSUPPORTED',
  );
  if (diagnostic !== undefined) return { pos: cloneVec(diagnostic.to), reason: 'unknown' };
  const unavailable = snapshot.unavailableHistorical[0];
  if (unavailable !== undefined) return { pos: cloneVec(unavailable.to), reason: 'unloaded' };
  const frontier = snapshot.frontiers[0];
  if (frontier !== undefined) return { pos: cloneVec(frontier.to), reason: 'unknown' };
  return { pos: cloneVec(target), reason: 'unknown' };
}

// --- request validation ---------------------------------------------------

function validateNavigateRequest(
  request: NavigateRequest,
  segments: readonly NavigateSegment[] | undefined,
): NavProblem | null {
  for (const key of Object.keys(request)) {
    if (!KNOWN_NAVIGATE_FIELDS.has(key)) {
      return { kind: 'invalid_request', detail: `unknown request field "${key}"` };
    }
  }
  if (!isVec3(request.destination)) {
    return { kind: 'invalid_request', detail: 'destination must contain finite x, y and z numbers' };
  }
  if (!isArrivalSpec(request.arrival)) {
    return { kind: 'invalid_request', detail: 'arrival must be exact, near or reach_block' };
  }
  if (request.arrival.kind !== 'exact') {
    return {
      kind: 'unsupported_target',
      detail: `arrival kind "${request.arrival.kind}" is not supported; this pipeline confirms only an exact foot position`,
    };
  }
  if (!Array.isArray(request.allowedModes)) {
    return { kind: 'invalid_request', detail: 'allowedModes must be an array of movement modes' };
  }
  if (request.allowedModes.length === 0) {
    return {
      kind: 'unsupported_mode',
      mode: 'walk',
      detail: 'allowedModes must explicitly include "walk"; an empty list permits no movement',
    };
  }
  for (const mode of request.allowedModes) {
    const known = (MOVE_MODES as readonly string[]).includes(mode);
    if (!known) return { kind: 'invalid_request', detail: `unknown movement mode "${String(mode)}"` };
    if (mode !== 'walk') {
      return {
        kind: 'unsupported_mode',
        mode,
        detail: 'this pipeline executes only walk steps; jump, swim, climb and other modes are not implemented',
      };
    }
  }
  for (const field of ['allowDigging', 'allowPlacing', 'allowTower'] as const) {
    if (typeof request[field] !== 'boolean') {
      return { kind: 'invalid_request', detail: `${field} must be a boolean` };
    }
  }
  if (request.allowDigging) {
    return {
      kind: 'not_authorized',
      detail: 'digging is not implemented by this walk pipeline; the request was rejected rather than silently ignored',
    };
  }
  if (request.allowPlacing) {
    return {
      kind: 'not_authorized',
      detail: 'placing is not implemented by this walk pipeline; the request was rejected rather than silently ignored',
    };
  }
  if (request.allowTower) {
    return {
      kind: 'not_authorized',
      detail: 'towering is not implemented by this walk pipeline; the request was rejected rather than silently ignored',
    };
  }
  if (!Array.isArray(request.materials)) {
    return { kind: 'invalid_request', detail: 'materials must be an array of material allowances' };
  }
  for (const material of request.materials) {
    if (!isMaterialAllowance(material)) {
      return { kind: 'invalid_request', detail: 'materials entries require a name and a finite non-negative maxCount' };
    }
  }
  if (request.materials.length > 0) {
    return {
      kind: 'not_authorized',
      detail: 'material spending is not implemented by this walk pipeline; a non-empty materials list cannot be honored',
    };
  }
  if (request.exploration !== 'known_only' && request.exploration !== 'allow_frontier') {
    return { kind: 'invalid_request', detail: 'exploration must be "known_only" or "allow_frontier"' };
  }
  if (request.exploration !== 'known_only') {
    return {
      kind: 'not_authorized',
      detail: 'frontier exploration is not implemented by this pipeline; only known, verified space is searched',
    };
  }
  if (request.constraints !== undefined) {
    if (typeof request.constraints !== 'object' || request.constraints === null) {
      return { kind: 'invalid_request', detail: 'constraints must be an object' };
    }
    for (const key of Object.keys(request.constraints)) {
      if (!KNOWN_CONSTRAINT_FIELDS.has(key)) {
        return { kind: 'invalid_request', detail: `unknown constraint field "${key}"` };
      }
    }
    const avoid = request.constraints.avoid;
    if (avoid !== undefined) {
      if (!Array.isArray(avoid)) {
        return { kind: 'invalid_request', detail: 'constraints.avoid must be an array of positions' };
      }
      if (!avoid.every(isVec3)) {
        return { kind: 'invalid_request', detail: 'constraints.avoid entries must contain finite x, y and z numbers' };
      }
      if (avoid.length > 0) {
        return {
          kind: 'not_authorized',
          detail: 'a non-empty avoid constraint is not consumed by the walk evaluator and cannot be silently ignored',
        };
      }
    }
  }
  if (segments !== undefined) {
    if (!Array.isArray(segments) || segments.length === 0) {
      return { kind: 'invalid_request', detail: 'segments must be a non-empty array' };
    }
    for (const segment of segments) {
      for (const key of Object.keys(segment)) {
        if (!KNOWN_SEGMENT_FIELDS.has(key)) {
          return { kind: 'invalid_request', detail: `unknown segment field "${key}"` };
        }
      }
      if (!isVec3(segment.destination)) {
        return { kind: 'invalid_request', detail: 'each segment destination must contain finite x, y and z numbers' };
      }
      if (!isArrivalSpec(segment.arrival)) {
        return { kind: 'invalid_request', detail: 'each segment arrival must be exact, near or reach_block' };
      }
      if (segment.arrival.kind !== 'exact') {
        return {
          kind: 'unsupported_target',
          detail: `segment arrival kind "${segment.arrival.kind}" is not supported; only exact foot positions are executed`,
        };
      }
    }
    const last = segments[segments.length - 1]!;
    if (!positionsEqual(last.destination, request.destination)) {
      return {
        kind: 'invalid_request',
        detail: 'the last explicit segment must end at the original exact destination',
      };
    }
  }
  return null;
}

function validateFollowRequest(request: FollowKnownPathRequest): NavProblem | null {
  for (const key of Object.keys(request)) {
    if (!KNOWN_FOLLOW_FIELDS.has(key)) {
      return { kind: 'invalid_request', detail: `unknown request field "${key}"` };
    }
  }
  for (const id of [request.pathId, request.fragmentId]) {
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      return { kind: 'invalid_request', detail: 'pathId and fragmentId must be non-empty strings when supplied' };
    }
  }
  if (typeof request.mode !== 'string' || !(MOVE_MODES as readonly string[]).includes(request.mode)) {
    return { kind: 'invalid_request', detail: `unknown movement mode "${String(request.mode)}"` };
  }
  if (request.mode !== 'walk') {
    return {
      kind: 'unsupported_mode',
      mode: request.mode,
      detail: 'only walk can follow a historical route; other modes are not implemented',
    };
  }
  if (!isArrivalSpec(request.arrival)) {
    return { kind: 'invalid_request', detail: 'arrival must be exact, near or reach_block' };
  }
  if (request.arrival.kind !== 'exact') {
    return {
      kind: 'unsupported_target',
      detail: `arrival kind "${request.arrival.kind}" is not supported; only exact foot-position arrival is executed`,
    };
  }
  if (request.constraints !== undefined) {
    if (typeof request.constraints !== 'object' || request.constraints === null) {
      return { kind: 'invalid_request', detail: 'constraints must be an object' };
    }
    for (const key of Object.keys(request.constraints)) {
      if (!KNOWN_CONSTRAINT_FIELDS.has(key)) {
        return { kind: 'invalid_request', detail: `unknown constraint field "${key}"` };
      }
    }
    const avoid = request.constraints.avoid;
    if (avoid !== undefined) {
      if (!Array.isArray(avoid) || !avoid.every(isVec3)) {
        return { kind: 'invalid_request', detail: 'constraints.avoid must be an array of finite positions' };
      }
      if (avoid.length > 0) {
        return {
          kind: 'not_authorized',
          detail: 'a non-empty avoid constraint is not consumed by the walk evaluator and cannot be silently ignored',
        };
      }
    }
  }
  return null;
}

function isArrivalSpec(value: unknown): value is ArrivalSpec {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'exact' || kind === 'reach_block') return true;
  if (kind === 'near') {
    const radius = (value as { radius?: unknown }).radius;
    return typeof radius === 'number' && Number.isFinite(radius) && radius >= 0;
  }
  return false;
}

function isVec3(value: unknown): value is Vec3Like {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return typeof v.x === 'number' && Number.isFinite(v.x)
    && typeof v.y === 'number' && Number.isFinite(v.y)
    && typeof v.z === 'number' && Number.isFinite(v.z);
}

function isMaterialAllowance(value: unknown): value is MaterialAllowance {
  if (typeof value !== 'object' || value === null) return false;
  const material = value as { name?: unknown; maxCount?: unknown };
  return typeof material.name === 'string' && material.name.length > 0
    && typeof material.maxCount === 'number' && Number.isFinite(material.maxCount) && material.maxCount >= 0;
}

// --- measured start -------------------------------------------------------

function readMeasuredStart(environment: {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  sample(): BodySample | null;
}): MeasuredStart | NavProblem {
  const sample = environment.sample();
  if (sample === null) {
    return {
      kind: 'unavailable',
      detail: 'no measured body sample is available; the starting position is unconfirmed',
    };
  }
  if (!isVec3(sample.pos) || !Number.isFinite(sample.observedAt)) {
    return {
      kind: 'unavailable',
      detail: 'the measured body sample has non-finite position or observation time',
    };
  }
  if (sample.worldId !== environment.worldId || sample.dim !== environment.dim
    || sample.sessionId !== environment.sessionId) {
    return {
      kind: 'scope_changed',
      detail: 'the measured sample world/dim/session does not match this delegation',
    };
  }
  if (!sample.alive || !sample.connected || !sample.observationReady) {
    return {
      kind: 'unavailable',
      detail: `the measured body is not usable: alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
    };
  }
  const body = environment.body;
  if (!Number.isFinite(body.width) || !Number.isFinite(body.height) || body.width <= 0 || body.height <= 0) {
    return {
      kind: 'invalid_request',
      detail: 'environment.body width and height must be finite positive numbers',
    };
  }
  return {
    sample,
    body: { feet: cloneVec(sample.pos), width: body.width, height: body.height, pose: body.pose },
  };
}

function isProblem(value: MeasuredStart | NavProblem): value is NavProblem {
  return 'kind' in value;
}

// --- known-route rejection mapping ---------------------------------------

function knownRejectionProblem(
  reason: KnownWalkRouteRejectionReason,
  request: FollowKnownPathRequest,
  pathId: string,
  environment: FollowKnownPathEnvironment,
  actual: Vec3Like,
  message: string,
): NavProblem {
  switch (reason) {
    case 'missing_path_id':
    case 'ambiguous_path':
      return { kind: 'invalid_request', detail: message };
    case 'missing_history':
      return { kind: 'unavailable', detail: message };
    case 'wrong_scope':
      return { kind: 'scope_changed', detail: message };
    case 'unsupported_geometry':
      return { kind: 'unsupported_target', detail: message };
    case 'unsupported_mode':
      return { kind: 'unsupported_mode', mode: request.mode, detail: message };
    case 'unsupported_arrival':
      return { kind: 'unsupported_target', detail: message };
    case 'unsupported_constraint':
      return { kind: 'not_authorized', detail: message };
    case 'wrong_start': {
      const start = environment.history.getFragment(pathId)?.polyline[0];
      return start === undefined
        ? { kind: 'unavailable', detail: message }
        : { kind: 'deviation', expected: cloneVec(start), actual: cloneVec(actual) };
    }
    case 'route_budget':
      return { kind: 'unavailable', detail: message };
  }
}

// --- result helpers -------------------------------------------------------

function failureResult(
  outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED',
  message: string,
  problem: NavProblem,
  sample?: BodySample,
  trace: Trace = [],
): NavResult {
  const base = {
    outcome,
    message,
    problem,
    confirmed: false as const,
    trace: copyTrace(trace),
    consumption: emptyConsumption(),
  };
  return sample === undefined
    ? base
    : {
        ...base,
        lastPosition: cloneVec(sample.pos),
        lastObservation: observationOf(sample),
      };
}

function failureWithEvidence(
  outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED',
  message: string,
  problem: NavProblem,
  trace: Trace,
  lastPosition: Vec3Like | undefined,
  lastObservation: LastObservation | undefined,
): NavResult {
  const base = {
    outcome,
    message,
    problem,
    confirmed: false as const,
    trace: copyTrace(trace),
    consumption: emptyConsumption(),
  };
  if (lastPosition === undefined || lastObservation === undefined) return base;
  return {
    ...base,
    lastPosition: cloneVec(lastPosition),
    lastObservation: cloneObservation(lastObservation),
  };
}

function cancelledResult(
  sample: BodySample,
  reason: string,
  trace: Trace,
  by: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown' = 'unknown',
): NavResult {
  return failureResult(
    'CANCELLED',
    `navigation was cancelled before the exact target was confirmed: ${reason}`,
    { kind: 'cancelled', by, reason },
    sample,
    trace,
  );
}

function timeoutResult(sample: BodySample, trace: Trace): NavResult {
  return failureResult(
    'TIMEOUT',
    'the navigation deadline was exceeded before the exact target was confirmed',
    { kind: 'timeout' },
    sample,
    trace,
  );
}

function asTimeout(cancelled: NavResult): NavResult {
  const base = {
    outcome: 'TIMEOUT' as const,
    message: 'the navigation deadline was exceeded before the exact target was confirmed',
    problem: { kind: 'timeout' } satisfies NavProblem,
    confirmed: false as const,
    trace: copyTrace(cancelled.trace),
    consumption: emptyConsumption(),
  };
  if (cancelled.lastPosition === undefined || cancelled.lastObservation === undefined) return base;
  return {
    ...base,
    lastPosition: cloneVec(cancelled.lastPosition),
    lastObservation: cloneObservation(cancelled.lastObservation),
  };
}

function withConsumption(result: NavResult): NavResult {
  return result.consumption === undefined ? { ...result, consumption: emptyConsumption() } : result;
}

function partialOrFail(
  completedSegments: number,
  totalSegments: number,
  failure: NavResult,
  trace: Trace,
  lastPosition: Vec3Like | undefined,
  lastObservation: LastObservation | undefined,
): NavResult {
  if (completedSegments === 0) return failure;
  const problem = failure.problem ?? {
    kind: 'unavailable',
    detail: 'the later segment failed without a structured problem',
  };
  const evidence =
    failure.lastPosition !== undefined && failure.lastObservation !== undefined
      ? { lastPosition: cloneVec(failure.lastPosition), lastObservation: cloneObservation(failure.lastObservation) }
      : lastPosition !== undefined && lastObservation !== undefined
        ? { lastPosition: cloneVec(lastPosition), lastObservation: cloneObservation(lastObservation) }
        : {};
  return {
    outcome: 'PARTIAL',
    message: `completed ${completedSegments} of ${totalSegments} explicit segments; ${failure.message}`,
    problem,
    confirmed: false,
    trace: copyTrace(trace),
    consumption: emptyConsumption(),
    ...evidence,
  };
}

function finishNavigate(
  environment: NavigateEnvironment,
  result: NavResult,
  input: {
    id: string;
    delegationId: string;
    parentActionId: string | undefined;
    startedAt: number;
    from: Vec3Like;
    executed: boolean;
    delegation: ActionRecord['delegation'];
    scope: Scope;
  },
): NavigateOutcome {
  const record = buildActionRecord({
    scope: input.scope,
    id: input.id,
    delegationId: input.delegationId,
    ...(input.parentActionId === undefined ? {} : { parentActionId: input.parentActionId }),
    ts: input.startedAt,
    from: input.from,
    result,
    executed: input.executed,
    delegation: input.delegation,
  });
  const final = applyMemoryWrite(environment.onMemoryWrite, result, record);
  return { result: final, record };
}

function buildActionRecord(input: {
  scope: Scope;
  id: string;
  delegationId: string;
  parentActionId?: string;
  ts: number;
  from: Vec3Like;
  result: NavResult | null;
  executed: boolean;
  delegation: ActionRecord['delegation'];
}): ActionRecord {
  const result = input.result;
  const trace = result === null ? [] : copyTrace(result.trace);
  const lastConfirmed = trace.length > 0 ? trace[trace.length - 1]!.pos : input.from;
  const subActions: ActionRecord['subActions'] = trace.map((entry) => ({
    kind: 'walk',
    at: cloneVec(entry.pos),
    origin: 'execution_helper',
    targetRole: 'body',
    outcome: 'ok',
  }));
  if (result !== null && result.lastPosition !== undefined && !positionsEqual(result.lastPosition, lastConfirmed)) {
    subActions.push({
      kind: 'walk',
      at: cloneVec(result.lastPosition),
      origin: 'execution_helper',
      targetRole: 'body',
      outcome: result.outcome === 'CANCELLED' || result.outcome === 'TIMEOUT' || result.outcome === 'PARTIAL'
        ? 'cancelled'
        : result.outcome === 'ARRIVED'
          ? 'ok'
          : 'unknown',
    });
  }
  const record: ActionRecord = {
    id: input.id,
    ts: input.ts,
    worldId: input.scope.worldId,
    dim: input.scope.dim,
    sessionId: input.scope.sessionId,
    delegationId: input.delegationId,
    ...(input.parentActionId === undefined ? {} : { parentActionId: input.parentActionId }),
    delegation: {
      ...input.delegation,
      requestedTarget:
        typeof input.delegation.requestedTarget === 'string'
          ? input.delegation.requestedTarget
          : cloneVec(input.delegation.requestedTarget),
      target: cloneVec(input.delegation.target),
      allowedModes: [...input.delegation.allowedModes],
      arrival: cloneArrival(input.delegation.arrival),
      materials: input.delegation.materials.map(cloneMaterial),
      ...(input.delegation.constraints === undefined
        ? {}
        : { constraints: { avoid: (input.delegation.constraints.avoid ?? []).map(cloneVec) } }),
    },
    subActions,
    from: cloneVec(input.from),
    trace,
    consumption: result?.consumption === undefined
      ? emptyConsumption()
      : {
          placed: result.consumption.placed.map((entry) => ({ pos: cloneVec(entry.pos), name: entry.name })),
          ...(result.consumption.durabilityLost === undefined
            ? {}
            : { durabilityLost: result.consumption.durabilityLost }),
          ...(result.consumption.digMs === undefined ? {} : { digMs: result.consumption.digMs }),
        },
    observedChanges: [],
    confirmed: result !== null && result.outcome === 'ARRIVED' && result.confirmed,
  };
  if (result !== null) {
    if (result.lastPosition !== undefined) record.to = cloneVec(result.lastPosition);
    if (result.outcome !== 'ARRIVED') {
      record.failureReason = result.message;
      if (input.executed && result.lastPosition !== undefined) record.failureAt = cloneVec(result.lastPosition);
    }
  }
  return record;
}

function applyMemoryWrite(
  callback: NavigationMemoryWrite | undefined,
  result: NavResult,
  record: ActionRecord,
): NavResult {
  const status = callback?.(result, record);
  const final: NavResult =
    status === 'saved' || status === 'pending' || status === 'failed'
      ? { ...result, memoryWrite: status }
      : result;
  record.result = final;
  return final;
}

// --- misc helpers ---------------------------------------------------------

function resolveTimeout(value: number | undefined, label: string): number {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive finite number: ${resolved}`);
  }
  return resolved;
}

function resolveBudget(value: number | undefined): number {
  const resolved = value ?? DEFAULT_BUDGET;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`environment.budget must be a positive safe integer: ${resolved}`);
  }
  return resolved;
}

function resolveStartSequence(value: number | undefined): number {
  const resolved = value ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`environment.startSequence must be a positive safe integer: ${resolved}`);
  }
  return resolved;
}

function defaultWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return 'navigation aborted by caller';
}

function observationOf(sample: BodySample): LastObservation {
  return {
    worldId: sample.worldId,
    dim: sample.dim,
    sessionId: sample.sessionId,
    observedAt: sample.observedAt,
    onGround: sample.onGround,
    inWater: sample.inWater,
    // `riding` is not part of a body sample; absent means "not provided".
  };
}

function emptyConsumption(): { placed: { pos: Vec3Like; name: string }[] } {
  return { placed: [] };
}

function makeActionId(prefix: string, startedAt: number): string {
  nextActionOrdinal += 1;
  return `${prefix}-${startedAt}-${nextActionOrdinal}`;
}

function requestMessage(problem: NavProblem): string {
  return `the navigation request was rejected: ${problemDetail(problem)}`;
}

function measuredMessage(problem: NavProblem): string {
  return `navigation cannot start: ${problemDetail(problem)}`;
}

function nextMessage(problem: NavProblem): string {
  return `the next explicit segment cannot start: ${problemDetail(problem)}`;
}

function problemDetail(problem: NavProblem): string {
  switch (problem.kind) {
    case 'invalid_request':
    case 'unsupported_target':
    case 'not_authorized':
    case 'unsupported_mode':
    case 'unavailable':
    case 'route_invalidated':
    case 'scope_changed':
    case 'execution_failed':
    case 'unobserved':
      return problem.kind === 'unobserved' ? `unobserved cell at ${fmt(problem.gap.pos)}` : problem.detail;
    case 'no_path':
      return 'no verified walk route was found';
    case 'timeout':
      return 'the deadline was exceeded';
    case 'cancelled':
      return `cancelled by ${problem.by}: ${problem.reason}`;
    case 'blocked':
    case 'head_blocked':
      return 'a required body cell is blocked';
    case 'unloaded':
    case 'stale':
      return `${problem.kind} evidence at ${fmt(problem.pos)}`;
    case 'hazard':
      return `hazard conflict: ${problem.constraint}`;
    case 'search_budget_exhausted':
      return `the bounded search used its ${problem.budgetMs}ms budget`;
    case 'occupied':
      return `a player occupies ${fmt(problem.pos)}`;
    case 'support_out_of_reach':
      return `support at ${fmt(problem.requiredSupport)} is out of reach`;
    case 'deviation':
      return `the body was at ${fmt(problem.actual)}, not ${fmt(problem.expected)}`;
    case 'unconfirmed_arrival':
      return `arrival at ${fmt(problem.expected)} was not confirmed`;
    case 'unmeasured_position':
      return `no measured body position confirms ${fmt(problem.expected)}`;
    case 'support_missing':
      return `support missing at ${fmt(problem.pos)}: ${problem.detail}`;
  }
}

function cloneVec(p: Vec3Like): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}

function cloneArrival(arrival: ArrivalSpec): ArrivalSpec {
  return arrival.kind === 'near' ? { kind: 'near', radius: arrival.radius } : { kind: arrival.kind };
}

function cloneMaterial(material: MaterialAllowance): MaterialAllowance {
  return { name: material.name, maxCount: material.maxCount };
}

function cloneObservation(observation: LastObservation): LastObservation {
  return {
    worldId: observation.worldId,
    dim: observation.dim,
    sessionId: observation.sessionId,
    observedAt: observation.observedAt,
    onGround: observation.onGround,
    inWater: observation.inWater,
    ...(observation.riding === undefined ? {} : { riding: observation.riding }),
  };
}

function copyTrace(trace: Trace): Trace {
  return trace.map((entry) => ({ pos: cloneVec(entry.pos), ts: entry.ts }));
}

function positionsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return Math.abs(a.x - b.x) <= POS_EPS
    && Math.abs(a.y - b.y) <= POS_EPS
    && Math.abs(a.z - b.z) <= POS_EPS;
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
