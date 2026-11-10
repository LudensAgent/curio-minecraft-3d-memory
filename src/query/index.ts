/**
 * Read-only query port (contract §5).
 *
 * `runSpatialQuery` validates the raw request once, resolves the query context,
 * and dispatches to a handler. The request union is voxel + facts only: there
 * is no fragment/topology/route handler and no fallback to a removed store.
 *
 * This module is memory-core only: it has no runtime import of navigation,
 * execution, adapter body ports, or a store implementation. The caller injects
 * a narrow `SpatialQuerySources` view.
 */

import { buildMemoryHostCapabilities, queryCapabilities, querySnapshot } from './capabilities.js';
import { queryCells } from './cells.js';
import { invalidQueryResult, makeQueryResult } from './envelope.js';
import { queryFacts } from './facts.js';
import { validateSpatialQueryRequest } from './validate.js';
import { blockToSection } from '../voxel/coordinates.js';
import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import type {
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
  SemanticPlaceLocation,
  SemanticPlaceSource,
  SemanticPlaceTag,
  SemanticPlaceView,
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
  return {
    sources,
    worldId: sources.worldId,
    now: options.now ?? Date.now,
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
function queryContainerContents(
  context: SpatialQueryContext,
  request: Extract<SpatialQueryRequest, { kind: 'containerContents' }>,
): SpatialQueryResult {
  // Never an empty list: an empty inventory is a host ledger fact this library
  // cannot verify. `dim` is echoed but does not change the answer.
  return makeQueryResult(context, {
    status: 'unsupported',
    ...(request.dim === undefined ? {} : { dim: request.dim }),
    problem: {
      kind: 'host_ledger',
      detail:
        'container contents are owned by the host precise inventory ledger; ' +
        'the spatial library stores location/reachability evidence only',
    },
  });
}

const QUERY_HANDLERS: { [K in SpatialQueryKind]: QueryHandler<K> } = {
  cells: queryCells,
  nodes: queryFacts,
  places: queryFacts,
  resourceAnchors: queryFacts,
  containerAnchors: queryFacts,
  containerContents: queryContainerContents,
  snapshot: querySnapshot,
  capabilities: queryCapabilities,
};

function dispatch(
  context: SpatialQueryContext,
  request: SpatialQueryRequest,
): SpatialQueryResult {
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
 * facts. The returned port answers cells and the facts-backed semantic kinds;
 * nothing falls back to an implicitly-created historical store.
 */
export function createVoxelFactsQueryPort(options: VoxelFactsQueryOptions): SpatialQueryPort {
  const { worldId, voxel, facts } = options;
  if (voxel.worldId !== worldId) {
    throw new Error(`voxel worldId "${voxel.worldId}" does not match query world "${worldId}"`);
  }
  const memoryCapabilities = (): MemoryHostCapabilities['memory'] => ({
    observeBatch: voxel.observeBatch !== undefined,
    beginSession: voxel.beginSession !== undefined,
    markStale: voxel.markStale !== undefined,
    markTraversed: voxel.markTraversed !== undefined,
    markModified: voxel.markModified !== undefined,
    // Persistence lifecycle belongs to the session channel, not this view.
    checkpoint: false,
    flush: false,
    close: false,
  });
  const sources: SpatialQuerySources = {
    worldId,
    facts,
    currentSessionId: () => voxel.sessionId,
    cellAt: (dim, x, y, z) => voxel.cellAt(dim, x, y, z),
    residencyAt: (dim, x, y, z) => {
      const { cx, cz, sy } = blockToSection(x, y, z);
      return voxel.sectionResidency({ worldId, dim, cx, cz, sy }).residency;
    },
    snapshot: (): SpatialMemoryStoreSnapshot => {
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
          // The shared in-memory store may hold other worlds; a snapshot is
          // scoped to this query port's world.
          places: facts.places({ worldId, limit: 1 }).total,
          resources: facts.resources({ worldId, limit: 1 }).total,
          containers: facts.containers({ worldId, limit: 1 }).total,
        },
        capabilities: buildMemoryHostCapabilities({ sources, worldId, now: Date.now }),
      };
    },
    memoryCapabilities,
  };
  return createSpatialQueryPort(sources, options.query);
}
