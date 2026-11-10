/**
 * Read-only route planning entry (contract §6, plan M3.3–M3.5).
 *
 * `planRoute` is the optional navigation layer's planning boundary. It:
 *
 * - validates every request field at the boundary (unknown fields rejected);
 * - takes the start from a measured `BodySample`, never from the request target;
 * - runs the supplied bounded voxel search for `source:'search'` and
 *   `source:'auto'`; reads one explicit historical fragment only for
 *   `source:'history'`;
 * - re-verifies the selected points through `RouteVerifier` and reports
 *   `verified`/`candidate` from current evidence;
 * - returns ordered boundaries, structured unsupported/budget/evidence
 *   problems, and a measured `routeId` issued by the registry.
 *
 * It never moves, turns, observes, writes the library, pins Sections, spends
 * materials or calls `navigateTo`/an executor/pathfinder. Planning carries no
 * execution authorization: `executable` is only a statement that the current
 * evidence supports the walk geometry for the measured start and exact target.
 */

import { MOVE_MODES } from '../topology/path-fragment.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type {
  CancellationOrigin,
  RoutePlanDraft,
  RoutePlanEnvironment,
  RoutePlanRequest,
  RoutePlanResult,
  RoutePlanSource,
  RouteUnsupported,
} from './route-plan-types.js';
import type { RouteSearchSource } from './route-search.js';
import type { WalkSearchSnapshot } from './walk-search.js';
import type { NavProblem } from './types.js';
import { RoutePlanRegistryCapacityError } from './route-plan-registry.js';
import { buildHistoryPlan } from './route-plan-history.js';
import {
  DEFAULT_BUDGET_PER_SLICE,
  DEFAULT_MAX_ROUTE_POINTS,
  DEFAULT_PLAN_TTL_MS,
  abortReason,
  assemblePlan,
  clonePoint,
  defaultWait,
  emptyVerification,
  isFinitePoint,
  planScope,
  positionsEqual,
  problemFromSearch,
  readMeasuredStart,
  verifyRoutePoints,
} from './route-plan-support.js';
import type { MeasuredPlanStart } from './route-plan-support.js';
import type { ArrivalSpec } from './types.js';

const KNOWN_REQUEST_FIELDS = new Set([
  'to',
  'mode',
  'source',
  'pathId',
  'arrival',
  'constraints',
  'deadlineMs',
]);
const KNOWN_CONSTRAINT_FIELDS = new Set(['avoid', 'maxNodes', 'maxEdges']);
const KNOWN_ARRIVAL_FIELDS = new Set(['kind', 'radius']);

/** Absolute implementation caps for request-supplied search budgets. */
const ABSOLUTE_MAX_NODES = 2048;
const ABSOLUTE_MAX_EDGES = 8192;

interface PlanContext {
  environment: RoutePlanEnvironment;
  request: RoutePlanRequest;
  start: MeasuredPlanStart;
  now: () => number;
  deadlineMs: number;
  budget: number;
  planTtlMs: number;
  maxRoutePoints: number;
  wait: () => Promise<void>;
  cancellationOrigin: CancellationOrigin;
}

type PlanOutcome = { draft: RoutePlanDraft } | { problem: NavProblem | RouteUnsupported; message: string };

/**
 * Plan one walk route. The returned `routeId` is volatile and single-use; it is
 * not an arrival, a permission or a promise that execution will succeed.
 */
export async function planRoute(
  request: RoutePlanRequest,
  environment: RoutePlanEnvironment,
): Promise<RoutePlanResult> {
  const result = await planRouteCore(request, environment);
  // The result is final before the persistence hook is touched; the hook
  // settles after the caller already has it and cannot change it. A failure is
  // reported through `onPersistenceFailure`, never through the result.
  const persist = environment.persistAction;
  if (persist !== undefined) {
    void Promise.resolve()
      .then(() => persist(environment.actionRecord ?? null))
      .catch((error: unknown) => environment.onPersistenceFailure?.(error));
  }
  return result;
}

async function planRouteCore(
  request: RoutePlanRequest,
  environment: RoutePlanEnvironment,
): Promise<RoutePlanResult> {
  const now = environment.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new Error(`route planning now() must return a finite number: ${startedAt}`);
  }
  const validated = validateRequest(request, startedAt);
  if (validated.problem !== undefined) {
    return { problem: validated.problem, message: validated.message };
  }

  if (environment.signal?.aborted === true) {
    return {
      problem: {
        kind: 'cancelled',
        by: environment.cancellationOrigin ?? 'unknown',
        reason: abortReason(environment.signal),
      },
      message: 'route planning was cancelled before it started',
    };
  }

  const measured = readMeasuredStart(environment);
  if ('problem' in measured) return { problem: measured.problem, message: measured.message };

  const config = resolveConfig(environment);
  if ('problem' in config) return { problem: config.problem, message: config.message };

  const context: PlanContext = {
    environment,
    request: validated.request,
    start: measured,
    now,
    deadlineMs: validated.request.deadlineMs,
    budget: config.budgetPerSlice,
    planTtlMs: config.planTtlMs,
    maxRoutePoints: config.maxRoutePoints,
    wait: environment.wait ?? defaultWait,
    cancellationOrigin: environment.cancellationOrigin ?? 'unknown',
  };

  const outcome = await planBySource(context);
  return finalizeOutcome(context, outcome);
}

async function planBySource(context: PlanContext): Promise<PlanOutcome> {
  switch (context.request.source) {
    case 'auto':
    case 'search':
      return planWithSearch(context);
    case 'history':
      return buildHistoryPlan({
        request: context.request,
        environment: context.environment,
        start: context.start,
        now: context.now,
        deadlineMs: context.deadlineMs,
        budget: context.budget,
        maxRoutePoints: context.maxRoutePoints,
        planTtlMs: context.planTtlMs,
        wait: context.wait,
        cancellationOrigin: context.cancellationOrigin,
      });
  }
}

async function planWithSearch(context: PlanContext): Promise<PlanOutcome> {
  const { environment, request, start } = context;
  const source: RouteSearchSource | undefined = environment.search;
  if (source === undefined) {
    return {
      problem: { kind: 'unavailable', detail: 'no known-space walk search source was supplied' },
      message: 'search planning is unavailable without a search source',
    };
  }

  source.start({
    worldId: environment.worldId,
    dim: environment.dim,
    sessionId: environment.sessionId,
    mode: 'walk',
    body: {
      feet: clonePoint(start.sample.pos),
      width: environment.body.width,
      height: environment.body.height,
      pose: environment.body.pose,
    },
    target: clonePoint(request.to),
    arrival: { kind: 'exact' },
    shapeProvider: environment.shapeProvider,
  });

  let snapshot = source.snapshot();
  const initialScope = searchScopeProblem(snapshot, context);
  if (initialScope !== null) {
    void source.cancel('search snapshot scope does not match the planning scope');
    return initialScope;
  }
  const requestedMaxNodes = request.constraints?.maxNodes;
  const requestedMaxEdges = request.constraints?.maxEdges;
  if (requestedMaxNodes !== undefined && requestedMaxNodes > snapshot.limits.maxNodes) {
    void source.cancel('requested maxNodes exceeds the configured search limit');
    return {
      problem: {
        kind: 'invalid_request',
        detail: `maxNodes ${requestedMaxNodes} exceeds the configured search limit ${snapshot.limits.maxNodes}`,
      },
      message: 'the requested search node budget exceeds this planner configuration',
    };
  }
  if (requestedMaxEdges !== undefined && requestedMaxEdges > snapshot.limits.maxEdges) {
    void source.cancel('requested maxEdges exceeds the configured search limit');
    return {
      problem: {
        kind: 'invalid_request',
        detail: `maxEdges ${requestedMaxEdges} exceeds the configured search limit ${snapshot.limits.maxEdges}`,
      },
      message: 'the requested search edge budget exceeds this planner configuration',
    };
  }

  while (snapshot.state === 'PENDING') {
    if (environment.signal?.aborted === true) {
      source.cancel(abortReason(environment.signal));
      return cancelledOutcome(context, abortReason(environment.signal));
    }
    if (context.now() >= context.deadlineMs) {
      source.cancel('route planning deadline exceeded');
      return timeoutOutcome();
    }
    if (requestedMaxEdges !== undefined && snapshot.counters.edgesEvaluated >= requestedMaxEdges) {
      source.cancel('requested maxEdges exhausted');
      return budgetOutcome('edges', `the requested maxEdges budget of ${requestedMaxEdges} was exhausted`);
    }
    if (requestedMaxNodes !== undefined && snapshot.counters.nodesReached >= requestedMaxNodes) {
      source.cancel('requested maxNodes exhausted');
      return budgetOutcome('nodes', `the requested maxNodes budget of ${requestedMaxNodes} was exhausted`);
    }

    // Every evaluated edge can add at most one node, so capping the slice by
    // both remaining budgets prevents a single advance() from overshooting
    // either request limit before the loop can check it.
    const nodesRemaining = requestedMaxNodes === undefined
      ? Number.POSITIVE_INFINITY
      : requestedMaxNodes - snapshot.counters.nodesReached;
    const edgesRemaining = requestedMaxEdges === undefined
      ? Number.POSITIVE_INFINITY
      : requestedMaxEdges - snapshot.counters.edgesEvaluated;
    const slice = Math.min(context.budget, nodesRemaining, edgesRemaining);
    snapshot = source.advance(slice);
    if (snapshot.state === 'PENDING') await context.wait();
  }

  // Check the terminal snapshot's scope before interpreting its state: an
  // out-of-scope result is not a fact about this world and must never be
  // reported as `no_path`/`timeout` or turned into this scope's evidence.
  const terminalScope = searchScopeProblem(snapshot, context);
  if (terminalScope !== null) return terminalScope;

  if (environment.signal?.aborted === true) {
    return cancelledOutcome(context, abortReason(environment.signal));
  }
  if (context.now() >= context.deadlineMs) return timeoutOutcome();

  // Never accept or report a terminal snapshot from an over-budget search.
  // The slice cap already prevents this for the bundled WalkRouteSearch; this
  // O(1) check also covers a caller-supplied RouteSearchSource that returns a
  // terminal snapshot from start()/advance() without honoring the slice bound.
  if (requestedMaxNodes !== undefined && snapshot.counters.nodesReached > requestedMaxNodes) {
    return budgetOutcome(
      'nodes',
      `the search reached ${snapshot.counters.nodesReached} nodes, exceeding requested maxNodes ${requestedMaxNodes}`,
    );
  }
  if (requestedMaxEdges !== undefined && snapshot.counters.edgesEvaluated > requestedMaxEdges) {
    return budgetOutcome(
      'edges',
      `the search evaluated ${snapshot.counters.edgesEvaluated} edges, exceeding requested maxEdges ${requestedMaxEdges}`,
    );
  }

  if (snapshot.state !== 'FOUND') {
    const mapped = problemFromSearch(snapshot, context.cancellationOrigin);
    return { problem: mapped.problem, message: mapped.message };
  }

  const candidate = snapshot.candidate;
  if (candidate === null || candidate.points.length === 0) {
    return {
      problem: {
        kind: 'invalid_request',
        detail: 'the walk search reported a FOUND state without a usable candidate route',
      },
      message: 'the walk search returned an inconsistent candidate',
    };
  }
  // A candidate is only about the target this planner asked for. Relying on
  // `resolvedTarget` alone would turn another target's geometry into this
  // request's evidence (as a non-executable candidate).
  if (!positionsEqual(candidate.target, request.to)) {
    return {
      problem: {
        kind: 'invalid_request',
        detail: 'the walk search candidate target does not match request.to',
      },
      message: 'the walk search returned a candidate for a different target than requested',
    };
  }
  if (candidate.points.length > context.maxRoutePoints) {
    return budgetOutcome(
      'points',
      `the candidate route has ${candidate.points.length} points, exceeding maxRoutePoints ${context.maxRoutePoints}`,
    );
  }

  let verification = emptyVerification();
  if (candidate.points.length >= 2) {
    const outcome = await verifyRoutePoints({
      verifier: environment.verifier,
      scope: planScope(environment),
      body: environment.body,
      shapeProvider: environment.shapeProvider,
      points: candidate.points,
      now: context.now,
      deadlineMs: context.deadlineMs,
      budget: context.budget,
      wait: context.wait,
      ...(environment.signal === undefined ? {} : { signal: environment.signal }),
      cancellationOrigin: context.cancellationOrigin,
    });
    if (!outcome.ok) return { problem: outcome.problem, message: outcome.message };
    verification = outcome.verification;
  }

  const nowMs = context.now();
  if (nowMs >= context.deadlineMs) return timeoutOutcome();

  return {
    draft: assemblePlan({
      source: 'search',
      points: candidate.points,
      start: start.sample.pos,
      requestedTarget: request.to,
      resolvedTarget: candidate.reachedAt,
      scope: planScope(environment),
      shapeProvider: environment.shapeProvider,
      verification,
      nowMs,
      planTtlMs: context.planTtlMs,
    }),
  };
}

function finalizeOutcome(context: PlanContext, outcome: PlanOutcome): RoutePlanResult {
  if ('problem' in outcome) return { problem: outcome.problem, message: outcome.message };
  try {
    return { plan: context.environment.registry.register(outcome.draft) };
  } catch (error) {
    if (!(error instanceof RoutePlanRegistryCapacityError)) throw error;
    return {
      problem: { kind: 'unavailable', detail: error.message },
      message: 'the route plan could not be retained because every registry handle is pinned',
    };
  }
}

// --- request/environment validation ---------------------------------------

type ValidatedRequest =
  | { request: RoutePlanRequest; problem?: undefined; message?: undefined }
  | { problem: NavProblem | RouteUnsupported; message: string };

function validateRequest(raw: RoutePlanRequest, now: number): ValidatedRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('the route plan request must be an object');
  }
  const record = raw as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_REQUEST_FIELDS.has(key)) return invalid(`unknown request field "${key}"`);
  }

  if (!isFinitePoint(record.to)) {
    return invalid('request.to must contain finite x, y and z numbers');
  }
  if (typeof record.mode !== 'string') {
    return invalid('request.mode must be a movement mode string');
  }
  if (!(MOVE_MODES as readonly string[]).includes(record.mode)) {
    return invalid(`unknown movement mode "${record.mode}"`);
  }
  if (record.mode !== 'walk') {
    return {
      problem: {
        kind: 'unsupported_mode',
        mode: record.mode as MoveMode,
        detail: 'v1 route planning supports same-height walk only; the mode was not changed or approximated',
      },
      message: `mode "${record.mode}" is not implemented by this planner`,
    };
  }

  if (record.source !== 'auto' && record.source !== 'search' && record.source !== 'history') {
    return invalid('request.source must be "auto", "search" or "history"');
  }
  const source: RoutePlanSource = record.source;

  let pathId: string | undefined;
  if (record.pathId !== undefined) {
    if (typeof record.pathId !== 'string' || record.pathId.length === 0) {
      return invalid('request.pathId must be a non-empty string when supplied');
    }
    pathId = record.pathId;
  }
  if (source === 'history' && pathId === undefined) {
    return invalid('source "history" requires an explicit pathId');
  }

  const arrival = validateArrival(record.arrival);
  if ('problem' in arrival) return arrival;

  const constraints = validateConstraints(record.constraints);
  if ('problem' in constraints) return constraints;
  if (
    source === 'history' &&
    (constraints.constraints?.maxNodes !== undefined || constraints.constraints?.maxEdges !== undefined)
  ) {
    return {
      problem: {
        kind: 'unsupported_constraint',
        constraint: 'search_budget',
        detail: 'maxNodes/maxEdges bound known-space search and are not consumed by history planning',
      },
      message: 'search node/edge budgets cannot be applied to an explicit historical route',
    };
  }

  if (typeof record.deadlineMs !== 'number' || !Number.isFinite(record.deadlineMs)) {
    return invalid('request.deadlineMs must be a finite epoch time in ms');
  }
  if (record.deadlineMs <= now) {
    return {
      problem: { kind: 'timeout' },
      message: 'the request deadline has already passed',
    };
  }

  const request: RoutePlanRequest = {
    to: clonePoint(record.to),
    mode: 'walk',
    source,
    ...(pathId === undefined ? {} : { pathId }),
    arrival: { kind: 'exact' },
    ...(constraints.constraints === undefined ? {} : { constraints: constraints.constraints }),
    deadlineMs: record.deadlineMs,
  };
  return { request };
}

function validateArrival(
  value: unknown,
): { arrival: ArrivalSpec } | { problem: NavProblem | RouteUnsupported; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('request.arrival must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_ARRIVAL_FIELDS.has(key)) return invalid(`unknown arrival field "${key}"`);
  }
  if (record.kind !== 'exact' && record.kind !== 'near' && record.kind !== 'reach_block') {
    return invalid('arrival.kind must be "exact", "near" or "reach_block"');
  }
  if (record.kind !== 'near' && record.radius !== undefined) {
    return invalid('arrival.radius is only valid for a near arrival');
  }
  if (record.kind === 'near') {
    if (typeof record.radius !== 'number' || !Number.isFinite(record.radius) || record.radius < 0) {
      return invalid('a near arrival requires a finite non-negative radius');
    }
    return {
      problem: {
        kind: 'unsupported_arrival',
        arrival: { kind: 'near', radius: record.radius },
        detail: 'v1 route planning confirms an exact foot position only',
      },
      message: 'near-arrival planning is not implemented',
    };
  }
  if (record.kind === 'reach_block') {
    return {
      problem: {
        kind: 'unsupported_arrival',
        arrival: { kind: 'reach_block' },
        detail: 'v1 route planning confirms an exact foot position only',
      },
      message: 'reach-block arrival planning is not implemented',
    };
  }
  return { arrival: { kind: 'exact' } };
}

function validateConstraints(
  value: unknown,
): { constraints?: RoutePlanRequest['constraints'] } | { problem: NavProblem | RouteUnsupported; message: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('request.constraints must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_CONSTRAINT_FIELDS.has(key)) return invalid(`unknown constraint field "${key}"`);
  }

  let avoid: Vec3Like[] | undefined;
  if (record.avoid !== undefined) {
    if (!Array.isArray(record.avoid) || !record.avoid.every(isFinitePoint)) {
      return invalid('constraints.avoid must be an array of finite positions');
    }
    if (record.avoid.length > 0) {
      return {
        problem: {
          kind: 'unsupported_constraint',
          constraint: 'avoid',
          detail: 'the walk evaluator does not consume avoid positions; v1 rejects a non-empty list',
        },
        message: 'avoid constraints are not implemented by this walk planner',
      };
    }
    avoid = [];
  }

  const maxNodes = validateBudgetField(record.maxNodes, ABSOLUTE_MAX_NODES, 'maxNodes');
  if ('problem' in maxNodes) return maxNodes;
  const maxEdges = validateBudgetField(record.maxEdges, ABSOLUTE_MAX_EDGES, 'maxEdges');
  if ('problem' in maxEdges) return maxEdges;

  if (avoid === undefined && maxNodes.value === undefined && maxEdges.value === undefined) return {};
  return {
    constraints: {
      ...(avoid === undefined ? {} : { avoid }),
      ...(maxNodes.value === undefined ? {} : { maxNodes: maxNodes.value }),
      ...(maxEdges.value === undefined ? {} : { maxEdges: maxEdges.value }),
    },
  };
}

function validateBudgetField(
  value: unknown,
  absoluteMax: number,
  label: 'maxNodes' | 'maxEdges',
): { value?: number } | { problem: NavProblem | RouteUnsupported; message: string } {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return invalid(`constraints.${label} must be a positive safe integer`);
  }
  if (value > absoluteMax) {
    return invalid(`constraints.${label} ${value} exceeds the implementation limit ${absoluteMax}`);
  }
  return { value };
}

function resolveConfig(environment: RoutePlanEnvironment):
  | {
      budgetPerSlice: number;
      planTtlMs: number;
      maxRoutePoints: number;
      problem?: undefined;
      message?: undefined;
    }
  | { problem: NavProblem | RouteUnsupported; message: string } {
  const budgetPerSlice = environment.budgetPerSlice ?? DEFAULT_BUDGET_PER_SLICE;
  if (!Number.isSafeInteger(budgetPerSlice) || budgetPerSlice < 1) {
    return invalid(`environment.budgetPerSlice must be a positive safe integer: ${budgetPerSlice}`);
  }
  const planTtlMs = environment.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  if (!Number.isFinite(planTtlMs) || planTtlMs <= 0) {
    return invalid(`environment.planTtlMs must be a positive finite number: ${planTtlMs}`);
  }
  const verifierLimit = environment.verifier.maxRouteLength;
  if (!Number.isSafeInteger(verifierLimit) || verifierLimit < 2) {
    return invalid(
      `environment.verifier.maxRouteLength must be a safe integer ≥ 2: ${verifierLimit}`,
    );
  }
  const requestedMaxRoutePoints = environment.maxRoutePoints;
  if (requestedMaxRoutePoints !== undefined) {
    if (!Number.isSafeInteger(requestedMaxRoutePoints) || requestedMaxRoutePoints < 1) {
      return invalid(
        `environment.maxRoutePoints must be a positive safe integer: ${requestedMaxRoutePoints}`,
      );
    }
    if (requestedMaxRoutePoints > verifierLimit) {
      return invalid(
        `environment.maxRoutePoints ${requestedMaxRoutePoints} exceeds the route verifier limit ${verifierLimit}`,
      );
    }
  }
  // Default to the smaller of the planner default and what the verifier can
  // actually accept, so a candidate never reaches register() over its limit.
  const maxRoutePoints = requestedMaxRoutePoints ?? Math.min(DEFAULT_MAX_ROUTE_POINTS, verifierLimit);
  return { budgetPerSlice, planTtlMs, maxRoutePoints };
}

// --- outcome helpers ------------------------------------------------------

/**
 * The search must describe the same world/dim/session/mode this planner was
 * asked to plan in. A custom `RouteSearchSource` (or a mis-wired search
 * instance) otherwise hands its candidate to this scope's evidence envelope.
 */
function searchScopeProblem(snapshot: WalkSearchSnapshot, context: PlanContext): PlanOutcome | null {
  if (
    snapshot.worldId === context.environment.worldId &&
    snapshot.dim === context.environment.dim &&
    snapshot.sessionId === context.environment.sessionId &&
    snapshot.mode === context.request.mode
  ) {
    return null;
  }
  const snapshotScope = `${snapshot.worldId}/${snapshot.dim}/${snapshot.sessionId}/${snapshot.mode}`;
  const planScopeLabel =
    `${context.environment.worldId}/${context.environment.dim}/` +
    `${context.environment.sessionId}/${context.request.mode}`;
  return {
    problem: {
      kind: 'scope_changed',
      detail: `the search snapshot scope ${snapshotScope} does not match the planning scope ${planScopeLabel}`,
    },
    message: 'the walk search result belongs to a different world, dimension, session or mode',
  };
}

function invalid(detail: string): { problem: NavProblem; message: string } {
  return { problem: { kind: 'invalid_request', detail }, message: `the route plan request was rejected: ${detail}` };
}

function cancelledOutcome(context: PlanContext, reason: string): PlanOutcome {
  return {
    problem: { kind: 'cancelled', by: context.cancellationOrigin, reason },
    message: `route planning was cancelled: ${reason}`,
  };
}

function timeoutOutcome(): PlanOutcome {
  return {
    problem: { kind: 'timeout' },
    message: 'the planning deadline was exceeded before a plan was proven',
  };
}

function budgetOutcome(limit: 'nodes' | 'edges' | 'points' | 'time', detail: string): PlanOutcome {
  return {
    problem: { kind: 'budget_exhausted', limit, detail },
    message: `route planning exhausted its ${limit} budget: ${detail}`,
  };
}

