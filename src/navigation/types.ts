/**
 * Navigation result envelope and delegation records (design §7).
 *
 * These are L2 primitives the library will expose; they are *not* yet registered
 * action names in Curio. Every failure returns both a human `message` and a
 * structured `problem` — never a bare string.
 */

import type { EffectEvidence, MaterialAllowance } from '../adapter/types.js';
import type { Observation, ObservationGap } from '../observation/types.js';
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
    };

export type ArrivalSpec =
  | { kind: 'exact' }
  | { kind: 'near'; radius: number }
  | { kind: 'reach_block' };

/** Input to `navigate_to`. The original request and the parsed target are both retained. */
export interface NavigateRequest {
  destination: Vec3Like;
  arrival: ArrivalSpec;
  allowedModes: MoveMode[];
  allowDigging: boolean;
  allowPlacing: boolean;
  allowTower: boolean;
  materials: MaterialAllowance[];
  exploration: 'known_only' | 'allow_frontier';
}

/** Input to `follow_known_path`. */
export interface FollowKnownPathRequest {
  pathId: string;
}

export interface NavResult {
  outcome: NavOutcome;
  message: string;
  /** Last *confirmed* position; omitted when there is no evidence (never the requested position). */
  lastPosition?: Vec3Like;
  lastObservation?: {
    worldId: string;
    dim: string;
    sessionId: string;
    observedAt: number;
    onGround: boolean;
    inWater: boolean;
    /** absent = not provided, not "confirmed unmounted". */
    riding?: string | null;
  };
  problem?: NavProblem;
  trace: { pos: Vec3Like; ts: number }[];
  consumption?: {
    placed: { pos: Vec3Like; name: string }[];
    durabilityLost?: number;
    digMs?: number;
  };
  /** true only when outcome is backed by a position confirmation; ARRIVED requires it. */
  confirmed: boolean;
  /** `saved` requires a commit confirmation; never rewrites a completed body effect into "didn't happen". */
  memoryWrite?: 'saved' | 'pending' | 'failed';
}

/** Unknown-boundary candidate with reachability and observation basis; never a chosen target. */
export interface Frontier {
  pos: Vec3Like;
  basis: Observation[];
  reachability: Traversability;
  historicalConnection: boolean;
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
  };
  subActions: {
    kind: string;
    at?: Vec3Like;
    block?: string;
    origin: 'agent' | 'execution_helper' | 'scheduler';
    targetRole?: 'body' | 'head' | 'support' | 'placement_target' | 'reference_face';
    /** ok = declared effect confirmed; noop = confirmed no effect; unknown = unconfirmed. */
    outcome: 'ok' | 'noop' | 'unknown' | 'refused' | 'failed';
    effect?: EffectEvidence;
  }[];
  from: Vec3Like;
  to?: Vec3Like;
  trace: { pos: Vec3Like; ts: number }[];
  consumption: { placed: { pos: Vec3Like; name: string }[]; durabilityLost?: number; digMs?: number };
  observedChanges: Observation[];
  failureAt?: Vec3Like;
  failureReason?: string;
  confirmed: boolean;
}
