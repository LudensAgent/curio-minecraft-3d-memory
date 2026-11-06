/**
 * Shared fixtures for M2 query tests. Not a vitest suite.
 *
 * The fixtures wire the same narrow `SpatialQuerySources` view the store uses,
 * so handler tests exercise the real projection without depending on the store
 * `query` method (added in a later batch).
 */

import {
  blockToSection,
  FragmentStore,
  SpatialMemoryStoreImpl,
  TopologyStore,
  VoxelMap,
} from '../src/index.js';
import type { SpatialNode, Vec3Like } from '../src/index.js';
import { runSpatialQuery } from '../src/query/index.js';
import { MAX_QUERY_LIMIT } from '../src/query/paging.js';
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
  store: SpatialMemoryStoreImpl;
  map: VoxelMap;
  fragments: FragmentStore;
  topology: TopologyStore;
}

export function makeQueryParts(
  overrides: {
    map?: VoxelMap;
    fragments?: FragmentStore;
    topology?: TopologyStore;
    now?: () => number;
    query?: SpatialQueryOptions;
  } = {},
): QueryParts {
  const now = overrides.now ?? (() => 5000);
  const map = overrides.map ?? new VoxelMap(WORLD, { now });
  const fragments = overrides.fragments ?? new FragmentStore(WORLD);
  const topology = overrides.topology ?? new TopologyStore(fragments, { now });
  const store = new SpatialMemoryStoreImpl({
    worldId: WORLD,
    map,
    fragments,
    topology,
    ...(overrides.query === undefined ? {} : { query: overrides.query }),
  });
  return { store, map, fragments, topology };
}

export function makeQuerySources(parts: QueryParts): SpatialQuerySources {
  const { store, map, fragments, topology } = parts;
  return {
    worldId: WORLD,
    currentSessionId: () => map.sessionId,
    cellAt: (dim, x, y, z) => map.cellAt(dim, x, y, z),
    residencyAt: (dim, x, y, z) => {
      const { cx, cz, sy } = blockToSection(x, y, z);
      return map.sectionResidency({ worldId: WORLD, dim, cx, cz, sy }).residency;
    },
    fragments: {
      fragments: (query) => fragments.fragments(query),
      traversals: (query) => fragments.traversals(query),
      getFragment: (id) => fragments.getFragment(id),
    },
    topology,
    history: {
      routeInspection: (dim, from, to, options) =>
        store.routeInspection(dim, from, to, options),
      surfaceAnchor: (dim, here, options) => store.surfaceAnchor(dim, here, options),
      deepestAnchor: (dim, here, options) => store.deepestAnchor(dim, here, options),
      components: (dim) => store.components(dim),
      segments: (fragmentId) => store.segments(fragmentId),
    },
    snapshot: () => store.snapshot(),
    memoryCapabilities: () => store.describeCapabilities(),
  };
}

export function runQuery(
  parts: QueryParts,
  request: unknown,
  options: SpatialQueryOptions = {},
): SpatialQueryResult {
  return runSpatialQuery(makeQuerySources(parts), request, options);
}

export function makeNode(
  id: string,
  pos: Vec3Like,
  overrides: Partial<SpatialNode> = {},
): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'agent',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { ...pos } },
    ...overrides,
  };
}

function collectPages<T>(
  fetch: (
    after: string | undefined,
    limit: number,
  ) => { items: T[]; total: number; nextAfter?: string },
): T[] {
  const items: T[] = [];
  let after: string | undefined;
  let pageBudget = 1;
  for (let pageIndex = 0; pageIndex < pageBudget; pageIndex += 1) {
    const page = fetch(after, MAX_QUERY_LIMIT);
    if (pageIndex === 0) pageBudget = Math.max(1, page.total);
    items.push(...page.items);
    if (page.nextAfter === undefined) return items;
    after = page.nextAfter;
  }
  return items;
}

/**
 * `componentCache`/`componentNext` are TypeScript-private; reading them is the
 * only direct proof that a query path never creates cache or counter entries.
 */
export function captureComponentCache(parts: QueryParts) {
  const state = parts.topology as unknown as {
    componentCache: Map<string, Map<string, number>>;
    componentNext: Map<string, number>;
  };
  return {
    cached: [...state.componentCache].map(([dim, cache]) => [dim, [...cache]] as const),
    counters: [...state.componentNext],
  };
}

/** Read-only snapshot used by tests to prove a query did not mutate anything. */
export function captureStoreState(parts: QueryParts): unknown {
  return {
    saveRevision: parts.map.saveRevision,
    pins: parts.map.pinState(),
    residency: parts.map.residentSize(),
    fragmentRevision: parts.fragments.revision,
    topologyRevision: parts.topology.revision,
    cell: parts.map.cellAt(DIM, 0, 0, 0),
    section: parts.map.sectionAt(DIM, 0, 0, 0),
    // Evidence times and use counters must survive a query untouched.
    nodes: collectPages((after, limit) => parts.topology.nodes({ after, limit })).map((node) => ({
      id: node.id,
      observedAt: node.observedAt,
    })),
    fragments: collectPages((after, limit) => parts.fragments.fragments({ after, limit })).map(
      (fragment) => ({
        id: fragment.id,
        lastUsedAt: fragment.lastUsedAt,
        uses: fragment.uses,
      }),
    ),
    traversals: collectPages((after, limit) =>
      parts.fragments.traversals({ after, limit }),
    ).map((traversal) => ({
      id: traversal.id,
      observedAt: traversal.observedAt,
    })),
    edges: collectPages((after, limit) => parts.topology.edges({ after, limit })).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      basis: edge.basis,
    })),
    // The component cache and its id counters are write-side derivation state;
    // a read-only query must leave both untouched.
    components: captureComponentCache(parts),
  };
}
