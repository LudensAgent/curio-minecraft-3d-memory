/**
 * Read-only query port (contract §5, plan M2).
 *
 * `runSpatialQuery` validates the raw request once, resolves the query context,
 * and dispatches to a handler. `createSpatialQueryPort` is the object-shaped
 * adaptation used by `SpatialMemoryStoreImpl`.
 *
 * This module is memory-core only: it has no runtime import of navigation,
 * execution, adapter body ports, or the store implementation. The store injects
 * a narrow `SpatialQuerySources` view at construction time.
 */

import { queryAnchors } from './anchors.js';
import { queryCapabilities, querySnapshot } from './capabilities.js';
import { queryCells } from './cells.js';
import { invalidQueryResult, unsupportedQueryResult } from './envelope.js';
import { queryFrontiers } from './frontiers.js';
import { queryFacts } from './facts.js';
import { queryHistory } from './history.js';
import { queryTopology } from './topology.js';
import { validateSpatialQueryRequest } from './validate.js';
import { blockToSection } from '../voxel/coordinates.js';
import { SPATIAL_MEMORY_CAPABILITY_NAMES } from './types.js';
import type {
  SpatialMemoryCapabilities,
  SpatialMemoryStoreSnapshot,
  SpatialQueryContext,
  SpatialQueryKind,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
  VoxelFactsQueryOptions,
} from './types.js';

export type {
  CellQueryView,
  FrontierBoundaryDirection,
  FrontierCandidateQueryView,
  FrontierQueryData,
  FrontierQuerySource,
  SpatialMemoryStoreSnapshot,
  SpatialQueryContext,
  SpatialQueryData,
  SpatialQueryKind,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryProblem,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
  SpatialQueryStatus,
  VoxelFactsQueryOptions,
  VoxelFactsQueryVoxel,
} from './types.js';

function makeContext(
  sources: SpatialQuerySources,
  options: SpatialQueryOptions,
): SpatialQueryContext {
  // `worldId` is validated once at the store boundary that owns it
  // (`SpatialMemoryStoreImpl`); the query port receives an already-typed value.
  return {
    sources,
    worldId: sources.worldId,
    now: options.now ?? Date.now,
    ...(options.isContainer === undefined ? {} : { isContainer: options.isContainer }),
  };
}

type QueryHandler<K extends SpatialQueryKind> = (
  context: SpatialQueryContext,
  request: Extract<SpatialQueryRequest, { kind: K }>,
) => SpatialQueryResult;

/**
 * One exhaustive kind→handler table. The `Record` annotation makes a missing
 * or misspelled kind a compile error instead of an implicit `undefined` return.
 */
const QUERY_HANDLERS: { [K in SpatialQueryKind]: QueryHandler<K> } = {
  cells: queryCells,
  fragments: queryTopology,
  traversals: queryTopology,
  nodes: queryTopology,
  edges: queryTopology,
  portals: queryTopology,
  historyRoute: queryHistory,
  anchor: queryHistory,
  components: queryHistory,
  segments: queryHistory,
  resourceAnchors: queryAnchors,
  containerAnchors: queryAnchors,
  containerContents: queryAnchors,
  frontiers: queryFrontiers,
  snapshot: querySnapshot,
  capabilities: queryCapabilities,
};

const LEGACY_ROUTE_KINDS: ReadonlySet<SpatialQueryKind> = new Set([
  'fragments', 'traversals', 'edges', 'portals', 'historyRoute', 'anchor', 'components', 'segments',
]);

const LEGACY_STORES_ABSENT =
  'this query composition has no legacy fragment/topology stores; ' +
  'use facts for semantic places/anchors and voxel cells for geometry';

function dispatch(
  context: SpatialQueryContext,
  request: SpatialQueryRequest,
): SpatialQueryResult {
  if (context.sources.facts !== undefined) {
    if (request.kind === 'nodes' || request.kind === 'resourceAnchors' || request.kind === 'containerAnchors') {
      return queryFacts(context, request);
    }
    if (LEGACY_ROUTE_KINDS.has(request.kind)) {
      return unsupportedQueryResult(context, request.kind, 'legacy route queries are retired; query facts for places and voxel cells for geometry');
    }
  }
  if (LEGACY_ROUTE_KINDS.has(request.kind)
    && (context.sources.fragments === undefined
      || context.sources.topology === undefined
      || context.sources.history === undefined)) {
    return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT);
  }
  // `nodes`/`resourceAnchors`/`containerAnchors` without facts fall back to the
  // legacy topology only when such a store is actually composed.
  if ((request.kind === 'nodes' || request.kind === 'resourceAnchors' || request.kind === 'containerAnchors')
    && context.sources.topology === undefined) {
    return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT, request.dim);
  }
  // TypeScript cannot carry the kind→handler correlation through an indexed
  // union lookup; the table is exhaustive, so widening the looked-up handler to
  // the full request union is sound.
  const handler = QUERY_HANDLERS[request.kind] as (
    context: SpatialQueryContext,
    request: SpatialQueryRequest,
  ) => SpatialQueryResult;
  return handler(context, request);
}

function executeQuery(
  context: SpatialQueryContext,
  rawRequest: unknown,
): SpatialQueryResult {
  const validated = validateSpatialQueryRequest(rawRequest);
  if (!validated.ok) return invalidQueryResult(context, validated.detail);
  return dispatch(context, validated.request);
}

/**
 * Validate and execute one query. `rawRequest` is intentionally `unknown`: the
 * runtime boundary must reject malformed host input with a structured problem.
 */
export function runSpatialQuery(
  sources: SpatialQuerySources,
  rawRequest: unknown,
  options: SpatialQueryOptions = {},
): SpatialQueryResult {
  return executeQuery(makeContext(sources, options), rawRequest);
}

export function createSpatialQueryPort(
  sources: SpatialQuerySources,
  options: SpatialQueryOptions = {},
): SpatialQueryPort {
  // Resolve/validate construction-time state once; each call still validates
  // the request itself.
  const context = makeContext(sources, options);
  return {
    query: (request: SpatialQueryRequest): SpatialQueryResult =>
      executeQuery(context, request),
  };
}

/**
 * Build the minimal production query composition: voxel state plus semantic
 * facts, with no legacy FragmentStore/TopologyStore placeholder.
 *
 * The returned port answers cells and the facts-backed semantic kinds. Legacy
 * route/topology kinds are reported as `unsupported` by the dispatch boundary;
 * nothing falls back to an implicitly-created historical store.
 */
export function createVoxelFactsQueryPort(options: VoxelFactsQueryOptions): SpatialQueryPort {
  const { worldId, voxel, facts } = options;
  if (voxel.worldId !== worldId) {
    throw new Error(`voxel worldId "${voxel.worldId}" does not match query world "${worldId}"`);
  }
  const unavailable = (reason: string): SpatialMemoryCapabilities =>
    Object.fromEntries(
      SPATIAL_MEMORY_CAPABILITY_NAMES.map((name) => [name, { available: false, reason }]),
    ) as SpatialMemoryCapabilities;
  const memoryCapabilities = (): SpatialMemoryCapabilities => ({
    ...unavailable('not part of the voxel+facts query composition; no legacy route/topology store'),
    observe: voxel.observe === undefined ? { available: false, reason: 'the composed voxel view has no observe entry' } : { available: true },
    observeBatch: voxel.observeBatch === undefined ? { available: false, reason: 'the composed voxel view has no observeBatch entry' } : { available: true },
    beginSession: voxel.beginSession === undefined ? { available: false, reason: 'the composed voxel view has no beginSession entry' } : { available: true },
    markStale: voxel.markStale === undefined ? { available: false, reason: 'the composed voxel view has no markStale entry' } : { available: true },
    sectionAt: voxel.sectionAt === undefined ? { available: false, reason: 'the composed voxel view has no sectionAt entry' } : { available: true },
    markTraversed: voxel.markTraversed === undefined ? { available: false, reason: 'the composed voxel view has no markTraversed entry' } : { available: true },
    markModified: voxel.markModified === undefined ? { available: false, reason: 'the composed voxel view has no markModified entry' } : { available: true },
    subscribeChanges: voxel.subscribeChanges === undefined ? { available: false, reason: 'the composed voxel view has no subscribeChanges entry' } : { available: true },
    query: { available: true },
  });
  const snapshot = (): SpatialMemoryStoreSnapshot => {
    const residency = voxel.residentSize();
    const pins = voxel.pinState();
    return {
      worldId,
      voxel: {
        saveRevision: voxel.saveRevision,
        residentSections: residency.sections,
        residentBytes: residency.bytes,
        pinLeases: pins.leases,
        pinnedSections: pins.pinnedSections,
      },
      facts: {
        revision: facts.revision,
        places: facts.places({ limit: 1 }).total,
        resources: facts.resources({ limit: 1 }).total,
        containers: facts.containers({ limit: 1 }).total,
      },
      capabilities: memoryCapabilities(),
    };
  };
  return createSpatialQueryPort({
    worldId,
    facts,
    currentSessionId: () => voxel.sessionId,
    cellAt: (dim, x, y, z) => voxel.cellAt(dim, x, y, z),
    residencyAt: (dim, x, y, z) => {
      const { cx, cz, sy } = blockToSection(x, y, z);
      return voxel.sectionResidency({ worldId, dim, cx, cz, sy }).residency;
    },
    snapshot,
    memoryCapabilities,
  }, options.query);
}
