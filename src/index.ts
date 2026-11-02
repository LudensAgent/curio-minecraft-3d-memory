/**
 * Public package entry (design §9: "导出最小且明确的公共 API").
 *
 * The host imports the library through this barrel only. Runtime, module
 * format and type declarations are consumed here — never via source aliases or
 * a dev-machine directory.
 */

// Base primitives + configuration
export { AIR_PALETTE_INDEX, PASSAGE_LINK, SECTION_CELL_COUNT, SECTION_SIZE } from './constants.js';
export type { BlockState, MoveMode, Vec3Like, WorldScope } from './types.js';

// Observation / evidence
export type {
  CellEvidence,
  EvidenceKind,
  Freshness,
  Observation,
  ObservationBatch,
  ObservationGap,
  ObservationSource,
} from './observation/index.js';

// Voxel — sparse in-memory observation map (coordinate math, palette, `VoxelMap`)
export {
  AIR_BLOCK_NAME,
  VoxelMap,
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
  Section,
  SectionChange,
  SectionKey,
  StaleReason,
  VoxelMapOptions,
} from './voxel/index.js';

// Traversability
export type {
  HazardFact,
  ObstacleEvidence,
  Traversability,
  TraversabilityEntry,
} from './traversability/index.js';

// Topology
export type {
  ConnectionType,
  LandmarkTag,
  NodeKind,
  NodeSource,
  PathFragment,
  SpatialEdge,
  SpatialNode,
} from './topology/index.js';

// Adapter
export type {
  ActionResult,
  AgentState,
  EffectEvidence,
  EventContext,
  MaterialAllowance,
  MoveOpts,
  MoveRejection,
  MoveTarget,
  PerceptionEvent,
  SwimOptions,
  WorldAdapter,
} from './adapter/index.js';

// Navigation
export type {
  ActionRecord,
  ArrivalSpec,
  FollowKnownPathRequest,
  Frontier,
  LastObservation,
  NavigateRequest,
  NavOutcome,
  NavProblem,
  NavResult,
} from './navigation/index.js';

// Store
export type { SpatialMemoryStore } from './store/index.js';

// Storage
export { TABLE_NAMES } from './storage/index.js';
export type { PersistenceWorker, SaveBatch, SaveConfirmation } from './storage/index.js';
