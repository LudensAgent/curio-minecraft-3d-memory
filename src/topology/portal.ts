/**
 * Portal connections (design §5).
 *
 * A portal is a connection with historical traversal evidence, not a walk edge.
 * It may join two different dimensions (or two far-apart points in one). It is
 * deliberately kept out of the walk graph: `TopologyStore.edges`,
 * `adjacency`, `route` and `reachable` never see portal edges.
 *
 * Only *observed* endpoint coordinates are stored. Coordinate scaling (e.g. the
 * Nether 8:1 ratio) is never applied to derive a route or an edge.
 */

import type { EdgeDirection } from './graph.js';

/** One raw portal traversal. Outbound and return records are kept separately. */
export interface PortalTraversalEvidence {
  /** Stable identity; re-delivering the same id+content is idempotent. */
  id: string;
  /** Owning portal edge. */
  edgeId: string;
  /** `forward` = from→to, `reverse` = to→from. */
  direction: EdgeDirection;
  /** Session the traversal actually happened in. */
  sessionId: string;
  /** Real traversal time; never a receive time or save batch. */
  observedAt: number;
  /** Host observation ids that witnessed the traversal. */
  observationIds: string[];
  /** Caller-supplied provenance label; opaque to the library. */
  source: string;
  /** Execution identity that performed the traversal, when the caller knows it. */
  executionId?: string;
  /** Host action id for a confirmed own-action effect, when known. */
  actionId?: string;
}

/** Caller input for an explicit portal edge. Endpoints may live in different dimensions. */
export interface PortalEdgeInput {
  id: string;
  from: string;
  to: string;
  /** Provenance association only. */
  fragmentId?: string;
  source?: string;
  /**
   * `false` (the default for portals) means both directions may be traversed;
   * each still needs its own raw traversal evidence. `true` keeps one direction.
   */
  directed?: boolean;
}

/** Read projection of one portal edge; `returnVerified` is derived, never stored. */
export interface PortalEdgeView {
  id: string;
  from: string;
  to: string;
  fromDim: string;
  toDim: string;
  directed: boolean;
  fragmentId?: string;
  source?: string;
  /** Raw evidence in insertion order. */
  traversals: PortalTraversalEvidence[];
  outbound: PortalTraversalEvidence[];
  return: PortalTraversalEvidence[];
  /**
   * Derived at read time: true only when at least one reverse traversal cites a
   * real session, time and observation id. There is no stored flag to drift.
   */
  returnVerified: boolean;
}

export function clonePortalTraversal(t: PortalTraversalEvidence): PortalTraversalEvidence {
  const clone: PortalTraversalEvidence = {
    id: t.id,
    edgeId: t.edgeId,
    direction: t.direction,
    sessionId: t.sessionId,
    observedAt: t.observedAt,
    observationIds: [...t.observationIds],
    source: t.source,
  };
  if (t.executionId !== undefined) clone.executionId = t.executionId;
  if (t.actionId !== undefined) clone.actionId = t.actionId;
  return clone;
}

export function portalTraversalsEqual(
  a: PortalTraversalEvidence,
  b: PortalTraversalEvidence,
): boolean {
  return (
    a.id === b.id &&
    a.edgeId === b.edgeId &&
    a.direction === b.direction &&
    a.sessionId === b.sessionId &&
    a.observedAt === b.observedAt &&
    a.source === b.source &&
    a.executionId === b.executionId &&
    a.actionId === b.actionId &&
    a.observationIds.length === b.observationIds.length &&
    a.observationIds.every((id, i) => id === b.observationIds[i])
  );
}

/** Validate and copy raw portal traversal evidence. */
export function snapshotPortalTraversal(raw: PortalTraversalEvidence): PortalTraversalEvidence {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`portal traversal id must be a non-empty string`);
  }
  if (typeof raw.edgeId !== 'string' || raw.edgeId.length === 0) {
    throw new Error(`portal traversal edgeId must be a non-empty string`);
  }
  if (raw.direction !== 'forward' && raw.direction !== 'reverse') {
    throw new Error(`portal traversal direction "${String(raw.direction)}" is not known`);
  }
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) {
    throw new Error(`portal traversal sessionId must be a non-empty string`);
  }
  if (!Number.isFinite(raw.observedAt) || raw.observedAt < 0) {
    throw new Error(`portal traversal observedAt must be a non-negative finite number`);
  }
  if (!Array.isArray(raw.observationIds)) {
    throw new Error(`portal traversal observationIds must be an array`);
  }
  for (let i = 0; i < raw.observationIds.length; i++) {
    const id = raw.observationIds[i];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`portal traversal observationIds must contain non-empty strings`);
    }
  }
  if (typeof raw.source !== 'string' || raw.source.length === 0) {
    throw new Error(`portal traversal source must be a non-empty string`);
  }
  if (raw.executionId !== undefined && (typeof raw.executionId !== 'string' || raw.executionId.length === 0)) {
    throw new Error(`portal traversal executionId must be a non-empty string when present`);
  }
  if (raw.actionId !== undefined && (typeof raw.actionId !== 'string' || raw.actionId.length === 0)) {
    throw new Error(`portal traversal actionId must be a non-empty string when present`);
  }
  return clonePortalTraversal(raw);
}

/** Derived return verification: raw reverse evidence with at least one observation id. */
export function portalReturnVerified(traversals: PortalTraversalEvidence[]): boolean {
  return traversals.some((t) => t.direction === 'reverse' && t.observationIds.length > 0);
}
