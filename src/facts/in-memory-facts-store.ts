/**
 * In-memory semantic fact store (v0.11 plan §3.2).
 *
 * Three indexed collections share the same bounded paging contract:
 * places, resource anchors and container anchors. The store owns coordinates,
 * identity links, provenance and observation times only.
 *
 * Invariants:
 * - a fact id is durable and unique within its kind;
 * - upsert dedupes by canonical key (place identity, resource cell+label,
 *   container identity), so replaying a snapshot creates no duplicates;
 * - gone/revoked is retained state, not a delete. The default query hides it and
 *   `includeGone` reads it back;
 * - resource re-anchoring updates the cell index in place, without rebuilding
 *   the collection or changing the id order.
 */

import {
  containerCanonicalKey,
  locationsEqual,
  placeCanonicalKey,
  pointsEqual,
  resourceCanonicalKey,
} from './canonical.js';
import {
  DEFAULT_FACT_PAGE_LIMIT,
  MAX_FACT_PAGE_LIMIT,
  type ContainerAnchorFact,
  type FactGoneEvidence,
  type FactLocation,
  type FactPage,
  type FactProvenance,
  type FactQuery,
  type FactWriteOutcome,
  type FactWriteResult,
  type InMemoryFactStoreOptions,
  type PlaceFact,
  type ResourceAnchorFact,
  type ResourceFactQuery,
  type ResourceSourceRef,
  type ResourceSourceUpdate,
} from './types.js';
import {
  assertContainer,
  assertFiniteNumber,
  assertGoneEvidence,
  assertNonEmptyString,
  assertPlace,
  assertPoint,
  assertProvenance,
  assertResource,
} from './validation.js';

export class InMemoryFactStore {
  private readonly maxQueryLimit: number;

  private readonly placesByKey = new Map<string, PlaceFact>();
  private readonly placeKeysById = new Map<string, string>();
  private readonly placeOrder: string[] = [];

  private readonly resourcesByKey = new Map<string, ResourceAnchorFact>();
  private readonly resourceKeysById = new Map<string, string>();
  private readonly resourceOrder: string[] = [];

  private readonly containersByKey = new Map<string, ContainerAnchorFact>();
  private readonly containerKeysById = new Map<string, string>();
  private readonly containerOrder: string[] = [];

  constructor(options: InMemoryFactStoreOptions = {}) {
    const requested = options.maxQueryLimit ?? MAX_FACT_PAGE_LIMIT;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new Error(`facts maxQueryLimit must be a positive safe integer: ${requested}`);
    }
    this.maxQueryLimit = Math.min(requested, MAX_FACT_PAGE_LIMIT);
  }

  /**
   * Insert or re-observe one place. A newer observation replaces the stored one;
   * an older/equal observation never rewrites the record.
   */
  upsertPlace(place: PlaceFact): FactWriteResult<PlaceFact> {
    assertPlace(place);
    const key = placeCanonicalKey(place);
    const indexKey = this.placeKeysById.get(place.id);
    if (indexKey !== undefined && indexKey !== key) {
      return { outcome: 'conflict', record: snapshotPlace(this.requirePlace(indexKey)) };
    }

    const existing = this.placesByKey.get(key);
    if (existing === undefined) {
      const record = snapshotPlace(place);
      this.placesByKey.set(key, record);
      this.placeKeysById.set(place.id, key);
      insertSorted(this.placeOrder, place.id);
      return { outcome: 'inserted', record: snapshotPlace(record) };
    }

    return this.applyPlaceObservation(existing, place);
  }

  /** Insert or re-observe one resource anchor (including a move to a new cell). */
  upsertResource(resource: ResourceAnchorFact): FactWriteResult<ResourceAnchorFact> {
    assertResource(resource);
    const key = resourceCanonicalKey(resource);
    const indexKey = this.resourceKeysById.get(resource.id);

    if (indexKey === undefined) {
      const occupant = this.resourcesByKey.get(key);
      if (occupant !== undefined) {
        return { outcome: 'conflict', record: snapshotResource(occupant) };
      }
      const record = snapshotResource(resource);
      this.resourcesByKey.set(key, record);
      this.resourceKeysById.set(resource.id, key);
      insertSorted(this.resourceOrder, resource.id);
      return { outcome: 'inserted', record: snapshotResource(record) };
    }

    const existing = this.requireResource(indexKey);
    if (indexKey === key) return this.applyResourceObservation(existing, resource);

    const occupant = this.resourcesByKey.get(key);
    if (occupant !== undefined && occupant.id !== resource.id) {
      return { outcome: 'conflict', record: snapshotResource(occupant) };
    }

    const incomingTime = resourceLastObserved(resource);
    const existingTime = resourceLastObserved(existing);
    if (incomingTime < existingTime) {
      return { outcome: 'duplicate', record: snapshotResource(existing) };
    }
    if (incomingTime === existingTime) {
      return { outcome: 'conflict', record: snapshotResource(existing) };
    }

    // Same durable id, newer observation: move its canonical source-cell entry.
    // The id order is unchanged, so paging cursors stay stable.
    this.resourcesByKey.delete(indexKey);
    const record = snapshotResource(resource);
    this.resourcesByKey.set(key, record);
    this.resourceKeysById.set(resource.id, key);
    return { outcome: 'updated', record: snapshotResource(record) };
  }

  /** Insert or re-observe one container anchor, deduped by stable identity. */
  upsertContainer(container: ContainerAnchorFact): FactWriteResult<ContainerAnchorFact> {
    assertContainer(container);
    const key = containerCanonicalKey(container);
    const existing = this.containersByKey.get(key);

    if (existing === undefined) {
      const indexKey = this.containerKeysById.get(container.id);
      if (indexKey !== undefined) {
        return { outcome: 'conflict', record: snapshotContainer(this.requireContainer(indexKey)) };
      }
      const record = snapshotContainer(container);
      this.containersByKey.set(key, record);
      this.containerKeysById.set(container.id, key);
      insertSorted(this.containerOrder, container.id);
      return { outcome: 'inserted', record: snapshotContainer(record) };
    }

    if (existing.id !== container.id) {
      return { outcome: 'conflict', record: snapshotContainer(existing) };
    }
    const incomingTime = containerLastObserved(container);
    const existingTime = containerLastObserved(existing);
    if (incomingTime < existingTime) {
      return { outcome: 'duplicate', record: snapshotContainer(existing) };
    }
    if (incomingTime === existingTime) {
      return sameContainer(existing, container)
        ? { outcome: 'duplicate', record: snapshotContainer(existing) }
        : { outcome: 'conflict', record: snapshotContainer(existing) };
    }
    const record = snapshotContainer(container);
    this.containersByKey.set(key, record);
    return { outcome: 'updated', record: snapshotContainer(record) };
  }

  /**
   * Mark a place gone from concrete disappearance evidence. The record and its
   * history stay in the store; only the query projection changes.
   */
  markPlaceGone(id: string, evidence: FactGoneEvidence): FactWriteResult<PlaceFact> {
    assertGoneEvidence(evidence);
    const key = this.placeKeysById.get(id);
    if (key === undefined) throw new Error(`unknown place id: ${id}`);
    const existing = this.requirePlace(key);
    if (existing.gone) {
      return { outcome: 'duplicate', record: snapshotPlace(existing) };
    }
    if (evidence.observedAt < existing.observedAt) {
      return { outcome: 'conflict', record: snapshotPlace(existing) };
    }
    const record: PlaceFact = {
      ...existing,
      gone: true,
      goneAt: evidence.observedAt,
      goneSource: snapshotProvenance(evidence.source),
    };
    this.placesByKey.set(key, record);
    return { outcome: 'updated', record: snapshotPlace(record) };
  }

  /**
   * Mark a container anchor gone from concrete disappearance evidence. The
   * anchor (identity, position, ledger link) is retained; only presence changes.
   */
  markContainerGone(id: string, evidence: FactGoneEvidence): FactWriteResult<ContainerAnchorFact> {
    assertGoneEvidence(evidence);
    const key = this.containerKeysById.get(id);
    if (key === undefined) throw new Error(`unknown container id: ${id}`);
    const existing = this.requireContainer(key);
    if (existing.gone) {
      return { outcome: 'duplicate', record: snapshotContainer(existing) };
    }
    if (evidence.observedAt < existing.observedAt) {
      return { outcome: 'conflict', record: snapshotContainer(existing) };
    }
    const record: ContainerAnchorFact = {
      ...existing,
      gone: true,
      goneAt: evidence.observedAt,
      goneSource: snapshotProvenance(evidence.source),
    };
    this.containersByKey.set(key, record);
    return { outcome: 'updated', record: snapshotContainer(record) };
  }

  /** Revoke a resource found by durable id. */
  revokeResource(id: string, evidence: FactGoneEvidence): FactWriteResult<ResourceAnchorFact> {
    assertGoneEvidence(evidence);
    const key = this.resourceKeysById.get(id);
    if (key === undefined) throw new Error(`unknown resource id: ${id}`);
    return this.applyResourceRevocation(this.requireResource(key), evidence);
  }

  /** Revoke a resource by its canonical source cell + label. */
  revokeResourceAt(
    ref: ResourceSourceRef,
    evidence: FactGoneEvidence,
  ): FactWriteResult<ResourceAnchorFact> {
    assertNonEmptyString(ref.worldId, 'resource ref worldId');
    assertNonEmptyString(ref.dim, 'resource ref dim');
    assertPoint(ref.sourceCell, 'resource ref sourceCell');
    assertNonEmptyString(ref.label, 'resource ref label');
    assertGoneEvidence(evidence);
    const key = resourceCanonicalKey(ref);
    const existing = this.resourcesByKey.get(key);
    if (existing === undefined) {
      throw new Error(`unknown resource source: ${ref.worldId}/${ref.dim} ${ref.label}`);
    }
    return this.applyResourceRevocation(existing, evidence);
  }

  /**
   * Re-anchor an existing resource id. The canonical cell+label entry is moved,
   * so queries at the old cell stop finding it without a collection rebuild.
   */
  updateResourceSource(
    id: string,
    update: ResourceSourceUpdate,
  ): FactWriteResult<ResourceAnchorFact> {
    assertNonEmptyString(id, 'resource id');
    assertPoint(update.sourceCell, 'resource sourceCell');
    assertFiniteNumber(update.observedAt, 'resource observedAt');
    assertProvenance(update.source);
    const existingKey = this.resourceKeysById.get(id);
    if (existingKey === undefined) throw new Error(`unknown resource id: ${id}`);
    const existing = this.requireResource(existingKey);
    if (existing.revoked) {
      // A revoked anchor is not moved; re-observe it through `upsertResource`.
      return { outcome: 'duplicate', record: snapshotResource(existing) };
    }
    const label = update.label ?? existing.label;
    assertNonEmptyString(label, 'resource label');
    if (update.observedAt < existing.observedAt) {
      return { outcome: 'duplicate', record: snapshotResource(existing) };
    }

    const nextKey = resourceCanonicalKey({
      worldId: existing.worldId,
      dim: existing.dim,
      sourceCell: update.sourceCell,
      label,
    });
    if (update.observedAt === existing.observedAt) {
      return nextKey === existingKey
        ? { outcome: 'duplicate', record: snapshotResource(existing) }
        : { outcome: 'conflict', record: snapshotResource(existing) };
    }

    if (nextKey !== existingKey) {
      const occupant = this.resourcesByKey.get(nextKey);
      if (occupant !== undefined && occupant.id !== id) {
        return { outcome: 'conflict', record: snapshotResource(occupant) };
      }
      this.resourcesByKey.delete(existingKey);
    }

    const record: ResourceAnchorFact = {
      ...existing,
      sourceCell: { ...update.sourceCell },
      label,
      observedAt: update.observedAt,
      source: snapshotProvenance(update.source),
    };
    this.resourcesByKey.set(nextKey, record);
    this.resourceKeysById.set(id, nextKey);
    return { outcome: 'updated', record: snapshotResource(record) };
  }

  /** Bounded, id-ordered page of places. Gone records require `includeGone`. */
  places(query: FactQuery = {}): FactPage<PlaceFact> {
    const includeGone = query.includeGone ?? false;
    return this.page(
      this.placeOrder,
      this.placeKeysById,
      this.placesByKey,
      query,
      (record) => matchesScope(record, query) && (includeGone || !record.gone),
      snapshotPlace,
    );
  }

  /** Bounded, id-ordered page of resource anchors. Revoked records require `includeGone`. */
  resources(query: ResourceFactQuery = {}): FactPage<ResourceAnchorFact> {
    if (query.sourceCell !== undefined) assertPoint(query.sourceCell, 'resource query sourceCell');
    const includeGone = query.includeGone ?? false;
    const cell = query.sourceCell;
    return this.page(
      this.resourceOrder,
      this.resourceKeysById,
      this.resourcesByKey,
      query,
      (record) =>
        matchesScope(record, query) &&
        (includeGone || !record.revoked) &&
        (cell === undefined || pointsEqual(record.sourceCell, cell)),
      snapshotResource,
    );
  }

  /** Bounded, id-ordered page of container anchors (no contents). */
  containers(query: FactQuery = {}): FactPage<ContainerAnchorFact> {
    const includeGone = query.includeGone ?? false;
    return this.page(
      this.containerOrder,
      this.containerKeysById,
      this.containersByKey,
      query,
      (record) => matchesScope(record, query) && (includeGone || !record.gone),
      snapshotContainer,
    );
  }

  /**
   * Capture every record of this store, including gone/revoked state, in stable
   * id order. This is the persistence capture, not a bounded query projection.
   */
  captureSnapshot(): {
    places: PlaceFact[];
    resources: ResourceAnchorFact[];
    containers: ContainerAnchorFact[];
  } {
    return {
      places: this.placeOrder.map((id) => {
        const key = this.placeKeysById.get(id);
        if (key === undefined) throw new Error('facts store place index is inconsistent');
        return snapshotPlace(this.requirePlace(key));
      }),
      resources: this.resourceOrder.map((id) => {
        const key = this.resourceKeysById.get(id);
        if (key === undefined) throw new Error('facts store resource index is inconsistent');
        return snapshotResource(this.requireResource(key));
      }),
      containers: this.containerOrder.map((id) => {
        const key = this.containerKeysById.get(id);
        if (key === undefined) throw new Error('facts store container index is inconsistent');
        return snapshotContainer(this.requireContainer(key));
      }),
    };
  }

  /**
   * Replace this store with a complete capture. Restore-only: the caller is
   * responsible for the snapshot's provenance/time; it is validated here and
   * inserted without re-dating or projecting.
   */
  restoreSnapshot(snapshot: {
    places: PlaceFact[];
    resources: ResourceAnchorFact[];
    containers: ContainerAnchorFact[];
  }): void {
    const placesByKey = new Map<string, PlaceFact>();
    const placeKeysById = new Map<string, string>();
    const placeOrder: string[] = [];
    for (const raw of snapshot.places) {
      assertPlace(raw);
      const record = snapshotPlace(raw);
      const key = placeCanonicalKey(record);
      if (placeKeysById.has(record.id) || placesByKey.has(key)) {
        throw new Error(`duplicate place id or identity "${record.id}"`);
      }
      placesByKey.set(key, record);
      placeKeysById.set(record.id, key);
      insertSorted(placeOrder, record.id);
    }

    const resourcesByKey = new Map<string, ResourceAnchorFact>();
    const resourceKeysById = new Map<string, string>();
    const resourceOrder: string[] = [];
    for (const raw of snapshot.resources) {
      assertResource(raw);
      const record = snapshotResource(raw);
      const key = resourceCanonicalKey(record);
      if (resourceKeysById.has(record.id) || resourcesByKey.has(key)) {
        throw new Error(`duplicate resource id or source cell + label "${record.id}"`);
      }
      resourcesByKey.set(key, record);
      resourceKeysById.set(record.id, key);
      insertSorted(resourceOrder, record.id);
    }

    const containersByKey = new Map<string, ContainerAnchorFact>();
    const containerKeysById = new Map<string, string>();
    const containerOrder: string[] = [];
    for (const raw of snapshot.containers) {
      assertContainer(raw);
      const record = snapshotContainer(raw);
      const key = containerCanonicalKey(record);
      if (containerKeysById.has(record.id) || containersByKey.has(key)) {
        throw new Error(`duplicate container id or identity "${record.id}"`);
      }
      containersByKey.set(key, record);
      containerKeysById.set(record.id, key);
      insertSorted(containerOrder, record.id);
    }

    this.placesByKey.clear();
    this.placeKeysById.clear();
    this.placeOrder.length = 0;
    this.resourcesByKey.clear();
    this.resourceKeysById.clear();
    this.resourceOrder.length = 0;
    this.containersByKey.clear();
    this.containerKeysById.clear();
    this.containerOrder.length = 0;

    for (const [key, record] of placesByKey) this.placesByKey.set(key, record);
    for (const [id, key] of placeKeysById) this.placeKeysById.set(id, key);
    this.placeOrder.push(...placeOrder);
    for (const [key, record] of resourcesByKey) this.resourcesByKey.set(key, record);
    for (const [id, key] of resourceKeysById) this.resourceKeysById.set(id, key);
    this.resourceOrder.push(...resourceOrder);
    for (const [key, record] of containersByKey) this.containersByKey.set(key, record);
    for (const [id, key] of containerKeysById) this.containerKeysById.set(id, key);
    this.containerOrder.push(...containerOrder);
  }

  private applyPlaceObservation(
    existing: PlaceFact,
    incoming: PlaceFact,
  ): FactWriteResult<PlaceFact> {
    const incomingTime = placeLastObserved(incoming);
    const existingTime = placeLastObserved(existing);
    if (incomingTime < existingTime) {
      return { outcome: 'duplicate', record: snapshotPlace(existing) };
    }
    if (incomingTime === existingTime) {
      return samePlace(existing, incoming)
        ? { outcome: 'duplicate', record: snapshotPlace(existing) }
        : { outcome: 'conflict', record: snapshotPlace(existing) };
    }
    const key = placeCanonicalKey(incoming);
    const record = snapshotPlace(incoming);
    this.placesByKey.set(key, record);
    return { outcome: 'updated', record: snapshotPlace(record) };
  }

  private applyResourceObservation(
    existing: ResourceAnchorFact,
    incoming: ResourceAnchorFact,
  ): FactWriteResult<ResourceAnchorFact> {
    const incomingTime = resourceLastObserved(incoming);
    const existingTime = resourceLastObserved(existing);
    if (incomingTime < existingTime) {
      return { outcome: 'duplicate', record: snapshotResource(existing) };
    }
    if (incomingTime === existingTime) {
      return sameResource(existing, incoming)
        ? { outcome: 'duplicate', record: snapshotResource(existing) }
        : { outcome: 'conflict', record: snapshotResource(existing) };
    }
    const key = resourceCanonicalKey(incoming);
    const record = snapshotResource(incoming);
    this.resourcesByKey.set(key, record);
    return { outcome: 'updated', record: snapshotResource(record) };
  }

  private applyResourceRevocation(
    existing: ResourceAnchorFact,
    evidence: FactGoneEvidence,
  ): FactWriteResult<ResourceAnchorFact> {
    if (existing.revoked) {
      return { outcome: 'duplicate', record: snapshotResource(existing) };
    }
    if (evidence.observedAt < existing.observedAt) {
      return { outcome: 'conflict', record: snapshotResource(existing) };
    }
    const record: ResourceAnchorFact = {
      ...existing,
      revoked: true,
      revokedAt: evidence.observedAt,
      revokedSource: snapshotProvenance(evidence.source),
    };
    const key = resourceCanonicalKey(record);
    this.resourcesByKey.set(key, record);
    return { outcome: 'updated', record: snapshotResource(record) };
  }

  private page<T extends { id: string }>(
    order: readonly string[],
    keysById: ReadonlyMap<string, string>,
    records: ReadonlyMap<string, T>,
    query: FactQuery,
    matches: (record: T) => boolean,
    snapshot: (record: T) => T,
  ): FactPage<T> {
    const limit = this.resolveLimit(query.limit);
    const start = firstIdAfter(order, query.after);
    const items: T[] = [];
    let total = 0;
    let more = false;

    for (let index = 0; index < order.length; index += 1) {
      const id = order[index];
      if (id === undefined) continue;
      const key = keysById.get(id);
      if (key === undefined) continue;
      const record = records.get(key);
      if (record === undefined || !matches(record)) continue;
      total += 1;
      if (index < start) continue;
      if (items.length < limit) {
        items.push(snapshot(record));
      } else {
        more = true;
      }
    }

    const last = items[items.length - 1];
    return {
      items,
      total,
      ...(more && last !== undefined ? { nextAfter: last.id } : {}),
    };
  }

  private resolveLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return Math.min(this.maxQueryLimit, DEFAULT_FACT_PAGE_LIMIT);
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`facts query limit must be a positive safe integer: ${limit}`);
    }
    return Math.min(limit, this.maxQueryLimit);
  }

  private requirePlace(key: string): PlaceFact {
    const record = this.placesByKey.get(key);
    if (record === undefined) throw new Error('facts store place index is inconsistent');
    return record;
  }

  private requireResource(key: string): ResourceAnchorFact {
    const record = this.resourcesByKey.get(key);
    if (record === undefined) throw new Error('facts store resource index is inconsistent');
    return record;
  }

  private requireContainer(key: string): ContainerAnchorFact {
    const record = this.containersByKey.get(key);
    if (record === undefined) throw new Error('facts store container index is inconsistent');
    return record;
  }
}

function matchesScope(record: { worldId: string; dim: string }, query: FactQuery): boolean {
  if (query.worldId !== undefined && record.worldId !== query.worldId) return false;
  if (query.dim !== undefined && record.dim !== query.dim) return false;
  return true;
}

function placeLastObserved(place: PlaceFact): number {
  return Math.max(place.observedAt, place.goneAt ?? place.observedAt);
}

function resourceLastObserved(resource: ResourceAnchorFact): number {
  return Math.max(resource.observedAt, resource.revokedAt ?? resource.observedAt);
}

function containerLastObserved(container: ContainerAnchorFact): number {
  return Math.max(container.observedAt, container.goneAt ?? container.observedAt);
}

function samePlace(a: PlaceFact, b: PlaceFact): boolean {
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

function sameResource(a: ResourceAnchorFact, b: ResourceAnchorFact): boolean {
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

function sameContainer(a: ContainerAnchorFact, b: ContainerAnchorFact): boolean {
  return (
    a.id === b.id &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    pointsEqual(a.pos, b.pos) &&
    a.externalRef === b.externalRef &&
    a.ledgerRef === b.ledgerRef &&
    a.gone === b.gone &&
    a.goneAt === b.goneAt
  );
}

function insertSorted(order: string[], id: string): void {
  let low = 0;
  let high = order.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = order[middle];
    if (current !== undefined && current < id) low = middle + 1;
    else high = middle;
  }
  order.splice(low, 0, id);
}

function firstIdAfter(order: readonly string[], after: string | undefined): number {
  if (after === undefined) return 0;
  let low = 0;
  let high = order.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = order[middle];
    if (current !== undefined && current <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

function snapshotPlace(place: PlaceFact): PlaceFact {
  return {
    ...place,
    location: snapshotLocation(place.location),
    source: snapshotProvenance(place.source),
    ...(place.goneSource === undefined
      ? {}
      : { goneSource: snapshotProvenance(place.goneSource) }),
  };
}

function snapshotResource(resource: ResourceAnchorFact): ResourceAnchorFact {
  return {
    ...resource,
    sourceCell: { ...resource.sourceCell },
    source: snapshotProvenance(resource.source),
    ...(resource.revokedSource === undefined
      ? {}
      : { revokedSource: snapshotProvenance(resource.revokedSource) }),
  };
}

function snapshotContainer(container: ContainerAnchorFact): ContainerAnchorFact {
  return {
    ...container,
    pos: { ...container.pos },
    source: snapshotProvenance(container.source),
    ...(container.goneSource === undefined
      ? {}
      : { goneSource: snapshotProvenance(container.goneSource) }),
  };
}

function snapshotLocation(location: FactLocation): FactLocation {
  return location.kind === 'exact'
    ? { kind: 'exact', pos: { ...location.pos } }
    : { kind: 'area', center: { ...location.center }, radius: location.radius };
}

function snapshotProvenance(source: FactProvenance): FactProvenance {
  return {
    source: source.source,
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    ...(source.observationIds === undefined
      ? {}
      : { observationIds: [...source.observationIds] }),
  };
}
