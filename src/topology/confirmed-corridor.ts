/**
 * Atomic confirmed-corridor writes (design §3.1/§5; Batch 5 A).
 *
 * A confirmed corridor is the set of facts produced by one actually-walked
 * passage: the fragment geometry, one `TraversalEvidence` per confirmed segment,
 * the exact endpoint nodes, and one `traversed` edge per segment. Writing those
 * facts through the per-record APIs is not atomic: a node update can be refused
 * by an edge guard after the fragment and traversals were already written, or an
 * edge can be rejected after its node was moved.
 *
 * `writeConfirmedCorridor` validates the whole corridor first, then writes it
 * inside nested in-memory transactions. Any failure restores both stores, so the
 * receipt can always say `committed: 'none'`; there is no partial-prefix state to
 * reason about or retry around.
 *
 * Coordinate contract
 * -------------------
 * Edge evidence must match node endpoints exactly. Measured feet positions carry
 * float jitter, so a cell-keyed node that is re-observed at a slightly different
 * exact position cannot be represented by one exact node. Callers choose one
 * canonical spec for the whole corridor:
 *
 * - `exact` (default): every node and traversal endpoint is used verbatim. This
 *   is the right choice when the caller already supplies stable exact points.
 * - `cell`: node positions and traversal endpoints are floored to the integer
 *   block cell before validation and storage. This makes repeated observations
 *   of the same block cell produce identical endpoints. It is an explicit
 *   conversion, not a tolerant comparison: the stored fact *is* the cell
 *   coordinate, and raw measured positions must be retained elsewhere if the
 *   caller needs sub-cell precision.
 *
 * Nothing is snapped by proximity. Two different ids at two different positions
 * remain two nodes; a node id whose exact position changed while an edge outside
 * this corridor still references it is rejected, never rebased.
 */

import type { PathFragment, TraversalEvidence } from './path-fragment.js';
import type { ConnectionType, NodeKind, NodeSource, SpatialNode } from './graph.js';
import type { FragmentStore, SaveResult } from './fragment-store.js';
import type { TopologyEdge, TopologyStore } from './topology-store.js';
import type { MoveMode, Vec3Like } from '../types.js';

/** Canonical coordinate spec for one corridor write. */
export type CorridorCoordinateMode = 'exact' | 'cell';

/** One exact endpoint node in a confirmed corridor. */
export interface ConfirmedCorridorNode {
  id: string;
  /** Measured endpoint position; floored when `coordinate` is `cell`. */
  pos: Vec3Like;
  kind: NodeKind;
  /** `program` by default: corridor nodes are derived, not durable agent places. */
  source?: NodeSource;
  observedAt?: number;
}

/** One directed edge backed by the corridor's confirmed traversals. */
export interface ConfirmedCorridorEdge {
  id: string;
  from: string;
  to: string;
  type: ConnectionType;
  evidenceIds: string[];
  modes?: MoveMode[];
  directed?: boolean;
  /** Owning fragment; defaults to `input.fragment.id`. */
  fragmentId?: string;
  source?: string;
}

/** Everything one actually-confirmed corridor contributes to history. */
export interface ConfirmedCorridorInput {
  fragment: PathFragment;
  /** Exactly the segments that were confirmed; never plan points or unconfirmed motion. */
  traversals: TraversalEvidence[];
  nodes: ConfirmedCorridorNode[];
  edges: ConfirmedCorridorEdge[];
  /** The session the traversals actually happened in. Required and matched exactly. */
  sessionId: string;
  coordinate?: CorridorCoordinateMode;
}

export type CorridorWriteProblemKind =
  | 'invalid_request'
  | 'scope_mismatch'
  | 'duplicate_id'
  | 'endpoint_mismatch'
  | 'node_referenced'
  | 'identity_conflict'
  | 'evidence_conflict'
  | 'capacity'
  | 'internal';

/** A structured, caller-actionable reason the whole corridor was not written. */
export interface CorridorWriteProblem {
  kind: CorridorWriteProblemKind;
  detail: string;
  nodeId?: string;
  edgeId?: string;
  evidenceId?: string;
  externalEdgeIds?: string[];
}

export interface CorridorWriteReceipt {
  /** `written` = at least one fact changed; `unchanged` = exact idempotent re-delivery. */
  status: 'written' | 'unchanged' | 'rejected';
  /** Atomic by contract: `all` on success, `none` on rejection. */
  committed: 'all' | 'none';
  fragmentId: string;
  problem?: CorridorWriteProblem;
  fragments: { inserted: string[]; unchanged: string[] };
  traversals: { inserted: string[]; unchanged: string[] };
  nodes: { inserted: string[]; updated: string[]; unchanged: string[] };
  edges: { inserted: string[]; updated: string[]; unchanged: string[] };
}

interface PlannedNode {
  node: SpatialNode;
  pos: Vec3Like;
  existing: SpatialNode | null;
  moved: boolean;
}

interface PlannedEdge {
  edge: TopologyEdge;
  existing: TopologyEdge | null;
  replace: boolean;
}

/**
 * Write one confirmed corridor atomically. The fragment and every traversal must
 * share `input.fragment.id`, `worldId` and `dim`; every traversal must name the
 * given `sessionId`. All edge endpoints must be present in `input.nodes`, and
 * every edge evidence id must resolve to an input traversal or to an already
 * stored traversal whose endpoints match the edge exactly.
 *
 * Throwing is reserved for programmer errors in the arguments' structure; all
 * world/evidence conflicts are returned as `status:'rejected'` with
 * `committed:'none'`.
 */
export function writeConfirmedCorridor(
  history: FragmentStore,
  topology: TopologyStore,
  input: ConfirmedCorridorInput,
): CorridorWriteReceipt {
  const empty = (problem: CorridorWriteProblem): CorridorWriteReceipt => ({
    status: 'rejected',
    committed: 'none',
    fragmentId: emptyId(input.fragment?.id),
    problem,
    fragments: { inserted: [], unchanged: [] },
    traversals: { inserted: [], unchanged: [] },
    nodes: { inserted: [], updated: [], unchanged: [] },
    edges: { inserted: [], updated: [], unchanged: [] },
  });

  const mode = input.coordinate ?? 'exact';
  const canonical = mode === 'cell' ? canonicalCellPoint : clonePoint;

  // --- scope and shape -------------------------------------------------------
  if (history.worldId !== topology.worldId) {
    return empty({
      kind: 'scope_mismatch',
      detail: `history worldId "${history.worldId}" and topology worldId "${topology.worldId}" differ`,
    });
  }
  const fragment = input.fragment;
  if (fragment === undefined || fragment === null) {
    return empty({ kind: 'invalid_request', detail: 'a confirmed corridor requires a fragment' });
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    return empty({ kind: 'invalid_request', detail: 'a confirmed corridor requires a non-empty sessionId' });
  }
  if (fragment.worldId !== history.worldId) {
    return empty({
      kind: 'scope_mismatch',
      detail: `fragment worldId "${fragment.worldId}" does not match store worldId "${history.worldId}"`,
    });
  }
  if (typeof fragment.dim !== 'string' || fragment.dim.length === 0) {
    return empty({ kind: 'invalid_request', detail: 'fragment dim must be a non-empty string' });
  }
  if (!Array.isArray(input.traversals) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    return empty({ kind: 'invalid_request', detail: 'traversals, nodes and edges must be arrays' });
  }

  const nodes: PlannedNode[] = [];
  const nodeById = new Map<string, PlannedNode>();
  for (const candidate of input.nodes) {
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      return empty({ kind: 'invalid_request', detail: 'every corridor node requires a non-empty id' });
    }
    if (!isFinitePoint(candidate.pos)) {
      return empty({
        kind: 'invalid_request',
        detail: `node "${candidate.id}" position must have finite coordinates`,
        nodeId: candidate.id,
      });
    }
    const pos = canonical(candidate.pos);
    const duplicate = nodeById.get(candidate.id);
    if (duplicate !== undefined) {
      // A corridor may revisit the same canonical cell. Identical endpoints are
      // one node; a second position for the same id is ambiguous, not a merge.
      if (pointsEqual(duplicate.pos, pos)) continue;
      return empty({
        kind: 'duplicate_id',
        detail: `node id "${candidate.id}" appears with two different positions`,
        nodeId: candidate.id,
      });
    }
    const existing = topology.getNode(candidate.id);
    if (existing !== null && (existing.worldId !== history.worldId || existing.dim !== fragment.dim)) {
      return empty({
        kind: 'scope_mismatch',
        detail: `node "${candidate.id}" is bound to ${existing.worldId}/${existing.dim}, not ${history.worldId}/${fragment.dim}`,
        nodeId: candidate.id,
      });
    }
    if (existing !== null && existing.location.kind !== 'exact') {
      return empty({
        kind: 'identity_conflict',
        detail: `node "${candidate.id}" is a region node and cannot be an edge endpoint`,
        nodeId: candidate.id,
      });
    }
    const source: NodeSource = candidate.source ?? 'program';
    const node: SpatialNode = {
      id: candidate.id,
      kind: candidate.kind,
      source,
      worldId: history.worldId,
      dim: fragment.dim,
      location: { kind: 'exact', pos },
    };
    if (candidate.observedAt !== undefined) node.observedAt = candidate.observedAt;
    if (existing !== null) node.source = existing.source;
    const existingPos = existing !== null && existing.location.kind === 'exact'
      ? existing.location.pos
      : null;
    const planned: PlannedNode = {
      node,
      pos,
      existing,
      moved: existingPos !== null && !pointsEqual(existingPos, pos),
    };
    nodes.push(planned);
    nodeById.set(planned.node.id, planned);
  }

  // --- traversals ------------------------------------------------------------
  const traversalIds = new Set<string>();
  const inputTraversals = new Map<string, TraversalEvidence>();
  for (const raw of input.traversals) {
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      return empty({ kind: 'invalid_request', detail: 'every traversal requires a non-empty id' });
    }
    if (traversalIds.has(raw.id)) {
      return empty({ kind: 'duplicate_id', detail: `traversal id "${raw.id}" appears more than once`, evidenceId: raw.id });
    }
    traversalIds.add(raw.id);
    if (raw.fragmentId !== fragment.id) {
      return empty({
        kind: 'scope_mismatch',
        detail: `traversal "${raw.id}" belongs to fragment "${raw.fragmentId}", not "${fragment.id}"`,
        evidenceId: raw.id,
      });
    }
    if (raw.worldId !== history.worldId || raw.dim !== fragment.dim) {
      return empty({
        kind: 'scope_mismatch',
        detail: `traversal "${raw.id}" scope ${raw.worldId}/${raw.dim} does not match ${history.worldId}/${fragment.dim}`,
        evidenceId: raw.id,
      });
    }
    if (raw.sessionId !== input.sessionId) {
      return empty({
        kind: 'scope_mismatch',
        detail: `traversal "${raw.id}" sessionId ${String(raw.sessionId)} does not match corridor session "${input.sessionId}"`,
        evidenceId: raw.id,
      });
    }
    if (!isFinitePoint(raw.from) || !isFinitePoint(raw.to)) {
      return empty({
        kind: 'invalid_request',
        detail: `traversal "${raw.id}" endpoints must have finite coordinates`,
        evidenceId: raw.id,
      });
    }
    const canonicalTraversal: TraversalEvidence = {
      ...raw,
      from: canonical(raw.from),
      to: canonical(raw.to),
    };
    inputTraversals.set(raw.id, canonicalTraversal);
  }

  // --- edges -----------------------------------------------------------------
  const plannedEdges: PlannedEdge[] = [];
  const edgeIds = new Set<string>();
  const plannedEdgeIds = new Set(input.edges.map((edge) => edge.id));
  for (const raw of input.edges) {
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      return empty({ kind: 'invalid_request', detail: 'every corridor edge requires a non-empty id' });
    }
    if (edgeIds.has(raw.id)) {
      return empty({ kind: 'duplicate_id', detail: `edge id "${raw.id}" appears more than once`, edgeId: raw.id });
    }
    edgeIds.add(raw.id);
    if (raw.type === 'PORTAL') {
      return empty({
        kind: 'identity_conflict',
        detail: `edge "${raw.id}" is PORTAL; portal edges are stored separately`,
        edgeId: raw.id,
      });
    }
    const from = nodeById.get(raw.from);
    const to = nodeById.get(raw.to);
    if (from === undefined || to === undefined) {
      return empty({
        kind: 'invalid_request',
        detail: `edge "${raw.id}" endpoints must both appear in the corridor nodes`,
        edgeId: raw.id,
      });
    }
    if (raw.evidenceIds.length === 0) {
      return empty({
        kind: 'invalid_request',
        detail: `traversed edge "${raw.id}" requires at least one evidence id`,
        edgeId: raw.id,
      });
    }
    for (const evidenceId of raw.evidenceIds) {
      const evidence = inputTraversals.get(evidenceId) ?? history.getTraversal(evidenceId);
      if (evidence === null || evidence === undefined) {
        return empty({
          kind: 'endpoint_mismatch',
          detail: `edge "${raw.id}" references unknown traversal evidence "${evidenceId}"`,
          edgeId: raw.id,
          evidenceId,
        });
      }
      if (evidence.worldId !== history.worldId || evidence.dim !== fragment.dim) {
        return empty({
          kind: 'scope_mismatch',
          detail: `edge evidence "${evidenceId}" scope does not match the corridor`,
          edgeId: raw.id,
          evidenceId,
        });
      }
      if (
        !pointsEqual(evidence.from, from.pos)
        || !pointsEqual(evidence.to, to.pos)
      ) {
        return empty({
          kind: 'endpoint_mismatch',
          detail: `edge evidence "${evidenceId}" endpoints do not match edge "${raw.id}" from→to`,
          edgeId: raw.id,
          evidenceId,
        });
      }
    }
    const edge: TopologyEdge = {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      type: raw.type,
      basis: 'traversed',
      evidenceIds: [...raw.evidenceIds],
    };
    if (raw.modes !== undefined) edge.modes = [...raw.modes];
    if (raw.directed !== undefined) edge.directed = raw.directed;
    const owner = raw.fragmentId ?? fragment.id;
    if (owner !== fragment.id) {
      return empty({
        kind: 'identity_conflict',
        detail: `edge "${raw.id}" fragmentId "${owner}" differs from corridor fragment "${fragment.id}"`,
        edgeId: raw.id,
      });
    }
    edge.fragmentId = owner;
    if (raw.source !== undefined) edge.source = raw.source;
    const existingEdge = topology.getEdge(raw.id);
    if (existingEdge !== null && (existingEdge.from !== raw.from || existingEdge.to !== raw.to)) {
      return empty({
        kind: 'identity_conflict',
        detail: `edge "${raw.id}" already exists with different endpoints; edge ids are immutable`,
        edgeId: raw.id,
      });
    }
    plannedEdges.push({
      edge,
      existing: existingEdge,
      replace: existingEdge !== null && !edgeContentEquals(existingEdge, edge),
    });
  }

  // A moved node may only be rebased when every edge that references it belongs
  // to this corridor. External edges are reported by id; they are never removed
  // or re-pointed by this call.
  for (const entry of nodes) {
    if (!entry.moved) continue;
    const references = topology.incidentEdgeIds(entry.node.id);
    const external = references.filter((id) => !plannedEdgeIds.has(id));
    const portalReferences = topology.incidentPortalEdgeIds(entry.node.id);
    if (external.length > 0 || portalReferences.length > 0) {
      return empty({
        kind: 'node_referenced',
        detail: `node "${entry.node.id}" changed position while referenced by external edge(s); nothing was written`,
        nodeId: entry.node.id,
        externalEdgeIds: [...external, ...portalReferences],
      });
    }
  }

  // --- commit ----------------------------------------------------------------
  const receipt: CorridorWriteReceipt = {
    status: 'unchanged',
    committed: 'all',
    fragmentId: fragment.id,
    fragments: { inserted: [], unchanged: [] },
    traversals: { inserted: [], unchanged: [] },
    nodes: { inserted: [], updated: [], unchanged: [] },
    edges: { inserted: [], updated: [], unchanged: [] },
  };

  try {
    history.runAtomic(() => topology.runAtomic(() => {
      recordSave(receipt.fragments, history.saveFragment(fragment), fragment.id);

      for (const traversal of inputTraversals.values()) {
        recordSave(receipt.traversals, history.addTraversal(traversal), traversal.id);
      }

      // Drop corridor-owned edges before relocating their nodes: the node guard
      // answers "is any edge still pointing at the old endpoint", and every such
      // edge here is being rewritten with the new endpoint.
      for (const planned of plannedEdges) {
        if (planned.existing !== null && (planned.replace || nodeMoved(planned, nodes))) {
          topology.forgetEdge(planned.edge.id);
        }
      }

      for (const planned of nodes) {
        if (planned.existing === null) {
          topology.saveNode(planned.node);
          receipt.nodes.inserted.push(planned.node.id);
          continue;
        }
        const changes: Parameters<TopologyStore['updateNode']>[1] = {
          kind: planned.node.kind,
        };
        if (planned.node.observedAt !== undefined) changes.observedAt = planned.node.observedAt;
        if (planned.moved) changes.location = planned.node.location;
        const result = topology.updateNode(planned.node.id, changes);
        if (planned.moved || result.status === 'updated') receipt.nodes.updated.push(planned.node.id);
        else receipt.nodes.unchanged.push(planned.node.id);
      }

      for (const planned of plannedEdges) {
        topology.saveEdge(planned.edge);
        if (planned.existing === null) receipt.edges.inserted.push(planned.edge.id);
        else if (planned.replace || nodeMoved(planned, nodes)) receipt.edges.updated.push(planned.edge.id);
        else receipt.edges.unchanged.push(planned.edge.id);
      }
    }));
  } catch (error) {
    return empty(classifyWriteError(error));
  }

  const changed = receipt.fragments.inserted.length > 0
    || receipt.traversals.inserted.length > 0
    || receipt.nodes.inserted.length > 0
    || receipt.nodes.updated.length > 0
    || receipt.edges.inserted.length > 0
    || receipt.edges.updated.length > 0;
  receipt.status = changed ? 'written' : 'unchanged';
  return receipt;
}

/** Floor a measured point to its integer block cell (explicit coordinate conversion). */
export function canonicalCellPoint(pos: Vec3Like): Vec3Like {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

/** Stable text key for a canonical block cell. */
export function canonicalCellKey(pos: Vec3Like): string {
  const cell = canonicalCellPoint(pos);
  return `${cell.x},${cell.y},${cell.z}`;
}

function nodeMoved(edge: PlannedEdge, nodes: readonly PlannedNode[]): boolean {
  return nodes.some((entry) => entry.moved && (entry.node.id === edge.edge.from || entry.node.id === edge.edge.to));
}

function recordSave(
  bucket: { inserted: string[]; unchanged: string[] },
  result: SaveResult,
  id: string,
): void {
  if (result.status === 'inserted') bucket.inserted.push(id);
  else bucket.unchanged.push(id);
}

function edgeContentEquals(existing: TopologyEdge, next: TopologyEdge): boolean {
  return existing.from === next.from
    && existing.to === next.to
    && existing.type === next.type
    && existing.basis === next.basis
    && (existing.fragmentId ?? undefined) === (next.fragmentId ?? undefined)
    && (existing.source ?? undefined) === (next.source ?? undefined)
    && (existing.directed ?? true) === (next.directed ?? true)
    && sameStrings(existing.evidenceIds, next.evidenceIds)
    && sameStrings(existing.modes ?? [], next.modes ?? []);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function classifyWriteError(error: unknown): CorridorWriteProblem {
  const detail = error instanceof Error ? error.message : String(error);
  if (/capacity/i.test(detail)) return { kind: 'capacity', detail };
  if (/referenced by|portal edge/i.test(detail)) return { kind: 'node_referenced', detail };
  if (/already exists with different content|already used|already exists/i.test(detail)) {
    return { kind: 'identity_conflict', detail };
  }
  if (/does not match|unknown traversal|unknown fragment|unknown node/i.test(detail)) {
    return { kind: 'endpoint_mismatch', detail };
  }
  return { kind: 'internal', detail };
}

function pointsEqual(a: Vec3Like, b: Vec3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function clonePoint(pos: Vec3Like): Vec3Like {
  return { x: pos.x, y: pos.y, z: pos.z };
}

function isFinitePoint(pos: Vec3Like | undefined): boolean {
  return pos !== undefined
    && Number.isFinite(pos.x)
    && Number.isFinite(pos.y)
    && Number.isFinite(pos.z);
}

function emptyId(value: string | undefined): string {
  return typeof value === 'string' ? value : '';
}
