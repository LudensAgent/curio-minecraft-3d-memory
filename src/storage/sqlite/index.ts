/**
 * SQLite voxel/facts persistence entry.
 *
 * `openSpatialSession` is the only public session constructor. It owns one
 * `VoxelMap`, the world-scoped ledger, the journal queue and the semantic fact
 * store, persisted through a single worker. The retired history/topology
 * session and its checkpoint/restore protocol are gone.
 */

export {
  DEFAULT_JOURNAL_LIMITS,
  DEFAULT_LEDGER_LIMITS,
  DEFAULT_SNAPSHOT_LIMITS,
  DEFAULT_TIMEOUT_MS,
  PersistenceError,
  resolveJournalLimits,
  resolveLedgerLimits,
  resolveSnapshotLimits,
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
  ChunkVisitRecord,
  CloseResult,
  EventJournalQuery,
  FactSourceGap,
  FlushResult,
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
  LegacyStoreSummary,
  LoadSectionsResult,
  MeasureSectionsResult,
  OpenSpatialSessionOptions,
  PendingJournalSnapshot,
  PersistenceErrorKind,
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
  VoxelSaveMode,
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
  WorkingSetCounters,
  WorkingSetLimits,
  WorkingSetRejection,
  WorkingSetRejectionKind,
  WorkingSetStats,
} from './working-set.js';
