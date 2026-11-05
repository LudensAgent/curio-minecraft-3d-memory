/**
 * Runtime edge state (design §5): per-direction, per-mode verification.
 *
 * Edges are historical records. Their current passage status is a derived cache
 * stored beside the record:
 *
 * - one verification per `(direction, mode)` pair;
 * - `OPEN` is only fresh while `validUntil > now` — an expired `OPEN` reads as
 *   `STALE` and is never treated as passable;
 * - forward verification never backs the reverse direction, even when the edge
 *   is undirected. An undirected edge just means both directions may each have
 *   their own evidence and verification.
 *
 * Nothing here deletes a `PathFragment` or a traversal record.
 */

import type {
  EdgeDependency,
  EdgeDirection,
  EdgeVerification,
  EdgeVerificationStatus,
} from './graph.js';
import { MOVE_MODES } from './path-fragment.js';
import { cloneObservation } from '../observation/index.js';
import type { HazardFact, ObstacleEvidence } from '../traversability/types.js';
import type { MoveMode } from '../types.js';

/** Caller-facing verification input; omitted optional evidence defaults explicitly. */
export interface EdgeVerificationInput {
  /** Defaults to `forward`; `reverse` is rejected on a directed edge. */
  direction?: EdgeDirection;
  mode: MoveMode;
  status: EdgeVerificationStatus;
  reason?: string;
  blockedAt?: ObstacleEvidence;
  hazards?: HazardFact[];
  dependencies?: EdgeDependency[];
  contextKey?: string;
  sessionId?: string;
  computedAt: number;
  validUntil: number;
}

/** Minimal structural shape needed to resolve a direction/mode. */
export interface EdgeRuntimeShape {
  directed: boolean;
  modes: MoveMode[];
  verifications: EdgeVerification[];
}

/** Per-mode current status of one direction. */
export interface EdgeModeState {
  mode: MoveMode;
  status: EdgeVerificationStatus;
  /** True when an explicit verification record exists for this direction+mode. */
  verified: boolean;
  /** True only for a still-fresh `OPEN`. */
  fresh: boolean;
  blocked: boolean;
  verification: EdgeVerification | null;
}

/** Current status of one direction, with every mode reported separately. */
export interface EdgeDirectionState {
  direction: EdgeDirection;
  /** False for the reverse of a directed edge (there is no reverse direction). */
  supported: boolean;
  modes: EdgeModeState[];
  /** Aggregate over modes: `BLOCKED` wins, then `STALE`, then `OPEN`, else `UNKNOWN`. */
  status: EdgeVerificationStatus;
  blocked: boolean;
}

/** Runtime view of one edge; never a claim about the walk graph's history. */
export interface EdgeRuntimeView {
  edgeId: string;
  directed: boolean;
  now: number;
  forward: EdgeDirectionState;
  reverse: EdgeDirectionState;
}

/** Why a direction+mode is or is not usable for a bounded/historical search. */
export type EdgeUsabilityReason =
  | 'blocked'
  | 'stale'
  | 'unsupported'
  | 'mode_mismatch'
  | 'no_direction';

export interface EdgeUsability {
  usable: boolean;
  reason?: EdgeUsabilityReason;
  /** The fresh `OPEN` verification that authorizes the current link, when one exists. */
  verification?: EdgeVerification;
}

const EDGE_DIRECTIONS: readonly EdgeDirection[] = ['forward', 'reverse'];
const EDGE_STATUSES: readonly EdgeVerificationStatus[] = [
  'OPEN',
  'BLOCKED',
  'UNKNOWN',
  'STALE',
  'UNSUPPORTED',
];

export function resolveEdgeDirected(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error(`edge directed must be a boolean when present`);
  }
  return value;
}

export function snapshotEdgeModes(value: MoveMode[] | undefined): MoveMode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`edge modes must be an array`);
  }
  const seen = new Set<MoveMode>();
  return value.flatMap((mode) => {
    if (!(MOVE_MODES as readonly string[]).includes(mode)) {
      throw new Error(`edge mode "${String(mode)}" is not a known movement mode`);
    }
    if (seen.has(mode)) return [];
    seen.add(mode);
    return [mode];
  });
}

export function cloneEdgeVerification(v: EdgeVerification): EdgeVerification {
  const clone: EdgeVerification = {
    direction: v.direction,
    mode: v.mode,
    status: v.status,
    hazards: v.hazards.map((h) => ({ ...h, pos: { x: h.pos.x, y: h.pos.y, z: h.pos.z } })),
    dependencies: v.dependencies.map((d) => ({ key: { ...d.key }, revision: d.revision })),
    contextKey: v.contextKey,
    sessionId: v.sessionId,
    computedAt: v.computedAt,
    validUntil: v.validUntil,
  };
  if (v.reason !== undefined) clone.reason = v.reason;
  if (v.blockedAt !== undefined) clone.blockedAt = cloneObstacleEvidence(v.blockedAt);
  return clone;
}

function cloneObstacleEvidence(e: ObstacleEvidence): ObstacleEvidence {
  if (e.kind === 'contact') {
    return {
      kind: 'contact',
      pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
      observedAt: e.observedAt,
      sessionId: e.sessionId,
    };
  }
  return { kind: 'block', observation: cloneObservation(e.observation) };
}

export function edgeVerificationsEqual(a: EdgeVerification[], b: EdgeVerification[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => edgeVerificationEqual(v, b[i]!));
}

function edgeVerificationEqual(a: EdgeVerification, b: EdgeVerification): boolean {
  return (
    a.direction === b.direction &&
    a.mode === b.mode &&
    a.status === b.status &&
    a.reason === b.reason &&
    a.contextKey === b.contextKey &&
    a.sessionId === b.sessionId &&
    a.computedAt === b.computedAt &&
    a.validUntil === b.validUntil &&
    obstacleEvidenceEqual(a.blockedAt, b.blockedAt) &&
    JSON.stringify(a.hazards) === JSON.stringify(b.hazards) &&
    JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies)
  );
}

function obstacleEvidenceEqual(
  a: ObstacleEvidence | undefined,
  b: ObstacleEvidence | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate and normalize one verification. `now` is the store's clock at write
 * time: an `OPEN` record must be fresh right now (`validUntil > now`,
 * `computedAt <= now`) and must cite a session and body context. `BLOCKED`
 * requires obstacle evidence. A directed edge has no reverse direction, so a
 * reverse verification is rejected there.
 */
export function snapshotEdgeVerification(
  raw: EdgeVerificationInput,
  now: number,
  directed: boolean,
  options: { allowExpiredOpen?: boolean } = {},
): EdgeVerification {
  const direction = raw.direction ?? 'forward';
  if (!EDGE_DIRECTIONS.includes(direction)) {
    throw new Error(`edge verification direction "${String(direction)}" is not known`);
  }
  if (direction === 'reverse' && directed) {
    throw new Error(`a directed edge has no reverse verification`);
  }
  if (!(MOVE_MODES as readonly string[]).includes(raw.mode)) {
    throw new Error(`edge verification mode "${String(raw.mode)}" is not a known movement mode`);
  }
  if (!EDGE_STATUSES.includes(raw.status)) {
    throw new Error(`edge verification status "${String(raw.status)}" is not known`);
  }
  if (!Number.isFinite(raw.computedAt)) {
    throw new Error(`edge verification computedAt must be finite: ${raw.computedAt}`);
  }
  if (!Number.isFinite(raw.validUntil)) {
    throw new Error(`edge verification validUntil must be finite: ${raw.validUntil}`);
  }
  if (raw.validUntil < raw.computedAt) {
    throw new Error(`edge verification validUntil must not precede computedAt`);
  }
  if (raw.status === 'OPEN') {
    if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) {
      throw new Error(`an OPEN edge verification must cite a session`);
    }
    if (typeof raw.contextKey !== 'string' || raw.contextKey.length === 0) {
      throw new Error(`an OPEN edge verification must cite a contextKey`);
    }
    const dependencies = raw.dependencies ?? [];
    if (!Array.isArray(dependencies)) {
      throw new Error(`edge verification dependencies must be an array`);
    }
    if (!options.allowExpiredOpen) {
      if (raw.computedAt > now) {
        throw new Error(`an OPEN edge verification cannot be computed in the future`);
      }
      if (raw.validUntil <= now) {
        throw new Error(`an OPEN edge verification must still be fresh (validUntil > now)`);
      }
    }
    if (raw.blockedAt !== undefined) {
      throw new Error(`an OPEN edge verification must not carry blockedAt evidence`);
    }
  }
  if (raw.status === 'BLOCKED' && raw.blockedAt === undefined) {
    throw new Error(`a BLOCKED edge verification must carry blockedAt evidence`);
  }
  if (raw.status !== 'BLOCKED' && raw.blockedAt !== undefined) {
    throw new Error(`only a BLOCKED edge verification may carry blockedAt evidence`);
  }
  if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) {
    throw new Error(`edge verification dependencies must be an array`);
  }
  // Empty session/context metadata means "unknown" for non-OPEN records; an OPEN
  // record is required above to cite both.
  if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string') {
    throw new Error(`edge verification sessionId must be a string when present`);
  }
  if (raw.contextKey !== undefined && typeof raw.contextKey !== 'string') {
    throw new Error(`edge verification contextKey must be a string when present`);
  }

  const verification: EdgeVerification = {
    direction,
    mode: raw.mode,
    status: raw.status,
    hazards: (raw.hazards ?? []).map((h) => ({ ...h, pos: { x: h.pos.x, y: h.pos.y, z: h.pos.z } })),
    dependencies: (raw.dependencies ?? []).map((d) => ({ key: { ...d.key }, revision: d.revision })),
    contextKey: raw.contextKey ?? '',
    sessionId: raw.sessionId ?? '',
    computedAt: raw.computedAt,
    validUntil: raw.validUntil,
  };
  if (raw.reason !== undefined) verification.reason = raw.reason;
  if (raw.blockedAt !== undefined) verification.blockedAt = cloneObstacleEvidence(raw.blockedAt);
  return verification;
}

/** All modes worth reporting for an edge: known modes plus recorded candidate/verified ones. */
export function edgeDirectionModes(edge: EdgeRuntimeShape): MoveMode[] {
  const seen = new Set<MoveMode>(MOVE_MODES);
  for (const mode of edge.modes) seen.add(mode);
  for (const verification of edge.verifications) seen.add(verification.mode);
  return [...seen];
}

/** Current status of one direction+mode. Never returns `OPEN` for expired evidence. */
export function modeState(
  edge: EdgeRuntimeShape,
  direction: EdgeDirection,
  mode: MoveMode,
  now: number,
): EdgeModeState {
  if (direction === 'reverse' && edge.directed) {
    return { mode, status: 'UNSUPPORTED', verified: false, fresh: false, blocked: false, verification: null };
  }
  const verification = findVerification(edge.verifications, direction, mode);
  if (verification === null) {
    const structurallySupported = edge.modes.length === 0 || edge.modes.includes(mode);
    return {
      mode,
      status: structurallySupported ? 'UNKNOWN' : 'UNSUPPORTED',
      verified: false,
      fresh: false,
      blocked: false,
      verification: null,
    };
  }
  const status = effectiveStatus(verification, now);
  return {
    mode,
    status,
    verified: true,
    fresh: status === 'OPEN',
    blocked: status === 'BLOCKED',
    verification,
  };
}

export function directionState(
  edge: EdgeRuntimeShape,
  direction: EdgeDirection,
  now: number,
): EdgeDirectionState {
  const supported = !(direction === 'reverse' && edge.directed);
  const modes = edgeDirectionModes(edge).map((mode) => modeState(edge, direction, mode, now));
  const statuses = modes.map((m) => m.status);
  const status: EdgeVerificationStatus = !supported
    ? 'UNSUPPORTED'
    : statuses.includes('BLOCKED')
      ? 'BLOCKED'
      : statuses.includes('STALE')
        ? 'STALE'
        : statuses.includes('OPEN')
          ? 'OPEN'
          : statuses.every((s) => s === 'UNSUPPORTED')
            ? 'UNSUPPORTED'
            : 'UNKNOWN';
  return {
    direction,
    supported,
    modes,
    status,
    blocked: statuses.includes('BLOCKED'),
  };
}

export function runtimeView(edgeId: string, edge: EdgeRuntimeShape, now: number): EdgeRuntimeView {
  return {
    edgeId,
    directed: edge.directed,
    now,
    forward: directionState(edge, 'forward', now),
    reverse: directionState(edge, 'reverse', now),
  };
}

/**
 * Usability of one direction for historical routing. Absence of any verification
 * keeps the historical result usable, but never means "currently OPEN" — the
 * separate runtime view reports `UNKNOWN` for that. An explicit non-fresh
 * verification excludes the link until a fresh `OPEN` replaces it.
 */
export function directionUsability(
  edge: EdgeRuntimeShape,
  direction: EdgeDirection,
  mode: MoveMode | undefined,
  now: number,
): EdgeUsability {
  if (direction === 'reverse' && edge.directed) {
    return { usable: false, reason: 'no_direction' };
  }
  if (mode !== undefined && edge.modes.length > 0 && !edge.modes.includes(mode)) {
    return { usable: false, reason: 'mode_mismatch' };
  }
  const matching = edge.verifications.filter((v) => v.direction === direction);
  if (mode !== undefined) {
    const verification = findVerification(matching, mode);
    return classify(matching.filter((v) => v.mode === mode), verification, now);
  }
  // No mode filter: a fresh OPEN for any mode keeps the edge usable; otherwise an
  // explicit BLOCKED/stale/unsupported record excludes it.
  if (matching.length === 0) return { usable: true };
  const freshOpen = matching.find((v) => effectiveStatus(v, now) === 'OPEN');
  if (freshOpen !== undefined) return { usable: true, verification: freshOpen };
  if (matching.some((v) => effectiveStatus(v, now) === 'BLOCKED')) {
    return { usable: false, reason: 'blocked' };
  }
  if (matching.some((v) => effectiveStatus(v, now) === 'UNSUPPORTED')) {
    return { usable: false, reason: 'unsupported' };
  }
  return { usable: false, reason: 'stale' };
}

function classify(
  all: EdgeVerification[],
  verification: EdgeVerification | null,
  now: number,
): EdgeUsability {
  if (verification === null) {
    return all.length === 0 ? { usable: true } : { usable: false, reason: 'stale' };
  }
  const status = effectiveStatus(verification, now);
  if (status === 'BLOCKED') return { usable: false, reason: 'blocked' };
  if (status === 'OPEN') return { usable: true, verification };
  if (status === 'UNSUPPORTED') return { usable: false, reason: 'unsupported' };
  return { usable: false, reason: 'stale' };
}

/** Effective status now: a recorded `BLOCKED` stays until explicitly cleared. */
export function effectiveStatus(v: EdgeVerification, now: number): EdgeVerificationStatus {
  if (v.status === 'OPEN') return v.validUntil > now ? 'OPEN' : 'STALE';
  return v.status;
}

function findVerification(
  verifications: EdgeVerification[],
  direction: EdgeDirection,
  mode: MoveMode,
): EdgeVerification | null;
function findVerification(verifications: EdgeVerification[], mode: MoveMode): EdgeVerification | null;
function findVerification(
  verifications: EdgeVerification[],
  directionOrMode: EdgeDirection | MoveMode,
  maybeMode?: MoveMode,
): EdgeVerification | null {
  const direction = maybeMode === undefined ? undefined : (directionOrMode as EdgeDirection);
  const mode = maybeMode === undefined ? (directionOrMode as MoveMode) : maybeMode;
  for (let i = verifications.length - 1; i >= 0; i--) {
    const v = verifications[i]!;
    if (v.mode !== mode) continue;
    if (direction !== undefined && v.direction !== direction) continue;
    return v;
  }
  return null;
}

/** Replace the single `(direction, mode)` record, preserving any other pairs. */
export function withVerification(
  verifications: EdgeVerification[],
  next: EdgeVerification,
): EdgeVerification[] {
  const replaced = verifications.filter(
    (v) => !(v.direction === next.direction && v.mode === next.mode),
  );
  replaced.push(next);
  return replaced;
}
