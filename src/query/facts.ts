import type { SemanticFact, FactPage, FactQuery } from '../facts/types.js';
import type { SpatialNode } from '../topology/graph.js';
import { pagedQueryResult } from './topology.js';
import { unsupportedQueryResult } from './envelope.js';
import { resolveLimit } from './paging.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

/** Read-only compatibility projection; it does not create topology nodes. */
export function queryFacts(
  context: SpatialQueryContext,
  request: Extract<SpatialQueryRequest, { kind: 'nodes' | 'resourceAnchors' | 'containerAnchors' }>,
): SpatialQueryResult {
  const facts = context.sources.facts;
  if (facts === undefined) {
    return unsupportedQueryResult(context, request.kind, 'no semantic fact store is composed into this query port', request.dim);
  }
  const readers: ((query: FactQuery) => FactPage<SemanticFact>)[] = request.kind === 'resourceAnchors'
    ? [query => facts.resources(query)]
    : request.kind === 'containerAnchors'
      ? [query => facts.containers(query)]
      : [query => facts.places(query), query => facts.resources(query), query => facts.containers(query)];
  const nodes: SpatialNode[] = [];
  for (const read of readers) {
    let after: string | undefined;
    do {
      const page = read({ worldId: context.worldId, dim: request.dim, includeGone: true, after, limit: 1000 });
      for (const fact of page.items) {
        const resource = 'sourceCell' in fact;
        const container = 'externalRef' in fact;
        const gone = resource ? fact.revoked : fact.gone;
        if (gone && !(request.kind === 'resourceAnchors' && request.includeGone === true)) continue;
        const location = resource ? { kind: 'exact' as const, pos: fact.sourceCell }
          : container ? { kind: 'exact' as const, pos: fact.pos }
            : fact.location.kind === 'area'
              ? { ...fact.location, kind: 'region' as const } : fact.location;
        const tag = resource ? 'resource' : container ? 'discovery'
          : fact.kind === 'base' || fact.kind === 'death' || fact.kind === 'portal' ? fact.kind
            : fact.kind === 'hazard' ? 'danger' : 'discovery';
        const node: SpatialNode = {
          id: fact.id, worldId: fact.worldId, dim: fact.dim, kind: 'place',
          source: fact.source.source === 'agent' ? 'agent' : 'program', tag,
          label: container ? fact.externalRef : fact.label,
          location, observedAt: fact.observedAt, gone,
          ...(container ? { externalRef: fact.externalRef } : {}),
          metadata: { factKind: resource ? 'resource' : container ? 'container' : 'place',
            provenance: { source: fact.source.source,
              ...(fact.source.sessionId === undefined ? {} : { sessionId: fact.source.sessionId }),
              ...(fact.source.observationIds === undefined ? {} : { observationIds: [...fact.source.observationIds] }) } },
        };
        if ('tag' in request && request.tag !== undefined && node.tag !== request.tag) continue;
        if ('label' in request && request.label !== undefined && node.label !== request.label) continue;
        if ('source' in request && request.source !== undefined && node.source !== request.source) continue;
        nodes.push(node);
      }
      after = page.nextAfter;
    } while (after !== undefined);
  }
  nodes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const remaining = request.after === undefined ? nodes : nodes.filter(node => node.id > request.after!);
  const items = remaining.slice(0, resolveLimit(request.limit));
  const nextAfter = remaining.length > items.length ? items.at(-1)?.id : undefined;
  return pagedQueryResult(context, request.kind, { items, total: nodes.length, ...(nextAfter === undefined ? {} : { nextAfter }) }, request.dim);
}
