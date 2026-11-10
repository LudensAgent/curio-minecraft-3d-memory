import type {
  FactPage,
  FactQuery,
  SemanticFact,
  SemanticFactKind,
} from '../facts/types.js';
import { invalidQueryResult, makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { resolveLimit } from './paging.js';
import type { QueryPage } from './paging.js';
import type {
  SemanticPlaceView,
  SpatialQueryContext,
  SpatialQueryRequest,
  SpatialQueryResult,
} from './types.js';

type FactsQuery = Extract<
  SpatialQueryRequest,
  { kind: 'places' | 'nodes' | 'resourceAnchors' | 'containerAnchors' }
>;

const NODES_CURSOR_PREFIX = 'facts:nodes:v1:';

/**
 * Facts-backed semantic projection. It never creates or reads topology nodes.
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
        'place',
        query => facts.places(query),
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
        ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
      });
    }
    case 'resourceAnchors': {
      const page = pageOneStream(
        'resource',
        query => facts.resources(query),
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
        'container',
        query => facts.containers(query),
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
      // Each kind owns its ids. Keep a cursor for each stream so a page ending
      // on a place cannot skip a resource/container with the same id.
      let afters = [request.after, request.after, request.after];
      if (request.after?.startsWith(NODES_CURSOR_PREFIX)) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(request.after.slice(NODES_CURSOR_PREFIX.length));
        } catch {
          return invalidQueryResult(context, 'invalid facts nodes cursor');
        }
        if (!Array.isArray(decoded) || decoded.length !== 3
          || !decoded.every((value: unknown) => value === null || typeof value === 'string')) {
          return invalidQueryResult(context, 'invalid facts nodes cursor');
        }
        afters = (decoded as (string | null)[]).map(value => value ?? undefined);
      }
      const streams = [
        pageOneStream('place', query => facts.places(query), context.worldId, request.dim, false, afters[0], limit, request.tag, request.label, request.source),
        pageOneStream('resource', query => facts.resources(query), context.worldId, request.dim, false, afters[1], limit, request.tag, request.label, request.source),
        pageOneStream('container', query => facts.containers(query), context.worldId, request.dim, false, afters[2], limit, request.tag, request.label, request.source),
      ];
      return pagedQueryResult(context, 'nodes', mergeIdPages(streams, limit, afters), request.dim);
    }
  }
}

function pagedQueryResult(
  context: SpatialQueryContext,
  kind: 'nodes' | 'resourceAnchors' | 'containerAnchors',
  page: QueryPage<SemanticPlaceView>,
  dim: string | undefined,
): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'ok',
    ...(dim === undefined ? {} : { dim }),
    data: { kind, ...page },
    total: page.total,
    ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
  });
}

/**
 * One id-ordered page over one fact collection, with bounded output.
 *
 * The store applies filters and computes the exact total in one O(N) scan.
 * Only the requested page is cloned/projected; this is not a fixed work budget
 * or a cold-page query, but it avoids rescanning N records for every source page.
 */
function pageOneStream(
  kind: SemanticFactKind,
  read: (query: FactQuery) => FactPage<SemanticFact>,
  worldId: string,
  dim: string | undefined,
  includeGone: boolean,
  after: string | undefined,
  limit: number,
  tag: SemanticPlaceView['tag'] | undefined,
  label: string | undefined,
  source: SemanticPlaceView['source'] | undefined,
): QueryPage<SemanticPlaceView> {
  let placeKinds: FactQuery['placeKinds'];
  if (tag !== undefined) {
    if (kind === 'place') {
      placeKinds = tag === 'base' || tag === 'death' || tag === 'portal' ? [tag]
        : tag === 'danger' ? ['hazard']
          : tag === 'discovery' ? ['place', 'station'] : [];
      if (placeKinds.length === 0) return { items: [], total: 0 };
    } else if (tag !== (kind === 'resource' ? 'resource' : 'discovery')) {
      return { items: [], total: 0 };
    }
  }
  const page = read({
    worldId,
    includeGone,
    ...(dim === undefined ? {} : { dim }),
    ...(after === undefined ? {} : { after }),
    ...(label === undefined ? {} : { label }),
    ...(source === undefined ? {} : { sourceKind: source }),
    ...(placeKinds === undefined ? {} : { placeKinds }),
    limit,
  });
  return {
    items: page.items.map(factToPlaceView),
    total: page.total,
    ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
  };
}

/** Merge already id-sorted, cursor-limited stream pages into one page window. */
function mergeIdPages(
  pages: readonly QueryPage<SemanticPlaceView>[],
  limit: number,
  afters: readonly (string | undefined)[],
): QueryPage<SemanticPlaceView> {
  const items: SemanticPlaceView[] = [];
  const cursors = pages.map(() => 0);
  const nextAfters = [...afters];
  for (;;) {
    let smallest = -1;
    for (let index = 0; index < pages.length; index += 1) {
      const candidate = pages[index]!.items[cursors[index]!];
      if (candidate === undefined) continue;
      const current = smallest === -1 ? undefined : pages[smallest]!.items[cursors[smallest]!];
      if (current === undefined || candidate.id < current.id) smallest = index;
    }
    if (smallest === -1) break;
    const item = pages[smallest]!.items[cursors[smallest]!]!;
    items.push(item);
    nextAfters[smallest] = item.id;
    cursors[smallest] = cursors[smallest]! + 1;
    if (items.length === limit) break;
  }
  const more = pages.some((page, index) => page.nextAfter !== undefined || cursors[index]! < page.items.length);
  return {
    items,
    total: pages.reduce((sum, page) => sum + page.total, 0),
    ...(more && items.length > 0
      ? { nextAfter: NODES_CURSOR_PREFIX + JSON.stringify(nextAfters.map(after => after ?? null)) }
      : {}),
  };
}

/** Project one semantic fact to the compatibility place view. */
function factToPlaceView(fact: SemanticFact): SemanticPlaceView {
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
