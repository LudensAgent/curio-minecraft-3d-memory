/**
 * `SpatialMemoryStore` — runtime store interface (design §9).
 *
 * One store instance is bound to an immutable `worldId`; coordinate methods take
 * an explicit `dim`. This is the in-memory work set of accepted evidence, not a
 * persistence handle: `observe` / `saveFragment` returning does not mean the
 * data is on disk. Lifecycle (init / section load / save status / flush / close)
 * is added in phase 5 (§9.2).
 */

import type { Frontier } from '../navigation/types.js';
import type { Observation } from '../observation/types.js';
import type { PathFragment, SpatialEdge, SpatialNode, LandmarkTag } from '../topology/index.js';
import type { Vec3Like } from '../types.js';
import type { Section } from '../voxel/section.js';

export interface SpatialMemoryStore {
  // --- Voxel (current world state)
  observe(o: Observation): void;
  sectionAt(dim: string, x: number, y: number, z: number): Section | null;
  markTraversed(dim: string, pos: Vec3Like): void;
  /** Only from a confirmed own action. */
  markModified(dim: string, pos: Vec3Like, actionId: string): void;

  // --- Paths (historical geometry)
  saveFragment(f: PathFragment): void;
  forgetFragment(id: string): void;
  fragments(dim?: string): PathFragment[];

  // --- Topology (places & connections)
  recordNode(dim: string, label: string, pos: Vec3Like, tag?: LandmarkTag): SpatialNode;
  upsertNode(n: SpatialNode): void;
  upsertEdge(e: SpatialEdge): void;
  /** Severs the current connection only — never deletes a fragment. */
  dropEdge(from: string, to: string): void;
  graph(dim: string): { nodes: SpatialNode[]; edges: SpatialEdge[] };
  portalEdges(): SpatialEdge[];

  // --- Routing & anchors (geometry memory, unverified against current terrain)
  route(
    dim: string,
    from: Vec3Like,
    to: Vec3Like,
    opts?: { near?: number; hop?: number; link?: number },
  ): Vec3Like[] | null;
  surfaceAnchor(dim: string, here: Vec3Like): Vec3Like | null;
  deepestAnchor(dim: string, here?: Vec3Like, opts?: { near?: number }): Vec3Like | null;
  fragmentation(dim: string): {
    records: number;
    points: number;
    components: number;
    pieces: { points: number; records: number }[];
  };

  // --- Frontier (candidates only — never selects a target)
  frontierCandidates(dim: string, here: Vec3Like): Frontier[];
}
