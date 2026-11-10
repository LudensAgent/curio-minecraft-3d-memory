/**
 * Persistent semantic fact store: a synchronous in-memory authority plus an
 * explicit checkpoint/ACK lifecycle.
 *
 * The in-memory store remains the hot path. Persistence is never implicit: a
 * caller captures `checkpointSnapshot()` and later acknowledges exactly that
 * captured revision. A write after capture keeps the domain dirty, and a late
 * ACK for an older revision can only advance the confirmed marker — it never
 * rewrites, deletes or re-dates newer facts.
 */

import type { JsonObject } from '../json-value.js';
import { InMemoryFactStore } from './in-memory-facts-store.js';
import {
  type ContainerAnchorFact,
  type FactCheckpointSnapshot,
  type FactGoneEvidence,
  type FactPage,
  type FactQuery,
  type FactStore,
  type FactWriteResult,
  type PersistentFactStoreOptions,
  type PlaceFact,
  type ResourceAnchorFact,
  type ResourceFactQuery,
  type ResourceSourceUpdate,
  type SemanticFact,
  type SemanticFactKind,
} from './types.js';
import { validateFactCheckpointSnapshot } from './validation.js';

export class PersistentFactStore implements FactStore {
  private readonly inner: InMemoryFactStore;
  private readonly worldId: string;
  private revisionField = 0;
  private confirmedRevisionField = 0;

  constructor(options: PersistentFactStoreOptions) {
    if (typeof options.worldId !== 'string' || options.worldId.length === 0) {
      throw new Error('persistent facts worldId must be a non-empty string');
    }
    this.worldId = options.worldId;
    this.inner = new InMemoryFactStore(options);
  }

  get revision(): number {
    return this.revisionField;
  }

  get confirmedRevision(): number {
    return this.confirmedRevisionField;
  }

  upsertPlace(fact: PlaceFact): FactWriteResult<PlaceFact> {
    if (fact.worldId !== this.worldId) throw new Error('place worldId does not match store worldId');
    return this.apply(this.inner.upsertPlace(fact));
  }

  upsertResource(fact: ResourceAnchorFact): FactWriteResult<ResourceAnchorFact> {
    if (fact.worldId !== this.worldId) throw new Error('resource worldId does not match store worldId');
    return this.apply(this.inner.upsertResource(fact));
  }

  upsertContainer(fact: ContainerAnchorFact): FactWriteResult<ContainerAnchorFact> {
    if (fact.worldId !== this.worldId) throw new Error('container worldId does not match store worldId');
    return this.apply(this.inner.upsertContainer(fact));
  }

  markPlaceGone(id: string, evidence: FactGoneEvidence): FactWriteResult<PlaceFact> {
    return this.apply(this.inner.markPlaceGone(id, evidence));
  }

  revokeResource(id: string, evidence: FactGoneEvidence): FactWriteResult<ResourceAnchorFact> {
    return this.apply(this.inner.revokeResource(id, evidence));
  }

  markContainerGone(id: string, evidence: FactGoneEvidence): FactWriteResult<ContainerAnchorFact> {
    return this.apply(this.inner.markContainerGone(id, evidence));
  }

  updateResourceSource(
    id: string,
    update: ResourceSourceUpdate,
  ): FactWriteResult<ResourceAnchorFact> {
    return this.apply(this.inner.updateResourceSource(id, update));
  }

  updateHostData(kind: SemanticFactKind, id: string, hostData: JsonObject): FactWriteResult<SemanticFact> {
    return this.apply(this.inner.updateHostData(kind, id, hostData));
  }

  places(query: FactQuery = {}): FactPage<PlaceFact> {
    return this.inner.places(query);
  }

  resources(query: ResourceFactQuery = {}): FactPage<ResourceAnchorFact> {
    return this.inner.resources(query);
  }

  containers(query: FactQuery = {}): FactPage<ContainerAnchorFact> {
    return this.inner.containers(query);
  }

  checkpointSnapshot(): FactCheckpointSnapshot {
    return {
      worldId: this.worldId,
      revision: this.revisionField,
      ...this.inner.captureSnapshot(),
    };
  }

  installSnapshot(snapshot: FactCheckpointSnapshot): void {
    const validated = validateFactCheckpointSnapshot(snapshot, this.worldId);
    this.inner.restoreSnapshot(validated);
    // A restored snapshot is committed state: memory starts clean at exactly the
    // captured revision, while the original record times/ids/state are untouched.
    this.revisionField = validated.revision;
    this.confirmedRevisionField = validated.revision;
  }

  confirmRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`facts revision to confirm must be a non-negative safe integer: ${revision}`);
    }
    if (revision > this.revisionField) {
      throw new Error(
        `cannot confirm facts revision ${revision}: local revision is ${this.revisionField}`,
      );
    }
    // `max` makes a delayed ACK harmless: it cannot lower the confirmed marker
    // and never touches records written after the captured revision.
    this.confirmedRevisionField = Math.max(this.confirmedRevisionField, revision);
  }

  hasPendingChanges(): boolean {
    return this.revisionField !== this.confirmedRevisionField;
  }

  private apply<T>(result: FactWriteResult<T>): FactWriteResult<T> {
    if (result.outcome === 'inserted' || result.outcome === 'updated') {
      this.revisionField += 1;
    }
    return result;
  }
}
