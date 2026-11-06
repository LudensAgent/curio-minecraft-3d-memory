/**
 * Paged topology queries (contract §5.2/§5.6, plan M2.3).
 *
 * Wraps the existing id-ordered, exclusive-cursor pages of `FragmentStore` and
 * `TopologyStore`. It does not call the `SpatialMemoryStore` facade methods that
 * drain every page (`fragments`, `graph`, `edgesDetailed`).
 */

import { makeQueryResult } from './envelope.js';
import { collectQueryPages, pagePortalEdges, resolveLimit } from './paging.js';
import type { QueryPage } from './paging.js';
import type {
  SpatialQueryContext,
  SpatialQueryData,
  SpatialQueryKind,
  SpatialQueryRequest,
  SpatialQueryResult,
} from './types.js';

export type TopologyQuery = Extract<
  SpatialQueryRequest,
  { kind: 'fragments' | 'traversals' | 'nodes' | 'edges' | 'portals' }
>;

/** Kinds whose response data is one bounded page window. */
type PagedQueryKind = Extract<
  SpatialQueryKind,
  | 'fragments'
  | 'traversals'
  | 'nodes'
  | 'edges'
  | 'portals'
  | 'resourceAnchors'
  | 'containerAnchors'
>;
type PagedQueryData<K extends PagedQueryKind> = Extract<SpatialQueryData, { kind: K }>;

/**
 * Shared envelope for every paged query kind (topology lists and anchors).
 * `data` is exactly `{ kind, ...page }`; `total`/`nextAfter` mirror the page
 * window on the result envelope.
 */
export function pagedQueryResult<K extends PagedQueryKind>(
  context: SpatialQueryContext,
  kind: K,
  page: QueryPage<PagedQueryData<K>['items'][number]>,
  dim?: string,
): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'ok',
    ...(dim === undefined ? {} : { dim }),
    data: { kind, ...page } as PagedQueryData<K>,
    total: page.total,
    nextAfter: page.nextAfter,
  });
}

export function queryTopology(
  context: SpatialQueryContext,
  request: TopologyQuery,
): SpatialQueryResult {
  const limit = resolveLimit(request.limit);
  switch (request.kind) {
    case 'fragments': {
      const page = collectQueryPages(
        (after, pageLimit) =>
          context.sources.fragments.fragments({
            dim: request.dim,
            kind: request.fragmentKind,
            source: request.geometrySource,
            after,
            limit: pageLimit,
          }),
        request.after,
        limit,
      );
      return pagedQueryResult(context, 'fragments', page, request.dim);
    }
    case 'traversals': {
      const page = collectQueryPages(
        (after, pageLimit) =>
          context.sources.fragments.traversals({
            dim: request.dim,
            fragmentId: request.fragmentId,
            after,
            limit: pageLimit,
          }),
        request.after,
        limit,
      );
      return pagedQueryResult(context, 'traversals', page, request.dim);
    }
    case 'nodes': {
      const page = collectQueryPages(
        (after, pageLimit) =>
          context.sources.topology.nodes({
            dim: request.dim,
            tag: request.tag,
            label: request.label,
            source: request.source,
            after,
            limit: pageLimit,
          }),
        request.after,
        limit,
      );
      return pagedQueryResult(context, 'nodes', page, request.dim);
    }
    case 'edges': {
      const page = collectQueryPages(
        (after, pageLimit) =>
          context.sources.topology.edges({
            dim: request.dim,
            from: request.from,
            to: request.to,
            type: request.type,
            basis: request.basis,
            after,
            limit: pageLimit,
          }),
        request.after,
        limit,
      );
      return pagedQueryResult(context, 'edges', page, request.dim);
    }
    case 'portals': {
      const page = pagePortalEdges(
        context.sources.topology.portalEdges(),
        request.after,
        limit,
      );
      return pagedQueryResult(context, 'portals', page);
    }
  }
}
