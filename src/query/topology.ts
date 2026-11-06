/**
 * Paged topology queries (contract §5.2/§5.6, plan M2.3).
 *
 * Wraps the existing id-ordered, exclusive-cursor pages of `FragmentStore` and
 * `TopologyStore`. It does not call the `SpatialMemoryStore` facade methods that
 * drain every page (`fragments`, `graph`, `edgesDetailed`).
 */

import { makeQueryResult } from './envelope.js';
import { collectQueryPages, pagePortalEdges, resolveLimit } from './paging.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

export type TopologyQuery = Extract<
  SpatialQueryRequest,
  { kind: 'fragments' | 'traversals' | 'nodes' | 'edges' | 'portals' }
>;

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
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'fragments', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
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
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'traversals', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
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
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'nodes', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
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
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'edges', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
    }
    case 'portals': {
      const page = pagePortalEdges(
        context.sources.topology.portalEdges(),
        request.after,
        limit,
      );
      return makeQueryResult(context, {
        status: 'ok',
        data: { kind: 'portals', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
    }
  }
}
