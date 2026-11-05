/**
 * Read-only historical-route inspection (design §7 `inspect_route` on a
 * stored fragment).
 *
 * `inspectKnownRoute` projects only data the history store already holds:
 * geometry, ends, legacy links, provenance precision and historical traversal
 * records. It does not accept a map, adapter or clock, so it cannot load a
 * section, pin residency, observe, refresh evidence, save, start an executor or
 * move the body.
 *
 * Openness and freshness are `unknown` unless the caller supplies explicit
 * current evidence. Even then the projection reports only what that evidence
 * states: a caller-provided blocked position is a blockage, but the route is
 * never called `open` unless the caller also asserts the fresh evidence covered
 * the whole stored polyline.
 */

import type { FragmentStore } from '../topology/fragment-store.js';
import type { PathFragment, TraversalEvidence } from '../topology/path-fragment.js';
import type { MoveMode, Vec3Like } from '../types.js';

/** Caller-supplied current evidence. This is the caller's claim, not a library observation. */
export interface KnownRouteEvidence {
  /** Real time the caller's evidence was captured or checked. */
  checkedAt: number;
  freshness: 'fresh' | 'stale';
  /** Positions the caller confirmed blocked. A block name is included only when actually observed. */
  blocked?: { pos: Vec3Like; block?: string }[];
  /**
   * Caller assertion that the fresh evidence covered every stored route point.
   * Without this, the projection never turns an empty blocked list into `open`.
   */
  verifiedWholeRoute?: boolean;
}

export interface InspectKnownRouteOptions {
  /** Caller-held current facts; absent keeps every current field explicitly unknown. */
  evidence?: KnownRouteEvidence;
  /** Maximum historical traversal records to project. Default 16. */
  traversalLimit?: number;
}

export interface KnownRouteTraversalView {
  id: string;
  from: Vec3Like;
  to: Vec3Like;
  sessionId: string | null;
  observedAt: number | null;
  source: string;
  mode?: MoveMode;
}

/** Current facts about the historical route. Never inferred from geometry alone. */
export interface KnownRouteCurrentFacts {
  openness: 'unknown' | 'open' | 'blocked' | 'stale';
  freshness: 'unknown' | 'fresh' | 'stale';
  source: 'none' | 'caller_supplied';
  checkedAt?: number;
  /** Caller-reported obstacles; empty when none were supplied. */
  blocked: { pos: Vec3Like; block?: string }[];
  verifiedWholeRoute?: boolean;
}

export interface KnownRouteInspection {
  kind: 'route';
  source: 'fragment_store';
  worldId: string;
  pathId: string;
  dim: string;
  fragmentKind: PathFragment['kind'];
  geometrySource: PathFragment['geometrySource'];
  /**
   * Source-derived geometry precision: `traversal` geometry came from an actual
   * traversal, `observed` from observed structure, `inferred` from legacy data.
   * It is not current passability.
   */
  precision: 'traversal' | 'observed' | 'inferred';
  /** Fresh copy of the stored ordered polyline. */
  polyline: Vec3Like[];
  pointCount: number;
  ends: { start: Vec3Like; end: Vec3Like } | null;
  /** Legacy historical link pairs. They are history, not current edges. */
  links: { a: Vec3Like; b: Vec3Like }[];
  deepestY: number;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
  /** Bounded, deep-copied historical traversal records. */
  traversals: KnownRouteTraversalView[];
  traversalCount: number;
  current: KnownRouteCurrentFacts;
  /** Literal: this query makes no current-open claim. */
  currentOpennessClaimed: false;
  /** Literal: this query did not observe the world. */
  observedNow: false;
  /** Literal: this query did not load or pin a section. */
  loadedSections: false;
  /** Literal: this query did not mutate the history store. */
  mutated: false;
}

export interface KnownRouteNotFound {
  kind: 'not_found';
  source: 'fragment_store';
  worldId: string;
  pathId: string;
  message: string;
}

export type KnownRouteInspectionResult = KnownRouteInspection | KnownRouteNotFound;

const DEFAULT_TRAVERSAL_LIMIT = 16;

/**
 * Project one stored fragment as historical facts. Pure: the only reads are
 * `getFragment` and `traversals`, both of which return deep copies.
 */
export function inspectKnownRoute(
  history: FragmentStore,
  pathId: string,
  options: InspectKnownRouteOptions = {},
): KnownRouteInspectionResult {
  const fragment = history.getFragment(pathId);
  if (fragment === null) {
    return {
      kind: 'not_found',
      source: 'fragment_store',
      worldId: history.worldId,
      pathId,
      message: `history for world "${history.worldId}" has no fragment "${pathId}"`,
    };
  }

  const limit = resolveTraversalLimit(options.traversalLimit);
  const traversals = history.traversals({ fragmentId: pathId, limit });

  return {
    kind: 'route',
    source: 'fragment_store',
    worldId: history.worldId,
    pathId: fragment.id,
    dim: fragment.dim,
    fragmentKind: fragment.kind,
    geometrySource: fragment.geometrySource,
    precision: fragment.geometrySource === 'traversal'
      ? 'traversal'
      : fragment.geometrySource === 'observed_structure'
        ? 'observed'
        : 'inferred',
    polyline: fragment.polyline.map(cloneVec),
    pointCount: fragment.polyline.length,
    ends: fragment.polyline.length === 0
      ? null
      : {
          start: cloneVec(fragment.polyline[0]!),
          end: cloneVec(fragment.polyline[fragment.polyline.length - 1]!),
        },
    links: (fragment.links ?? []).map((link) => ({ a: cloneVec(link.a), b: cloneVec(link.b) })),
    deepestY: fragment.deepestY,
    createdAt: fragment.createdAt,
    lastUsedAt: fragment.lastUsedAt,
    uses: fragment.uses,
    traversals: traversals.items.map(cloneTraversal),
    traversalCount: traversals.total,
    current: currentFacts(options.evidence),
    currentOpennessClaimed: false,
    observedNow: false,
    loadedSections: false,
    mutated: false,
  };
}

function currentFacts(evidence: KnownRouteEvidence | undefined): KnownRouteCurrentFacts {
  if (evidence === undefined) {
    return { openness: 'unknown', freshness: 'unknown', source: 'none', blocked: [] };
  }
  validateEvidence(evidence);
  const blocked = (evidence.blocked ?? []).map((entry) => ({
    pos: cloneVec(entry.pos),
    ...(entry.block === undefined ? {} : { block: entry.block }),
  }));
  const openness: KnownRouteCurrentFacts['openness'] = evidence.freshness === 'stale'
    ? 'stale'
    : blocked.length > 0
      ? 'blocked'
      : evidence.verifiedWholeRoute === true
        ? 'open'
        : 'unknown';
  return {
    openness,
    freshness: evidence.freshness,
    source: 'caller_supplied',
    checkedAt: evidence.checkedAt,
    blocked,
    ...(evidence.verifiedWholeRoute === undefined
      ? {}
      : { verifiedWholeRoute: evidence.verifiedWholeRoute }),
  };
}

function validateEvidence(evidence: KnownRouteEvidence): void {
  if (!Number.isFinite(evidence.checkedAt)) {
    throw new Error(`evidence.checkedAt must be finite: ${evidence.checkedAt}`);
  }
  if (evidence.freshness !== 'fresh' && evidence.freshness !== 'stale') {
    throw new Error(`evidence.freshness must be "fresh" or "stale": ${String(evidence.freshness)}`);
  }
  if (evidence.blocked !== undefined && !Array.isArray(evidence.blocked)) {
    throw new Error('evidence.blocked must be an array of positions');
  }
  for (const entry of evidence.blocked ?? []) {
    if (!isVec3(entry.pos)) {
      throw new Error('evidence.blocked entries must contain a finite position');
    }
    if (entry.block !== undefined && (typeof entry.block !== 'string' || entry.block.length === 0)) {
      throw new Error('evidence.blocked block names must be non-empty strings when supplied');
    }
  }
  if (evidence.verifiedWholeRoute !== undefined && typeof evidence.verifiedWholeRoute !== 'boolean') {
    throw new Error('evidence.verifiedWholeRoute must be a boolean when supplied');
  }
}

function resolveTraversalLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_TRAVERSAL_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`traversalLimit must be a positive safe integer: ${limit}`);
  }
  return limit;
}

function cloneTraversal(traversal: TraversalEvidence): KnownRouteTraversalView {
  return {
    id: traversal.id,
    from: cloneVec(traversal.from),
    to: cloneVec(traversal.to),
    sessionId: traversal.sessionId,
    observedAt: traversal.observedAt,
    source: traversal.source,
    ...(traversal.mode === undefined ? {} : { mode: traversal.mode }),
  };
}

function isVec3(value: unknown): value is Vec3Like {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return typeof v.x === 'number' && Number.isFinite(v.x)
    && typeof v.y === 'number' && Number.isFinite(v.y)
    && typeof v.z === 'number' && Number.isFinite(v.z);
}

function cloneVec(p: Vec3Like): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}
