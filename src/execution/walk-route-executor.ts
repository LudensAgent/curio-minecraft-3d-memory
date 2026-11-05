/**
 * Controlled walk-route execution loop (design §7 `navigate_to` first step).
 *
 * `WalkRouteExecutor` composes the read-only `RouteVerifier` over an
 * already-selected, ordered walk route with an injectable `MoveExecutor` and
 * measured body feedback. It drives the route one step at a time:
 *
 * - A step is only started when (a) a measured body sample confirms the body is
 *   at the step's from-point and (b) the step's evidence is currently OPEN.
 * - The next step is only started after the previous step's arrival has been
 *   confirmed by a measured body sample.
 * - An `ARRIVED` result requires the measured position to satisfy the original
 *   completion condition (strict by default; explicit grounded tolerances opt in) under the delegation's
 *   world/dim/session — never a bare promise resolve or a route whose steps are
 *   all OPEN.
 *
 * Body samples are trusted only by execution association (`executionId`) plus a
 * monotonic per-delegation sequence and a non-decreasing observation time —
 * never by a "timestamp strictly greater than start" rule, which would drop
 * same-millisecond samples or accept replayed ones.
 *
 * The loop always records a trusted body sample's displacement *before* deciding
 * the terminal state, so a timeout or invalidation preserves the measured partial
 * effect without being turned into an ARRIVED. Every external stop/abort callback
 * is treated as possibly re-entrant: handles are detached first and delegation
 * ownership is re-checked before any later state write.
 */

import type { LastObservation, NavProblem, NavResult } from '../navigation/types.js';
import type { Observation } from '../observation/types.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionKey } from '../voxel/section.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import { RouteVerifier } from '../traversability/route.js';
import type { RouteStatus } from '../traversability/route.js';
import { evaluateGroundedWalkSegment } from '../traversability/step.js';
import type { StepEvaluation } from '../traversability/step.js';
import type { ObstacleEvidence } from '../traversability/types.js';
import type { Vec3Like } from '../types.js';
import type {
  BodySample,
  ExecutableMoveResult,
  MoveExecutor,
  WalkRouteRequest,
  WalkRouteStatus,
} from './types.js';

export interface WalkRouteExecutorOptions {
  /** Clock for TTL/deadline checks; must return values comparable to observation times. Defaults to `Date.now`. */
  now?: () => number;
  /** Maximum number of route points; forwarded to the verifier. Defaults to 1024. */
  maxRouteLength?: number;
}

const POS_EPS = 1e-6;

type FailureOutcome = 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED';
type CancelBy = 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';

/** A terminal reason (deadline / per-move timeout / basis invalidation), not yet written to state. */
interface TerminalReason {
  outcome: FailureOutcome;
  message: string;
  problem: NavProblem;
}

/** The previous delegation's last accepted evidence, preserved at handover. */
interface HandoverSnapshot {
  sample: BodySample;
  trace: { pos: Vec3Like; ts: number }[];
}

/**
 * Controlled execution of an ordered walk route. One instance drives one
 * delegation at a time; `start` replaces (and orphans) any previous one.
 */
export class WalkRouteExecutor {
  private readonly map: VoxelMap;
  private readonly executor: MoveExecutor;
  private readonly verifier: RouteVerifier;
  private readonly now: () => number;

  private request: WalkRouteRequest | null = null;
  private generation = 0;
  private delegationId = '';
  /** Delegation start time (clock); samples must not predate it. */
  private startedAt = 0;
  /** Non-decreasing observation floor; equal values are allowed (same-ms). */
  private lastSampleObservedAt = 0;
  /** Strictly-increasing per-delegation sample sequence; rejects replayed samples. */
  private lastSampleSequence = 0;
  private nextPointIndex = 1;
  private lastPosition: Vec3Like | null = null;
  private lastSample: BodySample | null = null;
  private settledSince: number | null = null;
  private settledSamples = 0;
  private settledPoint = -1;
  /** Actual origin of the current/recent segment, retained across control release. */
  private measuredFrom: Vec3Like | null = null;
  /** Per-delegation handover snapshot, bound to the replaced delegation's identity. */
  private handovers = new Map<number, HandoverSnapshot>();
  /** Section dependencies of the action being released, kept until the final commit. */
  private releasedDependencies: Set<string> | null = null;
  /** True when a report invalidated the released action's dependencies during the stop. */
  private releasedInvalidated = false;
  private activeStepIndex: number | null = null;
  private activeExecutionId: string | null = null;
  private activeAbort: AbortController | null = null;
  private activeDependencies: Set<string> | null = null;
  /** Residency generation of each active dependency at start time, for unload detection. */
  private activeDependencyResidency: { key: SectionKey; generation: number }[] | null = null;
  private activeRuleVersion: string | null = null;
  private activeValidUntil = Number.POSITIVE_INFINITY;
  private activeStartedAt: number | null = null;
  private trace: { pos: Vec3Like; ts: number }[] = [];
  private result: NavResult | null = null;
  /** Nesting depth of stopActive's external stop/abort callbacks; re-scheduling is forbidden while > 0. */
  private releasing = 0;
  /** Per-generation nesting depth of cancel() while releasing control; a re-entrant start() preserves that snapshot. */
  private cancellingDepth = new Map<number, number>();

  constructor(map: VoxelMap, executor: MoveExecutor, options: WalkRouteExecutorOptions = {}) {
    this.map = map;
    this.executor = executor;
    this.now = options.now ?? Date.now;
    this.verifier = new RouteVerifier(map, { now: this.now, maxRouteLength: options.maxRouteLength });
  }

  /**
   * Begin (or replace) a delegation. Malformed geometry/body/world/clock throws;
   * capability gaps (mode/arrival/avoid) become a terminal result on the returned
   * status instead of being silently ignored.
   */
  start(request: WalkRouteRequest): WalkRouteStatus {
    if (request.worldId !== this.map.worldId) {
      throw new Error(`request worldId "${request.worldId}" does not match map worldId "${this.map.worldId}"`);
    }
    if (!Number.isFinite(request.deadlineMs)) {
      throw new Error(`deadlineMs must be a finite number: ${request.deadlineMs}`);
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive finite number: ${request.timeoutMs}`);
    }
    if (request.bodyArrival !== undefined) {
      const a = request.bodyArrival;
      if (![a.horizontalTolerance, a.feetTolerance, a.maxHorizontalSpeed, a.maxVerticalSpeed, a.stableMs].every((v) => Number.isFinite(v) && v >= 0)
        || a.horizontalTolerance <= 0 || a.horizontalTolerance >= 0.5
        || a.feetTolerance >= 0.5 || a.stableMs <= 0) {
        throw new Error('bodyArrival requires finite nonnegative limits, horizontalTolerance in (0, 0.5), feetTolerance < 0.5, and positive stableMs');
      }
    }
    const points = snapshotPoints(request.points);
    const body = snapshotBody(request.body);

    // Register with the verifier first: it throws on malformed geometry/body/worldId/clock
    // and leaves the existing route intact on rejection.
    this.verifier.register({
      worldId: request.worldId,
      dim: request.dim,
      sessionId: request.sessionId,
      mode: request.mode,
      body,
      constraints: request.constraints,
      shapeProvider: request.shapeProvider,
      points,
    });

    // Orphan any in-flight move from the previous delegation before replacing state.
    const previousGeneration = this.generation;
    this.generation += 1;
    const myGeneration = this.generation;
    this.delegationId = `walk-${myGeneration}`;
    // Preserve the previous delegation's last accepted evidence (position, time and
    // confirmed trace) only when its cancel() is still releasing control and may need it.
    if ((this.cancellingDepth.get(previousGeneration) ?? 0) > 0 && this.lastSample !== null) {
      this.handovers.set(previousGeneration, {
        sample: snapshotSample(this.lastSample),
        trace: this.trace.map((t) => ({ pos: { ...t.pos }, ts: t.ts })),
      });
    }
    this.stopActive();
    if (this.generation !== myGeneration) {
      // A re-entrant start() (from the stop/abort callback) superseded this one.
      return this.snapshot();
    }

    this.request = snapshotRequest(request, points, body);
    this.startedAt = this.currentNow();
    this.lastSampleObservedAt = this.startedAt;
    this.lastSampleSequence = 0;
    this.nextPointIndex = 1;
    this.lastPosition = null;
    this.lastSample = null;
    this.settledSince = null;
    this.settledSamples = 0;
    this.settledPoint = -1;
    this.measuredFrom = null;
    this.trace = [];
    this.result = null;
    this.releasedDependencies = null;
    this.releasedInvalidated = false;

    if (request.mode !== 'walk') {
      this.result = this.buildFailure('FAILED', `mode "${request.mode}" is not supported by the walk executor`, {
        kind: 'unsupported_mode',
        mode: request.mode,
        detail: 'only walk is supported this round',
      });
    } else if (request.arrival.kind !== 'exact') {
      this.result = this.buildFailure('FAILED', `arrival kind "${request.arrival.kind}" is not supported this round`, {
        kind: 'unsupported_target',
        detail: 'only the exact foot-position completion condition is supported',
      });
    } else if ((request.constraints?.avoid?.length ?? 0) > 0) {
      this.result = this.buildFailure('FAILED', 'the avoid constraint is not implemented this round', {
        kind: 'not_authorized',
        detail: 'a non-empty avoid is not yet effective and cannot be silently ignored',
      });
    }

    return this.snapshot();
  }

  /** Read-only snapshot; null before any delegation. */
  status(): WalkRouteStatus | null {
    if (this.request === null) return null;
    return this.snapshot();
  }

  /** Advance one bounded round: run the terminal guard, re-verify within budget, re-guard, then start at most one step. */
  advance(budget: number): WalkRouteStatus {
    this.requireRequest();
    validateBudget(budget);
    if (this.releasing > 0) return this.snapshot(); // releasing control: defer step advancement
    if (this.guard()) return this.snapshot();

    // Bounded re-verify.
    this.verifier.advance(budget);

    // Re-check the deadline and in-flight basis after verification: the clock may
    // have crossed the deadline or a TTL/rule boundary during re-verification.
    if (this.guard()) return this.snapshot();

    if (this.activeStepIndex !== null) return this.snapshot(); // still in flight
    if (this.nextPointIndex >= this.points.length) return this.snapshot();

    const stepIndex = this.nextPointIndex - 1;
    const from = this.points[stepIndex]!;

    // Start gate: the body must already be measured at the segment's from-point.
    if (this.lastPosition === null) {
      this.result = this.buildFailure('FAILED', 'no measured body position confirms the segment start', {
        kind: 'unmeasured_position',
        expected: { ...from },
      });
      return this.snapshot();
    }
    if (!this.positionMatches(this.lastPosition, from)) {
      this.result = this.buildFailure('FAILED', 'the body deviated from the route', {
        kind: 'deviation',
        expected: { ...from },
        actual: { ...this.lastPosition },
      });
      return this.snapshot();
    }

    if (this.request!.bodyArrival !== undefined && (this.lastSample === null || !this.arrivalReady(this.lastSample, stepIndex))) return this.snapshot();
    this.startMove(stepIndex);
    return this.snapshot();
  }

  /** Consume a `ChangeReport`: invalidate the cache, revoke an invalidated in-flight step, then re-verify within budget. */
  observe(report: ChangeReport, budget: number): WalkRouteStatus {
    this.requireRequest();
    validateBudget(budget);
    const generation = this.generation;

    // Invalidate the cache BEFORE any stop/abort callback, so a re-entrant start()
    // cannot read a stale OPEN cached from before this report.
    this.verifier.invalidate(report);

    // Mark a released action as invalidated when the report touches its dependencies.
    if (this.releasedDependencies !== null) {
      const touched = report.sections.some(
        (section) => section.invalidated && this.releasedDependencies!.has(sectionKeyString(section.key)),
      );
      const target = this.points[this.nextPointIndex];
      if (touched && (this.request!.bodyArrival === undefined || (this.releasing > 0 && target !== undefined
        && (this.measuredFrom === null || this.evaluateMeasured(this.measuredFrom, target).status !== 'OPEN')))) this.releasedInvalidated = true;
    }

    // Refresh-only observations do not bump a section revision. Recompute from
    // their original per-cell timestamps before the TTL guard; observing one
    // cell cannot extend the lifetime of any other required cell.
    const measuredEvaluation = this.request!.bodyArrival !== undefined && this.activeStepIndex !== null
      && this.measuredFrom !== null && this.reportTouchesActiveStep(report)
      ? this.evaluateMeasured(this.measuredFrom, this.points[this.nextPointIndex]!) : null;
    if (measuredEvaluation?.status === 'OPEN') this.updateMeasuredBasis(measuredEvaluation);

    this.guard(); // may re-enter start() via the stop/abort callback

    // Judge the report against the active step only if this call still owns the
    // delegation; a re-entrant start() would have replaced the active dependencies.
    if (generation === this.generation && this.result === null && this.activeStepIndex !== null && this.reportTouchesActiveStep(report)) {
      // A Section can contain unrelated/newly perceived cells or later route
      // segments. Revoke only when THIS measured corridor lost its basis.
      if (measuredEvaluation?.status !== 'OPEN') {
        this.terminate('FAILED', 'the in-flight segment was invalidated by an observed world change', {
          kind: 'route_invalidated',
          detail: 'the current segment is no longer verified OPEN after observation',
        });
      }
    }

    // Re-verify (bounded) after the affected action has been revoked.
    this.verifier.advance(budget);
    this.guard();

    return this.snapshot();
  }

  /** Accept measured body feedback (host push). Handles boundary validation, association, ordering, scope, lifecycle and position. */
  onSample(sample: BodySample): WalkRouteStatus {
    this.requireRequest();
    if (this.result !== null) return this.snapshot();

    // A sample may update evidence only when finite, belonging to this delegation
    // and in order. Invalid samples never update evidence, but the terminal check
    // below still runs.
    const usable =
      this.sampleFinite(sample) && sample.executionId === this.delegationId && this.sampleOrdered(sample);

    if (usable && !this.scopeMatches(sample)) {
      this.terminate('FAILED', 'the body left the delegation scope before arrival', {
        kind: 'scope_changed',
        detail: 'sample world/dim/session does not match the delegation',
      });
      return this.snapshot();
    }
    if (usable && this.lifecycleBroken(sample)) {
      this.recordSamplePosition(sample); // preserve the latest trusted position before terminating
      this.terminate('FAILED', 'the body became unavailable before arrival', {
        kind: 'unavailable',
        detail: `alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
      });
      return this.snapshot();
    }

    if (usable) this.recordSamplePosition(sample);

    // Always run the terminal check: an invalid sample must not bypass a deadline
    // or TTL that has already been crossed.
    if (this.guard()) return this.snapshot();

    if (!usable) return this.snapshot();

    // During control release, accept the trusted position but defer ordinary arrival
    // and step-deviation determination to the completing flow.
    if (this.releasing > 0) return this.snapshot();

    if (this.activeStepIndex !== null) {
      const target = this.points[this.nextPointIndex];
      if (target !== undefined && this.arrivalReady(sample, this.nextPointIndex)) {
        this.confirmArrival(sample);
      }
      // else: intermediate progress, already recorded.
    } else {
      const expected = this.points[this.nextPointIndex - 1]!;
      if (!this.positionMatches(sample.pos, expected)) {
        this.result = this.buildFailure('FAILED', 'the body deviated from the route', {
          kind: 'deviation',
          expected: { ...expected },
          actual: { ...sample.pos },
        });
      }
      // else: re-confirmed, already recorded.
    }

    return this.snapshot();
  }

  /** Host-driven timeout check; runs the terminal guard. */
  checkTimeout(): WalkRouteStatus {
    this.requireRequest();
    this.guard();
    return this.snapshot();
  }

  /** Active cancel; preserves confirmed partial displacement. Returns an isolated terminal result. */
  cancel(by: CancelBy, reason: string): NavResult {
    if (this.result !== null) return cloneResult(this.result);
    this.requireRequest();
    const generation = this.generation;
    const message = `cancelled by ${by}${reason ? `: ${reason}` : ''}`;
    const problem: NavProblem = { kind: 'cancelled', by, reason };
    // Build the cancellation snapshot before releasing: a re-entrant start() must
    // not replace the displacement this cancellation reports.
    const cancelled = this.buildFailure('CANCELLED', message, problem);
    this.cancellingDepth.set(generation, (this.cancellingDepth.get(generation) ?? 0) + 1);
    try {
      this.stopActive();
    } finally {
      const depth = (this.cancellingDepth.get(generation) ?? 0) - 1;
      if (depth <= 0) this.cancellingDepth.delete(generation);
      else this.cancellingDepth.set(generation, depth);
    }
    if (generation !== this.generation) {
      // Superseded: report this delegation's own last accepted evidence, if any, and release it.
      const handover = this.handovers.get(generation);
      this.handovers.delete(generation);
      if (handover !== undefined) {
        return this.buildFailureWithSample('CANCELLED', message, problem, handover.sample, handover.trace);
      }
      return cancelled;
    }
    if (this.result !== null) return cloneResult(this.result); // a re-entrant callback already terminated it
    // Rebuild after release so the cancellation reflects the latest trusted evidence.
    this.result = this.buildFailure('CANCELLED', message, problem);
    return cloneResult(this.result);
  }

  // --- internals ---

  private get points(): readonly Vec3Like[] {
    return this.request!.points;
  }

  private requireRequest(): void {
    if (this.request === null) throw new Error('no walk-route delegation started');
  }

  private currentNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error(`now() must return a finite number: ${now}`);
    return now;
  }

  private verifierStatus(): RouteStatus {
    const status = this.verifier.status();
    if (status === null) throw new Error('no route registered');
    return status;
  }

  private positionMatches(pos: Vec3Like, target: Vec3Like): boolean {
    const arrival = this.request!.bodyArrival;
    return arrival === undefined ? positionsEqual(pos, target)
      : Math.hypot(pos.x - target.x, pos.z - target.z) <= arrival.horizontalTolerance
        && Math.abs(pos.y - target.y) <= arrival.feetTolerance;
  }

  private grounded(sample: BodySample, target: Vec3Like): boolean {
    const arrival = this.request!.bodyArrival!;
    const velocity = sample.velocity;
    return this.positionMatches(sample.pos, target) && sample.onGround && !sample.inWater
      && velocity !== undefined && Math.hypot(velocity.x, velocity.z) <= arrival.maxHorizontalSpeed
      && Math.abs(velocity.y) <= arrival.maxVerticalSpeed;
  }

  private arrivalReady(sample: BodySample, pointIndex: number): boolean {
    const target = this.points[pointIndex]!;
    const arrival = this.request!.bodyArrival;
    if (arrival === undefined) return positionsEqual(sample.pos, target);
    return this.grounded(sample, target) && this.settledPoint === pointIndex
      && this.settledSince !== null && this.settledSamples >= 2
      && sample.observedAt - this.settledSince >= arrival.stableMs;
  }

  private updateMeasuredBasis(evaluation: StepEvaluation): void {
    this.activeDependencies = new Set(evaluation.dependencies.map((d) => sectionKeyString(d.key)));
    this.activeDependencyResidency = evaluation.dependencies.map((d) => ({
      key: { ...d.key }, generation: this.map.residencyGeneration(d.key.dim, d.key.cx, d.key.cz, d.key.sy),
    }));
    this.activeValidUntil = evaluation.validUntil;
  }

  private evaluateMeasured(from: Vec3Like, to: Vec3Like): StepEvaluation {
    const req = this.request!;
    return evaluateGroundedWalkSegment(this.map, {
      worldId: req.worldId, dim: req.dim, sessionId: req.sessionId, mode: req.mode,
      body: { ...req.body, feet: { ...from } },
      direction: { axis: 'x', sign: 1 }, constraints: req.constraints,
    }, to, req.shapeProvider, this.currentNow(), req.bodyArrival!.feetTolerance);
  }

  /** True when the sample's numeric fields are finite; non-finite input never enters evidence. */
  private sampleFinite(sample: BodySample): boolean {
    return (
      Number.isFinite(sample.pos.x) &&
      Number.isFinite(sample.pos.y) &&
      Number.isFinite(sample.pos.z) &&
      Number.isFinite(sample.observedAt) &&
      Number.isFinite(sample.sequence)
    );
  }

  /** Ordering: a strictly-increasing sequence rejects replayed samples; non-decreasing time allows same-ms. */
  private sampleOrdered(sample: BodySample): boolean {
    return sample.sequence > this.lastSampleSequence && sample.observedAt >= this.lastSampleObservedAt;
  }

  /** Compute a terminal reason (deadline / per-move timeout / basis invalidation) without writing state. */
  private terminalReason(): TerminalReason | null {
    return this.recheckTerminal(this.activeStartedAt, this.activeValidUntil, this.activeRuleVersion);
  }

  /**
   * Re-check the terminal conditions against a saved action context (start time,
   * validity ceiling and rule version), so a stop/abort callback that advanced the
   * clock or changed the rules cannot be missed after the fact.
   */
  private recheckTerminal(startedAt: number | null, validUntil: number, ruleVersion: string | null): TerminalReason | null {
    const now = this.currentNow();
    if (now >= this.request!.deadlineMs) {
      return { outcome: 'TIMEOUT', message: 'delegation deadline exceeded', problem: { kind: 'timeout' } };
    }
    if (startedAt !== null && now - startedAt >= this.request!.timeoutMs) {
      return { outcome: 'TIMEOUT', message: 'move timed out', problem: { kind: 'timeout' } };
    }
    if (ruleVersion !== null && this.verifierStatus().ruleVersion !== ruleVersion) {
      return {
        outcome: 'FAILED',
        message: 'the in-flight segment lost its OPEN verification basis',
        problem: { kind: 'route_invalidated', detail: 'rule-version invalidation revoked the in-flight step' },
      };
    }
    if (now > validUntil) {
      return {
        outcome: 'FAILED',
        message: 'the in-flight segment lost its OPEN verification basis',
        problem: { kind: 'route_invalidated', detail: 'TTL invalidation revoked the in-flight step' },
      };
    }
    return null;
  }

  /** A failure result when the given step is no longer verified OPEN, or null when it is still passable. */
  private stepNotOpenResult(stepIndex: number): NavResult | null {
    if (this.request!.bodyArrival !== undefined && this.measuredFrom !== null && this.lastPosition !== null) {
      const corridor = this.evaluateMeasured(this.measuredFrom, this.lastPosition);
      if (corridor.status !== 'OPEN') return this.failForStep(stepIndex, corridor);
      return null;
    }
    const step = this.verifierStatus().steps[stepIndex];
    if (step !== undefined && step.kind === 'verified') {
      return step.result.status === 'OPEN' ? null : this.failForStep(stepIndex, step.result);
    }
    return this.buildFailure('FAILED', 'the in-flight segment was invalidated before arrival', {
      kind: 'route_invalidated',
      detail: 'a required section changed during execution',
    });
  }

  /** The unified terminal guard. Returns true when the delegation is or becomes terminal. */
  private guard(): boolean {
    if (this.result !== null) return true;
    const reason = this.terminalReason() ?? this.residencyReason();
    if (reason !== null) {
      this.terminate(reason.outcome, reason.message, reason.problem);
      return true;
    }
    return false;
  }

  /** Terminal reason when an active dependency section changed residency (unload/load). */
  private residencyReason(): TerminalReason | null {
    if (this.activeDependencyResidency === null) return null;
    for (const dep of this.activeDependencyResidency) {
      if (this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy) !== dep.generation) {
        return {
          outcome: 'FAILED',
          message: 'the in-flight segment was invalidated by a residency change',
          problem: { kind: 'route_invalidated', detail: 'a required section was unloaded during execution' },
        };
      }
    }
    return null;
  }

  /** True when this flow may still write state: same delegation and not yet terminal. */
  private ownsDelegation(generation: number): boolean {
    return generation === this.generation && this.result === null;
  }

  /** Stop the active move and, if the delegation is unchanged, record a terminal result. */
  private terminate(outcome: FailureOutcome, message: string, problem: NavProblem): void {
    const generation = this.generation;
    this.stopActive();
    if (!this.ownsDelegation(generation)) return; // re-entrant start()/cancel() superseded or terminated this delegation
    this.result = this.buildFailure(outcome, message, problem);
  }

  private scopeMatches(sample: BodySample): boolean {
    const req = this.request!;
    return sample.worldId === req.worldId && sample.dim === req.dim && sample.sessionId === req.sessionId;
  }

  private lifecycleBroken(sample: BodySample): boolean {
    return !sample.alive || !sample.connected || !sample.observationReady;
  }

  private reportTouchesActiveStep(report: ChangeReport): boolean {
    if (this.activeDependencies === null) return false;
    return report.sections.some(
      (section) => (section.invalidated || this.request!.bodyArrival !== undefined) && this.activeDependencies!.has(sectionKeyString(section.key)),
    );
  }


  /** Re-read the latest step status and start the move only if it is still OPEN. */
  private startMove(stepIndex: number): void {
    const route = this.verifierStatus();
    const step = route.steps[stepIndex];
    if (step === undefined || step.kind !== 'verified') return; // pending: stay running, do not start
    if (step.result.status !== 'OPEN') {
      this.result = this.failForStep(stepIndex, step.result);
      return;
    }

    let evaluation = step.result;
    if (this.request!.bodyArrival !== undefined) {
      evaluation = this.evaluateMeasured(this.lastPosition!, this.points[stepIndex + 1]!);
      if (evaluation.status !== 'OPEN') {
        this.result = this.failForStep(stepIndex, evaluation);
        return;
      }
    }
    this.measuredFrom = { ...this.lastPosition! };
    const target = this.points[stepIndex + 1]!;
    const executionId = `${this.delegationId}-step-${stepIndex}`;
    const abort = new AbortController();
    const startedAt = this.currentNow();

    // Final validation with the just-captured start time: a deadline or TTL crossed
    // in the instant before scheduling must not still launch a move.
    if (startedAt >= this.request!.deadlineMs) {
      this.result = this.buildFailure('TIMEOUT', 'delegation deadline exceeded', { kind: 'timeout' });
      return;
    }
    if (startedAt > evaluation.validUntil) {
      this.result = this.buildFailure('FAILED', 'the step expired before it could start', {
        kind: 'route_invalidated',
        detail: 'evidence expired before the move was scheduled',
      });
      return;
    }

    this.activeStepIndex = stepIndex;
    this.activeExecutionId = executionId;
    this.activeAbort = abort;
    this.updateMeasuredBasis(evaluation);
    this.activeRuleVersion = route.ruleVersion;
    this.activeStartedAt = startedAt;

    const generation = this.generation;
    void this.executor
      .move({
        executionId,
        worldId: this.request!.worldId,
        dim: this.request!.dim,
        sessionId: this.request!.sessionId,
        from: { ...this.lastPosition! },
        to: { ...target },
        ...(this.request!.bodyArrival === undefined ? {} : { bodyArrival: { ...this.request!.bodyArrival } }),
        deadlineMs: this.request!.deadlineMs,
        timeoutMs: this.request!.timeoutMs,
        signal: abort.signal,
      })
      .then(
        (result) => this.handleMoveResult(generation, executionId, result),
        (error) =>
          this.handleMoveResult(generation, executionId, {
            failure: { kind: 'execution_error', detail: error instanceof Error ? error.message : String(error) },
          }),
      );
  }

  private handleMoveResult(generation: number, executionId: string, result: ExecutableMoveResult): void {
    if (generation !== this.generation) return; // stale delegation's late callback
    if (this.result !== null) return; // already terminal
    if (executionId !== this.activeExecutionId) return; // not the active move

    // Capture the terminal-relevant basis before releasing control (which clears it).
    const moveStartedAt = this.activeStartedAt;
    const activeValidUntil = this.activeValidUntil;
    const activeRuleVersion = this.activeRuleVersion;
    this.releasedDependencies = this.activeDependencies;
    this.releasedInvalidated = false;

    const sample = result.sample;
    const failure = result.failure;

    // Validate and record the trusted sample BEFORE releasing control, so a
    // re-entrant cancel()/start() from stopActive preserves the confirmed partial
    // displacement (position + original observation time).
    let usable: BodySample | null = null;
    let sampleVerdict: 'scope_changed' | 'unavailable' | null = null;
    if (sample !== undefined && this.sampleFinite(sample)) {
      if (sample.executionId !== executionId) {
        // Foreign sample: ignore it, do not interpret its scope/lifecycle.
      } else if (!this.sampleOrdered(sample)) {
        // Replayed/out-of-order sample: ignore it, do not interpret its scope/lifecycle.
      } else if (!this.scopeMatches(sample)) {
        sampleVerdict = 'scope_changed';
      } else if (this.lifecycleBroken(sample)) {
        this.recordSamplePosition(sample); // preserve the latest trusted position before terminating
        sampleVerdict = 'unavailable';
      } else {
        usable = sample;
        this.recordSamplePosition(sample);
      }
    }

    this.stopActive();
    if (!this.ownsDelegation(generation)) return; // re-entrant start()/cancel() superseded or terminated this delegation

    // A newer sample may have been accepted during the stop (via a re-entrant
    // onSample); this move's sample is then stale and must not update position,
    // advance the step, or confirm arrival.
    const sampleStale = sample !== undefined && sample.sequence < this.lastSampleSequence;
    if (sampleStale) {
      usable = null;
      sampleVerdict = null;
    }

    if (sampleVerdict === 'scope_changed') {
      this.result = this.buildFailure('FAILED', 'the body left the delegation scope during execution', {
        kind: 'scope_changed',
        detail: 'sample world/dim/session does not match the delegation',
      });
      return;
    }
    if (sampleVerdict === 'unavailable') {
      const s = sample as BodySample; // sampleVerdict is only set when the sample is defined
      this.result = this.buildFailure('FAILED', 'the body became unavailable during execution', {
        kind: 'unavailable',
        detail: `alive=${s.alive} connected=${s.connected} observationReady=${s.observationReady}`,
      });
      return;
    }

    // Re-check the terminal conditions after release, preserving the recorded displacement.
    const reason = this.recheckTerminal(moveStartedAt, activeValidUntil, activeRuleVersion);
    if (reason !== null) {
      this.result = this.buildFailure(reason.outcome, reason.message, reason.problem);
      return;
    }

    // Cancelled/timeout override a confirming sample; the displacement is already recorded.
    if (failure?.kind === 'cancelled') {
      this.result = this.buildFailure('CANCELLED', 'the move was cancelled', {
        kind: 'cancelled',
        by: 'unknown',
        reason: 'executor cancelled the move',
      });
      return;
    }
    if (failure?.kind === 'timed_out') {
      this.result = this.buildFailure('TIMEOUT', 'the move timed out', { kind: 'timeout' });
      return;
    }

    // The released action's dependencies were invalidated by a report during the stop.
    if (this.releasedInvalidated) {
      this.result = this.buildFailure('FAILED', 'the in-flight segment was invalidated by an observed world change', {
        kind: 'route_invalidated',
        detail: 'a required section changed while the segment was executing',
      });
      this.releasedDependencies = null;
      this.releasedInvalidated = false;
      return;
    }

    // The current segment must still be OPEN: a report during the stop may have invalidated it.
    const notOpen = this.stepNotOpenResult(this.nextPointIndex - 1);
    if (notOpen !== null) {
      this.result = notOpen;
      return;
    }

    // Arrival: from the latest accepted evidence, which may have superseded the move's sample.
    const target = this.points[this.nextPointIndex];
    if (target !== undefined && this.lastSample !== null && this.arrivalReady(this.lastSample, this.nextPointIndex)) {
      this.recordArrival(this.lastSample);
      return;
    }
    if (usable !== null && target !== undefined && this.positionMatches(usable.pos, target)) {
      this.result = this.buildFailure('FAILED', 'the move returned before grounded stable arrival was confirmed', {
        kind: 'unconfirmed_arrival', expected: { ...target },
      });
      return;
    }
    // Deviation: the move's own sample is off-route.
    if (usable !== null) {
      this.result = this.buildFailure('FAILED', 'the body deviated from the route', {
        kind: 'deviation',
        expected: target !== undefined ? { ...target } : { ...this.points[this.points.length - 1]! },
        actual: { ...usable.pos },
      });
      return;
    }
    // General error or empty result.
    if (failure !== undefined) {
      this.applyMoveFailure(failure);
      return;
    }
    this.result = this.buildFailure('FAILED', 'the move returned without a usable confirming body sample', {
      kind: 'unconfirmed_arrival',
      expected: target !== undefined ? { ...target } : { ...this.points[this.points.length - 1]! },
    });
  }

  private applyMoveFailure(failure: NonNullable<ExecutableMoveResult['failure']>): void {
    switch (failure.kind) {
      case 'unsupported_mode':
        this.result = this.buildFailure('FAILED', `executor does not support mode "${failure.mode}": ${failure.detail}`, {
          kind: 'unsupported_mode',
          mode: failure.mode,
          detail: failure.detail,
        });
        return;
      case 'not_authorized':
        this.result = this.buildFailure('FAILED', `executor refused the move: ${failure.constraint}`, {
          kind: 'not_authorized',
          detail: failure.constraint,
        });
        return;
      case 'cancelled':
        this.result = this.buildFailure('CANCELLED', 'the move was cancelled', {
          kind: 'cancelled',
          by: 'unknown',
          reason: 'executor cancelled the move',
        });
        return;
      case 'timed_out':
        this.result = this.buildFailure('TIMEOUT', 'the move timed out', { kind: 'timeout' });
        return;
      case 'execution_error':
        this.result = this.buildFailure('FAILED', `execution failed: ${failure.detail}`, {
          kind: 'execution_failed',
          detail: failure.detail,
        });
        return;
    }
  }

  /** Confirm arrival at the next point. Releases the old move's control before advancing. */
  private confirmArrival(sample: BodySample): void {
    const generation = this.generation;
    const startedAt = this.activeStartedAt;
    const validUntil = this.activeValidUntil;
    const ruleVersion = this.activeRuleVersion;
    this.releasedDependencies = this.activeDependencies;
    this.releasedInvalidated = false;
    this.stopActive(); // measured arrival and control release are separate confirmations
    if (!this.ownsDelegation(generation)) return; // re-entrant start()/cancel() superseded or terminated this delegation

    // Re-check the terminal conditions (deadline / per-move timeout / rule / TTL) first.
    const reason = this.recheckTerminal(startedAt, validUntil, ruleVersion);
    if (reason !== null) {
      this.result = this.buildFailure(reason.outcome, reason.message, reason.problem);
      return;
    }

    // The released action's dependencies were invalidated by a report during the stop.
    if (this.releasedInvalidated) {
      this.result = this.buildFailure('FAILED', 'the in-flight segment was invalidated by an observed world change', {
        kind: 'route_invalidated',
        detail: 'a required section changed while the segment was executing',
      });
      this.releasedDependencies = null;
      this.releasedInvalidated = false;
      return;
    }

    // The current segment must still be OPEN: a report during the stop may have invalidated it.
    const notOpen = this.stepNotOpenResult(this.nextPointIndex - 1);
    if (notOpen !== null) {
      this.result = notOpen;
      return;
    }

    // A newer sample accepted during the stop supersedes this one; confirm against it.
    const effective =
      sample.sequence < this.lastSampleSequence && this.lastSample !== null ? this.lastSample : sample;
    const target = this.points[this.nextPointIndex];
    if (target === undefined || !this.arrivalReady(effective, this.nextPointIndex)) {
      this.result = this.buildFailure('FAILED', 'the move returned without a usable confirming body sample', {
        kind: 'unconfirmed_arrival',
        expected: target !== undefined ? { ...target } : { ...this.points[this.points.length - 1]! },
      });
      return;
    }
    this.recordArrival(effective);
  }

  /** Record the confirmed arrival at the next point and advance; may produce ARRIVED. */
  private recordArrival(sample: BodySample): void {
    const pos = { ...sample.pos };
    this.lastPosition = pos;
    this.lastSample = snapshotSample(sample);
    this.lastSampleObservedAt = sample.observedAt;
    this.lastSampleSequence = sample.sequence;
    this.trace.push({ pos, ts: sample.observedAt });
    this.nextPointIndex += 1;

    if (this.nextPointIndex >= this.points.length) {
      this.result = {
        outcome: 'ARRIVED',
        message: `arrived at ${fmt(pos)}`,
        lastPosition: pos,
        lastObservation: sampleToObservation(sample),
        confirmed: true,
        trace: this.trace.map((t) => ({ pos: { ...t.pos }, ts: t.ts })),
      };
    }
  }

  private recordSamplePosition(sample: BodySample): void {
    const arrival = this.request!.bodyArrival;
    if (arrival !== undefined) {
      const point = this.activeStepIndex !== null || this.releasing > 0 ? this.nextPointIndex : this.nextPointIndex - 1;
      const previous = this.lastSample;
      const ticks = previous === null ? 0 : Math.max(0, sample.observedAt - previous.observedAt) / 50;
      const continuous = previous !== null && this.settledPoint === point
        && sample.observedAt - previous.observedAt <= Math.max(50, arrival.stableMs)
        && Math.hypot(sample.pos.x - previous.pos.x, sample.pos.z - previous.pos.z) <= arrival.maxHorizontalSpeed * ticks + POS_EPS
        && Math.abs(sample.pos.y - previous.pos.y) <= arrival.maxVerticalSpeed * ticks + POS_EPS;
      if (!this.grounded(sample, this.points[point]!)) {
        this.settledSince = null;
        this.settledSamples = 0;
      } else if (!continuous || this.settledSince === null) {
        this.settledSince = sample.observedAt;
        this.settledSamples = 1;
      } else {
        this.settledSamples += 1;
      }
      this.settledPoint = point;
    }
    this.lastPosition = { ...sample.pos };
    this.lastSample = snapshotSample(sample);
    this.lastSampleObservedAt = sample.observedAt;
    this.lastSampleSequence = sample.sequence;
  }

  private clearActiveState(): void {
    this.activeStepIndex = null;
    this.activeExecutionId = null;
    this.activeAbort = null;
    this.activeDependencies = null;
    this.activeDependencyResidency = null;
    this.activeRuleVersion = null;
    this.activeValidUntil = Number.POSITIVE_INFINITY;
    this.activeStartedAt = null;
  }

  /** Detach the active move's handles first, then release control with the captured refs. */
  private stopActive(): void {
    const executionId = this.activeExecutionId;
    const abort = this.activeAbort;
    this.clearActiveState();
    if (executionId !== null && abort !== null) {
      this.releasing += 1;
      try {
        this.executor.stop(executionId);
        abort.abort();
      } finally {
        this.releasing -= 1;
      }
    }
  }

  private failForStep(stepIndex: number, evaluation: StepEvaluation): NavResult {
    const problem = navProblemForStep(evaluation);
    switch (evaluation.status) {
      case 'BLOCKED':
        return this.buildFailure('BLOCKED', `route step ${stepIndex} is blocked: ${evaluation.reason ?? 'blocked'}`, problem);
      case 'UNKNOWN':
        return this.buildFailure('FAILED', `route step ${stepIndex} lacks evidence: ${evaluation.reason ?? 'unobserved'}`, problem);
      case 'STALE':
        return this.buildFailure('FAILED', `route step ${stepIndex} evidence is stale: ${evaluation.reason ?? 'stale'}`, problem);
      case 'UNSUPPORTED':
        return this.buildFailure('FAILED', `route step ${stepIndex} is not supported: ${evaluation.reason ?? 'unsupported'}`, problem);
      default:
        return this.buildFailure('FAILED', `route step ${stepIndex} is not passable`, problem);
    }
  }

  private buildFailure(outcome: FailureOutcome, message: string, problem: NavProblem): NavResult {
    const trace = this.trace.map((t) => ({ pos: { ...t.pos }, ts: t.ts }));
    const tail =
      this.lastPosition !== null && this.lastSample !== null
        ? { lastPosition: { ...this.lastPosition }, lastObservation: sampleToObservation(this.lastSample) }
        : {};
    return { outcome, message, problem, confirmed: false, trace, ...tail };
  }

  /** Build a failure result carrying a specific sample's position, observation and trace (for handover). */
  private buildFailureWithSample(
    outcome: FailureOutcome,
    message: string,
    problem: NavProblem,
    sample: BodySample,
    trace: { pos: Vec3Like; ts: number }[],
  ): NavResult {
    return {
      outcome,
      message,
      problem,
      confirmed: false,
      trace: trace.map((t) => ({ pos: { ...t.pos }, ts: t.ts })),
      lastPosition: { ...sample.pos },
      lastObservation: sampleToObservation(sample),
    };
  }

  private snapshot(): WalkRouteStatus {
    const req = this.request!;
    const now = this.currentNow();
    return {
      worldId: req.worldId,
      dim: req.dim,
      sessionId: req.sessionId,
      delegationId: this.delegationId,
      result: this.result === null ? null : cloneResult(this.result),
      nextPointIndex: this.nextPointIndex,
      lastPosition: this.lastPosition === null ? null : { ...this.lastPosition },
      activeStepIndex: this.activeStepIndex,
      route: this.verifierStatus(),
      deadlineMs: req.deadlineMs,
      timeoutMs: req.timeoutMs,
      remainingMs: req.deadlineMs - now,
    };
  }
}

function snapshotPoints(points: readonly Vec3Like[]): Vec3Like[] {
  if (points.length < 2) throw new Error(`a route needs at least two points, got ${points.length}`);
  return points.map((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      throw new Error(`point coordinates must be finite: ${fmt(p)}`);
    }
    return { x: p.x, y: p.y, z: p.z };
  });
}

function snapshotBody(body: WalkRouteRequest['body']): WalkRouteRequest['body'] {
  return { feet: { ...body.feet }, width: body.width, height: body.height, pose: body.pose };
}

function snapshotConstraints(constraints: NonNullable<WalkRouteRequest['constraints']>): NonNullable<WalkRouteRequest['constraints']> {
  return { avoid: (constraints.avoid ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z })) };
}

function snapshotRequest(
  request: WalkRouteRequest,
  points: Vec3Like[],
  body: WalkRouteRequest['body'],
): WalkRouteRequest {
  return {
    worldId: request.worldId,
    dim: request.dim,
    sessionId: request.sessionId,
    mode: request.mode,
    body,
    points,
    arrival: { ...request.arrival },
    ...(request.bodyArrival === undefined ? {} : { bodyArrival: { ...request.bodyArrival } }),
    constraints: request.constraints === undefined ? undefined : snapshotConstraints(request.constraints),
    shapeProvider: request.shapeProvider,
    deadlineMs: request.deadlineMs,
    timeoutMs: request.timeoutMs,
  };
}

function snapshotSample(sample: BodySample): BodySample {
  return { ...sample, pos: { ...sample.pos }, ...(sample.velocity === undefined ? {} : { velocity: { ...sample.velocity } }) };
}

function sampleToObservation(sample: BodySample): LastObservation {
  return {
    worldId: sample.worldId,
    dim: sample.dim,
    sessionId: sample.sessionId,
    observedAt: sample.observedAt,
    onGround: sample.onGround,
    inWater: sample.inWater,
  };
}

function positionsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return Math.abs(a.x - b.x) <= POS_EPS && Math.abs(a.y - b.y) <= POS_EPS && Math.abs(a.z - b.z) <= POS_EPS;
}

function validateBudget(budget: number): void {
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error(`budget must be a positive integer: ${budget}`);
  }
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

function navProblemForStep(evaluation: StepEvaluation): NavProblem {
  const problem = evaluation.problem;
  if (problem === undefined) {
    return { kind: 'unconfirmed_arrival', expected: { ...evaluation.to } };
  }
  switch (problem.kind) {
    case 'collision': {
      const evidence = evaluation.obstacles[0];
      return evidence !== undefined
        ? { kind: 'blocked', evidence: cloneObstacle(evidence) }
        : {
            kind: 'blocked',
            evidence: {
              kind: 'contact',
              pos: { ...(problem.cells[0] ?? evaluation.to) },
              observedAt: evaluation.computedAt,
              sessionId: evaluation.sessionId,
            },
          };
    }
    case 'missing_support':
      // Geometric, not a physical contact: no move was executed, so fabricating a
      // `contact` event would misattribute a derived gap to a real collision.
      return {
        kind: 'support_missing',
        pos: { ...(problem.cells[0] ?? evaluation.to) },
        detail: problem.detail ?? 'no standable surface under the swept footprint',
      };
    case 'unobserved':
      return { kind: 'unobserved', gap: { pos: { ...(problem.cells[0] ?? evaluation.to) }, reason: 'unknown' } };
    case 'stale':
      return { kind: 'stale', pos: { ...(problem.cells[0] ?? evaluation.to) } };
    case 'unsupported_mode':
      return { kind: 'unsupported_mode', mode: 'walk', detail: problem.detail ?? 'mode not supported by the walk evaluator' };
    case 'unsupported_shape':
      return { kind: 'unsupported_mode', mode: 'walk', detail: problem.detail ?? 'a collision shape cannot be resolved' };
  }
}

function cloneObstacle(evidence: ObstacleEvidence): ObstacleEvidence {
  if (evidence.kind === 'block') {
    return { kind: 'block', observation: cloneObservation(evidence.observation) };
  }
  return { kind: 'contact', pos: { ...evidence.pos }, observedAt: evidence.observedAt, sessionId: evidence.sessionId };
}

function cloneObservation(observation: Observation): Observation {
  return { ...observation, pos: { ...observation.pos }, state: { name: observation.state.name, properties: { ...observation.state.properties } } };
}

function cloneResult(result: NavResult): NavResult {
  const trace = result.trace.map((t) => ({ pos: { ...t.pos }, ts: t.ts }));
  if (result.outcome === 'ARRIVED') {
    return {
      outcome: 'ARRIVED',
      message: result.message,
      lastPosition: { ...result.lastPosition },
      lastObservation: { ...result.lastObservation },
      confirmed: true,
      trace,
    };
  }
  const problem = result.problem;
  // The executor only ever stores ARRIVED or a failure outcome (never PARTIAL),
  // so this clone reconstructs the failure/partial member of the union by shape.
  return {
    outcome: result.outcome,
    message: result.message,
    confirmed: result.confirmed,
    trace,
    ...(problem !== undefined ? { problem: cloneProblem(problem) } : {}),
    ...(result.lastPosition !== undefined ? { lastPosition: { ...result.lastPosition } } : {}),
    ...(result.lastObservation !== undefined ? { lastObservation: { ...result.lastObservation } } : {}),
  } as NavResult;
}

function cloneProblem(problem: NavProblem): NavProblem {
  switch (problem.kind) {
    case 'unloaded':
    case 'stale':
      return { kind: problem.kind, pos: { ...problem.pos } };
    case 'unobserved':
      return { kind: 'unobserved', gap: { pos: { ...problem.gap.pos }, reason: problem.gap.reason } };
    case 'blocked':
    case 'head_blocked':
      return { kind: problem.kind, evidence: cloneObstacle(problem.evidence) };
    case 'hazard':
      return { kind: 'hazard', facts: problem.facts.map((f) => ({ ...f, pos: { ...f.pos } })), constraint: problem.constraint };
    case 'unsupported_mode':
      return { kind: 'unsupported_mode', mode: problem.mode, detail: problem.detail };
    case 'search_budget_exhausted':
      return { kind: 'search_budget_exhausted', budgetMs: problem.budgetMs };
    case 'occupied':
      return { kind: 'occupied', pos: { ...problem.pos }, observedAt: problem.observedAt };
    case 'support_out_of_reach':
      return { kind: 'support_out_of_reach', pos: { ...problem.pos }, requiredSupport: { ...problem.requiredSupport } };
    case 'deviation':
      return { kind: 'deviation', expected: { ...problem.expected }, actual: { ...problem.actual } };
    case 'unconfirmed_arrival':
      return { kind: 'unconfirmed_arrival', expected: { ...problem.expected } };
    case 'unmeasured_position':
      return { kind: 'unmeasured_position', expected: { ...problem.expected } };
    case 'support_missing':
      return { kind: 'support_missing', pos: { ...problem.pos }, detail: problem.detail };
    case 'cancelled':
      return { kind: 'cancelled', by: problem.by, reason: problem.reason };
    case 'unsupported_target':
    case 'not_authorized':
    case 'route_invalidated':
    case 'scope_changed':
    case 'unavailable':
    case 'execution_failed':
    case 'invalid_request':
      return { kind: problem.kind, detail: problem.detail };
    case 'no_path':
    case 'timeout':
      return { kind: problem.kind };
  }
}
