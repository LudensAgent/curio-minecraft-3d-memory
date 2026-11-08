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
import { queryFrontiers } from './frontiers.js';
import { queryHistory } from './history.js';
import { queryTopology } from './topology.js';
import { validateSpatialQueryRequest } from './validate.js';
import type {
  SpatialQueryContext,
  SpatialQueryKind,
  SpatialQueryOptions,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  SpatialQuerySources,
} from './types.js';

export type {
  CellQueryView,
  FrontierBoundaryDirection,
  FrontierCandidateQueryView,
  FrontierQueryData,
  FrontierQuerySource,
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
