/**
 * Runtime `SpatialMemoryStore` composition (design §9).
 *
 * One instance binds an immutable `worldId` and composes three in-memory
 * runtime stores that are passed in (or default-constructed):
 *
 * - `VoxelMap` — recently observed world state (design §3.2);
 * - `FragmentStore` — historical path geometry plus traversal evidence (§3.1);
 * - `TopologyStore` — explicitly recorded places and directional connections (§5).
 *
 * It is a *composition and scope guard*, not a new source of facts. Every read
 * is delegated to the composed stores; every write is checked against the bound
 * `worldId` first. Nothing here scans the world, refreshes evidence, loads a
 * Section, persists data, moves the body or selects a target.
 *
 * Several interface methods cannot be implemented truthfully from the current
 * sources. They raise `SpatialMemoryUnsupportedError` or return an explicit
 * `unavailable` result instead of inventing an answer:
 *
 * - `markTraversed` / `markModified` exist only when the injected `VoxelMap`
 *   actually implements them (this build may not);
 * - `portalEdges` is unsupported because `TopologyStore` rejects `PORTAL` edges
 *   and no portal-traversal history store is composed;
 * - `frontierCandidates` requires a caller-supplied `WalkSearchSnapshot`
 *   provider; it never starts a search itself.
 *
 * `route` / `surfaceAnchor` / `deepestAnchor` / `fragmentation` are historical
 * geometry queries. They do not prove current passability and are not
 * executable routes. See `docs/spatial-memory-store.md` for the full mapping.
 */

import type {
  ChangeReportSink,
  ChangeReportSubscriptionOptions,
} from '../memory/change-reports.js';
import type { MemoryIngest, SpatialEdgeRecord } from '../memory/ingest.js';
import type { Observation, ObservationBatch } from '../observation/types.js';
import type { Frontier } from '../navigation/types.js';
import { createSpatialQueryPort } from '../query/index.js';
import type {
  HistoricalRouteInspection,
  SpatialMemoryCapabilities,
  SpatialMemoryCapabilityName,
  SpatialMemoryStoreSnapshot,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
} from '../query/types.js';
import {
  frontierCandidates as projectFrontierCandidates,
  inspectRoute as projectRouteInspection,
} from '../navigation/route-inspection.js';
import type {
  FrontierCandidateView,
  FrontierCandidatesResult,
  RouteInspection,
} from '../navigation/route-inspection.js';
import type { WalkSearchSnapshot } from '../navigation/walk-search.js';
import type {
  AnchorOrder,
  AnchorQueryOptions,
  AnchorResult,
  ComponentReport,
  EdgeBlockInput,
  EdgeDirection,
  EdgeRuntimeView,
  EdgeVerificationInput,
  EdgeView,
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
  RouteQueryResult,
  RouteQueryStatus,
  RuntimeQueryOptions,
  SaveResult,
  SpatialEdge,
  SpatialNode,
  TopologyEdge,
  TraversalEvidence,
} from '../topology/index.js';
import { FragmentStore, TopologyStore } from '../topology/index.js';
import type { Vec3Like } from '../types.js';
import { blockToSection } from '../voxel/coordinates.js';
import type { Section } from '../voxel/section.js';
import type { BatchChangeReport, ChangeReport, StaleReason } from '../voxel/voxel-map.js';
import { VoxelMap } from '../voxel/voxel-map.js';
import type { SpatialMemoryStore } from './store.js';

export type { SpatialEdgeRecord } from '../memory/ingest.js';

// The capability/snapshot/route-inspection shapes are query-owned so the query
// module does not import the store. Re-export them here to keep the existing
// `store/index.js` and package entry-point paths unchanged.
export type {
  HistoricalRouteInspection,
  SpatialMemoryCapability,
  SpatialMemoryCapabilities,
  SpatialMemoryCapabilityName,
  SpatialMemoryStoreSnapshot,
} from '../query/types.js';

/** Caller-supplied read-only projection over a search it already ran. */
export type WalkSearchSnapshotProvider = (
  dim: string,
  here: Vec3Like,
) => WalkSearchSnapshot | null;

export interface SpatialMemoryStoreOptions {
  /** Immutable world identity for this store. Every composed part must agree. */
  worldId: string;
  /** Defaults to `new VoxelMap(worldId)`. */
  map?: VoxelMap;
  /** Defaults to `new FragmentStore(worldId)`. */
  fragments?: FragmentStore;
  /** Defaults to `new TopologyStore(fragments)`. */
  topology?: TopologyStore;
  /**
   * Read-only source of an already-run walk search. Required for
   * `frontierCandidates`; when absent that method reports `unavailable`.
   */
  frontierSource?: WalkSearchSnapshotProvider;
  /**
   * Read-only query-port behavior: envelope clock and the host-owned container
   * classifier. Without `isContainer`, `containerAnchors` is unsupported.
   */
  query?: SpatialQueryOptions;
}

// Compile-time guard: the query-owned capability key list must mirror exactly
// the store surface (`spatial-memory-store.ts` may not edit query types).
type ExpectTrue<T extends true> = T;
type _CapabilityNamesMatchStoreSurface = ExpectTrue<
  Exclude<
    SpatialMemoryCapabilityName | keyof SpatialMemoryStore,
    SpatialMemoryCapabilityName & keyof SpatialMemoryStore
  > extends never
    ? true
    : false
>;

/** `unavailable` is a first-class outcome; callers never have to catch to see it. */
export type FrontierInspection =
  | {
      status: 'unavailable';
      worldId: string;
      dim: string;
      here: Vec3Like;
      reason: string;
    }
  | {
      status: 'available';
      result: FrontierCandidatesResult;
      historicalConnection: 'unknown';
      note: string;
    };

/** A write or read named a different world than the one this store is bound to. */
export class SpatialMemoryScopeError extends Error {
  readonly code = 'scope_mismatch';

  constructor(message: string) {
    super(message);
    this.name = 'SpatialMemoryScopeError';
  }
}

/** The current composition cannot perform the method truthfully. */
export class SpatialMemoryUnsupportedError extends Error {
  readonly code = 'unsupported';
  readonly method: string;
  readonly detail: string;

  constructor(method: string, detail: string) {
    super(`${method} is unavailable: ${detail}`);
    this.name = 'SpatialMemoryUnsupportedError';
    this.method = method;
    this.detail = detail;
  }
}

/** Optional markers a newer `VoxelMap` build may provide; never assumed. */
interface OptionalTraversalMarkers {
  markTraversed?: (dim: string, pos: Vec3Like) => void;
  markModified?: (dim: string, pos: Vec3Like, actionId: string) => void;
}

/** Legacy geometric thresholds used only to count fragment connected components. */
export const FRAGMENTATION_HOP_DISTANCE = 7;
export const FRAGMENTATION_LINK_DISTANCE = 3.5;

const DEFAULT_ENDPOINT_NEAR = 5;
const DEFAULT_ANCHOR_NEAR = 6;
const ANCHOR_QUERY_LIMIT = 20;

export class SpatialMemoryStoreImpl implements SpatialMemoryStore, MemoryIngest, SpatialQueryPort {
  readonly worldId: string;

  private readonly voxel: VoxelMap;
  private readonly fragmentStore: FragmentStore;
  private readonly topologyStore: TopologyStore;
  private readonly frontierSource: WalkSearchSnapshotProvider | undefined;
  private readonly queryPort: SpatialQueryPort;

  constructor(options: SpatialMemoryStoreOptions) {
    const worldId = options.worldId;
    if (typeof worldId !== 'string' || worldId.length === 0) {
      throw new Error('worldId must be a non-empty string');
    }
    const fragments = options.fragments ?? new FragmentStore(worldId);
    const topology = options.topology ?? new TopologyStore(fragments);
    const voxel = options.map ?? new VoxelMap(worldId);

    assertSameWorld('VoxelMap', voxel.worldId, worldId);
    assertSameWorld('FragmentStore', fragments.worldId, worldId);
    assertSameWorld('TopologyStore', topology.worldId, worldId);

    this.worldId = worldId;
    this.voxel = voxel;
    this.fragmentStore = fragments;
    this.topologyStore = topology;
    this.frontierSource = options.frontierSource;
    this.queryPort = createSpatialQueryPort(this.buildQuerySources(), options.query);
  }

  // --- Voxel (current world state) ---

  observe(observation: Observation): void {
    this.assertWorld(observation.worldId, 'observe');
    this.assertDim(observation.dim, 'observe');
    this.voxel.observe(observation);
  }

  /**
   * Validate the batch's world scope before a single cell is written, then
   * return the `VoxelMap` change report unchanged. Schema/gap validation stays
   * in `VoxelMap.observeBatch` (the boundary that owns `Observation`), which
   * also keeps the whole batch atomic. A malformed batch is delegated as-is so
   * the owner reports its structured error instead of this loop throwing a
   * native `TypeError`. The report covers only the sections this batch touched;
   * gaps are diagnostics and never become cells.
   */
  observeBatch(batch: ObservationBatch): BatchChangeReport {
    if (batch !== null && typeof batch === 'object' && Array.isArray(batch.observations)) {
      for (const observation of batch.observations) {
        if (observation !== null && typeof observation === 'object') {
          this.assertWorld(observation.worldId, 'observeBatch');
        }
      }
    }
    return this.voxel.observeBatch(batch);
  }

  /**
   * Begin/switch the observation session. Evidence last confirmed by another
   * session becomes STALE and is reported; history and original evidence times
   * are kept. A late old-session write is rejected by `VoxelMap`.
   */
  beginSession(sessionId: string): ChangeReport {
    return this.voxel.beginSession(sessionId);
  }

  /** Mark observable evidence STALE after an interruption; history is never deleted. */
  markStale(dim: string, reason: StaleReason): ChangeReport {
    return this.voxel.markStale(dim, reason);
  }

  /** Forward accepted-change reports to an active verifier/executor. */
  subscribeChanges(
    sink: ChangeReportSink,
    options?: ChangeReportSubscriptionOptions,
  ): () => void {
    return this.voxel.subscribeChanges(sink, options);
  }

  /** `null` means the Section is not resident/allocated — it is never empty air. */
  sectionAt(dim: string, x: number, y: number, z: number): Section | null {
    this.assertDim(dim, 'sectionAt');
    return this.voxel.sectionAt(dim, x, y, z);
  }

  markTraversed(dim: string, pos: Vec3Like): void {
    this.assertDim(dim, 'markTraversed');
    assertFinitePoint(pos, 'markTraversed');
    this.voxel.markTraversed(dim, copyPoint(pos));
  }

  markModified(dim: string, pos: Vec3Like, actionId: string): void {
    this.assertDim(dim, 'markModified');
    assertFinitePoint(pos, 'markModified');
    if (typeof actionId !== 'string' || actionId.length === 0) {
      throw new Error('markModified: actionId must be a non-empty string');
    }
    this.voxel.markModified(dim, copyPoint(pos), actionId);
  }

  // --- Paths (historical geometry) ---

  saveFragment(fragment: PathFragment): void {
    this.assertWorld(fragment.worldId, 'saveFragment');
    this.assertDim(fragment.dim, 'saveFragment');
    this.fragmentStore.saveFragment(fragment);
  }

  /**
   * Record measured continuous traversal evidence. The fragment must already
   * exist in this world/dimension; the same id with the same content is
   * idempotent, the same id with different content conflicts, and a full store
   * rejects the whole record. Saving evidence never marks the route as
   * currently passable, creates a fragment, or creates a topology edge.
   */
  addTraversal(evidence: TraversalEvidence): SaveResult {
    this.assertWorld(evidence.worldId, 'addTraversal');
    // The store owns its world/dim scope contract, so a cross-dimension record
    // is reported as `SpatialMemoryScopeError` here. Record shape, fragment
    // existence, idempotence, conflict and capacity stay in `FragmentStore`.
    const fragmentScope = this.fragmentStore.getFragmentScope(evidence.fragmentId);
    if (fragmentScope !== null && fragmentScope.dim !== evidence.dim) {
      throw new SpatialMemoryScopeError(
        `addTraversal: dim "${evidence.dim}" does not match fragment "${evidence.fragmentId}" dim "${fragmentScope.dim}"`,
      );
    }
    return this.fragmentStore.addTraversal(evidence);
  }

  forgetFragment(id: string): void {
    assertNonEmptyString(id, 'fragment id');
    this.fragmentStore.forgetFragment(id);
  }

  /** All matching fragments, following the store's bounded pages. Read-only. */
  fragments(dim?: string): PathFragment[] {
    if (dim !== undefined) this.assertDim(dim, 'fragments');
    return this.drainFragments(dim);
  }

  // --- Topology (places & connections) ---

  /**
   * Record an agent-named place at an exact position. The id is generated
   * deterministically from the label and is unique within the bound topology.
   */
  recordNode(label: string, pos: Vec3Like, tag?: LandmarkTag, options?: RecordNodeOptions): SpatialNode {
    const dim = options?.dim;
    if (typeof dim !== 'string' || dim.length === 0) {
      throw new Error('recordNode: options.dim is required');
    }
    this.assertDim(dim, 'recordNode');
    assertFinitePoint(pos, 'recordNode');
    const stored = this.topologyStore.recordNode(label, copyPoint(pos), tag, { ...options, dim });
    this.assertWorld(stored.worldId, 'recordNode');
    return stored;
  }

  /**
   * Insert a node, or accept an idempotent re-delivery. Same id with different
   * content throws: this method never silently overwrites recorded facts.
   */
  upsertNode(node: SpatialNode): void {
    this.assertWorld(node.worldId, 'upsertNode');
    this.assertDim(node.dim, 'upsertNode');
    this.topologyStore.saveNode(node);
  }

  /**
   * Record a directional connection. The `basis` is explicit when supplied;
   * otherwise evidence ids imply `traversed` and their absence means
   * `candidate`. `directed`/`modes`/`verifications` are not stored by the
   * topology layer (see docs).
   */
  upsertEdge(edge: SpatialEdgeRecord): void {
    assertNonEmptyString(edge.id, 'edge id');
    assertNonEmptyString(edge.from, 'edge from');
    assertNonEmptyString(edge.to, 'edge to');
    const citesEvidence = edge.evidenceIds !== undefined && edge.evidenceIds.length > 0;
    const basis = edge.basis ?? (citesEvidence ? 'traversed' : 'candidate');
    const resolved: TopologyEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      basis,
      // Pass through even for a candidate so TopologyStore rejects the
      // contradiction instead of this facade silently dropping evidence ids.
      evidenceIds: [...(edge.evidenceIds ?? [])],
    };
    if (edge.fragmentId !== undefined) resolved.fragmentId = edge.fragmentId;
    if (edge.source !== undefined) resolved.source = edge.source;
    this.topologyStore.saveEdge(resolved);
  }

  /** Deletes the matching directional edge records only; fragments/traversals stay. */
  dropEdge(from: string, to: string): void {
    assertNonEmptyString(from, 'edge from');
    assertNonEmptyString(to, 'edge to');
    for (const edge of this.drainEdges({ from, to })) {
      this.topologyStore.forgetEdge(edge.id);
    }
  }

  /**
   * Read-only topology projection. `directed` is always `true` because each
   * record supports `from → to` only (no reverse is implied); `modes` and
   * `verifications` are empty because `TopologyStore` does not store them.
   * Empty means "not represented", never "unsupported". Use `edgesDetailed`
   * for basis and evidence resolution.
   */
  graph(dim: string): { nodes: SpatialNode[]; edges: SpatialEdge[] } {
    this.assertDim(dim, 'graph');
    return {
      nodes: this.drainNodes(dim),
      edges: this.drainEdges({ dim }).map(toSpatialEdgeProjection),
    };
  }

  /** Recorded edges with `basis` and per-evidence resolution (read-only). */
  edgesDetailed(dim: string): EdgeView[] {
    this.assertDim(dim, 'edgesDetailed');
    return this.drainEdges({ dim });
  }

  portalEdges(): PortalEdgeView[] {
    return this.topologyStore.portalEdges();
  }

  // --- Node display / gone, edge verification, portal writes ---

  displayNodes(query: { dim?: string; namespace?: NodeSource; limit?: number; after?: string } = {}) {
    if (query.dim !== undefined) this.assertDim(query.dim, 'displayNodes');
    return this.topologyStore.displayNodes(query);
  }

  markGone(nodeId: string, evidence: GoneEvidence): void {
    this.topologyStore.markGone(nodeId, evidence);
  }

  goneNear(dim: string, pos: Vec3Like, radius = 3.5): SpatialNode[] {
    this.assertDim(dim, 'goneNear');
    assertFinitePoint(pos, 'goneNear');
    return this.topologyStore.goneNear(dim, pos, radius);
  }

  verifyEdge(id: string, verification: EdgeVerificationInput): void {
    this.topologyStore.verifyEdge(id, verification);
  }

  blockEdge(id: string, input: EdgeBlockInput): void {
    this.topologyStore.blockEdge(id, input);
  }

  clearEdgeBlock(id: string, direction?: EdgeDirection, mode?: Parameters<TopologyStore['clearEdgeBlock']>[2]): void {
    this.topologyStore.clearEdgeBlock(id, direction, mode);
  }

  edgeRuntime(id: string, options?: RuntimeQueryOptions): EdgeRuntimeView | null {
    return this.topologyStore.edgeRuntime(id, options);
  }

  savePortalEdge(edge: PortalEdgeInput, traversals: PortalTraversalEvidence[]): void {
    this.topologyStore.savePortalEdge(edge, traversals);
  }

  addPortalTraversal(edgeId: string, traversal: PortalTraversalEvidence): void {
    this.topologyStore.addPortalTraversal(edgeId, traversal);
  }

  // --- Routing & anchors (geometry memory, unverified against current terrain) ---

  /**
   * Historical recorded-topology route, or `null` when either endpoint has no
   * recorded node within `near` or no evidence-resolved connection was found.
   *
   * `hop`/`link` are legacy geometric-inference parameters. This composition
   * does not perform geometric inference, so passing either is rejected
   * explicitly rather than silently ignored.
   */
  route(
    dim: string,
    from: Vec3Like,
    to: Vec3Like,
    opts: { near?: number; hop?: number; link?: number } = {},
  ): Vec3Like[] | null {
    if (opts.hop !== undefined || opts.link !== undefined) {
      throw new SpatialMemoryUnsupportedError(
        'route',
        'recorded-topology routing has no hop/link geometric-inference parameters; only near endpoint snapping is supported',
      );
    }
    const inspection = this.routeInspection(dim, from, to, { near: opts.near });
    return inspection.status === 'FOUND' ? inspection.points.map(copyPoint) : null;
  }

  /** Detailed historical route read, including why a route was not found. */
  routeInspection(
    dim: string,
    from: Vec3Like,
    to: Vec3Like,
    opts: { near?: number } = {},
  ): HistoricalRouteInspection {
    this.assertDim(dim, 'routeInspection');
    assertFinitePoint(from, 'routeInspection from');
    assertFinitePoint(to, 'routeInspection to');
    const near = resolveNear(opts.near, DEFAULT_ENDPOINT_NEAR, 'routeInspection');
    const fromNode = this.findNodeNear(dim, from, near);
    const toNode = this.findNodeNear(dim, to, near);
    const base = {
      worldId: this.worldId,
      dim,
      from: copyPoint(from),
      to: copyPoint(to),
      near,
      historicalGeometry: true as const,
      executable: false as const,
      currentPassability: 'UNKNOWN' as const,
    };

    if (fromNode === null || toNode === null) {
      const missing =
        fromNode === null && toNode === null
          ? 'neither endpoint'
          : fromNode === null
            ? 'the from endpoint'
            : 'the to endpoint';
      return {
        ...base,
        status: 'ENDPOINT_NOT_RECORDED',
        fromNodeId: fromNode?.id ?? null,
        toNodeId: toNode?.id ?? null,
        points: [],
        nodeIds: [],
        edgeIds: [],
        segments: [],
        gaps: [],
        stats: null,
        diagnostics: [],
        message: `${missing} has no recorded node within ${near} block(s) in ${dim}; no route was queried`,
      };
    }

    const result = this.topologyStore.route(fromNode.id, toNode.id);
    const points = result.status === 'FOUND' ? this.pointsForNodeIds(result.nodeIds) : [];
    return {
      ...base,
      status: result.status,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      points,
      nodeIds: result.nodeIds,
      edgeIds: result.edgeIds,
      segments: result.segments,
      gaps: result.gaps,
      stats: result.stats,
      diagnostics: result.diagnostics,
      exhausted: result.exhausted,
      message: routeInspectionMessage(result.status, dim, fromNode.id, toNode.id),
    };
  }

  /**
   * Highest reachable recorded node by exact `y`, as a point candidate. It is
   * not a surface/opening guarantee and never falls back to the whole network.
   */
  surfaceAnchor(dim: string, here: Vec3Like, options: AnchorQueryOptions = {}): AnchorResult | null {
    this.assertDim(dim, 'surfaceAnchor');
    assertFinitePoint(here, 'surfaceAnchor');
    return this.topologyStore.surfaceAnchor(dim, here, options);
  }

  /**
   * Lowest reachable recorded node by exact `y`. Without `here` (or with no
   * recorded node within `near`) it returns `null` instead of the legacy
   * whole-network fallback, which did not establish a connection.
   */
  deepestAnchor(dim: string, here: Vec3Like, options: AnchorQueryOptions = {}): AnchorResult | null {
    this.assertDim(dim, 'deepestAnchor');
    assertFinitePoint(here, 'deepestAnchor');
    return this.topologyStore.deepestAnchor(dim, here, options);
  }

  /** Explicit connectivity components over recorded evidence (never proximity). */
  components(dim: string): ComponentReport {
    this.assertDim(dim, 'components');
    return this.topologyStore.components(dim);
  }

  /** Current-passable pieces of one fragment; the fragment history is kept. */
  segments(fragmentId: string): FragmentSegmentsResult {
    return this.topologyStore.segments(fragmentId);
  }

  /** Merge two fragments only with actual traversal evidence connecting them. */
  mergeFragments(aId: string, bId: string, evidenceId: string): void {
    this.topologyStore.mergeFragments(aId, bId, evidenceId);
  }

  /**
   * Fragment connected components in `dim`. Uses recorded `links` when present
   * and falls back to consecutive-polyline inference otherwise; cross-record
   * proximity within `FRAGMENTATION_LINK_DISTANCE` is a legacy geometric
   * heuristic, not evidence of current passability.
   */
  fragmentation(dim: string): FragmentationResult {
    this.assertDim(dim, 'fragmentation');
    return this.topologyStore.fragmentation(dim);
  }

  /** Legacy geometric projection retained for callers that need it; not evidence. */
  private fragmentationGeometric(dim: string): {
    records: number;
    points: number;
    components: number;
    pieces: { points: number; records: number }[];
  } {
    this.assertDim(dim, 'fragmentation');
    const records = this.drainFragments(dim);
    const nodes: Vec3Like[] = [];
    const owner: number[] = [];
    const byCoordinate = new Map<string, number>();
    const adjacency = new Map<number, Set<number>>();

    const indexOf = (point: Vec3Like, recordIndex: number): number => {
      const key = `${point.x},${point.y},${point.z}`;
      const existing = byCoordinate.get(key);
      if (existing !== undefined) return existing;
      const index = nodes.length;
      nodes.push(copyPoint(point));
      owner.push(recordIndex);
      byCoordinate.set(key, index);
      return index;
    };
    const connect = (a: number, b: number): void => {
      if (a === b) return;
      const fromSet = adjacency.get(a) ?? new Set<number>();
      fromSet.add(b);
      adjacency.set(a, fromSet);
      const toSet = adjacency.get(b) ?? new Set<number>();
      toSet.add(a);
      adjacency.set(b, toSet);
    };

    records.forEach((record, recordIndex) => {
      if (record.links !== undefined && record.links.length > 0) {
        for (const link of record.links) {
          connect(indexOf(link.a, recordIndex), indexOf(link.b, recordIndex));
        }
        return;
      }
      let previous = -1;
      for (const point of record.polyline) {
        const index = indexOf(point, recordIndex);
        if (previous >= 0) {
          const previousPoint = nodes[previous];
          if (
            previousPoint !== undefined &&
            distance3(previousPoint, point) <= FRAGMENTATION_HOP_DISTANCE
          ) {
            connect(previous, index);
          }
        }
        previous = index;
      }
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a === undefined || b === undefined) continue;
        if (owner[i] !== owner[j] && distance3(a, b) <= FRAGMENTATION_LINK_DISTANCE) {
          connect(i, j);
        }
      }
    }

    const component = new Array<number>(nodes.length).fill(-1);
    const pieces: { points: number; records: number }[] = [];
    for (let start = 0; start < nodes.length; start++) {
      if (component[start] !== -1) continue;
      const componentId = pieces.length;
      const stack = [start];
      component[start] = componentId;
      const recordsInPiece = new Set<number>();
      let points = 0;
      while (stack.length > 0) {
        const index = stack.pop() as number;
        points += 1;
        const recordIndex = owner[index];
        if (recordIndex !== undefined) recordsInPiece.add(recordIndex);
        for (const neighbour of adjacency.get(index) ?? []) {
          if (component[neighbour] === -1) {
            component[neighbour] = componentId;
            stack.push(neighbour);
          }
        }
      }
      pieces.push({ points, records: recordsInPiece.size });
    }
    pieces.sort((a, b) => b.points - a.points);

    return { records: records.length, points: nodes.length, components: pieces.length, pieces };
  }

  // --- Frontier (candidates only — never selects a target) ---

  /**
   * Project the bounded frontier candidates already present in a
   * caller-supplied walk-search snapshot. Without such a snapshot this throws
   * an explicit unsupported error; it never scans the map itself.
   */
  frontierCandidates(dim: string, here: Vec3Like): Frontier[] {
    this.assertDim(dim, 'frontierCandidates');
    assertFinitePoint(here, 'frontierCandidates');
    const resolved = this.resolveFrontierSnapshot(dim, here);
    if (!resolved.available) {
      throw new SpatialMemoryUnsupportedError('frontierCandidates', resolved.reason);
    }
    return projectFrontierCandidates(resolved.snapshot).candidates.map(toFrontier);
  }

  /** Same source as `frontierCandidates`, with `unavailable` as a value. */
  frontierInspection(dim: string, here: Vec3Like): FrontierInspection {
    this.assertDim(dim, 'frontierInspection');
    assertFinitePoint(here, 'frontierInspection');
    const resolved = this.resolveFrontierSnapshot(dim, here);
    if (!resolved.available) {
      return {
        status: 'unavailable',
        worldId: this.worldId,
        dim,
        here: copyPoint(here),
        reason: resolved.reason,
      };
    }
    return {
      status: 'available',
      result: projectFrontierCandidates(resolved.snapshot),
      historicalConnection: 'unknown',
      note: 'Candidates come from a caller-supplied WalkSearchSnapshot. The Frontier projection cannot express an unknown historical connection, so it reports false for "not established" (never "disproved").',
    };
  }

  /** Read-only `inspect_route` projection of an existing walk-search snapshot. */
  inspectRoute(snapshot: WalkSearchSnapshot): RouteInspection {
    this.assertWorld(snapshot.worldId, 'inspectRoute');
    this.assertDim(snapshot.dim, 'inspectRoute');
    return projectRouteInspection(snapshot);
  }

  // --- Read-only query projection (contract §5) ---

  /** Read-only projection over the composed stores; never loads, refreshes, or writes. */
  query(request: SpatialQueryRequest): SpatialQueryResult {
    return this.queryPort.query(request);
  }

  /** The narrow, mutation-free view the query port is allowed to see. */
  private buildQuerySources(): SpatialQuerySources {
    return {
      worldId: this.worldId,
      currentSessionId: () => this.voxel.sessionId,
      cellAt: (dim, x, y, z) => this.voxel.cellAt(dim, x, y, z),
      residencyAt: (dim, x, y, z) => {
        const { cx, cz, sy } = blockToSection(x, y, z);
        return this.voxel.sectionResidency({ worldId: this.worldId, dim, cx, cz, sy }).residency;
      },
      fragments: {
        fragments: (query) => this.fragmentStore.fragments(query),
        traversals: (query) => this.fragmentStore.traversals(query),
        getFragment: (id) => this.fragmentStore.getFragment(id),
      },
      topology: {
        nodes: (query) => this.topologyStore.nodes(query),
        edges: (query) => this.topologyStore.edges(query),
        portalEdges: () => this.topologyStore.portalEdges(),
      },
      history: {
        routeInspection: (dim, from, to, options) =>
          this.routeInspection(dim, from, to, options),
        surfaceAnchor: (dim, here, options) => this.surfaceAnchor(dim, here, options),
        deepestAnchor: (dim, here, options) => this.deepestAnchor(dim, here, options),
        components: (dim) => this.components(dim),
        segments: (fragmentId) => this.segments(fragmentId),
      },
      snapshot: () => this.snapshot(),
      memoryCapabilities: () => this.describeCapabilities(),
    };
  }

  // --- Capability and snapshot reports ---

  describeCapabilities(): SpatialMemoryCapabilities {
    const hasFrontierSource = this.frontierSource !== undefined;
    return {
      observe: { available: true, reason: 'Use subscribeChanges for its report; observe() itself returns void.' },
      observeBatch: {
        available: true,
        reason:
          'Whole batch is scope-validated before any write; returns the localized BatchChangeReport. Gaps are diagnostics, never cells or air.',
      },
      beginSession: {
        available: true,
        reason:
          'Prior-session evidence becomes STALE and is reported; original evidence times and history are kept.',
      },
      markStale: {
        available: true,
        reason:
          'Freshness only: affected cells become STALE and are reported; fragments and traversal history are not deleted.',
      },
      subscribeChanges: {
        available: true,
        reason:
          'Synchronous report forwarding from the same VoxelMap that accepted the write; empty reports are not delivered, and subscriber failures are reported as ChangeReportDeliveryError with committed:true.',
      },
      sectionAt: {
        available: true,
        reason: 'null means the Section is not resident or was never allocated; it is not empty air.',
      },
      query: {
        available: true,
        reason:
          'Read-only projection over the composed stores. containerAnchors requires a host-injected isContainer classifier; containerContents always returns host_ledger/unsupported.',
      },
      markTraversed: {
        available: true,
        reason: 'Measured stance history only; never inferred from proximity or requests.',
      },
      markModified: {
        available: true,
        reason: 'Requires a confirmed actionId; block-content revision is not advanced.',
      },
      saveFragment: { available: true },
      addTraversal: {
        available: true,
        reason:
          'Requires an existing same-world/same-dim fragment; idempotent for identical ids, conflicts on different content, and rejects a full store. History evidence only, never current passability.',
      },
      forgetFragment: { available: true },
      fragments: { available: true },
      recordNode: {
        available: true,
        reason: 'Creates an agent-source place node at an exact position with a deterministic id.',
      },
      upsertNode: {
        available: true,
        reason:
          'Insert or idempotent re-delivery only; the same id with different content throws instead of overwriting.',
      },
      upsertEdge: {
        available: true,
        reason:
          'TopologyStore stores id/from/to/type/basis/evidence. SpatialEdge.directed/modes/verifications are not stored; traversed edges need evidenceIds.',
      },
      dropEdge: {
        available: true,
        reason: 'Deletes matching directional edge records only; fragments and traversal evidence remain.',
      },
      graph: {
        available: true,
        reason:
          'Recorded topology projection. directed=true means only from→to is supported, not that the reverse was disproved; modes/verifications are empty because they are not represented here.',
      },
      displayNodes: {
        available: true,
        reason: 'Separate display namespace: program points never share the agent default surface.',
      },
      markGone: {
        available: true,
        reason: 'Requires real observation evidence; the node record and history are kept.',
      },
      goneNear: {
        available: true,
        reason: 'Gone anchors near a position, nearest first; history is not deleted.',
      },
      verifyEdge: {
        available: true,
        reason: 'Per-direction/mode verification; BLOCKED must go through blockEdge with evidence.',
      },
      blockEdge: {
        available: true,
        reason: 'Blocks one direction/mode with obstacle evidence; never deletes a fragment.',
      },
      clearEdgeBlock: {
        available: true,
        reason: 'Replaces a blockage with UNKNOWN; never restores OPEN without fresh evidence.',
      },
      edgeRuntime: {
        available: true,
        reason: 'Direction/mode separated current status; unverified or expired is never OPEN.',
      },
      savePortalEdge: {
        available: true,
        reason: 'Portal connectivity is stored separately from the walk graph with raw traversals.',
      },
      addPortalTraversal: {
        available: true,
        reason: 'Appends raw return/outbound evidence; returnVerified stays derived.',
      },
      components: {
        available: true,
        reason: 'Node components over evidence-backed edges with local invalidation.',
      },
      segments: {
        available: true,
        reason: 'Current-passable pieces from edge verification; fragment history is kept.',
      },
      mergeFragments: {
        available: true,
        reason: 'Requires traversal evidence that actually connects both fragments.',
      },
      portalEdges: {
        available: true,
        reason: 'Separate portal graph; never mixed into walk route/adjacency.',
      },
      route: {
        available: true,
        reason:
          'Recorded-topology geometry only: near endpoint snapping, no hop/link inference, not executable, current passability UNKNOWN.',
      },
      surfaceAnchor: {
        available: true,
        reason:
          'Highest reachable recorded exact node by y; not a surface/opening guarantee and no whole-network fallback.',
      },
      deepestAnchor: {
        available: true,
        reason:
          'Lowest reachable recorded exact node by y; null when here is absent or too far from the recorded network.',
      },
      fragmentation: {
        available: true,
        reason:
          'Geometric connected components over recorded fragments using legacy link/hop thresholds; not current passability.',
      },
      frontierCandidates: hasFrontierSource
        ? {
            available: true,
            reason:
              'Projects only a caller-supplied WalkSearchSnapshot; never starts a search. historicalConnection is `unknown` when no history lookup was made.',
          }
        : {
            available: false,
            reason:
              'No caller-supplied WalkSearchSnapshot provider was injected; this store never runs its own scan.',
          },
    };
  }

  /** Read-only runtime summary. */
  snapshot(): SpatialMemoryStoreSnapshot {
    const residency = this.voxel.residentSize();
    const pins = this.voxel.pinState();
    return {
      worldId: this.worldId,
      voxel: {
        saveRevision: this.voxel.saveRevision,
        residentSections: residency.sections,
        residentBytes: residency.bytes,
        pinLeases: pins.leases,
        pinnedSections: pins.pinnedSections,
      },
      fragments: {
        revision: this.fragmentStore.revision,
        total: this.fragmentStore.fragments({ limit: 1 }).total,
      },
      topology: {
        revision: this.topologyStore.revision,
        nodes: this.topologyStore.nodes({ limit: 1 }).total,
        edges: this.topologyStore.edges({ limit: 1 }).total,
      },
      capabilities: this.describeCapabilities(),
    };
  }

  // --- internals ---

  private get markers(): VoxelMap & OptionalTraversalMarkers {
    return this.voxel as VoxelMap & OptionalTraversalMarkers;
  }

  private assertWorld(worldId: string, method: string): void {
    if (worldId !== this.worldId) {
      throw new SpatialMemoryScopeError(
        `${method}: worldId "${worldId}" does not match this store's world "${this.worldId}"`,
      );
    }
  }

  private assertDim(dim: string, method: string): void {
    if (typeof dim !== 'string' || dim.length === 0) {
      throw new Error(`${method}: dim must be a non-empty string`);
    }
  }

  private nextNodeId(label: string): string {
    const slug =
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'place';
    let id = `agent:${slug}`;
    let suffix = 1;
    while (this.topologyStore.getNode(id) !== null) {
      suffix += 1;
      id = `agent:${slug}:${suffix}`;
    }
    return id;
  }

  private drainFragments(dim: string | undefined): PathFragment[] {
    const items: PathFragment[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.fragmentStore.fragments(
        after === undefined ? (dim === undefined ? {} : { dim }) : { ...(dim === undefined ? {} : { dim }), after },
      );
      items.push(...page.items);
      if (page.nextAfter === undefined) return items;
      after = page.nextAfter;
    }
  }

  private drainNodes(dim: string): SpatialNode[] {
    const items: SpatialNode[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.topologyStore.nodes(after === undefined ? { dim } : { dim, after });
      items.push(...page.items);
      if (page.nextAfter === undefined) return items;
      after = page.nextAfter;
    }
  }

  private drainEdges(query: { dim?: string; from?: string; to?: string }): EdgeView[] {
    const items: EdgeView[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.topologyStore.edges(after === undefined ? query : { ...query, after });
      items.push(...page.items);
      if (page.nextAfter === undefined) return items;
      after = page.nextAfter;
    }
  }

  private findNodeNear(dim: string, target: Vec3Like, near: number): SpatialNode | null {
    let best: SpatialNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of this.drainNodes(dim)) {
      if (node.location.kind !== 'exact') continue;
      const distance = distance3(node.location.pos, target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    return bestDistance <= near ? best : null;
  }

  private pointsForNodeIds(nodeIds: readonly string[]): Vec3Like[] {
    return nodeIds.flatMap((id) => {
      const node = this.topologyStore.getNode(id);
      return node !== null && node.location.kind === 'exact' ? [copyPoint(node.location.pos)] : [];
    });
  }

  private anchorPoint(
    dim: string,
    here: Vec3Like,
    order: AnchorOrder,
    near: number,
  ): Vec3Like | null {
    const start = this.findNodeNear(dim, here, near);
    if (start === null) return null;
    const result = this.topologyStore.historicalAnchorCandidates(start.id, {
      order,
      includeStart: true,
      limit: ANCHOR_QUERY_LIMIT,
    });
    const exact = result.items.find((item) => item.node.location.kind === 'exact');
    if (exact === undefined || exact.node.location.kind !== 'exact') return null;
    return copyPoint(exact.node.location.pos);
  }

  private resolveFrontierSnapshot(
    dim: string,
    here: Vec3Like,
  ): { available: true; snapshot: WalkSearchSnapshot } | { available: false; reason: string } {
    const provider = this.frontierSource;
    if (provider === undefined) {
      return {
        available: false,
        reason:
          'no caller-supplied WalkSearchSnapshot provider was injected; this store never runs its own scan',
      };
    }
    const snapshot = provider(dim, copyPoint(here));
    if (snapshot === null) {
      return {
        available: false,
        reason: `the caller-supplied provider has no WalkSearchSnapshot for dim "${dim}" at this position`,
      };
    }
    if (snapshot.worldId !== this.worldId) {
      throw new SpatialMemoryScopeError(
        `frontier snapshot worldId "${snapshot.worldId}" does not match this store's world "${this.worldId}"`,
      );
    }
    if (snapshot.dim !== dim) {
      throw new SpatialMemoryScopeError(
        `frontier snapshot dim "${snapshot.dim}" does not match the requested dim "${dim}"`,
      );
    }
    return { available: true, snapshot };
  }
}

function assertSameWorld(part: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SpatialMemoryScopeError(
      `${part} worldId "${actual}" does not match the requested world "${expected}"`,
    );
  }
}

function assertNonEmptyString(value: string, what: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
}

function assertFinitePoint(point: Vec3Like, what: string): void {
  if (
    point === null ||
    typeof point !== 'object' ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new Error(`${what}: position must have finite x, y and z`);
  }
}

function copyPoint(point: Vec3Like): Vec3Like {
  return { x: point.x, y: point.y, z: point.z };
}

function distance3(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function resolveNear(value: number | undefined, fallback: number, method: string): number {
  const near = value ?? fallback;
  if (!Number.isFinite(near) || near < 0) {
    throw new Error(`${method}: near must be a finite non-negative number`);
  }
  return near;
}

function routeInspectionMessage(
  status: RouteQueryStatus,
  dim: string,
  fromNodeId: string,
  toNodeId: string,
): string {
  switch (status) {
    case 'FOUND':
      return `Recorded historical connection sequence from "${fromNodeId}" to "${toNodeId}" in ${dim}; it is geometry memory, not proof of current passability.`;
    case 'NO_RECORDED_ROUTE':
      return `No recorded evidence-resolved connection from "${fromNodeId}" to "${toNodeId}" in ${dim}.`;
    case 'INSUFFICIENT_EVIDENCE':
      return `A recorded search from "${fromNodeId}" to "${toNodeId}" in ${dim} hit evidence gaps (candidate, missing, mismatched or mode-unknown edges).`;
    case 'BUDGET_EXHAUSTED':
      return `The bounded recorded search from "${fromNodeId}" to "${toNodeId}" in ${dim} exhausted its query budget; this is not proof that no route was recorded.`;
  }
}

function toSpatialEdgeProjection(view: EdgeView): SpatialEdge {
  const edge: SpatialEdge = {
    id: view.id,
    from: view.from,
    to: view.to,
    type: view.type,
    // Each topology record supports from→to only; no reverse relation is implied.
    directed: true,
    // Not represented in TopologyStore; empty is not evidence of unsupported modes.
    modes: [],
    // Current verification is not stored on a topology edge.
    verifications: [],
  };
  if (view.fragmentId !== undefined) edge.fragmentId = view.fragmentId;
  return edge;
}

function toFrontier(candidate: FrontierCandidateView): Frontier {
  return {
    pos: copyPoint(candidate.pos),
    basis: candidate.basis,
    // The stance this boundary is next to was OPEN-validated; the boundary
    // point itself and the gap beyond it are not claimed reachable.
    reachability: candidate.reachability,
    // No history lookup is wired here: report unknown, never a fabricated false.
    historicalConnection: 'unknown',
  };
}
