/**
 * Read-only route verification (design §7 `inspect_route`, phase 3 first step).
 *
 * `RouteVerifier` composes the existing single-step walk evaluator and
 * `TraversabilityCache` over an *already-selected, ordered* route. It answers
 * which segments are currently passable, which are blocked, and which lack
 * evidence — it never searches a route, moves the body, digs, places, or
 * generates a navigation strategy.
 *
 * The verifier manages one route at a time. `register` snapshots the caller's
 * points/body/constraints and decomposes the polyline into the one-cell,
 * same-height, ±1-along-X-or-Z steps `evaluateWalkStep` supports; it does not
 * round coordinates, insert points, or skip duplicates — a malformed step is
 * rejected at the boundary. Verification is bounded: `advance` processes at most
 * `budget` pending steps per call, and the remaining work is left to the next
 * call. On a `ChangeReport`, `apply` re-runs the cache invalidation, drops the
 * affected steps' results through a Section→step reverse index, and re-verifies
 * within the same budget.
 *
 * "Active route" here means only "a route being tracked for verification"; it
 * does not mean execution has started, and no `ARRIVED` / movement-success
 * record is ever produced. A read (`status`, `advance`, `apply`) never mutates
 * the map's evidence, time, version or freshness: it only reads snapshots and
 * updates the derived verification state.
 */

import type { Observation } from '../observation/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionKey } from '../voxel/section.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import { TraversabilityCache } from './cache.js';
import type { CollisionShapeProvider } from './collision-shape.js';
import type {
  BodyContext,
  StepConstraints,
  StepDirection,
  StepEvaluation,
  StepProblem,
  StepQuery,
  StepStatus,
} from './step.js';

/** Route-level verdict. `INCOMPLETE` means "not yet fully verified", never a terrain fact. */
export type RouteVerdict = 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED' | 'INCOMPLETE';

/** Why a single step is not (yet) verified. */
export type PendingReason = 'unprocessed' | 'invalidated';

/** Per-step verification state. */
export type RouteStepState =
  | { kind: 'verified'; result: StepEvaluation }
  | { kind: 'pending'; reason: PendingReason };

/** Input describing one route plus the fixed context under which it is verified. */
export interface RouteRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  /** Fixed body size/pose; `feet` must equal the first route point. */
  body: BodyContext;
  constraints?: StepConstraints;
  shapeProvider: CollisionShapeProvider;
  /** Ordered, consecutive foot positions (≥ 2). Snapshot on registration. */
  points: readonly Vec3Like[];
}

/** Read-only route-verification snapshot; never aliases internal state. */
export interface RouteStatus {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  body: BodyContext;
  /** Collision-shape rule version that produced these conclusions. */
  ruleVersion: string;
  /** Original route points (snapshot copy). */
  points: Vec3Like[];
  /** Number of walk steps (points.length − 1); 0 for an unsupported route. */
  stepCount: number;
  /** True only when every step has a current verified conclusion. */
  complete: boolean;
  /** Route verdict: OPEN only when every step is currently OPEN. */
  verdict: RouteVerdict;
  reason?: string;
  /** Leading consecutive OPEN steps from the start. */
  openPrefix: number;
  /** Sorted indices of currently verified steps (the "processed range"). */
  verifiedStepIndexes: number[];
  /** Sorted indices awaiting verification (the "pending range"). */
  pendingStepIndexes: number[];
  /** Number of pending steps whose previous result was invalidated/expired. */
  invalidatedCount: number;
  /** Earliest verified non-OPEN step, when any. */
  earliestProblem: { stepIndex: number; status: StepStatus; problem?: StepProblem } | null;
  /** Per-step state, indexed by step index. */
  steps: RouteStepState[];
  /** min validUntil over verified steps; never later than any single step's. */
  validUntil: number;
  computedAt: number;
}

export interface RouteVerifierOptions {
  /** Clock for TTL expiry; must return values comparable to observation times. Defaults to `Date.now`. */
  now?: () => number;
  /** Maximum number of points (inclusive). Exceeding it is rejected, not truncated. Defaults to 1024. */
  maxRouteLength?: number;
}

interface RegisteredRoute {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  body: BodyContext;
  constraints: StepConstraints | undefined;
  shapeProvider: CollisionShapeProvider;
  ruleVersion: string;
  points: Vec3Like[];
  /** Set when `mode` is outside the walk evaluator's range: no steps are decomposed. */
  unsupportedReason?: string;
  queries: StepQuery[];
}

const DEFAULT_MAX_ROUTE_LENGTH = 1024;

/** Tolerance for treating a floating-point delta as exactly one cell. */
const EPS = 1e-9;

/** Overall-severity order over single-step statuses; mirrors the single-step evaluator's precedence. */
const STATUS_PRIORITY: Record<StepStatus, number> = {
  OPEN: 0,
  UNKNOWN: 1,
  STALE: 2,
  UNSUPPORTED: 3,
  BLOCKED: 4,
};

/**
 * True when a result can change once a depended-on section is refreshed. STALE
 * and UNSUPPORTED are the only statuses that can be caused by expired evidence;
 * OPEN/BLOCKED/UNKNOWN are not recoverable by a same-content refresh.
 */
function refreshRecoverable(status: StepStatus): boolean {
  return status === 'STALE' || status === 'UNSUPPORTED';
}

/**
 * @example Full call order (observe → ChangeReport → invalidate → bounded re-verify → read):
 * ```ts
 * const map = new VoxelMap('world', { now });
 * const verifier = new RouteVerifier(map, { now });
 *
 * verifier.register({
 *   worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
 *   body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
 *   shapeProvider,
 *   points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
 * });
 *
 * verifier.advance(2);                        // bounded verification round
 * const report = map.observe(observation);    // caller writes the real observation first
 * verifier.apply(report, 2);                  // invalidate affected steps, re-verify within budget
 * const current = verifier.status();          // read-only snapshot, never mutates the map
 * ```
 */
export class RouteVerifier {
  private readonly map: VoxelMap;
  private readonly cache: TraversabilityCache;
  private readonly now: () => number;
  private readonly maxRouteLength: number;

  private route: RegisteredRoute | null = null;
  /** Verified step index → cloned evaluation (the "processed" range). */
  private readonly results = new Map<number, StepEvaluation>();
  /** Step index → why it still needs verification (the "pending" range). */
  private readonly pending = new Map<number, PendingReason>();
  /** Section key → step indices that depend on it (reverse dependency index). */
  private readonly sectionToSteps = new Map<string, Set<number>>();

  constructor(map: VoxelMap, options: RouteVerifierOptions = {}) {
    this.map = map;
    this.now = options.now ?? Date.now;
    const maxRouteLength = options.maxRouteLength ?? DEFAULT_MAX_ROUTE_LENGTH;
    if (!Number.isInteger(maxRouteLength) || maxRouteLength < 2) {
      throw new Error(`maxRouteLength must be an integer ≥ 2: ${maxRouteLength}`);
    }
    this.maxRouteLength = maxRouteLength;
    this.cache = new TraversabilityCache(map, { now: this.now });
  }

  /**
   * Register (or replace) the tracked route. Snapshots the request and returns
   * the initial status with every walk step pending. All validation happens
   * before the current route is replaced, so a rejected request leaves the
   * existing route intact.
   */
  register(request: RouteRequest): RouteStatus {
    if (request.worldId !== this.map.worldId) {
      throw new Error(`request worldId "${request.worldId}" does not match map worldId "${this.map.worldId}"`);
    }
    const points = snapshotPoints(request.points);
    if (points.length > this.maxRouteLength) {
      throw new Error(`route has ${points.length} points, exceeding the limit of ${this.maxRouteLength}`);
    }
    const body = snapshotBody(request.body);
    validateBody(body);
    if (!pointsEqual(body.feet, points[0]!)) {
      throw new Error(`body.feet ${fmt(body.feet)} must equal the first route point ${fmt(points[0]!)}`);
    }
    const constraints = snapshotConstraints(request.constraints);
    // Keep the caller's provider object so a class method's `this` receiver is
    // preserved. Rule identity is carried by `version` and reconciled when it
    // changes (see `reconcileRuleVersion`); we never copy or bind the function.
    const shapeProvider = request.shapeProvider;
    // Validate the clock before replacing state, so a broken clock cannot leave a
    // half-registered route.
    this.currentNow();

    const candidate: RegisteredRoute =
      request.mode !== 'walk'
        ? {
            worldId: request.worldId,
            dim: request.dim,
            sessionId: request.sessionId,
            mode: request.mode,
            body,
            constraints,
            shapeProvider,
            ruleVersion: shapeProvider.version,
            points,
            unsupportedReason: `mode "${request.mode}" is outside the walk route verifier's range`,
            queries: [],
          }
        : {
            worldId: request.worldId,
            dim: request.dim,
            sessionId: request.sessionId,
            mode: 'walk',
            body,
            constraints,
            shapeProvider,
            ruleVersion: shapeProvider.version,
            points,
            queries: buildQueries(request.worldId, request.dim, request.sessionId, body, constraints, points),
          };

    this.route = candidate;
    this.results.clear();
    this.pending.clear();
    this.sectionToSteps.clear();
    for (let i = 0; i < candidate.queries.length; i++) this.pending.set(i, 'unprocessed');
    return this.snapshot();
  }

  /** Read-only snapshot of the current verification state; `null` before any route is registered. */
  status(): RouteStatus | null {
    if (this.route === null) return null;
    this.reconcileRuleVersion();
    return this.snapshot();
  }

  /**
   * Verify up to `budget` pending steps, in step order. Already-valid steps are
   * not recomputed; their results are preserved.
   */
  advance(budget: number): RouteStatus {
    this.requireRoute();
    this.reconcileRuleVersion();
    this.expireStale(this.currentNow());
    this.runPending(budget);
    return this.snapshot();
  }

  /**
   * Consume a `ChangeReport`: invalidate the single-step cache, drop every step
   * result that depended on a changed section (via the reverse index), then
   * re-verify within `budget`. Unaffected steps keep their current results.
   *
   * When no route is registered, the report is still consumed into the cache so
   * stale single-step entries cannot survive a later re-registration, and `null`
   * is returned.
   */
  apply(report: ChangeReport, budget: number): RouteStatus | null {
    if (this.route === null) {
      this.cache.invalidate(report);
      return null;
    }
    this.invalidate(report);
    this.runPending(budget);
    return this.snapshot();
  }

  /**
   * Invalidate the single-step cache and drop every step result that depended on a
   * changed section, without re-verifying. This lets a caller consume a report
   * (so a later re-registration or re-entrant start cannot read a stale OPEN) while
   * deferring the bounded re-verification to a separate `advance`.
   */
  invalidate(report: ChangeReport): void {
    if (this.route === null) {
      this.cache.invalidate(report);
      return;
    }
    this.reconcileRuleVersion();
    this.expireStale(this.currentNow());
    this.invalidateByReport(report);
    this.cache.invalidate(report);
  }

  /**
   * Drop step results and cached entries that depended on sections whose residency
   * changed (unload or reload). Unlike a `ChangeReport`, a residency change does
   * not advance `Section.revision`, so it must be handled by section key here; an
   * unaffected section keeps its results. The host calls this with the sections
   * `unloadSections` released or `loadSections` installed.
   */
  invalidateSections(keys: readonly SectionKey[]): void {
    this.cache.invalidateSections(keys);
    if (this.route === null) return;
    for (const key of keys) {
      const steps = this.sectionToSteps.get(sectionKeyString(key));
      if (steps === undefined) continue;
      for (const i of [...steps]) this.invalidateStep(i);
    }
  }

  /** Drop the tracked route and all its results/dependencies. The shared cache is left intact. */
  clear(): void {
    this.route = null;
    this.results.clear();
    this.pending.clear();
    this.sectionToSteps.clear();
  }

  // --- internals ---

  private requireRoute(): void {
    if (this.route === null) throw new Error('no route registered');
  }

  private currentNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new Error(`now() must return a finite number: ${now}`);
    }
    return now;
  }

  /**
   * When the collision-shape provider's `version` changes after registration, the
   * previously verified steps were computed under the old rules and can no longer
   * be reused. Drop all results and re-queue every step under the new version.
   */
  private reconcileRuleVersion(): void {
    const route = this.route;
    if (route === null) return;
    if (route.shapeProvider.version === route.ruleVersion) return;
    route.ruleVersion = route.shapeProvider.version;
    // Preserve the invalidated mark from both currently-verified results and steps
    // already pending as invalidated, so consecutive version switches do not reset
    // a step that has not yet been re-verified back to unprocessed.
    const invalidated = new Set(this.results.keys());
    for (const [i, reason] of this.pending) {
      if (reason === 'invalidated') invalidated.add(i);
    }
    this.results.clear();
    this.pending.clear();
    this.sectionToSteps.clear();
    for (let i = 0; i < route.queries.length; i++) {
      this.pending.set(i, invalidated.has(i) ? 'invalidated' : 'unprocessed');
    }
  }

  private runPending(budget: number): void {
    validateBudget(budget);
    const route = this.route;
    if (route === null || route.unsupportedReason !== undefined) return;
    const indices = [...this.pending.keys()].sort((a, b) => a - b);
    let processed = 0;
    for (const i of indices) {
      if (processed >= budget) break;
      this.verifyStep(i);
      processed += 1;
    }
  }

  private verifyStep(i: number): void {
    const route = this.route;
    if (route === null) return;
    const query = route.queries[i];
    if (query === undefined) return;
    const evaluation = this.cache.get(query, route.shapeProvider);
    this.results.set(i, evaluation);
    this.pending.delete(i);
    for (const dep of evaluation.dependencies) {
      const key = sectionKeyString(dep.key);
      let set = this.sectionToSteps.get(key);
      if (set === undefined) {
        set = new Set();
        this.sectionToSteps.set(key, set);
      }
      set.add(i);
    }
  }

  private invalidateByReport(report: ChangeReport): void {
    for (const section of report.sections) {
      const key = sectionKeyString(section.key);
      const steps = this.sectionToSteps.get(key);
      if (steps === undefined) continue;
      for (const i of [...steps]) {
        if (section.invalidated) {
          this.invalidateStep(i);
        } else {
          // Refresh-only: content is unchanged but validity was extended. A result
          // whose conclusion was limited by expired evidence (STALE or UNSUPPORTED)
          // can recover, so re-queue it locally.
          const result = this.results.get(i);
          if (result !== undefined && refreshRecoverable(result.status)) this.invalidateStep(i);
        }
      }
    }
  }

  private invalidateStep(i: number): void {
    this.pending.set(i, 'invalidated');
    const result = this.results.get(i);
    if (result === undefined) return;
    this.results.delete(i);
    for (const dep of result.dependencies) {
      const key = sectionKeyString(dep.key);
      const set = this.sectionToSteps.get(key);
      if (set === undefined) continue;
      set.delete(i);
      if (set.size === 0) this.sectionToSteps.delete(key);
    }
  }

  /**
   * Move a verified step back to pending when the live evidence its conclusion
   * rests on has expired. A STALE diagnosis is a current conclusion ("evidence is
   * missing/stale") and is kept until new evidence arrives, so it does not
   * repeatedly consume budget. Never touches map state.
   */
  private expireStale(now: number): void {
    const expired: number[] = [];
    for (const [i, result] of this.results) {
      if (result.status !== 'STALE' && now > result.validUntil) expired.push(i);
    }
    for (const i of expired) this.invalidateStep(i);
  }

  private snapshot(): RouteStatus {
    const route = this.route;
    if (route === null) throw new Error('no route registered');
    const now = this.currentNow();
    this.expireStale(now);

    const steps: RouteStepState[] = [];
    const verifiedStepIndexes: number[] = [];
    const pendingStepIndexes: number[] = [];
    let invalidatedCount = 0;
    let validUntil = Number.POSITIVE_INFINITY;
    let earliestProblem: RouteStatus['earliestProblem'] = null;
    let worst: StepStatus | null = null;

    for (let i = 0; i < route.queries.length; i++) {
      const result = this.results.get(i);
      if (result === undefined) {
        const reason = this.pending.get(i) ?? 'unprocessed';
        steps.push({ kind: 'pending', reason });
        pendingStepIndexes.push(i);
        if (reason === 'invalidated') invalidatedCount += 1;
      } else {
        steps.push({ kind: 'verified', result: cloneEvaluation(result) });
        verifiedStepIndexes.push(i);
        validUntil = Math.min(validUntil, result.validUntil);
        if (result.status !== 'OPEN') {
          if (earliestProblem === null) {
            earliestProblem = {
              stepIndex: i,
              status: result.status,
              problem: result.problem === undefined ? undefined : cloneProblem(result.problem),
            };
          }
          if (worst === null || STATUS_PRIORITY[result.status] > STATUS_PRIORITY[worst]) {
            worst = result.status;
          }
        }
      }
    }

    let openPrefix = 0;
    for (let i = 0; i < route.queries.length; i++) {
      const result = this.results.get(i);
      if (result !== undefined && result.status === 'OPEN') openPrefix += 1;
      else break;
    }

    let verdict: RouteVerdict;
    if (worst !== null) {
      verdict = worst;
    } else if (route.unsupportedReason !== undefined) {
      verdict = 'UNSUPPORTED';
    } else if (pendingStepIndexes.length === 0 && route.queries.length > 0) {
      verdict = 'OPEN';
    } else {
      verdict = 'INCOMPLETE';
    }

    return {
      worldId: route.worldId,
      dim: route.dim,
      sessionId: route.sessionId,
      mode: route.mode,
      body: cloneBody(route.body),
      ruleVersion: route.ruleVersion,
      points: route.points.map((p) => ({ ...p })),
      stepCount: route.queries.length,
      complete: pendingStepIndexes.length === 0,
      verdict,
      reason: route.unsupportedReason,
      openPrefix,
      verifiedStepIndexes,
      pendingStepIndexes,
      invalidatedCount,
      earliestProblem,
      steps,
      validUntil,
      computedAt: now,
    };
  }
}

function buildQueries(
  worldId: string,
  dim: string,
  sessionId: string,
  body: BodyContext,
  constraints: StepConstraints | undefined,
  points: Vec3Like[],
): StepQuery[] {
  const queries: StepQuery[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    queries.push({
      worldId,
      dim,
      sessionId,
      mode: 'walk',
      body: { feet: { ...from }, width: body.width, height: body.height, pose: body.pose },
      direction: classifyDirection(from, to, i),
      constraints,
    });
  }
  return queries;
}

/**
 * Classify a consecutive pair as a walk direction. A unit move is detected by
 * comparing the delta against ±1 within a small tolerance, so both directions of
 * a fractional coordinate (e.g. `1.3 → 2.3` and `2.3 → 1.3`) are accepted despite
 * floating-point subtraction error. Nothing is rounded or rewritten.
 */
function classifyDirection(from: Vec3Like, to: Vec3Like, i: number): StepDirection {
  if (to.y !== from.y) {
    throw new Error(`step ${i} changes height (Δy=${to.y - from.y}); only same-height walk steps are supported`);
  }
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const xZero = Math.abs(dx) < EPS;
  const zZero = Math.abs(dz) < EPS;
  const xUnit = Math.abs(Math.abs(dx) - 1) < EPS;
  const zUnit = Math.abs(Math.abs(dz) - 1) < EPS;

  if (xUnit && zZero) return { axis: 'x', sign: dx > 0 ? 1 : -1 };
  if (zUnit && xZero) return { axis: 'z', sign: dz > 0 ? 1 : -1 };

  if (xZero && zZero) {
    throw new Error(`step ${i} must move exactly one cell along X or Z (duplicate point)`);
  }
  if (xUnit && zUnit) {
    throw new Error(`step ${i} must move exactly one cell along X or Z (got Δx=${dx}, Δz=${dz})`);
  }
  if (xZero) {
    throw new Error(`step ${i} must be ±1 cell (got Δz=${dz})`);
  }
  throw new Error(`step ${i} must be ±1 cell (got Δx=${dx})`);
}

function snapshotPoints(points: readonly Vec3Like[]): Vec3Like[] {
  if (points.length < 2) {
    throw new Error(`a route needs at least two points, got ${points.length}`);
  }
  return points.map((p) => {
    assertFinite(p.x, 'point.x');
    assertFinite(p.y, 'point.y');
    assertFinite(p.z, 'point.z');
    return { x: p.x, y: p.y, z: p.z };
  });
}

function snapshotBody(body: BodyContext): BodyContext {
  return { feet: { ...body.feet }, width: body.width, height: body.height, pose: body.pose };
}

function snapshotConstraints(constraints: StepConstraints | undefined): StepConstraints | undefined {
  if (constraints === undefined) return undefined;
  return { avoid: (constraints.avoid ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z })) };
}

function validateBody(body: BodyContext): void {
  if (
    !Number.isFinite(body.feet.x) ||
    !Number.isFinite(body.feet.y) ||
    !Number.isFinite(body.feet.z) ||
    !Number.isFinite(body.width) ||
    !Number.isFinite(body.height)
  ) {
    throw new Error('body feet and dimensions must be finite numbers');
  }
  if (body.width <= 0 || body.height <= 0) {
    throw new Error(`body dimensions must be positive: width ${body.width}, height ${body.height}`);
  }
}

function validateBudget(budget: number): void {
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error(`budget must be a positive integer: ${budget}`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number: ${value}`);
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

function cloneBody(body: BodyContext): BodyContext {
  return { feet: { ...body.feet }, width: body.width, height: body.height, pose: body.pose };
}

function cloneProblem(problem: StepProblem): StepProblem {
  return { ...problem, cells: problem.cells.map((c) => ({ ...c })) };
}

function cloneObservation(o: Observation): Observation {
  return { ...o, pos: { ...o.pos }, state: { name: o.state.name, properties: { ...o.state.properties } } };
}

function cloneEvaluation(e: StepEvaluation): StepEvaluation {
  return {
    ...e,
    from: { ...e.from },
    to: { ...e.to },
    problem: e.problem === undefined ? undefined : cloneProblem(e.problem),
    obstacles: e.obstacles.map((o) =>
      o.kind === 'block'
        ? { kind: 'block', observation: cloneObservation(o.observation) }
        : { kind: 'contact', pos: { ...o.pos }, observedAt: o.observedAt, sessionId: o.sessionId },
    ),
    dependencies: e.dependencies.map((d) => ({ key: { ...d.key }, revision: d.revision })),
  };
}
