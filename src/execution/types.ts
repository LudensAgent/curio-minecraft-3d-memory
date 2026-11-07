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
  /** Measured velocity in blocks per physics tick; required by bodyArrival. */
  velocity?: Vec3Like;
  alive: boolean;
  connected: boolean;
  observationReady: boolean;
  onGround: boolean;
  inWater: boolean;
  /**
   * Execution identity this sample belongs to. `walkPath` exposes a stable
   * external identity (`exec_<routeId>`) and rebinds it to the executor's
   * internal delegation id inside the binding; direct `WalkRouteExecutor`
   * callers echo the move/delegation id. The loop only trusts a sample whose
   * identity matches — never by timestamp alone.
   */
  executionId: string;
  /**
   * Monotonic per-delegation sample number. Strictly increasing across accepted
   * samples, so a replayed same-millisecond sample is rejected without relying on
   * a strictly-increasing `observedAt`. A re-delivery of the same sample keeps the
   * same number — this is a sample identity, not a per-delivery receive counter.
   */
  sequence: number;
}

/** Why a single move did not produce a confirming sample. */
export type MoveFailure =
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'not_authorized'; constraint: string }
  | { kind: 'cancelled' }
  | { kind: 'timed_out' }
  | { kind: 'execution_error'; detail: string };

/** Opt-in physical completion contract; absent keeps exact legacy comparisons. */
export interface GroundedArrival {
  /** Radius in blocks around each nominal waypoint; must be < 0.5. */
  horizontalTolerance: number;
  /** Vertical tolerance in blocks, additionally requiring observed support geometry. */
  feetTolerance: number;
  /** Speed limits in blocks per physics tick (20 Hz). */
  maxHorizontalSpeed: number;
  /** Include the host physics engine's grounded gravity velocity when selecting this limit. */
  maxVerticalSpeed: number;
  /** Two or more ordered samples must remain settled for this many ms. */
  stableMs: number;
}

/**
 * Defaults for same-height dry walking on Java 1.20.1, verified against
 * prismarine-physics. Units: tolerances are blocks; speeds are blocks per
 * physics tick (20 Hz). The vertical limit must absorb the grounded gravity
 * velocity (-0.0784 b/tick = -1.568 b/s) -- a body standing still is never at
 * vertical velocity 0 -- while still rejecting a real jump (~ +0.42 b/tick).
 */
export const GROUNDED_ARRIVAL_DEFAULTS: GroundedArrival = {
  horizontalTolerance: 0.12,
  feetTolerance: 0.05,
  maxHorizontalSpeed: 0.003,
  maxVerticalSpeed: 0.1,
  stableMs: 150,
};

/** One authorized single-step move, owned by the current execution. */
export interface ExecutableMove {
  /** Execution identity; a late result keyed to an old id must be ignored. */
  executionId: string;
  worldId: string;
  dim: string;
  sessionId: string;
  /** Last measured position, never replaced with the nominal route point. */
  from: Vec3Like;
  bodyArrival?: GroundedArrival;
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
  /** Require grounded, dry, stable measured arrival within these explicit tolerances. */
  bodyArrival?: GroundedArrival;
  /**
   * Measured sample captured immediately before this delegation starts. It only
   * seeds the sample-ordering floor (a search may have run between measurement
   * and start); it is never counted as arrival, trace, or a control result.
   */
  startSample?: BodySample;
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
  /**
   * Internal delegation identity used by the executor's own association checks.
   * `walkPath` does not expose it to the host; host-facing samples use the
   * stable `exec_<routeId>` identity instead.
   */
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
