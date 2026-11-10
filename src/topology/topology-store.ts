/**
 * In-memory explicit topology facts store (design §5, phase 4B).
 *
 * `TopologyStore` keeps the *explicit* topology the caller recorded: which
 * spatial nodes exist, which directional connections are recorded between them,
 * and which historical traversal evidence each traversed connection cites. It
 * answers "what nodes and connections were explicitly recorded, and do those
 * connections' evidence references still resolve from the authoritative history"
 * — never "can I walk this right now".
 *
 * Two connection kinds are distinguished in every query result:
 *
 * - `candidate` — an explicit "to-verify" relation the caller submitted. It does
 *   not prove a traversal happened and does not prove it is passable now.
 * - `traversed` — a directed historical connection backed by a concrete
 *   `TraversalEvidence` record whose endpoints match the edge's from→to exactly.
 *
 * Edges are always directional: A→B and B→A are independent records, and saving
 * A→B never auto-generates B→A. Only non-`PORTAL`, same-world, same-dimension,
 * exact-endpoint connections are supported; regions can be stored and queried as
 * nodes but never as edge endpoints, and `PORTAL`/cross-dimension connections are
 * rejected as unsupported in this phase.
 *
 * `TopologyStore` reads evidence through a narrow read-only history interface
 * (`worldId`, `getFragment`, `getTraversal`) satisfied directly by `FragmentStore`.
 * It never reaches into the history store's private state and keeps no second
 * writable copy of evidence — it only keeps the evidence *id* plus an immutable
 * binding snapshot used for matching and display.
 */

import type {
  ConnectionType,
  EdgeDependency,
  EdgeDirection,
  EdgeVerification,
  GoneEvidence,
  LandmarkTag,
  NodeKind,
  NodeSource,
  SpatialNode,
} from './graph.js';
import type { JsonObject } from '../json-value.js';
import {
  cloneJsonObject,
  DEFAULT_JSON_LIMITS,
  jsonObjectByteLength,
  jsonObjectsEqual,
  snapshotJsonObject,
  type JsonLimits,
} from '../json-value.js';
import type { PathFragment, TraversalEvidence } from './path-fragment.js';
import {
  assertValidMode,
  cloneTraversalEvidence,
  jsonEscapedByteLength,
  traversalEvidenceEqual,
} from './path-fragment.js';
import type { FragmentScope, SaveResult } from './fragment-store.js';
import { estimateTraversalBytes, snapshotEvidence, traversalLowerBound } from './fragment-store.js';
import type { ObstacleEvidence } from '../traversability/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type { EdgeRuntimeView, EdgeVerificationInput } from './edge-runtime.js';
import {
  cloneEdgeVerification,
  directionUsability,
  edgeVerificationsEqual,
  resolveEdgeDirected,
  runtimeView,
  snapshotEdgeModes,
  snapshotEdgeVerification,
  withVerification,
} from './edge-runtime.js';
import type {
  FragmentMerge,
  FragmentSegment,
  FragmentationResult,
} from './connectivity.js';
import {
  computeFragmentation,
  fragmentPointKeys,
  pointKey,
  splitPolyline,
  traversalConnectsFragments,
} from './connectivity.js';
import type {
  PortalEdgeInput,
  PortalEdgeView,
  PortalTraversalEvidence,
} from './portal.js';
import {
  clonePortalTraversal,
  portalReturnVerified,
  portalTraversalsEqual,
  snapshotPortalTraversal,
} from './portal.js';

/** How a topology edge is justified. */
export type EdgeBasis = 'candidate' | 'traversed';

/** Whether a still-present evidence record matches what an edge was bound to. */
export type ReferenceStatus = 'resolved' | 'missing' | 'mismatch';

/**
 * A directed, explicitly-recorded connection between two node ids. `basis`
 * separates a pending candidate relation from an evidence-backed traversed one;
 * `evidenceIds` (traversed only) cite the `TraversalEvidence` records that back
 * the from→to relation. Current traversability is deliberately absent here.
 */
export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  /** Provenance association only — never a substitute for traversal evidence. */
  fragmentId?: string;
  basis: EdgeBasis;
  /** Caller's provenance note (mainly for `candidate` edges). */
  source?: string;
  /** Traversal evidence ids backing a `traversed` edge; empty for `candidate`. */
  evidenceIds: string[];
  /**
   * `true` (or absent, for legacy records) = only from→to. `false` = both
   * directions have their own evidence and their own verification.
   */
  directed?: boolean;
  /** Candidate modes supported by evidence; empty/absent = no mode filter. */
  modes?: MoveMode[];
  /** Per-direction, per-mode current verification (derived state, never history). */
  verifications?: EdgeVerification[];
}

/** Resolution of one evidence reference, re-read from the authoritative history. */
export interface EdgeReference {
  evidenceId: string;
  status: ReferenceStatus;
  /** The evidence snapshot the edge was bound to (historical summary, never an authority). */
  snapshot: TraversalEvidence | null;
  /** The authoritative record as read now, when it still exists. */
  current: TraversalEvidence | null;
}

/** Read projection of an edge: the record plus per-reference resolution. */
export interface EdgeView extends TopologyEdge {
  directed: boolean;
  modes: MoveMode[];
  verifications: EdgeVerification[];
  /** Per-evidence resolution; empty for `candidate` edges. */
  references: EdgeReference[];
  /** Aggregate resolution for `traversed` edges, or `null` for `candidate` (nothing to resolve). */
  resolution: ReferenceStatus | null;
  /** Direction/mode separated current status (never implies current passability for unverified modes). */
  runtime: EdgeRuntimeView;
}

/**
 * Narrow read-only history surface `TopologyStore` consumes. `FragmentStore`
 * already satisfies it; the store never imports its private state.
 */
export interface TopologyHistorySource {
  readonly worldId: string;
  getFragment(id: string): PathFragment | null;
  getTraversal(id: string): TraversalEvidence | null;
  /**
   * Optional O(1) scope read (id/worldId/dim only, no geometry copy). When
   * absent, the bounded queries fall back to `getFragment(id)` and read only the
   * scope fields.
   */
  getFragmentScope?(id: string): FragmentScope | null;
  /**
   * Optional paginated fragment listing used by `fragmentation`/`segments`.
   * `FragmentStore.fragments` satisfies this signature. Sources without it can
   * still answer node/edge queries; connectivity queries then report clearly.
   */
  listFragments?(query?: { dim?: string; limit?: number; after?: string }): {
    items: PathFragment[];
    total: number;
    nextAfter?: string;
  };
  /** Optional traversal listing used by `fragmentation` to add actual link evidence. */
  listTraversals?(query?: { dim?: string; limit?: number; after?: string }): {
    items: TraversalEvidence[];
    total: number;
    nextAfter?: string;
  };
}

/** Capacity limits. These are implementation capacities, not game rules. */
export interface TopologyStoreOptions {
  /** Maximum `agent`-source nodes. Defaults to 10000. */
  maxAgentNodes?: number;
  /** Maximum `program`-source nodes. Defaults to 10000. */
  maxProgramNodes?: number;
  /** Maximum edges retained. Defaults to 20000. */
  maxEdges?: number;
  /** Maximum traversal evidence references one edge may cite. Defaults to 8. */
  maxEdgeEvidenceRefs?: number;
  /** Maximum items returned by one query page. Defaults to 100. */
  maxQueryBatch?: number;
  /** Ceiling for the per-query `maxNodes` budget. Defaults to 1000. */
  maxQueryNodes?: number;
  /** Ceiling for the per-query `maxEdges` budget. Defaults to 10000. */
  maxQueryEdges?: number;
  /** Ceiling for the per-query `maxHistoryReads` budget. Defaults to 1000. */
  maxQueryHistoryReads?: number;
  /** Ceiling for the per-query `maxDiagnostics` budget. Defaults to 100. */
  maxQueryDiagnostics?: number;
  /** Maximum portal edges retained. Defaults to 1000. */
  maxPortalEdges?: number;
  /** Maximum raw traversals retained per portal edge. Defaults to 32. */
  maxPortalTraversalsPerEdge?: number;
  /** Maximum explicit fragment merges retained. Defaults to 1000. */
  maxFragmentMerges?: number;
  /** Maximum serialized bytes of opaque metadata on one node. Defaults to 16 KiB. */
  maxMetadataBytes?: number;
  /**
   * Clock used for verification freshness. Defaults to `Date.now`. Tests and
   * replay inject a fixed clock; stored timestamps are never rewritten.
   */
  now?: () => number;
}

/** Paginated read filter over nodes. All fields optional and combined by AND. */
export interface NodeQuery {
  dim?: string;
  source?: NodeSource;
  tag?: LandmarkTag;
  label?: string;
  /** Exclusive cursor: only ids sorting after this are returned. */
  after?: string;
  limit?: number;
}

export interface NodePage {
  items: SpatialNode[];
  total: number;
  nextAfter?: string;
}

/** Paginated read filter over edges. */
export interface EdgeQuery {
  dim?: string;
  from?: string;
  to?: string;
  type?: ConnectionType;
  basis?: EdgeBasis;
  after?: string;
  limit?: number;
}

export interface EdgePage {
  items: EdgeView[];
  total: number;
  nextAfter?: string;
}

// --- runtime edge verification (design §5) ---

/** Block one direction+mode with concrete obstacle evidence. Never deletes history. */
export interface EdgeBlockInput {
  /** Defaults to `forward`; reverse of a directed edge is rejected. */
  direction?: EdgeDirection;
  mode: MoveMode;
  /** Required: collision/contact/block evidence for the blockage. */
  blockedAt: ObstacleEvidence;
  reason?: string;
  hazards?: EdgeVerification['hazards'];
  dependencies?: EdgeDependency[];
  contextKey?: string;
  sessionId?: string;
  computedAt: number;
  validUntil: number;
}

/** Options for `edgeRuntime` and runtime-clamped read paths. */
export interface RuntimeQueryOptions {
  /**
   * Clock override for freshness (milliseconds). Absent uses the store clock.
   * This never rewrites stored times; it only selects the cutoff.
   */
  now?: number;
}

/** Options for `recordNode`. `dim` is required; the other fields are optional provenance. */
export interface RecordNodeOptions {
  dim: string;
  kind?: NodeKind;
  /** Caller-supplied stable id; when absent a deterministic agent id is used. */
  id?: string;
  observedAt?: number;
  externalRef?: string;
}

/** Runtime anchor result. Region nodes are never returned as exact interaction targets. */
export interface AnchorResult {
  nodeId: string;
  pos: Vec3Like;
  y: number;
  precision: 'exact';
  source: NodeSource;
  observedAt?: number;
  externalRef?: string;
  /** Hops from the nearest node to `here` in the reachable component. */
  hops: number;
  componentSize: number;
  /** Region nodes in the component, excluded because they are not exact targets. */
  excludedRegionNodes: number;
  startNodeId: string;
}

/** Options for surface/deepest anchor queries. */
export interface AnchorQueryOptions extends RuntimeQueryOptions {
  /** Selection radius for mapping `here` to an exact node. Defaults to 3.5; never creates an edge. */
  near?: number;
}

/** Node-level connected components for one dimension. */
export interface ComponentReport {
  components: number;
  /** Node ids by component, sorted for determinism. */
  groups: string[][];
  /** Node id → component index. */
  byNode: Map<string, number>;
  /**
   * Nodes recomputed by this call. Unaffected components reuse the cache, so this
   * is not a full-graph recomputation claim.
   */
  recomputedNodes: number;
}

/** Derived current-passable segments of one historical fragment. */
export interface FragmentSegmentsResult {
  fragmentId: string;
  segments: FragmentSegment[];
  blockedEdgeIds: string[];
  cuts: Vec3Like[];
  totalPoints: number;
}

// --- bounded historical graph queries (phase 4C) ---

/** Finite per-query work budgets. Zero is honored literally, never defaulted. */
export interface QueryBudget {
  /** Distinct node metadata reads (cache misses), including start and target. */
  maxNodes?: number;
  /** Incident edges inspected, including ones screened out by direction/condition. */
  maxEdges?: number;
  /** Actual history read calls (traversal + fragment scope). */
  maxHistoryReads?: number;
  /** Detailed diagnostics retained (truncation does not stop the search). */
  maxDiagnostics?: number;
}

/** Options shared by the bounded reachability and route queries. */
export interface TopologyQueryOptions extends QueryBudget, RuntimeQueryOptions {
  /** Optional movement-mode filter; absent means "do not filter by mode". */
  mode?: MoveMode;
}

/** Options for a bounded adjacency read (edge budget only). */
export interface AdjacencyOptions {
  maxEdges?: number;
  /**
   * Include directions with an explicit blocked/stale/unsupported verification.
   * Defaults to false: blocked directions are excluded, matching routing.
   */
  includeBlocked?: boolean;
  /** Clock override for verification freshness. */
  now?: number;
}

/** Which budget stopped a bounded search before it finished. */
export type QueryBudgetKey = 'maxNodes' | 'maxEdges' | 'maxHistoryReads';

/**
 * The kinds of evidence gap a bounded search can observe on its frontier.
 * `blocked` and `stale` come from runtime verification; `unsupported` is a
 * structural direction/mode constraint, not a world observation.
 */
export type SearchGapKind =
  | 'candidate'
  | 'missing'
  | 'mismatch'
  | 'mode_unknown'
  | 'blocked'
  | 'stale'
  | 'unsupported';

/** A bounded description of one evidence gap encountered during a search. */
export interface SearchDiagnostic {
  kind: SearchGapKind;
  edgeId: string;
  from: string;
  to: string;
  /** Relevant evidence ids for `missing`/`mismatch`/`mode_unknown` gaps. */
  evidenceIds?: string[];
}

/** Work actually performed by one bounded query, with each counter defined. */
export interface QueryStats {
  /** Distinct node metadata reads performed (cache misses). */
  nodesRead: number;
  /** Nodes dequeued/expanded during BFS. */
  nodesExpanded: number;
  /** Incident edges inspected, including ones filtered out. */
  edgesChecked: number;
  /** History read calls performed (traversal + fragment scope). */
  historyReads: number;
  /** Diagnostics entries retained. */
  diagnostics: number;
  /** True when gaps were dropped because diagnostics exceeded `maxDiagnostics`. */
  diagnosticsTruncated: boolean;
}

/** Why a bounded search stopped, independent of route-finding. */
export type SearchDisposition = 'complete' | 'evidence_gaps' | 'budget_exhausted';

/** Result of a bounded adjacency read. Edges are snapshots, not reference-resolved. */
export interface AdjacencyResult {
  nodeId: string;
  /** Out-edges (`from === nodeId`), including self-loops (a self-loop is not duplicated into `inEdges`). */
  outEdges: TopologyEdge[];
  /** In-edges (`to === nodeId` and `from !== nodeId`). */
  inEdges: TopologyEdge[];
  /** Incident edges inspected (counted against `maxEdges`). */
  edgesChecked: number;
  /** True when the full incident set was scanned. */
  complete: boolean;
  /** Which budget stopped the scan, when `complete` is false. */
  exhausted?: QueryBudgetKey;
}

/** Result of a bounded directed reachability query. */
export interface ReachabilityResult {
  from: string;
  /** The requested mode filter (validated), or `undefined` when not specified. */
  mode?: MoveMode;
  /** Confirmed reachable node ids in BFS order, including `from` at depth 0. */
  nodes: string[];
  disposition: SearchDisposition;
  /** Deduplicated gap kinds encountered, preserved even when diagnostics are truncated. */
  gaps: SearchGapKind[];
  stats: QueryStats;
  diagnostics: SearchDiagnostic[];
  exhausted?: QueryBudgetKey;
}

/** Status of a bounded single historical route query. */
export type RouteQueryStatus =
  | 'FOUND'
  | 'NO_RECORDED_ROUTE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'BUDGET_EXHAUSTED';

/** One segment of a found route: an edge plus the witness evidence actually used. */
export interface RouteSegment {
  edgeId: string;
  from: string;
  to: string;
  type: ConnectionType;
  /** Direction actually traversed; `reverse` is only possible on an undirected edge. */
  direction: EdgeDirection;
  /** The witness evidence actually used (smallest evidenceId among matching resolved refs). */
  evidenceId: string;
  /** The witness evidence as read now (authoritative clone), preserving its original meaning. */
  evidence: TraversalEvidence;
}

/** Result of a bounded single historical route query. */
export interface RouteQueryResult {
  status: RouteQueryStatus;
  from: string;
  to: string;
  /** The requested mode filter (validated), or `undefined` when not specified. */
  mode?: MoveMode;
  /** Ordered node ids, populated only when `status === 'FOUND'`. */
  nodeIds: string[];
  /** Ordered edge ids, populated only when `status === 'FOUND'`. */
  edgeIds: string[];
  /** Per-segment witness details, populated only when `status === 'FOUND'`. */
  segments: RouteSegment[];
  /** Deduplicated gap kinds encountered, preserved even when diagnostics are truncated. */
  gaps: SearchGapKind[];
  stats: QueryStats;
  diagnostics: SearchDiagnostic[];
  exhausted?: QueryBudgetKey;
}

// --- bounded historical reachable-anchor query (phase 4D) ---

/** Sort order for historical anchor candidates. */
export type AnchorOrder = 'bfs' | 'highest' | 'deepest';

/** Options for the bounded historical reachable-anchor query. */
export interface HistoricalAnchorQueryOptions extends TopologyQueryOptions {
  /** Filter on node source (AND-combined with `tag`/`kind`). */
  source?: NodeSource;
  /** Filter on node tag; nodes without a tag never match a specified tag. */
  tag?: LandmarkTag;
  /** Filter on node kind. */
  kind?: NodeKind;
  /** Whether the start node may be returned as a zero-hop candidate. Defaults to true. */
  includeStart?: boolean;
  /** Sort order. Defaults to 'bfs'. */
  order?: AnchorOrder;
  /** Maximum returned candidates; clamped to `maxQueryBatch`. Defaults to min(20, maxQueryBatch). */
  limit?: number;
}

/** One matched candidate: its node snapshot plus BFS hop count from the start. */
export interface HistoricalAnchorCandidate {
  node: SpatialNode;
  hops: number;
}

/** Result of a bounded historical reachable-anchor query. */
export interface HistoricalAnchorQueryResult {
  from: string;
  mode?: MoveMode;
  order: AnchorOrder;
  items: HistoricalAnchorCandidate[];
  /** Union of the BFS predecessor paths needed to reach the returned candidates, in predecessor-first order. */
  proofSegments: RouteSegment[];
  /** Matched candidate count before applying `limit`. */
  matchedCount: number;
  /** True when `matchedCount` exceeds `items.length`. */
  resultsTruncated: boolean;
  disposition: SearchDisposition;
  gaps: SearchGapKind[];
  stats: QueryStats;
  diagnostics: SearchDiagnostic[];
  exhausted?: QueryBudgetKey;
}

/**
 * Explicit update to an existing node. `id`/`worldId`/`dim`/`source` are
 * immutable; `kind`/`tag`/`label` may be changed (an explicitly-`undefined`
 * `tag`/`label` clears them), and `location` may only be corrected while the node
 * is referenced by no edge.
 */
export interface NodeChanges {
  kind?: NodeKind;
  tag?: LandmarkTag;
  label?: string;
  location?: SpatialNode['location'];
  observedAt?: number;
  externalRef?: string;
  durable?: boolean;
  /** Opaque host metadata; an explicitly-`undefined` value clears it. */
  metadata?: JsonObject;
}

/**
 * Explicit update to an existing edge. `id`/`from`/`to` are immutable; changing
 * endpoints means deleting the edge and creating a new one. Changing `basis` from
 * `candidate` to `traversed` (or altering `evidenceIds`) re-runs every validation.
 */
export interface EdgeChanges {
  type?: ConnectionType;
  fragmentId?: string;
  basis?: EdgeBasis;
  source?: string;
  evidenceIds?: string[];
  /** `true` (default) or `false` for a bidirectional historical connection. */
  directed?: boolean;
  modes?: MoveMode[];
}

/** One preserved evidence binding: the id plus the immutable snapshot it was bound to. */
export interface TopologyEvidenceRefSnapshot {
  evidenceId: string;
  snapshot: TraversalEvidence;
}

/**
 * Persistent form of a stored edge: the public fields plus the binding snapshots.
 * This is the checkpoint/restore shape — distinct from `TopologyEdge` (query
 * projection) and `EdgeView` (resolution), and never from the derived
 * `current`/`resolution` of a read.
 */
export interface TopologyEdgeSnapshot {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  fragmentId?: string;
  basis: EdgeBasis;
  source?: string;
  refs: TopologyEvidenceRefSnapshot[];
  /** Optional for backward-compatible restore; absent means legacy `true`. */
  directed?: boolean;
  modes?: MoveMode[];
  /** Runtime verification records. Derived state, restored only with their stored times. */
  verifications?: EdgeVerification[];
}

/** Persistent form of a portal edge: raw traversals only — never a `returnVerified` flag. */
export interface TopologyPortalEdgeSnapshot {
  id: string;
  from: string;
  to: string;
  directed: boolean;
  fragmentId?: string;
  source?: string;
  traversals: PortalTraversalEvidence[];
}

/** Measured size of the topology store, used for the bounded checkpoint pre-flight. */
export interface TopologyCheckpointMeasure {
  nodes: number;
  edges: number;
  edgeEvidenceRefs: number;
  bytes: number;
  portalEdges?: number;
  portalTraversals?: number;
  fragmentMerges?: number;
}

/** A deep-copied, insertion-ordered snapshot of the store's full topology. */
export interface TopologyCheckpointSnapshot {
  worldId: string;
  nodes: SpatialNode[];
  edges: TopologyEdgeSnapshot[];
  /** Optional for older callers/snapshots: portal edges are a separate map. */
  portalEdges?: TopologyPortalEdgeSnapshot[];
  /** Explicit fragment merges (evidence-backed); pairs of fragment ids. */
  fragmentMerges?: [string, string][];
}

/** Internal edge record: the public shape plus the immutable binding snapshots. */
interface StoredEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  fragmentId?: string;
  basis: EdgeBasis;
  source?: string;
  refs: StoredEvidenceRef[];
  directed: boolean;
  modes: MoveMode[];
  verifications: EdgeVerification[];
}

/** Internal portal edge record: raw traversal evidence only. */
interface StoredPortalEdge {
  id: string;
  from: string;
  to: string;
  directed: boolean;
  fragmentId?: string;
  source?: string;
  traversals: PortalTraversalEvidence[];
}

interface StoredEvidenceRef {
  evidenceId: string;
  snapshot: TraversalEvidence;
}

/**
 * Lazily materialized, id-ascending read index for the paginated node listing.
 * A derived view over `nodeMap`, never a second source of truth: every write
 * that can change a listed node invalidates it, and it is rebuilt from the
 * current map on the next read.
 */
interface NodeListingIndex {
  /** Every node id, ascending (the unfiltered listing). */
  readonly all: string[];
  readonly byDim: Map<string, string[]>;
  readonly bySource: Map<NodeSource, string[]>;
  readonly byTag: Map<LandmarkTag, string[]>;
  readonly byLabel: Map<string, string[]>;
}

/**
 * Lazily materialized, id-ascending read index for the paginated edge listing.
 * `byDim` keys on the `from` node's dimension, matching `edges({ dim })`'s
 * endpoint rule (every stored edge's `from` node exists).
 */
interface EdgeListingIndex {
  readonly all: string[];
  readonly byDim: Map<string, string[]>;
  readonly byFrom: Map<string, string[]>;
  readonly byTo: Map<string, string[]>;
  readonly byType: Map<ConnectionType, string[]>;
  readonly byBasis: Map<EdgeBasis, string[]>;
}

interface ResolvedLimits {
  maxAgentNodes: number;
  maxProgramNodes: number;
  maxEdges: number;
  maxEdgeEvidenceRefs: number;
  maxQueryBatch: number;
  maxQueryNodes: number;
  maxQueryEdges: number;
  maxQueryHistoryReads: number;
  maxQueryDiagnostics: number;
  maxPortalEdges: number;
  maxPortalTraversalsPerEdge: number;
  maxFragmentMerges: number;
  json: JsonLimits;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  maxAgentNodes: 10000,
  maxProgramNodes: 10000,
  maxEdges: 20000,
  maxEdgeEvidenceRefs: 8,
  maxQueryBatch: 100,
  maxQueryNodes: 1000,
  maxQueryEdges: 10000,
  maxQueryHistoryReads: 1000,
  maxQueryDiagnostics: 100,
  maxPortalEdges: 1000,
  maxPortalTraversalsPerEdge: 32,
  maxFragmentMerges: 1000,
  json: DEFAULT_JSON_LIMITS,
};

const NODE_KINDS: readonly NodeKind[] = ['entrance', 'place', 'branch', 'turn', 'vertical_junction'];
const NODE_SOURCES: readonly NodeSource[] = ['agent', 'program'];
const LANDMARK_TAGS: readonly LandmarkTag[] = [
  'base',
  'resource',
  'danger',
  'discovery',
  'death',
  'waypoint',
  'herd',
  'portal',
];
const NON_PORTAL_CONNECTION_TYPES: readonly ConnectionType[] = [
  'HORIZONTAL',
  'STAIRCASE',
  'VERTICAL_SHAFT',
  'LADDER',
  'BRIDGE',
  'DROP',
  'CLIMB',
  'SWIM',
  'CAVE_PASSAGE',
];

export class TopologyStore {
  readonly worldId: string;

  private readonly history: TopologyHistorySource;
  private readonly limits: ResolvedLimits;
  private readonly nodeMap = new Map<string, SpatialNode>();
  private readonly edgeMap = new Map<string, StoredEdge>();
  /** Portal edges live in their own map; the walk graph never sees them. */
  private readonly portalEdgeMap = new Map<string, StoredPortalEdge>();
  /** Portal traversal id → raw evidence (insertion-ordered). */
  private readonly portalTraversalMap = new Map<string, PortalTraversalEvidence>();
  /** Evidence-backed fragment merges, canonical `[a,b]` with `a < b`. */
  private fragmentMerges: FragmentMerge[] = [];
  /** Program node insertion order, for oldest-first eviction. */
  private programNodeOrder: string[] = [];
  /**
   * Per-dimension node component cache. Invalidation touches only the
   * component(s) incident to a changed edge; untouched components are reused.
   */
  private readonly componentCache = new Map<string, Map<string, number>>();
  private readonly componentNext = new Map<string, number>();
  /** Materialized paging indexes; `null` after a listing-relevant write. */
  private nodeListingIndex: NodeListingIndex | null = null;
  private edgeListingIndex: EdgeListingIndex | null = null;
  private readonly clock: () => number;
  /** node id → edge ids that reference it (for location-update and delete guards). */
  private readonly nodeToEdgeIds = new Map<string, Set<string>>();
  /**
   * Session-local mutation revision, bumped only by writes that actually change a
   * fact. Not a time, observation number, or traversal count; it is reset on
   * `restoreSnapshot` and only exists to mark checkpoint cut-points and `dirty`.
   */
  private mutationRevision = 0;
  /** Nesting depth of `runAtomic`; only the outermost call owns the rollback. */
  private transactionDepth = 0;

  constructor(history: TopologyHistorySource, options: TopologyStoreOptions = {}) {
    this.worldId = history.worldId;
    this.history = history;
    this.limits = resolveLimits(options);
    this.clock = options.now ?? Date.now;
  }

  /** Current store clock (ms). Injected for deterministic freshness tests. */
  now(): number {
    return this.clock();
  }

  /** Current mutation revision (see `mutationRevision`). */
  get revision(): number {
    return this.mutationRevision;
  }

  /**
   * Run synchronous topology writes as one all-or-nothing unit. Per-call
   * validation already prevents half-written single records; this covers a
   * caller that updates nodes and edges together. The mutable maps are
   * snapshotted first and restored on any throw. Nested calls join the outer
   * transaction. Reads are never restricted, so the operation must not await.
   *
   * This is an in-memory transaction, not a persistence checkpoint.
   */
  runAtomic<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    const snapshot = this.snapshotMutableState();
    this.transactionDepth = 1;
    try {
      const value = operation();
      this.transactionDepth = 0;
      return value;
    } catch (error) {
      this.restoreMutableState(snapshot);
      this.transactionDepth = 0;
      throw error;
    }
  }

  private snapshotMutableState(): {
    nodes: Map<string, SpatialNode>;
    edges: Map<string, StoredEdge>;
    portalEdges: Map<string, StoredPortalEdge>;
    portalTraversals: Map<string, PortalTraversalEvidence>;
    merges: FragmentMerge[];
    programOrder: string[];
    componentCache: Map<string, Map<string, number>>;
    componentNext: Map<string, number>;
    nodeIndex: NodeListingIndex | null;
    edgeIndex: EdgeListingIndex | null;
    nodeToEdges: Map<string, Set<string>>;
    revision: number;
  } {
    return {
      nodes: new Map(this.nodeMap),
      edges: new Map(this.edgeMap),
      portalEdges: new Map(this.portalEdgeMap),
      portalTraversals: new Map(this.portalTraversalMap),
      merges: [...this.fragmentMerges],
      programOrder: [...this.programNodeOrder],
      componentCache: new Map(
        [...this.componentCache].map(([dim, components]) => [dim, new Map(components)]),
      ),
      componentNext: new Map(this.componentNext),
      nodeIndex: this.nodeListingIndex,
      edgeIndex: this.edgeListingIndex,
      nodeToEdges: new Map([...this.nodeToEdgeIds].map(([id, edges]) => [id, new Set(edges)])),
      revision: this.mutationRevision,
    };
  }

  private restoreMutableState(snapshot: ReturnType<TopologyStore['snapshotMutableState']>): void {
    this.nodeMap.clear();
    for (const [id, node] of snapshot.nodes) this.nodeMap.set(id, node);
    this.edgeMap.clear();
    for (const [id, edge] of snapshot.edges) this.edgeMap.set(id, edge);
    this.portalEdgeMap.clear();
    for (const [id, edge] of snapshot.portalEdges) this.portalEdgeMap.set(id, edge);
    this.portalTraversalMap.clear();
    for (const [id, traversal] of snapshot.portalTraversals) this.portalTraversalMap.set(id, traversal);
    this.fragmentMerges = snapshot.merges;
    this.programNodeOrder = snapshot.programOrder;
    this.componentCache.clear();
    for (const [dim, components] of snapshot.componentCache) this.componentCache.set(dim, components);
    this.componentNext.clear();
    for (const [dim, next] of snapshot.componentNext) this.componentNext.set(dim, next);
    this.nodeListingIndex = snapshot.nodeIndex;
    this.edgeListingIndex = snapshot.edgeIndex;
    this.nodeToEdgeIds.clear();
    for (const [id, edges] of snapshot.nodeToEdges) this.nodeToEdgeIds.set(id, edges);
    this.mutationRevision = snapshot.revision;
  }

  // --- nodes ---

  /**
   * Insert a node, or no-op when the same id + content is re-delivered. Same id
   * with different content is a conflict (use `updateNode` to change it). Agent
   * and program nodes draw on separate quotas.
   */
  saveNode(node: SpatialNode): SaveResult {
    const snapshot = snapshotNode(this.worldId, node, this.limits);
    const existing = this.nodeMap.get(node.id);
    if (existing !== undefined) {
      if (nodesEqual(existing, snapshot)) return { status: 'unchanged' };
      throw new Error(`node "${node.id}" already exists with different content`);
    }
    const capacity =
      snapshot.source === 'agent' ? this.limits.maxAgentNodes : this.limits.maxProgramNodes;
    if (this.countNodes(snapshot.source) >= capacity) {
      if (snapshot.source === 'agent') {
        // Agent-named places are durable: reject rather than silently forget one.
        throw new Error(
          `node capacity for source "agent" (${capacity}) reached; nothing was written`,
        );
      }
      if (!this.evictOldestProgramNode()) {
        throw new Error(
          `program node capacity (${capacity}) reached and every program node is referenced by an edge`,
        );
      }
    }
    this.nodeMap.set(node.id, snapshot);
    if (snapshot.source === 'program') this.programNodeOrder.push(snapshot.id);
    this.invalidateNodeListing();
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /**
   * Explicitly change an existing node. Identity (`id`/`worldId`/`dim`/`source`)
   * is immutable; omitted fields keep their value, and an explicitly-`undefined`
   * `tag`/`label` clears them. Changing `location` is rejected while any edge
   * references the node; a same-value location update stays idempotent.
   */
  updateNode(id: string, changes: NodeChanges): SaveResult {
    const existing = this.nodeMap.get(id);
    if (existing === undefined) {
      throw new Error(`unknown node "${id}"`);
    }
    const merged = applyNodeChanges(existing, changes);
    if (!locationsEqual(existing.location, merged.location)) {
      if (this.nodeToEdgeIds.get(id)?.size) {
        throw new Error(`node "${id}" is referenced by an edge; remove the edges before changing location`);
      }
      const portalRefs = this.portalEdgeIdsForNode(id);
      if (portalRefs.length > 0) {
        throw new Error(`node "${id}" is referenced by portal edge(s) ${portalRefs.join(', ')}; remove them before changing location`);
      }
    }
    const snapshot = snapshotNode(this.worldId, merged, this.limits);
    if (nodesEqual(existing, snapshot)) return { status: 'unchanged' };
    this.nodeMap.set(id, snapshot);
    this.invalidateNodeListing();
    this.mutationRevision += 1;
    return { status: 'updated' };
  }

  /** Read a node by id (deep-copied snapshot), or `null` when absent. */
  getNode(id: string): SpatialNode | null {
    const node = this.nodeMap.get(id);
    return node === undefined ? null : cloneNode(node);
  }

  /**
   * Read-only list of every walk-graph edge id that references `nodeId`, in
   * insertion order. Unlike `adjacency()`, this is not filtered by current
   * verification state and is not subject to a query budget — callers that must
   * decide whether a node location can change need the complete reference set.
   */
  incidentEdgeIds(nodeId: string): string[] {
    return [...(this.nodeToEdgeIds.get(nodeId) ?? [])];
  }

  /** Read-only list of every portal-edge id that references `nodeId`. */
  incidentPortalEdgeIds(nodeId: string): string[] {
    return this.portalEdgeIdsForNode(nodeId);
  }

  /** Delete a node. Refused while any edge references it; unknown id is a no-op. */
  forgetNode(id: string): void {
    const refs = this.nodeToEdgeIds.get(id);
    if (refs !== undefined && refs.size > 0) {
      throw new Error(`node "${id}" is referenced by ${refs.size} edge(s); remove them first`);
    }
    const portalRefs = this.portalEdgeIdsForNode(id);
    if (portalRefs.length > 0) {
      throw new Error(`node "${id}" is referenced by portal edge(s) ${portalRefs.join(', ')}; remove them first`);
    }
    const existed = this.nodeMap.delete(id);
    this.nodeToEdgeIds.delete(id);
    if (existed) {
      this.invalidateNodeComponent(id);
      this.invalidateNodeListing();
      this.mutationRevision += 1;
    }
  }

  /**
   * First-class "remember this named place" primitive (design §5). Always
   * agent-sourced and therefore durable. Re-recording the same label+position
   * updates tags/observation metadata instead of creating a duplicate; the
   * label is opaque to the library.
   */
  recordNode(
    label: string,
    pos: Vec3Like,
    tag?: LandmarkTag,
    options: RecordNodeOptions = { dim: '' },
  ): SpatialNode {
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error(`recordNode label must be a non-empty string`);
    }
    if (typeof options.dim !== 'string' || options.dim.length === 0) {
      throw new Error(`recordNode requires a non-empty dim`);
    }
    assertFinitePoint(pos, 'recordNode position');
    const id =
      options.id ??
      `agent:${options.dim}:${pos.x},${pos.y},${pos.z}:${label}`;
    const existing = this.nodeMap.get(id);
    if (existing !== undefined) {
      if (existing.source !== 'agent') {
        throw new Error(`recordNode id "${id}" belongs to a program node`);
      }
      const changes: NodeChanges = {
        kind: options.kind ?? existing.kind,
        tag: tag ?? existing.tag,
        label,
      };
      if (options.observedAt !== undefined) changes.observedAt = options.observedAt;
      if (options.externalRef !== undefined) changes.externalRef = options.externalRef;
      this.updateNode(id, changes);
      return this.getNode(id)!;
    }
    const node: SpatialNode = {
      id,
      kind: options.kind ?? 'place',
      source: 'agent',
      worldId: this.worldId,
      dim: options.dim,
      location: { kind: 'exact', pos: { x: pos.x, y: pos.y, z: pos.z } },
    };
    if (tag !== undefined) node.tag = tag;
    node.label = label;
    if (options.observedAt !== undefined) node.observedAt = options.observedAt;
    if (options.externalRef !== undefined) node.externalRef = options.externalRef;
    this.saveNode(node);
    return this.getNode(id)!;
  }

  /**
   * Mark an anchor's object gone. The node record and all history are kept; only
   * real observation evidence (session, time, source) is accepted. Evidence older
   * than the node's last observation is rejected rather than rewriting history.
   */
  markGone(nodeId: string, evidence: GoneEvidence): SaveResult {
    const existing = this.nodeMap.get(nodeId);
    if (existing === undefined) {
      throw new Error(`unknown node "${nodeId}"`);
    }
    validateGoneEvidence(evidence);
    if (existing.gone === true) return { status: 'unchanged' };
    if (existing.observedAt !== undefined && evidence.observedAt < existing.observedAt) {
      throw new Error(
        `gone evidence for "${nodeId}" is older than its last observation; nothing was written`,
      );
    }
    const merged: SpatialNode = {
      ...cloneNode(existing),
      gone: true,
      goneAt: evidence.observedAt,
      goneEvidence: {
        sessionId: evidence.sessionId,
        observedAt: evidence.observedAt,
        source: evidence.source,
        observationIds: evidence.observationIds?.slice(),
        reason: evidence.reason,
      },
    };
    this.nodeMap.set(nodeId, snapshotNode(this.worldId, merged, this.limits));
    this.invalidateNodeListing();
    this.mutationRevision += 1;
    return { status: 'updated' };
  }

  /** Gone anchors whose center is within `radius` of `pos`, nearest first. */
  goneNear(dim: string, pos: Vec3Like, radius = 3.5): SpatialNode[] {
    assertFinitePoint(pos, 'goneNear position');
    if (!Number.isFinite(radius) || radius < 0) {
      throw new Error(`goneNear radius must be a non-negative finite number`);
    }
    return [...this.nodeMap.values()]
      .filter((node) => node.dim === dim && node.gone === true)
      .map((node) => ({
        node,
        distance: distanceToLocation(node.location, pos),
      }))
      .filter((entry) => entry.distance <= radius)
      .sort((a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id))
      .map((entry) => cloneNode(entry.node));
  }

  /**
   * Display namespace read: program-generated points never share the default
   * (agent) display surface, so they cannot bury named places.
   */
  displayNodes(query: NodeQuery & { namespace?: NodeSource } = {}): NodePage {
    const { namespace = 'agent', ...rest } = query;
    return this.nodes({ ...rest, source: namespace });
  }

  /**
   * Paginated, read-only node listing (id-ordered, exclusive cursor, clamped
   * limit). Pages come from the materialized `nodeListingIndex`; `total` is the
   * bucket size for a single filter and the scanned match count otherwise.
   */
  nodes(query: NodeQuery = {}): NodePage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const index = this.getNodeListingIndex();
    const filterCount =
      (query.dim === undefined ? 0 : 1) +
      (query.source === undefined ? 0 : 1) +
      (query.tag === undefined ? 0 : 1) +
      (query.label === undefined ? 0 : 1);
    // First existing bucket by this fixed priority; its ids are already ascending.
    const bucket =
      query.label !== undefined
        ? index.byLabel.get(query.label)
        : query.tag !== undefined
          ? index.byTag.get(query.tag)
          : query.source !== undefined
            ? index.bySource.get(query.source)
            : query.dim !== undefined
              ? index.byDim.get(query.dim)
              : undefined;
    if (filterCount === 0) {
      const { pageIds, nextAfter } = selectPage(index.all, query.after, limit);
      return {
        items: pageIds.map((id) => cloneNode(this.nodeMap.get(id)!)),
        total: index.all.length,
        nextAfter,
      };
    }
    if (filterCount === 1 && bucket !== undefined) {
      // The single requested condition is exactly the bucket key: total is the
      // materialized bucket size, and the page is a direct slice.
      const { pageIds, nextAfter } = selectPage(bucket, query.after, limit);
      return {
        items: pageIds.map((id) => cloneNode(this.nodeMap.get(id)!)),
        total: bucket.length,
        nextAfter,
      };
    }
    const page = selectFilteredPage(bucket ?? [], query.after, limit, (id) => {
      const node = this.nodeMap.get(id)!;
      if (query.dim !== undefined && node.dim !== query.dim) return false;
      if (query.source !== undefined && node.source !== query.source) return false;
      if (query.tag !== undefined && node.tag !== query.tag) return false;
      if (query.label !== undefined && node.label !== query.label) return false;
      return true;
    });
    return {
      items: page.pageIds.map((id) => cloneNode(this.nodeMap.get(id)!)),
      total: page.total,
      nextAfter: page.nextAfter,
    };
  }

  // --- edges ---

  /**
   * Insert a directed edge, or no-op on an idempotent re-delivery. A `traversed`
   * edge re-validates every evidence reference against the authoritative history;
   * a `candidate` edge must not cite any evidence.
   */
  saveEdge(edge: TopologyEdge): SaveResult {
    if (this.portalEdgeMap.has(edge.id)) {
      throw new Error(`edge id "${edge.id}" is already used by a portal edge`);
    }
    const shape = this.validateEdgeShape(edge);
    if (edge.verifications !== undefined && !Array.isArray(edge.verifications)) {
      throw new Error(`edge verifications must be an array`);
    }
    const verifications = (edge.verifications ?? []).reduce<EdgeVerification[]>((acc, raw) => {
      const verification = snapshotEdgeVerification(raw, this.now(), shape.directed);
      if (shape.modes.length > 0 && !shape.modes.includes(verification.mode)) {
        throw new Error(
          `mode "${verification.mode}" is not a recorded candidate mode of edge "${edge.id}"`,
        );
      }
      return withVerification(acc, verification);
    }, []);
    const refs = this.resolveRefs(edge, shape.fromPos, shape.toPos, shape.dim, shape.directed);
    const stored = this.assembleStoredEdge(edge, refs, verifications);
    const existing = this.edgeMap.get(edge.id);
    if (existing !== undefined) {
      if (storedEdgesEqual(existing, stored)) return { status: 'unchanged' };
      throw new Error(`edge "${edge.id}" already exists with different content`);
    }
    if (this.edgeMap.size >= this.limits.maxEdges) {
      throw new Error(`edge capacity ${this.limits.maxEdges} reached; nothing was written`);
    }
    this.edgeMap.set(edge.id, stored);
    this.indexEdge(stored);
    this.invalidateEdgeComponents(stored);
    this.invalidateEdgeListing();
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /**
   * Explicitly change an existing edge. `id`/`from`/`to` are immutable. Only an
   * explicit rebind — providing `evidenceIds` — re-resolves the evidence and
   * replaces the binding snapshots; an empty update or an update of unrelated
   * fields (`type`/`source`/`fragmentId`/`basis`) preserves the existing binding,
   * so a re-imported-but-different evidence record stays `mismatch` rather than
   * being silently re-bound to `resolved`.
   */
  updateEdge(id: string, changes: EdgeChanges): SaveResult {
    const existing = this.edgeMap.get(id);
    if (existing === undefined) {
      throw new Error(`unknown edge "${id}"`);
    }
    const rebind = 'evidenceIds' in changes;
    const merged = applyEdgeChanges(existing, changes);
    const shape = this.validateEdgeShape(merged);
    if (shape.directed && existing.verifications.some((v) => v.direction === 'reverse')) {
      throw new Error(`edge "${id}" has reverse verification; it cannot become directed`);
    }
    const refs = rebind
      ? this.resolveRefs(merged, shape.fromPos, shape.toPos, shape.dim, shape.directed)
      : this.preservedRefs(merged, existing);
    const stored = this.assembleStoredEdge(merged, refs, existing.verifications);
    if (storedEdgesEqual(existing, stored)) return { status: 'unchanged' };
    this.edgeMap.set(id, stored);
    this.invalidateEdgeComponents(stored);
    this.invalidateEdgeListing();
    this.mutationRevision += 1;
    return { status: 'updated' };
  }

  /** Read an edge by id with its reference resolution, or `null` when absent. */
  getEdge(id: string): EdgeView | null {
    const stored = this.edgeMap.get(id);
    return stored === undefined ? null : this.toEdgeView(stored);
  }

  /**
   * Record a fresh verification for one direction+mode. This never deletes a
   * fragment, traversal or edge. `BLOCKED` must go through `blockEdge` so it
   * always carries obstacle evidence; an `OPEN` result must be fresh right now.
   */
  verifyEdge(id: string, verification: EdgeVerificationInput): SaveResult {
    if (verification.status === 'BLOCKED') {
      throw new Error(`use blockEdge to record a BLOCKED verification with evidence`);
    }
    if (verification.status === 'OPEN' && (verification.dependencies?.length ?? 0) === 0) {
      // OPEN must name the section revisions it actually depended on; without
      // them the library cannot tell whether the evidence is still current.
      throw new Error(`OPEN verification requires at least one section dependency`);
    }
    return this.applyVerification(id, verification);
  }

  /** Block one direction+mode with concrete obstacle evidence. Never deletes history. */
  blockEdge(id: string, input: EdgeBlockInput): SaveResult {
    if (input.blockedAt === undefined || input.blockedAt === null) {
      throw new Error(`blockEdge requires obstacle evidence`);
    }
    return this.applyVerification(id, {
      direction: input.direction,
      mode: input.mode,
      status: 'BLOCKED',
      blockedAt: input.blockedAt,
      reason: input.reason,
      hazards: input.hazards,
      dependencies: input.dependencies,
      contextKey: input.contextKey,
      sessionId: input.sessionId,
      computedAt: input.computedAt,
      validUntil: input.validUntil,
    });
  }

  /**
   * Clear a recorded blockage by replacing it with an explicit `UNKNOWN`. This
   * never restores `OPEN`: routing stays excluded until `verifyEdge` records a
   * fresh OPEN with current evidence. Returns `unchanged` when nothing was blocked.
   */
  clearEdgeBlock(id: string, direction: EdgeDirection = 'forward', mode: MoveMode = 'walk'): SaveResult {
    const stored = this.edgeMap.get(id);
    if (stored === undefined) {
      throw new Error(`unknown edge "${id}"`);
    }
    const current = stored.verifications.find(
      (v) => v.direction === direction && v.mode === mode && v.status === 'BLOCKED',
    );
    if (current === undefined) return { status: 'unchanged' };
    const now = this.now();
    const cleared: EdgeVerificationInput = {
      direction,
      mode,
      status: 'UNKNOWN',
      reason: 'block_cleared_pending_revalidation',
      dependencies: current.dependencies,
      computedAt: now,
      validUntil: now,
    };
    if (current.contextKey.length > 0) cleared.contextKey = current.contextKey;
    if (current.sessionId.length > 0) cleared.sessionId = current.sessionId;
    return this.applyVerification(id, cleared);
  }

  /**
   * Direction/mode separated current status. A mode without a verification reads
   * `UNKNOWN` (`verified: false`), never `OPEN`; an expired OPEN reads `STALE`.
   */
  edgeRuntime(id: string, options: RuntimeQueryOptions = {}): EdgeRuntimeView | null {
    const stored = this.edgeMap.get(id);
    if (stored === undefined) return null;
    return runtimeView(id, stored, this.resolveNow(options));
  }

  private applyVerification(id: string, input: EdgeVerificationInput): SaveResult {
    const stored = this.edgeMap.get(id);
    if (stored === undefined) {
      throw new Error(`unknown edge "${id}"`);
    }
    const verification = snapshotEdgeVerification(input, this.now(), stored.directed);
    if (!stored.modes.includes(verification.mode) && stored.modes.length > 0) {
      throw new Error(
        `mode "${verification.mode}" is not a recorded candidate mode of edge "${id}"`,
      );
    }
    const verifications = withVerification(stored.verifications, verification);
    if (edgeVerificationsEqual(stored.verifications, verifications)) {
      return { status: 'unchanged' };
    }
    // Verification is derived state and is not a listing key, so the paging
    // index stays valid: `id`/`from`/`to`/`type`/`basis` are unchanged.
    this.edgeMap.set(id, { ...stored, verifications });
    // Verification excludes routes but never rewrites historical
    // connectivity/components or deletes fragments.
    this.mutationRevision += 1;
    return { status: 'updated' };
  }

  private resolveNow(options: RuntimeQueryOptions): number {
    if (options.now === undefined) return this.now();
    if (!Number.isFinite(options.now)) {
      throw new Error(`now must be a finite number: ${options.now}`);
    }
    return options.now;
  }

  /**
   * Delete an edge record and its node-reference indices only. It never deletes
   * fragments or traversal evidence from the history store; unknown id is a no-op.
   */
  forgetEdge(id: string): void {
    const stored = this.edgeMap.get(id);
    if (stored === undefined) return;
    this.edgeMap.delete(id);
    this.unindexEdge(stored);
    this.invalidateEdgeComponents(stored);
    this.invalidateEdgeListing();
    this.mutationRevision += 1;
  }

  /**
   * Paginated, read-only edge listing. Each item re-resolves its (finite) evidence
   * references against the history store; a dangling edge is still returned with a
   * missing/mismatch status rather than dropped.
   */
  edges(query: EdgeQuery = {}): EdgePage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const matches = (id: string): boolean => {
      const edge = this.edgeMap.get(id)!;
      if (query.dim !== undefined) {
        const from = this.nodeMap.get(edge.from);
        if (from === undefined || from.dim !== query.dim) return false;
      }
      if (query.from !== undefined && edge.from !== query.from) return false;
      if (query.to !== undefined && edge.to !== query.to) return false;
      if (query.type !== undefined && edge.type !== query.type) return false;
      if (query.basis !== undefined && edge.basis !== query.basis) return false;
      return true;
    };
    const index = this.getEdgeListingIndex();
    const filterCount =
      (query.dim === undefined ? 0 : 1) +
      (query.from === undefined ? 0 : 1) +
      (query.to === undefined ? 0 : 1) +
      (query.type === undefined ? 0 : 1) +
      (query.basis === undefined ? 0 : 1);
    // First existing bucket by this fixed priority; its ids are already ascending.
    const bucket =
      query.from !== undefined
        ? index.byFrom.get(query.from)
        : query.to !== undefined
          ? index.byTo.get(query.to)
          : query.type !== undefined
            ? index.byType.get(query.type)
            : query.basis !== undefined
              ? index.byBasis.get(query.basis)
              : query.dim !== undefined
                ? index.byDim.get(query.dim)
                : undefined;
    if (filterCount === 0) {
      const { pageIds, nextAfter } = selectPage(index.all, query.after, limit);
      return {
        items: pageIds.map((id) => this.toEdgeView(this.edgeMap.get(id)!)),
        total: index.all.length,
        nextAfter,
      };
    }
    if (filterCount === 1 && bucket !== undefined) {
      const { pageIds, nextAfter } = selectPage(bucket, query.after, limit);
      return {
        items: pageIds.map((id) => this.toEdgeView(this.edgeMap.get(id)!)),
        total: bucket.length,
        nextAfter,
      };
    }
    const page = selectFilteredPage(bucket ?? [], query.after, limit, matches);
    return {
      items: page.pageIds.map((id) => this.toEdgeView(this.edgeMap.get(id)!)),
      total: page.total,
      nextAfter: page.nextAfter,
    };
  }

  // --- portal connections (explicitly outside the walk graph) ---

  /**
   * Record a portal connection and its raw traversal evidence. Endpoints may live
   * in different dimensions; only observed coordinates are used (no 8:1 or other
   * scaling). At least one outbound traversal record is required. `returnVerified`
   * is derived on read and is never a stored field.
   */
  savePortalEdge(
    edge: PortalEdgeInput,
    traversals: PortalTraversalEvidence[],
  ): SaveResult {
    if (typeof edge.id !== 'string' || edge.id.length === 0) {
      throw new Error(`portal edge id must be a non-empty string`);
    }
    if (this.edgeMap.has(edge.id)) {
      throw new Error(`edge id "${edge.id}" is already used by a walk edge`);
    }
    const directed = edge.directed ?? false;
    if (typeof directed !== 'boolean') {
      throw new Error(`portal edge directed must be a boolean when present`);
    }
    if (edge.fragmentId !== undefined && (typeof edge.fragmentId !== 'string' || edge.fragmentId.length === 0)) {
      throw new Error(`portal edge fragmentId must be a non-empty string when present`);
    }
    if (edge.source !== undefined && (typeof edge.source !== 'string' || edge.source.length === 0)) {
      throw new Error(`portal edge source must be a non-empty string when present`);
    }
    const fromNode = this.nodeMap.get(edge.from);
    const toNode = this.nodeMap.get(edge.to);
    if (fromNode === undefined) throw new Error(`portal edge references unknown node "${edge.from}"`);
    if (toNode === undefined) throw new Error(`portal edge references unknown node "${edge.to}"`);
    if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
      throw new Error(`portal edge endpoints must be exact locations, not regions`);
    }
    if (!Array.isArray(traversals) || traversals.length === 0) {
      throw new Error(`portal edges require at least one raw traversal record`);
    }
    const existing = this.portalEdgeMap.get(edge.id);
    const normalized = traversals.map((raw) => {
      const traversal = snapshotPortalTraversal(raw);
      if (traversal.edgeId !== edge.id) {
        throw new Error(`portal traversal "${traversal.id}" belongs to edge "${traversal.edgeId}"`);
      }
      if (traversal.direction === 'reverse' && directed) {
        throw new Error(`a directed portal has no reverse traversal`);
      }
      return traversal;
    });
    assertUniquePortalTraversalIds(normalized);
    if (!normalized.some((t) => t.direction === 'forward')) {
      throw new Error(`portal edges require at least one outbound (forward) traversal`);
    }
    const stored: StoredPortalEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      directed,
      traversals: normalized,
    };
    if (edge.fragmentId !== undefined) stored.fragmentId = edge.fragmentId;
    if (edge.source !== undefined) stored.source = edge.source;
    if (existing !== undefined) {
      if (storedPortalEdgesEqual(existing, stored)) return { status: 'unchanged' };
      throw new Error(`portal edge "${edge.id}" already exists with different content`);
    }
    if (this.portalEdgeMap.size >= this.limits.maxPortalEdges) {
      throw new Error(`portal edge capacity ${this.limits.maxPortalEdges} reached; nothing was written`);
    }
    if (normalized.length > this.limits.maxPortalTraversalsPerEdge) {
      throw new Error(
        `portal edge references ${normalized.length} traversals, exceeding ${this.limits.maxPortalTraversalsPerEdge}`,
      );
    }
    for (const traversal of normalized) {
      if (this.portalTraversalMap.has(traversal.id)) {
        throw new Error(`portal traversal id "${traversal.id}" already exists`);
      }
    }
    this.portalEdgeMap.set(edge.id, stored);
    for (const traversal of normalized) this.portalTraversalMap.set(traversal.id, traversal);
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /** Append raw traversal evidence (e.g. a later return trip) to an existing portal edge. */
  addPortalTraversal(edgeId: string, raw: PortalTraversalEvidence): SaveResult {
    const edge = this.portalEdgeMap.get(edgeId);
    if (edge === undefined) {
      throw new Error(`unknown portal edge "${edgeId}"`);
    }
    const traversal = snapshotPortalTraversal(raw);
    if (traversal.edgeId !== edgeId) {
      throw new Error(`portal traversal "${traversal.id}" belongs to edge "${traversal.edgeId}"`);
    }
    if (traversal.direction === 'reverse' && edge.directed) {
      throw new Error(`a directed portal has no reverse traversal`);
    }
    const existing = this.portalTraversalMap.get(traversal.id);
    if (existing !== undefined) {
      if (portalTraversalsEqual(existing, traversal)) return { status: 'unchanged' };
      throw new Error(`portal traversal "${traversal.id}" already exists with different content`);
    }
    if (edge.traversals.length >= this.limits.maxPortalTraversalsPerEdge) {
      throw new Error(
        `portal edge traversal capacity ${this.limits.maxPortalTraversalsPerEdge} reached`,
      );
    }
    edge.traversals.push(traversal);
    this.portalTraversalMap.set(traversal.id, traversal);
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /** Portal edges only; never mixed into `edges()`/`adjacency()`/`route()`. */
  portalEdges(): PortalEdgeView[] {
    return [...this.portalEdgeMap.values()].map((edge) => this.toPortalView(edge));
  }

  getPortalEdge(id: string): PortalEdgeView | null {
    const edge = this.portalEdgeMap.get(id);
    return edge === undefined ? null : this.toPortalView(edge);
  }

  /** Explicit portal-edge deletion; fragments and traversals elsewhere are untouched. */
  forgetPortalEdge(id: string): void {
    const edge = this.portalEdgeMap.get(id);
    if (edge === undefined) return;
    this.portalEdgeMap.delete(id);
    for (const traversal of edge.traversals) this.portalTraversalMap.delete(traversal.id);
    this.mutationRevision += 1;
  }

  private toPortalView(edge: StoredPortalEdge): PortalEdgeView {
    const traversals = edge.traversals.map(clonePortalTraversal);
    const outbound = traversals.filter((t) => t.direction === 'forward');
    const back = traversals.filter((t) => t.direction === 'reverse');
    const from = this.nodeMap.get(edge.from);
    const to = this.nodeMap.get(edge.to);
    if (from === undefined || to === undefined) {
      throw new Error(`portal edge "${edge.id}" references a missing endpoint node`);
    }
    const view: PortalEdgeView = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      fromDim: from.dim,
      toDim: to.dim,
      directed: edge.directed,
      traversals,
      outbound,
      return: back,
      returnVerified: portalReturnVerified(traversals),
    };
    if (edge.fragmentId !== undefined) view.fragmentId = edge.fragmentId;
    if (edge.source !== undefined) view.source = edge.source;
    return view;
  }

  // --- fragment connectivity (union-find over actual links/evidence) ---

  /**
   * Connected pieces of the recorded history for one dimension: union-find over
   * fragment `links` and actual traversal evidence only. Proximity, adjacency of
   * coordinates, and shared labels never create a connection.
   */
  fragmentation(dim: string): FragmentationResult {
    const fragments = this.listFragments(dim);
    const links = this.listTraversalLinks(dim);
    const fragmentIds = new Set(fragments.map((f) => f.id));
    return computeFragmentation({
      fragments,
      links,
      merges: this.fragmentMerges.filter((m) => fragmentIds.has(m.a) && fragmentIds.has(m.b)),
    });
  }

  /**
   * Explicitly merge two fragments as one piece. Only actual traversal evidence
   * whose endpoints lie in the two fragments is accepted; proximity is refused.
   * Neither fragment's geometry or history is deleted.
   */
  mergeFragments(aId: string, bId: string, evidenceId: string): SaveResult {
    if (aId === bId) {
      throw new Error(`cannot merge a fragment with itself`);
    }
    const a = this.history.getFragment(aId);
    const b = this.history.getFragment(bId);
    if (a === null) throw new Error(`unknown fragment "${aId}"`);
    if (b === null) throw new Error(`unknown fragment "${bId}"`);
    if (a.dim !== b.dim) {
      throw new Error(`fragments span dimensions "${a.dim}" and "${b.dim}"`);
    }
    const evidence = this.history.getTraversal(evidenceId);
    if (evidence === null) {
      throw new Error(`unknown traversal evidence "${evidenceId}"`);
    }
    if (evidence.dim !== a.dim || evidence.worldId !== this.worldId) {
      throw new Error(`traversal evidence scope does not match the fragments`);
    }
    if (!traversalConnectsFragments(evidence, a, b)) {
      throw new Error(
        `traversal evidence "${evidenceId}" does not connect fragments "${aId}" and "${bId}"`,
      );
    }
    const pair: FragmentMerge = aId < bId ? { a: aId, b: bId } : { a: bId, b: aId };
    const exists = this.fragmentMerges.some((m) => m.a === pair.a && m.b === pair.b);
    if (exists) return { status: 'unchanged' };
    if (this.fragmentMerges.length >= this.limits.maxFragmentMerges) {
      throw new Error(`fragment merge capacity ${this.limits.maxFragmentMerges} reached`);
    }
    this.fragmentMerges.push(pair);
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /**
   * Current-passable pieces of one fragment, derived from edge verification.
   * A blocked/stale/unsupported edge cuts the polyline; the fragment record and
   * its history remain untouched.
   */
  segments(fragmentId: string): FragmentSegmentsResult {
    const fragment = this.history.getFragment(fragmentId);
    if (fragment === null) {
      throw new Error(`unknown fragment "${fragmentId}"`);
    }
    const now = this.now();
    const pointKeys = fragmentPointKeys(fragment);
    const blockedEdgeIds = new Set<string>();
    const cuts: Vec3Like[] = [];
    const addCut = (pos: Vec3Like): void => {
      if (!cuts.some((c) => pointKey(c) === pointKey(pos))) {
        cuts.push({ x: pos.x, y: pos.y, z: pos.z });
      }
    };
    for (const edge of this.edgeMap.values()) {
      const fromNode = this.nodeMap.get(edge.from);
      const toNode = this.nodeMap.get(edge.to);
      if (fromNode === undefined || toNode === undefined) continue;
      if (fromNode.dim !== fragment.dim || toNode.dim !== fragment.dim) continue;
      if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') continue;
      const associated =
        edge.fragmentId === fragmentId ||
        (pointKeys.has(pointKey(fromNode.location.pos)) &&
          pointKeys.has(pointKey(toNode.location.pos)));
      if (!associated) continue;
      // A segment is only cut when no recorded mode remains usable in either
      // allowed direction. A blocked swim mode must not cut a walk segment.
      const modes = [...new Set(edge.verifications.map((v) => v.mode))];
      if (modes.length === 0) continue;
      const usable = modes.some(
        (mode) =>
          directionUsability(edge, 'forward', mode, now).usable ||
          (!edge.directed && directionUsability(edge, 'reverse', mode, now).usable),
      );
      if (usable) continue;
      blockedEdgeIds.add(edge.id);
      addCut(fromNode.location.pos);
      addCut(toNode.location.pos);
    }
    return {
      fragmentId,
      segments: splitPolyline(fragment.polyline, cuts),
      blockedEdgeIds: [...blockedEdgeIds].sort(),
      cuts,
      totalPoints: fragment.polyline.length,
    };
  }

  /**
   * Node connected components for one dimension, computed from recorded
   * evidence-backed edges. Cache invalidation is local to the component(s)
   * incident to a changed edge; untouched components are reused.
   */
  components(dim: string): ComponentReport {
    const cache = this.componentCache.get(dim) ?? new Map<string, number>();
    this.componentCache.set(dim, cache);
    const dimNodes = [...this.nodeMap.values()].filter((n) => n.dim === dim);
    for (const id of [...cache.keys()]) {
      const node = this.nodeMap.get(id);
      if (node === undefined || node.dim !== dim) cache.delete(id);
    }
    const adjacency = new Map<string, string[]>();
    for (const node of dimNodes) adjacency.set(node.id, []);
    for (const edge of this.edgeMap.values()) {
      if (edge.basis !== 'traversed') continue;
      const from = this.nodeMap.get(edge.from);
      const to = this.nodeMap.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (from.dim !== dim || to.dim !== dim) continue;
      adjacency.get(edge.from)?.push(edge.to);
      adjacency.get(edge.to)?.push(edge.from);
    }
    let recomputedNodes = 0;
    const starts = dimNodes.map((n) => n.id).sort();
    for (const start of starts) {
      if (cache.has(start)) continue;
      const component: string[] = [];
      const seen = new Set<string>([start]);
      const queue: string[] = [start];
      let cursor = 0;
      while (cursor < queue.length) {
        const id = queue[cursor++]!;
        component.push(id);
        for (const neighbor of adjacency.get(id) ?? []) {
          if (seen.has(neighbor)) continue;
          const staleComponent = cache.get(neighbor);
          if (staleComponent !== undefined) {
            // The cached component is now joined to this new one; drop its ids
            // so they are recomputed together instead of keeping a stale split.
            for (const [cachedId, cachedComponent] of [...cache]) {
              if (cachedComponent === staleComponent) cache.delete(cachedId);
            }
          }
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
      const componentId = this.componentNext.get(dim) ?? 0;
      this.componentNext.set(dim, componentId + 1);
      for (const id of component) cache.set(id, componentId);
      recomputedNodes += component.length;
    }
    const groups = new Map<number, string[]>();
    for (const node of dimNodes) {
      const component = cache.get(node.id);
      if (component === undefined) continue;
      const group = groups.get(component);
      if (group === undefined) groups.set(component, [node.id]);
      else group.push(node.id);
    }
    const ordered = [...groups.values()]
      .map((group) => group.sort())
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    const byNode = new Map<string, number>();
    ordered.forEach((group, index) => {
      for (const id of group) byNode.set(id, index);
    });
    return { components: ordered.length, groups: ordered, byNode, recomputedNodes };
  }

  /**
   * Highest exact anchor reachable from the node nearest `here` (never a global
   * maximum). Region nodes are excluded from the result and reported separately.
   */
  surfaceAnchor(dim: string, here: Vec3Like, options: AnchorQueryOptions = {}): AnchorResult | null {
    return this.anchorFromHere(dim, here, options, 'surface');
  }

  /** Lowest exact anchor reachable from the node nearest `here` (never a global minimum). */
  deepestAnchor(dim: string, here: Vec3Like, options: AnchorQueryOptions = {}): AnchorResult | null {
    return this.anchorFromHere(dim, here, options, 'deepest');
  }

  private anchorFromHere(
    dim: string,
    here: Vec3Like,
    options: AnchorQueryOptions,
    order: 'surface' | 'deepest',
  ): AnchorResult | null {
    assertFinitePoint(here, 'anchor query position');
    const near = options.near ?? 3.5;
    if (!Number.isFinite(near) || near < 0) {
      throw new Error(`anchor query near must be a non-negative finite number`);
    }
    const start = [...this.nodeMap.values()]
      .filter(
        (node) =>
          node.dim === dim &&
          node.gone !== true &&
          node.location.kind === 'exact' &&
          distanceToLocation(node.location, here) <= near,
      )
      .sort(
        (a, b) =>
          distanceToLocation(a.location, here) - distanceToLocation(b.location, here) ||
          a.id.localeCompare(b.id),
      )[0];
    if (start === undefined) return null;

    const now = this.resolveNow(options);
    const reach = this.reachable(start.id, { now });
    // A budget-truncated reachable set cannot prove which anchor is highest/lowest.
    // Evidence gaps are reported in the query stats and do not turn the proven
    // reachable subset into a fabricated global extreme.
    if (reach.exhausted !== undefined) return null;
    const reachableIds = new Set(reach.nodes);
    let excludedRegionNodes = 0;
    const candidates: SpatialNode[] = [];
    for (const id of reachableIds) {
      const node = this.nodeMap.get(id);
      if (node === undefined || node.gone === true) continue;
      if (node.location.kind !== 'exact') {
        excludedRegionNodes += 1;
        continue;
      }
      candidates.push(node);
    }
    if (candidates.length === 0) return null;
    const best = candidates.reduce((winner, node) => {
      const a = yOf(node);
      const b = yOf(winner);
      if (a !== b) {
        return order === 'surface' ? (a > b ? node : winner) : a < b ? node : winner;
      }
      return node.id < winner.id ? node : winner;
    });
    const anchor: AnchorResult = {
      nodeId: best.id,
      pos: { ...(best.location as { kind: 'exact'; pos: Vec3Like }).pos },
      y: yOf(best),
      precision: 'exact',
      source: best.source,
      hops: best.id === start.id ? 0 : this.hopsBetween(start.id, best.id, now),
      componentSize: reach.nodes.length,
      excludedRegionNodes,
      startNodeId: start.id,
    };
    if (best.observedAt !== undefined) anchor.observedAt = best.observedAt;
    if (best.externalRef !== undefined) anchor.externalRef = best.externalRef;
    return anchor;
  }

  private hopsBetween(fromId: string, toId: string, now: number): number {
    if (fromId === toId) return 0;
    const result = this.route(fromId, toId, { now });
    return result.status === 'FOUND' ? result.nodeIds.length - 1 : Number.POSITIVE_INFINITY;
  }

  // --- checkpoint support (phase 5A): bounded export + validated restore ---

  /**
   * Size of the store's full topology, used by the checkpoint pre-flight to reject
   * over-capacity saves before any copy or message pass. `maxBytes` bounds the
   * work: a cheap lower bound rejects obviously-over-limit input first, then a full
   * escaped-byte estimate runs with early termination. Read-only.
   */
  checkpointMeasure(maxBytes = Number.POSITIVE_INFINITY): TopologyCheckpointMeasure {
    let edgeEvidenceRefs = 0;
    for (const edge of this.edgeMap.values()) edgeEvidenceRefs += edge.refs.length;
    let portalTraversals = 0;
    for (const edge of this.portalEdgeMap.values()) portalTraversals += edge.traversals.length;

    let lowerBound = 0;
    for (const node of this.nodeMap.values()) lowerBound += nodeLowerBound(node);
    for (const edge of this.edgeMap.values()) lowerBound += edgeLowerBound(edge);
    for (const edge of this.portalEdgeMap.values()) lowerBound += portalEdgeLowerBound(edge);
    lowerBound += this.fragmentMerges.length * 128;
    if (lowerBound > maxBytes) {
      return {
        nodes: this.nodeMap.size,
        edges: this.edgeMap.size,
        edgeEvidenceRefs,
        bytes: lowerBound,
        portalEdges: this.portalEdgeMap.size,
        portalTraversals,
        fragmentMerges: this.fragmentMerges.length,
      };
    }

    let bytes = 0;
    for (const node of this.nodeMap.values()) {
      bytes += estimateNodeBytes(node);
      if (bytes > maxBytes) break;
    }
    for (const edge of this.edgeMap.values()) {
      bytes += estimateEdgeBytes(edge);
      if (bytes > maxBytes) break;
    }
    for (const edge of this.portalEdgeMap.values()) {
      bytes += estimatePortalEdgeBytes(edge);
      if (bytes > maxBytes) break;
    }
    return {
      nodes: this.nodeMap.size,
      edges: this.edgeMap.size,
      edgeEvidenceRefs,
      bytes,
      portalEdges: this.portalEdgeMap.size,
      portalTraversals,
      fragmentMerges: this.fragmentMerges.length,
    };
  }

  /**
   * Deep-copied, insertion-ordered snapshot of the store's full topology for a
   * checkpoint. Edges are exported with their binding snapshots (via
   * `TopologyEdgeSnapshot`), in edge insertion order — never the id-sorted
   * `edges()` projection, so the 4C/4D query order survives a restore.
   */
  checkpointSnapshot(): TopologyCheckpointSnapshot {
    return {
      worldId: this.worldId,
      nodes: [...this.nodeMap.values()].map(cloneNode),
      edges: [...this.edgeMap.values()].map(toEdgeSnapshot),
      portalEdges: [...this.portalEdgeMap.values()].map(toPortalEdgeSnapshot),
      fragmentMerges: this.fragmentMerges.map((m) => [m.a, m.b] as [string, string]),
    };
  }

  /**
   * Narrow, validated restore entry (phase 5A). Replaces the store's full topology
   * from a previously captured snapshot and resets the mutation revision to its
   * session baseline. It validates structure, IDs, scope, endpoints and binding
   * internal consistency, but it does *not* require the current authoritative
   * evidence to exist or match — so `missing`/`mismatch` edges restore as-is and
   * are re-resolved later by the normal read path, never silently re-bound.
   */
  restoreSnapshot(snapshot: TopologyCheckpointSnapshot): void {
    if (snapshot.worldId !== this.worldId) {
      throw new Error(`snapshot worldId "${snapshot.worldId}" does not match store worldId "${this.worldId}"`);
    }
    const nodes = new Map<string, SpatialNode>();
    let agentNodes = 0;
    let programNodes = 0;
    for (const raw of snapshot.nodes) {
      const validated = snapshotNode(this.worldId, raw, this.limits);
      if (nodes.has(validated.id)) {
        throw new Error(`duplicate node id "${validated.id}" in snapshot`);
      }
      nodes.set(validated.id, validated);
      if (validated.source === 'agent') agentNodes += 1;
      else programNodes += 1;
    }
    if (agentNodes > this.limits.maxAgentNodes) {
      throw new Error(`snapshot has ${agentNodes} agent nodes, exceeding ${this.limits.maxAgentNodes}`);
    }
    if (programNodes > this.limits.maxProgramNodes) {
      throw new Error(`snapshot has ${programNodes} program nodes, exceeding ${this.limits.maxProgramNodes}`);
    }
    if (snapshot.edges.length > this.limits.maxEdges) {
      throw new Error(`snapshot has ${snapshot.edges.length} edges, exceeding ${this.limits.maxEdges}`);
    }
    const edges = new Map<string, StoredEdge>();
    const nodeToEdgeIds = new Map<string, Set<string>>();
    for (const raw of snapshot.edges) {
      const stored = this.restoreEdge(raw, nodes);
      if (edges.has(stored.id)) {
        throw new Error(`duplicate edge id "${stored.id}" in snapshot`);
      }
      edges.set(stored.id, stored);
      addToNodeEdgeIndex(nodeToEdgeIds, stored.from, stored.id);
      addToNodeEdgeIndex(nodeToEdgeIds, stored.to, stored.id);
    }
    const portalEdges = new Map<string, StoredPortalEdge>();
    const portalTraversals = new Map<string, PortalTraversalEvidence>();
    for (const raw of snapshot.portalEdges ?? []) {
      const stored = this.restorePortalEdge(raw, nodes);
      if (portalEdges.has(stored.id)) {
        throw new Error(`duplicate portal edge id "${stored.id}" in snapshot`);
      }
      if (edges.has(stored.id)) {
        throw new Error(`portal edge id "${stored.id}" collides with a walk edge in snapshot`);
      }
      for (const traversal of stored.traversals) {
        if (portalTraversals.has(traversal.id)) {
          throw new Error(`duplicate portal traversal id "${traversal.id}" in snapshot`);
        }
        portalTraversals.set(traversal.id, traversal);
      }
      portalEdges.set(stored.id, stored);
    }
    if (portalEdges.size > this.limits.maxPortalEdges) {
      throw new Error(
        `snapshot has ${portalEdges.size} portal edges, exceeding ${this.limits.maxPortalEdges}`,
      );
    }
    const merges: FragmentMerge[] = [];
    const seenMerges = new Set<string>();
    for (const raw of snapshot.fragmentMerges ?? []) {
      if (!Array.isArray(raw) || raw.length !== 2) {
        throw new Error(`fragment merge entries must be [a, b] pairs`);
      }
      const [left, right] = raw;
      if (typeof left !== 'string' || left.length === 0 || typeof right !== 'string' || right.length === 0) {
        throw new Error(`fragment merge ids must be non-empty strings`);
      }
      if (left === right) throw new Error(`fragment merge cannot reference one fragment twice`);
      const pair: FragmentMerge = left < right ? { a: left, b: right } : { a: right, b: left };
      const key = `${pair.a}\u0000${pair.b}`;
      if (seenMerges.has(key)) continue;
      seenMerges.add(key);
      merges.push(pair);
    }
    if (merges.length > this.limits.maxFragmentMerges) {
      throw new Error(
        `snapshot has ${merges.length} fragment merges, exceeding ${this.limits.maxFragmentMerges}`,
      );
    }

    this.nodeMap.clear();
    for (const [id, value] of nodes) this.nodeMap.set(id, value);
    this.edgeMap.clear();
    for (const [id, value] of edges) this.edgeMap.set(id, value);
    this.nodeToEdgeIds.clear();
    for (const [id, value] of nodeToEdgeIds) this.nodeToEdgeIds.set(id, value);
    this.portalEdgeMap.clear();
    for (const [id, value] of portalEdges) this.portalEdgeMap.set(id, value);
    this.portalTraversalMap.clear();
    for (const [id, value] of portalTraversals) this.portalTraversalMap.set(id, value);
    this.fragmentMerges = merges;
    this.programNodeOrder = [...nodes.values()]
      .filter((node) => node.source === 'program')
      .map((node) => node.id);
    this.componentCache.clear();
    this.componentNext.clear();
    this.nodeListingIndex = null;
    this.edgeListingIndex = null;
    // Restore is a mutation: it replaces the store's facts, so it must mark the
    // store dirty. Only a session initializer (which then sets the confirmed
    // baseline to the post-restore revision) treats it as a clean baseline.
    this.mutationRevision += 1;
  }

  // --- bounded historical graph queries (phase 4C) ---

  /**
   * Bounded, read-only adjacency read: the recorded in-edges and out-edges of a
   * node, from the `nodeToEdgeIds` index in insertion order. The returned edges
   * are plain `TopologyEdge` snapshots — they are *not* reference-resolved here,
   * so they must not be read as usable routes. A self-loop is reported once, in
   * `outEdges`. Missing nodes are reported as an error, never as an empty set.
   */
  adjacency(nodeId: string, options: AdjacencyOptions = {}): AdjacencyResult {
    const node = this.nodeMap.get(nodeId);
    if (node === undefined) {
      throw new Error(`unknown node "${nodeId}"`);
    }
    const maxEdges = resolveQueryBudgetField('maxEdges', options.maxEdges, this.limits.maxQueryEdges);
    const now = this.resolveNow(options);
    const includeBlocked = options.includeBlocked ?? false;
    const outEdges: TopologyEdge[] = [];
    const inEdges: TopologyEdge[] = [];
    const incident = this.nodeToEdgeIds.get(nodeId);
    let edgesChecked = 0;
    let complete = true;
    let exhausted: QueryBudgetKey | undefined;
    if (incident !== undefined) {
      for (const edgeId of incident) {
        if (edgesChecked >= maxEdges) {
          complete = false;
          exhausted = 'maxEdges';
          break;
        }
        edgesChecked += 1;
        const stored = this.edgeMap.get(edgeId);
        if (stored === undefined) continue;
        if (stored.from === nodeId) {
          if (includeBlocked || adjacencyUsable(stored, 'forward', now)) {
            outEdges.push(toTopologyEdgeSnapshot(stored));
          }
          continue;
        }
        // In-edges are informational; only an explicit blocked/stale/unsupported
        // reverse verification removes one (a directed reverse is not a direction).
        const reverseUsable = stored.directed || adjacencyUsable(stored, 'reverse', now);
        if (includeBlocked || reverseUsable) inEdges.push(toTopologyEdgeSnapshot(stored));
      }
    }
    return { nodeId, outEdges, inEdges, edgesChecked, complete, exhausted };
  }

  /**
   * Bounded, read-only directed reachability query. Returns the confirmed
   * reachable node ids (including `from` at depth 0) by walking only
   * `basis === 'traversed'` out-edges whose evidence fully resolves and whose
   * mode passes the filter. Never claims current traversability.
   */
  reachable(fromNodeId: string, options: TopologyQueryOptions = {}): ReachabilityResult {
    const out = this.runSearch(fromNodeId, undefined, options);
    const disposition: SearchDisposition =
      out.exhausted !== undefined
        ? 'budget_exhausted'
        : out.gaps.length > 0
          ? 'evidence_gaps'
          : 'complete';
    return {
      from: out.from,
      mode: options.mode,
      nodes: out.order,
      disposition,
      gaps: out.gaps,
      stats: out.stats,
      diagnostics: out.diagnostics,
      exhausted: out.exhausted,
    };
  }

  /**
   * Bounded, read-only single historical route query. Returns one fewest-edges
   * directed historical connection sequence from `fromNodeId` to `toNodeId`, or
   * a precise reason it could not. This is a recorded-topology query over node
   * ids — not current routing, not `SpatialMemoryStore.route`, and never an
   * executable point list.
   */
  route(fromNodeId: string, toNodeId: string, options: TopologyQueryOptions = {}): RouteQueryResult {
    const out = this.runSearch(fromNodeId, toNodeId, options);
    const found = out.foundTarget;
    const status: RouteQueryStatus = found
      ? 'FOUND'
      : out.exhausted !== undefined
        ? 'BUDGET_EXHAUSTED'
        : out.gaps.length > 0
          ? 'INSUFFICIENT_EVIDENCE'
          : 'NO_RECORDED_ROUTE';
    const nodeIds: string[] = [];
    const edgeIds: string[] = [];
    const segments: RouteSegment[] = [];
    if (found) {
      let cursor = toNodeId;
      while (cursor !== fromNodeId) {
        const entry = out.parent.get(cursor)!;
        nodeIds.unshift(cursor);
        edgeIds.unshift(entry.viaEdge.id);
        segments.unshift({
          edgeId: entry.viaEdge.id,
          from: entry.viaEdge.from,
          to: entry.viaEdge.to,
          type: entry.viaEdge.type,
          direction: entry.direction,
          evidenceId: entry.witness.evidenceId,
          evidence: cloneTraversalEvidence(entry.witness.evidence),
        });
        cursor = entry.viaNode;
      }
      nodeIds.unshift(fromNodeId);
    }
    return {
      status,
      from: fromNodeId,
      to: toNodeId,
      mode: options.mode,
      nodeIds,
      edgeIds,
      segments,
      gaps: out.gaps,
      stats: out.stats,
      diagnostics: out.diagnostics,
      exhausted: out.exhausted,
    };
  }

  /**
   * Bounded, read-only historical reachable-anchor query. Returns the nodes
   * reachable from `fromNodeId` over recorded, evidence-resolved, mode-matching
   * `traversed` edges that also satisfy the filter, sorted and limited.
   * `highest`/`deepest` order on the node's exact `pos.y` only — never a surface
   * or cave-depth claim. Never proves current traversability or an executable
   * route, and never selects an action target.
   */
  historicalAnchorCandidates(
    fromNodeId: string,
    options: HistoricalAnchorQueryOptions = {},
  ): HistoricalAnchorQueryResult {
    const includeStart = resolveIncludeStart(options.includeStart);
    const order = resolveOrder(options.order);
    const limit = resolveLimit(options.limit, this.limits.maxQueryBatch);
    if (options.source !== undefined && !NODE_SOURCES.includes(options.source)) {
      throw new Error(`source "${String(options.source)}" is not a known node source`);
    }
    if (options.tag !== undefined && !LANDMARK_TAGS.includes(options.tag)) {
      throw new Error(`tag "${String(options.tag)}" is not a known landmark tag`);
    }
    if (options.kind !== undefined && !NODE_KINDS.includes(options.kind)) {
      throw new Error(`kind "${String(options.kind)}" is not a known node kind`);
    }

    const out = this.runSearch(fromNodeId, undefined, options);

    const bfsIndex = new Map<string, number>();
    out.order.forEach((id, i) => bfsIndex.set(id, i));

    const matched: { node: SpatialNode; hops: number }[] = [];
    for (const id of out.order) {
      if (id === fromNodeId && !includeStart) continue;
      const node = out.nodes.get(id);
      if (node === undefined) continue; // defensive; every confirmed node is indexed
      if (options.source !== undefined && node.source !== options.source) continue;
      if (options.tag !== undefined && node.tag !== options.tag) continue;
      if (options.kind !== undefined && node.kind !== options.kind) continue;
      matched.push({ node, hops: out.depth.get(id) ?? 0 });
    }
    const matchedCount = matched.length;
    sortMatched(matched, order, bfsIndex);

    const items = matched.slice(0, limit).map((m) => ({ node: cloneNode(m.node), hops: m.hops }));
    const candidateIds = items.filter((i) => i.hops > 0).map((i) => i.node.id);
    const proofSegments = buildProofSegments(fromNodeId, candidateIds, out.parent, bfsIndex);

    const disposition: SearchDisposition =
      out.exhausted !== undefined
        ? 'budget_exhausted'
        : out.gaps.length > 0
          ? 'evidence_gaps'
          : 'complete';

    return {
      from: fromNodeId,
      mode: options.mode,
      order,
      items,
      proofSegments,
      matchedCount,
      resultsTruncated: matchedCount > items.length,
      disposition,
      gaps: out.gaps,
      stats: out.stats,
      diagnostics: out.diagnostics,
      exhausted: out.exhausted,
    };
  }

  private runSearch(
    fromNodeId: string,
    toNodeId: string | undefined,
    options: TopologyQueryOptions,
  ): SearchOutput {
    assertValidMode(options.mode);
    const now = this.resolveNow(options);
    const budget = new SearchBudget(resolveQueryBudget(options, this.limits));

    const nodeCache = new Map<string, SpatialNode | null>();
    const traversalCache = new Map<string, TraversalEvidence | null>();
    const scopeCache = new Map<string, { worldId: string; dim: string } | null>();
    const order: string[] = [];
    const depth = new Map<string, number>();
    const nodes = new Map<string, SpatialNode>();
    const parent = new Map<string, ParentEntry>();
    const gaps = new Set<SearchGapKind>();
    const diagnostics: SearchDiagnostic[] = [];
    let foundTarget = false;

    const readNode = (id: string): SpatialNode | null => {
      if (nodeCache.has(id)) return nodeCache.get(id)!;
      if (!budget.tryNode()) return null;
      const node = this.nodeMap.get(id) ?? null;
      nodeCache.set(id, node);
      return node;
    };
    const readTraversal = (id: string): TraversalEvidence | null => {
      if (traversalCache.has(id)) return traversalCache.get(id)!;
      if (!budget.tryHistoryRead()) return null;
      const value = this.history.getTraversal(id);
      traversalCache.set(id, value);
      return value;
    };
    const readFragmentScope = (id: string): { worldId: string; dim: string } | null => {
      if (scopeCache.has(id)) return scopeCache.get(id)!;
      if (!budget.tryHistoryRead()) return null;
      const scope = this.readFragmentScope(id);
      scopeCache.set(id, scope);
      return scope;
    };
    const recordGap = (kind: SearchGapKind, edge: StoredEdge, evidenceIds?: string[]): void => {
      gaps.add(kind);
      if (budget.addDiagnostic()) {
        diagnostics.push({ kind, edgeId: edge.id, from: edge.from, to: edge.to, evidenceIds });
      }
    };
    const finish = (): SearchOutput => ({
      from: fromNodeId,
      to: toNodeId,
      foundTarget,
      order,
      depth,
      nodes,
      parent,
      gaps: [...gaps],
      diagnostics,
      exhausted: budget.exhausted ?? undefined,
      stats: {
        nodesRead: budget.nodesRead,
        nodesExpanded: budget.nodesExpanded,
        edgesChecked: budget.edgesChecked,
        historyReads: budget.historyReads,
        diagnostics: budget.diagnostics,
        diagnosticsTruncated: budget.diagnosticsTruncated,
      },
    });

    const from = readNode(fromNodeId);
    if (budget.exhausted !== null) return finish();
    if (from === null) throw new Error(`unknown node "${fromNodeId}"`);
    if (from.location.kind !== 'exact') throw new Error(`node "${fromNodeId}" is not an exact location`);
    depth.set(fromNodeId, 0);
    nodes.set(fromNodeId, from);

    if (toNodeId !== undefined) {
      const to = readNode(toNodeId);
      if (budget.exhausted !== null) return finish();
      if (to === null) throw new Error(`unknown node "${toNodeId}"`);
      if (to.location.kind !== 'exact') throw new Error(`node "${toNodeId}" is not an exact location`);
      if (to.dim !== from.dim) throw new Error(`nodes span dimensions "${from.dim}" and "${to.dim}"`);
      if (toNodeId === fromNodeId) {
        // A zero-hop route is only found once both endpoints validated (exist,
        // exact, same dim). ID equality alone is never enough to report FOUND.
        foundTarget = true;
        order.push(fromNodeId);
        return finish();
      }
    }

    const queue: string[] = [fromNodeId];
    let cursor = 0;
    const visited = new Set<string>([fromNodeId]);
    order.push(fromNodeId);

    while (cursor < queue.length && budget.exhausted === null && !foundTarget) {
      const nodeId = queue[cursor]!;
      cursor += 1;
      budget.nodesExpanded += 1;
      const incident = this.nodeToEdgeIds.get(nodeId);
      if (incident === undefined) continue;
      for (const edgeId of incident) {
        if (budget.exhausted !== null || foundTarget) break;
        if (!budget.tryEdge()) break;
        const edge = this.edgeMap.get(edgeId);
        if (edge === undefined) continue;
        const direction: EdgeDirection = edge.from === nodeId ? 'forward' : 'reverse';
        if (direction === 'reverse' && (edge.directed || edge.to !== nodeId)) continue;
        const edgeFrom = this.nodeMap.get(edge.from);
        const edgeTo = this.nodeMap.get(edge.to);
        if (edgeFrom?.location.kind !== 'exact' || edgeTo?.location.kind !== 'exact') continue;
        const usability = directionUsability(edge, direction, options.mode, now);
        if (!usability.usable) {
          const gap = usabilityGap(usability.reason);
          if (gap !== undefined) recordGap(gap, edge);
          continue;
        }
        const resolved = resolveSearchEdge(
          edge,
          direction,
          edgeFrom.location.pos,
          edgeTo.location.pos,
          this.worldId,
          options.mode,
          budget,
          readTraversal,
          readFragmentScope,
        );
        if (resolved.budgetExhausted) {
          // Preserve gaps confirmed before the budget ran out; the unread
          // references are never marked missing, and the edge is not traversed.
          if (resolved.gap !== undefined) recordGap(resolved.gap, edge, resolved.evidenceIds);
          break;
        }
        if (resolved.gap !== undefined) {
          recordGap(resolved.gap, edge, resolved.evidenceIds);
          continue;
        }
        if (!resolved.usable) continue; // known-mode mismatch is a normal filter, not a gap
        const neighborId = direction === 'forward' ? edge.to : edge.from;
        if (visited.has(neighborId)) continue;
        const neighbor = readNode(neighborId);
        if (budget.exhausted !== null) break;
        if (neighbor === null) continue; // defensive; edges guarantee endpoints exist
        visited.add(neighborId);
        order.push(neighborId);
        queue.push(neighborId);
        depth.set(neighborId, (depth.get(nodeId) ?? 0) + 1);
        nodes.set(neighborId, neighbor);
        parent.set(neighborId, {
          viaNode: nodeId,
          viaEdge: edge,
          direction,
          witness: resolved.witness!,
        });
        if (toNodeId !== undefined && neighborId === toNodeId) foundTarget = true;
      }
    }

    return finish();
  }

  // --- internals ---

  private listFragments(dim: string): PathFragment[] {
    const list = this.history.listFragments?.bind(this.history);
    if (list === undefined) {
      throw new Error(`history source does not support fragment listing`);
    }
    const out: PathFragment[] = [];
    let after: string | undefined;
    for (;;) {
      const page = list({ dim, after });
      out.push(...page.items);
      if (page.nextAfter === undefined) return out;
      after = page.nextAfter;
    }
  }

  private listTraversalLinks(dim: string): { a: Vec3Like; b: Vec3Like }[] {
    const list = this.history.listTraversals?.bind(this.history);
    if (list === undefined) return [];
    const links: { a: Vec3Like; b: Vec3Like }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = list({ dim, after });
      for (const evidence of page.items) {
        links.push({
          a: { ...evidence.from },
          b: { ...evidence.to },
        });
      }
      if (page.nextAfter === undefined) return links;
      after = page.nextAfter;
    }
  }

  private evictOldestProgramNode(): boolean {
    for (let i = 0; i < this.programNodeOrder.length; ) {
      const id = this.programNodeOrder[i]!;
      const node = this.nodeMap.get(id);
      if (node === undefined || node.source !== 'program') {
        this.programNodeOrder.splice(i, 1);
        continue;
      }
      if (node.durable === true) {
        i += 1;
        continue;
      }
      if ((this.nodeToEdgeIds.get(id)?.size ?? 0) > 0 || this.portalEdgeIdsForNode(id).length > 0) {
        i += 1;
        continue;
      }
      this.nodeMap.delete(id);
      this.nodeToEdgeIds.delete(id);
      this.programNodeOrder.splice(i, 1);
      this.invalidateNodeComponent(id);
      this.invalidateNodeListing();
      return true;
    }
    return false;
  }

  /** Portal edge ids whose endpoints reference `nodeId` (separate from walk edges). */
  private portalEdgeIdsForNode(nodeId: string): string[] {
    const ids: string[] = [];
    for (const edge of this.portalEdgeMap.values()) {
      if (edge.from === nodeId || edge.to === nodeId) ids.push(edge.id);
    }
    return ids.sort();
  }

  private invalidateEdgeComponents(edge: StoredEdge): void {
    this.invalidateNodeComponent(edge.from);
    this.invalidateNodeComponent(edge.to);
  }

  /** Drop the cached component membership of the component containing `nodeId`. */
  private invalidateNodeComponent(nodeId: string): void {
    const node = this.nodeMap.get(nodeId);
    if (node === undefined) return;
    const cache = this.componentCache.get(node.dim);
    if (cache === undefined) return;
    const component = cache.get(nodeId);
    if (component === undefined) {
      cache.delete(nodeId);
      return;
    }
    for (const [cachedId, cachedComponent] of [...cache]) {
      if (cachedComponent === component) cache.delete(cachedId);
    }
  }

  private invalidateNodeListing(): void {
    this.nodeListingIndex = null;
  }

  private invalidateEdgeListing(): void {
    this.edgeListingIndex = null;
  }

  /** The node listing index, rebuilt from `nodeMap` when a write invalidated it. */
  private getNodeListingIndex(): NodeListingIndex {
    const cached = this.nodeListingIndex;
    if (cached !== null) return cached;
    const byDim = new Map<string, string[]>();
    const bySource = new Map<NodeSource, string[]>();
    const byTag = new Map<LandmarkTag, string[]>();
    const byLabel = new Map<string, string[]>();
    const push = <K>(bucket: Map<K, string[]>, key: K, id: string): void => {
      const list = bucket.get(key);
      if (list === undefined) bucket.set(key, [id]);
      else list.push(id);
    };
    // Map insertion order is not id order; sort once per bucket so a page is a
    // slice, and keep each bucket in the same ascending order `selectPage` assumes.
    for (const node of this.nodeMap.values()) {
      push(byDim, node.dim, node.id);
      push(bySource, node.source, node.id);
      if (node.tag !== undefined) push(byTag, node.tag, node.id);
      if (node.label !== undefined) push(byLabel, node.label, node.id);
    }
    const all = [...this.nodeMap.keys()].sort();
    for (const bucket of [byDim, bySource, byTag, byLabel]) {
      for (const list of bucket.values()) list.sort();
    }
    const index: NodeListingIndex = { all, byDim, bySource, byTag, byLabel };
    this.nodeListingIndex = index;
    return index;
  }

  /** The edge listing index, rebuilt from `edgeMap` when a write invalidated it. */
  private getEdgeListingIndex(): EdgeListingIndex {
    const cached = this.edgeListingIndex;
    if (cached !== null) return cached;
    const byDim = new Map<string, string[]>();
    const byFrom = new Map<string, string[]>();
    const byTo = new Map<string, string[]>();
    const byType = new Map<ConnectionType, string[]>();
    const byBasis = new Map<EdgeBasis, string[]>();
    const push = <K>(bucket: Map<K, string[]>, key: K, id: string): void => {
      const list = bucket.get(key);
      if (list === undefined) bucket.set(key, [id]);
      else list.push(id);
    };
    for (const edge of this.edgeMap.values()) {
      // Every stored edge's `from` node exists: save/restore reject a missing
      // endpoint, and a referenced node cannot be forgotten or evicted.
      push(byDim, this.nodeMap.get(edge.from)!.dim, edge.id);
      push(byFrom, edge.from, edge.id);
      push(byTo, edge.to, edge.id);
      push(byType, edge.type, edge.id);
      push(byBasis, edge.basis, edge.id);
    }
    const all = [...this.edgeMap.keys()].sort();
    for (const bucket of [byDim, byFrom, byTo, byType, byBasis]) {
      for (const list of bucket.values()) list.sort();
    }
    const index: EdgeListingIndex = { all, byDim, byFrom, byTo, byType, byBasis };
    this.edgeListingIndex = index;
    return index;
  }

  private countNodes(source: NodeSource): number {
    let count = 0;
    for (const node of this.nodeMap.values()) if (node.source === source) count += 1;
    return count;
  }

  private validateEdgeShape(edge: TopologyEdge): {
    fromPos: Vec3Like;
    toPos: Vec3Like;
    dim: string;
    directed: boolean;
    modes: MoveMode[];
  } {
    if (typeof edge.id !== 'string' || edge.id.length === 0) {
      throw new Error(`edge id must be a non-empty string`);
    }
    if (edge.type === 'PORTAL') {
      throw new Error(`PORTAL edges use savePortalEdge and never enter the walk graph`);
    }
    if (!NON_PORTAL_CONNECTION_TYPES.includes(edge.type)) {
      throw new Error(`edge type "${String(edge.type)}" is not a known connection type`);
    }
    const directed = resolveEdgeDirected(edge.directed);
    const modes = snapshotEdgeModes(edge.modes);
    if (edge.basis !== 'candidate' && edge.basis !== 'traversed') {
      throw new Error(`edge basis "${String(edge.basis)}" is not known (candidate|traversed)`);
    }
    if (typeof edge.from !== 'string' || edge.from.length === 0) {
      throw new Error(`edge from must be a non-empty node id`);
    }
    if (typeof edge.to !== 'string' || edge.to.length === 0) {
      throw new Error(`edge to must be a non-empty node id`);
    }
    if (edge.fragmentId !== undefined && (typeof edge.fragmentId !== 'string' || edge.fragmentId.length === 0)) {
      throw new Error(`edge fragmentId must be a non-empty string when present`);
    }
    if (edge.source !== undefined && (typeof edge.source !== 'string' || edge.source.length === 0)) {
      throw new Error(`edge source must be a non-empty string when present`);
    }

    const fromNode = this.nodeMap.get(edge.from);
    const toNode = this.nodeMap.get(edge.to);
    if (fromNode === undefined) {
      throw new Error(`edge references unknown node "${edge.from}"`);
    }
    if (toNode === undefined) {
      throw new Error(`edge references unknown node "${edge.to}"`);
    }
    if (fromNode.dim !== toNode.dim) {
      throw new Error(`edge endpoints span dimensions "${fromNode.dim}" and "${toNode.dim}"`);
    }
    if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
      throw new Error(`edge endpoints must be exact locations, not regions`);
    }
    return {
      fromPos: fromNode.location.pos,
      toPos: toNode.location.pos,
      dim: fromNode.dim,
      directed,
      modes,
    };
  }

  private resolveRefs(
    edge: TopologyEdge,
    fromPos: Vec3Like,
    toPos: Vec3Like,
    dim: string,
    directed: boolean,
  ): StoredEvidenceRef[] {
    const evidenceIds = edge.evidenceIds ?? [];
    if (!Array.isArray(evidenceIds)) {
      throw new Error(`edge evidenceIds must be an array`);
    }
    if (edge.basis === 'candidate') {
      if (evidenceIds.length !== 0) {
        throw new Error(`candidate edges must not reference traversal evidence`);
      }
      return [];
    }
    if (evidenceIds.length === 0) {
      throw new Error(`traversed edges must reference at least one traversal evidence`);
    }
    if (evidenceIds.length > this.limits.maxEdgeEvidenceRefs) {
      throw new Error(
        `edge references ${evidenceIds.length} evidence, exceeding ${this.limits.maxEdgeEvidenceRefs}`,
      );
    }
    // Iterate by index rather than `map`: `map` skips holes, so a sparse array
    // would silently pass the length check while resolving no evidence. Visiting
    // each index makes every hole surface as a non-string id and be rejected.
    const refs: StoredEvidenceRef[] = [];
    for (let i = 0; i < evidenceIds.length; i++) {
      refs.push(
        this.resolveEvidenceRef(evidenceIds[i], edge.fragmentId, fromPos, toPos, dim, directed),
      );
    }
    return refs;
  }

  /** Reuse the existing binding when the update does not rebind evidence. */
  private preservedRefs(merged: TopologyEdge, existing: StoredEdge): StoredEvidenceRef[] {
    if (merged.basis === 'candidate') return [];
    if (existing.refs.length === 0) {
      throw new Error(`traversed edges must reference at least one traversal evidence`);
    }
    // Even without rebinding, a changed `fragmentId` must stay consistent with the
    // bound evidence; otherwise an unrelated update could point the edge at a
    // fragment the evidence never belonged to.
    if (merged.fragmentId !== undefined) {
      for (const ref of existing.refs) {
        if (ref.snapshot.fragmentId !== merged.fragmentId) {
          throw new Error(
            `edge fragmentId "${merged.fragmentId}" does not match evidence fragment "${ref.snapshot.fragmentId}"`,
          );
        }
      }
    }
    return existing.refs;
  }

  private assembleStoredEdge(
    edge: TopologyEdge,
    refs: StoredEvidenceRef[],
    verifications: EdgeVerification[],
  ): StoredEdge {
    const stored: StoredEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      basis: edge.basis,
      refs,
      directed: resolveEdgeDirected(edge.directed),
      modes: snapshotEdgeModes(edge.modes),
      verifications: verifications.map(cloneEdgeVerification),
    };
    if (edge.fragmentId !== undefined) stored.fragmentId = edge.fragmentId;
    if (edge.source !== undefined) stored.source = edge.source;
    return stored;
  }

  private resolveEvidenceRef(
    evidenceId: string | undefined,
    edgeFragmentId: string | undefined,
    fromPos: Vec3Like,
    toPos: Vec3Like,
    dim: string,
    directed = true,
  ): StoredEvidenceRef {
    if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
      throw new Error(`edge evidence id must be a non-empty string`);
    }
    const evidence = this.history.getTraversal(evidenceId);
    if (evidence === null) {
      throw new Error(`edge references unknown traversal evidence "${evidenceId}"`);
    }
    const fragment = this.history.getFragment(evidence.fragmentId);
    if (fragment === null) {
      throw new Error(`edge evidence "${evidenceId}" references unknown fragment "${evidence.fragmentId}"`);
    }
    if (evidence.worldId !== this.worldId) {
      throw new Error(`edge evidence "${evidenceId}" worldId does not match store worldId`);
    }
    if (fragment.worldId !== this.worldId || fragment.dim !== dim) {
      throw new Error(`edge evidence "${evidenceId}" fragment world/dim does not match`);
    }
    if (evidence.dim !== dim) {
      throw new Error(`edge evidence "${evidenceId}" dim does not match endpoint dim`);
    }
    const forwardMatch = pointsEqual(evidence.from, fromPos) && pointsEqual(evidence.to, toPos);
    const reverseMatch = pointsEqual(evidence.from, toPos) && pointsEqual(evidence.to, fromPos);
    if (!forwardMatch && !(directed === false && reverseMatch)) {
      throw new Error(`edge evidence "${evidenceId}" endpoints do not match edge from→to`);
    }
    if (edgeFragmentId !== undefined && edgeFragmentId !== evidence.fragmentId) {
      throw new Error(`edge fragmentId "${edgeFragmentId}" does not match evidence fragment "${evidence.fragmentId}"`);
    }
    return { evidenceId, snapshot: cloneTraversalEvidence(evidence) };
  }

  private toEdgeView(stored: StoredEdge): EdgeView {
    const references = stored.refs.map((ref) => this.resolveRef(ref));
    let resolution: ReferenceStatus | null = null;
    if (stored.basis === 'traversed') {
      if (references.some((ref) => ref.status === 'missing')) resolution = 'missing';
      else if (references.some((ref) => ref.status === 'mismatch')) resolution = 'mismatch';
      else resolution = 'resolved';
    }
    return {
      id: stored.id,
      from: stored.from,
      to: stored.to,
      type: stored.type,
      fragmentId: stored.fragmentId,
      basis: stored.basis,
      source: stored.source,
      evidenceIds: stored.refs.map((ref) => ref.evidenceId),
      directed: stored.directed,
      modes: [...stored.modes],
      verifications: stored.verifications.map(cloneEdgeVerification),
      references,
      resolution,
      runtime: runtimeView(stored.id, stored, this.now()),
    };
  }

  private resolveRef(ref: StoredEvidenceRef): EdgeReference {
    const current = this.history.getTraversal(ref.evidenceId);
    // Re-check the owning fragment, not just the traversal record: a history source
    // that does not cascade (unlike FragmentStore) may still serve a traversal whose
    // fragment is gone or whose scope has drifted. Either case must not read as resolved.
    const scope = current === null ? null : this.readFragmentScope(current.fragmentId);
    const status = classifyReference(this.worldId, ref.snapshot, current, scope);
    return {
      evidenceId: ref.evidenceId,
      status,
      snapshot: cloneTraversalEvidence(ref.snapshot),
      current: current === null ? null : cloneTraversalEvidence(current),
    };
  }

  /** Read a fragment's scope via the light entry when available, else `getFragment` (scope only). */
  private readFragmentScope(fragmentId: string): { worldId: string; dim: string } | null {
    if (this.history.getFragmentScope !== undefined) {
      const scope = this.history.getFragmentScope(fragmentId);
      return scope === null ? null : { worldId: scope.worldId, dim: scope.dim };
    }
    const fragment = this.history.getFragment(fragmentId);
    return fragment === null ? null : { worldId: fragment.worldId, dim: fragment.dim };
  }

  private indexEdge(stored: StoredEdge): void {
    addToNodeEdgeIndex(this.nodeToEdgeIds, stored.from, stored.id);
    addToNodeEdgeIndex(this.nodeToEdgeIds, stored.to, stored.id);
  }

  private unindexEdge(stored: StoredEdge): void {
    removeFromNodeEdgeIndex(this.nodeToEdgeIds, stored.from, stored.id);
    removeFromNodeEdgeIndex(this.nodeToEdgeIds, stored.to, stored.id);
  }

  /** Restore one portal edge from its checkpoint form (raw traversals only). */
  private restorePortalEdge(
    raw: TopologyPortalEdgeSnapshot,
    nodes: Map<string, SpatialNode>,
  ): StoredPortalEdge {
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error(`portal edge id must be a non-empty string`);
    }
    if (typeof raw.from !== 'string' || raw.from.length === 0) {
      throw new Error(`portal edge from must be a non-empty node id`);
    }
    if (typeof raw.to !== 'string' || raw.to.length === 0) {
      throw new Error(`portal edge to must be a non-empty node id`);
    }
    if (typeof raw.directed !== 'boolean') {
      throw new Error(`portal edge directed must be a boolean`);
    }
    if (raw.fragmentId !== undefined && (typeof raw.fragmentId !== 'string' || raw.fragmentId.length === 0)) {
      throw new Error(`portal edge fragmentId must be a non-empty string when present`);
    }
    if (raw.source !== undefined && (typeof raw.source !== 'string' || raw.source.length === 0)) {
      throw new Error(`portal edge source must be a non-empty string when present`);
    }
    const fromNode = nodes.get(raw.from);
    const toNode = nodes.get(raw.to);
    if (fromNode === undefined) {
      throw new Error(`portal edge "${raw.id}" references unknown node "${raw.from}"`);
    }
    if (toNode === undefined) {
      throw new Error(`portal edge "${raw.id}" references unknown node "${raw.to}"`);
    }
    if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
      throw new Error(`portal edge "${raw.id}" endpoints must be exact locations`);
    }
    if (!Array.isArray(raw.traversals) || raw.traversals.length === 0) {
      throw new Error(`portal edge "${raw.id}" must carry at least one traversal`);
    }
    if (raw.traversals.length > this.limits.maxPortalTraversalsPerEdge) {
      throw new Error(
        `portal edge "${raw.id}" has ${raw.traversals.length} traversals, exceeding ${this.limits.maxPortalTraversalsPerEdge}`,
      );
    }
    const traversals: PortalTraversalEvidence[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.traversals.length; i++) {
      const traversal = snapshotPortalTraversal(raw.traversals[i]!);
      if (traversal.edgeId !== raw.id) {
        throw new Error(`portal traversal "${traversal.id}" does not belong to edge "${raw.id}"`);
      }
      if (traversal.direction === 'reverse' && raw.directed) {
        throw new Error(`directed portal "${raw.id}" has a reverse traversal`);
      }
      if (seen.has(traversal.id)) {
        throw new Error(`duplicate portal traversal id "${traversal.id}"`);
      }
      seen.add(traversal.id);
      traversals.push(traversal);
    }
    if (!traversals.some((t) => t.direction === 'forward')) {
      throw new Error(`portal edge "${raw.id}" has no outbound traversal`);
    }
    const stored: StoredPortalEdge = {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      directed: raw.directed,
      traversals,
    };
    if (raw.fragmentId !== undefined) stored.fragmentId = raw.fragmentId;
    if (raw.source !== undefined) stored.source = raw.source;
    return stored;
  }

  /**
   * Restore one edge from its checkpoint form without going through `saveEdge`.
   * Validates shape, endpoint existence/scope, and binding internal consistency,
   * but never reads or requires the authoritative history, so a binding whose
   * evidence has since been deleted or replaced is preserved verbatim.
   */
  private restoreEdge(raw: TopologyEdgeSnapshot, nodes: Map<string, SpatialNode>): StoredEdge {
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error(`edge id must be a non-empty string`);
    }
    if (raw.type === 'PORTAL') {
      throw new Error(`PORTAL edges are not supported in this phase`);
    }
    if (!NON_PORTAL_CONNECTION_TYPES.includes(raw.type)) {
      throw new Error(`edge type "${String(raw.type)}" is not a known connection type`);
    }
    if (raw.basis !== 'candidate' && raw.basis !== 'traversed') {
      throw new Error(`edge basis "${String(raw.basis)}" is not known (candidate|traversed)`);
    }
    if (typeof raw.from !== 'string' || raw.from.length === 0) {
      throw new Error(`edge from must be a non-empty node id`);
    }
    if (typeof raw.to !== 'string' || raw.to.length === 0) {
      throw new Error(`edge to must be a non-empty node id`);
    }
    if (raw.fragmentId !== undefined && (typeof raw.fragmentId !== 'string' || raw.fragmentId.length === 0)) {
      throw new Error(`edge fragmentId must be a non-empty string when present`);
    }
    if (raw.source !== undefined && (typeof raw.source !== 'string' || raw.source.length === 0)) {
      throw new Error(`edge source must be a non-empty string when present`);
    }

    const fromNode = nodes.get(raw.from);
    const toNode = nodes.get(raw.to);
    if (fromNode === undefined) {
      throw new Error(`edge "${raw.id}" references unknown node "${raw.from}"`);
    }
    if (toNode === undefined) {
      throw new Error(`edge "${raw.id}" references unknown node "${raw.to}"`);
    }
    if (fromNode.dim !== toNode.dim) {
      throw new Error(`edge "${raw.id}" endpoints span dimensions "${fromNode.dim}" and "${toNode.dim}"`);
    }
    if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
      throw new Error(`edge "${raw.id}" endpoints must be exact locations, not regions`);
    }

    const directed = raw.directed === undefined ? true : raw.directed;
    if (typeof directed !== 'boolean') {
      throw new Error(`edge "${raw.id}" directed must be a boolean when present`);
    }
    const modes = snapshotEdgeModes(raw.modes);
    if (raw.verifications !== undefined && !Array.isArray(raw.verifications)) {
      throw new Error(`edge "${raw.id}" verifications must be an array`);
    }
    const verifications = (raw.verifications ?? []).reduce<EdgeVerification[]>((acc, rawVerification) => {
      const verification = snapshotEdgeVerification(rawVerification, this.now(), directed, {
        allowExpiredOpen: true,
      });
      if (modes.length > 0 && !modes.includes(verification.mode)) {
        throw new Error(
          `edge "${raw.id}" verification mode "${verification.mode}" is not one of its recorded modes`,
        );
      }
      return withVerification(acc, verification);
    }, []);

    const refs: StoredEvidenceRef[] = [];
    const rawRefs = raw.refs;
    if (!Array.isArray(rawRefs)) {
      throw new Error(`edge "${raw.id}" refs must be an array`);
    }
    if (raw.basis === 'candidate') {
      if (rawRefs.length !== 0) {
        throw new Error(`candidate edges must not reference traversal evidence`);
      }
    } else {
      if (rawRefs.length === 0) {
        throw new Error(`traversed edges must reference at least one traversal evidence`);
      }
      if (rawRefs.length > this.limits.maxEdgeEvidenceRefs) {
        throw new Error(
          `edge "${raw.id}" references ${rawRefs.length} evidence, exceeding ${this.limits.maxEdgeEvidenceRefs}`,
        );
      }
    }
    for (let i = 0; i < rawRefs.length; i++) {
      refs.push(
        restoreEvidenceRef(
          this.worldId,
          raw.id,
          rawRefs[i],
          fromNode,
          toNode,
          raw.fragmentId,
          directed,
        ),
      );
    }

    const stored: StoredEdge = {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      type: raw.type,
      basis: raw.basis,
      refs,
      directed,
      modes,
      verifications,
    };
    if (raw.fragmentId !== undefined) stored.fragmentId = raw.fragmentId;
    if (raw.source !== undefined) stored.source = raw.source;
    return stored;
  }
}

// --- validation + snapshotting (snapshot first, then write, so a failed write leaves no half state) ---

function snapshotNode(worldId: string, n: SpatialNode, limits: ResolvedLimits): SpatialNode {
  if (n.worldId !== worldId) {
    throw new Error(`node worldId "${n.worldId}" does not match store worldId "${worldId}"`);
  }
  if (typeof n.id !== 'string' || n.id.length === 0) {
    throw new Error(`node id must be a non-empty string`);
  }
  if (typeof n.dim !== 'string' || n.dim.length === 0) {
    throw new Error(`node dim must be a non-empty string`);
  }
  if (!NODE_KINDS.includes(n.kind)) {
    throw new Error(`node kind "${String(n.kind)}" is not a known kind`);
  }
  if (!NODE_SOURCES.includes(n.source)) {
    throw new Error(`node source "${String(n.source)}" is not a known source`);
  }
  if (n.tag !== undefined && !LANDMARK_TAGS.includes(n.tag)) {
    throw new Error(`node tag "${String(n.tag)}" is not a known tag`);
  }
  if (n.label !== undefined && typeof n.label !== 'string') {
    throw new Error(`node label must be a string when present`);
  }
  if (n.observedAt !== undefined && !Number.isFinite(n.observedAt)) {
    throw new Error(`node observedAt must be a finite number when present`);
  }
  if (n.externalRef !== undefined && (typeof n.externalRef !== 'string' || n.externalRef.length === 0)) {
    throw new Error(`node externalRef must be a non-empty string when present`);
  }
  if (n.durable !== undefined && typeof n.durable !== 'boolean') {
    throw new Error(`node durable must be a boolean when present`);
  }
  if (n.metadata !== undefined) snapshotJsonObject(n.metadata, 'node metadata', limits.json);
  if (n.gone !== undefined && typeof n.gone !== 'boolean') {
    throw new Error(`node gone must be a boolean when present`);
  }
  if (n.gone === true) {
    if (!Number.isFinite(n.goneAt)) {
      throw new Error(`a gone node must carry a finite goneAt`);
    }
    if (n.goneEvidence !== undefined) validateGoneEvidence(n.goneEvidence);
  } else if (n.goneAt !== undefined || n.goneEvidence !== undefined) {
    throw new Error(`goneAt/goneEvidence are only valid when gone is true`);
  }
  validateLocation(n.location);
  return cloneNode(n);
}

function validateLocation(loc: SpatialNode['location']): void {
  if (loc === null || typeof loc !== 'object') {
    throw new Error(`node location must be an exact or region object`);
  }
  const kind = (loc as { kind: unknown }).kind;
  if (kind === 'exact') {
    assertFinitePoint((loc as { pos: Vec3Like }).pos, 'node exact position');
    return;
  }
  if (kind === 'region') {
    const region = loc as { center: Vec3Like; radius: number };
    assertFinitePoint(region.center, 'node region center');
    if (!Number.isFinite(region.radius) || region.radius < 0) {
      throw new Error(`node region radius must be a non-negative finite number: ${region.radius}`);
    }
    return;
  }
  throw new Error(`node location kind "${String(kind)}" is not known`);
}

function cloneNode(n: SpatialNode): SpatialNode {
  const clone: SpatialNode = {
    id: n.id,
    kind: n.kind,
    source: n.source,
    tag: n.tag,
    label: n.label,
    worldId: n.worldId,
    dim: n.dim,
    location: cloneLocation(n.location),
  };
  if (n.observedAt !== undefined) clone.observedAt = n.observedAt;
  if (n.externalRef !== undefined) clone.externalRef = n.externalRef;
  if (n.durable !== undefined) clone.durable = n.durable;
  if (n.metadata !== undefined) clone.metadata = cloneJsonObject(n.metadata);
  if (n.gone !== undefined) clone.gone = n.gone;
  if (n.goneAt !== undefined) clone.goneAt = n.goneAt;
  if (n.goneEvidence !== undefined) clone.goneEvidence = cloneGoneEvidence(n.goneEvidence);
  return clone;
}

function cloneGoneEvidence(e: GoneEvidence): GoneEvidence {
  const clone: GoneEvidence = {
    sessionId: e.sessionId,
    observedAt: e.observedAt,
    source: e.source,
  };
  if (e.observationIds !== undefined) clone.observationIds = [...e.observationIds];
  if (e.reason !== undefined) clone.reason = e.reason;
  return clone;
}

function cloneLocation(loc: SpatialNode['location']): SpatialNode['location'] {
  if (loc.kind === 'exact') {
    return { kind: 'exact', pos: clonePoint(loc.pos) };
  }
  return { kind: 'region', center: clonePoint(loc.center), radius: loc.radius };
}

function nodesEqual(a: SpatialNode, b: SpatialNode): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.tag === b.tag &&
    a.label === b.label &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    a.observedAt === b.observedAt &&
    a.externalRef === b.externalRef &&
    a.durable === b.durable &&
    jsonObjectsEqual(a.metadata, b.metadata) &&
    a.gone === b.gone &&
    a.goneAt === b.goneAt &&
    goneEvidenceEqual(a.goneEvidence, b.goneEvidence) &&
    locationsEqual(a.location, b.location)
  );
}

function goneEvidenceEqual(a: GoneEvidence | undefined, b: GoneEvidence | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.sessionId === b.sessionId &&
    a.observedAt === b.observedAt &&
    a.source === b.source &&
    a.reason === b.reason &&
    (a.observationIds?.length ?? 0) === (b.observationIds?.length ?? 0) &&
    (a.observationIds ?? []).every((id, i) => id === b.observationIds![i])
  );
}

function locationsEqual(a: SpatialNode['location'], b: SpatialNode['location']): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') {
    return pointsEqual(a.pos, b.pos);
  }
  if (a.kind === 'region' && b.kind === 'region') {
    return pointsEqual(a.center, b.center) && a.radius === b.radius;
  }
  return false;
}

function applyNodeChanges(existing: SpatialNode, changes: NodeChanges): SpatialNode {
  const merged: SpatialNode = {
    id: existing.id,
    worldId: existing.worldId,
    dim: existing.dim,
    source: existing.source,
    kind: 'kind' in changes ? (changes.kind as NodeKind) : existing.kind,
    tag: 'tag' in changes ? changes.tag : existing.tag,
    label: 'label' in changes ? changes.label : existing.label,
    location: 'location' in changes ? (changes.location as SpatialNode['location']) : existing.location,
    observedAt: 'observedAt' in changes ? changes.observedAt : existing.observedAt,
    externalRef: 'externalRef' in changes ? changes.externalRef : existing.externalRef,
    durable: 'durable' in changes ? changes.durable : existing.durable,
    metadata: 'metadata' in changes ? changes.metadata : existing.metadata,
  };
  if (existing.gone !== undefined) merged.gone = existing.gone;
  if (existing.goneAt !== undefined) merged.goneAt = existing.goneAt;
  if (existing.goneEvidence !== undefined) merged.goneEvidence = existing.goneEvidence;
  return merged;
}

function storedEdgesEqual(a: StoredEdge, b: StoredEdge): boolean {
  return (
    a.id === b.id &&
    a.from === b.from &&
    a.to === b.to &&
    a.type === b.type &&
    a.fragmentId === b.fragmentId &&
    a.basis === b.basis &&
    a.source === b.source &&
    a.directed === b.directed &&
    a.modes.length === b.modes.length &&
    a.modes.every((mode, i) => mode === b.modes[i]) &&
    edgeVerificationsEqual(a.verifications, b.verifications) &&
    refsEqual(a.refs, b.refs)
  );
}

function refsEqual(a: StoredEvidenceRef[], b: StoredEvidenceRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (ref, i) =>
      ref.evidenceId === b[i]!.evidenceId &&
      traversalEvidenceEqual(ref.snapshot, b[i]!.snapshot),
  );
}

function applyEdgeChanges(existing: StoredEdge, changes: EdgeChanges): TopologyEdge {
  return {
    id: existing.id,
    from: existing.from,
    to: existing.to,
    type: 'type' in changes ? (changes.type as ConnectionType) : existing.type,
    fragmentId: 'fragmentId' in changes ? changes.fragmentId : existing.fragmentId,
    basis: 'basis' in changes ? (changes.basis as EdgeBasis) : existing.basis,
    source: 'source' in changes ? changes.source : existing.source,
    evidenceIds: 'evidenceIds' in changes ? (changes.evidenceIds ?? []) : existing.refs.map((ref) => ref.evidenceId),
    directed: 'directed' in changes ? (changes.directed as boolean) : existing.directed,
    modes: 'modes' in changes ? (changes.modes as MoveMode[]) : existing.modes,
  };
}

function clonePoint(p: Vec3Like): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function assertFinitePoint(p: Vec3Like, label: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    throw new Error(`${label} must have finite coordinates: (${p.x}, ${p.y}, ${p.z})`);
  }
}

function validateGoneEvidence(e: GoneEvidence): void {
  if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
    throw new Error(`gone evidence requires a non-empty sessionId`);
  }
  if (!Number.isFinite(e.observedAt) || e.observedAt < 0) {
    throw new Error(`gone evidence requires a non-negative finite observedAt`);
  }
  if (typeof e.source !== 'string' || e.source.length === 0) {
    throw new Error(`gone evidence requires a non-empty source`);
  }
  if (e.observationIds !== undefined) {
    if (!Array.isArray(e.observationIds)) {
      throw new Error(`gone evidence observationIds must be an array when present`);
    }
    for (const id of e.observationIds) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`gone evidence observationIds must contain non-empty strings`);
      }
    }
  }
  if (e.reason !== undefined && typeof e.reason !== 'string') {
    throw new Error(`gone evidence reason must be a string when present`);
  }
}

function distanceToLocation(location: SpatialNode['location'], pos: Vec3Like): number {
  const center = location.kind === 'exact' ? location.pos : location.center;
  return Math.hypot(center.x - pos.x, center.y - pos.y, center.z - pos.z);
}

function yOf(node: SpatialNode): number {
  return node.location.kind === 'exact' ? node.location.pos.y : node.location.center.y;
}

function assertUniquePortalTraversalIds(traversals: PortalTraversalEvidence[]): void {
  const seen = new Set<string>();
  for (const traversal of traversals) {
    if (seen.has(traversal.id)) {
      throw new Error(`duplicate portal traversal id "${traversal.id}"`);
    }
    seen.add(traversal.id);
  }
}

function storedPortalEdgesEqual(a: StoredPortalEdge, b: StoredPortalEdge): boolean {
  return (
    a.id === b.id &&
    a.from === b.from &&
    a.to === b.to &&
    a.directed === b.directed &&
    a.fragmentId === b.fragmentId &&
    a.source === b.source &&
    a.traversals.length === b.traversals.length &&
    a.traversals.every((t, i) => portalTraversalsEqual(t, b.traversals[i]!))
  );
}

function addToNodeEdgeIndex(index: Map<string, Set<string>>, nodeId: string, edgeId: string): void {
  let set = index.get(nodeId);
  if (set === undefined) {
    set = new Set();
    index.set(nodeId, set);
  }
  set.add(edgeId);
}

function removeFromNodeEdgeIndex(
  index: Map<string, Set<string>>,
  nodeId: string,
  edgeId: string,
): void {
  const set = index.get(nodeId);
  if (set === undefined) return;
  set.delete(edgeId);
  if (set.size === 0) index.delete(nodeId);
}

function resolveLimits(options: TopologyStoreOptions): ResolvedLimits {
  const limits: ResolvedLimits = { ...DEFAULT_LIMITS };
  const overrides: (keyof TopologyStoreOptions & keyof ResolvedLimits)[] = [
    'maxAgentNodes',
    'maxProgramNodes',
    'maxEdges',
    'maxEdgeEvidenceRefs',
    'maxQueryBatch',
    'maxQueryNodes',
    'maxQueryEdges',
    'maxQueryHistoryReads',
    'maxQueryDiagnostics',
    'maxPortalEdges',
    'maxPortalTraversalsPerEdge',
    'maxFragmentMerges',
  ];
  for (const key of overrides) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive integer: ${value}`);
    }
    limits[key] = value;
  }
  if (options.maxMetadataBytes !== undefined) {
    if (!Number.isInteger(options.maxMetadataBytes) || options.maxMetadataBytes < 1) {
      throw new Error(`maxMetadataBytes must be a positive integer: ${options.maxMetadataBytes}`);
    }
    limits.json = { ...limits.json, maxBytes: options.maxMetadataBytes };
  }
  return limits;
}

function clampLimit(limit: number | undefined, maxQueryBatch: number): number {
  if (limit === undefined) return maxQueryBatch;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer: ${limit}`);
  }
  return Math.min(limit, maxQueryBatch);
}

/** Select one page from an ascending-sorted id list; `after` is exclusive. */
function selectPage(
  sortedIds: string[],
  after: string | undefined,
  limit: number,
): { pageIds: string[]; nextAfter: string | undefined } {
  const start = after === undefined ? 0 : firstIndexAfter(sortedIds, after);
  const end = Math.min(start + limit, sortedIds.length);
  const pageIds = sortedIds.slice(start, end);
  const nextAfter = end < sortedIds.length ? sortedIds[end - 1] : undefined;
  return { pageIds, nextAfter };
}

function firstIndexAfter(sortedIds: string[], after: string): number {
  // Upper bound: the first id strictly greater than the exclusive cursor.
  let low = 0;
  let high = sortedIds.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedIds[mid]! <= after) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Select one page of `candidates` (ascending ids) that pass `matches`, with the
 * same `after`/`limit`/`nextAfter` semantics as `selectPage`. `total` is the
 * number of matching ids, independent of the page. This is the general filter
 * path for multi-condition queries; single-condition queries page their
 * materialized bucket directly.
 */
function selectFilteredPage(
  candidates: readonly string[],
  after: string | undefined,
  limit: number,
  matches: (id: string) => boolean,
): { pageIds: string[]; total: number; nextAfter: string | undefined } {
  let total = 0;
  let beforeCursor = 0;
  const pageIds: string[] = [];
  for (const id of candidates) {
    if (!matches(id)) continue;
    // `total` is the whole match count, independent of the cursor.
    total += 1;
    if (after !== undefined && id <= after) {
      beforeCursor += 1;
      continue;
    }
    if (pageIds.length < limit) pageIds.push(id);
  }
  const nextAfter =
    beforeCursor + pageIds.length < total ? pageIds[pageIds.length - 1] : undefined;
  return { pageIds, total, nextAfter };
}

// --- bounded query internals (phase 4C) ---

interface ParentEntry {
  viaNode: string;
  viaEdge: StoredEdge;
  direction: EdgeDirection;
  witness: { evidenceId: string; evidence: TraversalEvidence };
}

interface SearchOutput {
  from: string;
  to?: string;
  /** True only when endpoint validation succeeded and the target was confirmed reached. */
  foundTarget: boolean;
  order: string[];
  /** Hops from `from` for each confirmed reachable node (start = 0). */
  depth: Map<string, number>;
  /** Internal node snapshots for each confirmed reachable node (cloned at the public boundary). */
  nodes: Map<string, SpatialNode>;
  parent: Map<string, ParentEntry>;
  gaps: SearchGapKind[];
  diagnostics: SearchDiagnostic[];
  exhausted?: QueryBudgetKey;
  stats: QueryStats;
}

/** Resolved per-query budgets: defaults are the ceilings, zero is honored, values are clamped. */
interface ResolvedQueryBudget {
  maxNodes: number;
  maxEdges: number;
  maxHistoryReads: number;
  maxDiagnostics: number;
}

/** Counts work actually performed during one bounded query, honoring each ceiling. */
class SearchBudget {
  nodesRead = 0;
  nodesExpanded = 0;
  edgesChecked = 0;
  historyReads = 0;
  diagnostics = 0;
  diagnosticsTruncated = false;
  exhausted: QueryBudgetKey | null = null;

  constructor(private readonly limits: ResolvedQueryBudget) {}

  tryNode(): boolean {
    if (this.exhausted !== null) return false;
    if (this.nodesRead >= this.limits.maxNodes) {
      this.exhausted = 'maxNodes';
      return false;
    }
    this.nodesRead += 1;
    return true;
  }

  tryEdge(): boolean {
    if (this.exhausted !== null) return false;
    if (this.edgesChecked >= this.limits.maxEdges) {
      this.exhausted = 'maxEdges';
      return false;
    }
    this.edgesChecked += 1;
    return true;
  }

  tryHistoryRead(): boolean {
    if (this.exhausted !== null) return false;
    if (this.historyReads >= this.limits.maxHistoryReads) {
      this.exhausted = 'maxHistoryReads';
      return false;
    }
    this.historyReads += 1;
    return true;
  }

  addDiagnostic(): boolean {
    if (this.diagnostics >= this.limits.maxDiagnostics) {
      this.diagnosticsTruncated = true;
      return false;
    }
    this.diagnostics += 1;
    return true;
  }
}

function resolveQueryBudget(requested: QueryBudget | undefined, limits: ResolvedLimits): ResolvedQueryBudget {
  return {
    maxNodes: resolveQueryBudgetField('maxNodes', requested?.maxNodes, limits.maxQueryNodes),
    maxEdges: resolveQueryBudgetField('maxEdges', requested?.maxEdges, limits.maxQueryEdges),
    maxHistoryReads: resolveQueryBudgetField('maxHistoryReads', requested?.maxHistoryReads, limits.maxQueryHistoryReads),
    maxDiagnostics: resolveQueryBudgetField('maxDiagnostics', requested?.maxDiagnostics, limits.maxQueryDiagnostics),
  };
}

function resolveQueryBudgetField(key: string, value: number | undefined, ceiling: number): number {
  const v = value === undefined ? ceiling : value;
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${key} must be a non-negative safe integer: ${String(v)}`);
  }
  return Math.min(v, ceiling);
}

/**
 * Shared reference classification, reused by both the 4B read projection
 * (`resolveRef`) and the 4C search (`resolveSearchEdge`), so "resolved" means
 * the same thing everywhere. `fragmentScope` is the light scope read (or `null`
 * when the owning fragment is gone).
 */
function classifyReference(
  worldId: string,
  snapshot: TraversalEvidence,
  current: TraversalEvidence | null,
  fragmentScope: { worldId: string; dim: string } | null,
): ReferenceStatus {
  if (current === null) return 'missing';
  if (fragmentScope === null) return 'missing';
  if (fragmentScope.worldId !== worldId || fragmentScope.dim !== current.dim) return 'mismatch';
  return traversalEvidenceEqual(current, snapshot) ? 'resolved' : 'mismatch';
}

/** Map a usability rejection to a search gap; `mode_mismatch`/`no_direction` are normal filters. */
function usabilityGap(reason: ReturnType<typeof directionUsability>['reason']): SearchGapKind | undefined {
  if (reason === 'blocked') return 'blocked';
  if (reason === 'stale') return 'stale';
  if (reason === 'unsupported') return 'unsupported';
  return undefined;
}

/** Whether a direction has no explicit blocked/stale/unsupported verification. */
function adjacencyUsable(
  edge: StoredEdge,
  direction: EdgeDirection,
  now: number,
): boolean {
  const usability = directionUsability(edge, direction, undefined, now);
  return usability.reason === undefined || usability.reason === 'mode_mismatch' || usability.reason === 'no_direction';
}

/** Project a stored edge to its public `TopologyEdge` snapshot without resolving references. */
function toTopologyEdgeSnapshot(stored: StoredEdge): TopologyEdge {
  const edge: TopologyEdge = {
    id: stored.id,
    from: stored.from,
    to: stored.to,
    type: stored.type,
    basis: stored.basis,
    evidenceIds: stored.refs.map((ref) => ref.evidenceId),
    directed: stored.directed,
    modes: [...stored.modes],
    verifications: stored.verifications.map(cloneEdgeVerification),
  };
  if (stored.fragmentId !== undefined) edge.fragmentId = stored.fragmentId;
  if (stored.source !== undefined) edge.source = stored.source;
  return edge;
}

interface EdgeSearchResult {
  budgetExhausted: boolean;
  usable: boolean;
  witness?: { evidenceId: string; evidence: TraversalEvidence };
  gap?: SearchGapKind;
  evidenceIds?: string[];
}

/**
 * Resolve one out-edge for the search: `candidate` edges are a gap; `traversed`
 * edges must resolve every reference (reusing `classifyReference`) and then pass
 * the mode filter. A history read that cannot fit the budget stops the whole
 * search — the edge is never read as resolved, and unread references are never
 * marked missing — but any gap confirmed *before* the budget ran out is still
 * reported in `gap`/`evidenceIds` alongside `budgetExhausted: true`.
 */
function resolveSearchEdge(
  edge: StoredEdge,
  direction: EdgeDirection,
  fromPos: Vec3Like,
  toPos: Vec3Like,
  worldId: string,
  mode: MoveMode | undefined,
  budget: SearchBudget,
  readTraversal: (id: string) => TraversalEvidence | null,
  readFragmentScope: (id: string) => { worldId: string; dim: string } | null,
): EdgeSearchResult {
  if (edge.basis === 'candidate') {
    return { budgetExhausted: false, usable: false, gap: 'candidate' };
  }
  const resolved: { evidenceId: string; evidence: TraversalEvidence }[] = [];
  const gapEvidenceIds: string[] = [];
  let anyMissing = false;
  let anyMismatch = false;
  // A budget-exhausted stop still carries whatever gap was already confirmed,
  // without treating the still-unread reference as missing.
  const partial = (): EdgeSearchResult => {
    const gap: SearchGapKind | undefined = anyMissing ? 'missing' : anyMismatch ? 'mismatch' : undefined;
    return {
      budgetExhausted: true,
      usable: false,
      gap,
      evidenceIds: gap === undefined ? undefined : gapEvidenceIds,
    };
  };
  for (const ref of edge.refs) {
    const current = readTraversal(ref.evidenceId);
    if (budget.exhausted !== null) return partial();
    if (current === null) {
      anyMissing = true;
      gapEvidenceIds.push(ref.evidenceId);
      continue;
    }
    const scope = readFragmentScope(current.fragmentId);
    if (budget.exhausted !== null) return partial();
    const status = classifyReference(worldId, ref.snapshot, current, scope);
    if (status === 'missing') {
      anyMissing = true;
      gapEvidenceIds.push(ref.evidenceId);
    } else if (status === 'mismatch') {
      anyMismatch = true;
      gapEvidenceIds.push(ref.evidenceId);
    } else {
      resolved.push({ evidenceId: ref.evidenceId, evidence: current });
    }
  }
  if (anyMissing) return { budgetExhausted: false, usable: false, gap: 'missing', evidenceIds: gapEvidenceIds };
  if (anyMismatch) return { budgetExhausted: false, usable: false, gap: 'mismatch', evidenceIds: gapEvidenceIds };

  // Only evidence that actually traversed this direction can witness it. A
  // forward record never backs the reverse direction even on an undirected edge.
  const directional = resolved.filter((r) =>
    direction === 'forward'
      ? pointsEqual(r.evidence.from, fromPos) && pointsEqual(r.evidence.to, toPos)
      : pointsEqual(r.evidence.from, toPos) && pointsEqual(r.evidence.to, fromPos),
  );
  if (directional.length === 0) {
    // The edge is undirected but this direction was never traversed: a normal
    // historical absence, not a missing reference.
    return { budgetExhausted: false, usable: false };
  }
  if (mode === undefined) {
    return { budgetExhausted: false, usable: true, witness: pickWitness(directional) };
  }
  const matching = directional.filter((r) => r.evidence.mode === mode);
  if (matching.length > 0) {
    return { budgetExhausted: false, usable: true, witness: pickWitness(matching) };
  }
  const hasUnknownMode = directional.some((r) => r.evidence.mode === undefined);
  if (hasUnknownMode) {
    return {
      budgetExhausted: false,
      usable: false,
      gap: 'mode_unknown',
      evidenceIds: directional.map((r) => r.evidenceId),
    };
  }
  return { budgetExhausted: false, usable: false };
}

/** Pick the witness with the smallest evidenceId (lexicographic) for a stable, deterministic choice. */
function pickWitness(
  candidates: { evidenceId: string; evidence: TraversalEvidence }[],
): { evidenceId: string; evidence: TraversalEvidence } {
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i]!.evidenceId < best.evidenceId) best = candidates[i]!;
  }
  return { evidenceId: best.evidenceId, evidence: best.evidence };
}

// --- bounded historical reachable-anchor query internals (phase 4D) ---

function resolveIncludeStart(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error(`includeStart must be a boolean: ${String(value)}`);
  }
  return value;
}

function resolveOrder(value: AnchorOrder | undefined): AnchorOrder {
  if (value === undefined) return 'bfs';
  if (value !== 'bfs' && value !== 'highest' && value !== 'deepest') {
    throw new Error(`order "${String(value)}" is not known (bfs|highest|deepest)`);
  }
  return value;
}

function resolveLimit(value: number | undefined, maxQueryBatch: number): number {
  const v = value === undefined ? Math.min(20, maxQueryBatch) : value;
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new Error(`limit must be a positive safe integer: ${String(v)}`);
  }
  return Math.min(v, maxQueryBatch);
}

/** Sort matched candidates in place; height ties keep BFS discovery order. */
function sortMatched(
  matched: { node: SpatialNode; hops: number }[],
  order: AnchorOrder,
  bfsIndex: Map<string, number>,
): void {
  if (order === 'bfs') {
    matched.sort((a, b) => (bfsIndex.get(a.node.id) ?? 0) - (bfsIndex.get(b.node.id) ?? 0));
    return;
  }
  const y = (n: SpatialNode): number => (n.location.kind === 'exact' ? n.location.pos.y : 0);
  matched.sort((a, b) => {
    const ya = y(a.node);
    const yb = y(b.node);
    if (ya !== yb) return order === 'highest' ? yb - ya : ya - yb;
    return (bfsIndex.get(a.node.id) ?? 0) - (bfsIndex.get(b.node.id) ?? 0);
  });
}

/**
 * Build the union of BFS predecessor paths needed to reach `candidateIds` from
 * `from`, deduplicating shared prefixes and ordered predecessor-first (by the
 * `to` node's BFS discovery index).
 */
function buildProofSegments(
  from: string,
  candidateIds: string[],
  parent: Map<string, ParentEntry>,
  bfsIndex: Map<string, number>,
): RouteSegment[] {
  if (candidateIds.length === 0) return [];
  const collected = new Map<string, ParentEntry>(); // keyed by node id (the edge's `to`)
  for (const id of candidateIds) {
    let cursor = id;
    while (cursor !== from) {
      if (collected.has(cursor)) break; // shared prefix already collected
      const entry = parent.get(cursor);
      if (entry === undefined) break; // defensive; a confirmed candidate is always reachable
      collected.set(cursor, entry);
      cursor = entry.viaNode;
    }
  }
  const orderedIds = [...collected.keys()].sort(
    (a, b) => (bfsIndex.get(a) ?? 0) - (bfsIndex.get(b) ?? 0),
  );
  return orderedIds.map((id) => {
    const entry = collected.get(id)!;
    return {
      edgeId: entry.viaEdge.id,
      from: entry.viaEdge.from,
      to: entry.viaEdge.to,
      type: entry.viaEdge.type,
      direction: entry.direction,
      evidenceId: entry.witness.evidenceId,
      evidence: cloneTraversalEvidence(entry.witness.evidence),
    };
  });
}

// --- checkpoint restore + byte estimation (phase 5A) ---

/** Project a stored edge to its public checkpoint form, deep-copying binding snapshots. */
function toEdgeSnapshot(edge: StoredEdge): TopologyEdgeSnapshot {
  const out: TopologyEdgeSnapshot = {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    basis: edge.basis,
    refs: edge.refs.map((ref) => ({
      evidenceId: ref.evidenceId,
      snapshot: cloneTraversalEvidence(ref.snapshot),
    })),
    directed: edge.directed,
    modes: [...edge.modes],
    verifications: edge.verifications.map(cloneEdgeVerification),
  };
  if (edge.fragmentId !== undefined) out.fragmentId = edge.fragmentId;
  if (edge.source !== undefined) out.source = edge.source;
  return out;
}

/** Project a stored portal edge to its persistent form; `returnVerified` is never included. */
function toPortalEdgeSnapshot(edge: StoredPortalEdge): TopologyPortalEdgeSnapshot {
  const out: TopologyPortalEdgeSnapshot = {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    directed: edge.directed,
    traversals: edge.traversals.map(clonePortalTraversal),
  };
  if (edge.fragmentId !== undefined) out.fragmentId = edge.fragmentId;
  if (edge.source !== undefined) out.source = edge.source;
  return out;
}

/**
 * Validate one restored binding reference against the restored edge endpoints
 * only — structural validity plus internal consistency (identity, scope + endpoint
 * match), never a read of the current authoritative history. The snapshot is the
 * binding's own immutable copy, so a deleted/replaced evidence record still
 * restores verbatim, but a binding whose snapshot identity disagrees with its own
 * `evidenceId`/edge `fragmentId` is rejected as corrupt.
 */
function restoreEvidenceRef(
  worldId: string,
  edgeId: string,
  raw: unknown,
  fromNode: SpatialNode,
  toNode: SpatialNode,
  edgeFragmentId: string | undefined,
  directed = true,
): StoredEvidenceRef {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`edge "${edgeId}" binding reference must be an object`);
  }
  const evidenceId = (raw as { evidenceId?: unknown }).evidenceId;
  if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
    throw new Error(`edge "${edgeId}" binding evidence id must be a non-empty string`);
  }
  const snapshot = (raw as { snapshot?: unknown }).snapshot;
  // `snapshotEvidence` re-validates structure and world scope and returns a clone.
  const validated = snapshotEvidence(worldId, snapshot as TraversalEvidence);
  if (validated.id !== evidenceId) {
    throw new Error(`edge "${edgeId}" binding "${evidenceId}" snapshot id "${validated.id}" does not match`);
  }
  if (edgeFragmentId !== undefined && validated.fragmentId !== edgeFragmentId) {
    throw new Error(
      `edge "${edgeId}" fragmentId "${edgeFragmentId}" does not match binding "${evidenceId}" fragment "${validated.fragmentId}"`,
    );
  }
  if (validated.dim !== fromNode.dim) {
    throw new Error(`edge "${edgeId}" binding "${evidenceId}" dim does not match endpoint dim`);
  }
  if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
    throw new Error(`edge "${edgeId}" endpoints must be exact locations`);
  }
  const forwardMatch =
    pointsEqual(validated.from, fromNode.location.pos) &&
    pointsEqual(validated.to, toNode.location.pos);
  const reverseMatch =
    pointsEqual(validated.from, toNode.location.pos) &&
    pointsEqual(validated.to, fromNode.location.pos);
  if (!forwardMatch && !(directed === false && reverseMatch)) {
    throw new Error(`edge "${edgeId}" binding "${evidenceId}" endpoints do not match edge from→to`);
  }
  return { evidenceId, snapshot: validated };
}

const BYTES_PER_POINT = 96;
const BYTES_PER_NUMBER = 24;
const STRING_QUOTES = 2;

type StringCost = (s: string) => number;
type TraversalCost = (e: TraversalEvidence) => number;

function nodeStringBytes(n: SpatialNode, cost: StringCost): number {
  let bytes = 160;
  bytes += cost(n.id) + STRING_QUOTES;
  bytes += cost(n.worldId) + STRING_QUOTES;
  bytes += cost(n.dim) + STRING_QUOTES;
  bytes += cost(n.kind) + STRING_QUOTES;
  bytes += cost(n.source) + STRING_QUOTES;
  bytes += n.tag === undefined ? 0 : cost(n.tag) + STRING_QUOTES;
  bytes += n.label === undefined ? 0 : cost(n.label) + STRING_QUOTES;
  bytes += n.observedAt === undefined ? 0 : BYTES_PER_NUMBER;
  bytes += n.externalRef === undefined ? 0 : cost(n.externalRef) + STRING_QUOTES;
  if (n.durable !== undefined) bytes += 24;
  bytes += n.metadata === undefined ? 0 : jsonObjectByteLength(n.metadata);
  if (n.gone === true) {
    bytes += 48 + BYTES_PER_NUMBER;
    const evidence = n.goneEvidence;
    if (evidence !== undefined) {
      bytes += 160 + cost(evidence.sessionId) + cost(evidence.source);
      bytes += evidence.reason === undefined ? 0 : cost(evidence.reason) + STRING_QUOTES;
      bytes += (evidence.observationIds?.length ?? 0) * 48;
      for (const id of evidence.observationIds ?? []) bytes += cost(id) + STRING_QUOTES;
    }
  }
  // exact: `{"kind":"exact","pos":{…}}`; region adds `"center":{…}` and `"radius":…`.
  bytes += n.location.kind === 'exact' ? BYTES_PER_POINT + 24 : BYTES_PER_POINT + BYTES_PER_NUMBER + 48;
  return bytes;
}

function edgeStringBytes(e: StoredEdge, cost: StringCost, traversalCost: TraversalCost): number {
  let bytes = 160;
  bytes += cost(e.id) + STRING_QUOTES;
  bytes += cost(e.from) + STRING_QUOTES;
  bytes += cost(e.to) + STRING_QUOTES;
  bytes += cost(e.type) + STRING_QUOTES;
  bytes += cost(e.basis) + STRING_QUOTES;
  bytes += e.fragmentId === undefined ? 0 : cost(e.fragmentId) + STRING_QUOTES;
  bytes += e.source === undefined ? 0 : cost(e.source) + STRING_QUOTES;
  bytes += 8; // directed
  for (const mode of e.modes) bytes += cost(mode) + STRING_QUOTES;
  for (const verification of e.verifications) bytes += verificationStringBytes(verification, cost);
  // Each binding carries a full immutable traversal snapshot — count its real
  // string/point cost, not a fixed per-ref constant.
  for (const ref of e.refs) {
    bytes += cost(ref.evidenceId) + STRING_QUOTES + traversalCost(ref.snapshot);
  }
  return bytes;
}

function verificationStringBytes(v: EdgeVerification, cost: StringCost): number {
  let bytes = 256;
  bytes += cost(v.direction) + STRING_QUOTES;
  bytes += cost(v.mode) + STRING_QUOTES;
  bytes += cost(v.status) + STRING_QUOTES;
  bytes += cost(v.contextKey) + STRING_QUOTES;
  bytes += cost(v.sessionId) + STRING_QUOTES;
  bytes += v.reason === undefined ? 0 : cost(v.reason) + STRING_QUOTES;
  bytes += 2 * BYTES_PER_NUMBER;
  if (v.blockedAt !== undefined) {
    bytes += v.blockedAt.kind === 'contact' ? 160 : 512;
  }
  bytes += v.hazards.length * 256;
  for (const hazard of v.hazards) bytes += cost(hazard.detail);
  for (const dependency of v.dependencies) {
    bytes += 96 + cost(dependency.key.dim) + BYTES_PER_NUMBER;
  }
  return bytes;
}

function portalTraversalStringBytes(
  t: PortalTraversalEvidence,
  cost: StringCost,
): number {
  let bytes = 160;
  bytes += cost(t.id) + cost(t.edgeId) + cost(t.direction) + cost(t.sessionId);
  bytes += cost(t.source) + STRING_QUOTES * 5;
  bytes += BYTES_PER_NUMBER;
  bytes += t.executionId === undefined ? 0 : cost(t.executionId) + STRING_QUOTES;
  bytes += t.actionId === undefined ? 0 : cost(t.actionId) + STRING_QUOTES;
  for (const id of t.observationIds) bytes += cost(id) + STRING_QUOTES + 24;
  return bytes;
}

function portalEdgeStringBytes(e: StoredPortalEdge, cost: StringCost): number {
  let bytes = 160;
  bytes += cost(e.id) + cost(e.from) + cost(e.to) + STRING_QUOTES * 3;
  bytes += 8; // directed
  bytes += e.fragmentId === undefined ? 0 : cost(e.fragmentId) + STRING_QUOTES;
  bytes += e.source === undefined ? 0 : cost(e.source) + STRING_QUOTES;
  for (const traversal of e.traversals) bytes += portalTraversalStringBytes(traversal, cost);
  return bytes;
}

/** Conservative escaped-byte estimate (full per-character scan). */
function estimateNodeBytes(n: SpatialNode): number {
  return nodeStringBytes(n, jsonEscapedByteLength);
}

/** Cheap lower bound: UTF-16 `.length` (≤ UTF-8 bytes ≤ escaped bytes), O(1) per field. */
function nodeLowerBound(n: SpatialNode): number {
  return nodeStringBytes(n, (s) => s.length);
}

function estimateEdgeBytes(e: StoredEdge): number {
  return edgeStringBytes(e, jsonEscapedByteLength, estimateTraversalBytes);
}

function edgeLowerBound(e: StoredEdge): number {
  return edgeStringBytes(e, (s) => s.length, traversalLowerBound);
}

function estimatePortalEdgeBytes(e: StoredPortalEdge): number {
  return portalEdgeStringBytes(e, jsonEscapedByteLength);
}

function portalEdgeLowerBound(e: StoredPortalEdge): number {
  return portalEdgeStringBytes(e, (s) => s.length);
}
