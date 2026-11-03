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
  maxBytes: 64 * 1024 * 1024,
};

/** Default bound for every worker operation timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Conservative byte cost of the outer snapshot envelope (`{"worldId":…,"fragments":[],
 * "traversals":[],"nodes":[],"edges":[]}` brackets/commas), excluding the `worldId`
 * value itself (counted separately) and the record payloads. Both the session's
 * pre-flight and the worker's re-check add this so an empty snapshot with a large
 * `worldId` is still bounded by `maxBytes`.
 */
export const SNAPSHOT_FRAME_BYTES = 96;

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

/** Wire request messages sent from the session to the worker. */
export type WorkerRequest =
  | {
      type: 'open';
      requestId: number;
      databasePath: string;
      worldId: string;
      limits: ResolvedSnapshotLimits;
    }
  | {
      type: 'checkpoint';
      requestId: number;
      checkpointId: string;
      worldId: string;
      fragmentRevision: number;
      topologyRevision: number;
      snapshot: HistorySnapshot;
    }
  | { type: 'close'; requestId: number };

/** Wire response messages sent from the worker to the session. */
export type WorkerResponse =
  | {
      type: 'open_ok';
      requestId: number;
      baselineCheckpointId: string | null;
      snapshot: HistorySnapshot | null;
    }
  | { type: 'checkpoint_ok'; requestId: number; checkpointId: string }
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
