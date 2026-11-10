/**
 * SQLite history-persistence entry (phase 5A): `openHistorySession`.
 *
 * The caller keeps writing and reading through the in-memory `FragmentStore` and
 * `TopologyStore` exactly as before; `checkpoint()` is the *only* explicit save
 * trigger. One worker owns the SQLite connection and serializes load, checkpoint
 * transactions and JSON encode/decode. This entry is the persistence channel —
 * it never turns the in-memory stores into auto-persisting objects.
 */

import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FragmentStore } from '../../topology/fragment-store.js';
import { TopologyStore } from '../../topology/topology-store.js';
import { jsonEscapedByteLength } from '../../topology/path-fragment.js';
import {
  PersistenceError,
  resolveJournalLimits,
  resolveSnapshotLimits,
  resolveTimeoutMs,
  SNAPSHOT_FRAME_BYTES,
} from './types.js';
import type {
  CheckpointResult,
  CloseResult,
  FlushResult,
  HistorySession,
  HistorySnapshot,
  OpenHistorySessionOptions,
  PersistenceState,
  ResolvedJournalLimits,
  ResolvedSnapshotLimits,
  SessionLifecycle,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

export {
  DEFAULT_JOURNAL_LIMITS,
  DEFAULT_LEDGER_LIMITS,
  DEFAULT_SNAPSHOT_LIMITS,
  DEFAULT_TIMEOUT_MS,
  PersistenceError,
  resolveJournalLimits,
  resolveLedgerLimits,
} from './types.js';
export {
  LedgerStore,
  chunkVisitKey,
  placedBlockKey,
  portalTraversalIdentity,
} from './ledger.js';
export type { PortalTraversalInput } from './ledger.js';
export type {
  FactCheckpointSnapshot,
  FactMigrationState,
  FactStore,
} from '../../facts/types.js';
export type {
  ActionJournalQuery,
  CheckpointResult,
  ChunkVisitRecord,
  CloseResult,
  EventJournalQuery,
  FlushResult,
  HistorySession,
  HistorySnapshot,
  JournalAcceptResult,
  JournalBatchAcceptResult,
  JournalBatchInput,
  JournalController,
  JournalLimits,
  JournalPage,
  JournalQueryBase,
  JournalSaveMode,
  JournalWithdrawalResult,
  JournalWithdrawalSelector,
  LedgerLimits,
  LedgerSnapshot,
  HistoryLoading,
  LoadSectionsResult,
  MeasureSectionsResult,
  OpenHistorySessionOptions,
  OpenSpatialSessionOptions,
  PendingJournalSnapshot,
  PersistenceErrorKind,
  PersistenceState,
  PlacedBlockRecord,
  PortalEndpointEvidence,
  PortalTraversalDirection,
  PortalTraversalKind,
  PortalTraversalRecord,
  ResolvedJournalLimits,
  ResolvedLedgerLimits,
  ResolvedSnapshotLimits,
  SessionLifecycle,
  SnapshotLimits,
  SpatialCheckpointResult,
  SpatialEvent,
  SpatialEventKind,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
} from './types.js';
export { openSpatialSession } from './spatial.js';
export { WorkingSetManager, resolveWorkingSetLimits } from './working-set.js';
export type {
  CapacityGap,
  CapacityGapKind,
  EvictionRejection,
  FreeResult,
  PrepareResult,
  ResolvedWorkingSetLimits,
  WorkingSetLimits,
  WorkingSetRejection,
  WorkingSetRejectionKind,
  WorkingSetStats,
} from './working-set.js';

interface PendingRequest {
  kind: 'open' | 'checkpoint' | 'close';
  resolve: (value: unknown) => void;
  reject: (e: PersistenceError) => void;
  timer?: NodeJS.Timeout;
  checkpointId?: string;
  fragmentRevision?: number;
  topologyRevision?: number;
}

interface InFlightCheckpoint {
  checkpointId: string;
  promise: Promise<CheckpointResult>;
}

/**
 * Open a history persistence session bound to one world and one database file.
 * Resolves only after the committed state (if any) has been restored into fresh
 * in-memory stores; rejects without exposing a half-restored session on any
 * startup/load/schema failure, cleaning up the worker it created.
 */
export async function openHistorySession(options: OpenHistorySessionOptions): Promise<HistorySession> {
  const session = new HistorySessionImpl(options);
  await session.initialize();
  return session;
}

/** Sum of `,` separators between adjacent records in the four snapshot arrays. */
function interRecordCommas(fragments: number, traversals: number, nodes: number, edges: number): number {
  return (
    Math.max(0, fragments - 1) +
    Math.max(0, traversals - 1) +
    Math.max(0, nodes - 1) +
    Math.max(0, edges - 1)
  );
}

class HistorySessionImpl implements HistorySession {
  readonly history: FragmentStore;
  readonly topology: TopologyStore;

  private readonly worldId: string;
  private readonly databasePath: string;
  private readonly timeoutMs: number;
  private readonly limits: ResolvedSnapshotLimits;
  private readonly journalLimits: ResolvedJournalLimits;

  private worker: Worker | null = null;
  private lifecycle: SessionLifecycle = 'open';
  private cleanlyClosed = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private inFlight: InFlightCheckpoint | null = null;

  private confirmedFragmentRevision = 0;
  private confirmedTopologyRevision = 0;
  private baselineCheckpointId: string | null = null;
  private lastConfirmedCheckpointId: string | null = null;
  private lastError: PersistenceError | null = null;
  /** Checkpoint id whose commit confirmation was lost (timeout/unconfirmed). */
  private unconfirmedCheckpointId: string | null = null;

  constructor(options: OpenHistorySessionOptions) {
    if (typeof options.databasePath !== 'string' || options.databasePath.length === 0) {
      throw new PersistenceError('invalid_argument', 'databasePath must be a non-empty string');
    }
    if (!isAbsolute(options.databasePath)) {
      throw new PersistenceError('invalid_argument', 'databasePath must be an absolute path');
    }
    if (typeof options.worldId !== 'string' || options.worldId.length === 0) {
      throw new PersistenceError('invalid_argument', 'worldId must be a non-empty string');
    }
    this.worldId = options.worldId;
    this.databasePath = options.databasePath;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
    this.limits = resolveSnapshotLimits(options.snapshotLimits);
    this.journalLimits = resolveJournalLimits(options.journalLimits);

    this.history = new FragmentStore(options.worldId, options.fragmentOptions);
    this.topology = new TopologyStore(this.history, options.topologyOptions);
  }

  async initialize(): Promise<void> {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    this.worker = worker;
    worker.on('message', (msg: WorkerResponse) => this.handleMessage(msg));
    worker.on('error', (err) => this.handleWorkerError(err));
    worker.on('exit', () => this.handleWorkerExit());

    let result: { baselineCheckpointId: string | null; snapshot: HistorySnapshot | null };
    try {
      result = await this.requestOpen();
    } catch (err) {
      this.lifecycle = 'closed';
      await this.terminateWorker();
      throw err;
    }
    try {
      if (result.snapshot !== null) {
        this.history.restoreSnapshot(result.snapshot);
        this.topology.restoreSnapshot(result.snapshot);
      }
    } catch (err) {
      this.lifecycle = 'closed';
      await this.terminateWorker();
      throw new PersistenceError('data', `restore failed: ${(err as Error).message}`);
    }
    this.baselineCheckpointId = result.baselineCheckpointId;
    // `restoreSnapshot` bumps each store's revision (restore is a mutation); the
    // confirmed baseline is exactly the post-restore revision, so the session
    // starts clean while a later *runtime* restore would still read as dirty.
    this.confirmedFragmentRevision = this.history.revision;
    this.confirmedTopologyRevision = this.topology.revision;
  }

  async checkpoint(): Promise<CheckpointResult> {
    if (this.lifecycle === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new checkpoints are not accepted');
    }
    if (this.lifecycle === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new checkpoints are not accepted');
    }
    if (this.inFlight !== null) {
      throw new PersistenceError('busy', `a checkpoint is already in flight (${this.inFlight.checkpointId})`);
    }

    const fragmentRevision = this.history.revision;
    const topologyRevision = this.topology.revision;

    // Bounded pre-flight before any copy or message pass. The outer envelope is
    // deducted first (cheaply, via worldId `.length`), then the two stores share the
    // remaining byte budget so the measure can stop early on over-limit input.
    const maxBytes = this.limits.maxBytes;
    if (SNAPSHOT_FRAME_BYTES + this.worldId.length > maxBytes) {
      throw new PersistenceError('capacity', `worldId alone exceeds maxBytes (${maxBytes})`);
    }
    // Exact escaped worldId cost; this scan only runs once the cheap lower bound
    // above has already ruled out obviously-over-limit worldIds.
    const envelopeBytes = SNAPSHOT_FRAME_BYTES + jsonEscapedByteLength(this.worldId) + 2;
    const fragmentMeasure = this.history.checkpointMeasure(maxBytes - envelopeBytes);
    const remainingBytes = maxBytes - envelopeBytes - fragmentMeasure.bytes;
    const topologyMeasure = this.topology.checkpointMeasure(Math.max(0, remainingBytes));
    const totalBytes =
      envelopeBytes +
      interRecordCommas(fragmentMeasure.fragments, fragmentMeasure.traversals, topologyMeasure.nodes, topologyMeasure.edges) +
      fragmentMeasure.bytes +
      topologyMeasure.bytes;
    this.assertWithinLimits(fragmentMeasure.fragments, fragmentMeasure.traversals, topologyMeasure.nodes, topologyMeasure.edges, {
      polylinePoints: fragmentMeasure.polylinePoints,
      entrancePoints: fragmentMeasure.entrancePoints,
      linkPairs: fragmentMeasure.linkPairs,
      edgeEvidenceRefs: topologyMeasure.edgeEvidenceRefs,
      bytes: totalBytes,
    });

    const fragmentSnapshot = this.history.checkpointSnapshot();
    const topologySnapshot = this.topology.checkpointSnapshot();
    const snapshot: HistorySnapshot = {
      worldId: this.worldId,
      fragments: fragmentSnapshot.fragments,
      traversals: fragmentSnapshot.traversals,
      nodes: topologySnapshot.nodes,
      edges: topologySnapshot.edges,
    };

    const checkpointId = randomUUID();
    const promise = new Promise<CheckpointResult>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, {
        kind: 'checkpoint',
        checkpointId,
        fragmentRevision,
        topologyRevision,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.worker!.postMessage({
        type: 'checkpoint',
        requestId,
        checkpointId,
        worldId: this.worldId,
        fragmentRevision,
        topologyRevision,
        snapshot,
        voxelMode: 'none',
        voxelRevision: 0,
        voxelSnapshot: { worldId: this.worldId, sections: [] },
        // A history-only checkpoint never appends or re-baselines journal facts.
        journalMode: 'none',
        journalRevision: 0,
        journalBatch: { actions: [], events: [] },
      } satisfies WorkerRequest);
    });
    this.inFlight = { checkpointId, promise };
    return promise;
  }

  getPersistenceState(): PersistenceState {
    return {
      lifecycle: this.lifecycle,
      fragmentRevision: this.history.revision,
      topologyRevision: this.topology.revision,
      confirmedFragmentRevision: this.confirmedFragmentRevision,
      confirmedTopologyRevision: this.confirmedTopologyRevision,
      dirty: this.isDirty(),
      baselineCheckpointId: this.baselineCheckpointId,
      lastConfirmedCheckpointId: this.lastConfirmedCheckpointId,
      inFlightCheckpointId: this.inFlight?.checkpointId ?? null,
      unconfirmedCheckpointId: this.unconfirmedCheckpointId,
      lastError: this.lastError,
    };
  }

  async flush(): Promise<FlushResult> {
    const inFlight = this.inFlight;
    if (inFlight !== null) {
      try {
        await inFlight.promise;
        return { pending: true, completed: true, dirty: this.isDirty(), error: null };
      } catch (err) {
        const error =
          err instanceof PersistenceError ? err : new PersistenceError('worker_communication', String(err));
        return { pending: true, completed: false, dirty: this.isDirty(), error };
      }
    }
    // No in-flight request, but an earlier commit was never confirmed: report it
    // rather than claiming success. `dirty` stays a pure `isDirty()` judgment —
    // "unconfirmed commit" is expressed by `completed: false` + `error`, not by
    // conflating it with unsaved memory changes.
    if (this.unconfirmedCheckpointId !== null) {
      return {
        pending: true,
        completed: false,
        dirty: this.isDirty(),
        error:
          this.lastError ?? new PersistenceError('timeout_unconfirmed', 'a checkpoint commit was not confirmed'),
      };
    }
    return { pending: false, completed: true, dirty: this.isDirty(), error: null };
  }

  async close(): Promise<CloseResult> {
    if (this.lifecycle === 'closed') {
      return {
        completed: this.cleanlyClosed,
        lastConfirmedCheckpointId: this.lastConfirmedCheckpointId,
        unconfirmedRequest: this.inFlight !== null || this.unconfirmedCheckpointId !== null,
        dirty: this.isDirty(),
        error: this.lastError,
      };
    }

    this.lifecycle = 'closing';
    // A single total deadline governs the whole close, so waiting for an in-flight
    // checkpoint cannot silently extend the shutdown phase.
    const deadline = Date.now() + this.timeoutMs;
    let unconfirmed = this.unconfirmedCheckpointId !== null;
    let closeError: PersistenceError | null = this.lastError;

    if (this.inFlight !== null) {
      try {
        await this.inFlight.promise;
      } catch (err) {
        unconfirmed = true;
        closeError =
          err instanceof PersistenceError ? err : new PersistenceError('worker_communication', String(err));
      }
    }

    const remaining = deadline - Date.now();
    let closed: boolean;
    if (remaining > 0) {
      closed = await this.shutdownWorker(remaining);
    } else {
      // Deadline exhausted: still terminate the worker so it never leaks. A
      // non-clean close is reported, but any commit already confirmed remains
      // reflected via `lastConfirmedCheckpointId` / `cleanlyClosed`.
      await this.terminateWorker();
      closed = false;
    }
    this.cleanlyClosed = closed;
    this.lifecycle = 'closed';
    if (!closed && closeError === null) {
      closeError = new PersistenceError('worker_communication', 'persistence worker did not close within the deadline');
    }
    return {
      completed: closed,
      lastConfirmedCheckpointId: this.lastConfirmedCheckpointId,
      unconfirmedRequest: unconfirmed,
      dirty: this.isDirty(),
      error: closeError,
    };
  }

  // --- internals ---

  private isDirty(): boolean {
    return (
      this.history.revision !== this.confirmedFragmentRevision ||
      this.topology.revision !== this.confirmedTopologyRevision
    );
  }

  private requestOpen(): Promise<{ baselineCheckpointId: string | null; snapshot: HistorySnapshot | null }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, { kind: 'open', resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker!.postMessage({
        type: 'open',
        requestId,
        databasePath: this.databasePath,
        worldId: this.worldId,
        limits: this.limits,
        journalLimits: this.journalLimits,
        kind: 'history',
        voxelLoading: 'eager',
      } satisfies WorkerRequest);
    });
  }

  private assertWithinLimits(
    fragments: number,
    traversals: number,
    nodes: number,
    edges: number,
    extra: { polylinePoints: number; entrancePoints: number; linkPairs: number; edgeEvidenceRefs: number; bytes: number },
  ): void {
    const L = this.limits;
    const over = (name: string, value: number): PersistenceError =>
      new PersistenceError('capacity', `${name} exceeds limit ${L[name as keyof ResolvedSnapshotLimits]} (${value})`);
    if (fragments > L.maxFragments) throw over('maxFragments', fragments);
    if (traversals > L.maxTraversals) throw over('maxTraversals', traversals);
    if (nodes > L.maxNodes) throw over('maxNodes', nodes);
    if (edges > L.maxEdges) throw over('maxEdges', edges);
    if (extra.polylinePoints > L.maxPolylinePoints) throw over('maxPolylinePoints', extra.polylinePoints);
    if (extra.entrancePoints > L.maxEntrancePoints) throw over('maxEntrancePoints', extra.entrancePoints);
    if (extra.linkPairs > L.maxLinks) throw over('maxLinks', extra.linkPairs);
    if (extra.edgeEvidenceRefs > L.maxEdgeEvidenceRefs) throw over('maxEdgeEvidenceRefs', extra.edgeEvidenceRefs);
    if (extra.bytes > L.maxBytes) throw over('maxBytes', extra.bytes);
  }

  private shutdownWorker(timeoutMs: number): Promise<boolean> {
    if (this.worker === null) return Promise.resolve(false);
    const worker = this.worker;
    const requestId = this.nextRequestId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        void this.terminateWorker();
        resolve(false);
      }, timeoutMs);
      this.pending.set(requestId, {
        kind: 'close',
        resolve: (value: unknown) => resolve(value === true),
        reject: () => resolve(false),
        timer,
      });
      worker.postMessage({ type: 'close', requestId } satisfies WorkerRequest);
    });
  }

  private handleMessage(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.requestId);
    if (entry === undefined) return; // late/unknown ack
    this.pending.delete(msg.requestId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    if (msg.type === 'error') {
      const error = new PersistenceError(msg.kind, msg.message);
      this.lastError = error;
      if (entry.kind === 'checkpoint') this.inFlight = null;
      entry.reject(error);
      return;
    }

    if (entry.kind === 'open') {
      const openMsg = msg as WorkerResponse & { type: 'open_ok' };
      entry.resolve({ baselineCheckpointId: openMsg.baselineCheckpointId, snapshot: openMsg.snapshot });
    } else if (entry.kind === 'checkpoint') {
      const okMsg = msg as WorkerResponse & { type: 'checkpoint_ok' };
      this.inFlight = null;
      this.confirmedFragmentRevision = entry.fragmentRevision!;
      this.confirmedTopologyRevision = entry.topologyRevision!;
      this.lastConfirmedCheckpointId = okMsg.checkpointId;
      entry.resolve({
        checkpointId: okMsg.checkpointId,
        worldId: this.worldId,
        fragmentRevision: entry.fragmentRevision!,
        topologyRevision: entry.topologyRevision!,
      });
    } else {
      entry.resolve(true);
    }
  }

  private onTimeout(requestId: number): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);

    if (entry.kind === 'open') {
      const error = new PersistenceError('worker_start', 'persistence worker did not respond to open within timeout');
      this.lastError = error;
      this.lifecycle = 'closed';
      void this.terminateWorker();
      entry.reject(error);
      return;
    }
    if (entry.kind === 'checkpoint') {
      const error = new PersistenceError(
        'timeout_unconfirmed',
        `checkpoint "${entry.checkpointId}" commit was not confirmed within timeout`,
      );
      this.lastError = error;
      this.inFlight = null;
      this.unconfirmedCheckpointId = entry.checkpointId ?? null;
      this.lifecycle = 'closed'; // poisoned: no further writes accepted, no auto-retry
      this.failAllPending(error);
      entry.reject(error);
      void this.terminateWorker();
      return;
    }
    // close timeout
    this.lifecycle = 'closed';
    void this.terminateWorker();
    entry.resolve(false);
  }

  private handleWorkerError(err: Error): void {
    const error = new PersistenceError(
      'worker_communication',
      `persistence worker error (is better-sqlite3 installed?): ${err.message}`,
    );
    this.lastError = error;
    this.lifecycle = 'closed';
    this.failAllPending(error);
    void this.terminateWorker();
  }

  private handleWorkerExit(): void {
    if (this.pending.size === 0) return; // already settled/terminated
    const error = new PersistenceError('worker_communication', 'persistence worker exited before responding');
    this.lastError = error;
    this.lifecycle = 'closed';
    this.failAllPending(error);
  }

  private failAllPending(error: PersistenceError): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      // A checkpoint whose worker died before acking may or may not have committed;
      // keep its id so `flush`/`close`/state can report it as unconfirmed.
      if (entry.kind === 'checkpoint' && entry.checkpointId !== undefined) {
        this.unconfirmedCheckpointId = entry.checkpointId;
      }
      entry.reject(error);
    }
    this.pending.clear();
    this.inFlight = null;
  }

  private terminateWorker(): Promise<void> {
    const worker = this.worker;
    if (worker === null) return Promise.resolve();
    this.worker = null;
    return worker.terminate().then(
      () => undefined,
      () => undefined,
    );
  }
}
