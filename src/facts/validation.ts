/**
 * Runtime validation for semantic fact records.
 *
 * The in-memory store and the persistence worker both consume untrusted shapes
 * (a caller-built record or a structured-clone message), so the same checks run
 * at both boundaries. These are storage-integrity checks only: they never infer
 * evidence, kind or gone state beyond what the record already states.
 */

import {
  containerCanonicalKey,
  placeCanonicalKey,
  resourceCanonicalKey,
} from './canonical.js';
import { snapshotJsonObject } from '../json-value.js';
import type { Vec3Like } from '../types.js';
import type {
  ContainerAnchorFact,
  FactCheckpointSnapshot,
  FactGoneEvidence,
  FactLocation,
  FactProvenance,
  PlaceFact,
  PlaceKind,
  ResourceAnchorFact,
} from './types.js';

export function assertPlace(place: PlaceFact): void {
  assertNonEmptyString(place.id, 'place id');
  assertNonEmptyString(place.worldId, 'place worldId');
  assertNonEmptyString(place.dim, 'place dim');
  assertNonEmptyString(place.label, 'place label');
  if (!isPlaceKind(place.kind)) throw new Error(`place kind is not supported: ${place.kind}`);
  assertFiniteNumber(place.observedAt, 'place observedAt');
  assertLocation(place.location, 'place location');
  assertProvenance(place.source);
  if (typeof place.gone !== 'boolean') throw new Error('place gone must be a boolean');
  if (place.goneAt !== undefined) assertFiniteNumber(place.goneAt, 'place goneAt');
  if (place.goneSource !== undefined) assertProvenance(place.goneSource);
  if (place.legacyId !== undefined) assertNonEmptyString(place.legacyId, 'place legacyId');
  if (place.hostData !== undefined) assertHostData(place.hostData, 'place hostData');
}

export function assertResource(resource: ResourceAnchorFact): void {
  assertNonEmptyString(resource.id, 'resource id');
  assertNonEmptyString(resource.worldId, 'resource worldId');
  assertNonEmptyString(resource.dim, 'resource dim');
  assertNonEmptyString(resource.label, 'resource label');
  if (resource.resourceType !== undefined) {
    assertNonEmptyString(resource.resourceType, 'resource resourceType');
  }
  assertPoint(resource.sourceCell, 'resource sourceCell');
  assertFiniteNumber(resource.observedAt, 'resource observedAt');
  assertProvenance(resource.source);
  if (typeof resource.revoked !== 'boolean') throw new Error('resource revoked must be a boolean');
  if (resource.revokedAt !== undefined) assertFiniteNumber(resource.revokedAt, 'resource revokedAt');
  if (resource.revokedSource !== undefined) assertProvenance(resource.revokedSource);
  if (resource.legacyId !== undefined) {
    assertNonEmptyString(resource.legacyId, 'resource legacyId');
  }
  if (resource.hostData !== undefined) assertHostData(resource.hostData, 'resource hostData');
}

export function assertContainer(container: ContainerAnchorFact): void {
  assertNonEmptyString(container.id, 'container id');
  assertNonEmptyString(container.worldId, 'container worldId');
  assertNonEmptyString(container.dim, 'container dim');
  assertPoint(container.pos, 'container pos');
  assertNonEmptyString(container.externalRef, 'container externalRef');
  assertFiniteNumber(container.observedAt, 'container observedAt');
  assertProvenance(container.source);
  if (typeof container.gone !== 'boolean') throw new Error('container gone must be a boolean');
  if (container.goneAt !== undefined) assertFiniteNumber(container.goneAt, 'container goneAt');
  if (container.goneSource !== undefined) assertProvenance(container.goneSource);
  if (container.ledgerRef !== undefined) {
    assertNonEmptyString(container.ledgerRef, 'container ledgerRef');
  }
  if (container.legacyId !== undefined) {
    assertNonEmptyString(container.legacyId, 'container legacyId');
  }
  if (container.hostData !== undefined) assertHostData(container.hostData, 'container hostData');
}

/** Host metadata must be finite JSON; the store deep-copies it separately. */
export function assertHostData(value: unknown, label: string): void {
  snapshotJsonObject(value, label);
}

export function assertGoneEvidence(evidence: FactGoneEvidence): void {
  assertFiniteNumber(evidence.observedAt, 'gone observedAt');
  assertProvenance(evidence.source);
}

/**
 * Validate a complete facts-domain capture at the persistence boundary.
 *
 * Checks shape, world scope, stable-id/canonical-key uniqueness, and the
 * gone/revoked flags. It deliberately does not consult topography, topology or
 * any other domain: a missing or empty capture stays empty.
 */
export function validateFactCheckpointSnapshot(
  value: unknown,
  expectedWorldId?: string,
): FactCheckpointSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('facts snapshot must be an object');
  }
  const snapshot = value as Partial<FactCheckpointSnapshot>;
  assertNonEmptyString(snapshot.worldId as string, 'facts snapshot worldId');
  if (expectedWorldId !== undefined && snapshot.worldId !== expectedWorldId) {
    throw new Error('facts snapshot worldId does not match session worldId');
  }
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) {
    throw new Error('facts snapshot revision must be a non-negative safe integer');
  }
  if (!Array.isArray(snapshot.places) || !Array.isArray(snapshot.resources) || !Array.isArray(snapshot.containers)) {
    throw new Error('facts snapshot arrays are malformed');
  }

  const placeIds = new Set<string>();
  const placeKeys = new Set<string>();
  for (const place of snapshot.places as PlaceFact[]) {
    assertPlace(place);
    assertWorld(place.worldId, snapshot.worldId as string, 'place');
    if (placeIds.has(place.id)) throw new Error(`duplicate place id "${place.id}"`);
    placeIds.add(place.id);
    const key = placeCanonicalKey(place);
    if (placeKeys.has(key)) throw new Error(`duplicate place identity "${place.id}"`);
    placeKeys.add(key);
  }

  const resourceIds = new Set<string>();
  const resourceKeys = new Set<string>();
  for (const resource of snapshot.resources as ResourceAnchorFact[]) {
    assertResource(resource);
    assertWorld(resource.worldId, snapshot.worldId as string, 'resource');
    if (resourceIds.has(resource.id)) throw new Error(`duplicate resource id "${resource.id}"`);
    resourceIds.add(resource.id);
    const key = resourceCanonicalKey(resource);
    if (resourceKeys.has(key)) {
      throw new Error(`duplicate resource source cell + label under id "${resource.id}"`);
    }
    resourceKeys.add(key);
  }

  const containerIds = new Set<string>();
  const containerKeys = new Set<string>();
  for (const container of snapshot.containers as ContainerAnchorFact[]) {
    assertContainer(container);
    assertWorld(container.worldId, snapshot.worldId as string, 'container');
    if (containerIds.has(container.id)) throw new Error(`duplicate container id "${container.id}"`);
    containerIds.add(container.id);
    const key = containerCanonicalKey(container);
    if (containerKeys.has(key)) {
      throw new Error(`duplicate container identity under id "${container.id}"`);
    }
    containerKeys.add(key);
  }

  return snapshot as FactCheckpointSnapshot;
}

function assertWorld(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw new Error(`facts ${what} worldId "${actual}" does not match snapshot worldId "${expected}"`);
  }
}

export function assertLocation(location: FactLocation, label: string): void {
  if (location === null || typeof location !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  if (location.kind === 'exact') {
    assertPoint(location.pos, `${label} pos`);
    return;
  }
  if (location.kind === 'area') {
    assertPoint(location.center, `${label} center`);
    assertFiniteNumber(location.radius, `${label} radius`);
    if (location.radius < 0) throw new Error(`${label} radius must be non-negative`);
    return;
  }
  throw new Error(`${label} kind is not supported`);
}

export function assertPoint(point: Vec3Like, label: string): void {
  if (point === null || typeof point !== 'object') throw new Error(`${label} must be an object`);
  assertFiniteNumber(point.x, `${label}.x`);
  assertFiniteNumber(point.y, `${label}.y`);
  assertFiniteNumber(point.z, `${label}.z`);
}

export function assertProvenance(source: FactProvenance): void {
  if (source === null || typeof source !== 'object') throw new Error('fact source must be an object');
  assertNonEmptyString(source.source, 'fact source');
  if (source.sessionId !== undefined) assertNonEmptyString(source.sessionId, 'fact sessionId');
  if (source.observationIds === undefined) return;
  if (!Array.isArray(source.observationIds)) throw new Error('fact observationIds must be an array');
  for (const observationId of source.observationIds) {
    assertNonEmptyString(observationId, 'fact observationId');
  }
}

export function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function assertFiniteNumber(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

export function isPlaceKind(value: string): value is PlaceKind {
  return (
    value === 'place' ||
    value === 'base' ||
    value === 'death' ||
    value === 'portal' ||
    value === 'station' ||
    value === 'hazard'
  );
}
