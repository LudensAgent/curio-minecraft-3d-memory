/**
 * `cells` query handler (contract §5.2/§5.4, plan M2.2).
 *
 * Reads individual cell evidence without copying a whole Section and without
 * loading, pinning, or refreshing anything. `observed:false` never means air:
 * it means the store has no observation for that cell right now. A section
 * that is recorded but not resident is reported as a `gap` with reason
 * `unloaded`, never as an empty cell.
 */

import type { ObservationGap } from '../observation/types.js';
import type { SectionResidency } from '../voxel/index.js';
import { makeQueryResult } from './envelope.js';
import type {
  CellQueryView,
  SpatialQueryContext,
  SpatialQueryRequest,
  SpatialQueryResult,
} from './types.js';

/** Residency states that mean "a record exists but its cells are not readable now". */
const UNREADABLE_RESIDENCY: ReadonlySet<SectionResidency> = new Set([
  'not_resident',
  'loading',
  'load_failed',
]);

export function queryCells(
  context: SpatialQueryContext,
  request: Extract<SpatialQueryRequest, { kind: 'cells' }>,
): SpatialQueryResult {
  const cells: CellQueryView[] = [];
  const gaps: ObservationGap[] = [];

  for (const requested of request.positions) {
    const pos = { x: requested.x, y: requested.y, z: requested.z };
    const residency = context.sources.residencyAt(request.dim, pos.x, pos.y, pos.z);
    const cell = context.sources.cellAt(request.dim, pos.x, pos.y, pos.z);

    if (cell.observed) {
      const evidence = cell.evidence;
      const observation = evidence.observation;
      cells.push({
        pos,
        observed: true,
        // Fresh copies: a caller mutating the projection can never touch the store.
        state: {
          name: observation.state.name,
          properties: { ...observation.state.properties },
        },
        stateComplete: observation.stateComplete,
        evidence: observation.evidence,
        freshness: evidence.freshness,
        validUntil: evidence.validUntil,
        ...(evidence.staleReason === undefined ? {} : { staleReason: evidence.staleReason }),
      });
      continue;
    }

    if (UNREADABLE_RESIDENCY.has(residency)) {
      // Separate objects so the view's gap and the collected gap are independent.
      cells.push({
        pos,
        observed: false,
        residency,
        gap: { pos: { ...pos }, reason: 'unloaded' },
      });
      gaps.push({ pos: { ...pos }, reason: 'unloaded' });
      continue;
    }

    // `no_record`, or resident but this particular cell was never observed.
    cells.push({
      pos,
      observed: false,
      residency,
      unobservedReason: residency === 'no_record' ? 'no_record' : 'resident',
    });
  }

  return makeQueryResult(context, {
    status: gaps.length > 0 ? 'partial' : 'ok',
    dim: request.dim,
    data: { kind: 'cells', cells, gaps },
  });
}
