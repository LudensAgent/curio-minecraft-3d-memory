/**
 * Historical route, anchor, and component queries (contract §5.4/§5.6,
 * plan M2.4).
 *
 * These are projections of recorded historical geometry. They never start
 * movement, an executor, or a search, and they never claim current passability.
 */

import { makeQueryResult } from './envelope.js';
import type { SpatialQueryContext, SpatialQueryRequest, SpatialQueryResult } from './types.js';

export type HistoryQuery = Extract<
  SpatialQueryRequest,
  { kind: 'historyRoute' | 'anchor' | 'components' | 'segments' }
>;

export function queryHistory(
  context: SpatialQueryContext,
  request: HistoryQuery,
): SpatialQueryResult {
  switch (request.kind) {
    case 'historyRoute': {
      // The store's detailed inspection already reports endpoint snapping,
      // gaps, and the historicalGeometry/executable/currentPassability flags.
      const inspection = context.sources.history.routeInspection(
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
      const options = request.near === undefined ? {} : { near: request.near };
      // `null` means no exact anchor was found near `here`; it is a valid answer,
      // not a `not_found` problem.
      const anchor =
        request.order === 'surface'
          ? context.sources.history.surfaceAnchor(request.dim, request.here, options)
          : context.sources.history.deepestAnchor(request.dim, request.here, options);
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'anchor', anchor },
      });
    }
    case 'components': {
      // The report's Map is the in-memory result of the read; return it as-is.
      const report = context.sources.history.components(request.dim);
      return makeQueryResult(context, {
        status: 'ok',
        dim: request.dim,
        data: { kind: 'components', report },
      });
    }
    case 'segments': {
      const fragment = context.sources.fragments.getFragment(request.fragmentId);
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
          segments: context.sources.history.segments(request.fragmentId),
        },
      });
    }
  }
}
