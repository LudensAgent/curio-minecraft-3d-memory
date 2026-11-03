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
 *   `exact` completion condition (including Y) under the delegation's
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
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import { RouteVerifier } from '../traversability/route.js';
import type { RouteStatus } from '../traversability/route.js';
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
  private activeStepIndex: number | null = null;
  private activeExecutionId: string | null = null;
  private activeAbort: AbortController | null = null;
  private activeDependencies: Set<string> | null = null;
  private activeRuleVersion: string | null = null;
  private activeValidUntil = Number.POSITIVE_INFINITY;
  private activeStartedAt: number | null = null;
  private trace: { pos: Vec3Like; ts: number }[] = [];
  private result: NavResult | null = null;

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
    this.generation += 1;
    const myGeneration = this.generation;
    this.delegationId = `walk-${myGeneration}`;
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
    this.trace = [];
    this.result = null;

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
    if (!positionsEqual(this.lastPosition, from)) {
      this.result = this.buildFailure('FAILED', 'the body deviated from the route', {
        kind: 'deviation',
        expected: { ...from },
        actual: { ...this.lastPosition },
      });
      return this.snapshot();
    }

    this.startMove(stepIndex);
    return this.snapshot();
  }

  /** Consume a `ChangeReport`: run the terminal guard, revoke an invalidated in-flight step, then re-verify within budget. */
  observe(report: ChangeReport, budget: number): WalkRouteStatus {
    this.requireRequest();
    validateBudget(budget);
    this.guard();

    if (this.result === null && this.activeStepIndex !== null && this.reportTouchesActiveStep(report)) {
      this.terminate('FAILED', 'the in-flight segment was invalidated by an observed world change', {
        kind: 'route_invalidated',
        detail: 'a required section changed while the segment was executing',
      });
    }

    // Always consume the report (cache invalidation), even after termination, so a
    // stale OPEN cannot revive in a later re-registration.
    this.verifier.apply(report, budget);
    this.guard();

    return this.snapshot();
  }

  /** Accept measured body feedback (host push). Handles boundary validation, association, ordering, scope, lifecycle and position. */
  onSample(sample: BodySample): WalkRouteStatus {
    this.requireRequest();
    if (this.result !== null) return this.snapshot();

    if (!this.sampleFinite(sample)) return this.snapshot(); // non-finite input never enters state
    if (sample.executionId !== this.delegationId) return this.snapshot(); // foreign/stale delegation
    if (!this.sampleOrdered(sample)) return this.snapshot(); // replayed or out-of-order

    if (!this.scopeMatches(sample)) {
      this.terminate('FAILED', 'the body left the delegation scope before arrival', {
        kind: 'scope_changed',
        detail: 'sample world/dim/session does not match the delegation',
      });
      return this.snapshot();
    }
    if (this.lifecycleBroken(sample)) {
      this.terminate('FAILED', 'the body became unavailable before arrival', {
        kind: 'unavailable',
        detail: `alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
      });
      return this.snapshot();
    }

    // Record the trusted displacement before deciding the terminal state, so a
    // timeout/invalidation preserves the measured partial effect.
    this.recordSamplePosition(sample);

    if (this.guard()) return this.snapshot(); // deadline / per-move timeout / basis

    if (this.activeStepIndex !== null) {
      const target = this.points[this.nextPointIndex];
      if (target !== undefined && positionsEqual(sample.pos, target)) {
        this.confirmArrival(sample);
      }
      // else: intermediate progress, already recorded.
    } else {
      const expected = this.points[this.nextPointIndex - 1]!;
      if (!positionsEqual(sample.pos, expected)) {
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
    // Build the cancellation snapshot before releasing, so a re-entrant start()
    // cannot replace the displacement this cancellation reports.
    const cancelled = this.buildFailure('CANCELLED', message, problem);
    this.stopActive();
    if (generation !== this.generation) return cancelled; // superseded; return the old snapshot
    this.result = cancelled;
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
    const now = this.currentNow();
    if (now >= this.request!.deadlineMs) {
      return { outcome: 'TIMEOUT', message: 'delegation deadline exceeded', problem: { kind: 'timeout' } };
    }
    if (this.activeStepIndex !== null && this.activeStartedAt !== null && now - this.activeStartedAt >= this.request!.timeoutMs) {
      return { outcome: 'TIMEOUT', message: 'move timed out', problem: { kind: 'timeout' } };
    }
    if (this.activeStepIndex !== null && this.activeBasisInvalidated()) {
      return {
        outcome: 'FAILED',
        message: 'the in-flight segment lost its OPEN verification basis',
        problem: { kind: 'route_invalidated', detail: 'rule-version or TTL invalidation revoked the in-flight step' },
      };
    }
    return null;
  }

  /** The unified terminal guard. Returns true when the delegation is or becomes terminal. */
  private guard(): boolean {
    if (this.result !== null) return true;
    const reason = this.terminalReason();
    if (reason !== null) {
      this.terminate(reason.outcome, reason.message, reason.problem);
      return true;
    }
    return false;
  }

  /** Stop the active move and, if the delegation is unchanged, record a terminal result. */
  private terminate(outcome: FailureOutcome, message: string, problem: NavProblem): void {
    const generation = this.generation;
    this.stopActive();
    if (generation !== this.generation) return; // re-entrant start() replaced the delegation
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
      (section) => section.invalidated && this.activeDependencies!.has(sectionKeyString(section.key)),
    );
  }

  /** True when the in-flight move's saved verification basis changed (rule version or TTL). */
  private activeBasisInvalidated(): boolean {
    if (this.activeStepIndex === null) return false;
    const now = this.currentNow();
    if (this.activeRuleVersion !== null && this.verifierStatus().ruleVersion !== this.activeRuleVersion) return true;
    if (now > this.activeValidUntil) return true;
    return false;
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

    const evaluation = step.result;
    const target = this.points[stepIndex + 1]!;
    const executionId = `${this.delegationId}-step-${stepIndex}`;
    const abort = new AbortController();
    this.activeStepIndex = stepIndex;
    this.activeExecutionId = executionId;
    this.activeAbort = abort;
    this.activeDependencies = new Set(evaluation.dependencies.map((d) => sectionKeyString(d.key)));
    this.activeRuleVersion = route.ruleVersion;
    this.activeValidUntil = evaluation.validUntil;
    this.activeStartedAt = this.currentNow();

    const generation = this.generation;
    void this.executor
      .move({
        executionId,
        worldId: this.request!.worldId,
        dim: this.request!.dim,
        sessionId: this.request!.sessionId,
        to: { ...target },
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
    const basisInvalidated = this.activeBasisInvalidated();

    this.stopActive();
    if (generation !== this.generation) return; // re-entrant start() replaced the delegation

    const sample = result.sample;
    const failure = result.failure;

    // Validate the sample, checking execution association BEFORE scope/lifecycle so
    // a foreign sample cannot override an explicit cancel/timeout reason.
    let usable: BodySample | null = null;
    if (sample !== undefined && this.sampleFinite(sample)) {
      if (sample.executionId !== executionId) {
        // Foreign sample: ignore it, do not interpret its scope/lifecycle.
      } else if (!this.scopeMatches(sample)) {
        this.result = this.buildFailure('FAILED', 'the body left the delegation scope during execution', {
          kind: 'scope_changed',
          detail: 'sample world/dim/session does not match the delegation',
        });
        return;
      } else if (this.lifecycleBroken(sample)) {
        this.result = this.buildFailure('FAILED', 'the body became unavailable during execution', {
          kind: 'unavailable',
          detail: `alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
        });
        return;
      } else if (this.sampleOrdered(sample)) {
        usable = sample;
        this.recordSamplePosition(sample);
      }
    }

    // Decide terminal (deadline / per-move timeout / basis), preserving the recorded displacement.
    const now = this.currentNow();
    if (now >= this.request!.deadlineMs) {
      this.result = this.buildFailure('TIMEOUT', 'delegation deadline exceeded', { kind: 'timeout' });
      return;
    }
    if (moveStartedAt !== null && now - moveStartedAt >= this.request!.timeoutMs) {
      this.result = this.buildFailure('TIMEOUT', 'move timed out', { kind: 'timeout' });
      return;
    }
    if (basisInvalidated) {
      this.result = this.buildFailure('FAILED', 'the in-flight segment lost its OPEN verification basis', {
        kind: 'route_invalidated',
        detail: 'rule-version or TTL invalidation revoked the in-flight step',
      });
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

    if (usable !== null) {
      const target = this.points[this.nextPointIndex];
      if (target !== undefined && positionsEqual(usable.pos, target)) {
        this.confirmArrival(usable);
        return;
      }
      this.result = this.buildFailure('FAILED', 'the body deviated from the route', {
        kind: 'deviation',
        expected: target !== undefined ? { ...target } : { ...this.points[this.points.length - 1]! },
        actual: { ...usable.pos },
      });
      return;
    }

    if (failure !== undefined) {
      this.applyMoveFailure(failure);
      return;
    }
    this.result = this.buildFailure('FAILED', 'the move returned without a usable confirming body sample', {
      kind: 'unconfirmed_arrival',
      expected: { ...this.points[this.nextPointIndex]! },
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
    this.stopActive(); // measured arrival and control release are separate confirmations
    if (generation !== this.generation) return; // re-entrant start() replaced the delegation

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
      this.executor.stop(executionId);
      abort.abort();
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
    constraints: request.constraints === undefined ? undefined : snapshotConstraints(request.constraints),
    shapeProvider: request.shapeProvider,
    deadlineMs: request.deadlineMs,
    timeoutMs: request.timeoutMs,
  };
}

function snapshotSample(sample: BodySample): BodySample {
  return { ...sample, pos: { ...sample.pos } };
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
      return { kind: problem.kind, detail: problem.detail };
    case 'no_path':
    case 'timeout':
      return { kind: problem.kind };
  }
}
