/**
 * Historical route, anchor, and component queries (contract §5.4/§5.6,
 * plan M2.4).
 *
 * These are projections of recorded historical geometry. They never start
 * movement, an executor, or a search, and they never claim current passability.
 */

import type { ComponentReport } from '../topology/index.js';
import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { MAX_QUERY_LIMIT } from './paging.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

export type HistoryQuery = Extract<
  SpatialQueryRequest,
  { kind: 'historyRoute' | 'anchor' | 'components' | 'segments' }
>;

/**
 * Join read-only pages until the source is exhausted. The underlying stores
 * clamp each page to their own batch limit, so the cursor — not the requested
 * size — drives termination. The page count is bounded by the first page's
 * match total, so a stalled cursor cannot loop forever, and the stores are in
 * turn capacity-bounded.
 */
function collectAll<T>(
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
 * Rebuild the dimension's node components from paged, read-only node and edge
 * lists. This deliberately does not call the store's cached `components`
 * projection: a query must not write the write-side component cache or its
 * counters. Connectivity still comes only from `traversed` edges whose two
 * endpoints exist and belong to the requested dimension.
 */
function computeComponents(
  context: SpatialQueryContext,
  topology: NonNullable<SpatialQueryContext['sources']['topology']>,
  dim: string,
): ComponentReport {
  const nodes = collectAll((after, limit) =>
    topology.nodes({ dim, after, limit }),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  const edges = collectAll((after, limit) =>
    topology.edges({ dim, basis: 'traversed', after, limit }),
  );
  for (const edge of edges) {
    // A traversed edge only connects two nodes of this dimension when both
    // endpoints are present in the dimension's node set.
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    adjacency.get(edge.to)!.push(edge.from);
  }
  // Start from the smallest unvisited id so groups are ordered by first node
  // and every outcome is independent of page or insertion order.
  const assignment = new Map<string, number>();
  const groups: string[][] = [];
  for (const start of [...nodeIds].sort()) {
    if (assignment.has(start)) continue;
    const index = groups.length;
    const group: string[] = [];
    const queue = [start];
    assignment.set(start, index);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor]!;
      group.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (assignment.has(neighbor)) continue;
        assignment.set(neighbor, index);
        queue.push(neighbor);
      }
    }
    groups.push(group.sort());
  }
  // Match `TopologyStore.components`: groups are ordered by their first node
  // using locale collation, not the default code-unit order used above.
  groups.sort((a, b) => a[0]!.localeCompare(b[0]!));
  const byNode = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group) byNode.set(id, index);
  });
  // A pure query recomputes the whole dimension every time; consecutive calls
  // therefore report the same count.
  return { components: groups.length, groups, byNode, recomputedNodes: nodes.length };
}

const LEGACY_STORES_ABSENT =
  'this query composition has no legacy fragment/topology stores; ' +
  'use facts for semantic places/anchors and voxel cells for geometry';

export function queryHistory(
  context: SpatialQueryContext,
  request: HistoryQuery,
): SpatialQueryResult {
  const history = context.sources.history;
  const fragments = context.sources.fragments;
  const topology = context.sources.topology;
  switch (request.kind) {
    case 'historyRoute': {
      if (history === undefined) {
        return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT, request.dim);
      }
      // The store's detailed inspection already reports endpoint snapping,
      // gaps, and the historicalGeometry/executable/currentPassability flags.
      const inspection = history.routeInspection(
        request.dim,
        request.from,
        request.to,
        request.near === undefined ? {} : { near: request.near },
      );
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'historyRoute', inspection },
      });
    }
    case 'anchor': {
      if (history === undefined) {
        return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT, request.dim);
      }
      const options = request.near === undefined ? {} : { near: request.near };
      // `null` means no exact anchor was found near `here`; it is a valid answer,
      // not a `not_found` problem.
      const anchor =
        request.order === 'surface'
          ? history.surfaceAnchor(request.dim, request.here, options)
          : history.deepestAnchor(request.dim, request.here, options);
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'anchor', anchor },
      });
    }
    case 'components': {
      if (topology === undefined) {
        return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT, request.dim);
      }
      // Computed from read-only list pages so the query never mutates the
      // store's derived component cache.
      const report = computeComponents(context, topology, request.dim);
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'components', report },
      });
    }
    case 'segments': {
      if (fragments === undefined || history === undefined) {
        return unsupportedQueryResult(context, request.kind, LEGACY_STORES_ABSENT);
      }
      const fragment = fragments.getFragment(request.fragmentId);
      if (fragment === null) {
        return makeQueryResult(context, {
          status: 'not_found',
          problem: {
            kind: 'not_found',
            detail: `no fragment "${request.fragmentId}" is recorded in this world`,
          },
        });
      }
      // Pieces derived from recorded edge verification; unrecorded links are
      // not cut, so this is not a proof of current passability. The fragment
      // history itself is never deleted or rewritten.
      return makeQueryResult(context, {
        status: 'ok',
        dim: fragment.dim,
        data: {
          kind: 'segments',
          segments: history.segments(request.fragmentId),
        },
      });
    }
  }
}
