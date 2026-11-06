/**
 * `SpatialMemoryStore` — runtime store interface (design §9).
 *
 * One store instance is bound to an immutable `worldId`; coordinate methods take
 * an explicit `dim`. This is the in-memory work set of accepted evidence, not a
 * persistence handle: `observe` / `saveFragment` returning does not mean the
 * data is on disk. Lifecycle (init / section load / save status / flush / close)
 * is added in phase 5 (§9.2).
 */

import type { ChangeReportSource } from '../memory/change-reports.js';
import type { Frontier } from '../navigation/types.js';
import type { Observation, ObservationBatch } from '../observation/types.js';
import type { SpatialQueryRequest, SpatialQueryResult } from '../query/types.js';
import type {
  AnchorQueryOptions,
  AnchorResult,
  ComponentReport,
  EdgeBlockInput,
  EdgeDirection,
  EdgeRuntimeView,
  EdgeVerificationInput,
  FragmentSegmentsResult,
  FragmentationResult,
  GoneEvidence,
  LandmarkTag,
  NodeSource,
  PathFragment,
  PortalEdgeInput,
  PortalEdgeView,
  PortalTraversalEvidence,
  RecordNodeOptions,
  RuntimeQueryOptions,
  SaveResult,
  SpatialEdge,
  SpatialNode,
  TraversalEvidence,
} from '../topology/index.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type { Section } from '../voxel/section.js';
import type { BatchChangeReport, ChangeReport, StaleReason } from '../voxel/voxel-map.js';

export interface SpatialMemoryStore extends ChangeReportSource {
  // --- Voxel (current world state)
  observe(o: Observation): void;
  /** Atomically accept one batch; returns the localized change report plus gaps. */
  observeBatch(batch: ObservationBatch): BatchChangeReport;
  /** Begin/switch the observation session; returns the local invalidation report. */
  beginSession(sessionId: string): ChangeReport;
  /** Mark observation interrupted/unloaded; freshness only, history is kept. */
  markStale(dim: string, reason: StaleReason): ChangeReport;
  sectionAt(dim: string, x: number, y: number, z: number): Section | null;
  markTraversed(dim: string, pos: Vec3Like): void;
  /** Only from a confirmed own action. */
  markModified(dim: string, pos: Vec3Like, actionId: string): void;

  // --- Paths (historical geometry)
  saveFragment(f: PathFragment): void;
  /** Record measured continuous traversal; the fragment must already exist. */
  addTraversal(evidence: TraversalEvidence): SaveResult;
  forgetFragment(id: string): void;
  fragments(dim?: string): PathFragment[];

  // --- Topology (places & connections)
  /** Agent-named, durable node. `options.dim` is required. */
  recordNode(label: string, pos: Vec3Like, tag?: LandmarkTag, options?: RecordNodeOptions): SpatialNode;
  upsertNode(n: SpatialNode): void;
  upsertEdge(e: SpatialEdge): void;
  /** Severs the current connection only — never deletes a fragment. */
  dropEdge(from: string, to: string): void;
  graph(dim: string): { nodes: SpatialNode[]; edges: SpatialEdge[] };
  displayNodes(query?: { dim?: string; namespace?: NodeSource; limit?: number; after?: string }): {
    items: SpatialNode[];
    total: number;
    nextAfter?: string;
  };
  /** Requires real observation evidence; history is preserved. */
  markGone(nodeId: string, evidence: GoneEvidence): void;
  goneNear(dim: string, pos: Vec3Like, radius?: number): SpatialNode[];

  // --- Runtime edge verification (derived state; never deletes history)
  verifyEdge(id: string, verification: EdgeVerificationInput): void;
  blockEdge(id: string, input: EdgeBlockInput): void;
  /** Replaces a blockage with explicit UNKNOWN; never restores OPEN by itself. */
  clearEdgeBlock(id: string, direction?: EdgeDirection, mode?: MoveMode): void;
  edgeRuntime(id: string, options?: RuntimeQueryOptions): EdgeRuntimeView | null;

  // --- Portal connections (separate from the walk graph)
  savePortalEdge(edge: PortalEdgeInput, traversals: PortalTraversalEvidence[]): void;
  addPortalTraversal(edgeId: string, traversal: PortalTraversalEvidence): void;
  portalEdges(): PortalEdgeView[];

  // --- Routing & anchors (geometry memory, unverified against current terrain)
  route(
    dim: string,
    from: Vec3Like,
    to: Vec3Like,
    opts?: { near?: number; hop?: number; link?: number },
  ): Vec3Like[] | null;
  surfaceAnchor(dim: string, here: Vec3Like, options?: AnchorQueryOptions): AnchorResult | null;
  deepestAnchor(dim: string, here: Vec3Like, options?: AnchorQueryOptions): AnchorResult | null;
  /** Union-find over actual links/evidence; never proximity. */
  fragmentation(dim: string): FragmentationResult;
  /** Node components with affected-subgraph recomputation. */
  components(dim: string): ComponentReport;
  /** Current-passable pieces derived from edge verification; history is kept. */
  segments(fragmentId: string): FragmentSegmentsResult;
  /** Only evidence that actually connects the two fragments; never proximity. */
  mergeFragments(aId: string, bId: string, evidenceId: string): void;

  // --- Read-only query projection (contract §5)
  /**
   * Project the composed stores for a host query. Never moves, turns, scans,
   * loads a Section, refreshes evidence, saves, pins, or executes.
   */
  query(request: SpatialQueryRequest): SpatialQueryResult;

  // --- Frontier (candidates only — never selects a target)
  frontierCandidates(dim: string, here: Vec3Like): Frontier[];
}
