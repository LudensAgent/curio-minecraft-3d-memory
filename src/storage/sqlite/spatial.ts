/**
 * Combined spatial persistence entry (phase 5B): `openSpatialSession`.
 *
 * Holds one `VoxelMap`, one `FragmentStore` and one `TopologyStore` for the same
 * `worldId`, all persisted through a single SQLite worker. `checkpoint()` is the
 * *only* explicit save trigger and captures all three stores in one transaction;
 * a history-only `openHistorySession` and this combined entry never run two
 * workers over the same database, and neither claims concurrency across the two.
 *
 * Each domain keeps its own save baseline: a history-only checkpoint replaces
 * only the history facts and never touches voxel rows, so a later combined
 * restore reports the voxel baseline from the last combined checkpoint — not from
 * the newer history-only checkpoint id.
 */

import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FragmentStore } from '../../topology/fragment-store.js';
import { TopologyStore } from '../../topology/topology-store.js';
import { VoxelMap } from '../../voxel/voxel-map.js';
import { jsonEscapedByteLength } from '../../bytes.js';
import {
  PersistenceError,
  resolveSnapshotLimits,
  resolveTimeoutMs,
  SNAPSHOT_FRAME_BYTES,
  VOXEL_FRAME_BYTES,
} from './types.js';
import type {
  CloseResult,
  FlushResult,
  OpenSpatialSessionOptions,
  ResolvedSnapshotLimits,
  SessionLifecycle,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type { HistorySnapshot } from './types.js';
import type { VoxelCheckpointSnapshot } from '../../voxel/snapshot.js';

interface PendingRequest {
  kind: 'open' | 'checkpoint' | 'close';
  resolve: (value: unknown) => void;
  reject: (e: PersistenceError) => void;
  timer?: NodeJS.Timeout;
  checkpointId?: string;
  voxelRevision?: number;
  fragmentRevision?: number;
  topologyRevision?: number;
}

interface InFlightCheckpoint {
  checkpointId: string;
  promise: Promise<SpatialCheckpointResult>;
}

/**
 * Open a combined spatial persistence session bound to one world and one database
 * file. Resolves only after the committed history/topology and voxel state (if
 * any) has been restored into fresh in-memory stores; rejects without exposing a
 * half-restored session on any startup/load/schema failure, cleaning up its worker.
 */
export async function openSpatialSession(options: OpenSpatialSessionOptions): Promise<SpatialSession> {
  const session = new SpatialSessionImpl(options);
  await session.initialize();
  return session;
}

function interRecordCommas(fragments: number, traversals: number, nodes: number, edges: number): number {
  return (
    Math.max(0, fragments - 1) +
    Math.max(0, traversals - 1) +
    Math.max(0, nodes - 1) +
    Math.max(0, edges - 1)
  );
}

class SpatialSessionImpl implements SpatialSession {
  readonly voxel: VoxelMap;
  readonly history: FragmentStore;
  readonly topology: TopologyStore;

  private readonly worldId: string;
  private readonly databasePath: string;
  private readonly timeoutMs: number;
  private readonly limits: ResolvedSnapshotLimits;

  private worker: Worker | null = null;
  private lifecycle: SessionLifecycle = 'open';
  private cleanlyClosed = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private inFlight: InFlightCheckpoint | null = null;

  private confirmedVoxelRevision = 0;
  private confirmedFragmentRevision = 0;
  private confirmedTopologyRevision = 0;
  private baselineCheckpointId: string | null = null;
  private voxelBaselineCheckpointId: string | null = null;
  private lastConfirmedCheckpointId: string | null = null;
  private lastError: PersistenceError | null = null;
  private unconfirmedCheckpointId: string | null = null;

  constructor(options: OpenSpatialSessionOptions) {
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

    // Read `validityWindowMs` / `now` explicitly rather than spreading the caller's
    // options object: object spread only copies own enumerable properties, so it
    // would silently drop class-prototype getters and fall back to defaults.
    this.voxel = new VoxelMap(options.worldId, {
      validityWindowMs: options.voxelOptions?.validityWindowMs,
      now: options.voxelOptions?.now,
      requireSession: true,
    });
    this.history = new FragmentStore(options.worldId, options.fragmentOptions);
    this.topology = new TopologyStore(this.history, options.topologyOptions);
  }

  async initialize(): Promise<void> {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    this.worker = worker;
    worker.on('message', (msg: WorkerResponse) => this.handleMessage(msg));
    worker.on('error', (err) => this.handleWorkerError(err));
    worker.on('exit', () => this.handleWorkerExit());

    let result: {
      baselineCheckpointId: string | null;
      snapshot: HistorySnapshot | null;
      voxelBaselineCheckpointId: string | null;
      voxelSnapshot: VoxelCheckpointSnapshot | null;
    };
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
      if (result.voxelSnapshot !== null) {
        this.voxel.restoreSnapshot(result.voxelSnapshot);
      }
    } catch (err) {
      this.lifecycle = 'closed';
      await this.terminateWorker();
      throw new PersistenceError('data', `restore failed: ${(err as Error).message}`);
    }
    this.baselineCheckpointId = result.baselineCheckpointId;
    this.voxelBaselineCheckpointId = result.voxelBaselineCheckpointId;
    this.confirmedFragmentRevision = this.history.revision;
    this.confirmedTopologyRevision = this.topology.revision;
    this.confirmedVoxelRevision = this.voxel.saveRevision;
  }

  async checkpoint(): Promise<SpatialCheckpointResult> {
    if (this.lifecycle === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new checkpoints are not accepted');
    }
    if (this.lifecycle === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new checkpoints are not accepted');
    }
    if (this.inFlight !== null) {
      throw new PersistenceError('busy', `a checkpoint is already in flight (${this.inFlight.checkpointId})`);
    }

    const voxelRevision = this.voxel.saveRevision;
    const fragmentRevision = this.history.revision;
    const topologyRevision = this.topology.revision;

    const maxBytes = this.limits.maxBytes;
    // Cheap lower bound first (2 × worldId `.length` + both fixed frames + 4 quotes):
    // each code unit encodes to ≥ 1 escaped byte, so this is a safe under-estimate
    // that rejects an obviously-over-limit worldId before scanning its characters.
    const frameTotal = SNAPSHOT_FRAME_BYTES + VOXEL_FRAME_BYTES;
    if (frameTotal + 2 * this.worldId.length + 4 > maxBytes) {
      throw new PersistenceError('capacity', `worldId alone exceeds maxBytes (${maxBytes})`);
    }
    // Compute the escaped worldId cost exactly once and reuse it in both envelopes.
    const escapedWorldId = jsonEscapedByteLength(this.worldId);
    const historyEnvelope = SNAPSHOT_FRAME_BYTES + escapedWorldId + 2;
    const voxelEnvelope = VOXEL_FRAME_BYTES + escapedWorldId + 2;
    if (historyEnvelope + voxelEnvelope > maxBytes) {
      throw new PersistenceError('capacity', `worldId alone exceeds maxBytes (${maxBytes})`);
    }

    const shared = maxBytes - historyEnvelope - voxelEnvelope;
    const historyMeasure = this.history.checkpointMeasure(shared);
    const afterHistory = shared - historyMeasure.bytes;
    const topologyMeasure = this.topology.checkpointMeasure(Math.max(0, afterHistory));
    const afterTopology = afterHistory - topologyMeasure.bytes;
    const voxelMeasure = this.voxel.checkpointMeasure(Math.max(0, afterTopology));

    const totalBytes =
      historyEnvelope +
      voxelEnvelope +
      interRecordCommas(
        historyMeasure.fragments,
        historyMeasure.traversals,
        topologyMeasure.nodes,
        topologyMeasure.edges,
      ) +
      Math.max(0, voxelMeasure.sections - 1) +
      historyMeasure.bytes +
      topologyMeasure.bytes +
      voxelMeasure.bytes;

    this.assertWithinLimits(
      historyMeasure.fragments,
      historyMeasure.traversals,
      topologyMeasure.nodes,
      topologyMeasure.edges,
      {
        polylinePoints: historyMeasure.polylinePoints,
        entrancePoints: historyMeasure.entrancePoints,
        linkPairs: historyMeasure.linkPairs,
        edgeEvidenceRefs: topologyMeasure.edgeEvidenceRefs,
        voxelSections: voxelMeasure.sections,
        observedCells: voxelMeasure.observedCells,
        paletteEntries: voxelMeasure.paletteEntries,
        bytes: totalBytes,
      },
    );

    const historySnapshot = this.history.checkpointSnapshot();
    const topologySnapshot = this.topology.checkpointSnapshot();
    const snapshot: HistorySnapshot = {
      worldId: this.worldId,
      fragments: historySnapshot.fragments,
      traversals: historySnapshot.traversals,
      nodes: topologySnapshot.nodes,
      edges: topologySnapshot.edges,
    };
    const voxelSnapshot: VoxelCheckpointSnapshot = this.voxel.checkpointSnapshot();

    const checkpointId = randomUUID();
    const promise = new Promise<SpatialCheckpointResult>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, {
        kind: 'checkpoint',
        checkpointId,
        voxelRevision,
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
        hasVoxel: true,
        voxelRevision,
        voxelSnapshot,
      } satisfies WorkerRequest);
    });
    this.inFlight = { checkpointId, promise };
    return promise;
  }

  getPersistenceState(): SpatialPersistenceState {
    return {
      lifecycle: this.lifecycle,
      voxelRevision: this.voxel.saveRevision,
      fragmentRevision: this.history.revision,
      topologyRevision: this.topology.revision,
      confirmedVoxelRevision: this.confirmedVoxelRevision,
      confirmedFragmentRevision: this.confirmedFragmentRevision,
      confirmedTopologyRevision: this.confirmedTopologyRevision,
      dirty: this.isDirty(),
      baselineCheckpointId: this.baselineCheckpointId,
      voxelBaselineCheckpointId: this.voxelBaselineCheckpointId,
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
      this.voxel.saveRevision !== this.confirmedVoxelRevision ||
      this.history.revision !== this.confirmedFragmentRevision ||
      this.topology.revision !== this.confirmedTopologyRevision
    );
  }

  private requestOpen(): Promise<{
    baselineCheckpointId: string | null;
    snapshot: HistorySnapshot | null;
    voxelBaselineCheckpointId: string | null;
    voxelSnapshot: VoxelCheckpointSnapshot | null;
  }> {
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
        kind: 'spatial',
      } satisfies WorkerRequest);
    });
  }

  private assertWithinLimits(
    fragments: number,
    traversals: number,
    nodes: number,
    edges: number,
    extra: {
      polylinePoints: number;
      entrancePoints: number;
      linkPairs: number;
      edgeEvidenceRefs: number;
      voxelSections: number;
      observedCells: number;
      paletteEntries: number;
      bytes: number;
    },
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
    if (extra.voxelSections > L.maxVoxelSections) throw over('maxVoxelSections', extra.voxelSections);
    if (extra.observedCells > L.maxObservedCells) throw over('maxObservedCells', extra.observedCells);
    if (extra.paletteEntries > L.maxPaletteEntries) throw over('maxPaletteEntries', extra.paletteEntries);
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
    if (entry === undefined) return;
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
      entry.resolve({
        baselineCheckpointId: openMsg.baselineCheckpointId,
        snapshot: openMsg.snapshot,
        voxelBaselineCheckpointId: openMsg.voxelBaselineCheckpointId,
        voxelSnapshot: openMsg.voxelSnapshot,
      });
    } else if (entry.kind === 'checkpoint') {
      const okMsg = msg as WorkerResponse & { type: 'checkpoint_ok' };
      this.inFlight = null;
      this.confirmedVoxelRevision = entry.voxelRevision!;
      this.confirmedFragmentRevision = entry.fragmentRevision!;
      this.confirmedTopologyRevision = entry.topologyRevision!;
      this.lastConfirmedCheckpointId = okMsg.checkpointId;
      entry.resolve({
        checkpointId: okMsg.checkpointId,
        worldId: this.worldId,
        voxelRevision: entry.voxelRevision!,
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
      this.lifecycle = 'closed';
      this.failAllPending(error);
      entry.reject(error);
      void this.terminateWorker();
      return;
    }
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
    if (this.pending.size === 0) return;
    const error = new PersistenceError('worker_communication', 'persistence worker exited before responding');
    this.lastError = error;
    this.lifecycle = 'closed';
    this.failAllPending(error);
  }

  private failAllPending(error: PersistenceError): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
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
