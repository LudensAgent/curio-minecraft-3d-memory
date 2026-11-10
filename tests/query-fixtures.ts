/**
 * Shared fixtures for voxel + facts query tests. Not a vitest suite.
 *
 * The fixtures wire the same narrow `SpatialQuerySources` view the production
 * port uses, so handler tests exercise the real projection without depending on
 * a removed legacy store.
 */

import { InMemoryFactStore, VoxelMap, blockToSection } from '../src/index.js';
import type { Vec3Like } from '../src/index.js';
import { runSpatialQuery } from '../src/query/index.js';
import type {
  SpatialQueryOptions,
  SpatialQueryResult,
  SpatialQuerySources,
} from '../src/query/types.js';

export const WORLD = 'world';
export const DIM = 'overworld';

export const A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
export const B: Vec3Like = { x: 1.5, y: 64, z: 0.5 };
export const C: Vec3Like = { x: 2.5, y: 64, z: 0.5 };

export interface QueryParts {
  map: VoxelMap;
  facts: InMemoryFactStore;
}

export function makeQueryParts(
  overrides: {
    map?: VoxelMap;
    facts?: InMemoryFactStore;
    now?: () => number;
  } = {},
): QueryParts {
  const now = overrides.now ?? (() => 5000);
  const map = overrides.map ?? new VoxelMap(WORLD, { now });
  const facts = overrides.facts ?? new InMemoryFactStore();
  return { map, facts };
}

export function makeQuerySources(parts: QueryParts): SpatialQuerySources {
  const { map, facts } = parts;
  return {
    worldId: WORLD,
    facts,
    currentSessionId: () => map.sessionId,
    cellAt: (dim, x, y, z) => map.cellAt(dim, x, y, z),
    residencyAt: (dim, x, y, z) => {
      const { cx, cz, sy } = blockToSection(x, y, z);
      return map.sectionResidency({ worldId: WORLD, dim, cx, cz, sy }).residency;
    },
    memoryCapabilities: () => ({
      observeBatch: typeof map.observeBatch === 'function',
      beginSession: typeof map.beginSession === 'function',
      markStale: typeof map.markStale === 'function',
      markTraversed: typeof map.markTraversed === 'function',
      markModified: typeof map.markModified === 'function',
      checkpoint: false,
      flush: false,
      close: false,
    }),
  };
}

export function runQuery(
  parts: QueryParts,
  request: unknown,
  options: SpatialQueryOptions = {},
): SpatialQueryResult {
  return runSpatialQuery(makeQuerySources(parts), request, options);
}

/**
 * Read-only state fingerprint used to prove a query did not refresh evidence,
 * advance revisions or mutate the map/facts.
 */
export function captureStoreState(parts: QueryParts): unknown {
  return {
    saveRevision: parts.map.saveRevision,
    sessionId: parts.map.sessionId,
    factsRevision: parts.facts.revision,
  };
}
