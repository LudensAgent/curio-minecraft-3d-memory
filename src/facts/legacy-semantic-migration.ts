/**
 * Pure legacy semantic-node migration dry run (v0.11 plan §7 compatibility).
 *
 * Input is a generic, caller-validated JSON shape. This module deliberately
 * does not import the topology, fragment or storage implementations: it only
 * classifies the snapshot's nodes into semantic facts, reports what would be
 * migrated, and leaves route-only nodes/edges/fragments behind.
 *
 * Nothing is written. Applying the returned plan is a separate, explicit step
 * (`applyLegacySemanticMigration`), and replaying the same plan is idempotent
 * because the destination store dedupes by canonical identity.
 *
 * Classification rules:
 * - `resource` tag -> resource anchor (exact cell only);
 * - `container` tag -> container anchor (exact cell + stable identity only);
 * - `kind: "place"` or any other semantic tag -> named place;
 * - route-only node kinds (entrance/branch/turn/vertical_junction) without a
 *   semantic tag, plus every edge and fragment -> skipped route geometry;
 * - missing id/dim/location/observedAt, region resources, gone containers and
 *   otherwise unclassifiable nodes -> unknown. No field is fabricated.
 *
 * Legacy ids are preserved verbatim on the fact `id` and recorded in `legacyId`.
 * `worldId` falls back to the snapshot scope; `observedAt` never falls back to a
 * creation time, receive time or migration time.
 */

import type { Vec3Like } from '../types.js';
import {
  containerCanonicalKey,
  locationsEqual,
  placeCanonicalKey,
  pointsEqual,
  resourceCanonicalKey,
} from './canonical.js';
import { InMemoryFactStore } from './in-memory-facts-store.js';
import {
  isContainerFact,
  isPlaceFact,
  isResourceFact,
  type ContainerAnchorFact,
  type FactLocation,
  type FactProvenance,
  type FactWriteOutcome,
  type PlaceFact,
  type PlaceKind,
  type ResourceAnchorFact,
  type SemanticFact,
} from './types.js';

export interface LegacySemanticExactLocation {
  kind: 'exact';
  pos: Vec3Like;
}

export interface LegacySemanticRegionLocation {
  kind: 'region';
  center: Vec3Like;
  radius: number;
}

export type LegacySemanticLocation =
  | LegacySemanticExactLocation
  | LegacySemanticRegionLocation;

/** Generic legacy node; extra fields are ignored. */
export interface LegacySemanticNode {
  id?: string;
  kind?: string;
  tag?: string;
  label?: string;
  worldId?: string;
  dim?: string;
  location?: LegacySemanticLocation;
  observedAt?: number;
  source?: string;
  sessionId?: string;
  observationIds?: readonly string[];
  externalRef?: string;
  resourceType?: string;
  ledgerRef?: string;
  gone?: boolean;
  goneAt?: number;
  legacyId?: string;
}

/** Only used to count/report skipped route geometry. */
export interface LegacyRouteRecord {
  id?: string;
}

export interface LegacySemanticSnapshot {
  worldId: string;
  nodes?: readonly LegacySemanticNode[];
  edges?: readonly LegacyRouteRecord[];
  fragments?: readonly LegacyRouteRecord[];
}

export interface LegacySemanticMigrationOptions {
  /**
   * Facts already present in the destination. Passing the previous plan's
   * facts makes a re-run report duplicates instead of migrations.
   */
  existing?: readonly SemanticFact[];
}

export interface LegacySemanticMigrationReport {
  /** Unique facts that still need a destination write. */
  migrated: number;
  /** Route-only nodes + edges + fragments deliberately not migrated. */
  skippedRoute: number;
  /** Canonical duplicates (within the snapshot or against `existing`). */
  duplicates: number;
  /** Same identity/key with incompatible content or durable ids. */
  conflicts: number;
  /** Unique migrated facts that carry gone/revoked state. */
  gone: number;
  /** Semantic-looking nodes that could not be attributed without inventing data. */
  unknown: number;
  migratedIds: string[];
  skippedRouteIds: string[];
  duplicateIds: string[];
  conflictIds: string[];
  goneIds: string[];
  unknownIds: string[];
}

export interface LegacySemanticMigrationPlan {
  /** Full desired semantic fact set; applying it is idempotent. */
  facts: readonly SemanticFact[];
  report: LegacySemanticMigrationReport;
}

export interface LegacySemanticMigrationApplyReport {
  inserted: number;
  updated: number;
  duplicate: number;
  conflict: number;
}

interface PlanBucket<T extends SemanticFact> {
  byKey: Map<string, T>;
  ids: Map<string, string>;
}

interface ExistingIndex {
  placesByKey: Map<string, PlaceFact>;
  placesById: Map<string, PlaceFact>;
  resourcesByKey: Map<string, ResourceAnchorFact>;
  resourcesById: Map<string, ResourceAnchorFact>;
  containersByKey: Map<string, ContainerAnchorFact>;
  containersById: Map<string, ContainerAnchorFact>;
}

interface MutableCounters {
  duplicates: string[];
  conflicts: string[];
  unknown: string[];
  skippedRoute: string[];
}

type ExistingOutcome = 'migrated' | 'duplicate' | 'conflict';

const ROUTE_NODE_KINDS = new Set(['entrance', 'branch', 'turn', 'vertical_junction']);

/**
 * Rehearse migrating semantic nodes from a generic legacy snapshot. Pure: the
 * input is not mutated and no destination is touched.
 */
export function runLegacySemanticMigrationDryRun(
  snapshot: LegacySemanticSnapshot,
  options: LegacySemanticMigrationOptions = {},
): LegacySemanticMigrationPlan {
  const counters: MutableCounters = {
    duplicates: [],
    conflicts: [],
    unknown: [],
    skippedRoute: [],
  };
  const places: PlanBucket<PlaceFact> = { byKey: new Map(), ids: new Map() };
  const resources: PlanBucket<ResourceAnchorFact> = { byKey: new Map(), ids: new Map() };
  const containers: PlanBucket<ContainerAnchorFact> = { byKey: new Map(), ids: new Map() };

  const nodes = snapshot.nodes ?? [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    switch (classifyLegacyNode(node)) {
      case 'route':
        counters.skippedRoute.push(nodeLabel(node, index));
        break;
      case 'unknown':
        counters.unknown.push(nodeLabel(node, index));
        break;
      case 'place': {
        const place = placeFromLegacyNode(node, snapshot.worldId);
        if (place === null) counters.unknown.push(nodeLabel(node, index));
        else addPlanned(place, placeCanonicalKey(place), places, counters);
        break;
      }
      case 'resource': {
        const resource = resourceFromLegacyNode(node, snapshot.worldId);
        if (resource === null) counters.unknown.push(nodeLabel(node, index));
        else addPlanned(resource, resourceCanonicalKey(resource), resources, counters);
        break;
      }
      case 'container': {
        const container = containerFromLegacyNode(node, snapshot.worldId);
        if (container === null) counters.unknown.push(nodeLabel(node, index));
        else addPlanned(container, containerCanonicalKey(container), containers, counters);
        break;
      }
    }
  }

  const edges = snapshot.edges ?? [];
  for (let index = 0; index < edges.length; index += 1) {
    counters.skippedRoute.push(routeLabel('edge', edges[index], index));
  }
  const fragments = snapshot.fragments ?? [];
  for (let index = 0; index < fragments.length; index += 1) {
    counters.skippedRoute.push(routeLabel('fragment', fragments[index], index));
  }

  const facts: SemanticFact[] = [
    ...places.byKey.values(),
    ...resources.byKey.values(),
    ...containers.byKey.values(),
  ];

  const existing = indexExisting(options.existing ?? []);
  const migratedIds: string[] = [];
  const duplicateIds = [...counters.duplicates];
  const conflictIds = [...counters.conflicts];

  for (const fact of facts) {
    const outcome = compareWithExisting(fact, existing);
    if (outcome === 'migrated') migratedIds.push(fact.id);
    else if (outcome === 'duplicate') duplicateIds.push(fact.id);
    else conflictIds.push(fact.id);
  }

  const goneFacts = facts.filter(factIsGone);
  const report: LegacySemanticMigrationReport = {
    migrated: migratedIds.length,
    skippedRoute: counters.skippedRoute.length,
    duplicates: duplicateIds.length,
    conflicts: conflictIds.length,
    gone: goneFacts.length,
    unknown: counters.unknown.length,
    migratedIds,
    skippedRouteIds: [...counters.skippedRoute],
    duplicateIds,
    conflictIds,
    goneIds: goneFacts.map((fact) => fact.id),
    unknownIds: [...counters.unknown],
  };
  return { facts, report };
}

/**
 * Apply a dry-run plan to an in-memory fact store. This is the only mutation in
 * this module and the destination is caller-supplied; old stores are untouched.
 * Re-applying the same plan yields duplicates, never new records.
 */
export function applyLegacySemanticMigration(
  store: InMemoryFactStore,
  plan: LegacySemanticMigrationPlan,
): LegacySemanticMigrationApplyReport {
  const report: LegacySemanticMigrationApplyReport = {
    inserted: 0,
    updated: 0,
    duplicate: 0,
    conflict: 0,
  };
  for (const fact of plan.facts) {
    const outcome = upsertFact(store, fact);
    report[outcome] += 1;
  }
  return report;
}

function upsertFact(store: InMemoryFactStore, fact: SemanticFact): FactWriteOutcome {
  if (isPlaceFact(fact)) return store.upsertPlace(fact).outcome;
  if (isResourceFact(fact)) return store.upsertResource(fact).outcome;
  if (isContainerFact(fact)) return store.upsertContainer(fact).outcome;
  throw new Error('unsupported semantic fact shape');
}

function classifyLegacyNode(
  node: LegacySemanticNode,
): 'route' | 'unknown' | 'place' | 'resource' | 'container' {
  if (node.tag === 'resource') return 'resource';
  if (node.tag === 'container') return 'container';
  if (node.kind === 'place' || node.tag !== undefined) return 'place';
  if (node.kind !== undefined && ROUTE_NODE_KINDS.has(node.kind)) return 'route';
  return 'unknown';
}

function placeFromLegacyNode(
  node: LegacySemanticNode,
  snapshotWorldId: string,
): PlaceFact | null {
  const id = nonEmpty(node.id);
  if (id === undefined) return null;
  const worldId = nonEmpty(node.worldId) ?? nonEmpty(snapshotWorldId);
  if (worldId === undefined) return null;
  const dim = nonEmpty(node.dim);
  if (dim === undefined) return null;
  const label = nonEmpty(node.label);
  if (label === undefined) return null;
  const location = legacyLocation(node.location);
  if (location === null) return null;
  const observedAt = node.observedAt;
  if (!isFiniteNumber(observedAt)) return null;
  const gone = node.gone === true;
  const goneAt = node.goneAt;
  if (goneAt !== undefined && !isFiniteNumber(goneAt)) return null;
  const source = legacyProvenance(node);
  const legacyId = nonEmpty(node.legacyId) ?? id;
  return {
    id,
    kind: placeKindForTag(node.tag),
    label,
    worldId,
    dim,
    location,
    observedAt,
    source,
    gone,
    ...(gone && goneAt !== undefined ? { goneAt } : {}),
    ...(gone ? { goneSource: legacyProvenance(node) } : {}),
    legacyId,
  };
}

function resourceFromLegacyNode(
  node: LegacySemanticNode,
  snapshotWorldId: string,
): ResourceAnchorFact | null {
  const id = nonEmpty(node.id);
  if (id === undefined) return null;
  const worldId = nonEmpty(node.worldId) ?? nonEmpty(snapshotWorldId);
  if (worldId === undefined) return null;
  const dim = nonEmpty(node.dim);
  if (dim === undefined) return null;
  const label = nonEmpty(node.label);
  if (label === undefined) return null;
  const sourceCell = exactCell(node.location);
  if (sourceCell === null) return null;
  const observedAt = node.observedAt;
  if (!isFiniteNumber(observedAt)) return null;
  const revoked = node.gone === true;
  const revokedAt = node.goneAt;
  if (revokedAt !== undefined && !isFiniteNumber(revokedAt)) return null;
  const source = legacyProvenance(node);
  const resourceType = nonEmpty(node.resourceType);
  const legacyId = nonEmpty(node.legacyId) ?? id;
  return {
    id,
    worldId,
    dim,
    label,
    ...(resourceType === undefined ? {} : { resourceType }),
    sourceCell,
    observedAt,
    source,
    revoked,
    ...(revoked && revokedAt !== undefined ? { revokedAt } : {}),
    ...(revoked ? { revokedSource: legacyProvenance(node) } : {}),
    legacyId,
  };
}

function containerFromLegacyNode(
  node: LegacySemanticNode,
  snapshotWorldId: string,
): ContainerAnchorFact | null {
  const id = nonEmpty(node.id);
  if (id === undefined) return null;
  const worldId = nonEmpty(node.worldId) ?? nonEmpty(snapshotWorldId);
  if (worldId === undefined) return null;
  const dim = nonEmpty(node.dim);
  if (dim === undefined) return null;
  const pos = exactCell(node.location);
  if (pos === null) return null;
  const observedAt = node.observedAt;
  if (!isFiniteNumber(observedAt)) return null;
  // This model has no container-gone state yet; migrating it as present would
  // assert something the source did not say.
  if (node.gone === true) return null;
  const externalRef = nonEmpty(node.externalRef) ?? id;
  const ledgerRef = nonEmpty(node.ledgerRef);
  const source = legacyProvenance(node);
  const legacyId = nonEmpty(node.legacyId) ?? id;
  return {
    id,
    worldId,
    dim,
    pos,
    externalRef,
    observedAt,
    source,
    ...(ledgerRef === undefined ? {} : { ledgerRef }),
    legacyId,
  };
}

function addPlanned<T extends SemanticFact>(
  fact: T,
  key: string,
  bucket: PlanBucket<T>,
  counters: MutableCounters,
): void {
  const existing = bucket.byKey.get(key);
  if (existing === undefined) {
    const otherKey = bucket.ids.get(fact.id);
    if (otherKey !== undefined && otherKey !== key) {
      counters.conflicts.push(fact.id);
      return;
    }
    bucket.byKey.set(key, fact);
    bucket.ids.set(fact.id, key);
    return;
  }

  if (existing.id !== fact.id) {
    counters.conflicts.push(fact.id);
    return;
  }

  const incomingTime = factLastObserved(fact);
  const existingTime = factLastObserved(existing);
  if (incomingTime > existingTime) {
    // Same canonical identity with a newer observation wins; it is still a
    // duplicate source record, not a second fact.
    bucket.byKey.set(key, fact);
    counters.duplicates.push(fact.id);
    return;
  }
  if (incomingTime === existingTime && !sameSemanticFact(existing, fact)) {
    counters.conflicts.push(fact.id);
    return;
  }
  counters.duplicates.push(fact.id);
}

function indexExisting(existing: readonly SemanticFact[]): ExistingIndex {
  const index: ExistingIndex = {
    placesByKey: new Map(),
    placesById: new Map(),
    resourcesByKey: new Map(),
    resourcesById: new Map(),
    containersByKey: new Map(),
    containersById: new Map(),
  };
  for (const fact of existing) {
    if (isPlaceFact(fact)) {
      index.placesByKey.set(placeCanonicalKey(fact), fact);
      index.placesById.set(fact.id, fact);
    } else if (isResourceFact(fact)) {
      index.resourcesByKey.set(resourceCanonicalKey(fact), fact);
      index.resourcesById.set(fact.id, fact);
    } else if (isContainerFact(fact)) {
      index.containersByKey.set(containerCanonicalKey(fact), fact);
      index.containersById.set(fact.id, fact);
    }
  }
  return index;
}

function compareWithExisting(fact: SemanticFact, existing: ExistingIndex): ExistingOutcome {
  if (isPlaceFact(fact)) {
    return compareFact(
      fact,
      placeCanonicalKey(fact),
      existing.placesByKey,
      existing.placesById,
      false,
    );
  }
  if (isResourceFact(fact)) {
    return compareFact(
      fact,
      resourceCanonicalKey(fact),
      existing.resourcesByKey,
      existing.resourcesById,
      true,
    );
  }
  if (isContainerFact(fact)) {
    return compareFact(
      fact,
      containerCanonicalKey(fact),
      existing.containersByKey,
      existing.containersById,
      false,
    );
  }
  throw new Error('unsupported semantic fact shape');
}

function compareFact<T extends SemanticFact>(
  fact: T,
  key: string,
  byKey: ReadonlyMap<string, T>,
  byId: ReadonlyMap<string, T>,
  allowMove: boolean,
): ExistingOutcome {
  const sameKey = byKey.get(key);
  if (sameKey !== undefined) {
    if (sameKey.id !== fact.id) return 'conflict';
    const incomingTime = factLastObserved(fact);
    const existingTime = factLastObserved(sameKey);
    if (incomingTime > existingTime) return 'migrated';
    if (incomingTime === existingTime) {
      return sameSemanticFact(sameKey, fact) ? 'duplicate' : 'conflict';
    }
    return 'duplicate';
  }

  const sameId = byId.get(fact.id);
  if (sameId !== undefined) {
    if (!allowMove) return 'conflict';
    const incomingTime = factLastObserved(fact);
    const existingTime = factLastObserved(sameId);
    if (incomingTime > existingTime) return 'migrated';
    return incomingTime === existingTime ? 'conflict' : 'duplicate';
  }

  return 'migrated';
}

function sameSemanticFact(a: SemanticFact, b: SemanticFact): boolean {
  if (isPlaceFact(a) && isPlaceFact(b)) {
    return (
      a.id === b.id &&
      a.worldId === b.worldId &&
      a.dim === b.dim &&
      a.kind === b.kind &&
      a.label === b.label &&
      locationsEqual(a.location, b.location) &&
      a.gone === b.gone &&
      a.goneAt === b.goneAt
    );
  }
  if (isResourceFact(a) && isResourceFact(b)) {
    return (
      a.id === b.id &&
      a.worldId === b.worldId &&
      a.dim === b.dim &&
      a.label === b.label &&
      a.resourceType === b.resourceType &&
      pointsEqual(a.sourceCell, b.sourceCell) &&
      a.revoked === b.revoked &&
      a.revokedAt === b.revokedAt
    );
  }
  if (isContainerFact(a) && isContainerFact(b)) {
    return (
      a.id === b.id &&
      a.worldId === b.worldId &&
      a.dim === b.dim &&
      pointsEqual(a.pos, b.pos) &&
      a.externalRef === b.externalRef &&
      a.ledgerRef === b.ledgerRef
    );
  }
  return false;
}

function factLastObserved(fact: SemanticFact): number {
  if (isPlaceFact(fact)) return Math.max(fact.observedAt, fact.goneAt ?? fact.observedAt);
  if (isResourceFact(fact)) {
    return Math.max(fact.observedAt, fact.revokedAt ?? fact.observedAt);
  }
  return fact.observedAt;
}

function factIsGone(fact: SemanticFact): boolean {
  if (isPlaceFact(fact)) return fact.gone;
  if (isResourceFact(fact)) return fact.revoked;
  return false;
}

function legacyLocation(location: LegacySemanticLocation | undefined): FactLocation | null {
  if (location === undefined) return null;
  if (location.kind === 'exact') {
    if (!isFinitePoint(location.pos)) return null;
    return { kind: 'exact', pos: { ...location.pos } };
  }
  if (location.kind === 'region') {
    if (!isFinitePoint(location.center)) return null;
    if (!isFiniteNumber(location.radius) || location.radius < 0) return null;
    return { kind: 'area', center: { ...location.center }, radius: location.radius };
  }
  return null;
}

function exactCell(location: LegacySemanticLocation | undefined): Vec3Like | null {
  if (location === undefined || location.kind !== 'exact') return null;
  return isFinitePoint(location.pos) ? { ...location.pos } : null;
}

function legacyProvenance(node: LegacySemanticNode): FactProvenance {
  const source = nonEmpty(node.source) ?? 'legacy_semantic_node';
  const sessionId = nonEmpty(node.sessionId);
  return {
    source,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(node.observationIds === undefined
      ? {}
      : { observationIds: [...node.observationIds] }),
  };
}

function placeKindForTag(tag: string | undefined): PlaceKind {
  switch (tag) {
    case 'base':
      return 'base';
    case 'death':
      return 'death';
    case 'portal':
      return 'portal';
    case 'station':
      return 'station';
    case 'danger':
    case 'hazard':
      return 'hazard';
    default:
      return 'place';
  }
}

function nodeLabel(node: LegacySemanticNode, index: number): string {
  const id = nonEmpty(node.id);
  return id ?? `node#${index}`;
}

function routeLabel(kind: string, record: LegacyRouteRecord | undefined, index: number): string {
  const id = nonEmpty(record?.id);
  return id ?? `${kind}#${index}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFinitePoint(point: Vec3Like): boolean {
  return (
    isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z)
  );
}
