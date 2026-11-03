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

import type { FragmentStore, FragmentStoreOptions } from '../../topology/fragment-store.js';
import type { TopologyStore, TopologyStoreOptions } from '../../topology/topology-store.js';
import type {
  PathFragment,
  SpatialNode,
  TopologyEdgeSnapshot,
  TraversalEvidence,
} from '../../topology/index.js';
import type { SectionKey } from '../../voxel/section.js';
import type {
  ResidencyLimits,
  ResolvedResidencyLimits,
  SectionResidencyInfo,
  UnloadSectionsResult,
  VoxelDirectoryEntry,
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
  | 'data';

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
   * Voxel loading mode. `eager` (default) restores every committed section into
   * memory at open, preserving the phase 5B/5C behavior. `manual` reads only the
   * committed section directory at open and requires explicit `loadSections`.
   */
  voxelLoading?: VoxelLoading;
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
  /** How voxel sections are loaded at open (`eager` or `manual`). */
  readonly voxelLoading: VoxelLoading;
  /** The resolved working-set bounds used by the manual residency mode. */
  readonly residencyLimits: ResolvedResidencyLimits;
  /** The session lifecycle (`open` / `closing` / `closed`). */
  readonly lifecycle: SessionLifecycle;
  /** True while a checkpoint or section load is in flight (single in-flight I/O). */
  readonly busy: boolean;
  /** Capture and commit history + topology + voxel in one transaction. */
  checkpoint(): Promise<SpatialCheckpointResult>;
  getPersistenceState(): SpatialPersistenceState;
  /** Wait only for an already-accepted checkpoint; never captures new memory changes. */
  flush(): Promise<FlushResult>;
  /** Stop accepting writes and shut the persistence channel down within a bounded time. */
  close(): Promise<CloseResult>;
  /** Residency of one section (manual mode); mirrors `VoxelMap.sectionResidency`. */
  sectionResidency(key: SectionKey): SectionResidencyInfo;
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

/** Wire request messages sent from the session to the worker. */
export type WorkerRequest =
  | {
      type: 'open';
      requestId: number;
      databasePath: string;
      worldId: string;
      limits: ResolvedSnapshotLimits;
      kind: WorkerSessionKind;
      /** How a combined spatial session loads voxel sections at open. */
      voxelLoading: VoxelLoading;
    }
  | {
      type: 'checkpoint';
      requestId: number;
      checkpointId: string;
      worldId: string;
      fragmentRevision: number;
      topologyRevision: number;
      snapshot: HistorySnapshot;
      /** How this checkpoint persists voxel state (history-only / full / incremental). */
      voxelMode: VoxelSaveMode;
      voxelRevision: number;
      /** The full set for `full`, the changed set for `incremental`; ignored for `none`. */
      voxelSnapshot: VoxelCheckpointSnapshot;
    }
  | {
      type: 'load_sections';
      requestId: number;
      worldId: string;
      /** Distinct section coordinates to load. */
      keys: { dim: string; cx: number; cz: number; sy: number }[];
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
      /** Committed section directory (manual loading); null when loaded eagerly. */
      voxelDirectory: VoxelDirectoryEntry[] | null;
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
      type: 'checkpoint_ok';
      requestId: number;
      checkpointId: string;
      /** Actual committed payload octet_length per section, for the directory's exact byte count. */
      voxelBytes: { dim: string; cx: number; cz: number; sy: number; bytes: number }[];
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
