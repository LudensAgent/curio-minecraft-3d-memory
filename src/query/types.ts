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
import type {
  EvidenceKind,
  Freshness,
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
  SpatialNode,
  TopologyStore,
  TraversalEvidence,
} from '../topology/index.js';
import type { BlockState, Vec3Like, WorldScope } from '../types.js';
import type { CellView, SectionResidency } from '../voxel/index.js';
// Type-only: these are erased under `verbatimModuleSyntax`. The query runtime
// graph stays free of the store/navigation modules (checked against dist/*.js).
import type {
  HistoricalRouteInspection,
  SpatialMemoryCapabilities,
  SpatialMemoryStoreSnapshot,
} from '../store/spatial-memory-store.js';

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
      after?: string;
      limit?: number;
    }
  | { kind: 'containerAnchors'; dim?: string; after?: string; limit?: number }
  /**
   * Additive to contract §5.2: a contents request is always answered by the
   * structured `host_ledger` boundary, never by an empty list.
   */
  | { kind: 'containerContents'; dim?: string; nodeId?: string }
  | { kind: 'snapshot' }
  | { kind: 'capabilities' };

export type SpatialQueryKind = SpatialQueryRequest['kind'];

export type SpatialQueryStatus =
  | 'ok'
  | 'partial'
  | 'not_found'
  | 'unsupported'
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

export type SpatialQueryData =
  | { kind: 'cells'; cells: CellQueryView[]; gaps: ObservationGap[] }
  | { kind: 'fragments'; items: PathFragment[]; total: number; nextAfter?: string }
  | { kind: 'traversals'; items: TraversalEvidence[]; total: number; nextAfter?: string }
  | { kind: 'nodes'; items: SpatialNode[]; total: number; nextAfter?: string }
  | { kind: 'edges'; items: EdgeView[]; total: number; nextAfter?: string }
  | { kind: 'historyRoute'; inspection: HistoricalRouteInspection }
  | { kind: 'anchor'; anchor: AnchorResult | null }
  | { kind: 'components'; report: ComponentReport }
  | { kind: 'segments'; segments: FragmentSegmentsResult }
  | { kind: 'portals'; items: PortalEdgeView[]; total: number; nextAfter?: string }
  | { kind: 'resourceAnchors'; items: SpatialNode[]; total: number; nextAfter?: string }
  | { kind: 'containerAnchors'; items: SpatialNode[]; total: number; nextAfter?: string }
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
 * Narrow read-only source set for the query handlers. It deliberately does not
 * expose the write stores' mutation APIs, so a handler cannot accidentally
 * observe, save, pin, load, or execute.
 */
export interface SpatialQuerySources {
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
