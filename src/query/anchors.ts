/**
 * Resource and container anchor queries (contract §5.4/§5.5, plan M2.5).
 *
 * The library stores positions, identities, and observation times. It never
 * stores inventory contents. A contents request always returns the structured
 * `host_ledger` boundary; an empty list would falsely read as an empty chest.
 */

import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { collectQueryPages, pageSortedById, resolveLimit } from './paging.js';
import type { SpatialNode } from '../topology/index.js';
import { pagedQueryResult } from './topology.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

export type AnchorQuery = Extract<
  SpatialQueryRequest,
  { kind: 'resourceAnchors' | 'containerAnchors' | 'containerContents' }
>;

/**
 * `containerAnchors` has no classifier index, so it scans node pages. The scan
 * is bounded by the topology store's own node capacity; a fixed query budget
 * would make the exclusive cursor silently skip matches beyond the prefix.
 */
const CONTAINER_SCAN_PAGE_SIZE = 1000;

const NO_CLASSIFIER_DETAIL =
  'container identification is host-owned; pass isContainer to classify recorded nodes ' +
  'as containers (labels and metadata are opaque to the library)';

const CONTAINER_CONTENTS_DETAIL =
  'container contents are owned by the host precise inventory ledger; ' +
  'the spatial library stores location/reachability evidence only';

export function queryAnchors(
  context: SpatialQueryContext,
  request: AnchorQuery,
): SpatialQueryResult {
  switch (request.kind) {
    case 'resourceAnchors':
      return queryResourceAnchors(context, request);
    case 'containerAnchors':
      return queryContainerAnchors(context, request);
    case 'containerContents':
      return queryContainerContents(context, request);
  }
}

function queryResourceAnchors(
  context: SpatialQueryContext,
  request: Extract<AnchorQuery, { kind: 'resourceAnchors' }>,
): SpatialQueryResult {
  const page = collectQueryPages<SpatialNode>(
    (after, limit) =>
      context.sources.topology.nodes({
        ...(request.dim === undefined ? {} : { dim: request.dim }),
        ...(request.tag === undefined ? {} : { tag: request.tag }),
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(after === undefined ? {} : { after }),
        limit,
      }),
    request.after,
    resolveLimit(request.limit),
  );
  return pagedQueryResult(context, 'resourceAnchors', page, request.dim);
}

function queryContainerAnchors(
  context: SpatialQueryContext,
  request: Extract<AnchorQuery, { kind: 'containerAnchors' }>,
): SpatialQueryResult {
  const isContainer = context.isContainer;
  if (isContainer === undefined) {
    return unsupportedQueryResult(
      context,
      'containerAnchors',
      NO_CLASSIFIER_DETAIL,
      request.dim,
    );
  }

  // The host classifier has no index: scan node pages in id order until the
  // store is exhausted. Only exact locations are precise container targets;
  // region centers are never promoted to exact coordinates. The topology store
  // bounds the node count, so the scan (and the resulting exact total) is
  // finite. Frequent calls on a large node set are an M8 benchmark candidate.
  const matches: SpatialNode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = context.sources.topology.nodes({
      ...(request.dim === undefined ? {} : { dim: request.dim }),
      ...(cursor === undefined ? {} : { after: cursor }),
      limit: CONTAINER_SCAN_PAGE_SIZE,
    });
    for (const node of page.items) {
      if (node.location.kind === 'exact' && isContainer(node)) matches.push(node);
    }
    if (page.nextAfter === undefined) break;
    cursor = page.nextAfter;
  }

  // Matches are already id-ordered by the source pages; the request cursor and
  // limit page the collected result without reordering it.
  const page = pageSortedById(matches, request.after, resolveLimit(request.limit));
  return pagedQueryResult(context, 'containerAnchors', page, request.dim);
}

function queryContainerContents(
  context: SpatialQueryContext,
  request: Extract<AnchorQuery, { kind: 'containerContents' }>,
): SpatialQueryResult {
  // Never an empty list: an empty inventory is a host ledger fact this library
  // cannot verify. `dim`/`nodeId` scope the request but do not change the answer.
  return makeQueryResult(context, {
    status: 'unsupported',
    ...(request.dim === undefined ? {} : { dim: request.dim }),
    problem: { kind: 'host_ledger', detail: CONTAINER_CONTENTS_DETAIL },
  });
}
