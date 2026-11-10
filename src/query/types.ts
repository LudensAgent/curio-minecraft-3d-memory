/**
 * Read-only query projection types for the voxel + facts composition.
 *
 * A query never moves, turns, scans, loads a Section, refreshes evidence,
 * pins, saves, or executes. It is a projection over the in-memory voxel map and
 * semantic fact store the host already fed through the write path.
 *
 * The retired fragment/topology/route domains are not part of this request
 * union. `nodes` is a compatibility view backed exclusively by semantic facts;
 * it is defined here so the query layer never imports the old topology module.
 */

import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import type { QueryPage } from './paging.js';
import type {
  EvidenceKind,
  Freshness,
  Observation,
  ObservationGap,
} from '../observation/types.js';
import type { BlockState, Vec3Like, WorldScope } from '../types.js';
import type { CellView, SectionKey, SectionResidency } from '../voxel/index.js';

export interface SpatialQueryPort {
  query(request: SpatialQueryRequest): SpatialQueryResult;
}

/** Semantic place tag used by the facts-backed projection. */
export type SemanticPlaceTag =
  | 'base'
  | 'resource'
  | 'danger'
  | 'discovery'
  | 'death'
  | 'portal';

/** Provenance source of a semantic place view. */
export type SemanticPlaceSource = 'agent' | 'program';

export type SemanticPlaceLocation =
  | { kind: 'exact'; pos: Vec3Like }
  | { kind: 'region'; center: Vec3Like; radius: number };

/**
 * Facts-backed semantic place/container/resource view.
 *
 * This is the `nodes` compatibility projection. Every field comes from a
 * semantic fact (or an explicit `null` gap for an unrecorded source-cell
 * version); nothing is synthesized from historical topology.
 */
export interface SemanticPlaceView {
  id: string;
  worldId: string;
  dim: string;
  kind: 'place';
  source: SemanticPlaceSource;
  tag: SemanticPlaceTag;
  label: string;
  location: SemanticPlaceLocation;
  observedAt: number;
  gone: boolean;
  externalRef?: string;
  metadata: {
    factKind: 'place' | 'resource' | 'container';
    /** Present for resources: the exact source-cell evidence revision, or null. */
    sourceCellVersion?: number | null;
    /** False when the resource record carries no reliable source-cell version. */
    sourceCellVersionKnown?: boolean;
    provenance: {
      source: string;
      sessionId?: string;
      observationIds?: string[];
    };
  };
}

export type SpatialQueryRequest =
  | { kind: 'cells'; dim: string; positions: Vec3Like[] }
  | {
      kind: 'nodes';
      dim?: string;
      tag?: SemanticPlaceTag;
      label?: string;
      source?: SemanticPlaceSource;
      after?: string;
      limit?: number;
    }
  | {
      kind: 'places';
      dim?: string;
      tag?: SemanticPlaceTag;
      label?: string;
      source?: SemanticPlaceSource;
      /** Default false: gone places are hidden. */
      includeGone?: boolean;
      after?: string;
      limit?: number;
    }
  | {
      kind: 'resourceAnchors';
      dim?: string;
      tag?: SemanticPlaceTag;
      label?: string;
      /** Default false: anchors marked gone/revoked are excluded. */
      includeGone?: boolean;
      after?: string;
      limit?: number;
    }
  | { kind: 'containerAnchors'; dim?: string; after?: string; limit?: number }
  /**
   * A contents request is always answered by the structured `host_ledger`
   * boundary, never by an empty list.
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
   * never observed), `not_resident`, `loading`, and `load_failed`.
   */
  residency?: SectionResidency;
  /**
   * Why an unobserved cell has no gap. `no_record` means the Section has no
   * record at all; `resident` means the Section is resident but this cell was
   * never observed.
   */
  unobservedReason?: 'no_record' | 'resident';
}

/**
 * Read-only runtime summary. Never refreshes evidence or changes a revision.
 *
 * The retired fragment/topology blocks are absent rather than reported as zero
 * recorded history.
 */
export interface SpatialMemoryStoreSnapshot {
  worldId: string;
  voxel: {
    saveRevision: number;
    residentSections: number;
    residentBytes: number;
    pinLeases: number;
    pinnedSections: number;
  };
  /** Present when semantic facts are part of the composition. */
  facts?: { revision: number; places: number; resources: number; containers: number };
  capabilities: MemoryHostCapabilities;
}

/**
 * Query data variants. Every list kind carries one bounded `QueryPage` window.
 */
export type SpatialQueryData =
  | { kind: 'cells'; cells: CellQueryView[]; gaps: ObservationGap[] }
  | ({ kind: 'nodes' } & QueryPage<SemanticPlaceView>)
  | ({
      kind: 'places';
      /**
       * `memory` states the actual authority: the in-memory facts store, not a
       * persisted cold-page read. There is no page-per-read cold place index.
       */
      pageSource: 'memory';
    } & QueryPage<SemanticPlaceView>)
  | ({ kind: 'resourceAnchors' } & QueryPage<SemanticPlaceView>)
  | ({ kind: 'containerAnchors' } & QueryPage<SemanticPlaceView>)
  | { kind: 'snapshot'; snapshot: SpatialMemoryStoreSnapshot }
  | { kind: 'capabilities'; capabilities: MemoryHostCapabilities };

export interface SpatialQueryResult {
  status: SpatialQueryStatus;
  contract: 'memory-host-contract/2';
  worldId: string;
  dim?: string;
  sessionId?: string;
  computedAt: number;
  readOnly: true;
  /** Current evidence is never an authorization to execute. */
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
}

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
  snapshot?(): SpatialMemoryStoreSnapshot;
  memoryCapabilities?(): MemoryHostCapabilities['memory'];
}

/**
 * The voxel view a production facts query port needs. `VoxelMap` satisfies it
 * structurally; tests may supply a narrower stand-in.
 */
export interface VoxelFactsQueryVoxel {
  readonly worldId: string;
  readonly sessionId: string | null;
  readonly saveRevision: number;
  cellAt(dim: string, x: number, y: number, z: number): CellView;
  sectionResidency(key: SectionKey): { residency: SectionResidency };
  residentSize(): { sections: number; bytes: number };
  pinState(): { leases: number; pinnedSections: number };
  observe?(observation: Observation): unknown;
  observeBatch?(batch: import('../observation/types.js').ObservationBatch): unknown;
  beginSession?(sessionId: string): unknown;
  markStale?(dim: string, reason: import('../voxel/voxel-map.js').StaleReason): unknown;
  sectionAt?(dim: string, x: number, y: number, z: number): unknown;
  markTraversed?(dim: string, pos: Vec3Like): unknown;
  markModified?(dim: string, pos: Vec3Like, actionId: string): unknown;
  subscribeChanges?(sink: import('../memory/change-reports.js').ChangeReportSink): unknown;
}

/** Options for the minimal production query composition: voxel state + facts. */
export interface VoxelFactsQueryOptions {
  /** Immutable world identity; must match the supplied voxel map. */
  worldId: string;
  voxel: VoxelFactsQueryVoxel;
  facts: Pick<import('../facts/types.js').FactStore, 'places' | 'resources' | 'containers' | 'revision'>;
  query?: SpatialQueryOptions;
}

/** Internal, already-resolved query context shared by the handlers. */
export interface SpatialQueryContext {
  readonly sources: SpatialQuerySources;
  readonly worldId: string;
  readonly now: () => number;
}
