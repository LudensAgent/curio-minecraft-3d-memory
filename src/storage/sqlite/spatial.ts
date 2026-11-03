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
import { sectionKeyString } from '../../voxel/section.js';
import type { SectionKey } from '../../voxel/section.js';
import { resolveResidencyLimits } from '../../voxel/residency.js';
import type {
  ResolvedResidencyLimits,
  SectionResidencyInfo,
  UnloadSectionsResult,
  VoxelDirectoryEntry,
} from '../../voxel/residency.js';
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
  LoadSectionsResult,
  OpenSpatialSessionOptions,
  ResolvedSnapshotLimits,
  SessionLifecycle,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
  VoxelSaveMode,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type { HistorySnapshot } from './types.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';

interface PendingRequest {
  kind: 'open' | 'checkpoint' | 'load' | 'close';
  resolve: (value: unknown) => void;
  reject: (e: PersistenceError) => void;
  timer?: NodeJS.Timeout;
  checkpointId?: string;
  voxelRevision?: number;
  fragmentRevision?: number;
  topologyRevision?: number;
  /** How this checkpoint persisted voxel state, for the directory update on ACK. */
  voxelMode?: VoxelSaveMode;
  /** The captured (committed) voxel sections, for the directory update on ACK. */
  voxelSections?: VoxelSectionSnapshot[];
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
  private loadInFlight = false;
  private readonly voxelLoading: VoxelLoading;
  private readonly residencyLimits: ResolvedResidencyLimits;

  private confirmedVoxelRevision = 0;
  private confirmedFragmentRevision = 0;
  private confirmedTopologyRevision = 0;
  private baselineCheckpointId: string | null = null;
  private voxelBaselineCheckpointId: string | null = null;
  /** Whether a voxel save baseline exists (restored, or established this session). */
  private voxelBaselineEstablished = false;
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
    this.voxelLoading = options.voxelLoading ?? 'eager';
    this.residencyLimits = resolveResidencyLimits(options.residencyLimits);

    // Read `validityWindowMs` / `now` explicitly rather than spreading the caller's
    // options object: object spread only copies own enumerable properties, so it
    // would silently drop class-prototype getters and fall back to defaults.
    this.voxel = new VoxelMap(options.worldId, {
      validityWindowMs: options.voxelOptions?.validityWindowMs,
      now: options.voxelOptions?.now,
      requireSession: true,
      manualResidency: this.voxelLoading === 'manual',
      residencyLimits: options.residencyLimits,
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
      voxelDirectory: VoxelDirectoryEntry[] | null;
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
      if (this.voxelLoading === 'manual') {
        if (result.voxelDirectory !== null) {
          this.voxel.installDirectory(result.voxelDirectory);
        }
      } else if (result.voxelSnapshot !== null) {
        this.voxel.restoreSnapshot(result.voxelSnapshot);
      }
    } catch (err) {
      this.lifecycle = 'closed';
      await this.terminateWorker();
      throw new PersistenceError('data', `restore failed: ${(err as Error).message}`);
    }
    this.baselineCheckpointId = result.baselineCheckpointId;
    this.voxelBaselineCheckpointId = result.voxelBaselineCheckpointId;
    this.voxelBaselineEstablished = result.voxelBaselineCheckpointId !== null;
    this.confirmedFragmentRevision = this.history.revision;
    this.confirmedTopologyRevision = this.topology.revision;
    this.confirmedVoxelRevision = this.voxel.saveRevision;
    // Once initialization is complete the map is live: a second `restoreSnapshot`
    // must never silently replace its facts (see `sealInitialization`).
    this.voxel.sealInitialization();
  }

  async checkpoint(): Promise<SpatialCheckpointResult> {
    if (this.lifecycle === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new checkpoints are not accepted');
    }
    if (this.lifecycle === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new checkpoints are not accepted');
    }
    if (this.inFlight !== null || this.loadInFlight) {
      throw new PersistenceError('busy', `a persistence request is already in flight (${this.inFlight?.checkpointId ?? 'section load'})`);
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

    const historyCommas = interRecordCommas(
      historyMeasure.fragments,
      historyMeasure.traversals,
      topologyMeasure.nodes,
      topologyMeasure.edges,
    );

    // First save (no voxel baseline yet) replaces the whole set; once a baseline
    // exists, only the pending sections are copied, encoded and written.
    const voxelMode: VoxelSaveMode = this.voxelBaselineEstablished ? 'incremental' : 'full';

    // Bounded pre-flight: full-set counts (cheap) + the batch actually being sent.
    // `bytes` is the *batch* size — the worker still re-checks the post-increment
    // full set against the same limits before commit.
    let totalBytes: number;
    let voxelSections: number;
    let observedCells: number;
    let paletteEntries: number;
    if (voxelMode === 'full') {
      const voxelMeasure = this.voxel.checkpointMeasure(Math.max(0, afterTopology));
      totalBytes =
        historyEnvelope +
        voxelEnvelope +
        historyCommas +
        Math.max(0, voxelMeasure.sections - 1) +
        historyMeasure.bytes +
        topologyMeasure.bytes +
        voxelMeasure.bytes;
      voxelSections = voxelMeasure.sections;
      observedCells = voxelMeasure.observedCells;
      paletteEntries = voxelMeasure.paletteEntries;
    } else {
      // Full-set counts (not just resident) so a partial-resident map does not
      // under-count the committed fact set against the voxel capacity limits.
      const counts = this.voxel.checkpointFullCounts();
      const dirtyMeasure = this.voxel.checkpointDirtyMeasure(Math.max(0, afterTopology));
      totalBytes =
        historyEnvelope +
        voxelEnvelope +
        historyCommas +
        Math.max(0, dirtyMeasure.count - 1) +
        historyMeasure.bytes +
        topologyMeasure.bytes +
        dirtyMeasure.bytes;
      voxelSections = counts.sections;
      observedCells = counts.observedCells;
      paletteEntries = counts.paletteEntries;
    }

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
        voxelSections,
        observedCells,
        paletteEntries,
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
    // Deep copy only after the bounded pre-flight passed (before copy/postMessage).
    const voxelSnapshot: VoxelCheckpointSnapshot =
      voxelMode === 'full'
        ? this.voxel.checkpointSnapshot()
        : { worldId: this.worldId, sections: this.voxel.captureDirtySections() };

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
        voxelMode,
        voxelSections: voxelSnapshot.sections,
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
        voxelMode,
        voxelRevision,
        voxelSnapshot,
      } satisfies WorkerRequest);
    });
    this.inFlight = { checkpointId, promise };
    return promise;
  }

  sectionResidency(key: SectionKey): SectionResidencyInfo {
    return this.voxel.sectionResidency(key);
  }

  unloadSections(keys: readonly SectionKey[]): UnloadSectionsResult {
    return this.voxel.unloadSections(keys);
  }

  pinSections(keys: readonly SectionKey[]): { token: string; keys: SectionKey[] } {
    return this.voxel.pinSections(keys);
  }

  releasePins(tokens: readonly string[]): void {
    this.voxel.releasePins(tokens);
  }

  /**
   * Explicitly load committed sections into the resident working set (manual mode
   * only). Already-resident keys are skipped; keys with no committed record are
   * reported in `missing`. The loaded evidence keeps its original time/source and
   * reads as STALE — it never becomes a fresh observation or a current OPEN.
   */
  async loadSections(keys: readonly SectionKey[]): Promise<LoadSectionsResult> {
    if (this.voxelLoading !== 'manual') {
      throw new PersistenceError('invalid_argument', 'loadSections requires voxelLoading "manual"');
    }
    if (this.lifecycle === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new loads are not accepted');
    }
    if (this.lifecycle === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new loads are not accepted');
    }
    if (this.inFlight !== null || this.loadInFlight) {
      throw new PersistenceError('busy', 'a persistence request is already in flight');
    }

    const deduped = this.validateAndDedupeKeys(keys);
    if (deduped.length > this.residencyLimits.maxLoadBatchSections) {
      throw new PersistenceError(
        'capacity',
        `load request has ${deduped.length} sections, exceeding maxLoadBatchSections (${this.residencyLimits.maxLoadBatchSections})`,
      );
    }
    const fetch = deduped.filter((k) => this.voxel.sectionResidency(k).residency !== 'resident');
    if (fetch.length === 0) return { loaded: [], missing: [] };

    this.voxel.markLoading(fetch);
    this.loadInFlight = true;
    let sections: VoxelSectionSnapshot[];
    let missingCoords: { dim: string; cx: number; cz: number; sy: number }[];
    try {
      const result = await this.requestLoadSections(fetch);
      sections = result.sections;
      missingCoords = result.missing;
    } catch (err) {
      this.voxel.markLoadFailed(fetch);
      throw err;
    } finally {
      this.loadInFlight = false;
    }

    const missing = missingCoords.map((m) => ({ worldId: this.worldId, ...m }));
    this.voxel.clearTransientResidency(missing);
    const missingSet = new Set(missing.map((k) => sectionKeyString(k)));
    const toFail = fetch.filter((k) => !missingSet.has(sectionKeyString(k)));
    let installed: SectionKey[];
    try {
      installed = this.voxel.installLoadedSections(sections);
    } catch (err) {
      this.voxel.markLoadFailed(toFail);
      const message = (err as Error).message;
      throw new PersistenceError(/exceeds/.test(message) ? 'capacity' : 'data', message);
    }
    return { loaded: installed, missing };
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

  private validateAndDedupeKeys(keys: readonly SectionKey[]): SectionKey[] {
    const out: SectionKey[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (key.worldId !== this.worldId) {
        throw new PersistenceError(
          'invalid_argument',
          `section key worldId "${key.worldId}" does not match session worldId "${this.worldId}"`,
        );
      }
      if (typeof key.dim !== 'string' || key.dim.length === 0) {
        throw new PersistenceError('invalid_argument', 'section key dim must be a non-empty string');
      }
      if (!Number.isInteger(key.cx) || !Number.isInteger(key.cz) || !Number.isInteger(key.sy)) {
        throw new PersistenceError(
          'invalid_argument',
          `section key coordinates must be integers: (${key.cx}, ${key.cz}, ${key.sy})`,
        );
      }
      const s = sectionKeyString(key);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ ...key });
    }
    return out;
  }

  private requestLoadSections(keys: SectionKey[]): Promise<{
    sections: VoxelSectionSnapshot[];
    missing: { dim: string; cx: number; cz: number; sy: number }[];
  }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, { kind: 'load', resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker!.postMessage({
        type: 'load_sections',
        requestId,
        worldId: this.worldId,
        keys: keys.map((k) => ({ dim: k.dim, cx: k.cx, cz: k.cz, sy: k.sy })),
      } satisfies WorkerRequest);
    });
  }

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
    voxelDirectory: VoxelDirectoryEntry[] | null;
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
        voxelLoading: this.voxelLoading,
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
        voxelDirectory: openMsg.voxelDirectory,
      });
    } else if (entry.kind === 'load') {
      const loadMsg = msg as WorkerResponse & { type: 'load_ok' };
      entry.resolve({ sections: loadMsg.sections, missing: loadMsg.missing });
    } else if (entry.kind === 'checkpoint') {
      const okMsg = msg as WorkerResponse & { type: 'checkpoint_ok' };
      this.inFlight = null;
      // Clear only pending sections captured at (or before) this revision; a
      // section re-dirtied during the save keeps its newer pending entry.
      this.voxel.confirmSections(entry.voxelRevision!);
      // Update the committed directory from the *captured* snapshot (not the
      // ACK-time memory state), so a confirmed save is reflected as committed and
      // its committed metadata matches what the worker actually wrote.
      if (entry.voxelMode !== undefined && entry.voxelMode !== 'none') {
        this.voxel.commitDirectory(entry.voxelMode, entry.voxelSections ?? [], okMsg.voxelBytes);
      }
      this.voxelBaselineEstablished = true;
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
    if (entry.kind === 'load') {
      // A read timeout is distinct from an unconfirmed save (no checkpoint id is
      // fabricated), but the worker may still be running the slow read — so the
      // session must not accept new requests that would queue behind it. Poison and
      // terminate, exactly like a checkpoint timeout, to avoid an unbounded queue.
      const error = new PersistenceError('timeout', 'section load did not complete within timeout');
      this.lastError = error;
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
