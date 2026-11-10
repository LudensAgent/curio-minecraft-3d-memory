/**
 * Concrete semantic facts for the v0.11 voxel-first memory (plan §3.2).
 *
 * These records replace the semantic role previously carried by topology graph
 * nodes. They are deliberately flat anchors:
 *
 * - places name a base/death/portal/station/hazard or generic point of interest;
 * - resource anchors point at the exact cell a resource was observed in;
 * - container anchors associate an exact block position with the host's stable
 *   container identity and optional precise-ledger reference.
 *
 * The library never stores container contents here. Inventory remains owned by
 * the host ledger; a container observation says only where and when the shell
 * was seen. Gone/revoked is explicit state, never a deletion of the record.
 */

import type { JsonObject } from '../json-value.js';
import type { Vec3Like } from '../types.js';

/** How a fact was observed. Opaque to the library. */
export interface FactProvenance {
  /** Caller-supplied provenance label (e.g. `vision_scan`, `legacy_node`). */
  source: string;
  /** Session the observation actually happened in, when known. */
  sessionId?: string;
  /** Host observation ids that support this record, when available. */
  observationIds?: readonly string[];
}

export type PlaceKind = 'place' | 'base' | 'death' | 'portal' | 'station' | 'hazard';

export type FactLocation =
  | { kind: 'exact'; pos: Vec3Like }
  | { kind: 'area'; center: Vec3Like; radius: number };

/**
 * A named place/anchor. `id` is durable and is preserved across re-observations;
 * `legacyId` records the compatibility-source id when one existed.
 */
export interface PlaceFact {
  id: string;
  kind: PlaceKind;
  label: string;
  worldId: string;
  dim: string;
  location: FactLocation;
  /** Real observation time in milliseconds; never a save batch or receipt time. */
  observedAt: number;
  source: FactProvenance;
  /**
   * The place was observed no longer present. The record is retained; queries
   * exclude it by default and `includeGone` asks for it explicitly.
   */
  gone: boolean;
  /** Real disappearance observation time; absent when legacy data lacked one. */
  goneAt?: number;
  /** Provenance of the disappearance observation, separate from `source`. */
  goneSource?: FactProvenance;
  /** Compatibility-source id, preserved verbatim during a migration. */
  legacyId?: string;
  /**
   * Opaque host metadata (e.g. base selection or harvest counters). The library
   * validates that it is finite JSON and deep-copies it; its schema and meaning
   * belong to the host. It never changes observation time or availability.
   */
  hostData?: JsonObject;
}

/** A resource label observed at one exact source cell. */
export interface ResourceAnchorFact {
  id: string;
  worldId: string;
  dim: string;
  /** Resource identity within the source cell (e.g. `iron_ore`). */
  label: string;
  /** Optional host resource classification; never inferred from the label. */
  resourceType?: string;
  /** Exact cell the resource was observed in. Area locations are not resources. */
  sourceCell: Vec3Like;
  /** Real observation time in milliseconds. */
  observedAt: number;
  source: FactProvenance;
  /** The resource was observed removed or replaced; the record is retained. */
  revoked: boolean;
  /** Real revocation observation time; absent when legacy data lacked one. */
  revokedAt?: number;
  /** Provenance of the removal observation, separate from `source`. */
  revokedSource?: FactProvenance;
  /** Compatibility-source id, preserved verbatim during a migration. */
  legacyId?: string;
  /** Opaque host metadata; validated, deep-copied and never interpreted here. */
  hostData?: JsonObject;
}

/**
 * A container shell identity at an exact cell. Contents and inventory are
 * host-led; this record only links position, stable identity and ledger ref.
 */
export interface ContainerAnchorFact {
  id: string;
  worldId: string;
  dim: string;
  /** Exact block cell. Region centers are never promoted to container targets. */
  pos: Vec3Like;
  /**
   * Stable host identity (e.g. a chest key). The same `worldId` + `dim` +
   * `externalRef` is one anchor even when re-observed.
   */
  externalRef: string;
  /** Real observation time of the shell in milliseconds. */
  observedAt: number;
  source: FactProvenance;
  /**
   * The container shell was observed no longer present. The record is retained;
   * queries exclude it by default and `includeGone` asks for it explicitly.
   */
  gone: boolean;
  /** Real disappearance observation time; absent when legacy data lacked one. */
  goneAt?: number;
  /** Provenance of the disappearance observation, separate from `source`. */
  goneSource?: FactProvenance;
  /** Opaque reference into the host precise container ledger. */
  ledgerRef?: string;
  /** Compatibility-source id, preserved verbatim during a migration. */
  legacyId?: string;
  /** Opaque host metadata; validated, deep-copied and never interpreted here. */
  hostData?: JsonObject;
}

export type SemanticFact = PlaceFact | ResourceAnchorFact | ContainerAnchorFact;

export type SemanticFactKind = 'place' | 'resource' | 'container';

/** Discriminate a fact by its concrete shape; no stored tag is required. */
export function semanticFactKind(fact: SemanticFact): SemanticFactKind {
  if ('sourceCell' in fact) return 'resource';
  if ('externalRef' in fact) return 'container';
  return 'place';
}

export function isPlaceFact(fact: SemanticFact): fact is PlaceFact {
  return semanticFactKind(fact) === 'place';
}

export function isResourceFact(fact: SemanticFact): fact is ResourceAnchorFact {
  return semanticFactKind(fact) === 'resource';
}

export function isContainerFact(fact: SemanticFact): fact is ContainerAnchorFact {
  return semanticFactKind(fact) === 'container';
}

/** Common bounded paging options. All filters are combined by AND. */
export interface FactQuery {
  worldId?: string;
  dim?: string;
  /** Include gone/revoked records. Defaults to false. */
  includeGone?: boolean;
  /** Exclusive cursor: only ids sorting after this id are returned. */
  after?: string;
  /** Page size; bounded by the store's `maxQueryLimit`. */
  limit?: number;
}

/** Resource queries may select the current exact source cell. */
export interface ResourceFactQuery extends FactQuery {
  sourceCell?: Vec3Like;
}

export interface FactPage<T> {
  items: T[];
  /** Count of records matching the filters, independent of cursor and limit. */
  total: number;
  /** Last returned id; present only when more matching records remain. */
  nextAfter?: string;
}

export type FactWriteOutcome = 'inserted' | 'updated' | 'duplicate' | 'conflict';

export interface FactWriteResult<T> {
  outcome: FactWriteOutcome;
  /** The record now stored. On `duplicate`/`conflict` this is the retained record. */
  record: T;
}

/** Evidence for a gone/revoked transition. It is not a deletion. */
export interface FactGoneEvidence {
  /** Real observation time of the disappearance/removal. */
  observedAt: number;
  source: FactProvenance;
}

/** Locate a resource by its canonical source cell + label. */
export interface ResourceSourceRef {
  worldId: string;
  dim: string;
  sourceCell: Vec3Like;
  label: string;
}

/** Re-anchor an existing resource id at a new exact source cell. */
export interface ResourceSourceUpdate {
  sourceCell: Vec3Like;
  /** Defaults to the current label. */
  label?: string;
  /** Must not be older than the stored observation, or the update is a duplicate. */
  observedAt: number;
  source: FactProvenance;
}

export interface InMemoryFactStoreOptions {
  /** Ceiling for one query page. Defaults to `MAX_FACT_PAGE_LIMIT` (1000). */
  maxQueryLimit?: number;
}

/** Default bounded page size. There is deliberately no unbounded list method. */
export const DEFAULT_FACT_PAGE_LIMIT = 100;

/** Hard ceiling for one query page. */
export const MAX_FACT_PAGE_LIMIT = 1000;

/**
 * The semantic-facts model version recorded with the persistent facts domain.
 * It is a storage/migration version, not a world or observation time.
 */
export const FACT_MIGRATION_VERSION = 1;

/** Human-readable migration target recorded next to `FACT_MIGRATION_VERSION`. */
export const FACT_MIGRATION_TARGET = 'semantic-facts-v1';

/**
 * Complete facts-domain capture committed by one checkpoint. `revision` is the
 * exact captured local revision; it is what an ACK confirms.
 */
export interface FactCheckpointSnapshot {
  worldId: string;
  /** Captured local facts revision, not a save confirmation by itself. */
  revision: number;
  /** Every place, including gone records (gone is retained state). */
  places: PlaceFact[];
  /** Every resource anchor, including revoked records. */
  resources: ResourceAnchorFact[];
  /** Every container anchor, including gone records; never container contents. */
  containers: ContainerAnchorFact[];
}

/** Facts-domain migration/version record read from the same persistence authority. */
export interface FactMigrationState {
  /** Facts model version recorded for this world/database. */
  version: number;
  /** Migration target label recorded with the version. */
  target: string | null;
  /** Whether this world has a committed facts-domain record (even an empty one). */
  committed: boolean;
}

/** Options for `PersistentFactStore`. */
export interface PersistentFactStoreOptions extends InMemoryFactStoreOptions {
  /** The world this store persists and restores. Required and non-empty. */
  worldId: string;
}

/**
 * Synchronous facts authority with an explicit persistence lifecycle.
 *
 * Writes and reads are the hot path and are visible immediately. A caller
 * captures `checkpointSnapshot()` and persists it; `confirmRevision(revision)`
 * acknowledges only that captured revision. Confirming an old revision never
 * clears or rewrites newer facts — it only advances the confirmed marker.
 */
export interface FactStore {
  upsertPlace(fact: PlaceFact): FactWriteResult<PlaceFact>;
  upsertResource(fact: ResourceAnchorFact): FactWriteResult<ResourceAnchorFact>;
  upsertContainer(fact: ContainerAnchorFact): FactWriteResult<ContainerAnchorFact>;
  markPlaceGone(id: string, evidence: FactGoneEvidence): FactWriteResult<PlaceFact>;
  revokeResource(id: string, evidence: FactGoneEvidence): FactWriteResult<ResourceAnchorFact>;
  markContainerGone(id: string, evidence: FactGoneEvidence): FactWriteResult<ContainerAnchorFact>;
  updateResourceSource(id: string, update: ResourceSourceUpdate): FactWriteResult<ResourceAnchorFact>;
  /**
   * Replace only the opaque host metadata of one fact. Observation time,
   * position and gone/revoked state are untouched; `duplicate` means the
   * supplied data already equals the stored value.
   */
  updateHostData(
    kind: SemanticFactKind,
    id: string,
    hostData: JsonObject,
  ): FactWriteResult<SemanticFact>;

  places(query?: FactQuery): FactPage<PlaceFact>;
  resources(query?: ResourceFactQuery): FactPage<ResourceAnchorFact>;
  containers(query?: FactQuery): FactPage<ContainerAnchorFact>;

  /** Local facts revision; advanced only by a write that actually changed memory. */
  readonly revision: number;
  /** Revision last acknowledged by a committed checkpoint. */
  readonly confirmedRevision: number;
  /** Capture the complete domain (including gone/revoked) at the current revision. */
  checkpointSnapshot(): FactCheckpointSnapshot;
  /** Replace memory with a committed capture; restore-only, preserves ids/times/state. */
  installSnapshot(snapshot: FactCheckpointSnapshot): void;
  /** Acknowledge the exact captured revision. Never decreases the confirmed marker. */
  confirmRevision(revision: number): void;
  /** True when a write has occurred after the last confirmed revision. */
  hasPendingChanges(): boolean;
}
