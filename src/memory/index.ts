/**
 * Pure memory-core exports (`curio-minecraft-3d-memory/memory`).
 *
 * This barrel must stay free of navigation, execution and adapter-body ports.
 * Its runtime dependency graph contains only the voxel map and the
 * dependency-free capability report; type-only exports may name contracts owned
 * by other modules because they are erased at emit time.
 */

export {
  CAPABILITY_DOMAINS,
  CapabilityContractError,
  CapabilityUnavailableError,
  composeCapabilities,
  CONTRACT_VERSION,
  hasCapability,
  requireCapability,
} from './capabilities.js';
export type {
  CapabilityDomain,
  CapabilityNameOf,
  ComposedCapabilityReport,
  ContractVersion,
  HostCapabilityDeclaration,
  MemoryHostCapabilities,
} from './capabilities.js';
export type {
  ChangeReportErrorHandler,
  ChangeReportSink,
  ChangeReportSource,
  ChangeReportSubscriptionOptions,
} from './change-reports.js';

// Observation / evidence
export type { Observation, ObservationBatch } from '../observation/types.js';

// Sparse in-memory observation map
export { VoxelMap } from '../voxel/index.js';

// Read-only query port
export type {
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
} from '../query/types.js';
