/**
 * Public package entry (design §9: "导出最小且明确的公共 API").
 *
 * The host imports the library through this barrel only. Runtime, module
 * format and type declarations are consumed here — never via source aliases or
 * a dev-machine directory.
 */

// Base primitives + configuration
export {
  AIR_PALETTE_INDEX,
  SECTION_CELL_COUNT,
  SECTION_SIZE,
  VOXEL_SECTION_PAYLOAD_VERSION,
} from './constants.js';
export type { BlockState, MoveMode, Vec3Like, WorldScope } from './types.js';
export type { JsonLimits, JsonObject, JsonPrimitive, JsonValue } from './json-value.js';

// Observation / evidence
export {
  ObservationQueue,
  cloneCellEvidence,
  cloneObservation,
  cloneObservationGap,
  validateObservation,
  validateObservationGap,
} from './observation/index.js';
export type {
  CellEvidence,
  EvidenceKind,
  Freshness,
  Observation,
  ObservationBacklog,
  ObservationBatch,
  ObservationDrainResult,
  ObservationEnqueueResult,
  ObservationGap,
  ObservationOverflow,
  ObservationQueueOptions,
  ObservationSource,
} from './observation/index.js';

// Voxel — sparse in-memory observation map (coordinate math, palette, `VoxelMap`)
export {
  AIR_BLOCK_NAME,
  ChangeReportDeliveryError,
  DEFAULT_RESIDENCY_LIMITS,
  LruOrder,
  estimateVoxelSectionResidentBytesFromCommitted,
  estimateVoxelSectionResidentBytesFromSnapshot,
  resolveResidencyLimits,
  VoxelMap,
  VoxelResidencyError,
  blockToSection,
  cellIndex,
  isAirState,
  localCoord,
  sectionCoord,
  serializeBlockState,
} from './voxel/index.js';
export type {
  BlockSectionCoords,
  CellChange,
  CellChangeKind,
  CellView,
  ChangeReport,
  ChangeReportDeliveryFailure,
  ChangeReportErrorHandler,
  ChangeReportListener,
  CommittedSectionInfo,
  PinLease,
  ResidencyLimits,
  ResolvedResidencyLimits,
  Section,
  SectionChange,
  SectionKey,
  SectionResidency,
  SectionResidencyInfo,
  StaleReason,
  UnloadRejectionReason,
  UnloadSectionsResult,
  VoxelCellSnapshot,
  VoxelCheckpointCounts,
  VoxelCheckpointMeasure,
  VoxelCheckpointSnapshot,
  VoxelDirectory,
  VoxelDirectoryEntry,
  VoxelDirectoryPage,
  VoxelDirectorySummary,
  VoxelDirtyBatch,
  VoxelDirtyBatchMeasure,
  VoxelDirtyMeasure,
  VoxelMapOptions,
  VoxelSectionSnapshot,
} from './voxel/index.js';
export {
  decodeVoxelSectionPayload,
  deserializeBlockState,
  encodeVoxelSectionPayload,
  voxelSectionPayloadId,
} from './voxel/index.js';
export type {
  BatchChangeReport,
  CellHistoryView,
  VoxelCellPayloadV2,
  VoxelSectionPayloadV2,
} from './voxel/index.js';

// Traversability (land walking, jumps, steps, drops; water primitives separately)
export {
  DEFAULT_LAND_LIMITS,
  evaluateLandTransition,
  evaluateWalkStep,
  LandRouteVerifier,
  resolveLandLimits,
  TraversabilityCache,
} from './traversability/index.js';
export type {
  ClimbCellInput,
  ClimbRegion,
  ClimbRegionProvider,
  ClimbRegionResolution,
  CollisionShape,
  CollisionShapeProvider,
  LandJumpTrajectory,
  LandLimitField,
  LandLimitGap,
  LandLimits,
  LandMotionInput,
  LandMotionModel,
  LandMotionResolution,
  LandRouteBudgetGap,
  LandRouteLimitField,
  LandRoutePendingReason,
  LandRouteRecovery,
  LandRouteRequest,
  LandRouteSegmentState,
  LandRouteStatus,
  LandRouteVerifierOptions,
  LandRules,
  LandRuleVersions,
  LandSectionDependency,
  LandTransition,
  LandTransitionEvaluation,
  LandTransitionKind,
  LandTransitionQuery,
  LandTransitionReason,
  LandTransitionReasonKind,
  LandTransitionStatus,
  LandWorkReport,
  NeighborCellView,
  NeighborRead,
  ShapeResolution,
  SupportFace,
  TraversabilityCacheOptions,
  UnitBox,
} from './traversability/index.js';
export type {
  BodyContext,
  StepConstraints,
  StepDirection,
  StepEvaluation,
  StepProblem,
  StepQuery,
  StepStatus,
} from './traversability/index.js';
export type {
  HazardFact,
  ObstacleEvidence,
  Traversability,
  TraversabilityEntry,
} from './traversability/index.js';
// Memory capability contract and change-report port
export {
  CAPABILITY_DOMAINS,
  CapabilityContractError,
  CapabilityUnavailableError,
  composeCapabilities,
  CONTRACT_VERSION,
  hasCapability,
  requireCapability,
} from './memory/index.js';
export type {
  CapabilityDomain,
  CapabilityNameOf,
  ChangeReportSink,
  ChangeReportSource,
  ChangeReportSubscriptionOptions,
  ComposedCapabilityReport,
  ContractVersion,
  HostCapabilityDeclaration,
  MemoryHostCapabilities,
} from './memory/index.js';

// Query — read-only voxel + facts projection
export { createVoxelFactsQueryPort } from './query/index.js';
export type {
  CellQueryView,
  SemanticPlaceLocation,
  SemanticPlaceSource,
  SemanticPlaceTag,
  SemanticPlaceView,
  SpatialMemoryStoreSnapshot,
  SpatialQueryData,
  SpatialQueryKind,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryProblem,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
  SpatialQueryStatus,
  VoxelFactsQueryOptions,
  VoxelFactsQueryVoxel,
} from './query/index.js';

// Adapter
export type {
  ActionResult,
  AgentState,
  BodyAdapter,
  EffectEvidence,
  EventContext,
  MaterialAllowance,
  MoveOpts,
  MoveRejection,
  MoveTarget,
  PerceptionCapabilities,
  PerceptionEvent,
  PerceptionSource,
  PerceptionState,
  SwimOptions,
  WorldAdapter,
} from './adapter/index.js';

// Navigation — current voxel land search + shared delegation contracts
export { searchLandRoute, searchLandRouteAsync } from './navigation/index.js';
export type {
  ActionRecord,
  ArrivalSpec,
  LastObservation,
  NavOutcome,
  NavProblem,
  NavResult,
  LandSearchArrival,
  LandSearchBoundary,
  LandSearchBoundaryStatus,
  LandSearchBudget,
  LandSearchCorridor,
  LandSearchEdgePolicy,
  LandSearchKind,
  LandSearchPolicyCell,
  LandSearchPolicyDecision,
  LandSearchPolicyEdge,
  LandSearchPolicyRead,
  LandSearchPolicyRejection,
  LandSearchPolicySummary,
  LandSearchPrefix,
  LandSearchRequest,
  LandSearchResult,
  LandSearchStatus,
  LandSearchTransition,
} from './navigation/index.js';

// Storage — voxel/facts/ledger/journal persistence
export { TABLE_NAMES } from './storage/index.js';
export type { PersistenceWorker, SaveBatch, SaveConfirmation } from './storage/index.js';
export type {
  CloseResult,
  FlushResult,
  LegacyStoreSummary,
  OpenSpatialSessionOptions,
  PersistenceErrorKind,
  SessionLifecycle,
  SnapshotLimits,
  SpatialCheckpointResult,
  SpatialPersistenceState,
  SpatialSession,
  VoxelLoading,
} from './storage/sqlite/types.js';
export { PersistenceError } from './storage/sqlite/types.js';

// Facts — semantic place/resource/container anchors, separate from route history
export {
  FACT_MIGRATION_TARGET,
  FACT_MIGRATION_VERSION,
  InMemoryFactStore,
  PersistentFactStore,
  applyLegacySemanticMigration,
  runLegacySemanticMigrationDryRun,
} from './facts/index.js';
export type {
  ContainerAnchorFact,
  FactCheckpointSnapshot,
  FactGoneEvidence,
  FactLocation,
  FactMigrationState,
  FactPage,
  FactProvenance,
  FactQuery,
  FactStore,
  FactWriteOutcome,
  FactWriteResult,
  InMemoryFactStoreOptions,
  PersistentFactStoreOptions,
  LegacyRouteRecord,
  LegacySemanticExactLocation,
  LegacySemanticLocation,
  LegacySemanticMigrationApplyReport,
  LegacySemanticMigrationOptions,
  LegacySemanticMigrationPlan,
  LegacySemanticMigrationReport,
  LegacySemanticNode,
  LegacySemanticRegionLocation,
  LegacySemanticSnapshot,
  PlaceFact,
  PlaceKind,
  ResourceAnchorFact,
  ResourceFactQuery,
  ResourceSourceRef,
  ResourceSourceUpdate,
  SemanticFact,
} from './facts/index.js';
