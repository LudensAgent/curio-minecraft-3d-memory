/**
 * Controlled walk-route execution contract (design §7 `navigate_to` first step,
 * phase 3).
 *
 * The execution layer connects a verified route to controlled single-step
 * movement plus measured body feedback through an injectable `MoveExecutor`.
 * It never searches a route, never reads hidden world data, and never expands
 * the caller's delegation. Only what the caller explicitly authorized is ever
 * executed — digging, placing, towering and material spend are absent here by
 * construction.
 */

import type { ArrivalSpec, NavResult } from '../navigation/types.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import type { RouteStatus } from '../traversability/route.js';
import type { BodyContext, StepConstraints } from '../traversability/step.js';
import type { MoveMode, Vec3Like } from '../types.js';

/** One measured body sample, tied to a specific execution. */
export interface BodySample {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Measured feet position in continuous space. */
  pos: Vec3Like;
  /** Real timestamp the sample was captured (never the receive time). */
  observedAt: number;
  alive: boolean;
  connected: boolean;
  observationReady: boolean;
  onGround: boolean;
  inWater: boolean;
  /**
   * Execution identity this sample belongs to. A move result echoes the move's
   * `ExecutableMove.executionId`; a host push uses the delegation id. The loop
   * only trusts a sample whose identity matches — never by timestamp alone.
   */
  executionId: string;
}

/** Why a single move did not produce a confirming sample. */
export type MoveFailure =
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'not_authorized'; constraint: string }
  | { kind: 'cancelled' }
  | { kind: 'timed_out' }
  | { kind: 'execution_error'; detail: string };

/** One authorized single-step move, owned by the current execution. */
export interface ExecutableMove {
  /** Execution identity; a late result keyed to an old id must be ignored. */
  executionId: string;
  worldId: string;
  dim: string;
  sessionId: string;
  /** The single authorized target feet position (one step). */
  to: Vec3Like;
  /** Delegation deadline (epoch ms); never reset per move. */
  deadlineMs: number;
  /** Per-move timeout budget (ms). */
  timeoutMs: number;
  /** Abort signal owned by this execution. */
  signal: AbortSignal;
}

/** Result of one move; `sample` and `failure` may both be present. */
export interface ExecutableMoveResult {
  /** A body sample measured by THIS execution; may be a partial/deviated position. */
  sample?: BodySample;
  /** Why the move did not produce a confirming sample, when applicable. */
  failure?: MoveFailure;
}

/**
 * The injectable single-step executor. It only executes one authorized segment;
 * it must never search a route, plan around obstacles, or read hidden world data.
 * There is deliberately no dig/place/tower surface here.
 */
export interface MoveExecutor {
  move(request: ExecutableMove): Promise<ExecutableMoveResult>;
  /** Stop only the execution identified by `executionId`; must not stop a newer one. */
  stop(executionId: string): void;
}

/** Input to the controlled walk-route execution loop. */
export interface WalkRouteRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Only `walk` is supported this round; other modes are rejected. */
  mode: MoveMode;
  /** Fixed body; `feet` must equal the first route point. */
  body: BodyContext;
  /** Ordered consecutive feet positions (≥ 2); same height, ±1 along X or Z. */
  points: readonly Vec3Like[];
  /** Completion condition; only `{ kind: 'exact' }` is supported this round. */
  arrival: ArrivalSpec;
  constraints?: StepConstraints;
  shapeProvider: CollisionShapeProvider;
  /** Original delegation deadline (epoch ms). */
  deadlineMs: number;
  /** Per-move timeout budget (ms). */
  timeoutMs: number;
}

/** Live execution snapshot; `result` is non-null once the delegation reached a terminal outcome. */
export interface WalkRouteStatus {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Stable identity of this delegation; host samples must carry it in `BodySample.executionId`. */
  delegationId: string;
  /** Terminal result, or null while running. */
  result: NavResult | null;
  /** Index (0-based) of the next route point still to be reached; `points.length` means ARRIVED. */
  nextPointIndex: number;
  /** Last measured position accepted by this execution, or null. */
  lastPosition: Vec3Like | null;
  /** 0-based step currently awaiting a confirming sample, or null. */
  activeStepIndex: number | null;
  /** Route verification snapshot. */
  route: RouteStatus;
  /** Original delegation deadline (epoch ms). */
  deadlineMs: number;
  /** Per-move timeout budget (ms). */
  timeoutMs: number;
  /** deadlineMs − now at snapshot time. */
  remainingMs: number;
}
