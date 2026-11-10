import type { SemanticFact, FactPage, FactQuery } from '../facts/types.js';
import type { SpatialNode } from '../topology/graph.js';
import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { resolveLimit } from './paging.js';
import type { QueryPage } from './paging.js';
import { pagedQueryResult } from './topology.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

type FactsQuery = Extract<
  SpatialQueryRequest,
  { kind: 'places' | 'nodes' | 'resourceAnchors' | 'containerAnchors' }
>;

const FACT_SCAN_PAGE_SIZE = 1000;

/**
 * Read-only compatibility projection; it does not create topology nodes.
 *
 * Every list is paged from the facts store with its own exclusive cursor. The
 * query layer never loads all records, sorts them, and slices: `nodes` merges
 * three already id-ordered streams page by page.
 */
export function queryFacts(
  context: SpatialQueryContext,
  request: FactsQuery,
): SpatialQueryResult {
  const facts = context.sources.facts;
  if (facts === undefined) {
    return unsupportedQueryResult(context, request.kind, 'no semantic fact store is composed into this query port', request.dim);
  }
  switch (request.kind) {
    case 'places': {
      const page = pageOneStream(
        query => facts.places(query),
        fact => factToNode(fact),
        context.worldId,
        request.dim,
        request.includeGone === true,
        request.after,
        resolveLimit(request.limit),
        request.tag,
        request.label,
        request.source,
      );
      return makeQueryResult(context, {
        status: 'ok',
        ...(request.dim === undefined ? {} : { dim: request.dim }),
        data: { kind: 'places', pageSource: 'memory', ...page },
        total: page.total,
        nextAfter: page.nextAfter,
      });
    }
    case 'resourceAnchors': {
      const page = pageOneStream(
        query => facts.resources(query),
        fact => factToNode(fact),
        context.worldId,
        request.dim,
        request.includeGone === true,
        request.after,
        resolveLimit(request.limit),
        request.tag,
        request.label,
        undefined,
      );
      return pagedQueryResult(context, 'resourceAnchors', page, request.dim);
    }
    case 'containerAnchors': {
      const page = pageOneStream(
        query => facts.containers(query),
        fact => factToNode(fact),
        context.worldId,
        request.dim,
        false,
        request.after,
        resolveLimit(request.limit),
        undefined,
        undefined,
        undefined,
      );
      return pagedQueryResult(context, 'containerAnchors', page, request.dim);
    }
    case 'nodes': {
      const limit = resolveLimit(request.limit);
      const streams = [
        pageOneStream(query => facts.places(query), fact => factToNode(fact), context.worldId, request.dim, false, request.after, limit, request.tag, request.label, request.source),
        pageOneStream(query => facts.resources(query), fact => factToNode(fact), context.worldId, request.dim, false, request.after, limit, request.tag, request.label, request.source),
        pageOneStream(query => facts.containers(query), fact => factToNode(fact), context.worldId, request.dim, false, request.after, limit, request.tag, request.label, request.source),
      ];
      return pagedQueryResult(context, 'nodes', mergeIdPages(streams, limit), request.dim);
    }
  }
}

/**
 * One bounded, id-ordered page over one fact collection.
 *
 * Without tag/label/source filters the store's own `total` and `nextAfter` are
 * exact. With filters, the store cannot count them without projecting every
 * record; the scan still reads one bounded page at a time and keeps only the
 * requested window in memory. It never materializes and sorts the collection.
 */
function pageOneStream(
  read: (query: FactQuery) => FactPage<SemanticFact>,
  project: (fact: SemanticFact) => SpatialNode,
  worldId: string,
  dim: string | undefined,
  includeGone: boolean,
  after: string | undefined,
  limit: number,
  tag: SpatialNode['tag'] | undefined,
  label: string | undefined,
  source: SpatialNode['source'] | undefined,
): QueryPage<SpatialNode> {
  const filtered = tag !== undefined || label !== undefined || source !== undefined;
  const base: FactQuery = {
    worldId,
    includeGone,
    ...(dim === undefined ? {} : { dim }),
  };

  if (!filtered) {
    const page = read({ ...base, ...(after === undefined ? {} : { after }), limit });
    return {
      items: page.items.map(project),
      total: page.total,
      ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
    };
  }

  const matches = (node: SpatialNode): boolean =>
    (tag === undefined || node.tag === tag)
    && (label === undefined || node.label === label)
    && (source === undefined || node.source === source);

  const items: SpatialNode[] = [];
  let total = 0;
  let more = false;
  let cursor: string | undefined;
  for (;;) {
    const page = read({
      ...base,
      ...(cursor === undefined ? {} : { after: cursor }),
      limit: FACT_SCAN_PAGE_SIZE,
      // The scan needs a cursor-stable view of the whole collection; hiding
      // gone records here would also hide them from the exact filter count.
      includeGone: true,
    });
    for (const fact of page.items) {
      const node = project(fact);
      if (!includeGone && node.gone) continue;
      if (!matches(node)) continue;
      total += 1;
      if (after !== undefined && node.id <= after) continue;
      if (items.length < limit) items.push(node);
      else more = true;
    }
    if (page.nextAfter === undefined) break;
    cursor = page.nextAfter;
  }
  const last = items.at(-1);
  return { items, total, ...(more && last !== undefined ? { nextAfter: last.id } : {}) };
}

/** Merge already id-sorted, cursor-limited stream pages into one page window. */
function mergeIdPages(pages: readonly QueryPage<SpatialNode>[], limit: number): QueryPage<SpatialNode> {
  const items: SpatialNode[] = [];
  const cursors = pages.map(() => 0);
  for (;;) {
    let smallest = -1;
    for (let index = 0; index < pages.length; index += 1) {
      const candidate = pages[index]!.items[cursors[index]!];
      if (candidate === undefined) continue;
      const current = smallest === -1 ? undefined : pages[smallest]!.items[cursors[smallest]!];
      if (current === undefined || candidate.id < current.id) smallest = index;
    }
    if (smallest === -1) break;
    items.push(pages[smallest]!.items[cursors[smallest]!]!);
    cursors[smallest] = cursors[smallest]! + 1;
    if (items.length === limit) break;
  }
  const more = pages.some((page, index) => page.nextAfter !== undefined || cursors[index]! < page.items.length);
  const last = items.at(-1);
  return {
    items,
    total: pages.reduce((sum, page) => sum + page.total, 0),
    ...(more && last !== undefined ? { nextAfter: last.id } : {}),
  };
}

/** Project one semantic fact to the compatibility `SpatialNode` view. */
function factToNode(fact: SemanticFact): SpatialNode {
  const resource = 'sourceCell' in fact;
  const container = 'externalRef' in fact;
  const gone = resource ? fact.revoked : fact.gone;
  const location = resource ? { kind: 'exact' as const, pos: fact.sourceCell }
    : container ? { kind: 'exact' as const, pos: fact.pos }
      : fact.location.kind === 'area'
        ? { ...fact.location, kind: 'region' as const } : fact.location;
  const tag = resource ? 'resource' : container ? 'discovery'
    : fact.kind === 'base' || fact.kind === 'death' || fact.kind === 'portal' ? fact.kind
      : fact.kind === 'hazard' ? 'danger' : 'discovery';
  return {
    id: fact.id,
    worldId: fact.worldId,
    dim: fact.dim,
    kind: 'place',
    source: fact.source.source === 'agent' ? 'agent' : 'program',
    tag,
    label: container ? fact.externalRef : fact.label,
    location,
    observedAt: fact.observedAt,
    gone,
    ...(container ? { externalRef: fact.externalRef } : {}),
    metadata: {
      factKind: resource ? 'resource' : container ? 'container' : 'place',
      // A missing source-cell version is an explicit gap. `null` is not `0`:
      // both the value and its presence are visible to the caller.
      ...(resource
        ? {
            sourceCellVersion: fact.sourceCellVersion ?? null,
            sourceCellVersionKnown: fact.sourceCellVersion !== undefined,
          }
        : {}),
      provenance: {
        source: fact.source.source,
        ...(fact.source.sessionId === undefined ? {} : { sessionId: fact.source.sessionId }),
        ...(fact.source.observationIds === undefined ? {} : { observationIds: [...fact.source.observationIds] }),
      },
    },
  };
}
