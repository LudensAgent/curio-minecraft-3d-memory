/**
 * `WorldAdapter` — the target adapter surface (design §2.1).
 *
 * The library does not import mineflayer. It consumes this narrow dependency
 * face, which the host composes out of its own perception loop and body
 * primitives. These are the library's *own* contract types, not a verbatim copy
 * of Curio's `GameAdapter`; they are reconciled with the real adapter at
 * integration time (§2.2).
 */

import type { ObservationBatch } from '../observation/types.js';
import type { MoveMode, Vec3Like, WorldScope } from '../types.js';

/** Body/world state subset the library depends on. */
export interface AgentState {
  pos: Vec3Like;
  dim: string;
  worldId: string;
  sessionId: string;
  observationId: number;
  /** Real timestamp this body snapshot was captured; never fabricated from log/offline duration. */
  observedAt: number;
  alive: boolean;
  connected: boolean;
  observationReady: boolean;
  onGround: boolean;
  inWater: boolean;
  inLava: boolean;
  oxygen: number;
  effects: readonly string[];
  riding: string | null;
  worldAgeTicks: number;
}

export interface MoveTarget {
  pos: Vec3Like;
}

/** Allowed item spend for placing; a target with no allowance must not place. */
export interface MaterialAllowance {
  name: string;
  maxCount: number;
}

/**
 * Why the executor refused a request it cannot honor. The executor throws one of
 * these rather than silently dropping a constraint; the navigation layer maps it
 * to a `NavProblem`.
 */
export type MoveRejection =
  | { kind: 'unsupported_mode'; mode: MoveMode; supported: readonly MoveMode[] }
  | { kind: 'unsupported_exploration'; requested: 'known_only' | 'allow_frontier' }
  | { kind: 'not_authorized'; constraint: string }
  | { kind: 'material_unavailable'; name: string; maxCount: number };

/** Per-delegation movement constraints (design §2.2 / §7). */
export interface MoveOpts {
  signal: AbortSignal;
  /** Original delegation deadline (epoch ms); retries and nesting share it — never reset per move. */
  deadlineMs: number;
  /** Per-move timeout budget within the delegation. */
  timeoutMs: number;
  /** Full set of modes the delegation authorizes; unsupported combinations are rejected, never silently dropped. */
  allowedModes: readonly MoveMode[];
  /** Search scope: `known_only` confines planning to verified space; `allow_frontier` permits frontier candidates. */
  exploration: 'known_only' | 'allow_frontier';
  /** allowDigging. */
  allowTerrainChanges: boolean;
  /** allowPlacing. */
  allowPlace: boolean;
  /** Towering is authorized separately; never implied by `allowPlace`. */
  allowTower: boolean;
  /** Per-material allowance cap; the executor reports consumption and the store tracks the remaining amount. */
  materials: readonly MaterialAllowance[];
  /** Max single-step drop-down (adjacent xyz), not a global route height constraint. */
  maxDropDown: number;
  /** Blocks to avoid. */
  avoid: readonly Vec3Like[];
}

/** Surface-swim constraints (design §2.1 / §7). The concrete adapter extends this. */
export interface SwimOptions {
  /** Whether the swim must end by landing on solid ground; false = remaining afloat satisfies the target. */
  requireLanding: boolean;
  /** Delegation deadline (epoch ms); shared with retries/nesting. */
  deadlineMs: number;
  /** Per-swim timeout budget. */
  timeoutMs?: number;
}

/**
 * Body action result shell; the concrete adapter extends it.
 *
 * `ok` means "the declared effect was confirmed", not merely "the call returned".
 * On cancel/timeout, the confirmed partial effects are still preserved here with
 * their original scope and time.
 */
export interface ActionResult {
  ok: boolean;
  /** Confirmed effects, kept even when the action is cancelled or fails partway. */
  effects: readonly EffectEvidence[];
}

/** Structured, confirmed effect evidence for an own action (design §3.2). */
export interface EffectEvidence {
  /** What was confirmed (e.g. block dug/placed, item received, moved, turned). */
  kind: string;
  /** Where the effect occurred. */
  at?: Vec3Like;
  /** Block name when the effect is a block change. */
  block?: string;
  /** Real timestamp the effect was confirmed — not the request time. */
  observedAt: number;
  /** Scope where the effect was observed. */
  worldId: string;
  dim: string;
  sessionId: string;
  /** Which own action confirmed it; never inferred from time proximity. */
  actionId?: string;
  /** Confirmed, not merely requested. */
  verified: boolean;
}

export interface EventContext extends WorldScope {
  sessionId: string;
  receivedAt: number;
  sequence: number;
}

export type PerceptionEvent = EventContext &
  (
    | ({ kind: 'observed' } & ObservationBatch)
    | { kind: 'column_unavailable'; cx: number; cz: number }
    | {
        kind: 'observation_gap';
        reason: 'disconnected' | 'paused' | 'scope_changed' | 'not_ready';
      }
  );

/**
 * The library's dependency face: perception evidence + execution + observation
 * lifecycle. `observeBatch` must only return cells truly seen/contacted; cells
 * not returned are not air.
 */
export interface WorldAdapter {
  state(): AgentState;

  /** New bridged entry; does not change the legacy `observeBlocks` return type. */
  observeBatch(positions: Vec3Like[]): ObservationBatch;
  capabilities(): { fullBlockState: boolean; movementModes: MoveMode[] };

  /** L1 body — stably executes a destination the agent already chose. Rejects with a `MoveRejection` when a constraint in `opts` cannot be honored. */
  moveTo(target: MoveTarget, opts: MoveOpts): Promise<void>;
  swimTo?(
    target: Vec3Like | null,
    signal: AbortSignal,
    opts?: SwimOptions,
  ): Promise<ActionResult & { landed: boolean; oxygen: number }>;
  stopAll(): void;
  dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult>;
  placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult>;

  /** Existing action-history hints; lack scope/full post-state/actionId, so not turned into Observations. */
  recentDug?(since: number): { pos: Vec3Like; name: string; ts: number }[];
  recentPlaced?(since: number): { pos: Vec3Like; name: string; ts: number }[];

  /** Perception-loop push; returns an unsubscribe fn, never subscribes to raw blockUpdate. */
  subscribe(cb: (event: PerceptionEvent) => void): () => void;
}
