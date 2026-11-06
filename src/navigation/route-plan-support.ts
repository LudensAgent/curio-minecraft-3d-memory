/**
 * Internal shared helpers for the read-only route planner (plan M3.3–M3.5).
 *
 * Nothing here moves, observes, saves or searches beyond the caller-supplied
 * search/verifier. The helpers only:
 *
 * - validate the measured start;
 * - re-verify an already-selected point sequence through `RouteVerifier`;
 * - turn verification facts into ordered boundaries/dependencies;
 * - assemble the plan envelope; and
 * - map search conclusions to structured problems without collapsing
 *   "unobserved"/"budget"/"unsupported" into "no path".
 */

import type { BodySample } from '../execution/types.js';
import type { ObservationGap } from '../observation/types.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import type { RouteStatus } from '../traversability/route.js';
import type { RouteVerifier } from '../traversability/route.js';
import type { BodyContext, StepStatus } from '../traversability/step.js';
import type { Vec3Like } from '../types.js';
import type { SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type {
  WalkSearchSnapshot,
  WalkSearchUnavailableEvidence,
  WalkSearchFrontier,
} from './walk-search.js';
import type {
  CancellationOrigin,
  RouteBoundary,
  RouteEvidence,
  RoutePlanDraft,
  RoutePlanScope,
  RouteUnsupported,
} from './route-plan-types.js';
import type { ArrivalSpec, NavProblem } from './types.js';
import { concludeWalkSearch } from './route-search.js';

export const PLAN_POS_EPS = 1e-6;
/** Matches `RouteVerifier`'s unit-step tolerance; a looser precheck could throw inside it. */
const GEOMETRY_EPS = 1e-9;
export const DEFAULT_BUDGET_PER_SLICE = 256;
export const DEFAULT_PLAN_TTL_MS = 30_000;
export const DEFAULT_MAX_ROUTE_POINTS = 1024;

const STATUS_PRIORITY: Record<StepStatus, number> = {
  OPEN: 0,
  UNKNOWN: 1,
  STALE: 2,
  UNSUPPORTED: 3,
  BLOCKED: 4,
};

export interface MeasuredPlanStart {
  sample: BodySample;
  body: BodyContext;
}

export type MeasuredStartResult = MeasuredPlanStart | { problem: NavProblem; message: string };

export function readMeasuredStart(
  environment: {
    worldId: string;
    dim: string;
    sessionId: string;
    body: BodyContext;
    sample(): BodySample | null;
  },
): MeasuredStartResult {
  const sample = environment.sample();
  if (sample === null) {
    return {
      problem: {
        kind: 'unavailable',
        detail: 'no measured body sample is available; the starting position is unconfirmed',
      },
      message: 'route planning cannot start without a measured body position',
    };
  }
  if (!isFinitePoint(sample.pos) || !Number.isFinite(sample.observedAt)) {
    return {
      problem: {
        kind: 'unavailable',
        detail: 'the measured body sample has a non-finite position or observation time',
      },
      message: 'route planning cannot use an unmeasured body position',
    };
  }
  if (
    sample.worldId !== environment.worldId ||
    sample.dim !== environment.dim ||
    sample.sessionId !== environment.sessionId
  ) {
    return {
      problem: {
        kind: 'scope_changed',
        detail: 'the measured sample world/dim/session does not match this planning scope',
      },
      message: 'the measured body sample belongs to a different world, dimension or session',
    };
  }
  if (!sample.alive || !sample.connected || !sample.observationReady) {
    return {
      problem: {
        kind: 'unavailable',
        detail: `the measured body is not usable: alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
      },
      message: 'the body is not alive, connected and observation-ready',
    };
  }
  const body = environment.body;
  if (!Number.isFinite(body.width) || !Number.isFinite(body.height) || body.width <= 0 || body.height <= 0) {
    return {
      problem: {
        kind: 'invalid_request',
        detail: 'environment.body width and height must be finite positive numbers',
      },
      message: 'the body dimensions are unusable',
    };
  }
  return {
    sample,
    body: { feet: clonePoint(sample.pos), width: body.width, height: body.height, pose: body.pose },
  };
}

export interface RouteVerification {
  /** All route steps have a current verified conclusion. */
  complete: boolean;
  boundaries: RouteBoundary[];
  /** Worst verified step status, or null when every step is OPEN. */
  worst: StepStatus | null;
  /** Earliest validity of the verified evidence; Infinity for a zero-edge route. */
  validUntil: number;
  dependencies: { key: SectionKey; revision: number }[];
}

export type VerificationOutcome =
  | { ok: true; verification: RouteVerification }
  | { ok: false; problem: NavProblem | RouteUnsupported; message: string };

export interface VerifyRouteOptions {
  verifier: RouteVerifier;
  scope: RoutePlanScope;
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  points: readonly Vec3Like[];
  now: () => number;
  deadlineMs: number;
  budget: number;
  wait: () => Promise<void>;
  signal?: AbortSignal;
  cancellationOrigin: CancellationOrigin;
}

/**
 * Re-verify an already-selected ≥2-point route through the caller's dedicated
 * verifier. The verifier is cleared on every exit so planning retains no route.
 */
export async function verifyRoutePoints(options: VerifyRouteOptions): Promise<VerificationOutcome> {
  const { verifier, points } = options;
  // Defense in depth for a host-supplied verifier with a smaller limit than the
  // planner budget: never let register() throw into the control loop.
  if (points.length > verifier.maxRouteLength) {
    verifier.clear();
    return {
      ok: false,
      problem: {
        kind: 'budget_exhausted',
        limit: 'points',
        detail: `route has ${points.length} points, exceeding the route verifier limit ${verifier.maxRouteLength}`,
      },
      message: 'the selected route exceeds the route verifier point limit',
    };
  }
  verifier.register({
    worldId: options.scope.worldId,
    dim: options.scope.dim,
    sessionId: options.scope.sessionId,
    mode: 'walk',
    body: { feet: clonePoint(points[0]!), width: options.body.width, height: options.body.height, pose: options.body.pose },
    shapeProvider: options.shapeProvider,
    points,
  });

  let status = verifier.status();
  if (status === null) {
    throw new Error('the route verifier did not retain the registered planning route');
  }
  while (!status.complete) {
    if (options.signal?.aborted === true) {
      verifier.clear();
      return {
        ok: false,
        problem: {
          kind: 'cancelled',
          by: options.cancellationOrigin,
          reason: abortReason(options.signal),
        },
        message: 'route planning was cancelled before verification completed',
      };
    }
    if (options.now() >= options.deadlineMs) {
      verifier.clear();
      return {
        ok: false,
        problem: { kind: 'timeout' },
        message: 'the planning deadline was exceeded before verification completed',
      };
    }
    status = verifier.advance(options.budget);
    if (!status.complete) await options.wait();
  }

  const verification = verificationOf(status);
  verifier.clear();
  return { ok: true, verification };
}

function verificationOf(status: RouteStatus): RouteVerification {
  const boundaries: RouteBoundary[] = [];
  const dependencies = new Map<string, { key: SectionKey; revision: number }>();
  let worst: StepStatus | null = null;
  let validUntil = Number.POSITIVE_INFINITY;

  status.steps.forEach((step, index) => {
    if (step.kind !== 'verified') return;
    const result = step.result;
    validUntil = Math.min(validUntil, result.validUntil);
    for (const dep of result.dependencies) {
      const key = sectionKeyString(dep.key);
      const current = dependencies.get(key);
      if (current === undefined || dep.revision > current.revision) {
        dependencies.set(key, { key: { ...dep.key }, revision: dep.revision });
      }
    }
    if (result.status === 'OPEN') return;
    if (worst === null || STATUS_PRIORITY[result.status] > STATUS_PRIORITY[worst]) {
      worst = result.status;
    }
    boundaries.push({
      kind: boundaryKindOf(result.status),
      status: result.status,
      stance: clonePoint(status.points[index]!),
      to: clonePoint(status.points[index + 1]!),
      reason: result.reason ?? result.status.toLowerCase(),
      ...(Number.isFinite(result.validUntil)
        ? {
            evidence: {
              worldId: status.worldId,
              dim: status.dim,
              sessionId: status.sessionId,
              validUntil: result.validUntil,
              ruleVersion: status.ruleVersion,
            },
          }
        : {}),
    });
  });

  return {
    complete: status.complete,
    boundaries,
    worst,
    validUntil,
    dependencies: [...dependencies.values()],
  };
}

function boundaryKindOf(status: StepStatus): RouteBoundary['kind'] {
  switch (status) {
    case 'BLOCKED':
      return 'blocked';
    case 'STALE':
      return 'stale';
    case 'UNSUPPORTED':
      return 'unsupported';
    case 'UNKNOWN':
    case 'OPEN':
      return 'unknown';
  }
}

export interface AssemblePlanInput {
  source: 'search' | 'history';
  kind?: RoutePlanDraft['kind'];
  pathId?: string;
  points: Vec3Like[];
  start: Vec3Like;
  requestedTarget: Vec3Like;
  resolvedTarget: Vec3Like;
  scope: RoutePlanScope;
  shapeProvider: CollisionShapeProvider;
  verification: RouteVerification;
  nowMs: number;
  planTtlMs: number;
  extraUnsupported?: RouteUnsupported;
}

/**
 * Build one plan draft from verification facts. `executable` is true only when
 * the route is complete, every step is OPEN, the measured start equals the
 * first point, the resolved target equals the requested target, and the
 * evidence is still valid at `nowMs`.
 */
export function assemblePlan(input: AssemblePlanInput): RoutePlanDraft {
  const startMatches = positionsEqual(input.start, input.points[0]!);
  const targetMatches = positionsEqual(input.resolvedTarget, input.requestedTarget);
  // A zero-edge plan read no evaluator evidence; its bounded validity is the
  // plan TTL, not a fabricated observation window.
  const evidenceValidUntil = Number.isFinite(input.verification.validUntil)
    ? input.verification.validUntil
    : input.nowMs + input.planTtlMs;
  const currentlyValid = input.nowMs <= evidenceValidUntil;
  const verified =
    input.verification.complete &&
    input.verification.worst === null &&
    startMatches &&
    targetMatches &&
    currentlyValid;

  const unsupported =
    input.extraUnsupported ??
    (input.verification.worst === 'UNSUPPORTED'
      ? {
          kind: 'unsupported_geometry' as const,
          detail: input.verification.boundaries.find((boundary) => boundary.status === 'UNSUPPORTED')?.reason
            ?? 'the walk evaluator does not support this route geometry',
        }
      : undefined);

  const expiresAt = Math.min(evidenceValidUntil, input.nowMs + input.planTtlMs);
  const verdict = verdictOf(input.verification);

  return {
    backend: 'spatial_library',
    source: input.source,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    points: input.points.map(clonePoint),
    segments: [
      {
        index: 0,
        mode: 'walk',
        points: input.points.map(clonePoint),
        cost: Math.max(0, input.points.length - 1),
      },
    ],
    cost: Math.max(0, input.points.length - 1),
    confidence: verified ? 'verified' : 'candidate',
    executable: verified,
    boundaries: input.verification.boundaries.map(cloneBoundary),
    ...(unsupported === undefined ? {} : { unsupported }),
    evidence: {
      worldId: input.scope.worldId,
      dim: input.scope.dim,
      sessionId: input.scope.sessionId,
      validUntil: evidenceValidUntil,
      ruleVersion: input.shapeProvider.version,
      ...(input.verification.dependencies.length === 0
        ? {}
        : { dependencies: input.verification.dependencies.map((dep) => ({ key: { ...dep.key }, revision: dep.revision })) }),
    },
    expiresAt,
    ...(input.pathId === undefined ? {} : { pathId: input.pathId }),
    ...(verdict === undefined ? {} : { verdict }),
    requestedTarget: clonePoint(input.requestedTarget),
    resolvedTarget: clonePoint(input.resolvedTarget),
    start: clonePoint(input.start),
  };
}

function verdictOf(verification: RouteVerification): RoutePlanDraft['verdict'] {
  if (!verification.complete) return 'UNKNOWN';
  switch (verification.worst) {
    case null:
      return 'OPEN';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'STALE':
      return 'STALE';
    case 'UNKNOWN':
      return 'UNKNOWN';
    case 'UNSUPPORTED':
    case 'OPEN':
      return undefined;
  }
}

/** Failure mapping for a non-FOUND search snapshot; preserves state-specific facts. */
export function problemFromSearch(
  snapshot: WalkSearchSnapshot,
  cancellationOrigin: CancellationOrigin,
): { problem: NavProblem | RouteUnsupported; message: string } {
  switch (concludeWalkSearch(snapshot.state)) {
    case 'no_verified_path':
      return {
        problem: { kind: 'no_path' },
        message:
          'no currently OPEN walk route was found within the verified evidence; this does not prove the target is unreachable in the world',
      };
    case 'insufficient_evidence': {
      const detail =
        `the bounded walk search stopped with insufficient evidence: ${snapshot.counters.edgesUnknown} unknown, ` +
        `${snapshot.counters.edgesStale} stale and ${snapshot.counters.edgesUnsupported} unsupported boundary edge(s)`;
      if (snapshot.counters.edgesUnknown > 0) {
        const gap = searchGap(snapshot);
        // No recorded gap cell means no evidence-backed position to report.
        if (gap === null) return { problem: { kind: 'unavailable', detail: snapshot.reason }, message: detail };
        return { problem: { kind: 'unobserved', gap }, message: detail };
      }
      if (snapshot.counters.edgesStale > 0) {
        const stale = firstDiagnostic(snapshot, 'STALE');
        if (stale === undefined) return { problem: { kind: 'unavailable', detail: snapshot.reason }, message: detail };
        return { problem: { kind: 'stale', pos: clonePoint(stale.to) }, message: detail };
      }
      return {
        problem: { kind: 'unsupported_geometry', detail: snapshot.reason },
        message: detail,
      };
    }
    case 'unsupported': {
      const problem = snapshot.problem;
      if (problem?.kind === 'unsupported_mode') {
        return {
          problem: { kind: 'unsupported_mode', mode: problem.mode, detail: problem.detail },
          message: `mode "${problem.mode}" is not supported by the walk planner: ${problem.detail}`,
        };
      }
      return {
        problem: {
          kind: 'unsupported_geometry',
          detail: problem?.kind === 'unsupported_target' ? problem.detail : snapshot.reason,
        },
        message: `this walk planner cannot represent the requested route: ${snapshot.reason}`,
      };
    }
    case 'budget_exhausted':
      return {
        problem: {
          kind: 'budget_exhausted',
          limit: snapshot.problem?.kind === 'budget_exhausted' && snapshot.problem.nodeLimitReached ? 'nodes' : 'edges',
          detail: snapshot.reason,
        },
        message: 'the bounded search exhausted its node/edge budget before proving a route',
      };
    case 'cancelled':
      return {
        problem: {
          kind: 'cancelled',
          by: cancellationOrigin,
          reason: snapshot.cancellation?.reason ?? snapshot.reason,
        },
        message: 'the walk search was cancelled before a route was proven',
      };
    case 'invalidated':
      return {
        problem: { kind: 'route_invalidated', detail: snapshot.reason },
        message: 'the walk search evidence was invalidated; start a fresh planning request',
      };
    case 'pending':
      return {
        problem: { kind: 'unavailable', detail: 'the walk search is still pending' },
        message: 'a pending walk search is not a planning result',
      };
    case 'found':
      return {
        problem: { kind: 'invalid_request', detail: 'the search reported FOUND without a candidate route' },
        message: 'the walk search returned an inconsistent FOUND result without a candidate',
      };
  }
}

function searchGap(snapshot: WalkSearchSnapshot): ObservationGap | null {
  const diagnostic = firstDiagnostic(snapshot, 'UNKNOWN');
  if (diagnostic !== undefined) return { pos: clonePoint(diagnostic.to), reason: 'unknown' };
  const unavailable: WalkSearchUnavailableEvidence | undefined = snapshot.unavailableHistorical[0];
  if (unavailable !== undefined) return { pos: clonePoint(unavailable.to), reason: 'unloaded' };
  const frontier: WalkSearchFrontier | undefined = snapshot.frontiers[0];
  if (frontier !== undefined) return { pos: clonePoint(frontier.to), reason: 'unknown' };
  // No diagnostic/frontier recorded (for example a truncated diagnostic list):
  // there is no evidence-backed cell to report as the gap.
  return null;
}

function firstDiagnostic(
  snapshot: WalkSearchSnapshot,
  status: 'UNKNOWN' | 'STALE' | 'UNSUPPORTED',
): WalkSearchSnapshot['diagnostics'][number] | undefined {
  return snapshot.diagnostics.find((entry) => entry.status === status);
}

/**
 * The verifier/executor polyline contract: same-height, one-cell ±X/±Z steps.
 * Returns a problem phrase, or null when accepted. History geometry is checked
 * before registering so malformed geometry becomes structured `unsupported`
 * instead of a thrown boundary error.
 */
export function routeGeometryProblem(points: readonly Vec3Like[]): string | null {
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to.y !== from.y) {
      return `step ${i} changes height (Δy=${to.y - from.y}); only same-height walk steps are supported`;
    }
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const xZero = Math.abs(dx) < GEOMETRY_EPS;
    const zZero = Math.abs(dz) < GEOMETRY_EPS;
    const xUnit = Math.abs(Math.abs(dx) - 1) < GEOMETRY_EPS;
    const zUnit = Math.abs(Math.abs(dz) - 1) < GEOMETRY_EPS;
    if (xUnit && zZero) continue;
    if (zUnit && xZero) continue;
    if (xZero && zZero) return `step ${i} duplicates point (${from.x}, ${from.y}, ${from.z})`;
    if (xUnit && zUnit) return `step ${i} is diagonal (Δx=${dx}, Δz=${dz})`;
    if (xZero) return `step ${i} is not a one-cell move (Δz=${dz})`;
    return `step ${i} is not a one-cell move (Δx=${dx})`;
  }
  return null;
}

export function emptyVerification(): RouteVerification {
  return {
    complete: true,
    boundaries: [],
    worst: null,
    validUntil: Number.POSITIVE_INFINITY,
    dependencies: [],
  };
}

export function positionsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return (
    Math.abs(a.x - b.x) <= PLAN_POS_EPS &&
    Math.abs(a.y - b.y) <= PLAN_POS_EPS &&
    Math.abs(a.z - b.z) <= PLAN_POS_EPS
  );
}

export function clonePoint(point: Vec3Like): Vec3Like {
  return { x: point.x, y: point.y, z: point.z };
}

/** Snapshot the immutable planning scope used by verification and evidence. */
export function planScope(environment: { worldId: string; dim: string; sessionId: string }): RoutePlanScope {
  return {
    worldId: environment.worldId,
    dim: environment.dim,
    sessionId: environment.sessionId,
  };
}

export function isFinitePoint(value: unknown): value is Vec3Like {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return (
    typeof v.x === 'number' && Number.isFinite(v.x) &&
    typeof v.y === 'number' && Number.isFinite(v.y) &&
    typeof v.z === 'number' && Number.isFinite(v.z)
  );
}

export function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return 'route planning aborted by caller';
}

export function defaultWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function cloneBoundary(boundary: RouteBoundary): RouteBoundary {
  return {
    ...boundary,
    ...(boundary.stance === undefined ? {} : { stance: clonePoint(boundary.stance) }),
    ...(boundary.to === undefined ? {} : { to: clonePoint(boundary.to) }),
    ...(boundary.evidence === undefined ? {} : { evidence: cloneEvidence(boundary.evidence) }),
  };
}

export function cloneEvidence(evidence: RouteEvidence): RouteEvidence {
  return {
    ...evidence,
    ...(evidence.dependencies === undefined
      ? {}
      : { dependencies: evidence.dependencies.map((dep) => ({ key: { ...dep.key }, revision: dep.revision })) }),
  };
}

export function cloneUnsupported(unsupported: RouteUnsupported): RouteUnsupported {
  switch (unsupported.kind) {
    case 'unsupported_mode':
      return { kind: 'unsupported_mode', mode: unsupported.mode, detail: unsupported.detail };
    case 'unsupported_arrival':
      return {
        kind: 'unsupported_arrival',
        arrival: cloneArrival(unsupported.arrival),
        detail: unsupported.detail,
      };
    case 'unsupported_constraint':
      return {
        kind: 'unsupported_constraint',
        constraint: unsupported.constraint,
        detail: unsupported.detail,
      };
    case 'unsupported_geometry':
      return { kind: 'unsupported_geometry', detail: unsupported.detail };
    case 'unobserved':
      return { kind: 'unobserved', gap: { ...unsupported.gap, pos: clonePoint(unsupported.gap.pos) } };
    case 'budget_exhausted':
      return { kind: 'budget_exhausted', limit: unsupported.limit, detail: unsupported.detail };
    case 'not_authorized':
      return { kind: 'not_authorized', detail: unsupported.detail };
    case 'scope_mismatch':
      return { kind: 'scope_mismatch', detail: unsupported.detail };
  }
}

export function cloneArrival(arrival: ArrivalSpec): ArrivalSpec {
  if (arrival.kind === 'near') return { kind: 'near', radius: arrival.radius };
  if (arrival.kind === 'reach_block') return { kind: 'reach_block' };
  return { kind: 'exact' };
}
