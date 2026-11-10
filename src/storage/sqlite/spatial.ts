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
  VoxelDirectoryPage,
  VoxelDirectorySummary,
} from '../../voxel/residency.js';
import { jsonEscapedByteLength } from '../../bytes.js';
import {
  PersistenceError,
  resolveJournalLimits,
  resolveLedgerLimits,
  resolveSnapshotLimits,
  resolveTimeoutMs,
  SNAPSHOT_FRAME_BYTES,
  VOXEL_FRAME_BYTES,
} from './types.js';
import type {
  ActionJournalQuery,
  CloseResult,
  EventJournalQuery,
  FlushResult,
  HistoryLoading,
  JournalAcceptResult,
  JournalBatchAcceptResult,
  JournalBatchInput,
  JournalController,
  JournalPage,
  JournalQueryBase,
  JournalWithdrawalResult,
  JournalWithdrawalSelector,
  LedgerSnapshot,
  LoadSectionsResult,
  MeasureSectionsResult,
  OpenSpatialSessionOptions,
  PendingJournalSnapshot,
  ResolvedJournalLimits,
  ResolvedLedgerLimits,
  ResolvedSnapshotLimits,
  SessionLifecycle,
  SpatialCheckpointResult,
  SpatialEvent,
  SpatialEventKind,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
  VoxelSaveMode,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import { LedgerStore } from './ledger.js';
import type { LedgerDelta, LedgerDeltaCapture } from './ledger.js';
import type { ActionRecord } from '../../navigation/types.js';
import { PersistentFactStore } from '../../facts/persistent-fact-store.js';
import {
  FACT_MIGRATION_TARGET,
  FACT_MIGRATION_VERSION,
  type FactCheckpointSnapshot,
  type FactMigrationState,
  type FactStore,
} from '../../facts/types.js';
import { JournalQueue } from './journal.js';
import type { JournalCapture } from './journal.js';
import type { HistorySnapshot } from './types.js';
import { UNKNOWN_GAME_VERSION } from '../../voxel/serialization.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';
import { estimateVoxelSectionResidentBytesFromSnapshot } from '../../voxel/snapshot.js';

interface PendingRequest {
  kind: 'open' | 'checkpoint' | 'load' | 'directory' | 'query' | 'close';
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
  /** Exactly the voxel sections this batch may confirm; unselected dirty stays pending. */
  voxelKeys?: SectionKey[];
  removedVoxelKeys?: SectionKey[];
  /** Exact facts revision captured by this checkpoint (confirmed only on ACK). */
  factsRevision?: number;
  /** Whether this checkpoint captured the facts domain. */
  factsCaptured?: boolean;
  /** The captured journal batch, for the ACK-time pending clear. */
  journalCapture?: JournalCapture;
  /**
   * The ledger delta captured by this checkpoint. Its presence means this
   * checkpoint wrote ledger rows; its tokens make the ACK clear exactly what the
   * worker committed and keep rows re-dirtied afterwards pending.
   */
  ledgerCapture?: LedgerDeltaCapture;
}

interface InFlightCheckpoint {
  checkpointId: string;
  promise: Promise<SpatialCheckpointResult>;
  /** Exactly the voxel sections captured by this batch; the ACK confirms only these. */
  voxelKeys: SectionKey[];
  removedVoxelKeys: SectionKey[];
}

interface JournalQueryMessage {
  type: 'query_actions' | 'query_events';
  worldId: string;
  afterSeq: number;
  maxRecords: number;
  maxBytes: number;
  dim?: string;
  sessionId?: string;
  actionId?: string;
  eventId?: string;
  kind?: SpatialEventKind;
}

function optionalQueryString(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceError('invalid_argument', `${what} must be a non-empty string when present`);
  }
  return value;
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
  readonly ledger: LedgerStore;
  readonly facts: FactStore;

  get factsMigration(): FactMigrationState {
    return this.factsMigrationField;
  }

  get voxelLoading(): VoxelLoading {
    return this.voxelLoadingField;
  }

  get residencyLimits(): ResolvedResidencyLimits {
    return this.residencyLimitsField;
  }

  get lifecycle(): SessionLifecycle {
    return this.lifecycleField;
  }

  get busy(): boolean {
    return this.inFlight !== null || this.loadInFlight || this.workingSetLock || this.queryInFlight;
  }

  readonly journal: JournalController;

  private readonly worldId: string;
  private readonly databasePath: string;
  private readonly timeoutMs: number;
  private readonly limits: ResolvedSnapshotLimits;
  private readonly journalLimitsField: ResolvedJournalLimits;
  private readonly journalQueue: JournalQueue;
  private readonly ledgerLimitsField: ResolvedLedgerLimits;

  private worker: Worker | null = null;
  private lifecycleField: SessionLifecycle = 'open';
  private cleanlyClosed = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private inFlight: InFlightCheckpoint | null = null;
  private loadInFlight = false;
  private queryInFlight = false;
  private activeQuery: Promise<unknown> | null = null;
  /** Session-wide operation gate shared by working-set managers and direct load/save. */
  private workingSetLock = false;
  private readonly voxelLoadingField: VoxelLoading;
  private readonly historyLoadingField: HistoryLoading;
  /** True when a `none` open preserved an existing committed history/topology. */
  private preservedHistoryBaseline = false;
  private readonly residencyLimitsField: ResolvedResidencyLimits;
  /** Per-checkpoint voxel dirty batch cap; defaults to the full snapshot limit. */
  private readonly voxelBatchMaxBytes: number;
  /** Explicit caller-supplied game version (`undefined` records `'unknown'`). */
  private readonly gameVersionField: string | undefined;
  /** Game version of the voxel baseline this session restored/established. */
  private restoredGameVersion: string | null = null;

  private confirmedVoxelRevision = 0;
  private confirmedFragmentRevision = 0;
  private confirmedTopologyRevision = 0;
  private confirmedJournalRevision = 0;
  private confirmedLedgerRevision = 0;
  private confirmedFactsRevision = 0;
  private baselineCheckpointId: string | null = null;
  private voxelBaselineCheckpointId: string | null = null;
  private journalBaselineCheckpointId: string | null = null;
  private ledgerBaselineCheckpointId: string | null = null;
  private factsBaselineCheckpointId: string | null = null;
  private factsMigrationField: FactMigrationState = {
    version: 0,
    target: null,
    committed: false,
  };
  private committedJournalRecords = 0;
  private committedJournalBytes = 0;
  /** Whether a voxel save baseline exists (restored, or established this session). */
  private voxelBaselineEstablished = false;
  /** Whether the opened database already had committed voxel rows without a baseline. */
  private voxelRowsPresent = false;
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
    // Fail closed at the host boundary: an empty version is a caller error, never
    // silently recorded as `'unknown'`.
    if (options.gameVersion !== undefined && options.gameVersion.length === 0) {
      throw new PersistenceError('invalid_argument', 'gameVersion must be a non-empty string when supplied');
    }
    this.worldId = options.worldId;
    this.databasePath = options.databasePath;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
    this.limits = resolveSnapshotLimits(options.snapshotLimits);
    const batchMaxBytes = options.voxelBatchMaxBytes ?? this.limits.maxBytes;
    if (!Number.isSafeInteger(batchMaxBytes) || batchMaxBytes < 1) {
      throw new PersistenceError('invalid_argument', `voxelBatchMaxBytes must be a positive safe integer: ${String(batchMaxBytes)}`);
    }
    // A batch cannot exceed the total snapshot byte limit; reject at the boundary
    // instead of silently clamping a caller's configuration.
    if (batchMaxBytes > this.limits.maxBytes) {
      throw new PersistenceError(
        'invalid_argument',
        `voxelBatchMaxBytes (${batchMaxBytes}) must not exceed snapshotLimits.maxBytes (${this.limits.maxBytes})`,
      );
    }
    this.voxelBatchMaxBytes = batchMaxBytes;
    this.journalLimitsField = resolveJournalLimits(options.journalLimits);
    this.journalQueue = new JournalQueue(this.worldId, this.journalLimitsField);
    this.ledgerLimitsField = resolveLedgerLimits(options.ledgerLimits);
    this.ledger = new LedgerStore(this.worldId, this.ledgerLimitsField);
    this.facts = new PersistentFactStore({ worldId: this.worldId });
    this.journal = {
      recordAction: (record: ActionRecord): JournalAcceptResult => {
        this.assertJournalAccepting();
        return this.journalQueue.recordAction(record);
      },
      recordEvent: (event: SpatialEvent): JournalAcceptResult => {
        this.assertJournalAccepting();
        return this.journalQueue.recordEvent(event);
      },
      recordBatch: (batch: JournalBatchInput): JournalBatchAcceptResult => {
        this.assertJournalAccepting();
        return this.journalQueue.acceptBatch(batch);
      },
      readPending: (): PendingJournalSnapshot => this.journalQueue.readPending(),
      withdraw: (selector: JournalWithdrawalSelector): JournalWithdrawalResult => this.withdrawPending(selector),
    };
    this.voxelLoadingField = options.voxelLoading ?? 'eager';
    this.historyLoadingField = options.historyLoading ?? 'eager';
    if (this.historyLoadingField !== 'eager' && this.historyLoadingField !== 'none') {
      throw new Error(`historyLoading must be "eager" or "none", got ${String(this.historyLoadingField)}`);
    }
    this.residencyLimitsField = resolveResidencyLimits(options.residencyLimits);
    this.gameVersionField = options.gameVersion;

    // Read `validityWindowMs` / `now` explicitly rather than spreading the caller's
    // options object: object spread only copies own enumerable properties, so it
    // would silently drop class-prototype getters and fall back to defaults.
    this.voxel = new VoxelMap(options.worldId, {
      validityWindowMs: options.voxelOptions?.validityWindowMs,
      now: options.voxelOptions?.now,
      ...(options.voxelOptions?.onChange === undefined
        ? {}
        : { onChange: options.voxelOptions.onChange }),
      requireSession: true,
      manualResidency: this.voxelLoadingField === 'manual',
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
      voxelDirectoryKeys: SectionKey[];
      voxelDirectorySummary: VoxelDirectorySummary;
      journalBaselineCheckpointId: string | null;
      journalRevision: number;
      journalRecordCount: number;
      journalRecordBytes: number;
      ledgerBaselineCheckpointId: string | null;
      ledgerSnapshot: LedgerSnapshot | null;
      factsBaselineCheckpointId: string | null;
      factsSnapshot: FactCheckpointSnapshot | null;
      factsMigration: FactMigrationState;
      gameVersion: string | null;
    };
    try {
      result = await this.requestOpen();
    } catch (err) {
      this.lifecycleField = 'closed';
      await this.terminateWorker();
      throw err;
    }
    try {
      if (this.historyLoadingField === 'eager' && result.snapshot !== null) {
        this.history.restoreSnapshot(result.snapshot);
        this.topology.restoreSnapshot(result.snapshot);
      }
      if (this.historyLoadingField === 'none' && result.baselineCheckpointId !== null) {
        this.preservedHistoryBaseline = true;
      }
      if (this.voxelLoadingField === 'manual') {
        this.voxel.installDirectorySummary(result.voxelDirectorySummary, result.voxelDirectoryKeys);
      } else if (result.voxelSnapshot !== null) {
        this.voxel.restoreSnapshot(result.voxelSnapshot);
      }
      if (result.ledgerSnapshot !== null) {
        this.ledger.restoreSnapshot(result.ledgerSnapshot);
      }
      if (result.factsSnapshot !== null) {
        this.facts.installSnapshot(result.factsSnapshot);
      }
    } catch (err) {
      this.lifecycleField = 'closed';
      await this.terminateWorker();
      throw new PersistenceError('data', `restore failed: ${(err as Error).message}`);
    }
    this.baselineCheckpointId = result.baselineCheckpointId;
    this.voxelBaselineCheckpointId = result.voxelBaselineCheckpointId;
    this.voxelBaselineEstablished = result.voxelBaselineCheckpointId !== null;
    this.voxelRowsPresent = (result.voxelSnapshot?.sections.length ?? 0) > 0
      || result.voxelDirectorySummary.sections > 0;
    this.journalBaselineCheckpointId = result.journalBaselineCheckpointId;
    this.ledgerBaselineCheckpointId = result.ledgerBaselineCheckpointId;
    this.factsBaselineCheckpointId = result.factsBaselineCheckpointId;
    this.factsMigrationField = result.factsMigration;
    this.restoredGameVersion = result.gameVersion;
    this.committedJournalRecords = result.journalRecordCount;
    this.committedJournalBytes = result.journalRecordBytes;
    this.journalQueue.resetRevisionForRestore(result.journalRevision);
    this.confirmedJournalRevision = result.journalRevision;
    this.confirmedLedgerRevision = this.ledger.revision;
    this.confirmedFactsRevision = this.facts.confirmedRevision;
    this.confirmedFragmentRevision = this.history.revision;
    this.confirmedTopologyRevision = this.topology.revision;
    this.confirmedVoxelRevision = this.voxel.saveRevision;
    // Once initialization is complete the map is live: a second `restoreSnapshot`
    // must never silently replace its facts (see `sealInitialization`).
    this.voxel.sealInitialization();
  }

  async checkpoint(options: { deadlineMs?: number } = {}): Promise<SpatialCheckpointResult> {
    if (this.lifecycleField === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new checkpoints are not accepted');
    }
    if (this.lifecycleField === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new checkpoints are not accepted');
    }
    if (this.inFlight !== null || this.loadInFlight || this.workingSetLock || this.queryInFlight) {
      throw new PersistenceError('busy', 'a persistence request is already in flight');
    }
    if (options.deadlineMs !== undefined
      && (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0)) {
      throw new PersistenceError('invalid_argument', 'checkpoint deadlineMs must be a positive finite epoch millisecond');
    }
    const deadlineMs = options.deadlineMs;
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new PersistenceError('timeout', 'checkpoint deadline expired before capture');
    }

    let voxelRevision = this.voxel.saveRevision;
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

    // Only domains whose revision leads their confirmed revision are sent and
    // rewritten. A clean domain contributes an empty snapshot and its measure is
    // zero; the worker leaves its committed rows and baseline untouched.
    const historyMode: 'full' | 'none' =
      this.history.revision !== this.confirmedFragmentRevision ? 'full' : 'none';
    const topologyMode: 'full' | 'none' =
      this.topology.revision !== this.confirmedTopologyRevision ? 'full' : 'none';
    if (this.preservedHistoryBaseline && (historyMode === 'full' || topologyMode === 'full')) {
      throw new PersistenceError(
        'data',
        'historyLoading "none" preserved an existing history/topology baseline; refusing to replace it with a full snapshot from an unloaded domain (migrate explicitly)',
      );
    }

    const shared = maxBytes - historyEnvelope - voxelEnvelope;
    const historyMeasure =
      historyMode === 'full'
        ? this.history.checkpointMeasure(shared)
        : { fragments: 0, traversals: 0, polylinePoints: 0, entrancePoints: 0, linkPairs: 0, bytes: 0 };
    const afterHistory = shared - historyMeasure.bytes;
    const topologyMeasure =
      topologyMode === 'full'
        ? this.topology.checkpointMeasure(Math.max(0, afterHistory))
        : { nodes: 0, edges: 0, edgeEvidenceRefs: 0, bytes: 0 };
    const afterTopology = afterHistory - topologyMeasure.bytes;

    const historyCommas = interRecordCommas(
      historyMeasure.fragments,
      historyMeasure.traversals,
      topologyMeasure.nodes,
      topologyMeasure.edges,
    );

    // The first save on an empty database can use incremental upserts, so a large
    // initial map is also split by voxelBatchMaxBytes. A database that already has
    // voxel rows without a baseline keeps the replacing full mode.
    const voxelMode: VoxelSaveMode = this.voxelBaselineEstablished || !this.voxelRowsPresent
      ? 'incremental'
      : 'full';

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
      const dirtyMeasure = this.voxel.checkpointDirtyMeasureBounded(
        Math.min(this.voxelBatchMaxBytes, Math.max(0, afterTopology)),
        deadlineMs,
      );
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

    // Copy only dirty domains after the bounded pre-flight passed. A clean domain
    // is sent as empty arrays under its `none` mode, never as a stale full copy.
    const historySnapshot = historyMode === 'full' ? this.history.checkpointSnapshot() : null;
    const topologySnapshot = topologyMode === 'full' ? this.topology.checkpointSnapshot() : null;
    const snapshot: HistorySnapshot = {
      worldId: this.worldId,
      fragments: historySnapshot?.fragments ?? [],
      traversals: historySnapshot?.traversals ?? [],
      nodes: topologySnapshot?.nodes ?? [],
      edges: topologySnapshot?.edges ?? [],
      portalEdges: topologySnapshot?.portalEdges ?? [],
      fragmentMerges: topologySnapshot?.fragmentMerges ?? [],
    };
    // Deep copy only after the bounded pre-flight passed (before copy/postMessage).
    let voxelSnapshot: VoxelCheckpointSnapshot;
    let voxelKeys: SectionKey[];
    let removedVoxelKeys: SectionKey[];
    if (voxelMode === 'full') {
      voxelSnapshot = this.voxel.checkpointSnapshot();
      voxelKeys = voxelSnapshot.sections.map((section) => ({
        worldId: this.worldId, dim: section.dim, cx: section.cx, cz: section.cz, sy: section.sy,
      }));
      removedVoxelKeys = (voxelSnapshot.removedSections ?? []).map((section) => ({
        worldId: this.worldId, ...section,
      }));
    } else {
      const batch = this.voxel.captureDirtySectionsBounded(
        Math.min(this.voxelBatchMaxBytes, Math.max(0, afterTopology)),
        deadlineMs,
      );
      voxelSnapshot = {
        worldId: this.worldId,
        sections: batch.sections,
        removedSections: batch.removedSections.map(({ dim, cx, cz, sy }) => ({ dim, cx, cz, sy })),
      };
      voxelKeys = batch.keys;
      removedVoxelKeys = batch.removedSections;
      // A split batch acknowledges only this prefix; unselected sections keep
      // higher pending entries and the next checkpoint saves them.
      voxelRevision = batch.capturedRevision;
    }

    // Capture the exact pending batch/revision now. Records accepted after this
    // line keep a higher local revision and survive this ACK.
    const journalCapture = this.journalQueue.capture(
      this.journalLimitsField.maxBatchRecords,
      this.journalLimitsField.maxBatchBytes,
    );

    // Ledger: the first save in this session is a full replacement (so an omitted
    // row can never be read as a deletion); later saves send only the rows changed
    // since the previous confirmed capture. The worker re-reads the committed set
    // inside the transaction and enforces the full-set capacity/byte bounds there,
    // so a delta is never the authority for what stays on disk.
    let ledgerMode: 'none' | 'full' | 'delta' = 'none';
    let ledgerSnapshot: LedgerSnapshot | undefined;
    let ledgerDelta: LedgerDelta | undefined;
    let ledgerCapture: LedgerDeltaCapture | undefined;
    if (this.ledger.revision !== this.confirmedLedgerRevision) {
      const capture = this.ledger.captureDelta();
      ledgerCapture = capture;
      if (this.ledgerBaselineCheckpointId === null) {
        ledgerMode = 'full';
        ledgerSnapshot = this.ledger.snapshot();
        if (ledgerSnapshot.placed.length > this.ledgerLimitsField.maxPlacedBlocks) {
          throw new PersistenceError('capacity', `ledger exceeds maxPlacedBlocks (${ledgerSnapshot.placed.length})`);
        }
        if (ledgerSnapshot.visits.length > this.ledgerLimitsField.maxChunkVisits) {
          throw new PersistenceError('capacity', `ledger exceeds maxChunkVisits (${ledgerSnapshot.visits.length})`);
        }
        if (ledgerSnapshot.traversals.length > this.ledgerLimitsField.maxPortalTraversals) {
          throw new PersistenceError(
            'capacity',
            `ledger exceeds maxPortalTraversals (${ledgerSnapshot.traversals.length})`,
          );
        }
        const ledgerBytes = Buffer.byteLength(JSON.stringify(ledgerSnapshot), 'utf8');
        if (ledgerBytes > this.ledgerLimitsField.maxBytes) {
          throw new PersistenceError('capacity', `ledger exceeds maxBytes (${ledgerBytes})`);
        }
      } else {
        ledgerMode = 'delta';
        ledgerDelta = {
          worldId: capture.worldId,
          placedUpserts: capture.placedUpserts,
          placedRemovals: capture.placedRemovals,
          visitUpserts: capture.visitUpserts,
          visitRemovals: capture.visitRemovals,
          traversals: capture.traversals,
        };
      }
    }
    const ledgerRevision = ledgerCapture?.revision ?? this.confirmedLedgerRevision;

    // Facts: only a domain that actually changed since its confirmed revision is
    // captured and replaced. Capture is synchronous and takes the exact revision
    // an ACK must confirm; later writes keep a newer revision pending.
    const factsCaptured = this.facts.revision !== this.confirmedFactsRevision;
    const factsSnapshot: FactCheckpointSnapshot | undefined = factsCaptured
      ? this.facts.checkpointSnapshot()
      : undefined;
    const factsRevision = factsSnapshot?.revision ?? this.confirmedFactsRevision;
    if (factsSnapshot !== undefined) {
      const count =
        factsSnapshot.places.length + factsSnapshot.resources.length + factsSnapshot.containers.length;
      if (count > this.limits.maxFacts) {
        throw new PersistenceError('capacity', `facts exceed maxFacts (${count})`);
      }
      const factBytes = Buffer.byteLength(JSON.stringify(factsSnapshot), 'utf8');
      if (factBytes > this.limits.maxFactBytes) {
        throw new PersistenceError('capacity', `facts exceed maxFactBytes (${factBytes})`);
      }
    }

    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new PersistenceError('timeout', 'checkpoint deadline expired before the worker commit');
    }
    const checkpointId = randomUUID();
    const promise = new Promise<SpatialCheckpointResult>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const waitMs = deadlineMs === undefined
        ? this.timeoutMs
        : Math.max(1, Math.min(this.timeoutMs, deadlineMs - Date.now()));
      const timer = setTimeout(() => this.onTimeout(requestId), waitMs);
      this.pending.set(requestId, {
        kind: 'checkpoint',
        checkpointId,
        voxelRevision,
        fragmentRevision,
        topologyRevision,
        voxelMode,
        voxelSections: voxelSnapshot.sections,
        voxelKeys,
        removedVoxelKeys,
        journalCapture,
        ledgerCapture,
        factsRevision,
        factsCaptured,
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
        journalMode: 'append',
        journalRevision: journalCapture.revision,
        journalBatch: { actions: journalCapture.actions, events: journalCapture.events },
        historyMode,
        topologyMode,
        ledgerMode,
        ledgerRevision,
        ...(ledgerSnapshot === undefined ? {} : { ledgerSnapshot }),
        ...(ledgerDelta === undefined ? {} : { ledgerDelta }),
        factsMode: factsCaptured ? 'full' : 'none',
        factsRevision,
        ...(factsSnapshot === undefined ? {} : { factsSnapshot }),
        gameVersion: this.gameVersionField,
      } satisfies WorkerRequest);
    });
    this.inFlight = { checkpointId, promise, voxelKeys, removedVoxelKeys };
    return promise;
  }

  sectionResidency(key: SectionKey): SectionResidencyInfo {
    return this.voxel.sectionResidency(key);
  }

  async directoryPage(options: { after?: number; limit?: number } = {}): Promise<VoxelDirectoryPage> {
    if (this.voxelLoadingField !== 'manual') {
      throw new PersistenceError('invalid_argument', 'directoryPage requires voxelLoading "manual"');
    }
    if (this.lifecycleField === 'closing' || this.lifecycleField === 'closed') {
      throw new PersistenceError(this.lifecycleField === 'closing' ? 'closing' : 'closed', 'directoryPage requires an open session');
    }
    const after = options.after;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
      throw new PersistenceError('invalid_argument', 'directory after must be a non-negative safe integer');
    }
    const limit = options.limit ?? 128;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
      throw new PersistenceError('invalid_argument', 'directory limit must be an integer in 1..1024');
    }
    const requestId = this.nextRequestId++;
    return new Promise<VoxelDirectoryPage>((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, {
        kind: 'directory',
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.worker!.postMessage({
        type: 'directory_page',
        requestId,
        worldId: this.worldId,
        ...(after === undefined ? {} : { after }),
        limit,
      } satisfies WorkerRequest);
    });
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
    if (this.workingSetLock) {
      throw new PersistenceError('busy', 'a working-set operation is in flight');
    }
    const { sections, missing } = await this.measureSections(keys);
    if (sections.length === 0) return { loaded: [], missing };
    return { loaded: this.installSections(sections), missing };
  }

  /**
   * Bounded read: decode the requested committed sections *without* installing them,
   * returning their snapshots and their exact resident cost. The caller (a
   * working-set manager) holds the session operation gate while it drives
   * measure → evict → install, so this method does not re-check `workingSetLock`.
   */
  async measureSections(keys: readonly SectionKey[]): Promise<MeasureSectionsResult> {
    if (this.voxelLoadingField !== 'manual') {
      throw new PersistenceError('invalid_argument', 'measureSections requires voxelLoading "manual"');
    }
    if (this.lifecycleField === 'closing') {
      throw new PersistenceError('closing', 'session is closing; new loads are not accepted');
    }
    if (this.lifecycleField === 'closed') {
      throw new PersistenceError('closed', 'session is closed; new loads are not accepted');
    }
    if (this.inFlight !== null || this.loadInFlight || this.queryInFlight) {
      throw new PersistenceError('busy', 'a persistence request is already in flight');
    }

    const deduped = this.validateAndDedupeKeys(keys);
    if (deduped.length > this.residencyLimitsField.maxLoadBatchSections) {
      throw new PersistenceError(
        'capacity',
        `load request has ${deduped.length} sections, exceeding maxLoadBatchSections (${this.residencyLimitsField.maxLoadBatchSections})`,
      );
    }
    const fetch = deduped.filter((k) => this.voxel.sectionResidency(k).residency !== 'resident');
    if (fetch.length === 0) return { sections: [], missing: [], residentBytes: 0 };

    this.voxel.markLoading(fetch);
    this.loadInFlight = true;
    try {
      const result = await this.requestLoadSections(fetch);
      const missing = result.missing.map((m) => ({ worldId: this.worldId, ...m }));
      this.voxel.clearTransientResidency(missing);
      const residentBytes = result.sections.reduce(
        (sum, section) => sum + estimateVoxelSectionResidentBytesFromSnapshot(section),
        0,
      );
      return { sections: result.sections, missing, residentBytes };
    } catch (err) {
      this.voxel.markLoadFailed(fetch);
      throw err;
    } finally {
      this.loadInFlight = false;
    }
  }

  /** Install already-measured snapshots; every abandon path marks them load_failed. */
  installSections(sections: readonly VoxelSectionSnapshot[]): SectionKey[] {
    const keys: SectionKey[] = sections.map((s) => ({ worldId: this.worldId, dim: s.dim, cx: s.cx, cz: s.cz, sy: s.sy }));
    const fail = (error: PersistenceError): never => {
      this.voxel.markLoadFailed(keys);
      throw error;
    };
    if (this.lifecycleField === 'closing') {
      return fail(new PersistenceError('closing', 'session is closing; installs are not accepted'));
    }
    if (this.lifecycleField === 'closed') {
      return fail(new PersistenceError('closed', 'session is closed; installs are not accepted'));
    }
    // Reject a stale snapshot whose revision no longer matches the committed record,
    // so a caller cannot install an old measure over a newer saved fact.
    for (const raw of sections) {
      const committed = this.voxel.sectionResidency({ worldId: this.worldId, dim: raw.dim, cx: raw.cx, cz: raw.cz, sy: raw.sy }).committed;
      if (committed !== undefined && committed.revision !== raw.revision) {
        return fail(
          new PersistenceError(
            'data',
            `stale section snapshot (${raw.dim}, ${raw.cx}, ${raw.cz}, ${raw.sy}): revision ${raw.revision} does not match committed revision ${committed.revision}`,
          ),
        );
      }
    }
    try {
      return this.voxel.installLoadedSections(sections);
    } catch (err) {
      const message = (err as Error).message;
      // `installLoadedSections` reports "would exceed maxResidentSections/Bytes"
      // (first person "exceed"), so match both spellings.
      return fail(new PersistenceError(/exceed/.test(message) ? 'capacity' : 'data', message));
    }
  }

  /**
   * Acquire the session-wide operation gate shared by every working-set manager and
   * the direct load/checkpoint entries. Throws busy when any operation is in flight.
   */
  acquireWorkingSetOperation(): void {
    if (this.lifecycleField === 'closing') {
      throw new PersistenceError('closing', 'session is closing; working-set operations are not accepted');
    }
    if (this.lifecycleField === 'closed') {
      throw new PersistenceError('closed', 'session is closed; working-set operations are not accepted');
    }
    if (this.workingSetLock) {
      throw new PersistenceError('busy', 'another working-set operation is in flight');
    }
    if (this.inFlight !== null || this.loadInFlight || this.queryInFlight) {
      throw new PersistenceError('busy', 'a persistence request is in flight');
    }
    this.workingSetLock = true;
  }

  /** Release the session-wide operation gate. */
  releaseWorkingSetOperation(): void {
    this.workingSetLock = false;
  }

  getPersistenceState(): SpatialPersistenceState {
    return {
      lifecycle: this.lifecycleField,
      voxelRevision: this.voxel.saveRevision,
      fragmentRevision: this.history.revision,
      topologyRevision: this.topology.revision,
      confirmedVoxelRevision: this.confirmedVoxelRevision,
      confirmedFragmentRevision: this.confirmedFragmentRevision,
      confirmedTopologyRevision: this.confirmedTopologyRevision,
      dirty: this.isDirty(),
      baselineCheckpointId: this.baselineCheckpointId,
      voxelBaselineCheckpointId: this.voxelBaselineCheckpointId,
      journalRevision: this.journalQueue.revision,
      confirmedJournalRevision: this.confirmedJournalRevision,
      journalBaselineCheckpointId: this.journalBaselineCheckpointId,
      ledgerRevision: this.ledger.revision,
      confirmedLedgerRevision: this.confirmedLedgerRevision,
      ledgerBaselineCheckpointId: this.ledgerBaselineCheckpointId,
      factsRevision: this.facts.revision,
      confirmedFactsRevision: this.confirmedFactsRevision,
      factsBaselineCheckpointId: this.factsBaselineCheckpointId,
      factsMigration: this.factsMigrationField,
      restoredGameVersion: this.restoredGameVersion,
      pendingJournalRecords: this.journalQueue.pendingRecords,
      pendingJournalBytes: this.journalQueue.pendingBytes,
      committedJournalRecords: this.committedJournalRecords,
      committedJournalBytes: this.committedJournalBytes,
      lastConfirmedCheckpointId: this.lastConfirmedCheckpointId,
      inFlightCheckpointId: this.inFlight?.checkpointId ?? null,
      unconfirmedCheckpointId: this.unconfirmedCheckpointId,
      lastError: this.lastError,
    };
  }

  /** Bounded read of committed action records through the same worker gate. */
  async queryActions(query: ActionJournalQuery = {}): Promise<JournalPage<ActionRecord>> {
    const page = this.resolveJournalQuery(query);
    const actionId = optionalQueryString(query.actionId, 'actionId');
    return this.sendJournalQuery<ActionRecord>({
      type: 'query_actions',
      worldId: this.worldId,
      ...page,
      actionId,
    });
  }

  /** Bounded read of committed spatial events through the same worker gate. */
  async queryEvents(query: EventJournalQuery = {}): Promise<JournalPage<SpatialEvent>> {
    const page = this.resolveJournalQuery(query);
    const eventId = optionalQueryString(query.eventId, 'eventId');
    const kind = query.kind;
    if (
      kind !== undefined &&
      kind !== 'observed_cell_change' &&
      kind !== 'cell_blocked' &&
      kind !== 'cell_cleared' &&
      kind !== 'cell_revalidated' &&
      kind !== 'observation_gap'
    ) {
      throw new PersistenceError('invalid_argument', `unsupported spatial event kind filter: ${String(kind)}`);
    }
    return this.sendJournalQuery<SpatialEvent>({
      type: 'query_events',
      worldId: this.worldId,
      ...page,
      eventId,
      kind,
    });
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
    if (this.lifecycleField === 'closed') {
      return {
        completed: this.cleanlyClosed,
        lastConfirmedCheckpointId: this.lastConfirmedCheckpointId,
        unconfirmedRequest: this.inFlight !== null || this.unconfirmedCheckpointId !== null,
        dirty: this.isDirty(),
        error: this.lastError,
      };
    }

    this.lifecycleField = 'closing';
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

    // An already-accepted read is awaited (inside the same deadline) so close
    // does not terminate its worker mid-query. Query failures are reported to
    // that caller; they are not unsaved writes.
    if (this.activeQuery !== null) {
      try {
        await this.activeQuery;
      } catch {
        // already surfaced through lastError / the query promise
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
    this.lifecycleField = 'closed';
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

  private assertJournalAccepting(): void {
    if (this.lifecycleField === 'closing') {
      throw new PersistenceError('closing', 'session is closing; journal records are not accepted');
    }
    if (this.lifecycleField === 'closed') {
      throw new PersistenceError('closed', 'session is closed; journal records are not accepted');
    }
  }

  private withdrawPending(selector: JournalWithdrawalSelector): JournalWithdrawalResult {
    // The simplest safe rule: no withdrawal while any checkpoint may be covering
    // these entries. Withdrawal is local and never touches committed rows.
    if (this.inFlight !== null) {
      throw new PersistenceError('busy', 'a checkpoint is in flight; pending journal withdrawal is not accepted');
    }
    return this.journalQueue.withdraw(selector);
  }

  private resolveJournalQuery(query: JournalQueryBase | undefined): {
    dim?: string;
    sessionId?: string;
    afterSeq: number;
    maxRecords: number;
    maxBytes: number;
  } {
    const q: JournalQueryBase = query ?? {};
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      throw new PersistenceError('invalid_argument', 'journal query must be an object');
    }
    const dim = optionalQueryString(q.dim, 'dim');
    const sessionId = optionalQueryString(q.sessionId, 'sessionId');
    const maxRecords = q.maxRecords ?? this.journalLimitsField.maxPageRecords;
    if (
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1 ||
      maxRecords > this.journalLimitsField.maxPageRecords
    ) {
      throw new PersistenceError(
        'invalid_argument',
        `maxRecords must be within 1..${this.journalLimitsField.maxPageRecords}`,
      );
    }
    const maxBytes = q.maxBytes ?? this.journalLimitsField.maxPageBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.journalLimitsField.maxPageBytes) {
      throw new PersistenceError(
        'invalid_argument',
        `maxBytes must be within 1..${this.journalLimitsField.maxPageBytes}`,
      );
    }
    let afterSeq = 0;
    if (q.cursor !== undefined) {
      if (typeof q.cursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(q.cursor)) {
        throw new PersistenceError('invalid_argument', 'cursor must be an opaque string from a previous journal page');
      }
      const parsed = Number(q.cursor);
      if (!Number.isSafeInteger(parsed)) {
        throw new PersistenceError('invalid_argument', 'cursor is out of range');
      }
      afterSeq = parsed;
    }
    return { dim, sessionId, afterSeq, maxRecords, maxBytes };
  }

  private async sendJournalQuery<T>(msg: JournalQueryMessage): Promise<JournalPage<T>> {
    if (this.lifecycleField === 'closing') {
      throw new PersistenceError('closing', 'session is closing; journal queries are not accepted');
    }
    if (this.lifecycleField === 'closed') {
      throw new PersistenceError('closed', 'session is closed; journal queries are not accepted');
    }
    if (this.inFlight !== null || this.loadInFlight || this.workingSetLock || this.queryInFlight) {
      throw new PersistenceError('busy', 'a persistence request is already in flight');
    }
    this.queryInFlight = true;
    const promise = new Promise<JournalPage<T>>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => this.onTimeout(requestId), this.timeoutMs);
      this.pending.set(requestId, {
        kind: 'query',
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.worker!.postMessage({ ...msg, requestId });
    });
    this.activeQuery = promise;
    try {
      return await promise;
    } finally {
      this.queryInFlight = false;
      if (this.activeQuery === promise) this.activeQuery = null;
    }
  }

  private isDirty(): boolean {
    return (
      this.voxel.saveRevision !== this.confirmedVoxelRevision ||
      this.voxel.hasPendingChanges() ||
      this.history.revision !== this.confirmedFragmentRevision ||
      this.topology.revision !== this.confirmedTopologyRevision ||
      this.journalQueue.revision !== this.confirmedJournalRevision ||
      this.ledger.revision !== this.confirmedLedgerRevision ||
      this.facts.hasPendingChanges()
    );
  }

  private requestOpen(): Promise<{
    baselineCheckpointId: string | null;
    snapshot: HistorySnapshot | null;
    voxelBaselineCheckpointId: string | null;
    voxelSnapshot: VoxelCheckpointSnapshot | null;
    voxelDirectoryKeys: SectionKey[];
    voxelDirectorySummary: VoxelDirectorySummary;
    journalBaselineCheckpointId: string | null;
    journalRevision: number;
    journalRecordCount: number;
    journalRecordBytes: number;
    ledgerBaselineCheckpointId: string | null;
    ledgerSnapshot: LedgerSnapshot | null;
    factsBaselineCheckpointId: string | null;
    factsSnapshot: FactCheckpointSnapshot | null;
    factsMigration: FactMigrationState;
    gameVersion: string | null;
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
        journalLimits: this.journalLimitsField,
        ledgerLimits: this.ledgerLimitsField,
        kind: 'spatial',
        historyLoading: this.historyLoadingField,
        voxelLoading: this.voxelLoadingField,
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
        voxelDirectoryKeys: openMsg.voxelDirectoryKeys,
        voxelDirectorySummary: openMsg.voxelDirectorySummary,
        journalBaselineCheckpointId: openMsg.journalBaselineCheckpointId,
        journalRevision: openMsg.journalRevision,
        journalRecordCount: openMsg.journalRecordCount,
        journalRecordBytes: openMsg.journalRecordBytes,
        ledgerBaselineCheckpointId: openMsg.ledgerBaselineCheckpointId,
        ledgerSnapshot: openMsg.ledgerSnapshot,
        factsBaselineCheckpointId: openMsg.factsBaselineCheckpointId,
        factsSnapshot: openMsg.factsSnapshot,
        factsMigration: openMsg.factsMigration,
        gameVersion: openMsg.gameVersion,
      });
    } else if (entry.kind === 'load') {
      const loadMsg = msg as WorkerResponse & { type: 'load_ok' };
      entry.resolve({ sections: loadMsg.sections, missing: loadMsg.missing });
    } else if (entry.kind === 'directory') {
      if (msg.type !== 'directory_page_ok') {
        entry.reject(new PersistenceError('data', 'unexpected worker response to directory page'));
        return;
      }
      entry.resolve(msg.page);
    } else if (entry.kind === 'query') {
      if (msg.type !== 'query_actions_ok' && msg.type !== 'query_events_ok') {
        entry.reject(new PersistenceError('data', 'unexpected worker response to journal query'));
        return;
      }
      entry.resolve({
        records: msg.records,
        nextCursor: msg.nextCursor,
        hasMore: msg.hasMore,
      });
    } else if (entry.kind === 'checkpoint') {
      const okMsg = msg as WorkerResponse & { type: 'checkpoint_ok' };
      this.inFlight = null;
      // Clear exactly the captured section keys at (or before) this revision; a
      // section re-dirtied during the save keeps its newer pending entry, and a
      // split batch never clears an unselected tail.
      this.voxel.confirmCapturedSections(
        entry.voxelKeys ?? [],
        entry.removedVoxelKeys ?? [],
        entry.voxelRevision!,
      );
      // Update the committed directory from the *captured* snapshot (not the
      // ACK-time memory state), so a confirmed save is reflected as committed and
      // its committed metadata matches what the worker actually wrote.
      if (entry.voxelMode !== undefined && entry.voxelMode !== 'none') {
        this.voxel.commitDirectory(
          entry.voxelMode,
          entry.voxelSections ?? [],
          okMsg.voxelBytes,
          entry.removedVoxelKeys ?? [],
        );
        // This confirmed checkpoint wrote voxel rows, so it is the new voxel
        // baseline and its rows carry exactly this session's version. A
        // history-only checkpoint never changes the voxel baseline's version.
        this.restoredGameVersion = this.gameVersionField ?? UNKNOWN_GAME_VERSION;
      }
      this.voxelBaselineEstablished = true;
      // A split batch may confirm an older revision after a newer one; the
      // confirmed marker only advances, while per-key pending state decides dirty.
      this.confirmedVoxelRevision = Math.max(this.confirmedVoxelRevision, entry.voxelRevision!);
      this.confirmedFragmentRevision = entry.fragmentRevision!;
      this.confirmedTopologyRevision = entry.topologyRevision!;
      if (entry.ledgerCapture !== undefined) {
        // Clear exactly the captured rows; a key re-dirtied after capture keeps
        // its newer pending entry and is re-sent by the next checkpoint.
        this.ledger.confirmDelta(entry.ledgerCapture);
        this.confirmedLedgerRevision = entry.ledgerCapture.revision;
        this.ledgerBaselineCheckpointId = okMsg.checkpointId;
      }
      if (entry.factsCaptured === true && entry.factsRevision !== undefined) {
        // Confirm exactly the captured revision. A write after capture keeps a
        // newer revision pending, and a delayed ACK cannot lower the marker.
        this.facts.confirmRevision(entry.factsRevision);
        this.confirmedFactsRevision = Math.max(this.confirmedFactsRevision, entry.factsRevision);
        this.factsBaselineCheckpointId = okMsg.checkpointId;
        this.factsMigrationField = {
          version: FACT_MIGRATION_VERSION,
          target: FACT_MIGRATION_TARGET,
          committed: true,
        };
      }
      // Clear only the captured journal entries; newer acceptances stay pending.
      if (entry.journalCapture !== undefined) {
        this.journalQueue.confirm(entry.journalCapture.keys, entry.journalCapture.revision);
        this.confirmedJournalRevision = entry.journalCapture.revision;
        this.journalBaselineCheckpointId = okMsg.checkpointId;
      }
      this.committedJournalRecords = okMsg.journalRecordCount;
      this.committedJournalBytes = okMsg.journalRecordBytes;
      this.lastConfirmedCheckpointId = okMsg.checkpointId;
      entry.resolve({
        checkpointId: okMsg.checkpointId,
        worldId: this.worldId,
        voxelRevision: entry.voxelRevision!,
        fragmentRevision: entry.fragmentRevision!,
        topologyRevision: entry.topologyRevision!,
        // Exact captured (and now ACK-confirmed) revision, not the latest queue
        // revision. A truncated capture reports only its confirmed prefix.
        journalRevision: entry.journalCapture?.revision ?? this.confirmedJournalRevision,
        ledgerRevision: entry.ledgerCapture?.revision ?? this.confirmedLedgerRevision,
        factsRevision: entry.factsCaptured === true
          ? entry.factsRevision ?? this.confirmedFactsRevision
          : this.confirmedFactsRevision,
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
      this.lifecycleField = 'closed';
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
      this.lifecycleField = 'closed';
      this.failAllPending(error);
      entry.reject(error);
      void this.terminateWorker();
      return;
    }
    if (entry.kind === 'load' || entry.kind === 'query') {
      // A read timeout is distinct from an unconfirmed save (no checkpoint id is
      // fabricated), but the worker may still be running the slow read — so the
      // session must not accept new requests that would queue behind it. Poison and
      // terminate, exactly like a checkpoint timeout, to avoid an unbounded queue.
      const error = new PersistenceError(
        'timeout',
        entry.kind === 'load' ? 'section load did not complete within timeout' : 'journal query did not complete within timeout',
      );
      this.lastError = error;
      this.lifecycleField = 'closed';
      this.failAllPending(error);
      entry.reject(error);
      void this.terminateWorker();
      return;
    }
    this.lifecycleField = 'closed';
    void this.terminateWorker();
    entry.resolve(false);
  }

  private handleWorkerError(err: Error): void {
    const error = new PersistenceError(
      'worker_communication',
      `persistence worker error (is better-sqlite3 installed?): ${err.message}`,
    );
    this.lastError = error;
    this.lifecycleField = 'closed';
    this.failAllPending(error);
    void this.terminateWorker();
  }

  private handleWorkerExit(): void {
    if (this.pending.size === 0) return;
    const error = new PersistenceError('worker_communication', 'persistence worker exited before responding');
    this.lastError = error;
    this.lifecycleField = 'closed';
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
