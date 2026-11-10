/**
 * Semantic fact layer for the voxel-first memory (v0.11 plan §3.2, §7).
 *
 * This entry exports concrete place/resource/container anchors, the bounded
 * in-memory store, and the pure legacy semantic-node migration dry run. It does
 * not import or re-export topology, fragment or storage stores.
 */

export { InMemoryFactStore } from './in-memory-facts-store.js';
export { PersistentFactStore } from './persistent-fact-store.js';
export { validateFactCheckpointSnapshot } from './validation.js';
export {
  applyLegacySemanticMigration,
  runLegacySemanticMigrationDryRun,
} from './legacy-semantic-migration.js';
export type {
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
} from './legacy-semantic-migration.js';
export {
  DEFAULT_FACT_PAGE_LIMIT,
  FACT_MIGRATION_TARGET,
  FACT_MIGRATION_VERSION,
  MAX_FACT_PAGE_LIMIT,
  isContainerFact,
  isPlaceFact,
  isResourceFact,
  semanticFactKind,
} from './types.js';
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
  PlaceFact,
  PlaceKind,
  ResourceAnchorFact,
  ResourceFactQuery,
  ResourceSourceRef,
  ResourceSourceUpdate,
  SemanticFact,
  SemanticFactKind,
} from './types.js';
