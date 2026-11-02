/**
 * Derived traversability (design §3.3).
 *
 * Traversability is computed from current world state + body + movement mode +
 * delegation constraints. It is a cache that can be invalidated; it is *not* a
 * navigation permission or a no-risk guarantee.
 */

import type { Observation } from '../observation/types.js';
import type { Vec3Like, MoveMode } from '../types.js';
import type { SectionKey } from '../voxel/section.js';

/** The only four passage states; UNKNOWN/STALE are never treated as OPEN. */
export type Traversability = 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE';

/** Objective risk facts tied to evidence; independent of the four passage states. */
export interface HazardFact {
  kind:
    | 'water_contact'
    | 'submersion'
    | 'lava_contact'
    | 'current'
    | 'bubble_column'
    | 'fall';
  pos: Vec3Like;
  basis: 'observed' | 'derived';
  detail: string;
}

/**
 * Evidence of an obstacle. Pure collision/contact proves blockage but must not
 * fill in an unseen block name.
 */
export type ObstacleEvidence =
  | { kind: 'block'; observation: Observation }
  | { kind: 'contact'; pos: Vec3Like; observedAt: number; sessionId: string };

/**
 * Passage judgement for one step and its direction, under one mode and body
 * context — not merely for a single cell.
 */
export interface TraversabilityEntry {
  pos: Vec3Like;
  to: Vec3Like;
  mode: MoveMode;
  status: Traversability;
  /** Collision / missing support / unloaded / stale evidence, etc. */
  reason?: string;
  /** Independent of the four states; OPEN does not mean risk-free. */
  hazards: HazardFact[];
  dependencies: { key: SectionKey; revision: number }[];
  /** Normalized key over body size/pose/capabilities/mode plus this delegation's constraints. */
  contextKey: string;
  sessionId: string;
  computedAt: number;
  /** No later than the validity of the evidence it depends on. */
  validUntil: number;
}
