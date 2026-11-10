/**
 * Public types for the SQLite history-persistence entry (phase 5A).
 *
 * These are the concrete contracts for the `openHistorySession` lifecycle —
 * explicit, bounded checkpoint save + restore of the four historical facts
 * (`PathFragment`, `TraversalEvidence`, `SpatialNode`, and topology edges with
 * their original binding snapshots). They are deliberately named separately from
 * the general `PersistenceWorker`/`SaveBatch` sketches in `storage/worker.ts`,
 * which this phase neither implements nor supersedes.
 */

import type { ActionRecord } from '../../navigation/types.js';
import type { Observation, ObservationGap } from '../../observation/types.js';
import type { LedgerDelta, LedgerStore } from './ledger.js';
import type { FragmentStore, FragmentStoreOptions } from '../../topology/fragment-store.js';
import type { TopologyStore, TopologyStoreOptions } from '../../topology/topology-store.js';
import type {
  PathFragment,
  SpatialNode,
  TopologyEdgeSnapshot,
  TopologyPortalEdgeSnapshot,
  TraversalEvidence,
} from '../../topology/index.js';
import type { Vec3Like } from '../../types.js';
import type { SectionKey } from '../../voxel/section.js';
import type {
  ResidencyLimits,
  ResolvedResidencyLimits,
  SectionResidencyInfo,
  UnloadSectionsResult,
  VoxelDirectoryEntry,
  VoxelDirectoryPage,
  VoxelDirectorySummary,
} from '../../voxel/residency.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';
import type { VoxelMap, VoxelMapOptions } from '../../voxel/voxel-map.js';

/** Lifecycle of a history session. */
export type SessionLifecycle = 'open' | 'closing' | 'closed';

/** Distinct persistence failure modes. Thrown as `PersistenceError`. */
export type PersistenceErrorKind =
  | 'busy'
  | 'closing'
  | 'closed'
  | 'capacity'
  | 'invalid_argument'
  | 'sql'
  | 'worker_start'
  | 'worker_communication'
  | 'timeout_unconfirmed'
  | 'timeout'
  | 'schema'
  | 'data'
  /** A replay used an already-recorded scoped id with a different canonical payload. */
  | 'conflict';

/** A typed persistence failure. `kind` is machine-readable; `message` is for humans. */
export class PersistenceError extends Error {
  readonly kind: PersistenceErrorKind;

  constructor(kind: PersistenceErrorKind, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.kind = kind;
  }
}

/** Bounded snapshot capacity limits. These are implementation capacities, not game rules. */
export interface SnapshotLimits {
  /** Maximum fragments captured in one checkpoint. Default 10000. */
  maxFragments?: number;
  /** Maximum traversal records captured in one checkpoint. Default 100000. */
  maxTraversals?: number;
  /** Maximum nodes captured in one checkpoint. Default 20000. */
  maxNodes?: number;
  /** Maximum edges captured in one checkpoint. Default 20000. */
  maxEdges?: number;
  /** Maximum total polyline points across all fragments. Default 2_000_000. */
  maxPolylinePoints?: number;
  /** Maximum total entrance points across all fragments. Default 100_000. */
  maxEntrancePoints?: number;
  /** Maximum total link pairs across all fragments. Default 2_000_000. */
  maxLinks?: number;
  /** Maximum total edge evidence refs (binding snapshots). Default 50_000. */
  maxEdgeEvidenceRefs?: number;
  /** Maximum voxel sections captured in one checkpoint. Default 10000. */
  maxVoxelSections?: number;
  /** Maximum observed voxel cells (evidence entries) captured in one checkpoint. Default 1_000_000. */
  maxObservedCells?: number;
  /** Maximum total palette entries across all voxel sections. Default 200_000. */
  maxPaletteEntries?: number;
  /** Maximum total serialized snapshot size in bytes (string + nested data). Default 64 MiB. */
  maxBytes?: number;
}

/** `SnapshotLimits` with every default resolved. Shared with the worker for load/write bounds. */
export interface ResolvedSnapshotLimits {
  maxFragments: number;
  maxTraversals: number;
  maxNodes: number;
  maxEdges: number;
  maxPolylinePoints: number;
  maxEntrancePoints: number;
  maxLinks: number;
  maxEdgeEvidenceRefs: number;
  maxVoxelSections: number;
  maxObservedCells: number;
  maxPaletteEntries: number;
  maxBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: ResolvedSnapshotLimits = {
  maxFragments: 10_000,
  maxTraversals: 100_000,
  maxNodes: 20_000,
  maxEdges: 20_000,
  maxPolylinePoints: 2_000_000,
  maxEntrancePoints: 100_000,
  maxLinks: 2_000_000,
  maxEdgeEvidenceRefs: 50_000,
  maxVoxelSections: 10_000,
  maxObservedCells: 1_000_000,
  maxPaletteEntries: 200_000,
  maxBytes: 64 * 1024 * 1024,
};

/**
 * Bounded capacities for the append-only event/action journal. These are storage
 * capacities, not game rules. Journal bytes count canonical UTF-8 JSON payload
 * bytes (SQL framing/index overhead is excluded).
 */
export interface JournalLimits {
  /** Maximum accepted but not yet ACK-confirmed records across actions + events. Default 10000. */
  maxPendingRecords?: number;
  /** Maximum accepted but not yet ACK-confirmed canonical payload bytes. Default 16 MiB. */
  maxPendingBytes?: number;
  /** Maximum canonical payload bytes of one record. Default 1 MiB. */
  maxRecordBytes?: number;
  /** Maximum element count of any array nested in one record. Default 100000. */
  maxRecordArrayLength?: number;
  /** Maximum nesting depth of one record. Default 32. */
  maxRecordDepth?: number;
  /** Maximum records sent in one checkpoint. Default 1000. */
  maxBatchRecords?: number;
  /** Maximum canonical payload bytes sent in one checkpoint. Default 8 MiB. */
  maxBatchBytes?: number;
  /** Maximum committed action + event rows per world. Default 1_000_000. */
  maxCommittedRecords?: number;
  /** Maximum committed canonical payload bytes per world. Default 512 MiB. */
  maxCommittedBytes?: number;
  /** Maximum rows returned by one journal query page. Default 200. */
  maxPageRecords?: number;
  /** Maximum decoded payload bytes returned by one journal query page. Default 1 MiB. */
  maxPageBytes?: number;
}

/** `JournalLimits` with every default resolved. */
export interface ResolvedJournalLimits {
  maxPendingRecords: number;
  maxPendingBytes: number;
  maxRecordBytes: number;
  maxRecordArrayLength: number;
  maxRecordDepth: number;
  maxBatchRecords: number;
  maxBatchBytes: number;
  maxCommittedRecords: number;
  maxCommittedBytes: number;
  maxPageRecords: number;
  maxPageBytes: number;
}

export const DEFAULT_JOURNAL_LIMITS: ResolvedJournalLimits = {
  maxPendingRecords: 10_000,
  maxPendingBytes: 16 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxRecordArrayLength: 100_000,
  maxRecordDepth: 32,
  maxBatchRecords: 1_000,
  maxBatchBytes: 8 * 1024 * 1024,
  maxCommittedRecords: 1_000_000,
  maxCommittedBytes: 512 * 1024 * 1024,
  maxPageRecords: 200,
  maxPageBytes: 1024 * 1024,
};

/** Resolve optional journal limits with every default filled and relationally validated. */
export function resolveJournalLimits(options: JournalLimits | undefined): ResolvedJournalLimits {
  const limits: ResolvedJournalLimits = { ...DEFAULT_JOURNAL_LIMITS };
  if (options === undefined) return limits;
  const keys = [
    'maxPendingRecords',
    'maxPendingBytes',
    'maxRecordBytes',
    'maxRecordArrayLength',
    'maxRecordDepth',
    'maxBatchRecords',
    'maxBatchBytes',
    'maxCommittedRecords',
    'maxCommittedBytes',
    'maxPageRecords',
    'maxPageBytes',
  ] as const;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PersistenceError('invalid_argument', `${key} must be a positive safe integer: ${String(value)}`);
    }
    limits[key] = value;
  }
  if (limits.maxRecordBytes > limits.maxPendingBytes) {
    throw new PersistenceError(
      'invalid_argument',
      `maxRecordBytes (${limits.maxRecordBytes}) must not exceed maxPendingBytes (${limits.maxPendingBytes})`,
    );
  }
  if (limits.maxRecordBytes > limits.maxBatchBytes) {
    throw new PersistenceError(
      'invalid_argument',
      `maxRecordBytes (${limits.maxRecordBytes}) must not exceed maxBatchBytes (${limits.maxBatchBytes})`,
    );
  }
  return limits;
}

/**
 * Logical placement ledger (design §9, §9.1).
 *
 * `key` is the canonical `worldId:dim:x,y,z` for attributed records. Legacy
 * placement data has only `x,y,z`, so records whose world/dimension cannot be
 * proven are kept as unattributed history with a null scope and their original
 * source key — they are never projected into a live world.
 */
export interface PlacedBlockRecord {
  key: string;
  /** Owning world. Null only for a raw schema row opened outside a world-bound ledger. */
  worldId: string | null;
  /**
   * Dimension, or null for a legacy placement whose sidecar did not record one.
   * The owning world remains known; dimension-scoped queries do not match these.
   */
  dim: string | null;
  /** Integer grid position. */
  pos: Vec3Like;
  name: string;
  /**
   * Legacy LRU serial. It increases when a block is placed or looked up; it is
   * **not** a placement time or an observation time and is never decayed.
   */
  lruAt: number;
  source: 'legacy' | 'live';
}

/** One chunk visit counter. `key` is `worldId:dim:cx:cz`. */
export interface ChunkVisitRecord {
  key: string;
  worldId: string;
  dim: string;
  cx: number;
  cz: number;
  count: number;
  source: 'legacy' | 'live';
}

/**
 * Raw orientation label of one portal crossing. Legacy travel files do not
 * distinguish outbound and return crossings, so imported records stay
 * `unclassified`; a return is proven by the reverse crossing, not relabeled.
 */
export type PortalTraversalDirection = 'outbound' | 'return' | 'unclassified';

export type PortalTraversalKind = 'traversal' | 'gateway';

/** Raw endpoint evidence as observed at the time of the crossing. */
export interface PortalEndpointEvidence {
  id: string;
  worldId: string;
  dim: string;
  pos: Vec3Like;
  kind: 'nether_portal' | 'end_portal' | 'end_gateway';
  portalObserved: boolean;
  observedAt: number;
}

/**
 * One raw portal/gateway crossing. All identity, session, observation-id and time
 * fields are preserved verbatim; `fromEndpoint`/`toEndpoint` keep the endpoint
 * evidence that was present when the crossing was recorded. `returnVerified` is
 * derived from a reverse crossing and is never stored as current truth.
 */
export interface PortalTraversalRecord {
  /** Deterministic canonical id derived from the raw crossing fields. */
  id: string;
  /** Proven endpoint world, or null when the legacy evidence does not locate one. */
  worldId: string | null;
  kind: PortalTraversalKind;
  direction: PortalTraversalDirection;
  fromId: string;
  toId: string;
  ts: number;
  fromSession: string;
  toSession: string;
  fromObservation: number;
  toObservation: number;
  fromEndpoint: PortalEndpointEvidence | null;
  toEndpoint: PortalEndpointEvidence | null;
  source: 'legacy' | 'live';
}

/** Full placement/visit/portal ledger for one world, as captured by a checkpoint. */
export interface LedgerSnapshot {
  worldId: string;
  /** Ascending `lruAt` (oldest first); `lruAt` values are preserved verbatim. */
  placed: PlacedBlockRecord[];
  /** Deterministic key order. */
  visits: ChunkVisitRecord[];
  /** Ascending `ts`, then canonical id. */
  traversals: PortalTraversalRecord[];
}

/**
 * Storage capacities for the ledger batch. These are implementation limits, not
 * game rules, and are enforced before a checkpoint is sent and again inside the
 * worker transaction.
 */
export interface LedgerLimits {
  /** Maximum placed records for one world. Default 50000. */
  maxPlacedBlocks?: number;
  /** Maximum chunk visit records for one world. Default 200000. */
  maxChunkVisits?: number;
  /** Maximum portal traversal records for one world. Default 5000. */
  maxPortalTraversals?: number;
  /** Maximum canonical JSON bytes of one endpoint evidence payload. Default 64 KiB. */
  maxEndpointBytes?: number;
  /** Maximum canonical JSON bytes of the whole ledger snapshot. Default 8 MiB. */
  maxBytes?: number;
}

/** `LedgerLimits` with every default resolved. */
export interface ResolvedLedgerLimits {
  maxPlacedBlocks: number;
  maxChunkVisits: number;
  maxPortalTraversals: number;
  maxEndpointBytes: number;
  maxBytes: number;
}

export const DEFAULT_LEDGER_LIMITS: ResolvedLedgerLimits = {
  maxPlacedBlocks: 50_000,
  maxChunkVisits: 200_000,
  maxPortalTraversals: 5_000,
  maxEndpointBytes: 64 * 1024,
  maxBytes: 8 * 1024 * 1024,
};

/** Resolve optional ledger limits with every default filled and validated. */
export function resolveLedgerLimits(options: LedgerLimits | undefined): ResolvedLedgerLimits {
  const limits: ResolvedLedgerLimits = { ...DEFAULT_LEDGER_LIMITS };
  if (options === undefined) return limits;
  const keys = ['maxPlacedBlocks', 'maxChunkVisits', 'maxPortalTraversals', 'maxEndpointBytes', 'maxBytes'] as const;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PersistenceError('invalid_argument', `${key} must be a positive safe integer: ${String(value)}`);
    }
    limits[key] = value;
  }
  if (limits.maxEndpointBytes > limits.maxBytes) {
    throw new PersistenceError(
      'invalid_argument',
      `maxEndpointBytes (${limits.maxEndpointBytes}) must not exceed maxBytes (${limits.maxBytes})`,
    );
  }
  return limits;
}

/**
 * The explicit event vocabulary accepted by the journal. This is deliberately a
 * closed union rather than an arbitrary JSON blob: every variant names the
 * original evidence and scope it rests on.
 *
 * `cell_blocked` / `cell_cleared` / `cell_revalidated` classify an important
 * traversability change for one cell. Their `evidence` is the observation that
 * established the classification; it must belong to the event's own session and
 * carry its exact acquisition time. The classification itself is the caller's
 * statement about traversability, not an inferred game rule.
 */
export type SpatialEvent =
  | {
      kind: 'observed_cell_change';
      /** Caller-supplied stable id, unique within (worldId, sessionId). */
      id: string;
      /** Real time the change observation was acquired, preserved verbatim. */
      observedAt: number;
      worldId: string;
      dim: string;
      sessionId: string;
      pos: Vec3Like;
      /**
       * The actual previous observation, when one was retained. Absence means the
       * prior cell state is unknown — never that it was air.
       */
      previous?: Observation;
      /** The actual new observation that established this change. Required. */
      current: Observation;
      /** Only a confirmed own-action attribution; never inferred from time proximity. */
      actionId?: string;
    }
  | {
      /** Important traversability reclassification for one cell (design §9). */
      kind: 'cell_blocked' | 'cell_cleared' | 'cell_revalidated';
      /** Caller-supplied stable id, unique within (worldId, sessionId). */
      id: string;
      /** Real time the evidence was acquired, preserved verbatim. */
      observedAt: number;
      worldId: string;
      dim: string;
      sessionId: string;
      pos: Vec3Like;
      /** The actual observation that established this classification. Required. */
      evidence: Observation;
      /**
       * The previous observation when one was retained. Absence means the prior
       * cell state is unknown — never that it was air.
       */
      previous?: Observation;
      /** Only a confirmed own-action attribution; never inferred from time proximity. */
      actionId?: string;
    }
  | {
      kind: 'observation_gap';
      id: string;
      /** Real time the gap started or was observed, preserved verbatim. */
      observedAt: number;
      worldId: string;
      dim: string;
      sessionId: string;
      reason: ObservationGap['reason'] | 'disconnected' | 'paused' | 'scope_changed' | 'not_ready';
      /** Present only when the gap concerns one specific cell. */
      pos?: Vec3Like;
    };

export type SpatialEventKind = SpatialEvent['kind'];

/** Result of a synchronous, unsaved journal acceptance. */
export interface JournalAcceptResult {
  accepted: true;
  /** True when an identical scoped record was already pending (no quota consumed). */
  duplicate: boolean;
  /** Local journal revision after this call (not a save confirmation). */
  revision: number;
  pendingRecords: number;
  pendingBytes: number;
}

/** Atomic batch input for `journal.recordBatch`. */
export interface JournalBatchInput {
  actions?: readonly ActionRecord[];
  events?: readonly SpatialEvent[];
}

/** Result of an atomic batch acceptance. */
export interface JournalBatchAcceptResult {
  /** Newly accepted records (duplicates are excluded). */
  accepted: number;
  /** Identical duplicates already pending or repeated within the batch. */
  duplicates: number;
  revision: number;
  pendingRecords: number;
  pendingBytes: number;
}

/**
 * Bounded snapshot of caller-accepted records not yet confirmed by a checkpoint
 * ACK, for explicit recovery. A timed-out checkpoint may already have committed
 * while its confirmation was lost. Entries are isolated copies; mutating them
 * cannot change the session's pending queue.
 */
export interface PendingJournalSnapshot {
  revision: number;
  actions: ActionRecord[];
  events: SpatialEvent[];
  bytes: number;
}

/** Exact scoped ids to withdraw from the pending queue. */
export interface JournalWithdrawalSelector {
  actions?: readonly { sessionId: string; id: string }[];
  events?: readonly { sessionId: string; id: string }[];
}

/** Result of an explicit pending withdrawal. Committed rows are never touched. */
export interface JournalWithdrawalResult {
  withdrawn: {
    actions: ActionRecord[];
    events: SpatialEvent[];
  };
  missing: { kind: 'action' | 'event'; sessionId: string; id: string }[];
  revision: number;
  pendingRecords: number;
  pendingBytes: number;
}

/** Common filters/bounds for committed journal pages. */
export interface JournalQueryBase {
  /** Exact dimension filter. */
  dim?: string;
  /** Exact original sessionId filter. */
  sessionId?: string;
  /**
   * Page row bound; must not exceed the resolved maxPageRecords (larger values are
   * rejected with `invalid_argument`, never clamped).
   */
  maxRecords?: number;
  /**
   * Page decoded-payload byte bound; must not exceed the resolved maxPageBytes
   * (larger values are rejected with `invalid_argument`, never clamped).
   */
  maxBytes?: number;
  /** Opaque continuation from a previous page. */
  cursor?: string;
}

export interface ActionJournalQuery extends JournalQueryBase {
  /** Exact action record id filter. */
  actionId?: string;
}

export interface EventJournalQuery extends JournalQueryBase {
  /** Exact spatial event id filter. */
  eventId?: string;
  /** Exact event variant filter. */
  kind?: SpatialEventKind;
}

/** One stable-insertion-order page of committed journal records. */
export interface JournalPage<T> {
  records: T[];
  /** Continuation, or null when this is the last page. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Synchronous pending-journal API exposed as `session.journal`. */
export interface JournalController {
  recordAction(record: ActionRecord): JournalAcceptResult;
  recordEvent(event: SpatialEvent): JournalAcceptResult;
  recordBatch(batch: JournalBatchInput): JournalBatchAcceptResult;
  readPending(): PendingJournalSnapshot;
  /**
   * Deliberately drop exact pending records (e.g. a rejected/conflicting replay).
   * Rejects with `busy` while any checkpoint is in flight. Never deletes committed
   * rows. An actual withdrawal advances the local journal revision so an empty
   * checkpoint can confirm the new state.
   */
  withdraw(selector: JournalWithdrawalSelector): JournalWithdrawalResult;
}

/** Default bound for every worker operation timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fixed byte cost of the outer snapshot envelope (`{"worldId":…,"fragments":…,
 * "traversals":…,"nodes":…,"edges":…}` — field names, braces, colons, and the four
 * `[`/`]` array brackets), *excluding* the JSON-escaped `worldId` value and the
 * inter-record commas (both counted separately, since they grow with content).
 */
export const SNAPSHOT_FRAME_BYTES = 65;

/**
 * Fixed byte cost of the outer voxel snapshot envelope (`{"worldId":…,"sections":[
 * …]}` — field names, braces, colons and the `[`/`]` brackets), *excluding* the
 * JSON-escaped `worldId` value and inter-section commas (counted separately, since
 * they grow with content). The worldId is counted twice across the history and
 * voxel envelopes in a combined snapshot — a conservative over-count, never an
 * under-estimate.
 */
export const VOXEL_FRAME_BYTES = 30;

/**
 * The full four-fact snapshot sent to and returned from the worker. This is the
 * persisted shape, not a query projection: edges carry their original binding
 * snapshots, and records are ordered by insertion order.
 */
export interface HistorySnapshot {
  worldId: string;
  fragments: PathFragment[];
  traversals: TraversalEvidence[];
  nodes: SpatialNode[];
  edges: TopologyEdgeSnapshot[];
  /**
   * Portal edges are a separate graph from walk edges; they must survive a
   * restart together with their raw traversal evidence.
   */
  portalEdges?: TopologyPortalEdgeSnapshot[];
  /** Evidence-backed explicit fragment merges (id pairs). */
  fragmentMerges?: [string, string][];
}

/** Options for `openHistorySession`. */
export interface OpenHistorySessionOptions {
  /** Absolute path to the SQLite database file. Required. */
  databasePath: string;
  /** The world this session persists. Required. */
  worldId: string;
  fragmentOptions?: FragmentStoreOptions;
  topologyOptions?: TopologyStoreOptions;
  snapshotLimits?: SnapshotLimits;
  /** Bounded journal capacities. Defaults are in `DEFAULT_JOURNAL_LIMITS`. */
  journalLimits?: JournalLimits;
  /** Bound for worker open/checkpoint/close/flush waits. Default 30000 ms. */
  timeoutMs?: number;
}

/** Result of a successful, committed checkpoint. */
export interface CheckpointResult {
  checkpointId: string;
  worldId: string;
  fragmentRevision: number;
  topologyRevision: number;
}

/** Result of `flush()`. */
export interface FlushResult {
  /** Whether there was an in-flight checkpoint at flush time. */
  pending: boolean;
  /** Whether the awaited checkpoint (if any) committed. */
  completed: boolean;
  /** Whether the memory revisions still lead the confirmed checkpoint. */
  dirty: boolean;
  error: PersistenceError | null;
}

/** Result of `close()`. */
export interface CloseResult {
  /** Whether the persistence channel closed cleanly. */
  completed: boolean;
  /** Last checkpoint id confirmed this session (null if none). */
  lastConfirmedCheckpointId: string | null;
  /** Whether an accepted request was left unconfirmed (failed/timed out). */
  unconfirmedRequest: boolean;
  /** Whether memory revisions still lead the confirmed checkpoint. */
  dirty: boolean;
  error: PersistenceError | null;
}

/** Snapshot of the session's persistence state. */
export interface PersistenceState {
  lifecycle: SessionLifecycle;
  /** Current fragment-store mutation revision. */
  fragmentRevision: number;
  /** Current topology-store mutation revision. */
  topologyRevision: number;
  /** Fragment revision last confirmed on disk (recovery baseline or last checkpoint). */
  confirmedFragmentRevision: number;
  /** Topology revision last confirmed on disk (recovery baseline or last checkpoint). */
  confirmedTopologyRevision: number;
  /** Whether current revisions lead the confirmed revisions. */
  dirty: boolean;
  /** Checkpoint id restored from disk at open (null when the DB had no committed state). */
  baselineCheckpointId: string | null;
  /** Last checkpoint id confirmed this session (null until the first one). */
  lastConfirmedCheckpointId: string | null;
  /** Checkpoint id currently in flight (null when none). */
  inFlightCheckpointId: string | null;
  /** Checkpoint id whose commit confirmation was lost (timeout/unconfirmed), if any. */
  unconfirmedCheckpointId: string | null;
  lastError: PersistenceError | null;
}

/** The history persistence session handed to the caller by `openHistorySession`. */
export interface HistorySession {
  readonly history: FragmentStore;
  readonly topology: TopologyStore;
  /** Capture and commit the current full history; rejects when busy/closing/closed/over-capacity. */
  checkpoint(): Promise<CheckpointResult>;
  getPersistenceState(): PersistenceState;
  /** Wait only for an already-accepted checkpoint; never captures new memory changes. */
  flush(): Promise<FlushResult>;
  /** Stop accepting writes and shut the persistence channel down within a bounded time. */
  close(): Promise<CloseResult>;
}

/** How a combined spatial session loads voxel sections at open. */
export type VoxelLoading = 'eager' | 'manual';

/**
 * How history/topology is loaded at open. `none` validates the committed
 * baseline/counts but does not decode or restore old fragments/nodes; callers
 * starting a new main session use it to avoid materializing the old domain.
 * A `none` session refuses to overwrite that preserved domain with a full
 * history/topology checkpoint; migration must be explicit.
 */
export type HistoryLoading = 'eager' | 'none';

/** Options for `openSpatialSession`. */
export interface OpenSpatialSessionOptions {
  /** Absolute path to the SQLite database file. Required. */
  databasePath: string;
  /** The world this session persists. Required. */
  worldId: string;
  voxelOptions?: VoxelMapOptions;
  fragmentOptions?: FragmentStoreOptions;
  topologyOptions?: TopologyStoreOptions;
  snapshotLimits?: SnapshotLimits;
  /**
   * Per-checkpoint voxel dirty-batch byte cap. Defaults to `snapshotLimits.maxBytes`
   * (one batch, preserving the previous behavior). A smaller value makes each
   * checkpoint commit a bounded dirty prefix; remaining dirty sections stay pending
   * and require a later checkpoint. The ACK confirms only the captured section keys.
   *
   * The cap is a soft bound for one oversized Section: the first dirty Section is
   * always included so a batch can make progress. `snapshotLimits.maxBytes` remains
   * the full committed-set quota checked by the worker, not a per-batch quota.
   * Must not exceed `snapshotLimits.maxBytes`.
   */
  voxelBatchMaxBytes?: number;
  /** Bounded journal capacities. Defaults are in `DEFAULT_JOURNAL_LIMITS`. */
  journalLimits?: JournalLimits;
  /** Bounded placement/visit/portal ledger capacities. Defaults are in `DEFAULT_LEDGER_LIMITS`. */
  ledgerLimits?: LedgerLimits;
  /**
   * Explicit Minecraft game version the caller is writing under. It is forwarded
   * to every checkpoint and recorded on the committed voxel rows and checkpoint
   * row. When omitted, checkpoints record `'unknown'` — never a guessed version.
   */
  gameVersion?: string;
  /**
   * Voxel loading mode. `eager` (default) restores every committed section into
   * memory at open, preserving the phase 5B/5C behavior. `manual` reads only the
   * committed section directory at open and requires explicit `loadSections`.
   */
  voxelLoading?: VoxelLoading;
  /**
   * History/topology loading mode. `eager` (default) restores old fragments and
   * topology nodes; `none` validates the committed baseline without decoding
   * payloads and refuses to replace that domain with an implicit full snapshot.
   */
  historyLoading?: HistoryLoading;
  /** Working-set bounds used when `voxelLoading` is `manual`. */
  residencyLimits?: ResidencyLimits;
  /** Bound for worker open/checkpoint/close/flush waits. Default 30000 ms. */
  timeoutMs?: number;
}

/** Result of `SpatialSession.loadSections`. */
export interface LoadSectionsResult {
  /** Sections that were loaded (and are now resident). */
  loaded: SectionKey[];
  /** Requested sections with no committed record. */
  missing: SectionKey[];
}

/** Result of a successful combined spatial checkpoint. */
export interface SpatialCheckpointResult {
  checkpointId: string;
  worldId: string;
  voxelRevision: number;
  fragmentRevision: number;
  topologyRevision: number;
  /**
   * The exact journal revision captured for this checkpoint and confirmed by its
   * ACK. A batch truncated by `maxBatchRecords`/`maxBatchBytes` reports only the
   * captured prefix, never the latest local queue revision.
   */
  journalRevision: number;
  /** Ledger revision captured and committed with this checkpoint. */
  ledgerRevision: number;
}

/**
 * Snapshot of a combined spatial session's persistence state. Each domain reports
 * its own current and confirmed revisions and its own restore baseline, so a
 * history-only checkpoint can never be read as a voxel save confirmation.
 */
export interface SpatialPersistenceState {
  lifecycle: SessionLifecycle;
  voxelRevision: number;
  fragmentRevision: number;
  topologyRevision: number;
  confirmedVoxelRevision: number;
  confirmedFragmentRevision: number;
  confirmedTopologyRevision: number;
  /** True when any domain's current revision leads its confirmed revision. */
  dirty: boolean;
  /** History/topology restore baseline checkpoint id (null when the DB had no committed state). */
  baselineCheckpointId: string | null;
  /** Voxel restore baseline checkpoint id (null when voxel has never been saved). */
  voxelBaselineCheckpointId: string | null;
  /** Local journal revision (acceptances/withdrawals); not a save confirmation. */
  journalRevision: number;
  /** Journal revision confirmed by the last committed journal checkpoint. */
  confirmedJournalRevision: number;
  /** Journal restore baseline checkpoint id (null when no journal baseline exists). */
  journalBaselineCheckpointId: string | null;
  /**
   * Minecraft game version recorded on the voxel baseline this session restored
   * from, updated whenever a checkpoint that writes voxel rows is confirmed.
   * `'unknown'` means the baseline rows never recorded a version; null before any
   * voxel baseline exists. A history-only checkpoint never changes it.
   */
  restoredGameVersion: string | null;
  /** Local placement/visit/portal ledger revision (not a save confirmation). */
  ledgerRevision: number;
  /** Ledger revision confirmed by the last committed checkpoint. */
  confirmedLedgerRevision: number;
  /** Ledger restore baseline checkpoint id (null when no ledger baseline exists). */
  ledgerBaselineCheckpointId: string | null;
  /**
   * Accepted but not yet ACK-confirmed journal records (a timed-out checkpoint may
   * already have committed).
   */
  pendingJournalRecords: number;
  /** Accepted but not yet ACK-confirmed canonical payload bytes. */
  pendingJournalBytes: number;
  /** Committed journal rows for this world (metadata known without loading payloads). */
  committedJournalRecords: number;
  /** Committed canonical payload bytes for this world. */
  committedJournalBytes: number;
  /** Last checkpoint id confirmed this session (null until the first one). */
  lastConfirmedCheckpointId: string | null;
  /** Checkpoint id currently in flight (null when none). */
  inFlightCheckpointId: string | null;
  /** Checkpoint id whose commit confirmation was lost (timeout/unconfirmed), if any. */
  unconfirmedCheckpointId: string | null;
  lastError: PersistenceError | null;
}

/** The combined spatial persistence session handed to the caller by `openSpatialSession`. */
export interface SpatialSession {
  readonly voxel: VoxelMap;
  readonly history: FragmentStore;
  readonly topology: TopologyStore;
  /** World-scoped placement, chunk-visit and portal-crossing ledger. */
  readonly ledger: LedgerStore;
  /** How voxel sections are loaded at open (`eager` or `manual`). */
  readonly voxelLoading: VoxelLoading;
  /** The resolved working-set bounds used by the manual residency mode. */
  readonly residencyLimits: ResolvedResidencyLimits;
  /** The session lifecycle (`open` / `closing` / `closed`). */
  readonly lifecycle: SessionLifecycle;
  /** True while a checkpoint, section load, working-set operation or journal query is in flight. */
  readonly busy: boolean;
  /** Synchronous acceptance into the bounded pending journal; acceptance is not a save. */
  readonly journal: JournalController;
  /**
   * Capture and commit history + topology + voxel + the pending journal batch in
   * one transaction. Journal rows are append-only; an empty batch never clears
   * previously committed journal facts.
   */
  checkpoint(options?: { deadlineMs?: number }): Promise<SpatialCheckpointResult>;
  getPersistenceState(): SpatialPersistenceState;
  /** Bounded, read-only page of committed action records (insertion order). */
  queryActions(query?: ActionJournalQuery): Promise<JournalPage<ActionRecord>>;
  /** Bounded, read-only page of committed spatial events (insertion order). */
  queryEvents(query?: EventJournalQuery): Promise<JournalPage<SpatialEvent>>;
  /** Wait only for an already-accepted checkpoint; never captures new memory changes. */
  flush(): Promise<FlushResult>;
  /** Stop accepting writes and shut the persistence channel down within a bounded time. */
  close(): Promise<CloseResult>;
  /** Residency of one section (manual mode); mirrors `VoxelMap.sectionResidency`. */
  sectionResidency(key: SectionKey): SectionResidencyInfo;
  /**
   * Worker-backed page of committed directory metadata. No full directory is
   * materialized in memory; each call reads only one `seq > after` page.
   */
  directoryPage(options?: { after?: number; limit?: number }): Promise<VoxelDirectoryPage>;
  /** Explicitly load committed sections into memory (manual mode only). */
  loadSections(keys: readonly SectionKey[]): Promise<LoadSectionsResult>;
  /**
   * Bounded read: decode the requested committed sections *without* installing them,
   * returning their snapshots and their exact resident cost. Used by the working-set
   * manager to decide how much to evict before installing; the manager holds the
   * session operation gate while it drives measure → evict → install.
   */
  measureSections(keys: readonly SectionKey[]): Promise<MeasureSectionsResult>;
  /** Install already-measured section snapshots into the resident working set. */
  installSections(sections: readonly VoxelSectionSnapshot[]): SectionKey[];
  /** Safely unload resident sections; rejects pinned/dirty/uncommitted with reasons. */
  unloadSections(keys: readonly SectionKey[]): UnloadSectionsResult;
  /** Acquire a bounded pin lease; pass its token to `releasePins` to drop it. */
  pinSections(keys: readonly SectionKey[]): { token: string; keys: SectionKey[] };
  /** Release pin leases by token; releasing an unknown token is a no-op. */
  releasePins(tokens: readonly string[]): void;
  /**
   * Acquire the session-wide operation gate shared by every working-set manager and
   * the direct load/checkpoint entries. Throws `PersistenceError('busy')` when any
   * operation is already in flight. Call `releaseWorkingSetOperation` in a finally.
   */
  acquireWorkingSetOperation(): void;
  /** Release the session-wide operation gate. */
  releaseWorkingSetOperation(): void;
}

/** Result of `SpatialSession.measureSections` (bounded decode without install). */
export interface MeasureSectionsResult {
  /** Decoded snapshots for the requested keys that had a committed record. */
  sections: VoxelSectionSnapshot[];
  /** Requested keys with no committed record. */
  missing: SectionKey[];
  /** Exact resident working-set cost of `sections` (same billing as install). */
  residentBytes: number;
}

/** Which facts a worker session persists (history-only vs combined spatial). */
export type WorkerSessionKind = 'history' | 'spatial';

/**
 * How a checkpoint persists voxel state.
 *
 * - `none`: history-only; the checkpoint never touches `spatial_sections`.
 * - `full`: complete replacement — delete all of this world's sections, then insert
 *   the full set. Used to establish the first voxel save baseline.
 * - `incremental`: upsert only the included sections, leaving all others untouched.
 *   An empty `sections` array means "no voxel change", never "clear the voxel data".
 */
export type VoxelSaveMode = 'none' | 'full' | 'incremental';

/**
 * How a checkpoint persists the journal.
 *
 * - `none`: never touches journal rows or the journal baseline (history-only sessions).
 * - `append`: appends the captured batch and records a new journal baseline revision.
 *   An empty batch is valid and never deletes committed rows; it is how an
 *   acceptance/withdrawal revision is confirmed without new records.
 */
export type JournalSaveMode = 'none' | 'append';

/** Wire request messages sent from the session to the worker. */
export type WorkerRequest =
  | {
      type: 'open';
      requestId: number;
      databasePath: string;
      worldId: string;
      limits: ResolvedSnapshotLimits;
      journalLimits: ResolvedJournalLimits;
      kind: WorkerSessionKind;
      /** How history/topology is loaded at open; `none` validates metadata only. */
      historyLoading?: HistoryLoading;
      /** How a combined spatial session loads voxel sections at open. */
      voxelLoading: VoxelLoading;
      /** Bounded ledger capacities (spatial sessions only). */
      ledgerLimits?: ResolvedLedgerLimits;
    }
  | {
      type: 'directory_page';
      requestId: number;
      worldId: string;
      after?: number;
      limit: number;
    }
  | {
      type: 'checkpoint';
      requestId: number;
      checkpointId: string;
      worldId: string;
      fragmentRevision: number;
      topologyRevision: number;
      snapshot: HistorySnapshot;
      /**
       * Whether this checkpoint persists the history (fragments + traversals) and
       * topology (nodes, edges, portal edges, merges) domains. Omitted means
       * `full` (every existing caller's behavior). `none` writes no rows for that
       * domain and keeps its committed baseline untouched, so the omitted arrays
       * in `snapshot` are never read as "clear this domain".
       */
      historyMode?: 'full' | 'none';
      topologyMode?: 'full' | 'none';
      /** How this checkpoint persists voxel state (history-only / full / incremental). */
      voxelMode: VoxelSaveMode;
      voxelRevision: number;
      /** The full set for `full`, the changed set for `incremental`; ignored for `none`. */
      voxelSnapshot: VoxelCheckpointSnapshot;
      /** How this checkpoint persists the journal (`none` never alters journal facts/baseline). */
      journalMode: JournalSaveMode;
      /** Local journal revision captured with this batch. */
      journalRevision: number;
      /** Captured pending records, in acceptance order (may be empty). */
      journalBatch: { actions: ActionRecord[]; events: SpatialEvent[] };
      /**
       * Ledger persistence mode. `none` (default for history-only checkpoints)
       * never touches ledger rows; `full` replaces this world's ledger rows in the
       * same transaction; `delta` upserts/removes only the changed rows (the first
       * ledger save is still `full`, so an omission is never a deletion).
       */
      ledgerMode?: 'none' | 'full' | 'delta';
      /** Captured ledger revision. */
      ledgerRevision?: number;
      /** Complete world-scoped ledger snapshot for `full`. */
      ledgerSnapshot?: LedgerSnapshot;
      /** Changed placed/visit rows plus new portal crossings for `delta`. */
      ledgerDelta?: LedgerDelta;
      /**
       * Explicit Minecraft game version this checkpoint's voxel rows were written
       * under, supplied by the caller (never guessed by the worker). When absent,
       * the checkpoint and its section rows record `'unknown'`.
       */
      gameVersion?: string;
    }
  | {
      type: 'load_sections';
      requestId: number;
      worldId: string;
      /** Distinct section coordinates to load. */
      keys: { dim: string; cx: number; cz: number; sy: number }[];
    }
  | {
      type: 'query_actions';
      requestId: number;
      worldId: string;
      /** Exclusive insertion-sequence cursor; 0 starts at the beginning. */
      afterSeq: number;
      maxRecords: number;
      maxBytes: number;
      dim?: string;
      sessionId?: string;
      actionId?: string;
    }
  | {
      type: 'query_events';
      requestId: number;
      worldId: string;
      afterSeq: number;
      maxRecords: number;
      maxBytes: number;
      dim?: string;
      sessionId?: string;
      eventId?: string;
      kind?: SpatialEventKind;
    }
  | { type: 'close'; requestId: number };

/** Wire response messages sent from the worker to the session. */
export type WorkerResponse =
  | {
      type: 'open_ok';
      requestId: number;
      baselineCheckpointId: string | null;
      snapshot: HistorySnapshot | null;
      /** Voxel baseline checkpoint id, or null when voxel has never been saved. */
      voxelBaselineCheckpointId: string | null;
      voxelSnapshot: VoxelCheckpointSnapshot | null;
      /** Exact committed key membership (manual loading); empty when eager. */
      voxelDirectoryKeys: SectionKey[];
      /** Aggregate committed metadata; per-page details are queried on demand. */
      voxelDirectorySummary: VoxelDirectorySummary;
      /** Journal metadata only — payloads are never decoded at open. */
      journalBaselineCheckpointId: string | null;
      journalRevision: number;
      journalRecordCount: number;
      journalRecordBytes: number;
      /** Ledger restore baseline (spatial sessions; null when never saved). */
      ledgerBaselineCheckpointId: string | null;
      /** Restored world-scoped ledger (spatial sessions only). */
      ledgerSnapshot: LedgerSnapshot | null;
      /**
       * Minecraft game version recorded on the voxel baseline this open restores
       * from (the latest checkpoint with `has_voxel = 1`), or `'unknown'` when its
       * rows never recorded one (pre-v8 rows). Null when the world has no voxel
       * baseline. A newer history-only checkpoint never changes this fact.
       */
      gameVersion: string | null;
    }
  | {
      type: 'directory_page_ok';
      requestId: number;
      page: VoxelDirectoryPage;
    }
  | {
      type: 'load_ok';
      requestId: number;
      /** Decoded payloads for the requested keys that had a committed record. */
      sections: VoxelCheckpointSnapshot['sections'];
      /** Requested coordinates with no committed record. */
      missing: { dim: string; cx: number; cz: number; sy: number }[];
    }
  | {
      type: 'query_actions_ok';
      requestId: number;
      records: ActionRecord[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | {
      type: 'query_events_ok';
      requestId: number;
      records: SpatialEvent[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | {
      type: 'checkpoint_ok';
      requestId: number;
      checkpointId: string;
      /** Actual committed payload octet_length per section, for the directory's exact byte count. */
      voxelBytes: { dim: string; cx: number; cz: number; sy: number; bytes: number }[];
      /** Committed journal row count/bytes for this world after the transaction. */
      journalRecordCount: number;
      journalRecordBytes: number;
      /**
       * Committed ledger row count/bytes for this world after the transaction, when
       * this checkpoint wrote the ledger. Computed by the worker from the committed
       * rows (never from a delta), so a caller does not need to serialize the
       * full set to learn its size.
       */
      ledgerRecordCount?: number;
      ledgerRecordBytes?: number;
    }
  | { type: 'closed'; requestId: number }
  | { type: 'error'; requestId: number; kind: PersistenceErrorKind; message: string };

/** Resolve the optional snapshot limits with every default filled and validated. */
export function resolveSnapshotLimits(options: SnapshotLimits | undefined): ResolvedSnapshotLimits {
  const limits: ResolvedSnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS };
  if (options === undefined) return limits;
  const keys = [
    'maxFragments',
    'maxTraversals',
    'maxNodes',
    'maxEdges',
    'maxPolylinePoints',
    'maxEntrancePoints',
    'maxLinks',
    'maxEdgeEvidenceRefs',
    'maxVoxelSections',
    'maxObservedCells',
    'maxPaletteEntries',
    'maxBytes',
  ] as const;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PersistenceError('invalid_argument', `${key} must be a positive safe integer: ${String(value)}`);
    }
    limits[key] = value;
  }
  return limits;
}

/** Validate and resolve a finite, positive operation timeout. */
export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PersistenceError('invalid_argument', `timeoutMs must be a positive safe integer: ${String(value)}`);
  }
  return value;
}
