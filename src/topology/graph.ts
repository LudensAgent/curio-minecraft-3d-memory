/**
 * Topology graph (design §5).
 *
 * G = (V, E): nodes are entrances/places/branches/turns/vertical junctions;
 * edges are path segments between them. This layer answers "how did we get
 * there and what does it connect to", not "can we walk it right now".
 */

import type { ObstacleEvidence, TraversabilityEntry } from '../traversability/types.js';
import type { MoveMode, Vec3Like } from '../types.js';

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
 * quotas and must not share a display namespace. In this phase both kinds are
 * capacity-bounded with explicit rejection on overflow — no oldest-first eviction
 * is implemented here (a later phase may add durability-based eviction).
 */
export type NodeSource = 'agent' | 'program';

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
}

export interface SpatialEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  /** true = only traversable along from→to (e.g. a DROP). */
  directed: boolean;
  /** Candidate modes supported by evidence; does not replace per-delegation authorization. */
  modes: MoveMode[];
  /** Owning PathFragment, for provenance. */
  fragmentId?: string;
  /** Direction / mode / context verification; blockedAt only marks the current edge, never deletes the fragment. */
  verifications: (Omit<TraversabilityEntry, 'pos' | 'to'> & {
    direction: 'forward' | 'reverse';
    blockedAt?: ObstacleEvidence;
  })[];
}
