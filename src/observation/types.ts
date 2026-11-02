/**
 * Observation / evidence model (design §3.2).
 *
 * The library only ever writes cells that were actually seen or contacted
 * through the host's perception boundary, or whose effect was confirmed by the
 * agent's own action. Raw `blockUpdate` / chunk data / sounds never produce an
 * `Observation`.
 */

import type { BlockState, Vec3Like } from '../types.js';

/** Who produced the observation. */
export type ObservationSource = 'vision' | 'agent_action' | 'local_rescan';

/** What kind of confirmation the observation rests on. */
export type EvidenceKind = 'seen' | 'contact' | 'confirmed_effect';

/**
 * Precise evidence for one cell, confirmed through the perception boundary or a
 * verified action effect.
 */
export interface Observation {
  pos: Vec3Like;
  /** name + properties; serialized into the section palette on persistence. */
  state: BlockState;
  /** false when only the name is known — never guess door/liquid state from a name. */
  stateComplete: boolean;
  evidence: EvidenceKind;
  /** Real timestamp the evidence was acquired, never the persist time. */
  observedAt: number;
  /** Only recorded when an actual observed world tick exists; never derived from offline duration. */
  observedWorldTick?: number;
  source: ObservationSource;
  sessionId: string;
  /** Retains the host observation id for correlation; it is not a scan sequence. */
  originObservationId?: number;
  /** Boundary receive order; shares one per-session sequence with perception events. */
  sequence: number;
  /** Only present for a confirmed own-action effect; never inferred from temporal proximity. */
  actionId?: string;
  dim: string;
  worldId: string;
}

/** A cell this batch was asked to check but could not observe, with the real reason. */
export interface ObservationGap {
  pos: Vec3Like;
  reason:
    | 'out_of_view'
    | 'occluded'
    | 'too_dark'
    | 'unloaded'
    | 'budget_not_scanned'
    | 'unknown';
}

/** One batch: cells actually observed plus cells requested-but-not-observed. */
export interface ObservationBatch {
  observations: Observation[];
  unobserved: ObservationGap[];
}

export type Freshness = 'FRESH' | 'STALE';

/** Per-cell evidence plus versioning; a Section keeps one of these per observed cell. */
export interface CellEvidence {
  observation: Observation;
  /** Advances when content / completeness / validity changes; re-confirming the same state only refreshes time. */
  revision: number;
  freshness: Freshness;
  staleReason?: 'unloaded' | 'observation_gap' | 'expired' | 'pending_effect' | 'conflict';
  /** Local cache validity ceiling; does not guarantee the world did not change meanwhile. */
  validUntil: number;
}
