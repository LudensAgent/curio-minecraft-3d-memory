/**
 * Canonical identity keys for semantic facts.
 *
 * Keys are internal to the facts layer. They are JSON-encoded tuples so labels
 * or host ids containing separators cannot collide. The store and the legacy
 * dry-run share these keys so "already migrated" means the same thing in both.
 */

import type {
  ContainerAnchorFact,
  FactLocation,
  PlaceFact,
  ResourceAnchorFact,
} from './types.js';
import type { Vec3Like } from '../types.js';

export function placeCanonicalKey(
  fact: Pick<PlaceFact, 'worldId' | 'dim' | 'id'>,
): string {
  return JSON.stringify(['place', fact.worldId, fact.dim, fact.id]);
}

export function resourceCanonicalKey(
  fact: Pick<ResourceAnchorFact, 'worldId' | 'dim' | 'sourceCell' | 'label'>,
): string {
  const { x, y, z } = fact.sourceCell;
  return JSON.stringify(['resource', fact.worldId, fact.dim, x, y, z, fact.label]);
}

export function containerCanonicalKey(
  fact: Pick<ContainerAnchorFact, 'worldId' | 'dim' | 'externalRef'>,
): string {
  return JSON.stringify(['container', fact.worldId, fact.dim, fact.externalRef]);
}

export function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function locationsEqual(a: FactLocation, b: FactLocation): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') return pointsEqual(a.pos, b.pos);
  if (a.kind === 'area' && b.kind === 'area') {
    return a.radius === b.radius && pointsEqual(a.center, b.center);
  }
  return false;
}
