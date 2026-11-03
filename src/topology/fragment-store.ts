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
import {
  assertValidMode,
  cloneTraversalEvidence,
  jsonEscapedByteLength,
  traversalEvidenceEqual,
} from './path-fragment.js';
import type { Vec3Like } from '../types.js';

/** What one write operation did. `unchanged` is the idempotent no-op. */
export type SaveStatus = 'inserted' | 'updated' | 'unchanged';

export interface SaveResult {
  status: SaveStatus;
}

/**
 * O(1) read-only scope of a fragment: identity and scope only, no geometry copy.
 * Used by bounded topology queries to re-check a fragment's world/dim without
 * copying `polyline` / `entrances` / `links`.
 */
export interface FragmentScope {
  id: string;
  worldId: string;
  dim: string;
}

/**
 * Measured size of the fragment store, used for the bounded checkpoint pre-flight.
 * Every count is exact; `bytes` is a conservative estimate of the JSON-encoded
 * snapshot size (computed without copying or stringifying the full dataset).
 */
export interface FragmentCheckpointMeasure {
  fragments: number;
  traversals: number;
  polylinePoints: number;
  entrancePoints: number;
  linkPairs: number;
  bytes: number;
}

/**
 * A deep-copied, insertion-ordered snapshot of the store's full history, captured
 * synchronously for a checkpoint. Mutating the returned arrays/objects never
 * reaches the store.
 */
export interface FragmentCheckpointSnapshot {
  worldId: string;
  fragments: PathFragment[];
  traversals: TraversalEvidence[];
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
  /**
   * Session-local mutation revision, bumped only by writes that actually change a
   * fact. Not a time, observation number, or traversal count; it is reset on
   * `restoreSnapshot` and only exists to mark checkpoint cut-points and `dirty`.
   */
  private mutationRevision = 0;

  constructor(worldId: string, options: FragmentStoreOptions = {}) {
    this.worldId = worldId;
    this.limits = resolveLimits(options);
  }

  /** Current mutation revision (see `mutationRevision`). */
  get revision(): number {
    return this.mutationRevision;
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
    this.mutationRevision += 1;
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
    this.mutationRevision += 1;
    return { status: 'updated' };
  }

  /** Read a fragment by id (deep-copied snapshot), or `null` when absent. */
  getFragment(id: string): PathFragment | null {
    const fragment = this.fragmentMap.get(id);
    return fragment === undefined ? null : cloneFragment(fragment);
  }

  /**
   * O(1) read-only scope read: identity and world/dim only, no copy of
   * `polyline`/`entrances`/`links`, and no refresh of time, uses or any other
   * fact. Returns `null` when the fragment is absent.
   */
  getFragmentScope(id: string): FragmentScope | null {
    const fragment = this.fragmentMap.get(id);
    return fragment === undefined
      ? null
      : { id: fragment.id, worldId: fragment.worldId, dim: fragment.dim };
  }

  /**
   * Delete a fragment and the traversal evidence it owns. Deleting an unknown id
   * is a stable no-op; evidence owned by other fragments is never touched.
   */
  forgetFragment(id: string): void {
    const existed = this.fragmentMap.delete(id);
    const owned = this.fragmentToTraversalIds.get(id);
    if (owned !== undefined) {
      for (const traversalId of owned) this.traversalMap.delete(traversalId);
      this.fragmentToTraversalIds.delete(id);
    }
    // Deleting an unknown id (or an id whose cascade removed nothing) is a no-op;
    // only an actual removal — including its cascade — counts as a change.
    if (existed) this.mutationRevision += 1;
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
      if (traversalEvidenceEqual(existing, snapshot)) return { status: 'unchanged' };
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
    this.mutationRevision += 1;
    return { status: 'inserted' };
  }

  /**
   * Read one traversal record by id (deep-copied snapshot), or `null` when absent.
   * A direct by-id lookup — never a scan of the paginated listing — and read-only:
   * it does not refresh time, uses, or any other fact.
   */
  getTraversal(id: string): TraversalEvidence | null {
    const evidence = this.traversalMap.get(id);
    return evidence === undefined ? null : cloneTraversalEvidence(evidence);
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
      items: pageIds.map((id) => cloneTraversalEvidence(this.traversalMap.get(id)!)),
      total: ids.length,
      nextAfter,
    };
  }

  // --- checkpoint support (phase 5A): bounded export + validated restore ---

  /**
   * Exact size of the store's full history, used by the checkpoint pre-flight to
   * reject over-capacity saves *before* any copy or message pass. Read-only; never
   * refreshes time, uses, or any other fact.
   */
  checkpointMeasure(): FragmentCheckpointMeasure {
    let polylinePoints = 0;
    let entrancePoints = 0;
    let linkPairs = 0;
    let bytes = 0;
    for (const fragment of this.fragmentMap.values()) {
      polylinePoints += fragment.polyline.length;
      entrancePoints += fragment.entrances.length;
      linkPairs += fragment.links?.length ?? 0;
      bytes += estimateFragmentBytes(fragment);
    }
    for (const evidence of this.traversalMap.values()) {
      bytes += estimateTraversalBytes(evidence);
    }
    return {
      fragments: this.fragmentMap.size,
      traversals: this.traversalMap.size,
      polylinePoints,
      entrancePoints,
      linkPairs,
      bytes,
    };
  }

  /**
   * Deep-copied, insertion-ordered snapshot of the store's full history for a
   * checkpoint. Read-only; the caller owns the returned objects.
   */
  checkpointSnapshot(): FragmentCheckpointSnapshot {
    return {
      worldId: this.worldId,
      fragments: [...this.fragmentMap.values()].map(cloneFragment),
      traversals: [...this.traversalMap.values()].map(cloneTraversalEvidence),
    };
  }

  /**
   * Narrow, validated restore entry (phase 5A). Replaces the store's full history
   * from a previously captured snapshot and resets the mutation revision to its
   * session baseline. It validates every record and the fragment→traversal
   * ownership graph, but it does not go through the public write methods, so it
   * never fabricates a traversal, never re-resolves evidence, and never bumps the
   * revision for the restored facts themselves.
   */
  restoreSnapshot(snapshot: FragmentCheckpointSnapshot): void {
    if (snapshot.worldId !== this.worldId) {
      throw new Error(`snapshot worldId "${snapshot.worldId}" does not match store worldId "${this.worldId}"`);
    }
    if (snapshot.fragments.length > this.limits.maxFragments) {
      throw new Error(
        `snapshot has ${snapshot.fragments.length} fragments, exceeding ${this.limits.maxFragments}`,
      );
    }
    if (snapshot.traversals.length > this.limits.maxTraversals) {
      throw new Error(
        `snapshot has ${snapshot.traversals.length} traversals, exceeding ${this.limits.maxTraversals}`,
      );
    }
    const fragments = new Map<string, PathFragment>();
    for (const raw of snapshot.fragments) {
      const validated = snapshotFragment(this.worldId, raw, this.limits);
      if (fragments.has(validated.id)) {
        throw new Error(`duplicate fragment id "${validated.id}" in snapshot`);
      }
      fragments.set(validated.id, validated);
    }
    const traversals = new Map<string, TraversalEvidence>();
    const fragmentToTraversalIds = new Map<string, Set<string>>();
    for (const raw of snapshot.traversals) {
      const validated = snapshotEvidence(this.worldId, raw);
      if (traversals.has(validated.id)) {
        throw new Error(`duplicate traversal id "${validated.id}" in snapshot`);
      }
      const owner = fragments.get(validated.fragmentId);
      if (owner === undefined) {
        throw new Error(`traversal "${validated.id}" references unknown fragment "${validated.fragmentId}"`);
      }
      if (owner.worldId !== validated.worldId || owner.dim !== validated.dim) {
        throw new Error(`traversal "${validated.id}" world/dim does not match fragment "${validated.fragmentId}"`);
      }
      traversals.set(validated.id, validated);
      let owned = fragmentToTraversalIds.get(validated.fragmentId);
      if (owned === undefined) {
        owned = new Set();
        fragmentToTraversalIds.set(validated.fragmentId, owned);
      }
      owned.add(validated.id);
    }
    this.fragmentMap.clear();
    for (const [id, value] of fragments) this.fragmentMap.set(id, value);
    this.traversalMap.clear();
    for (const [id, value] of traversals) this.traversalMap.set(id, value);
    this.fragmentToTraversalIds.clear();
    for (const [id, value] of fragmentToTraversalIds) this.fragmentToTraversalIds.set(id, value);
    // Restore is a mutation: it replaces the store's facts, so it must mark the
    // store dirty. Only a session initializer (which then sets the confirmed
    // baseline to the post-restore revision) treats it as a clean baseline.
    this.mutationRevision += 1;
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

export function snapshotEvidence(worldId: string, e: TraversalEvidence): TraversalEvidence {
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
  assertValidMode(e.mode);
  assertFinitePoint(e.from, 'traversal.from');
  assertFinitePoint(e.to, 'traversal.to');
  return cloneTraversalEvidence(e);
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

// --- checkpoint byte estimation (conservative upper bound; no full copy or stringify) ---

// A point `{"x":…,"y":…,"z":…}`: ~16 structural bytes + 3 doubles (~24 worst-case each).
const BYTES_PER_POINT = 96;
// A link `{"a":{…},"b":{…}}`: two points plus ~8 framing bytes.
const BYTES_PER_LINK = BYTES_PER_POINT * 2 + 8;
// Worst-case JSON decimal for a JS double (`-1.2345678901234567e+300`-style).
const BYTES_PER_NUMBER = 24;
// Surrounding quotes added to every string value in the JSON object.
const STRING_QUOTES = 2;

function estimateFragmentBytes(f: PathFragment): number {
  // Field names + `{`/`}`/commas, conservatively.
  let bytes = 192;
  bytes += jsonEscapedByteLength(f.id) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(f.worldId) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(f.dim) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(f.kind) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(f.geometrySource) + STRING_QUOTES;
  bytes += 4 * BYTES_PER_NUMBER; // deepestY, createdAt, lastUsedAt, uses
  bytes += f.polyline.length * BYTES_PER_POINT;
  bytes += f.entrances.length * BYTES_PER_POINT;
  bytes += (f.links?.length ?? 0) * BYTES_PER_LINK;
  return bytes;
}

export function estimateTraversalBytes(e: TraversalEvidence): number {
  let bytes = 160;
  bytes += jsonEscapedByteLength(e.id) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(e.fragmentId) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(e.worldId) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(e.dim) + STRING_QUOTES;
  bytes += jsonEscapedByteLength(e.source) + STRING_QUOTES;
  bytes += e.sessionId === null ? 4 : jsonEscapedByteLength(e.sessionId) + STRING_QUOTES; // null → "null"
  bytes += e.observedAt === null ? 4 : BYTES_PER_NUMBER;
  bytes += e.executionId === undefined ? 0 : jsonEscapedByteLength(e.executionId) + STRING_QUOTES;
  bytes += e.actionId === undefined ? 0 : jsonEscapedByteLength(e.actionId) + STRING_QUOTES;
  bytes += e.mode === undefined ? 0 : jsonEscapedByteLength(e.mode) + STRING_QUOTES;
  bytes += 2 * BYTES_PER_POINT; // from, to
  return bytes;
}
