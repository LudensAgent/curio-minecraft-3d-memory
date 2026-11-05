/**
 * Topology graph (design §5).
 *
 * G = (V, E): nodes are entrances/places/branches/turns/vertical junctions;
 * edges are path segments between them. This layer answers "how did we get
 * there and what does it connect to", not "can we walk it right now".
 */

import type { JsonObject } from '../json-value.js';
import type { HazardFact, ObstacleEvidence } from '../traversability/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type { SectionKey } from '../voxel/section.js';

export type ConnectionType =
  | 'HORIZONTAL'
  | 'STAIRCASE'
  | 'VERTICAL_SHAFT'
  | 'LADDER'
  | 'BRIDGE'
  | 'DROP'
  | 'CLIMB'
  | 'SWIM'
  | 'CAVE_PASSAGE'
  | 'PORTAL';

/** Topological role of a node (orthogonal to its semantic tag). */
export type NodeKind = 'entrance' | 'place' | 'branch' | 'turn' | 'vertical_junction';

/** Semantic classification of an anchor (maps to the host `Landmark.kind`). */
export type LandmarkTag =
  | 'base'
  | 'resource'
  | 'danger'
  | 'discovery'
  | 'death'
  | 'waypoint'
  | 'herd'
  | 'portal';

/**
 * Who recorded this anchor (design §5 "命名空间分流"). Drives separate capacity
 * quotas and the display namespace: `agent` and `program` nodes draw on their own
 * quotas and must not share a display namespace. Agent nodes are durable: an
 * overflow is rejected, never evicted. Program nodes may be evicted oldest-first
 * within the program quota (never an agent node, never a node still referenced by
 * an edge).
 */
export type NodeSource = 'agent' | 'program';

/** Evidence that a node's object is no longer there. */
export interface GoneEvidence {
  /** Session the disappearance was actually observed in; never fabricated. */
  sessionId: string;
  /** Real observation time; never a receive time, save batch, or `Date.now()` guess. */
  observedAt: number;
  /** Caller-supplied provenance label (e.g. `"vision_scan"`); opaque to the library. */
  source: string;
  /** Host observation ids that witnessed the absence, when available. */
  observationIds?: string[];
  reason?: string;
}

export interface SpatialNode {
  id: string;
  kind: NodeKind;
  /** Who recorded it — orthogonal to `kind`/`tag`; drives eviction and display. */
  source: NodeSource;
  /** Semantic tag; `label` carries the meaning, which is opaque to the library. */
  tag?: LandmarkTag;
  label?: string;
  worldId: string;
  dim: string;
  location:
    | { kind: 'exact'; pos: Vec3Like }
    | { kind: 'region'; center: Vec3Like; radius: number };
  /** Real time the node's location/object was last actually observed. */
  observedAt?: number;
  /** Host identity for the same object (e.g. landmark id, chest key), opaque to the library. */
  externalRef?: string;
  /**
   * Host-requested durability. Durable program nodes are never evicted by the
   * program-node quota; if the store is full, insertion fails instead.
   */
  durable?: boolean;
  /** Opaque host metadata; never interpreted by the library. */
  metadata?: JsonObject;
  /**
   * The object at this anchor was observed to be gone. The node record and its
   * history are kept; `markGone` requires real observation evidence.
   */
  gone?: boolean;
  /** Real observation time of the disappearance; only present when `gone` is true. */
  goneAt?: number;
  /** What proved the disappearance. */
  goneEvidence?: GoneEvidence;
}

/** Direction of a traversal relative to an edge's stored `from → to`. */
export type EdgeDirection = 'forward' | 'reverse';

/**
 * Current passage status for one direction + mode of one edge. `UNSUPPORTED` is
 * structural (mode not carried by the edge, or reverse of a directed edge), not
 * an observation that the world is blocked.
 */
export type EdgeVerificationStatus = 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED';

/** One section revision the verification actually depended on. */
export interface EdgeDependency {
  key: SectionKey;
  revision: number;
}

/**
 * A verification of one edge direction under one movement mode. It is derived
 * evidence, not history: deleting/replacing it never deletes the edge's
 * `PathFragment`. `OPEN` is only valid while `validUntil > now`; an expired
 * `OPEN` reads as `STALE` and is never treated as passable.
 */
export interface EdgeVerification {
  direction: EdgeDirection;
  mode: MoveMode;
  status: EdgeVerificationStatus;
  reason?: string;
  /** Evidence for `BLOCKED`; pure contact may prove blockage without a block name. */
  blockedAt?: ObstacleEvidence;
  /** Independent risk facts; `OPEN` does not mean risk-free. */
  hazards: HazardFact[];
  /** Section revisions read to reach this verdict. */
  dependencies: EdgeDependency[];
  /** Body size/pose/capabilities/mode plus delegation constraints. */
  contextKey: string;
  /** Session the verification was computed in; absent is never back-filled. */
  sessionId: string;
  /** Real computation/observation time. */
  computedAt: number;
  /** Finite evidence-reuse ceiling. */
  validUntil: number;
}

export interface SpatialEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  /**
   * `true` = only traversable along from→to (e.g. a DROP). Absent defaults to
   * `true`, matching historical one-directional records. `false` means both
   * directions have their own traversal evidence and their own verification.
   */
  directed?: boolean;
  /** Candidate modes supported by evidence; does not replace per-delegation authorization. */
  modes?: MoveMode[];
  /** Owning PathFragment, for provenance. */
  fragmentId?: string;
  /**
   * Direction / mode / context verification; blockedAt only marks the current
   * edge, never deletes the fragment. Each `(direction, mode)` pair has at most
   * one record; forward OPEN never backs the reverse direction.
   */
  verifications?: EdgeVerification[];
}
