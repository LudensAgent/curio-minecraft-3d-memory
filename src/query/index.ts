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
import { invalidQueryResult } from './envelope.js';
import { queryHistory } from './history.js';
import { queryTopology } from './topology.js';
import { validateSpatialQueryRequest } from './validate.js';
import type {
  SpatialQueryContext,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
} from './types.js';

export type {
  CellQueryView,
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
} from './types.js';

function makeContext(
  sources: SpatialQuerySources,
  options: SpatialQueryOptions,
): SpatialQueryContext {
  if (typeof sources.worldId !== 'string' || sources.worldId.length === 0) {
    throw new Error('SpatialQuerySources.worldId must be a non-empty string');
  }
  return {
    sources,
    worldId: sources.worldId,
    now: options.now ?? Date.now,
    ...(options.isContainer === undefined ? {} : { isContainer: options.isContainer }),
  };
}

function dispatch(
  context: SpatialQueryContext,
  request: SpatialQueryRequest,
): SpatialQueryResult {
  switch (request.kind) {
    case 'cells':
      return queryCells(context, request);
    case 'fragments':
    case 'traversals':
    case 'nodes':
    case 'edges':
    case 'portals':
      return queryTopology(context, request);
    case 'historyRoute':
    case 'anchor':
    case 'components':
    case 'segments':
      return queryHistory(context, request);
    case 'resourceAnchors':
    case 'containerAnchors':
    case 'containerContents':
      return queryAnchors(context, request);
    case 'snapshot':
      return querySnapshot(context);
    case 'capabilities':
      return queryCapabilities(context);
  }
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
