/**
 * Pure memory-core exports (`curio-minecraft-3d-memory/memory`, plan M5.1).
 *
 * This barrel must stay free of navigation, execution and adapter-body ports.
 * Its runtime dependency graph contains only the memory core, the voxel map and
 * the dependency-free capability report; type-only exports may name contracts
 * owned by other modules because they are erased at emit time.
 *
 * A pure memory consumer can therefore write observations and query the store
 * without importing `src/navigation/*`, `src/execution/*` or `src/adapter/*`.
 */

export {
  CAPABILITY_DOMAINS,
  CapabilityContractError,
  CapabilityUnavailableError,
  composeCapabilities,
  CONTRACT_VERSION,
  hasCapability,
  requireCapability,
  ROUTE_PLAN_CAPABILITIES,
} from './capabilities.js';
export type {
  CapabilityDomain,
  CapabilityNameOf,
  ComposedCapabilityReport,
  ContractVersion,
  HostCapabilityDeclaration,
  MemoryHostCapabilities,
  RoutePlanCapabilities,
  RoutePlanCapabilityName,
} from './capabilities.js';
export type {
  ChangeReportErrorHandler,
  ChangeReportSink,
  ChangeReportSource,
  ChangeReportSubscriptionOptions,
} from './change-reports.js';
export type {
  LegacyRouteIngest,
  MemoryIngest,
  ObservationIngest,
  SpatialEdgeRecord,
} from './ingest.js';

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

// Runtime store interface (the implementation lives in `src/store/` and pulls
// in navigation projections; keep this a type-only export).
export type { SpatialMemoryStore } from '../store/store.js';
