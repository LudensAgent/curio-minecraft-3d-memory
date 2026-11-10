/**
 * `MemoryIngest` — the host's single write port into the spatial memory core
 * (contract §4.1, implementation plan M1.4).
 *
 * This interface intentionally exposes *only* evidence writes and observation
 * lifecycle. It does not expose the body, actions, route planning or execution:
 * there is no `moveTo`/`dig`/`place`/`navigateTo`/`walkPath` here. The memory
 * core records what was observed or confirmed; it never decides what to do.
 *
 * The concrete implementation is `SpatialMemoryStoreImpl` (`src/store/`). The
 * imports below are all memory-core modules so a consumer can type against this
 * port without pulling in navigation, execution or adapter body types.
 */

import type { ObservationBatch } from '../observation/types.js';
import type {
  LandmarkTag,
  PathFragment,
  PortalEdgeInput,
  PortalTraversalEvidence,
  RecordNodeOptions,
  SaveResult,
  SpatialEdge,
  SpatialNode,
  TopologyEdge,
  TraversalEvidence,
} from '../topology/index.js';
import type { Vec3Like } from '../types.js';
import type { BatchChangeReport, ChangeReport, StaleReason } from '../voxel/voxel-map.js';

/**
 * `SpatialEdge` as accepted by the store, with the optional fields
 * `TopologyStore` needs to record a *traversed* connection.
 *
 * `evidenceIds` may only belong to a traversed edge, so when `basis` is omitted
 * and evidence ids are present the basis is `traversed`; otherwise it is
 * `candidate`. `directed`, `modes` and `verifications` are accepted for source
 * compatibility but are not stored by `TopologyStore`.
 */
export type SpatialEdgeRecord = SpatialEdge &
  Partial<Pick<TopologyEdge, 'basis' | 'evidenceIds' | 'source'>>;

/**
 * Observation and voxel-state writes. This is the port a production host needs
 * for evidence; it says nothing about the retired route/topology stores.
 */
export interface ObservationIngest {
  /** Begin/switch the observation session; returns the local invalidation report. */
  beginSession(sessionId: string): ChangeReport;

  /** Atomically accept one observation batch; any invalid entry rejects the whole batch. */
  observeBatch(batch: ObservationBatch): BatchChangeReport;

  /** Mark a measured stance; never inferred from a request or proximity. */
  markTraversed(dim: string, pos: Vec3Like): void;

  /** Mark a cell changed by a confirmed own action; `actionId` is required. */
  markModified(dim: string, pos: Vec3Like, actionId: string): void;

  /** Observation interrupted/unloaded/session changed; freshness only, history is kept. */
  markStale(dim: string, reason: StaleReason): ChangeReport;
}

/**
 * Legacy route/topology writes. Retained for offline migration and explicit
 * compatibility callers; a production voxel+facts composition does not
 * implement or advertise these methods.
 */
export interface LegacyRouteIngest {
  /** Save historical geometry; this does not create a traversal or prove current passability. */
  saveFragment(fragment: PathFragment): void;

  /** Save measured continuous traversal; the fragment must already exist. */
  addTraversal(evidence: TraversalEvidence): SaveResult;

  /** Record a named anchor; `label`/`tag`/`metadata` are opaque to the library. */
  recordNode(
    label: string,
    pos: Vec3Like,
    tag?: LandmarkTag,
    options?: RecordNodeOptions,
  ): SpatialNode;

  /** Record an explicit relation; the reverse direction is never generated. */
  upsertEdge(edge: SpatialEdgeRecord): void;

  /** Portal connectivity and its raw crossing evidence, separate from the walk graph. */
  savePortalEdge(edge: PortalEdgeInput, traversals: PortalTraversalEvidence[]): void;
  addPortalTraversal(edgeId: string, traversal: PortalTraversalEvidence): void;
}

/** Full compatibility write port: observation plus legacy route writes. */
export interface MemoryIngest extends ObservationIngest, LegacyRouteIngest {}
