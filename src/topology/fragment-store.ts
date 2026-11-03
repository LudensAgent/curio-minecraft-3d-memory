/**
 * In-memory historical path store (design §3.1, phase 4A).
 *
 * `FragmentStore` keeps two kinds of historical fact, both strictly separated
 * from current world state:
 *
 * - **Geometry** (`PathFragment`): the shape of a path or observed structure —
 *   its polyline, entrances, and provenance. Saving geometry never proves the
 *   path was walked, and never marks it passable.
 * - **Traversal evidence** (`TraversalEvidence`): an explicitly-submitted,
 *   actually-walked continuous passage between two positions. It is directional
 *   and carries world/dim/session/time/source; nothing here fabricates a
 *   connection from proximity, endpoint overlap, or a sorted block list.
 *
 * The store is bound to one immutable `worldId`. Every record carries its own
 * `dim`; a query filters by `dim` explicitly, so records in different worlds or
 * dimensions are never merged by coincidental coordinates.
 *
 * This is deliberately *not* the full `SpatialMemoryStore`: routing, current
 * traversability, frontiers, and persistence are composed beside it later, so
 * none of those methods appear here as fake-success stubs.
 */

import type { PathFragment, TraversalEvidence } from './path-fragment.js';
import type { Vec3Like } from '../types.js';

/** What one write operation did. `unchanged` is the idempotent no-op. */
export type SaveStatus = 'inserted' | 'updated' | 'unchanged';

export interface SaveResult {
  status: SaveStatus;
}

/** Capacity limits. These are implementation capacities, not game rules. */
export interface FragmentStoreOptions {
  /** Maximum fragments retained. Defaults to 1000. */
  maxFragments?: number;
  /** Maximum points in one fragment polyline. Defaults to 4096. */
  maxPolylinePoints?: number;
  /** Maximum surface reference points in one fragment. Defaults to 64. */
  maxEntrances?: number;
  /** Maximum legacy `links` pairs in one fragment. Defaults to 4096. */
  maxLinks?: number;
  /** Maximum confirmed traversal records retained across the store. Defaults to 10000. */
  maxTraversals?: number;
  /** Maximum items returned by one query page. Defaults to 100. */
  maxQueryBatch?: number;
}

/** Paginated read filter over fragments. All fields are optional and combined by AND. */
export interface FragmentQuery {
  dim?: string;
  /** Filters on `PathFragment.geometrySource`. */
  source?: PathFragment['geometrySource'];
  kind?: PathFragment['kind'];
  /** Exclusive cursor: only fragments whose `id` sorts after this are returned. */
  after?: string;
  /** Page size, clamped to `[1, maxQueryBatch]`. */
  limit?: number;
}

export interface FragmentPage {
  /** Deep-copied snapshots; mutating them never changes the store. */
  items: PathFragment[];
  /** Number of fragments matching the filter, independent of the page. */
  total: number;
  /** Cursor for the next page, or `undefined` when exhausted. */
  nextAfter?: string;
}

/** Paginated read filter over traversal evidence. */
export interface TraversalQuery {
  fragmentId?: string;
  dim?: string;
  after?: string;
  limit?: number;
}

export interface TraversalPage {
  items: TraversalEvidence[];
  total: number;
  nextAfter?: string;
}

/**
 * Explicit update to an existing fragment. Identity (`id`, `worldId`, `dim`) and
 * `createdAt` are immutable; everything else may be changed, and any field left
 * absent is preserved as-is (so `uses`/`lastUsedAt` are never reset by default).
 */
export interface FragmentChanges {
  kind?: PathFragment['kind'];
  entrances?: Vec3Like[];
  polyline?: Vec3Like[];
  geometrySource?: PathFragment['geometrySource'];
  links?: { a: Vec3Like; b: Vec3Like }[];
  deepestY?: number;
  lastUsedAt?: number;
  uses?: number;
}

interface ResolvedLimits {
  maxFragments: number;
  maxPolylinePoints: number;
  maxEntrances: number;
  maxLinks: number;
  maxTraversals: number;
  maxQueryBatch: number;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  maxFragments: 1000,
  maxPolylinePoints: 4096,
  maxEntrances: 64,
  maxLinks: 4096,
  maxTraversals: 10000,
  maxQueryBatch: 100,
};

const FRAGMENT_KINDS: readonly PathFragment['kind'][] = ['dug', 'walked', 'bridge', 'built'];
const GEOMETRY_SOURCES: readonly PathFragment['geometrySource'][] = [
  'traversal',
  'observed_structure',
  'legacy',
];

export class FragmentStore {
  readonly worldId: string;

  private readonly limits: ResolvedLimits;
  private readonly fragmentMap = new Map<string, PathFragment>();
  private readonly traversalMap = new Map<string, TraversalEvidence>();
  /** fragmentId → traversal ids owned by that fragment (removed together on delete). */
  private readonly fragmentToTraversalIds = new Map<string, Set<string>>();

  constructor(worldId: string, options: FragmentStoreOptions = {}) {
    this.worldId = worldId;
    this.limits = resolveLimits(options);
  }

  /**
   * Insert a fragment, or no-op when the same id + content is re-delivered.
   * Same id with *different* content is a conflict and throws (use
   * `updateFragment` to change an existing fragment).
   */
  saveFragment(fragment: PathFragment): SaveResult {
    const snapshot = snapshotFragment(this.worldId, fragment, this.limits);
    const existing = this.fragmentMap.get(fragment.id);
    if (existing !== undefined) {
      if (fragmentsEqual(existing, snapshot)) return { status: 'unchanged' };
      throw new Error(`fragment "${fragment.id}" already exists with different content`);
    }
    if (this.fragmentMap.size >= this.limits.maxFragments) {
      throw new Error(
        `fragment capacity ${this.limits.maxFragments} reached; nothing was written`,
      );
    }
    this.fragmentMap.set(fragment.id, snapshot);
    return { status: 'inserted' };
  }

  /**
   * Explicitly change an existing fragment. Identity and `createdAt` are
   * preserved; omitted fields keep their current value. Returns `unchanged` when
   * the merged result equals the current content.
   */
  updateFragment(id: string, changes: FragmentChanges): SaveResult {
    const existing = this.fragmentMap.get(id);
    if (existing === undefined) {
      throw new Error(`unknown fragment "${id}"`);
    }
    const merged = applyChanges(existing, changes);
    const snapshot = snapshotFragment(this.worldId, merged, this.limits);
    if (fragmentsEqual(existing, snapshot)) return { status: 'unchanged' };
    this.fragmentMap.set(id, snapshot);
    return { status: 'updated' };
  }

  /** Read a fragment by id (deep-copied snapshot), or `null` when absent. */
  getFragment(id: string): PathFragment | null {
    const fragment = this.fragmentMap.get(id);
    return fragment === undefined ? null : cloneFragment(fragment);
  }

  /**
   * Delete a fragment and the traversal evidence it owns. Deleting an unknown id
   * is a stable no-op; evidence owned by other fragments is never touched.
   */
  forgetFragment(id: string): void {
    this.fragmentMap.delete(id);
    const owned = this.fragmentToTraversalIds.get(id);
    if (owned === undefined) return;
    for (const traversalId of owned) this.traversalMap.delete(traversalId);
    this.fragmentToTraversalIds.delete(id);
  }

  /** Paginated read of fragments. Read-only: never changes time, uses, or content. */
  fragments(query: FragmentQuery = {}): FragmentPage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const ids = [...this.fragmentMap.keys()]
      .filter((id) => {
        const fragment = this.fragmentMap.get(id)!;
        if (query.dim !== undefined && fragment.dim !== query.dim) return false;
        if (query.source !== undefined && fragment.geometrySource !== query.source) return false;
        if (query.kind !== undefined && fragment.kind !== query.kind) return false;
        return true;
      })
      .sort();
    const { pageIds, nextAfter } = selectPage(ids, query.after, limit);
    return {
      items: pageIds.map((id) => cloneFragment(this.fragmentMap.get(id)!)),
      total: ids.length,
      nextAfter,
    };
  }

  /**
   * Record confirmed traversal evidence, or no-op when the same id + content is
   * re-delivered. The referenced fragment must already exist and share world/dim.
   */
  addTraversal(evidence: TraversalEvidence): SaveResult {
    const snapshot = snapshotEvidence(this.worldId, evidence);
    const fragment = this.fragmentMap.get(evidence.fragmentId);
    if (fragment === undefined) {
      throw new Error(`traversal references unknown fragment "${evidence.fragmentId}"`);
    }
    if (fragment.worldId !== evidence.worldId || fragment.dim !== evidence.dim) {
      throw new Error(
        `traversal world/dim does not match fragment "${evidence.fragmentId}"`,
      );
    }
    const existing = this.traversalMap.get(evidence.id);
    if (existing !== undefined) {
      if (evidencesEqual(existing, snapshot)) return { status: 'unchanged' };
      throw new Error(`traversal evidence "${evidence.id}" already exists with different content`);
    }
    if (this.traversalMap.size >= this.limits.maxTraversals) {
      throw new Error(
        `traversal capacity ${this.limits.maxTraversals} reached; nothing was written`,
      );
    }
    this.traversalMap.set(evidence.id, snapshot);
    let owned = this.fragmentToTraversalIds.get(evidence.fragmentId);
    if (owned === undefined) {
      owned = new Set();
      this.fragmentToTraversalIds.set(evidence.fragmentId, owned);
    }
    owned.add(evidence.id);
    return { status: 'inserted' };
  }

  /** Paginated read of traversal evidence. Read-only, and directional: A→B never implies B→A. */
  traversals(query: TraversalQuery = {}): TraversalPage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const ids = [...this.traversalMap.keys()]
      .filter((id) => {
        const evidence = this.traversalMap.get(id)!;
        if (query.fragmentId !== undefined && evidence.fragmentId !== query.fragmentId) return false;
        if (query.dim !== undefined && evidence.dim !== query.dim) return false;
        return true;
      })
      .sort();
    const { pageIds, nextAfter } = selectPage(ids, query.after, limit);
    return {
      items: pageIds.map((id) => cloneEvidence(this.traversalMap.get(id)!)),
      total: ids.length,
      nextAfter,
    };
  }
}

// --- validation + snapshotting (snapshot first, then write, so a failed write leaves no half state) ---

function snapshotFragment(worldId: string, f: PathFragment, limits: ResolvedLimits): PathFragment {
  if (f.worldId !== worldId) {
    throw new Error(`fragment worldId "${f.worldId}" does not match store worldId "${worldId}"`);
  }
  if (typeof f.id !== 'string' || f.id.length === 0) {
    throw new Error(`fragment id must be a non-empty string`);
  }
  if (typeof f.dim !== 'string' || f.dim.length === 0) {
    throw new Error(`fragment dim must be a non-empty string`);
  }
  if (!FRAGMENT_KINDS.includes(f.kind)) {
    throw new Error(`fragment kind "${String(f.kind)}" is not a known kind`);
  }
  if (!GEOMETRY_SOURCES.includes(f.geometrySource)) {
    throw new Error(`fragment geometrySource "${String(f.geometrySource)}" is not a known source`);
  }
  if (f.polyline.length > limits.maxPolylinePoints) {
    throw new Error(
      `fragment polyline has ${f.polyline.length} points, exceeding ${limits.maxPolylinePoints}`,
    );
  }
  if (f.entrances.length > limits.maxEntrances) {
    throw new Error(
      `fragment has ${f.entrances.length} entrances, exceeding ${limits.maxEntrances}`,
    );
  }
  if (f.links !== undefined && f.links.length > limits.maxLinks) {
    throw new Error(`fragment has ${f.links.length} links, exceeding ${limits.maxLinks}`);
  }
  if (!Number.isFinite(f.deepestY)) {
    throw new Error(`fragment deepestY must be a finite number: ${f.deepestY}`);
  }
  if (!Number.isFinite(f.createdAt)) {
    throw new Error(`fragment createdAt must be a finite number: ${f.createdAt}`);
  }
  if (!Number.isFinite(f.lastUsedAt)) {
    throw new Error(`fragment lastUsedAt must be a finite number: ${f.lastUsedAt}`);
  }
  if (!Number.isFinite(f.uses) || f.uses < 0) {
    throw new Error(`fragment uses must be a non-negative finite number: ${f.uses}`);
  }
  for (const p of f.polyline) assertFinitePoint(p, 'polyline point');
  for (const p of f.entrances) assertFinitePoint(p, 'entrance point');
  for (const l of f.links ?? []) {
    assertFinitePoint(l.a, 'link.a');
    assertFinitePoint(l.b, 'link.b');
  }
  return cloneFragment(f);
}

function snapshotEvidence(worldId: string, e: TraversalEvidence): TraversalEvidence {
  if (e.worldId !== worldId) {
    throw new Error(`traversal worldId "${e.worldId}" does not match store worldId "${worldId}"`);
  }
  if (typeof e.id !== 'string' || e.id.length === 0) {
    throw new Error(`traversal id must be a non-empty string`);
  }
  if (typeof e.fragmentId !== 'string' || e.fragmentId.length === 0) {
    throw new Error(`traversal fragmentId must be a non-empty string`);
  }
  if (typeof e.dim !== 'string' || e.dim.length === 0) {
    throw new Error(`traversal dim must be a non-empty string`);
  }
  if (e.sessionId !== null && (typeof e.sessionId !== 'string' || e.sessionId.length === 0)) {
    throw new Error(`traversal sessionId must be a non-empty string or null`);
  }
  if (e.observedAt !== null && !Number.isFinite(e.observedAt)) {
    throw new Error(`traversal observedAt must be a finite number or null`);
  }
  if (typeof e.source !== 'string' || e.source.length === 0) {
    throw new Error(`traversal source must be a non-empty string`);
  }
  if (e.executionId !== undefined && (typeof e.executionId !== 'string' || e.executionId.length === 0)) {
    throw new Error(`traversal executionId must be a non-empty string when present`);
  }
  if (e.actionId !== undefined && (typeof e.actionId !== 'string' || e.actionId.length === 0)) {
    throw new Error(`traversal actionId must be a non-empty string when present`);
  }
  assertFinitePoint(e.from, 'traversal.from');
  assertFinitePoint(e.to, 'traversal.to');
  return cloneEvidence(e);
}

function cloneFragment(f: PathFragment): PathFragment {
  return {
    id: f.id,
    worldId: f.worldId,
    dim: f.dim,
    kind: f.kind,
    entrances: f.entrances.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    polyline: f.polyline.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    geometrySource: f.geometrySource,
    links: f.links?.map((l) => ({
      a: { x: l.a.x, y: l.a.y, z: l.a.z },
      b: { x: l.b.x, y: l.b.y, z: l.b.z },
    })),
    deepestY: f.deepestY,
    createdAt: f.createdAt,
    lastUsedAt: f.lastUsedAt,
    uses: f.uses,
  };
}

function cloneEvidence(e: TraversalEvidence): TraversalEvidence {
  // Read every field explicitly: object spread skips prototype getters, so a
  // class-provided input would otherwise lose its attribution and coordinates.
  return {
    id: e.id,
    fragmentId: e.fragmentId,
    from: { x: e.from.x, y: e.from.y, z: e.from.z },
    to: { x: e.to.x, y: e.to.y, z: e.to.z },
    worldId: e.worldId,
    dim: e.dim,
    sessionId: e.sessionId,
    observedAt: e.observedAt,
    source: e.source,
    executionId: e.executionId,
    actionId: e.actionId,
  };
}

function assertFinitePoint(p: Vec3Like, label: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    throw new Error(`${label} must have finite coordinates: (${p.x}, ${p.y}, ${p.z})`);
  }
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function fragmentsEqual(a: PathFragment, b: PathFragment): boolean {
  return (
    a.id === b.id &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    a.kind === b.kind &&
    a.geometrySource === b.geometrySource &&
    a.deepestY === b.deepestY &&
    a.createdAt === b.createdAt &&
    a.lastUsedAt === b.lastUsedAt &&
    a.uses === b.uses &&
    a.entrances.length === b.entrances.length &&
    a.entrances.every((p, i) => pointsEqual(p, b.entrances[i]!)) &&
    a.polyline.length === b.polyline.length &&
    a.polyline.every((p, i) => pointsEqual(p, b.polyline[i]!)) &&
    linksEqual(a.links, b.links)
  );
}

function linksEqual(
  a: PathFragment['links'],
  b: PathFragment['links'],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((l, i) => pointsEqual(l.a, b[i]!.a) && pointsEqual(l.b, b[i]!.b))
  );
}

function evidencesEqual(a: TraversalEvidence, b: TraversalEvidence): boolean {
  return (
    a.id === b.id &&
    a.fragmentId === b.fragmentId &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    a.sessionId === b.sessionId &&
    a.observedAt === b.observedAt &&
    a.source === b.source &&
    a.executionId === b.executionId &&
    a.actionId === b.actionId &&
    pointsEqual(a.from, b.from) &&
    pointsEqual(a.to, b.to)
  );
}

/**
 * Merge an explicit update onto an existing fragment. Identity and `createdAt`
 * are preserved; every other field is read by presence (own or prototype
 * getter) so a class-provided `FragmentChanges` is honored. `links` is the one
 * field where an explicitly-undefined value clears it instead of falling back.
 */
function applyChanges(existing: PathFragment, changes: FragmentChanges): PathFragment {
  return {
    id: existing.id,
    worldId: existing.worldId,
    dim: existing.dim,
    createdAt: existing.createdAt,
    kind: pick(changes, 'kind', existing.kind),
    entrances: pick(changes, 'entrances', existing.entrances),
    polyline: pick(changes, 'polyline', existing.polyline),
    geometrySource: pick(changes, 'geometrySource', existing.geometrySource),
    links: 'links' in changes ? changes.links : existing.links,
    deepestY: pick(changes, 'deepestY', existing.deepestY),
    lastUsedAt: pick(changes, 'lastUsedAt', existing.lastUsedAt),
    uses: pick(changes, 'uses', existing.uses),
  };
}

/** Read a non-optional change field by presence (own or prototype getter), else keep the current value. */
function pick<K extends keyof FragmentChanges>(
  changes: FragmentChanges,
  key: K,
  fallback: NonNullable<FragmentChanges[K]>,
): NonNullable<FragmentChanges[K]> {
  return key in changes ? (changes[key] as NonNullable<FragmentChanges[K]>) : fallback;
}

function resolveLimits(options: FragmentStoreOptions): ResolvedLimits {
  const limits: ResolvedLimits = { ...DEFAULT_LIMITS };
  const overrides: (keyof ResolvedLimits)[] = [
    'maxFragments',
    'maxPolylinePoints',
    'maxEntrances',
    'maxLinks',
    'maxTraversals',
    'maxQueryBatch',
  ];
  for (const key of overrides) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive integer: ${value}`);
    }
    limits[key] = value;
  }
  return limits;
}

function clampLimit(limit: number | undefined, maxQueryBatch: number): number {
  if (limit === undefined) return maxQueryBatch;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer: ${limit}`);
  }
  return Math.min(limit, maxQueryBatch);
}

/**
 * Select one page from an ascending-sorted id list. `after` is exclusive; the
 * cursor is the last returned id, so `nextAfter` is only set when more ids follow.
 */
function selectPage(
  sortedIds: string[],
  after: string | undefined,
  limit: number,
): { pageIds: string[]; nextAfter: string | undefined } {
  const start = after === undefined ? 0 : firstIndexAfter(sortedIds, after);
  const end = Math.min(start + limit, sortedIds.length);
  const pageIds = sortedIds.slice(start, end);
  const nextAfter = end < sortedIds.length ? sortedIds[end - 1] : undefined;
  return { pageIds, nextAfter };
}

function firstIndexAfter(sortedIds: string[], after: string): number {
  let i = 0;
  while (i < sortedIds.length && sortedIds[i]! <= after) i += 1;
  return i;
}
