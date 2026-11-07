/**
 * Walk-path execution types (implementation plan M4.1; contract §7.2–§7.4).
 *
 * `walkPath` binds a `planRoute`-issued `routeId` to bounded single-step body
 * execution. These types only describe the request/environment/result boundary:
 * they carry no search, no re-planning and no construction authority. The body
 * port executes one authorized move at a time and can stop only the execution
 * it was given.
 */

import type {
  BodySample,
  ExecutableMove,
  ExecutableMoveResult,
  GroundedArrival,
} from '../execution/types.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import type { BodyContext } from '../traversability/step.js';
import type { Vec3Like } from '../types.js';
import type { ChangeReport } from '../voxel/voxel-map.js';
import type { CancellationOrigin } from './route-plan-types.js';
import type { LastObservation, NavProblem } from './types.js';

/** Input to `walkPath`; the route must come from `planRoute` and is single-use. */
export interface WalkPathRequest {
  /** Must come from `planRoute`; consumed once by the `walkPath` entry. */
  routeId: string;
  /** Absolute deadline (epoch ms); never reset per segment. */
  deadlineMs: number;
  signal?: AbortSignal;
  /** Optional override; defaults to `GROUNDED_ARRIVAL_DEFAULTS`. */
  bodyArrival?: GroundedArrival;
}

/**
 * Source of accepted-change reports for the active execution.
 *
 * Mirrors contract §7.3 `subscribe(callback) => unsubscribe`. This is distinct
 * from the memory write port's `subscribeChanges(sink, options)` — the walk
 * executor asks for a simple per-run subscription.
 */
export interface ChangeReportSource {
  subscribe(callback: (report: ChangeReport) => void): () => void;
}

/** Environment supplied by the host for one bounded walk execution. */
export interface WalkPathEnvironment {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /**
   * Latest measured body sample. It must carry the stable external identity
   * `exec_<routeId>` for the active walkPath; null, an old session or a
   * disconnect means failure (never a reason to wait for TIMEOUT).
   */
  sample(): BodySample | null;
  /** Single-step body port; executes one authorized move and never re-plans. */
  bodyPort: WalkBodyPort;
  /** Observation change source; must be the same chain as `observeBatch`. */
  changes?: ChangeReportSource;
  now?: () => number;
  cancellationOrigin?: CancellationOrigin;
}

/** Single-step body port; it only executes one authorized move. */
export interface WalkBodyPort {
  move(request: ExecutableMove): Promise<ExecutableMoveResult>;
  /** Stop only the execution identified by `executionId`; never stop a newer one. */
  stop(executionId: string): void;
}

/**
 * Terminal outcomes of one `walkPath` delegation.
 *
 * `INVALIDATED` is independent: a start/evidence/session/scope change stops the
 * route and is never folded into `BLOCKED` or `NO_PATH`.
 */
export type WalkPathOutcome =
  | 'ARRIVED'
  | 'PARTIAL'
  | 'NO_PATH'
  | 'BLOCKED'
  | 'INVALIDATED'
  | 'TIMEOUT'
  | 'CANCELLED';

/** Result of one bounded walk execution (contract §7.4). */
export interface WalkPathResult {
  outcome: WalkPathOutcome;
  contract: 'memory-host-contract/1';
  routeId: string;
  executionId: string;
  lastPosition?: Vec3Like;
  lastObservation?: LastObservation;
  confirmedSegments: number;
  remainingPoints: Vec3Like[];
  invalidation?: {
    segment: number;
    reason: string;
    /**
     * The accepted-change report forwarded to the executor immediately before
     * the invalidation became terminal (contract §7.4, §8.1), kept verbatim.
     * It names the report under consideration, not necessarily the sole cause:
     * the executor can also stop on TTL expiry, a rule-version change or a
     * section-residency change, which no report exposes. Absent when no report
     * was forwarded during this execution.
     */
    changes?: ChangeReport;
  };
  problem?: NavProblem;
  consumption?: {
    placed: { pos: Vec3Like; name: string }[];
    durabilityLost?: number;
    digMs?: number;
  };
  memoryWrite?: 'saved' | 'pending' | 'failed';
  /** Only `ARRIVED` must be true; every other outcome is false. */
  confirmed: boolean;
  trace: { pos: Vec3Like; ts: number }[];
}
