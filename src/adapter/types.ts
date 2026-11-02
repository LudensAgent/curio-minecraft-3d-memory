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

/** Per-delegation movement constraints (mirrors §2.2 field mapping). */
export interface MoveOpts {
  signal: AbortSignal;
  timeoutMs: number;
  allowTerrainChanges: boolean;
  allowPlace: boolean;
  allowTower: boolean;
  allowSwimming: boolean;
  maxDropDown: number;
  avoid: readonly Vec3Like[];
  materials: readonly MaterialAllowance[];
}

/** Surface-swim options; extended by the execution adapter at integration time. */
export interface SwimOptions {
  // Reserved for the concrete adapter's surface-swim controls (target, budget, …).
}

/** Body action result shell; the concrete adapter extends it. */
export interface ActionResult {
  ok: boolean;
}

/** Confirmed effect evidence for an own action (design §3.2). */
export interface EffectEvidence {
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

  /** L1 body — the library only stably executes a destination the agent already chose. */
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
