/**
 * Navigation result envelope and delegation records (design §7).
 *
 * These are L2 primitives the library will expose; they are *not* yet registered
 * action names in Curio. Every failure returns both a human `message` and a
 * structured `problem` — never a bare string.
 */

import type { EffectEvidence, MaterialAllowance } from '../adapter/types.js';
import type { Observation, ObservationGap } from '../observation/types.js';
import type { StepConstraints } from '../traversability/step.js';
import type { HazardFact, ObstacleEvidence, Traversability } from '../traversability/types.js';
import type { MoveMode, Vec3Like } from '../types.js';

export type NavOutcome =
  | 'ARRIVED'
  | 'PARTIAL'
  | 'NO_PATH'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'FAILED';

export type NavProblem =
  | { kind: 'unloaded' | 'stale'; pos: Vec3Like }
  | { kind: 'unobserved'; gap: ObservationGap }
  | { kind: 'blocked' | 'head_blocked'; evidence: ObstacleEvidence }
  | { kind: 'hazard'; facts: HazardFact[]; constraint: string }
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'unsupported_target'; detail: string }
  | { kind: 'search_budget_exhausted'; budgetMs: number }
  | { kind: 'not_authorized'; detail: string }
  | { kind: 'occupied'; pos: Vec3Like; observedAt: number }
  | { kind: 'support_out_of_reach'; pos: Vec3Like; requiredSupport: Vec3Like }
  | { kind: 'no_path' }
  | { kind: 'timeout' }
  | {
      kind: 'cancelled';
      by: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';
      reason: string;
    }
  // Execution-phase failures (design §7): the body left the route or scope, a
  // move returned without a confirming position, or the segment's evidence was
  // invalidated mid-execution. These must not be collapsed into BLOCKED/NO_PATH.
  | { kind: 'deviation'; expected: Vec3Like; actual: Vec3Like }
  | { kind: 'unconfirmed_arrival'; expected: Vec3Like }
  | { kind: 'unmeasured_position'; expected: Vec3Like }
  | { kind: 'support_missing'; pos: Vec3Like; detail: string }
  | { kind: 'route_invalidated'; detail: string }
  | { kind: 'scope_changed'; detail: string }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'execution_failed'; detail: string }
  // Request-boundary rejection: malformed fields or fields outside the
  // declared contract. This is not a world fact and must not be read as any
  // obstacle or path conclusion.
  | { kind: 'invalid_request'; detail: string };

export type ArrivalSpec =
  | { kind: 'exact' }
  | { kind: 'near'; radius: number }
  | { kind: 'reach_block' };

/** Body/world evidence snapshot that must accompany an ARRIVED position (§7). */
export interface LastObservation {
  worldId: string;
  dim: string;
  sessionId: string;
  observedAt: number;
  onGround: boolean;
  inWater: boolean;
  /** absent = not provided, not "confirmed unmounted". */
  riding?: string | null;
}

interface NavResultBase {
  message: string;
  trace: { pos: Vec3Like; ts: number }[];
  consumption?: {
    placed: { pos: Vec3Like; name: string }[];
    durabilityLost?: number;
    digMs?: number;
  };
  /** `saved` requires a commit confirmation; never rewrites a completed body effect into "didn't happen". */
  memoryWrite?: 'saved' | 'pending' | 'failed';
}

/**
 * Navigation result envelope, discriminated on `outcome` (design §7).
 *
 * This is a compile-time contract only: emitting `ARRIVED` still requires the
 * runtime to have validated the original completion condition against a measured
 * position — the type cannot prove that on its own.
 */
export type NavResult =
  | (NavResultBase & {
      outcome: 'ARRIVED';
      lastPosition: Vec3Like;
      lastObservation: LastObservation;
      confirmed: true;
      problem?: never;
    })
  | (NavResultBase & {
      outcome: 'PARTIAL';
      lastPosition?: Vec3Like;
      lastObservation?: LastObservation;
      confirmed: boolean;
      problem?: NavProblem;
    })
  | (NavResultBase & {
      outcome: 'NO_PATH' | 'BLOCKED' | 'CANCELLED' | 'TIMEOUT' | 'FAILED';
      lastPosition?: Vec3Like;
      lastObservation?: LastObservation;
      confirmed: boolean;
      problem: NavProblem;
    });

/** Unknown-boundary candidate with reachability and observation basis; never a chosen target. */
export interface Frontier {
  pos: Vec3Like;
  basis: Observation[];
  reachability: Traversability;
  /** `'unknown'` when no history lookup was made; never fabricated as false. */
  historicalConnection: boolean | 'unknown';
}

/** One delegated navigation/execution, kept for attribution and skill learning. */
export interface ActionRecord {
  id: string;
  ts: number;
  worldId: string;
  dim: string;
  sessionId: string;
  delegationId: string;
  parentActionId?: string;
  delegation: {
    /** Original request entering the parse boundary — not the truncated target. */
    requestedTarget: string | Vec3Like;
    target: Vec3Like;
    allowedModes: MoveMode[];
    arrival: ArrivalSpec;
    allowDigging: boolean;
    allowPlacing: boolean;
    allowTower: boolean;
    materials: MaterialAllowance[];
    exploration: 'known_only' | 'allow_frontier';
    /** Delegation constraints, when supplied; absent means none were requested. */
    constraints?: StepConstraints;
  };
  subActions: {
    kind: string;
    at?: Vec3Like;
    block?: string;
    origin: 'agent' | 'execution_helper' | 'scheduler';
    targetRole?: 'body' | 'head' | 'support' | 'placement_target' | 'reference_face';
    /** ok = declared effect confirmed; noop = confirmed no effect; unknown = unconfirmed; cancelled = stopped partway, partial effects kept. */
    outcome: 'ok' | 'noop' | 'unknown' | 'refused' | 'failed' | 'cancelled';
    effects?: readonly EffectEvidence[];
  }[];
  from: Vec3Like;
  to?: Vec3Like;
  trace: { pos: Vec3Like; ts: number }[];
  consumption: { placed: { pos: Vec3Like; name: string }[]; durabilityLost?: number; digMs?: number };
  observedChanges: Observation[];
  failureAt?: Vec3Like;
  failureReason?: string;
  confirmed: boolean;
  /**
   * Full original navigation/execution result, when the caller has one. This is
   * optional so older callers remain valid; when present it is retained verbatim
   * (outcome, problem, last observation, trace, partial effects and the original
   * `memoryWrite` marker) rather than reconstructed from legacy `ok/confirmed`.
   */
  result?: NavResult;
}
