/**
 * Bounded paging for list queries (contract §5.6, plan M2.3).
 *
 * The composed stores expose pages of at most `maxQueryBatch` items (default
 * 100) and silently clamp a larger `limit`. The query contract instead accepts
 * up to 1000 and must not silently truncate. `collectQueryPages` bridges the
 * two: it joins as many store pages as needed to satisfy the requested limit,
 * with an upper bound of `limit` page calls even if a page returns one item.
 *
 * Paging never drains beyond the requested page. `containerAnchors` is the one
 * documented exception: a host classifier has no index, so `anchors.ts` scans
 * the in-memory node store to get an exact total, then pages the matches here.
 */

import type { PortalEdgeView } from '../topology/index.js';

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

export interface QueryPage<T> {
  items: T[];
  total: number;
  nextAfter?: string;
}

export function resolveLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_QUERY_LIMIT;
}

/**
 * Join consecutive exclusive-cursor pages until `limit` items are collected or
 * the source is exhausted. `total` comes from the first page: it is the
 * filter match count, independent of page size. `nextAfter` is the last
 * returned id and only appears when more matching items remain.
 */
export function collectQueryPages<T extends { id: string }>(
  fetch: (after: string | undefined, limit: number) => QueryPage<T>,
  after: string | undefined,
  limit: number,
): QueryPage<T> {
  const items: T[] = [];
  let cursor = after;
  let total = 0;
  let firstPage = true;

  for (;;) {
    const remaining = limit - items.length;
    if (remaining <= 0) break;

    const page = fetch(cursor, remaining);
    if (firstPage) {
      total = page.total;
      firstPage = false;
    }
    if (page.items.length === 0) {
      cursor = undefined;
      break;
    }

    const taken = page.items.slice(0, remaining);
    items.push(...taken);
    if (taken.length < page.items.length) {
      // A source returned more than requested; the last taken id is the cursor.
      cursor = taken[taken.length - 1]?.id;
      break;
    }
    if (page.nextAfter === undefined) {
      cursor = undefined;
      break;
    }
    cursor = page.nextAfter;
    if (items.length >= limit) break;
  }

  const last = items[items.length - 1];
  const nextAfter = cursor === undefined || last === undefined ? undefined : last.id;
  return {
    items,
    total,
    ...(nextAfter === undefined ? {} : { nextAfter }),
  };
}

/**
 * Page an already id-sorted collection with an exclusive cursor. Used where the
 * source has no cursor of its own (portal edges) or where a host predicate
 * requires collecting matches before paging (container anchors).
 */
export function pageSortedById<T extends { id: string }>(
  sorted: readonly T[],
  after: string | undefined,
  limit: number,
): QueryPage<T> {
  const start = after === undefined ? 0 : sorted.findIndex((item) => item.id > after);
  const from = start === -1 ? sorted.length : start;
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  const nextAfter = from + items.length < sorted.length && last !== undefined ? last.id : undefined;
  return {
    items,
    total: sorted.length,
    ...(nextAfter === undefined ? {} : { nextAfter }),
  };
}

/**
 * Stable id-ordered paging for portal edges. The topology store returns them
 * in insertion order with no cursor or total, so the query layer owns the
 * deterministic projection.
 */
export function pagePortalEdges(
  edges: readonly PortalEdgeView[],
  after: string | undefined,
  limit: number,
): QueryPage<PortalEdgeView> {
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pageSortedById(sorted, after, limit);
}
