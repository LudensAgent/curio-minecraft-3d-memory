/**
 * Read-only frontier query (contract §5, additive kind, D-V4-017).
 *
 * The handler is a projection of a `WalkSearchSnapshot` the caller already ran.
 * It does not start a search, load a Section, refresh evidence, rank candidates,
 * select a target, or claim the boundary cell is passable. When the composition
 * has no `frontierSource` (or the source has no snapshot for this dim/position)
 * the answer is a structured `unsupported`, never an empty "no frontiers" list.
 *
 * `items` contains never-observed boundary candidates only. STALE diagnostics
 * and unavailable saved-section residency are reported as aggregate counts, so
 * stale / not-resident / never-observed stay distinguishable without being
 * misread as air or passability.
 */

import type { Observation } from '../observation/types.js';
import type { FrontierCandidateView } from '../navigation/route-inspection.js';
import type { Vec3Like } from '../types.js';
import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { resolveLimit } from './paging.js';
import type {
  FrontierBoundaryDirection,
  FrontierCandidateQueryView,
  FrontierQueryData,
  SpatialQueryContext,
  SpatialQueryRequest,
  SpatialQueryResult,
} from './types.js';

type FrontierQueryRequest = Extract<SpatialQueryRequest, { kind: 'frontiers' }>;

const NO_SOURCE_DETAIL =
  'frontiers are projected from a caller-supplied WalkSearchSnapshot; ' +
  'this composition has no snapshot source and never starts a search or scans the map';

/** Adjacent points differ by one axis/sign; a non-axis step yields `null`. */
const AXIS_EPSILON = 1e-6;

export function queryFrontiers(
  context: SpatialQueryContext,
  request: FrontierQueryRequest,
): SpatialQueryResult {
  const source = context.sources.frontiers;
  if (source === undefined) {
    return unsupportedQueryResult(context, 'frontiers', NO_SOURCE_DETAIL, request.dim);
  }

  const resolved = source(request.dim, { ...request.here });
  if (resolved.status === 'unavailable') {
    return unsupportedQueryResult(context, 'frontiers', resolved.reason, request.dim);
  }
  if (resolved.status === 'scope_mismatch') {
    return makeQueryResult(context, {
      status: 'scope_mismatch',
      dim: request.dim,
      problem: { kind: 'scope_mismatch', expected: resolved.expected, actual: resolved.actual },
    });
  }

  const projected = resolved.result;
  const snapshot = resolved.snapshot;
  const limit = resolveLimit(request.limit);
  const total = projected.candidates.length;
  const now = context.now();

  // Aggregate counts only: STALE diagnostics and unavailable saved-section
  // residency stay out of `items`, which remains never-observed frontiers only.
  const staleCount = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.status === 'STALE',
  ).length;
  const unavailableHistoricalResidency = {
    not_resident: 0,
    loading: 0,
    load_failed: 0,
  };
  for (const entry of snapshot.unavailableHistorical) {
    for (const section of entry.sections) {
      unavailableHistoricalResidency[section.residency] += 1;
    }
  }

  const data: FrontierQueryData = {
    kind: 'frontiers',
    source: 'walk_search_snapshot',
    scope: {
      worldId: projected.worldId,
      dim: projected.dim,
      sessionId: projected.sessionId,
    },
    snapshotState: projected.state,
    // Snapshot discovery order is preserved: no sort, no rank, no selection.
    items: projected.candidates
      .slice(0, limit)
      .map((candidate) => toView(candidate, request.dim, now)),
    total,
    truncated: total > limit,
    snapshotTruncated: projected.truncated,
    staleCount,
    diagnosticsTruncated: snapshot.counters.diagnosticsTruncated,
    unavailableHistoricalCount: projected.unavailableHistoricalCount,
    unavailableHistoricalTruncated: projected.unavailableHistoricalTruncated,
    unavailableHistoricalResidency,
  };

  return makeQueryResult(context, {
    status: 'ok',
    dim: request.dim,
    data,
    total,
  });
}

function toView(
  candidate: FrontierCandidateView,
  dim: string,
  now: number,
): FrontierCandidateQueryView {
  return {
    id: frontierCandidateId(dim, candidate.pos),
    pos: { ...candidate.pos },
    stance: { ...candidate.stance },
    // The projection only ever proves the approach stance.
    reachability: candidate.reachability,
    boundaryReachability: 'unknown',
    direction: boundaryDirection(candidate.stance, candidate.pos),
    gap: candidate.gap.map((cell) => ({ ...cell })),
    gapCount: candidate.gap.length,
    basis: candidate.basis.map(copyObservation),
    reason: candidate.reason,
    historicalConnection: candidate.historicalConnection,
    computedAt: candidate.computedAt,
    validUntil: candidate.validUntil,
    ageMs: Math.max(0, now - candidate.computedAt),
  };
}

/** Stable across snapshots for the same dimension and boundary cell. */
function frontierCandidateId(dim: string, pos: Vec3Like): string {
  return `frontier:${dim}:${pos.x},${pos.y},${pos.z}`;
}

function boundaryDirection(
  stance: Vec3Like,
  pos: Vec3Like,
): FrontierBoundaryDirection | null {
  const dx = pos.x - stance.x;
  const dz = pos.z - stance.z;
  const onX = Math.abs(dx) > AXIS_EPSILON;
  const onZ = Math.abs(dz) > AXIS_EPSILON;
  if (onX && !onZ) return { axis: 'x', sign: dx > 0 ? 1 : -1 };
  if (onZ && !onX) return { axis: 'z', sign: dz > 0 ? 1 : -1 };
  return null;
}

function copyObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { ...observation.pos },
    state: {
      name: observation.state.name,
      properties: { ...observation.state.properties },
    },
  };
}
