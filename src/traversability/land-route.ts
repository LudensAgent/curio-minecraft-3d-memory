/**
 * Read-only bounded verifier for an explicitly selected, ordered land route.
 *
 * The route is a list of typed transitions with exact feet coordinates. This
 * verifier never searches, infers a transition kind from points, rounds or snaps
 * coordinates, moves the body, digs, places, saves or executes. It composes the
 * pure `evaluateLandTransition` evaluator over the route and returns
 * `assurance: 'geometry_only'`, `executable: false` snapshots.
 *
 * `advance`/`apply` process pending transitions in declared order under a
 * per-call work budget. Budget-exhausted transitions stay pending and are
 * retried from scratch by a later call; the status carries an explicit
 * `budgetGap` (`used` / `requiredAtLeast`) instead of silently remaining
 * INCOMPLETE forever. Results are revoked locally by Section `ChangeReport`,
 * provider/model version changes, evidence TTL expiry and Section
 * unload/reload residency changes.
 */

import { sectionKeyString } from '../voxel/section.js';
import type { SectionKey } from '../voxel/section.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import { cloneLandTransitionEvaluation, evaluateLandTransition, resolveLandLimits } from './land-transition.js';
import type {
  LandLimits,
  LandRules,
  LandTransition,
  LandTransitionEvaluation,
  LandTransitionReason,
  LandTransitionStatus,
} from './land-transition.js';
import type { BodyContext } from './step.js';

/** Why a transition still needs verification. */
export type LandRoutePendingReason = 'unprocessed' | 'invalidated';

/** Per-transition route state. */
export type LandRouteSegmentState =
  | { kind: 'verified'; result: LandTransitionEvaluation }
  | { kind: 'pending'; reason: LandRoutePendingReason };

/** Snapshot of the provider/model identities that produced current proofs. */
export interface LandRuleVersions {
  shapeProvider: string;
  jumpModel?: string;
  climbProvider?: string;
}

/** Explicit per-call budget shortfall. Pass at least `requiredAtLeast` on the next call. */
export interface LandRouteBudgetGap {
  /** Work units actually consumed by this call. */
  used: number;
  /** Lower bound on the budget needed to finish the next pending transition from scratch. */
  requiredAtLeast: number;
}

/** Input describing one route plus the fixed context under which it is verified. */
export interface LandRouteRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Fixed body width/height/standing pose; `feet` must exactly equal the first `from`. */
  body: BodyContext;
  rules: LandRules;
  /** Ordered typed transitions (≥ 1) with exact joined endpoints. Snapshot on registration. */
  transitions: readonly LandTransition[];
}

export interface LandRouteVerifierOptions {
  /** Clock for TTL expiry; must return values comparable to observation times. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional bounded work/allocation limits; missing fields use `DEFAULT_LAND_LIMITS`. */
  limits?: Partial<LandLimits>;
}

/** Read-only route snapshot; never aliases internal state. */
export interface LandRouteStatus {
  worldId: string;
  dim: string;
  sessionId: string;
  assurance: 'geometry_only';
  executable: false;
  body: BodyContext;
  /** Provider/model identities that produced the current proofs. */
  ruleVersions: LandRuleVersions;
  /** Original typed transitions (snapshot copy, exact coordinates). */
  transitions: LandTransition[];
  transitionCount: number;
  /** True only when every transition currently has a verified conclusion. */
  complete: boolean;
  /** Route verdict; OPEN only when every transition is currently OPEN. */
  verdict: LandTransitionStatus;
  reason?: string;
  /** Leading consecutive verified OPEN transitions from the start. */
  openPrefix: number;
  verifiedTransitionIndexes: number[];
  pendingTransitionIndexes: number[];
  /** Number of pending transitions whose previous result was invalidated/expired. */
  invalidatedCount: number;
  /** Earliest verified non-OPEN transition, when any. */
  earliestProblem: {
    transitionIndex: number;
    status: LandTransitionStatus;
    reason?: LandTransitionReason;
  } | null;
  /** Per-transition state, indexed by transition index. */
  segments: LandRouteSegmentState[];
  /** min validUntil over verified transitions. */
  validUntil: number;
  computedAt: number;
  /** Present when the last advance/apply call ran out of work budget. */
  budgetGap?: LandRouteBudgetGap;
}

interface RegisteredRoute {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  rules: LandRules;
  versions: LandRuleVersions;
  transitions: LandTransition[];
}

const STATUS_PRIORITY: Record<LandTransitionStatus, number> = {
  OPEN: 0,
  INCOMPLETE: 1,
  UNKNOWN: 2,
  STALE: 3,
  UNSUPPORTED: 4,
  BLOCKED: 5,
};

/**
 * @example Full call order (observe → register → bounded advance → ChangeReport → re-verify → read):
 * ```ts
 * const verifier = new LandRouteVerifier(map, { now });
 * verifier.register({
 *   worldId: 'world', dim: 'overworld', sessionId: 's1',
 *   body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
 *   rules: { shapeProvider, jumpModel },        // test models are geometric only
 *   transitions: [
 *     { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 0.5 } },
 *   ],
 * });
 * const first = verifier.advance(4096);         // bounded per-call work
 * verifier.apply(map.observe(observation), 4096); // local invalidation + bounded re-verify
 * verifier.status();                            // isolated read-only snapshot
 * ```
 */
export class LandRouteVerifier {
  private readonly map: VoxelMap;
  private readonly now: () => number;
  private readonly limits: LandLimits;

  private route: RegisteredRoute | null = null;
  private readonly results = new Map<number, LandTransitionEvaluation>();
  private readonly pending = new Map<number, LandRoutePendingReason>();
  private readonly sectionToTransitions = new Map<string, Set<number>>();
  private readonly transitionResidency = new Map<number, { key: SectionKey; generation: number }[]>();
  private budgetGap: LandRouteBudgetGap | undefined;

  constructor(map: VoxelMap, options: LandRouteVerifierOptions = {}) {
    this.map = map;
    this.now = options.now ?? Date.now;
    this.limits = resolveLandLimits(options.limits);
  }

  /**
   * Register (or replace) the tracked route. All validation and snapshotting
   * happens before the current route is replaced, so a rejected request leaves
   * the previous route and results intact.
   */
  register(request: LandRouteRequest): LandRouteStatus {
    // Validate the clock before replacing state, so a broken clock cannot leave a
    // half-registered route.
    this.currentNow();
    if (request.worldId !== this.map.worldId) {
      throw new Error(`request worldId "${request.worldId}" does not match map worldId "${this.map.worldId}"`);
    }
    if (typeof request.dim !== 'string' || request.dim.length === 0) {
      throw new Error('request dim must be a non-empty string');
    }
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      throw new Error('request sessionId must be a non-empty string');
    }
    const body = snapshotBody(request.body);
    validateBody(body);
    if (request.rules === null || typeof request.rules !== 'object') {
      throw new Error('request rules are required');
    }
    const rules = snapshotRules(request.rules);
    const versions = snapshotVersions(rules);
    const transitions = snapshotTransitions(request.transitions);
    if (transitions.length > this.limits.maxTransitions) {
      throw new Error(
        `route has ${transitions.length} transitions, exceeding the limit of ${this.limits.maxTransitions}`,
      );
    }
    const first = transitions[0]!;
    if (!pointsEqual(body.feet, first.from)) {
      throw new Error(
        `body.feet (${fmt(body.feet)}) must exactly equal the first transition.from (${fmt(first.from)})`,
      );
    }
    for (let i = 1; i < transitions.length; i++) {
      const previous = transitions[i - 1]!;
      const current = transitions[i]!;
      if (!pointsEqual(previous.to, current.from)) {
        throw new Error(
          `transition ${i}.from (${fmt(current.from)}) must exactly equal transition ${i - 1}.to (${fmt(previous.to)})`,
        );
      }
    }

    this.route = {
      worldId: request.worldId,
      dim: request.dim,
      sessionId: request.sessionId,
      body,
      rules,
      versions,
      transitions,
    };
    this.results.clear();
    this.pending.clear();
    this.sectionToTransitions.clear();
    this.transitionResidency.clear();
    this.budgetGap = undefined;
    for (let i = 0; i < transitions.length; i++) this.pending.set(i, 'unprocessed');
    return this.snapshot();
  }

  /** Read-only snapshot; `null` before any route is registered. Never extends a proof's TTL. */
  status(): LandRouteStatus | null {
    if (this.route === null) return null;
    this.reconcileVersions();
    return this.snapshot();
  }

  /** Verify pending transitions in declared order under a per-call work budget. */
  advance(budget: number): LandRouteStatus {
    this.requireRoute();
    this.runPending(budget);
    return this.snapshot();
  }

  /**
   * Consume a `ChangeReport`: revoke only transitions whose recorded Section
   * dependencies were invalidated (or whose STALE conclusion can recover on a
   * refresh-only change), then re-verify within `budget`.
   */
  apply(report: ChangeReport, budget: number): LandRouteStatus | null {
    validateBudget(budget);
    if (this.route === null) return null;
    this.reconcileVersions();
    this.expireStale(this.currentNow());
    this.invalidateByReport(report);
    this.runPending(budget);
    return this.snapshot();
  }

  /**
   * Consume a `ChangeReport` without re-verifying. This lets a caller revoke an
   * old OPEN immediately and defer bounded re-verification to `advance`.
   */
  invalidate(report: ChangeReport): void {
    if (this.route === null) return;
    this.reconcileVersions();
    this.expireStale(this.currentNow());
    this.invalidateByReport(report);
  }

  /** Revoke results that depended on Sections whose residency changed (unload/reload). */
  invalidateSections(keys: readonly SectionKey[]): void {
    if (this.route === null) return;
    for (const key of keys) {
      const indexes = this.sectionToTransitions.get(sectionKeyString(key));
      if (indexes === undefined) continue;
      for (const i of [...indexes]) this.invalidateTransition(i);
    }
  }

  /** Drop the tracked route and all results/dependencies. The map is untouched. */
  clear(): void {
    this.route = null;
    this.results.clear();
    this.pending.clear();
    this.sectionToTransitions.clear();
    this.transitionResidency.clear();
    this.budgetGap = undefined;
  }

  // --- internals ---

  private requireRoute(): RegisteredRoute {
    if (this.route === null) throw new Error('no land route registered');
    return this.route;
  }

  private currentNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error(`now() must return a finite number: ${now}`);
    return now;
  }

  private runPending(budget: number): void {
    validateBudget(budget);
    const route = this.requireRoute();
    const now = this.currentNow();
    this.reconcileVersions();
    this.expireStale(now);
    this.invalidateByResidency();
    this.budgetGap = undefined;

    const pending = [...this.pending.keys()].sort((a, b) => a - b);
    let used = 0;
    for (const i of pending) {
      if (used >= budget) {
        this.budgetGap = { used, requiredAtLeast: used + 1 };
        return;
      }
      const remaining = budget - used;
      const limits: LandLimits = { ...this.limits, maxWork: Math.min(this.limits.maxWork, remaining) };
      const transition = route.transitions[i]!;
      const evaluation = evaluateLandTransition(
        this.map,
        {
          worldId: route.worldId,
          dim: route.dim,
          sessionId: route.sessionId,
          // The route body fixes width/height/pose; each transition starts at
          // its own exact feet position.
          body: {
            feet: { x: transition.from.x, y: transition.from.y, z: transition.from.z },
            width: route.body.width,
            height: route.body.height,
            pose: route.body.pose,
          },
          transition,
        },
        route.rules,
        now,
        limits,
      );
      used += evaluation.work.used;
      if (evaluation.status === 'INCOMPLETE' && evaluation.work.exhausted) {
        // Do not store a budget-limited attempt: the transition stays pending and
        // is retried from scratch when the caller supplies a larger budget.
        this.budgetGap = {
          used,
          requiredAtLeast: Math.max(used + 1, evaluation.work.requiredAtLeast),
        };
        return;
      }
      this.storeResult(i, evaluation);
    }
  }

  private storeResult(index: number, evaluation: LandTransitionEvaluation): void {
    const stored = cloneLandTransitionEvaluation(evaluation);
    this.results.set(index, stored);
    this.pending.delete(index);
    this.transitionResidency.set(
      index,
      stored.dependencies.map((dep) => ({ key: { ...dep.key }, generation: dep.generation })),
    );
    for (const dep of stored.dependencies) {
      const key = sectionKeyString(dep.key);
      let indexes = this.sectionToTransitions.get(key);
      if (indexes === undefined) {
        indexes = new Set();
        this.sectionToTransitions.set(key, indexes);
      }
      indexes.add(index);
    }
  }

  /**
   * When any provider/model version changes, old proofs were made under a
   * different identity. Revoke all results and re-queue only the transitions
   * that had actually been verified (unprocessed ones stay unprocessed).
   */
  private reconcileVersions(): void {
    const route = this.route;
    if (route === null) return;
    const live = snapshotVersions(route.rules);
    if (versionsEqual(live, route.versions)) return;
    route.versions = live;
    const invalidated = new Set<number>(this.results.keys());
    for (const [i, reason] of this.pending) {
      if (reason === 'invalidated') invalidated.add(i);
    }
    this.results.clear();
    this.pending.clear();
    this.sectionToTransitions.clear();
    this.transitionResidency.clear();
    for (let i = 0; i < route.transitions.length; i++) {
      this.pending.set(i, invalidated.has(i) ? 'invalidated' : 'unprocessed');
    }
  }

  private invalidateByReport(report: ChangeReport): void {
    for (const section of report.sections) {
      const indexes = this.sectionToTransitions.get(sectionKeyString(section.key));
      if (indexes === undefined) continue;
      for (const i of [...indexes]) {
        if (section.invalidated) {
          this.invalidateTransition(i);
        } else {
          // Refresh-only: content is unchanged, but validity was extended. Only a
          // STALE conclusion can be limited by expired evidence and recover here.
          const result = this.results.get(i);
          if (result !== undefined && result.status === 'STALE') this.invalidateTransition(i);
        }
      }
    }
  }

  private invalidateTransition(index: number): void {
    this.pending.set(index, 'invalidated');
    const result = this.results.get(index);
    if (result === undefined) return;
    this.results.delete(index);
    this.transitionResidency.delete(index);
    for (const dep of result.dependencies) {
      const key = sectionKeyString(dep.key);
      const indexes = this.sectionToTransitions.get(key);
      if (indexes === undefined) continue;
      indexes.delete(index);
      if (indexes.size === 0) this.sectionToTransitions.delete(key);
    }
  }

  /**
   * Move verified results back to pending when their evidence horizon passes.
   * A current STALE diagnosis is kept (it reports missing/stale evidence) until
   * a refresh report or a new observation invalidates it.
   */
  private expireStale(now: number): void {
    for (const [i, result] of this.results) {
      if (result.status !== 'STALE' && now > result.validUntil) this.invalidateTransition(i);
    }
  }

  /** Residency changes (unload/reload) do not advance Section.revision, so check generations. */
  private invalidateByResidency(): void {
    for (const [i, deps] of this.transitionResidency) {
      for (const dep of deps) {
        if (this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy) !== dep.generation) {
          this.invalidateTransition(i);
          break;
        }
      }
    }
  }

  private snapshot(): LandRouteStatus {
    const route = this.requireRoute();
    const now = this.currentNow();
    // The clock may have advanced since `advance`/`status` started; never return an
    // old OPEN past its evidence horizon.
    this.expireStale(now);
    this.invalidateByResidency();

    const segments: LandRouteSegmentState[] = [];
    const verifiedTransitionIndexes: number[] = [];
    const pendingTransitionIndexes: number[] = [];
    let invalidatedCount = 0;
    let validUntil = Number.POSITIVE_INFINITY;
    let earliestProblem: LandRouteStatus['earliestProblem'] = null;
    let worst: LandTransitionStatus | null = null;

    for (let i = 0; i < route.transitions.length; i++) {
      const result = this.results.get(i);
      if (result === undefined) {
        const reason = this.pending.get(i) ?? 'unprocessed';
        segments.push({ kind: 'pending', reason });
        pendingTransitionIndexes.push(i);
        if (reason === 'invalidated') invalidatedCount += 1;
        continue;
      }
      segments.push({ kind: 'verified', result: cloneLandTransitionEvaluation(result) });
      verifiedTransitionIndexes.push(i);
      validUntil = Math.min(validUntil, result.validUntil);
      if (result.status !== 'OPEN') {
        if (earliestProblem === null) {
          earliestProblem = {
            transitionIndex: i,
            status: result.status,
            reason: result.reason === undefined ? undefined : cloneReason(result.reason),
          };
        }
        if (worst === null || STATUS_PRIORITY[result.status] > STATUS_PRIORITY[worst]) {
          worst = result.status;
        }
      }
    }

    let openPrefix = 0;
    for (let i = 0; i < route.transitions.length; i++) {
      const result = this.results.get(i);
      if (result !== undefined && result.status === 'OPEN') openPrefix += 1;
      else break;
    }

    let verdict: LandTransitionStatus;
    let reason: string | undefined;
    if (worst !== null) {
      verdict = worst;
      reason = earliestProblem?.reason?.detail;
    } else if (pendingTransitionIndexes.length > 0) {
      verdict = 'INCOMPLETE';
      reason =
        this.budgetGap === undefined
          ? 'not every transition has been verified yet'
          : 'work budget exhausted before all transitions were evaluated';
    } else {
      verdict = 'OPEN';
    }

    return {
      worldId: route.worldId,
      dim: route.dim,
      sessionId: route.sessionId,
      assurance: 'geometry_only',
      executable: false,
      body: cloneBody(route.body),
      ruleVersions: cloneVersions(route.versions),
      transitions: route.transitions.map(cloneTransition),
      transitionCount: route.transitions.length,
      complete: pendingTransitionIndexes.length === 0,
      verdict,
      reason,
      openPrefix,
      verifiedTransitionIndexes,
      pendingTransitionIndexes,
      invalidatedCount,
      earliestProblem,
      segments,
      validUntil,
      computedAt: now,
      budgetGap: this.budgetGap === undefined ? undefined : { ...this.budgetGap },
    };
  }
}

function snapshotRules(rules: LandRules): LandRules {
  if (rules.shapeProvider === null || typeof rules.shapeProvider !== 'object') {
    throw new Error('rules.shapeProvider is required');
  }
  return {
    shapeProvider: rules.shapeProvider,
    jumpModel: rules.jumpModel,
    climbProvider: rules.climbProvider,
  };
}

function snapshotVersions(rules: LandRules): LandRuleVersions {
  assertVersion(rules.shapeProvider.version, 'shapeProvider.version');
  const versions: LandRuleVersions = { shapeProvider: rules.shapeProvider.version };
  if (rules.jumpModel !== undefined) {
    assertVersion(rules.jumpModel.version, 'jumpModel.version');
    versions.jumpModel = rules.jumpModel.version;
  }
  if (rules.climbProvider !== undefined) {
    assertVersion(rules.climbProvider.version, 'climbProvider.version');
    versions.climbProvider = rules.climbProvider.version;
  }
  return versions;
}

function versionsEqual(a: LandRuleVersions, b: LandRuleVersions): boolean {
  return (
    a.shapeProvider === b.shapeProvider &&
    a.jumpModel === b.jumpModel &&
    a.climbProvider === b.climbProvider
  );
}

function cloneVersions(versions: LandRuleVersions): LandRuleVersions {
  const out: LandRuleVersions = { shapeProvider: versions.shapeProvider };
  if (versions.jumpModel !== undefined) out.jumpModel = versions.jumpModel;
  if (versions.climbProvider !== undefined) out.climbProvider = versions.climbProvider;
  return out;
}

function snapshotTransitions(transitions: readonly LandTransition[]): LandTransition[] {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    throw new Error('a land route needs at least one transition');
  }
  return transitions.map((transition, i) => {
    if (transition === null || typeof transition !== 'object') {
      throw new Error(`transition ${i} must be an object`);
    }
    if (
      transition.kind !== 'step' &&
      transition.kind !== 'drop' &&
      transition.kind !== 'jump' &&
      transition.kind !== 'ladder'
    ) {
      throw new Error(`transition ${i} has an unknown kind: ${String(transition.kind)}`);
    }
    for (const [label, point] of [
      [`transition ${i}.from`, transition.from],
      [`transition ${i}.to`, transition.to],
    ] as const) {
      if (
        point === null ||
        typeof point !== 'object' ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.z)
      ) {
        throw new Error(`${label} must have finite coordinates`);
      }
    }
    return {
      kind: transition.kind,
      from: { x: transition.from.x, y: transition.from.y, z: transition.from.z },
      to: { x: transition.to.x, y: transition.to.y, z: transition.to.z },
    };
  });
}

function snapshotBody(body: BodyContext): BodyContext {
  return {
    feet: { x: body.feet.x, y: body.feet.y, z: body.feet.z },
    width: body.width,
    height: body.height,
    pose: body.pose,
  };
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
  if (body.pose !== 'standing') throw new Error(`body pose must be "standing": ${String(body.pose)}`);
}

function validateBudget(budget: number): void {
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error(`budget must be a positive integer: ${budget}`);
  }
}

function assertVersion(version: string, label: string): void {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function pointsEqual(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function fmt(point: { x: number; y: number; z: number }): string {
  return `(${point.x}, ${point.y}, ${point.z})`;
}

function cloneBody(body: BodyContext): BodyContext {
  return {
    feet: { x: body.feet.x, y: body.feet.y, z: body.feet.z },
    width: body.width,
    height: body.height,
    pose: body.pose,
  };
}

function cloneTransition(transition: LandTransition): LandTransition {
  return {
    kind: transition.kind,
    from: { ...transition.from },
    to: { ...transition.to },
  };
}

function cloneReason(reason: LandTransitionReason): LandTransitionReason {
  return { ...reason, cells: reason.cells.map((cell) => ({ ...cell })) };
}
