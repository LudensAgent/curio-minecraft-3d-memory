/**
 * In-memory explicit topology facts store (design §5, phase 4B).
 *
 * `TopologyStore` keeps the *explicit* topology the caller recorded: which
 * spatial nodes exist, which directional connections are recorded between them,
 * and which historical traversal evidence each traversed connection cites. It
 * answers "what nodes and connections were explicitly recorded, and do those
 * connections' evidence references still resolve from the authoritative history"
 * — never "can I walk this right now".
 *
 * Two connection kinds are distinguished in every query result:
 *
 * - `candidate` — an explicit "to-verify" relation the caller submitted. It does
 *   not prove a traversal happened and does not prove it is passable now.
 * - `traversed` — a directed historical connection backed by a concrete
 *   `TraversalEvidence` record whose endpoints match the edge's from→to exactly.
 *
 * Edges are always directional: A→B and B→A are independent records, and saving
 * A→B never auto-generates B→A. Only non-`PORTAL`, same-world, same-dimension,
 * exact-endpoint connections are supported; regions can be stored and queried as
 * nodes but never as edge endpoints, and `PORTAL`/cross-dimension connections are
 * rejected as unsupported in this phase.
 *
 * `TopologyStore` reads evidence through a narrow read-only history interface
 * (`worldId`, `getFragment`, `getTraversal`) satisfied directly by `FragmentStore`.
 * It never reaches into the history store's private state and keeps no second
 * writable copy of evidence — it only keeps the evidence *id* plus an immutable
 * binding snapshot used for matching and display.
 */

import type { ConnectionType, LandmarkTag, NodeKind, NodeSource, SpatialNode } from './graph.js';
import type { PathFragment, TraversalEvidence } from './path-fragment.js';
import { cloneTraversalEvidence, traversalEvidenceEqual } from './path-fragment.js';
import type { SaveResult } from './fragment-store.js';
import type { Vec3Like } from '../types.js';

/** How a topology edge is justified. */
export type EdgeBasis = 'candidate' | 'traversed';

/** Whether a still-present evidence record matches what an edge was bound to. */
export type ReferenceStatus = 'resolved' | 'missing' | 'mismatch';

/**
 * A directed, explicitly-recorded connection between two node ids. `basis`
 * separates a pending candidate relation from an evidence-backed traversed one;
 * `evidenceIds` (traversed only) cite the `TraversalEvidence` records that back
 * the from→to relation. Current traversability is deliberately absent here.
 */
export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  /** Provenance association only — never a substitute for traversal evidence. */
  fragmentId?: string;
  basis: EdgeBasis;
  /** Caller's provenance note (mainly for `candidate` edges). */
  source?: string;
  /** Traversal evidence ids backing a `traversed` edge; empty for `candidate`. */
  evidenceIds: string[];
}

/** Resolution of one evidence reference, re-read from the authoritative history. */
export interface EdgeReference {
  evidenceId: string;
  status: ReferenceStatus;
  /** The evidence snapshot the edge was bound to (historical summary, never an authority). */
  snapshot: TraversalEvidence | null;
  /** The authoritative record as read now, when it still exists. */
  current: TraversalEvidence | null;
}

/** Read projection of an edge: the record plus per-reference resolution. */
export interface EdgeView extends TopologyEdge {
  /** Per-evidence resolution; empty for `candidate` edges. */
  references: EdgeReference[];
  /** Aggregate resolution for `traversed` edges, or `null` for `candidate` (nothing to resolve). */
  resolution: ReferenceStatus | null;
}

/**
 * Narrow read-only history surface `TopologyStore` consumes. `FragmentStore`
 * already satisfies it; the store never imports its private state.
 */
export interface TopologyHistorySource {
  readonly worldId: string;
  getFragment(id: string): PathFragment | null;
  getTraversal(id: string): TraversalEvidence | null;
}

/** Capacity limits. These are implementation capacities, not game rules. */
export interface TopologyStoreOptions {
  /** Maximum `agent`-source nodes. Defaults to 10000. */
  maxAgentNodes?: number;
  /** Maximum `program`-source nodes. Defaults to 10000. */
  maxProgramNodes?: number;
  /** Maximum edges retained. Defaults to 20000. */
  maxEdges?: number;
  /** Maximum traversal evidence references one edge may cite. Defaults to 8. */
  maxEdgeEvidenceRefs?: number;
  /** Maximum items returned by one query page. Defaults to 100. */
  maxQueryBatch?: number;
}

/** Paginated read filter over nodes. All fields optional and combined by AND. */
export interface NodeQuery {
  dim?: string;
  source?: NodeSource;
  tag?: LandmarkTag;
  label?: string;
  /** Exclusive cursor: only ids sorting after this are returned. */
  after?: string;
  limit?: number;
}

export interface NodePage {
  items: SpatialNode[];
  total: number;
  nextAfter?: string;
}

/** Paginated read filter over edges. */
export interface EdgeQuery {
  dim?: string;
  from?: string;
  to?: string;
  type?: ConnectionType;
  basis?: EdgeBasis;
  after?: string;
  limit?: number;
}

export interface EdgePage {
  items: EdgeView[];
  total: number;
  nextAfter?: string;
}

/**
 * Explicit update to an existing node. `id`/`worldId`/`dim`/`source` are
 * immutable; `kind`/`tag`/`label` may be changed (an explicitly-`undefined`
 * `tag`/`label` clears them), and `location` may only be corrected while the node
 * is referenced by no edge.
 */
export interface NodeChanges {
  kind?: NodeKind;
  tag?: LandmarkTag;
  label?: string;
  location?: SpatialNode['location'];
}

/**
 * Explicit update to an existing edge. `id`/`from`/`to` are immutable; changing
 * endpoints means deleting the edge and creating a new one. Changing `basis` from
 * `candidate` to `traversed` (or altering `evidenceIds`) re-runs every validation.
 */
export interface EdgeChanges {
  type?: ConnectionType;
  fragmentId?: string;
  basis?: EdgeBasis;
  source?: string;
  evidenceIds?: string[];
}

/** Internal edge record: the public shape plus the immutable binding snapshots. */
interface StoredEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  fragmentId?: string;
  basis: EdgeBasis;
  source?: string;
  refs: StoredEvidenceRef[];
}

interface StoredEvidenceRef {
  evidenceId: string;
  snapshot: TraversalEvidence;
}

interface ResolvedLimits {
  maxAgentNodes: number;
  maxProgramNodes: number;
  maxEdges: number;
  maxEdgeEvidenceRefs: number;
  maxQueryBatch: number;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  maxAgentNodes: 10000,
  maxProgramNodes: 10000,
  maxEdges: 20000,
  maxEdgeEvidenceRefs: 8,
  maxQueryBatch: 100,
};

const NODE_KINDS: readonly NodeKind[] = ['entrance', 'place', 'branch', 'turn', 'vertical_junction'];
const NODE_SOURCES: readonly NodeSource[] = ['agent', 'program'];
const LANDMARK_TAGS: readonly LandmarkTag[] = [
  'base',
  'resource',
  'danger',
  'discovery',
  'death',
  'waypoint',
  'herd',
  'portal',
];
const NON_PORTAL_CONNECTION_TYPES: readonly ConnectionType[] = [
  'HORIZONTAL',
  'STAIRCASE',
  'VERTICAL_SHAFT',
  'LADDER',
  'BRIDGE',
  'DROP',
  'CLIMB',
  'SWIM',
  'CAVE_PASSAGE',
];

export class TopologyStore {
  readonly worldId: string;

  private readonly history: TopologyHistorySource;
  private readonly limits: ResolvedLimits;
  private readonly nodeMap = new Map<string, SpatialNode>();
  private readonly edgeMap = new Map<string, StoredEdge>();
  /** node id → edge ids that reference it (for location-update and delete guards). */
  private readonly nodeToEdgeIds = new Map<string, Set<string>>();

  constructor(history: TopologyHistorySource, options: TopologyStoreOptions = {}) {
    this.worldId = history.worldId;
    this.history = history;
    this.limits = resolveLimits(options);
  }

  // --- nodes ---

  /**
   * Insert a node, or no-op when the same id + content is re-delivered. Same id
   * with different content is a conflict (use `updateNode` to change it). Agent
   * and program nodes draw on separate quotas.
   */
  saveNode(node: SpatialNode): SaveResult {
    const snapshot = snapshotNode(this.worldId, node);
    const existing = this.nodeMap.get(node.id);
    if (existing !== undefined) {
      if (nodesEqual(existing, snapshot)) return { status: 'unchanged' };
      throw new Error(`node "${node.id}" already exists with different content`);
    }
    const capacity =
      snapshot.source === 'agent' ? this.limits.maxAgentNodes : this.limits.maxProgramNodes;
    if (this.countNodes(snapshot.source) >= capacity) {
      throw new Error(
        `node capacity for source "${snapshot.source}" (${capacity}) reached; nothing was written`,
      );
    }
    this.nodeMap.set(node.id, snapshot);
    return { status: 'inserted' };
  }

  /**
   * Explicitly change an existing node. Identity (`id`/`worldId`/`dim`/`source`)
   * is immutable; omitted fields keep their value, and an explicitly-`undefined`
   * `tag`/`label` clears them. Changing `location` is rejected while any edge
   * references the node; a same-value location update stays idempotent.
   */
  updateNode(id: string, changes: NodeChanges): SaveResult {
    const existing = this.nodeMap.get(id);
    if (existing === undefined) {
      throw new Error(`unknown node "${id}"`);
    }
    const merged = applyNodeChanges(existing, changes);
    if (!locationsEqual(existing.location, merged.location) && this.nodeToEdgeIds.get(id)?.size) {
      throw new Error(`node "${id}" is referenced by an edge; remove the edges before changing location`);
    }
    const snapshot = snapshotNode(this.worldId, merged);
    if (nodesEqual(existing, snapshot)) return { status: 'unchanged' };
    this.nodeMap.set(id, snapshot);
    return { status: 'updated' };
  }

  /** Read a node by id (deep-copied snapshot), or `null` when absent. */
  getNode(id: string): SpatialNode | null {
    const node = this.nodeMap.get(id);
    return node === undefined ? null : cloneNode(node);
  }

  /** Delete a node. Refused while any edge references it; unknown id is a no-op. */
  forgetNode(id: string): void {
    const refs = this.nodeToEdgeIds.get(id);
    if (refs !== undefined && refs.size > 0) {
      throw new Error(`node "${id}" is referenced by ${refs.size} edge(s); remove them first`);
    }
    this.nodeMap.delete(id);
    this.nodeToEdgeIds.delete(id);
  }

  /** Paginated, read-only node listing (id-ordered, exclusive cursor, clamped limit). */
  nodes(query: NodeQuery = {}): NodePage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const ids = [...this.nodeMap.keys()]
      .filter((id) => {
        const node = this.nodeMap.get(id)!;
        if (query.dim !== undefined && node.dim !== query.dim) return false;
        if (query.source !== undefined && node.source !== query.source) return false;
        if (query.tag !== undefined && node.tag !== query.tag) return false;
        if (query.label !== undefined && node.label !== query.label) return false;
        return true;
      })
      .sort();
    const { pageIds, nextAfter } = selectPage(ids, query.after, limit);
    return {
      items: pageIds.map((id) => cloneNode(this.nodeMap.get(id)!)),
      total: ids.length,
      nextAfter,
    };
  }

  // --- edges ---

  /**
   * Insert a directed edge, or no-op on an idempotent re-delivery. A `traversed`
   * edge re-validates every evidence reference against the authoritative history;
   * a `candidate` edge must not cite any evidence.
   */
  saveEdge(edge: TopologyEdge): SaveResult {
    const shape = this.validateEdgeShape(edge);
    const refs = this.resolveRefs(edge, shape.fromPos, shape.toPos, shape.dim);
    const stored = this.assembleStoredEdge(edge, refs);
    const existing = this.edgeMap.get(edge.id);
    if (existing !== undefined) {
      if (storedEdgesEqual(existing, stored)) return { status: 'unchanged' };
      throw new Error(`edge "${edge.id}" already exists with different content`);
    }
    if (this.edgeMap.size >= this.limits.maxEdges) {
      throw new Error(`edge capacity ${this.limits.maxEdges} reached; nothing was written`);
    }
    this.edgeMap.set(edge.id, stored);
    this.indexEdge(stored);
    return { status: 'inserted' };
  }

  /**
   * Explicitly change an existing edge. `id`/`from`/`to` are immutable. Only an
   * explicit rebind — providing `evidenceIds` — re-resolves the evidence and
   * replaces the binding snapshots; an empty update or an update of unrelated
   * fields (`type`/`source`/`fragmentId`/`basis`) preserves the existing binding,
   * so a re-imported-but-different evidence record stays `mismatch` rather than
   * being silently re-bound to `resolved`.
   */
  updateEdge(id: string, changes: EdgeChanges): SaveResult {
    const existing = this.edgeMap.get(id);
    if (existing === undefined) {
      throw new Error(`unknown edge "${id}"`);
    }
    const rebind = 'evidenceIds' in changes;
    const merged = applyEdgeChanges(existing, changes);
    const shape = this.validateEdgeShape(merged);
    const refs = rebind
      ? this.resolveRefs(merged, shape.fromPos, shape.toPos, shape.dim)
      : this.preservedRefs(merged, existing);
    const stored = this.assembleStoredEdge(merged, refs);
    if (storedEdgesEqual(existing, stored)) return { status: 'unchanged' };
    this.edgeMap.set(id, stored);
    return { status: 'updated' };
  }

  /** Read an edge by id with its reference resolution, or `null` when absent. */
  getEdge(id: string): EdgeView | null {
    const stored = this.edgeMap.get(id);
    return stored === undefined ? null : this.toEdgeView(stored);
  }

  /**
   * Delete an edge record and its node-reference indices only. It never deletes
   * fragments or traversal evidence from the history store; unknown id is a no-op.
   */
  forgetEdge(id: string): void {
    const stored = this.edgeMap.get(id);
    if (stored === undefined) return;
    this.edgeMap.delete(id);
    this.unindexEdge(stored);
  }

  /**
   * Paginated, read-only edge listing. Each item re-resolves its (finite) evidence
   * references against the history store; a dangling edge is still returned with a
   * missing/mismatch status rather than dropped.
   */
  edges(query: EdgeQuery = {}): EdgePage {
    const limit = clampLimit(query.limit, this.limits.maxQueryBatch);
    const ids = [...this.edgeMap.keys()]
      .filter((id) => {
        const edge = this.edgeMap.get(id)!;
        if (query.dim !== undefined) {
          const from = this.nodeMap.get(edge.from);
          if (from === undefined || from.dim !== query.dim) return false;
        }
        if (query.from !== undefined && edge.from !== query.from) return false;
        if (query.to !== undefined && edge.to !== query.to) return false;
        if (query.type !== undefined && edge.type !== query.type) return false;
        if (query.basis !== undefined && edge.basis !== query.basis) return false;
        return true;
      })
      .sort();
    const { pageIds, nextAfter } = selectPage(ids, query.after, limit);
    return {
      items: pageIds.map((id) => this.toEdgeView(this.edgeMap.get(id)!)),
      total: ids.length,
      nextAfter,
    };
  }

  // --- internals ---

  private countNodes(source: NodeSource): number {
    let count = 0;
    for (const node of this.nodeMap.values()) if (node.source === source) count += 1;
    return count;
  }

  private validateEdgeShape(edge: TopologyEdge): { fromPos: Vec3Like; toPos: Vec3Like; dim: string } {
    if (typeof edge.id !== 'string' || edge.id.length === 0) {
      throw new Error(`edge id must be a non-empty string`);
    }
    if (edge.type === 'PORTAL') {
      throw new Error(`PORTAL edges are not supported in this phase`);
    }
    if (!NON_PORTAL_CONNECTION_TYPES.includes(edge.type)) {
      throw new Error(`edge type "${String(edge.type)}" is not a known connection type`);
    }
    if (edge.basis !== 'candidate' && edge.basis !== 'traversed') {
      throw new Error(`edge basis "${String(edge.basis)}" is not known (candidate|traversed)`);
    }
    if (typeof edge.from !== 'string' || edge.from.length === 0) {
      throw new Error(`edge from must be a non-empty node id`);
    }
    if (typeof edge.to !== 'string' || edge.to.length === 0) {
      throw new Error(`edge to must be a non-empty node id`);
    }
    if (edge.fragmentId !== undefined && (typeof edge.fragmentId !== 'string' || edge.fragmentId.length === 0)) {
      throw new Error(`edge fragmentId must be a non-empty string when present`);
    }
    if (edge.source !== undefined && (typeof edge.source !== 'string' || edge.source.length === 0)) {
      throw new Error(`edge source must be a non-empty string when present`);
    }

    const fromNode = this.nodeMap.get(edge.from);
    const toNode = this.nodeMap.get(edge.to);
    if (fromNode === undefined) {
      throw new Error(`edge references unknown node "${edge.from}"`);
    }
    if (toNode === undefined) {
      throw new Error(`edge references unknown node "${edge.to}"`);
    }
    if (fromNode.dim !== toNode.dim) {
      throw new Error(`edge endpoints span dimensions "${fromNode.dim}" and "${toNode.dim}"`);
    }
    if (fromNode.location.kind !== 'exact' || toNode.location.kind !== 'exact') {
      throw new Error(`edge endpoints must be exact locations, not regions`);
    }
    return { fromPos: fromNode.location.pos, toPos: toNode.location.pos, dim: fromNode.dim };
  }

  private resolveRefs(
    edge: TopologyEdge,
    fromPos: Vec3Like,
    toPos: Vec3Like,
    dim: string,
  ): StoredEvidenceRef[] {
    const evidenceIds = edge.evidenceIds ?? [];
    if (!Array.isArray(evidenceIds)) {
      throw new Error(`edge evidenceIds must be an array`);
    }
    if (edge.basis === 'candidate') {
      if (evidenceIds.length !== 0) {
        throw new Error(`candidate edges must not reference traversal evidence`);
      }
      return [];
    }
    if (evidenceIds.length === 0) {
      throw new Error(`traversed edges must reference at least one traversal evidence`);
    }
    if (evidenceIds.length > this.limits.maxEdgeEvidenceRefs) {
      throw new Error(
        `edge references ${evidenceIds.length} evidence, exceeding ${this.limits.maxEdgeEvidenceRefs}`,
      );
    }
    // Iterate by index rather than `map`: `map` skips holes, so a sparse array
    // would silently pass the length check while resolving no evidence. Visiting
    // each index makes every hole surface as a non-string id and be rejected.
    const refs: StoredEvidenceRef[] = [];
    for (let i = 0; i < evidenceIds.length; i++) {
      refs.push(this.resolveEvidenceRef(evidenceIds[i], edge.fragmentId, fromPos, toPos, dim));
    }
    return refs;
  }

  /** Reuse the existing binding when the update does not rebind evidence. */
  private preservedRefs(merged: TopologyEdge, existing: StoredEdge): StoredEvidenceRef[] {
    if (merged.basis === 'candidate') return [];
    if (existing.refs.length === 0) {
      throw new Error(`traversed edges must reference at least one traversal evidence`);
    }
    // Even without rebinding, a changed `fragmentId` must stay consistent with the
    // bound evidence; otherwise an unrelated update could point the edge at a
    // fragment the evidence never belonged to.
    if (merged.fragmentId !== undefined) {
      for (const ref of existing.refs) {
        if (ref.snapshot.fragmentId !== merged.fragmentId) {
          throw new Error(
            `edge fragmentId "${merged.fragmentId}" does not match evidence fragment "${ref.snapshot.fragmentId}"`,
          );
        }
      }
    }
    return existing.refs;
  }

  private assembleStoredEdge(edge: TopologyEdge, refs: StoredEvidenceRef[]): StoredEdge {
    const stored: StoredEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      basis: edge.basis,
      refs,
    };
    if (edge.fragmentId !== undefined) stored.fragmentId = edge.fragmentId;
    if (edge.source !== undefined) stored.source = edge.source;
    return stored;
  }

  private resolveEvidenceRef(
    evidenceId: string | undefined,
    edgeFragmentId: string | undefined,
    fromPos: Vec3Like,
    toPos: Vec3Like,
    dim: string,
  ): StoredEvidenceRef {
    if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
      throw new Error(`edge evidence id must be a non-empty string`);
    }
    const evidence = this.history.getTraversal(evidenceId);
    if (evidence === null) {
      throw new Error(`edge references unknown traversal evidence "${evidenceId}"`);
    }
    const fragment = this.history.getFragment(evidence.fragmentId);
    if (fragment === null) {
      throw new Error(`edge evidence "${evidenceId}" references unknown fragment "${evidence.fragmentId}"`);
    }
    if (evidence.worldId !== this.worldId) {
      throw new Error(`edge evidence "${evidenceId}" worldId does not match store worldId`);
    }
    if (fragment.worldId !== this.worldId || fragment.dim !== dim) {
      throw new Error(`edge evidence "${evidenceId}" fragment world/dim does not match`);
    }
    if (evidence.dim !== dim) {
      throw new Error(`edge evidence "${evidenceId}" dim does not match endpoint dim`);
    }
    if (!pointsEqual(evidence.from, fromPos) || !pointsEqual(evidence.to, toPos)) {
      throw new Error(`edge evidence "${evidenceId}" endpoints do not match edge from→to`);
    }
    if (edgeFragmentId !== undefined && edgeFragmentId !== evidence.fragmentId) {
      throw new Error(`edge fragmentId "${edgeFragmentId}" does not match evidence fragment "${evidence.fragmentId}"`);
    }
    return { evidenceId, snapshot: cloneTraversalEvidence(evidence) };
  }

  private toEdgeView(stored: StoredEdge): EdgeView {
    const references = stored.refs.map((ref) => this.resolveRef(ref));
    let resolution: ReferenceStatus | null = null;
    if (stored.basis === 'traversed') {
      if (references.some((ref) => ref.status === 'missing')) resolution = 'missing';
      else if (references.some((ref) => ref.status === 'mismatch')) resolution = 'mismatch';
      else resolution = 'resolved';
    }
    return {
      id: stored.id,
      from: stored.from,
      to: stored.to,
      type: stored.type,
      fragmentId: stored.fragmentId,
      basis: stored.basis,
      source: stored.source,
      evidenceIds: stored.refs.map((ref) => ref.evidenceId),
      references,
      resolution,
    };
  }

  private resolveRef(ref: StoredEvidenceRef): EdgeReference {
    const current = this.history.getTraversal(ref.evidenceId);
    if (current === null) {
      return {
        evidenceId: ref.evidenceId,
        status: 'missing',
        snapshot: cloneTraversalEvidence(ref.snapshot),
        current: null,
      };
    }
    // Re-check the owning fragment, not just the traversal record: a history source
    // that does not cascade (unlike FragmentStore) may still serve a traversal whose
    // fragment is gone or whose scope has drifted. Either case must not read as resolved.
    const fragment = this.history.getFragment(current.fragmentId);
    if (fragment === null) {
      return {
        evidenceId: ref.evidenceId,
        status: 'missing',
        snapshot: cloneTraversalEvidence(ref.snapshot),
        current: cloneTraversalEvidence(current),
      };
    }
    if (fragment.worldId !== this.worldId || fragment.dim !== current.dim) {
      return {
        evidenceId: ref.evidenceId,
        status: 'mismatch',
        snapshot: cloneTraversalEvidence(ref.snapshot),
        current: cloneTraversalEvidence(current),
      };
    }
    const matches = traversalEvidenceEqual(current, ref.snapshot);
    return {
      evidenceId: ref.evidenceId,
      status: matches ? 'resolved' : 'mismatch',
      snapshot: cloneTraversalEvidence(ref.snapshot),
      current: cloneTraversalEvidence(current),
    };
  }

  private indexEdge(stored: StoredEdge): void {
    addToNodeEdgeIndex(this.nodeToEdgeIds, stored.from, stored.id);
    addToNodeEdgeIndex(this.nodeToEdgeIds, stored.to, stored.id);
  }

  private unindexEdge(stored: StoredEdge): void {
    removeFromNodeEdgeIndex(this.nodeToEdgeIds, stored.from, stored.id);
    removeFromNodeEdgeIndex(this.nodeToEdgeIds, stored.to, stored.id);
  }
}

// --- validation + snapshotting (snapshot first, then write, so a failed write leaves no half state) ---

function snapshotNode(worldId: string, n: SpatialNode): SpatialNode {
  if (n.worldId !== worldId) {
    throw new Error(`node worldId "${n.worldId}" does not match store worldId "${worldId}"`);
  }
  if (typeof n.id !== 'string' || n.id.length === 0) {
    throw new Error(`node id must be a non-empty string`);
  }
  if (typeof n.dim !== 'string' || n.dim.length === 0) {
    throw new Error(`node dim must be a non-empty string`);
  }
  if (!NODE_KINDS.includes(n.kind)) {
    throw new Error(`node kind "${String(n.kind)}" is not a known kind`);
  }
  if (!NODE_SOURCES.includes(n.source)) {
    throw new Error(`node source "${String(n.source)}" is not a known source`);
  }
  if (n.tag !== undefined && !LANDMARK_TAGS.includes(n.tag)) {
    throw new Error(`node tag "${String(n.tag)}" is not a known tag`);
  }
  if (n.label !== undefined && typeof n.label !== 'string') {
    throw new Error(`node label must be a string when present`);
  }
  validateLocation(n.location);
  return cloneNode(n);
}

function validateLocation(loc: SpatialNode['location']): void {
  if (loc === null || typeof loc !== 'object') {
    throw new Error(`node location must be an exact or region object`);
  }
  const kind = (loc as { kind: unknown }).kind;
  if (kind === 'exact') {
    assertFinitePoint((loc as { pos: Vec3Like }).pos, 'node exact position');
    return;
  }
  if (kind === 'region') {
    const region = loc as { center: Vec3Like; radius: number };
    assertFinitePoint(region.center, 'node region center');
    if (!Number.isFinite(region.radius) || region.radius < 0) {
      throw new Error(`node region radius must be a non-negative finite number: ${region.radius}`);
    }
    return;
  }
  throw new Error(`node location kind "${String(kind)}" is not known`);
}

function cloneNode(n: SpatialNode): SpatialNode {
  return {
    id: n.id,
    kind: n.kind,
    source: n.source,
    tag: n.tag,
    label: n.label,
    worldId: n.worldId,
    dim: n.dim,
    location: cloneLocation(n.location),
  };
}

function cloneLocation(loc: SpatialNode['location']): SpatialNode['location'] {
  if (loc.kind === 'exact') {
    return { kind: 'exact', pos: clonePoint(loc.pos) };
  }
  return { kind: 'region', center: clonePoint(loc.center), radius: loc.radius };
}

function nodesEqual(a: SpatialNode, b: SpatialNode): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.tag === b.tag &&
    a.label === b.label &&
    a.worldId === b.worldId &&
    a.dim === b.dim &&
    locationsEqual(a.location, b.location)
  );
}

function locationsEqual(a: SpatialNode['location'], b: SpatialNode['location']): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') {
    return pointsEqual(a.pos, b.pos);
  }
  if (a.kind === 'region' && b.kind === 'region') {
    return pointsEqual(a.center, b.center) && a.radius === b.radius;
  }
  return false;
}

function applyNodeChanges(existing: SpatialNode, changes: NodeChanges): SpatialNode {
  return {
    id: existing.id,
    worldId: existing.worldId,
    dim: existing.dim,
    source: existing.source,
    kind: 'kind' in changes ? (changes.kind as NodeKind) : existing.kind,
    tag: 'tag' in changes ? changes.tag : existing.tag,
    label: 'label' in changes ? changes.label : existing.label,
    location: 'location' in changes ? (changes.location as SpatialNode['location']) : existing.location,
  };
}

function storedEdgesEqual(a: StoredEdge, b: StoredEdge): boolean {
  return (
    a.id === b.id &&
    a.from === b.from &&
    a.to === b.to &&
    a.type === b.type &&
    a.fragmentId === b.fragmentId &&
    a.basis === b.basis &&
    a.source === b.source &&
    refsEqual(a.refs, b.refs)
  );
}

function refsEqual(a: StoredEvidenceRef[], b: StoredEvidenceRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (ref, i) =>
      ref.evidenceId === b[i]!.evidenceId &&
      traversalEvidenceEqual(ref.snapshot, b[i]!.snapshot),
  );
}

function applyEdgeChanges(existing: StoredEdge, changes: EdgeChanges): TopologyEdge {
  return {
    id: existing.id,
    from: existing.from,
    to: existing.to,
    type: 'type' in changes ? (changes.type as ConnectionType) : existing.type,
    fragmentId: 'fragmentId' in changes ? changes.fragmentId : existing.fragmentId,
    basis: 'basis' in changes ? (changes.basis as EdgeBasis) : existing.basis,
    source: 'source' in changes ? changes.source : existing.source,
    evidenceIds: 'evidenceIds' in changes ? (changes.evidenceIds ?? []) : existing.refs.map((ref) => ref.evidenceId),
  };
}

function clonePoint(p: Vec3Like): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function assertFinitePoint(p: Vec3Like, label: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    throw new Error(`${label} must have finite coordinates: (${p.x}, ${p.y}, ${p.z})`);
  }
}

function addToNodeEdgeIndex(index: Map<string, Set<string>>, nodeId: string, edgeId: string): void {
  let set = index.get(nodeId);
  if (set === undefined) {
    set = new Set();
    index.set(nodeId, set);
  }
  set.add(edgeId);
}

function removeFromNodeEdgeIndex(
  index: Map<string, Set<string>>,
  nodeId: string,
  edgeId: string,
): void {
  const set = index.get(nodeId);
  if (set === undefined) return;
  set.delete(edgeId);
  if (set.size === 0) index.delete(nodeId);
}

function resolveLimits(options: TopologyStoreOptions): ResolvedLimits {
  const limits: ResolvedLimits = { ...DEFAULT_LIMITS };
  const overrides: (keyof ResolvedLimits)[] = [
    'maxAgentNodes',
    'maxProgramNodes',
    'maxEdges',
    'maxEdgeEvidenceRefs',
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

/** Select one page from an ascending-sorted id list; `after` is exclusive. */
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
