/**
 * Read-only query projection types (contract §5, implementation plan M2.1).
 *
 * A query never moves, turns, scans, loads a Section, refreshes evidence,
 * pins, saves, or executes. It is a projection over the in-memory stores the
 * host already fed through the write port.
 *
 * The request union is the host-facing surface. Unknown fields and unknown
 * kinds are rejected by the runtime validator in `validate.ts`; the TypeScript
 * types are not a substitute for that boundary check.
 */

import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import type { FrontierCandidatesResult } from '../navigation/route-inspection.js';
import type { WalkSearchSnapshot } from '../navigation/walk-search.js';
import type { QueryPage } from './paging.js';
import type {
  EvidenceKind,
  Freshness,
  Observation,
  ObservationGap,
} from '../observation/types.js';
import type {
  AnchorResult,
  ComponentReport,
  ConnectionType,
  EdgeBasis,
  EdgeView,
  FragmentSegmentsResult,
  FragmentStore,
  LandmarkTag,
  NodeSource,
  PathFragment,
  PortalEdgeView,
  QueryBudgetKey,
  QueryStats,
  RouteQueryStatus,
  RouteSegment,
  SearchDiagnostic,
  SearchGapKind,
  SpatialNode,
  TopologyStore,
  TraversalEvidence,
} from '../topology/index.js';
import type { BlockState, Vec3Like, WorldScope } from '../types.js';
import type { CellView, SectionResidency } from '../voxel/index.js';

export interface SpatialQueryPort {
  query(request: SpatialQueryRequest): SpatialQueryResult;
}

export type SpatialQueryRequest =
  | { kind: 'cells'; dim: string; positions: Vec3Like[] }
  | {
      kind: 'fragments';
      dim?: string;
      fragmentKind?: PathFragment['kind'];
      geometrySource?: PathFragment['geometrySource'];
      after?: string;
      limit?: number;
    }
  | { kind: 'traversals'; dim?: string; fragmentId?: string; after?: string; limit?: number }
  | {
      kind: 'nodes';
      dim?: string;
      tag?: LandmarkTag;
      label?: string;
      source?: NodeSource;
      after?: string;
      limit?: number;
    }
  | {
      kind: 'edges';
      dim?: string;
      from?: string;
      to?: string;
      type?: ConnectionType;
      basis?: EdgeBasis;
      after?: string;
      limit?: number;
    }
  | { kind: 'historyRoute'; dim: string; from: Vec3Like; to: Vec3Like; near?: number }
  | { kind: 'anchor'; dim: string; here: Vec3Like; order: 'surface' | 'deepest'; near?: number }
  | { kind: 'components'; dim: string }
  | { kind: 'segments'; fragmentId: string }
  | { kind: 'portals'; after?: string; limit?: number }
  | {
      kind: 'resourceAnchors';
      dim?: string;
      tag?: LandmarkTag;
      label?: string;
      /** Default false: anchors marked gone are excluded so a removed resource is revoked immediately. */
      includeGone?: boolean;
      after?: string;
      limit?: number;
    }
  | { kind: 'containerAnchors'; dim?: string; after?: string; limit?: number }
  /**
   * Additive to contract §5.2 (D-V4-017): read-only projection of never-observed
   * boundary candidates from a caller-supplied `WalkSearchSnapshot`. It never
   * starts a search, scans the map, ranks candidates, or selects a target.
   */
  | { kind: 'frontiers'; dim: string; here: Vec3Like; limit?: number }
  /**
   * Additive to contract §5.2: a contents request is always answered by the
   * structured `host_ledger` boundary, never by an empty list.
   */
  | { kind: 'containerContents'; dim?: string }
  | { kind: 'snapshot' }
  | { kind: 'capabilities' };

export type SpatialQueryKind = SpatialQueryRequest['kind'];

export type SpatialQueryStatus =
  | 'ok'
  | 'partial'
  | 'not_found'
  | 'unsupported'
  /**
   * `frontiers` is the current producer: it rejects a caller snapshot whose
   * world/dim does not match the store/request. Other kinds keep the reserved
   * world-addressing semantics.
   */
  | 'scope_mismatch'
  | 'invalid_request';

/** One cell's read-only projection; `observed:false` never means air. */
export interface CellQueryView {
  pos: Vec3Like;
  observed: boolean;
  state?: BlockState;
  stateComplete?: boolean;
  evidence?: EvidenceKind;
  freshness?: Freshness;
  validUntil?: number;
  staleReason?: string;
  /** Present only when this requested cell could not be observed now. */
  gap?: ObservationGap;
  /**
   * Residency of the owning Section at query time, present on unobserved cells.
   * It separates `no_record`, `resident` (Section readable but this cell was
   * never observed), `not_resident`, `loading`, and `load_failed`. Observed
   * cells omit it: their own evidence already says the Section was readable.
   */
  residency?: SectionResidency;
  /**
   * Why an unobserved cell has no gap. `no_record` means the Section has no
   * record at all; `resident` means the Section is resident but this cell was
   * never observed. Absent for unreadable Sections, where `gap.reason` says
   * `unloaded` and `residency` names the state.
   */
  unobservedReason?: 'no_record' | 'resident';
}

/** One store method's honesty report. */
export interface SpatialMemoryCapability {
  available: boolean;
  /** Why it is unavailable, or the honest limitation when it is available. */
  reason?: string;
}

/**
 * Public store surface covered by the capability report.
 *
 * Owned by the query types so this module stays free of store imports;
 * `spatial-memory-store.ts` asserts at compile time that the list still equals
 * `keyof SpatialMemoryStore`.
 */
export type SpatialMemoryCapabilityName =
  | 'observe'
  | 'observeBatch'
  | 'beginSession'
  | 'markStale'
  | 'sectionAt'
  | 'markTraversed'
  | 'markModified'
  | 'saveFragment'
  | 'addTraversal'
  | 'forgetFragment'
  | 'fragments'
  | 'recordNode'
  | 'upsertNode'
  | 'upsertEdge'
  | 'dropEdge'
  | 'graph'
  | 'displayNodes'
  | 'markGone'
  | 'goneNear'
  | 'verifyEdge'
  | 'blockEdge'
  | 'clearEdgeBlock'
  | 'edgeRuntime'
  | 'savePortalEdge'
  | 'addPortalTraversal'
  | 'portalEdges'
  | 'route'
  | 'surfaceAnchor'
  | 'deepestAnchor'
  | 'fragmentation'
  | 'components'
  | 'segments'
  | 'mergeFragments'
  | 'query'
  | 'frontierCandidates'
  | 'subscribeChanges';

export type SpatialMemoryCapabilities = Record<
  SpatialMemoryCapabilityName,
  SpatialMemoryCapability
>;

/** Read-only runtime summary. Never refreshes evidence or changes a revision. */
export interface SpatialMemoryStoreSnapshot {
  worldId: string;
  voxel: {
    saveRevision: number;
    residentSections: number;
    residentBytes: number;
    pinLeases: number;
    pinnedSections: number;
  };
  fragments: { revision: number; total: number };
  topology: { revision: number; nodes: number; edges: number };
  capabilities: SpatialMemoryCapabilities;
}

/** Detailed historical-route read; explicitly not an executable route. */
export interface HistoricalRouteInspection {
  worldId: string;
  dim: string;
  from: Vec3Like;
  to: Vec3Like;
  /** Endpoint snapping radius around `from`/`to`. */
  near: number;
  status: RouteQueryStatus | 'ENDPOINT_NOT_RECORDED';
  fromNodeId: string | null;
  toNodeId: string | null;
  /** Ordered recorded node positions for a FOUND route; empty otherwise. */
  points: Vec3Like[];
  nodeIds: string[];
  edgeIds: string[];
  segments: RouteSegment[];
  gaps: SearchGapKind[];
  stats: QueryStats | null;
  diagnostics: SearchDiagnostic[];
  exhausted?: QueryBudgetKey;
  /** Recorded topology/geometry, not measured current terrain. */
  historicalGeometry: true;
  /** This query never starts movement or an executor. */
  executable: false;
  /** Current terrain passability is not established by this query. */
  currentPassability: 'UNKNOWN';
  message: string;
}

/** Axis/sign of the boundary step from the approach stance to the boundary cell. */
export interface FrontierBoundaryDirection {
  axis: 'x' | 'z';
  sign: 1 | -1;
}

/**
 * One never-observed boundary candidate projected from a caller-supplied
 * `WalkSearchSnapshot`. `pos` is the adjacent boundary cell (`WalkSearchFrontier.to`);
 * it was never entered and is not claimed reachable. Only `stance` carries a
 * reachability claim, and `basis` is the local stance evidence that makes the
 * boundary interpretable. A missing candidate is not proof the boundary is air
 * or passable.
 */
export interface FrontierCandidateQueryView {
  /** Stable id derived from `dim` and the boundary cell coordinates. */
  id: string;
  pos: Vec3Like;
  /** The approach stance the search validated; reachability applies here only. */
  stance: Vec3Like;
  /** `OPEN` for `stance`; never for `pos` or `gap`. */
  reachability: 'OPEN';
  /** The boundary cell itself was not entered. Never inferred from `OPEN`. */
  boundaryReachability: 'unknown';
  /** Axis/sign from `stance` to `pos`; null when they are not axis-adjacent. */
  direction: FrontierBoundaryDirection | null;
  /** Adjacent never-observed cells beyond the boundary. Never air. */
  gap: Vec3Like[];
  gapCount: number;
  /** Locally observed stance cells (feet/head/support); not arbitrary body clearance. */
  basis: Observation[];
  reason: string;
  /** `unknown` unless the caller supplied a history lookup; never a fabricated false. */
  historicalConnection: boolean | 'unknown';
  computedAt: number;
  validUntil: number;
  /** Query clock minus `computedAt`, clamped at zero. */
  ageMs: number;
}

/**
 * Read-only frontier window. Candidates keep snapshot discovery order; this
 * projection never re-sorts, ranks or selects one. `truncated` is a `limit`
 * window cut, while `snapshotTruncated` is the snapshot's own `maxFrontiers`
 * bound. `unavailableHistorical*` counts evidence boundaries whose saved
 * Section is stale/unavailable; those are not never-observed frontiers and are
 * deliberately not mixed into `items`.
 */
export interface FrontierQueryData {
  kind: 'frontiers';
  source: 'walk_search_snapshot';
  /** Scope carried by the snapshot the candidates were projected from. */
  scope: { worldId: string; dim: string; sessionId: string };
  snapshotState: FrontierCandidatesResult['state'];
  items: FrontierCandidateQueryView[];
  total: number;
  truncated: boolean;
  snapshotTruncated: boolean;
  /**
   * Snapshot diagnostics with `status:'STALE'`. These are boundaries whose
   * saved evidence is stale, not never-observed cells and not air/passable.
   */
  staleCount: number;
  /** True when the snapshot hit its diagnostic cap; `staleCount` is then partial. */
  diagnosticsTruncated: boolean;
  /** STALE/not-resident boundaries whose saved Section is unavailable. */
  unavailableHistoricalCount: number;
  unavailableHistoricalTruncated: boolean;
  /** Section residency occurrences across `unavailableHistorical` boundaries. */
  unavailableHistoricalResidency: {
    not_resident: number;
    loading: number;
    load_failed: number;
  };
}

/**
 * Query data variants. Most list kinds carry one bounded `QueryPage` window.
 * `frontiers` is the deliberate exception: it has no cursor (`after`) and
 * returns a `limit`-bounded window over the snapshot's own bounded candidate
 * set, with `total`/`truncated` flags instead of `nextAfter`.
 */
export type SpatialQueryData =
  | { kind: 'cells'; cells: CellQueryView[]; gaps: ObservationGap[] }
  | ({ kind: 'fragments' } & QueryPage<PathFragment>)
  | ({ kind: 'traversals' } & QueryPage<TraversalEvidence>)
  | ({ kind: 'nodes' } & QueryPage<SpatialNode>)
  | ({ kind: 'edges' } & QueryPage<EdgeView>)
  | { kind: 'historyRoute'; inspection: HistoricalRouteInspection }
  | { kind: 'anchor'; anchor: AnchorResult | null }
  | { kind: 'components'; report: ComponentReport }
  | { kind: 'segments'; segments: FragmentSegmentsResult }
  | ({ kind: 'portals' } & QueryPage<PortalEdgeView>)
  | ({ kind: 'resourceAnchors' } & QueryPage<SpatialNode>)
  | ({ kind: 'containerAnchors' } & QueryPage<SpatialNode>)
  | FrontierQueryData
  | { kind: 'snapshot'; snapshot: SpatialMemoryStoreSnapshot }
  | { kind: 'capabilities'; capabilities: MemoryHostCapabilities };

export interface SpatialQueryResult {
  status: SpatialQueryStatus;
  contract: 'memory-host-contract/1';
  worldId: string;
  dim?: string;
  sessionId?: string;
  computedAt: number;
  readOnly: true;
  /** History/geometry queries are never executable; current evidence isn't authorization either. */
  executable: false;
  data?: SpatialQueryData;
  problem?: SpatialQueryProblem;
  total?: number;
  nextAfter?: string;
}

export type SpatialQueryProblem =
  | { kind: 'invalid_request'; detail: string }
  /**
   * `frontiers` is the current producer: a caller snapshot whose world/dim does
   * not match the store/request is rejected with this problem. Other kinds keep
   * the reserved world-addressing semantics.
   */
  | { kind: 'scope_mismatch'; expected: WorldScope; actual: WorldScope }
  | { kind: 'unsupported'; query: SpatialQueryKind; detail: string }
  | { kind: 'host_ledger'; detail: string }
  | { kind: 'not_found'; detail: string };

/** Construction-time behavior for the query projection. */
export interface SpatialQueryOptions {
  /** Envelope clock; defaults to `Date.now`. Never rewrites stored evidence time. */
  now?: () => number;
  /**
   * Host-owned classification of which recorded nodes denote containers.
   * Labels/metadata stay opaque to the library. Without it, `containerAnchors`
   * is reported as unsupported rather than guessing from names.
   */
  isContainer?: (node: SpatialNode) => boolean;
}

/**
 * One already-run frontier projection, or the reason none can be projected.
 * The store resolves its existing `frontierSource` into this union; the query
 * handler never runs a search itself.
 */
export type FrontierQuerySource =
  | {
      status: 'available';
      result: FrontierCandidatesResult;
      /**
       * The resolved caller snapshot behind `result`. The handler reads only
       * bounded evidence summaries (STALE diagnostics, unavailable residency)
       * from it; it is never returned wholesale and no search is re-run.
       */
      snapshot: WalkSearchSnapshot;
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'scope_mismatch'; expected: WorldScope; actual: WorldScope };

/**
 * Narrow read-only source set for the query handlers. It deliberately does not
 * expose the write stores' mutation APIs, so a handler cannot accidentally
 * observe, save, pin, load, or execute.
 */
export interface SpatialQuerySources {
  /** When supplied, semantic queries use facts exclusively, including empty results. */
  facts?: Pick<import('../facts/types.js').FactStore, 'places' | 'resources' | 'containers'>;
  readonly worldId: string;
  currentSessionId(): string | null;
  cellAt(dim: string, x: number, y: number, z: number): CellView;
  residencyAt(dim: string, x: number, y: number, z: number): SectionResidency;
  fragments: Pick<FragmentStore, 'fragments' | 'traversals' | 'getFragment'>;
  topology: Pick<TopologyStore, 'nodes' | 'edges' | 'portalEdges'>;
  history: {
    routeInspection(
      dim: string,
      from: Vec3Like,
      to: Vec3Like,
      options: { near?: number },
    ): HistoricalRouteInspection;
    surfaceAnchor(dim: string, here: Vec3Like, options: { near?: number }): AnchorResult | null;
    deepestAnchor(dim: string, here: Vec3Like, options: { near?: number }): AnchorResult | null;
    components(dim: string): ComponentReport;
    segments(fragmentId: string): FragmentSegmentsResult;
  };
  /**
   * Optional caller-supplied frontier projection source (the store's
   * `frontierSource`). Absent means the composition cannot answer `frontiers`
   * truthfully → `unsupported`; it never triggers a scan.
   */
  frontiers?(dim: string, here: Vec3Like): FrontierQuerySource;
  snapshot(): SpatialMemoryStoreSnapshot;
  memoryCapabilities(): SpatialMemoryCapabilities;
}

/** Internal, already-resolved query context shared by the handlers. */
export interface SpatialQueryContext {
  readonly sources: SpatialQuerySources;
  readonly worldId: string;
  readonly now: () => number;
  readonly isContainer?: (node: SpatialNode) => boolean;
}
