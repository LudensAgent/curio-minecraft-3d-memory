/**
 * Bounded voxel A* extracted from the host's observed-voxel land search.
 * The heap, support-surface expansion and cooperative search remain here;
 * host geometry data, risk policy, body control and permanent history do not.
 */
import type { BlockState, Vec3Like } from '../types.js';
import type { CollisionShapeProvider, NeighborCellView, NeighborRead } from '../traversability/collision-shape.js';
import {
  evaluateLandTransition,
  evaluateRememberedLandTransition,
  resolveLandLimits,
} from '../traversability/land-transition.js';
import type { LandLimits, LandRules } from '../traversability/land-transition.js';
import { evaluateRememberedWalkStep, evaluateWalkStep, evaluateWalkTo } from '../traversability/step.js';
import { MAX_STEP_RISE } from '../traversability/land-geometry.js';
import type { BodyContext } from '../traversability/step.js';
import type { HazardFact } from '../traversability/types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { VoxelMap } from '../voxel/voxel-map.js';
import { evidenceStale } from '../observation/freshness.js';

export type LandSearchKind = 'walk' | 'step' | 'drop' | 'jump' | 'ladder';
export type LandSearchArrival = { kind: 'exact' } | {
  kind: 'near';
  radius: number;
  /** Default continuous; cell measures Euclidean distance after flooring each coordinate. */
  coordinates?: 'continuous' | 'cell';
};
export type LandSearchStatus =
  | 'FOUND'
  | 'NO_PATH_IN_MEMORY'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNSUPPORTED'
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'INVALIDATED';
export type LandSearchBoundaryStatus = 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED' | 'INCOMPLETE';
export type LandSearchBudget = 'nodes' | 'edges' | 'reads' | 'sections' | 'points' | 'time' | 'geometry';
export const DEFAULT_LAND_SEARCH_MAX_NODES = 2048;
/** Eight walk neighbours plus step/drop candidates per node; keeps roughly the old node reach. */
export const DEFAULT_LAND_SEARCH_MAX_EDGES = 16384;

/**
 * Finite-width delegation limit around an observed start/corridor line. It is
 * not terrain evidence and never authorizes a move back into the corridor from
 * an out-of-corridor actual start.
 */
export interface LandSearchCorridor {
  origin: Vec3Like;
  /** Nonzero horizontal direction; copied and normalized at the request boundary. */
  bearing: { x: number; z: number };
  /** Maximum lateral distance from the infinite origin/bearing line, inclusive. */
  maxLateral: number;
}

export interface LandSearchRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  /** Original continuous feet target. Neither target nor start is centered or snapped. */
  to: Vec3Like;
  arrival?: LandSearchArrival;
  /**
   * Distance used by arrival and prefix ranking. Default 3d preserves the
   * caller's feet height; horizontal selects an observed standable height in
   * the target XZ column/radius without relaxing any transition geometry.
   */
  goalMetric?: '3d' | 'horizontal';
  rules: LandRules;
  /** Historical candidates use recorded geometry; they never become current OPEN proofs. */
  evidenceMode?: 'current' | 'remembered';
  allowed?: readonly LandSearchKind[];
  /** Candidate columns/actions outside this finite-width strip are not expanded. */
  corridor?: LandSearchCorridor;
  /**
   * Caller-owned admission/cost decision for geometrically OPEN edges. Without
   * it, search behavior, costs and diagnostics are unchanged.
   */
  edgePolicy?: LandSearchEdgePolicy;
  /** Total policy-read budget, independent of maxSurfaceReads. Default 131072. */
  maxPolicyReads?: number;
  /** Per-edge policy-read budget. Default 64. */
  maxPolicyReadsPerEdge?: number;
  /** Search range only, not a claim that a drop is safe or physically executable. Default 4. */
  maxDrop?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Candidate support/neighbor reads. Edge evaluation is bounded separately by geometryLimits and maxEdges. */
  maxSurfaceReads?: number;
  maxSections?: number;
  maxRoutePoints?: number;
  maxBoundaries?: number;
  maxSearchMs?: number;
  /** Shared absolute deadline; maxSearchMs still bounds this call. */
  deadlineMs?: number;
  maxSliceMs?: number;
  maxWorkPerSlice?: number;
  geometryLimits?: Partial<LandLimits>;
  /** Default distance uses every goal dimension; horizontal and zero remain available for comparison. */
  heuristic?: 'distance' | 'horizontal' | 'zero';
  signal?: AbortSignal;
  /** Budget clock; evidence freshness is evaluated at the entry point's `now` argument. */
  clock?: () => number;
  /** Optional offline visualizer hook, called in actual expansion order with a detached point. */
  onExpand?: (point: Readonly<Vec3Like>) => void;
}

export interface LandSearchTransition {
  kind: LandSearchKind;
  from: Vec3Like;
  to: Vec3Like;
  /**
   * Geometric search weight plus any caller edge-policy surcharge. These are
   * not elapsed time or risk estimates.
   */
  cost: number;
  hazards: HazardFact[];
}

/** One geometrically OPEN candidate offered to the caller's edge policy. */
export interface LandSearchPolicyEdge {
  kind: LandSearchKind;
  from: Readonly<Vec3Like>;
  to: Readonly<Vec3Like>;
  /** Geometric walk/step/drop cost before the caller's surcharge. */
  baseCost: number;
  hazards: readonly HazardFact[];
  evidenceMode: 'current' | 'remembered';
}

export type LandSearchPolicyDecision =
  | { allow: true; extraCost?: number }
  | { allow: false; reason: string };

/**
 * Recorded facts for a policy read. This is not geometry-OPEN proof and does
 * not claim freshness: `recorded` may be stale, foreign-session or incomplete.
 */
export type LandSearchPolicyCell =
  | { kind: 'recorded'; state: BlockState; stateComplete: boolean }
  | { kind: 'unknown' }
  | { kind: 'unavailable' };

/**
 * Bounded, read-only policy accessor scoped to the request world/dimension.
 * Valid only during the synchronous `evaluate` call that received it.
 */
export interface LandSearchPolicyRead {
  cell(x: number, y: number, z: number): LandSearchPolicyCell;
}

/**
 * Trusted synchronous caller policy. Like a shape provider it must perform
 * bounded work and must bump `version` whenever its behavior changes.
 */
export interface LandSearchEdgePolicy {
  version: string;
  evaluate(edge: LandSearchPolicyEdge, read: LandSearchPolicyRead): LandSearchPolicyDecision;
}

export interface LandSearchPolicyRejection {
  from: Vec3Like;
  to: Vec3Like;
  reason: string;
}

/** Fixed-size policy diagnostics; never an unbounded rejection list. */
export interface LandSearchPolicySummary {
  version: string;
  reads: number;
  rejectedEdges: number;
  /** One bounded example, never the prefix's known terrain blocker. */
  firstRejection?: LandSearchPolicyRejection;
}

export interface LandSearchBoundary {
  from: Vec3Like;
  to: Vec3Like;
  status: LandSearchBoundaryStatus;
  reason: string;
  /** Inclusive block Y bounds scanned under the candidate footprint when no support surface was found. */
  supportColumn?: { minY: number; maxY: number };
}

/**
 * Best current-evidence prefix reached before a non-FOUND stop. Every included
 * transition was evaluated `OPEN`; the endpoint is the closest actually reached
 * node by the requested goal metric. `atTarget` never means physical arrival.
 */
export interface LandSearchPrefix {
  endpoint: Vec3Like;
  /** Original start first; `points.length === transitions.length + 1`. */
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  /** Distance from `endpoint` to the original target under `goalMetric`. */
  distanceToTarget: number;
  /** The original exact/near completion predicate held at the endpoint. */
  atTarget: boolean;
  /** The endpoint is the untouched original start (zero transitions). */
  atStart: boolean;
  /** One real BLOCKED/UNSUPPORTED out-edge from the endpoint toward the target. */
  knownBlockerAhead?: LandSearchBoundary;
}

export interface LandSearchResult {
  status: LandSearchStatus;
  assurance: 'geometry_only' | 'historical_geometry';
  evidenceMode: 'current' | 'remembered';
  executable: false;
  /** Every candidate still needs current checks and measured body execution. */
  needsRevalidation: true;
  from: Vec3Like;
  target: Vec3Like;
  arrival: LandSearchArrival;
  goalMetric: '3d' | 'horizontal';
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  /** Sum of transition costs, including caller edge-policy surcharges. */
  cost: number;
  boundaries: LandSearchBoundary[];
  /** Present whenever an edge policy was supplied, including zero calls. */
  policy?: LandSearchPolicySummary;
  /**
   * Current-mode only. Present for non-FOUND results once a current start chain
   * is available; omitted for remembered searches, CANCELLED/INVALIDATED
   * results and stops that occur before any start node can be recorded.
   */
  prefix?: LandSearchPrefix;
  /** Candidates were excluded by `corridor`; it does not claim a route outside it. */
  corridorLimited?: true;
  /** Saved pages were not loaded implicitly; the caller can prepare them and retry. */
  unavailableSections: SectionKey[];
  reason: string;
  budget?: LandSearchBudget;
  evaluatedAt: number;
  stats: {
    nodesReached: number;
    nodesExpanded: number;
    edgesEvaluated: number;
    /**
     * Candidate support reads only; not evaluator-internal evidence reads and
     * not policy reads (reported separately in `result.policy.reads`).
     */
    surfaceReads: number;
    sectionsRead: number;
    staleReads: number;
    /** Candidate columns excluded before any map read by the corridor filter. */
    corridorSkipped: number;
    boundariesTruncated: boolean;
    durationMs: number;
    yieldCount: number;
    maxSyncSliceMs: number;
  };
}

const EPS = 1e-9;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
/**
 * Same-height diagonal walks. The swept body must clear both corner columns and
 * keep continuous support, so a diagonal never cuts a blocked or unknown corner.
 */
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
/** Exact 8-neighbour lattice distance for unit cardinal and √2 diagonal costs. */
const octile = (dx: number, dz: number): number => Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);

class LandSearchGeometryBudgetExceeded extends Error {}
/** Private sentinel: policy reads hit work/readability limits or stop state. */
class LandSearchPolicyAborted extends Error {}

function validatePolicyDecision(value: unknown): LandSearchPolicyDecision {
  if (typeof value !== 'object' || value === null || typeof (value as { allow?: unknown }).allow !== 'boolean') {
    throw new Error('land search edge policy must return an object with a boolean allow field');
  }
  const decision = value as { allow: boolean; extraCost?: unknown; reason?: unknown };
  if (decision.allow) {
    if (decision.extraCost !== undefined
      && (typeof decision.extraCost !== 'number' || !Number.isFinite(decision.extraCost) || decision.extraCost < 0)) {
      throw new Error('land search edge policy extraCost must be a finite nonnegative number');
    }
    return decision.extraCost === undefined ? { allow: true } : { allow: true, extraCost: decision.extraCost };
  }
  if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
    throw new Error('land search edge policy rejection requires a nonempty reason string');
  }
  return { allow: false, reason: decision.reason };
}

/** Heap entries carry their own g so superseded entries cannot expand newer nodes twice. */
class MinHeap {
  private readonly items: { key: string; g: number; f: number }[] = [];

  push(item: { key: string; g: number; f: number }): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]!.f <= this.items[index]!.f) break;
      [this.items[parent], this.items[index]] = [this.items[index]!, this.items[parent]!];
      index = parent;
    }
  }

  pop(): { key: string; g: number; f: number } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (first === undefined || last === undefined || this.items.length === 0) return first;
    this.items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < this.items.length && this.items[left]!.f < this.items[best]!.f) best = left;
      if (right < this.items.length && this.items[right]!.f < this.items[best]!.f) best = right;
      if (best === index) break;
      [this.items[index], this.items[best]] = [this.items[best]!, this.items[index]!];
      index = best;
    }
    return first;
  }

  get size(): number { return this.items.length; }
}

interface SearchNode {
  point: Vec3Like;
  g: number;
  parent: SearchNode | null;
  via: LandSearchTransition | null;
  /**
   * At most one real BLOCKED/UNSUPPORTED out-edge toward the target. Kept on
   * the bounded node so a truncated global boundary list cannot hide it.
   */
  blocker?: LandSearchBoundary;
}

function positive(value: number | undefined, fallback: number, label: string, integer = true): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || (integer && !Number.isSafeInteger(result))) {
    throw new Error(`${label} must be a positive ${integer ? 'safe integer' : 'finite number'}`);
  }
  return result;
}

function* searchChunks(
  map: VoxelMap,
  request: LandSearchRequest,
  now: number,
  cooperative: boolean,
): Generator<void, LandSearchResult, void> {
  request = { ...request, rules: { ...request.rules } };
  if (request.worldId !== map.worldId) throw new Error('land search worldId does not match the map');
  if (request.dim.length === 0 || request.sessionId.length === 0) throw new Error('land search requires dim and sessionId');
  const start = { ...request.body.feet };
  const target = { ...request.to };
  if (![start.x, start.y, start.z, target.x, target.y, target.z, now].every(Number.isFinite)) {
    throw new Error('land search positions and evaluation time must be finite');
  }
  if (![start.x, start.y, start.z, target.x, target.y, target.z].every((value) => Number.isSafeInteger(Math.floor(value)))) {
    throw new Error('land search coordinates must have safely representable block cells');
  }
  const body = { ...request.body, feet: start };
  if (!Number.isFinite(body.width) || body.width <= 0 || !Number.isFinite(body.height) || body.height <= 0 || body.pose !== 'standing') {
    throw new Error('land search requires a positive finite standing body');
  }
  const arrival = request.arrival === undefined ? { kind: 'exact' as const } : { ...request.arrival };
  if (arrival.kind !== 'exact' && (arrival.kind !== 'near' || !Number.isFinite(arrival.radius) || arrival.radius < 0)) {
    throw new Error('land search arrival must be exact or near with a finite nonnegative radius');
  }
  if (arrival.kind === 'near' && arrival.coordinates !== undefined
    && arrival.coordinates !== 'continuous' && arrival.coordinates !== 'cell') {
    throw new Error('land search near coordinates must be continuous or cell');
  }
  const goalMetric = request.goalMetric ?? '3d';
  if (goalMetric !== '3d' && goalMetric !== 'horizontal') throw new Error('unsupported land search goal metric');
  const evidenceMode = request.evidenceMode ?? 'current';
  if (evidenceMode !== 'current' && evidenceMode !== 'remembered') throw new Error('unsupported land search evidence mode');
  const heuristicMode = request.heuristic ?? 'distance';
  if (heuristicMode !== 'distance' && heuristicMode !== 'horizontal' && heuristicMode !== 'zero') throw new Error('unsupported land search heuristic');
  const allowed = new Set(request.allowed ?? ['walk', 'step', 'drop']);
  if ([...allowed].some((kind) => kind !== 'walk' && kind !== 'step' && kind !== 'drop' && kind !== 'jump' && kind !== 'ladder')) {
    throw new Error('land search supports walk, step, drop, jump and ladder geometry only');
  }
  // Validate, copy and normalize the corridor exactly once at the request
  // boundary so the hot expansion loop only compares finite numbers.
  let corridor: { origin: Vec3Like; bearing: { x: number; z: number }; maxLateral: number } | undefined;
  if (request.corridor !== undefined) {
    const { origin, bearing, maxLateral } = request.corridor;
    if (![origin?.x, origin?.y, origin?.z, bearing?.x, bearing?.z, maxLateral].every(Number.isFinite)) {
      throw new Error('land search corridor origin, bearing and maxLateral must be finite numbers');
    }
    if (maxLateral < 0) {
      throw new Error('land search corridor maxLateral must be nonnegative');
    }
    const length = Math.hypot(bearing.x, bearing.z);
    if (length === 0) throw new Error('land search corridor bearing must be nonzero');
    corridor = {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      bearing: { x: bearing.x / length, z: bearing.z / length },
      maxLateral,
    };
  }
  // Capture the trusted policy reference and version once, like shape rules.
  const edgePolicy = request.edgePolicy;
  const policyVersion = edgePolicy?.version;
  if (edgePolicy !== undefined && (typeof policyVersion !== 'string' || policyVersion.length === 0)) {
    throw new Error('land search edge policy requires a nonempty version');
  }
  const maxDrop = request.maxDrop ?? 4;
  if (!Number.isFinite(maxDrop) || maxDrop < 0) throw new Error('maxDrop must be finite and nonnegative');
  const maxNodes = positive(request.maxNodes, DEFAULT_LAND_SEARCH_MAX_NODES, 'maxNodes');
  const maxEdges = positive(request.maxEdges, DEFAULT_LAND_SEARCH_MAX_EDGES, 'maxEdges');
  const maxSurfaceReads = positive(request.maxSurfaceReads, 262144, 'maxSurfaceReads');
  const maxPolicyReads = positive(request.maxPolicyReads, 131072, 'maxPolicyReads');
  const maxPolicyReadsPerEdge = positive(request.maxPolicyReadsPerEdge, 64, 'maxPolicyReadsPerEdge');
  const maxSections = positive(request.maxSections, 1024, 'maxSections');
  const maxRoutePoints = positive(request.maxRoutePoints, 2048, 'maxRoutePoints');
  const maxBoundaries = positive(request.maxBoundaries, 64, 'maxBoundaries');
  const maxSearchMs = positive(request.maxSearchMs, 1500, 'maxSearchMs', false);
  const maxSliceMs = positive(request.maxSliceMs, 5, 'maxSliceMs', false);
  const maxWorkPerSlice = positive(request.maxWorkPerSlice, 32, 'maxWorkPerSlice');
  const geometryLimits = resolveLandLimits(request.geometryLimits);
  const ruleVersion = request.rules.shapeProvider.version;
  const jumpVersion = request.rules.jumpModel?.version;
  const climbVersion = request.rules.climbProvider?.version;
  if (ruleVersion.length === 0) throw new Error('land search shape rules require a nonempty version');
  const clock = request.clock ?? Date.now;
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) throw new Error('land search clock must return a finite time');
  if (request.deadlineMs !== undefined && !Number.isFinite(request.deadlineMs)) throw new Error('deadlineMs must be finite');
  const deadline = Math.min(request.deadlineMs ?? Infinity, startedAt + maxSearchMs);
  let sliceStart = startedAt;
  let sliceWork = 0;
  const stats = {
    nodesReached: 1, nodesExpanded: 0, edgesEvaluated: 0, surfaceReads: 0,
    sectionsRead: 0, staleReads: 0, corridorSkipped: 0, boundariesTruncated: false,
    durationMs: 0, yieldCount: 0, maxSyncSliceMs: 0,
  };
  const dependencies = new Map<string, { key: SectionKey; generation: number }>();
  const cellKeyOf = (point: Vec3Like): string => `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
  // Same-content observations leave current geometry unchanged, except when
  // they restore a cell this search already rejected as expired/stale. Keep
  // those read dependencies separate from Section content/residency changes.
  const refreshSensitiveCells = new Set<string>();
  const unavailable = new Map<string, SectionKey>();
  const boundaries: LandSearchBoundary[] = [];
  const counts = { UNKNOWN: 0, STALE: 0, BLOCKED: 0, UNSUPPORTED: 0, INCOMPLETE: 0 };
  let invalidated = false;
  let invalidatedReason = 'search dependency or provider version changed';
  let budget: LandSearchBudget | undefined;
  /** Precise non-terrain detail for a policy/read/section budget stop. */
  let budgetDetail: string | undefined;
  let policyReads = 0;
  let policyReadsThisEdge = 0;
  let policyRejectedEdges = 0;
  let policyFirstRejection: LandSearchPolicyRejection | undefined;
  // Continuous feet XZ, never centered block coordinates. The origin/bearing
  // were validated and normalized once at the request boundary.
  const corridorContains = (point: Vec3Like): boolean => corridor === undefined
    || Math.abs((point.x - corridor.origin.x) * corridor.bearing.z
      - (point.z - corridor.origin.z) * corridor.bearing.x) <= corridor.maxLateral + EPS;
  // Prefix selection uses the caller's goal distance, independently of the A*
  // heuristic. Directional goals do not impose an unobserved waypoint height.
  let closest: SearchNode | null = null;
  let closestMetric = Number.POSITIVE_INFINITY;
  const cellCoordinates = arrival.kind === 'near' && arrival.coordinates === 'cell';
  const coordinateDelta = (from: number, to: number): number => cellCoordinates
    ? Math.floor(from) - Math.floor(to) : from - to;
  const targetDistance = (point: Vec3Like): number =>
    Math.hypot(coordinateDelta(point.x, target.x), goalMetric === 'horizontal' ? 0 : coordinateDelta(point.y, target.y), coordinateDelta(point.z, target.z));
  const remainingMetric = (point: Vec3Like): number => arrival.kind === 'near'
    ? Math.max(0, targetDistance(point) - arrival.radius)
    : targetDistance(point);
  /**
   * Keep at most one real terrain/capability blocker per bounded node. Unknown,
   * stale, incomplete and corridor-skipped candidates are deliberately absent.
   */
  const noteBlocker = (
    node: SearchNode,
    to: Vec3Like,
    status: LandSearchBoundaryStatus,
    reason: string,
    supportColumn?: LandSearchBoundary['supportColumn'],
  ): void => {
    if (node.blocker !== undefined) return;
    if (status !== 'BLOCKED' && status !== 'UNSUPPORTED') return;
    if (!(remainingMetric(to) < remainingMetric(node.point))) return;
    node.blocker = { from: { ...node.point }, to: { ...to }, status, reason, ...(supportColumn && { supportColumn }) };
  };
  const stopped = (): LandSearchStatus | null => {
    if (request.signal?.aborted) return 'CANCELLED';
    if (invalidated) return 'INVALIDATED';
    if (clock() >= deadline) budget = 'time';
    return budget === undefined ? null : 'BUDGET_EXHAUSTED';
  };
  const boundary = (from: Vec3Like, to: Vec3Like, status: LandSearchBoundaryStatus, reason: string, supportColumn?: LandSearchBoundary['supportColumn']): void => {
    counts[status] += 1;
    if (boundaries.length < maxBoundaries) boundaries.push({ from: { ...from }, to: { ...to }, status, reason, ...(supportColumn && { supportColumn }) });
    else stats.boundariesTruncated = true;
  };
  const addDependency = (key: SectionKey): void => {
    const id = sectionKeyString(key);
    if (dependencies.has(id)) return;
    if (dependencies.size >= maxSections) { budget = 'sections'; return; }
    dependencies.set(id, { key: { ...key }, generation: map.residencyGeneration(key.dim, key.cx, key.cz, key.sy) });
    stats.sectionsRead = dependencies.size;
  };
  /**
   * Recorded-fact projection for the trusted policy. Never yields geometry-OPEN
   * proof or freshness, never loads cold pages, and participates in the same
   * Section dependencies/change subscription/generation check as geometry.
   */
  const policyRead: LandSearchPolicyRead = {
    cell(x, y, z): LandSearchPolicyCell {
      if (![x, y, z].every(Number.isSafeInteger)) {
        throw new Error('policy read coordinates must be safe integers');
      }
      if (stopped() !== null) throw new LandSearchPolicyAborted();
      if (policyReads >= maxPolicyReads) {
        budget = 'reads';
        budgetDetail = `policy reads exceeded maxPolicyReads (${maxPolicyReads})`;
        throw new LandSearchPolicyAborted();
      }
      if (policyReadsThisEdge >= maxPolicyReadsPerEdge) {
        budget = 'reads';
        budgetDetail = `policy reads exceeded maxPolicyReadsPerEdge (${maxPolicyReadsPerEdge}) on one edge`;
        throw new LandSearchPolicyAborted();
      }
      policyReads += 1;
      policyReadsThisEdge += 1;
      const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
      const key = { worldId: map.worldId, dim: request.dim, cx, cz, sy };
      addDependency(key);
      if (budget !== undefined) {
        budgetDetail ??= 'policy read reached maxSections';
        throw new LandSearchPolicyAborted();
      }
      const section = map.sectionRef(request.dim, x, y, z);
      if (section === null) {
        const residency = map.sectionResidency(key).residency;
        if (residency === 'not_resident' || residency === 'loading' || residency === 'load_failed') {
          unavailable.set(sectionKeyString(key), key);
          return { kind: 'unavailable' };
        }
        return { kind: 'unknown' };
      }
      const evidence = section.evidence.get(cellIndex(lx, ly, lz));
      if (evidence === undefined) return { kind: 'unknown' };
      const state = evidence.observation.state;
      return {
        kind: 'recorded',
        state: { name: state.name, properties: { ...state.properties } },
        stateComplete: evidence.observation.stateComplete,
      };
    },
  };
  const read: NeighborRead = {
    cell(x, y, z): NeighborCellView {
      if (![x, y, z].every(Number.isSafeInteger)) throw new Error('shape neighbor coordinates must be safe integers');
      const pos = { x, y, z };
      if (stats.surfaceReads >= maxSurfaceReads) { budget = 'reads'; return { pos, kind: 'unobserved' }; }
      stats.surfaceReads += 1;
      const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
      const key = { worldId: map.worldId, dim: request.dim, cx, cz, sy };
      addDependency(key);
      if (budget !== undefined) return { pos, kind: 'unobserved' };
      const section = map.sectionRef(request.dim, x, y, z);
      if (section === null) {
        const residency = map.sectionResidency(key).residency;
        if (residency === 'not_resident' || residency === 'loading' || residency === 'load_failed') {
          unavailable.set(sectionKeyString(key), key);
        }
        return { pos, kind: 'unobserved' };
      }
      const evidence = section.evidence.get(cellIndex(lx, ly, lz));
      if (evidence === undefined) return { pos, kind: 'unobserved' };
      const staleReason = evidenceStale(evidence) ? 'stale' : null;
      if (staleReason !== null) {
        stats.staleReads += 1;
        if (evidenceMode === 'current') {
          refreshSensitiveCells.add(cellKeyOf(pos));
          return { pos, kind: 'stale', reason: staleReason };
        }
      }
      if (!evidence.observation.stateComplete) return { pos, kind: 'incomplete' };
      const state = evidence.observation.state;
      return { pos, kind: 'observed', state: { name: state.name, properties: { ...state.properties } } };
    },
  };
  function* pause(): Generator<void, void, void> {
    sliceWork += 1;
    const at = clock();
    if (sliceWork < maxWorkPerSlice && at - sliceStart < maxSliceMs) return;
    stats.maxSyncSliceMs = Math.max(stats.maxSyncSliceMs, at - sliceStart);
    sliceWork = 0;
    if (cooperative) stats.yieldCount += 1;
    yield;
    if (cooperative) sliceStart = clock();
  }
  /** Support heights under the body footprint at one horizontal column. */
  function* columnSurfaces(
    x: number,
    z: number,
    fromY: number,
  ): Generator<void, { surfaces: Set<number>; gaps: Set<LandSearchBoundaryStatus>; minY: number; maxY: number }, void> {
    const half = body.width / 2;
    const surfaces = new Set<number>();
    const gaps = new Set<LandSearchBoundaryStatus>();
    const minY = Math.floor(fromY - maxDrop) - 1, maxY = Math.ceil(fromY + MAX_STEP_RISE);
    const scan = { surfaces, gaps, minY, maxY };
    // Candidate heights come from actual support faces under the body footprint.
    // No top-of-column shortcut merges a bridge with the cave below it.
    for (let bx = Math.floor(x - half + EPS); bx <= Math.floor(x + half - EPS); bx++) {
      for (let bz = Math.floor(z - half + EPS); bz <= Math.floor(z + half - EPS); bz++) {
        for (let by = minY; by <= maxY; by++) {
          if (stopped() !== null) return scan;
          const cell = read.cell(bx, by, bz);
          if (cell.kind === 'stale') gaps.add('STALE');
          if (cell.kind === 'unobserved' || cell.kind === 'incomplete') gaps.add('UNKNOWN');
          if (cell.kind === 'observed') {
            const resolution = request.rules.shapeProvider.resolve(cell.state, cell.pos, read);
            if (resolution.kind === 'shape') {
              if (resolution.shape.supportFaces.length > geometryLimits.maxSupportFaces
                || resolution.shape.boxes.length > geometryLimits.maxShapeBoxes) {
                budget = 'geometry';
                return scan;
              }
              for (const face of resolution.shape.supportFaces) {
                const y = by + face.top;
                if (y < fromY - maxDrop - EPS || y > fromY + MAX_STEP_RISE + EPS) continue;
                if (bx + face.maxX <= x - half + EPS || bx + face.minX >= x + half - EPS
                  || bz + face.maxZ <= z - half + EPS || bz + face.minZ >= z + half - EPS) continue;
                surfaces.add(Math.abs(y - fromY) <= EPS ? fromY : y);
              }
            } else if (resolution.kind === 'unsupported_shape') gaps.add('UNSUPPORTED');
            else gaps.add(resolution.view.kind === 'stale' ? 'STALE' : 'UNKNOWN');
          }
          yield* pause();
        }
      }
    }
    return scan;
  }
  const climbSourceCache = new Map<string, boolean>();
  /**
   * Classify a node as a climb source using the same explicit provider that
   * proves ladder transitions. A ladder cell is not inferred from its name or
   * empty collision, and a platform node remains walkable after an exit.
   */
  const isClimbSource = (point: Vec3Like): boolean => {
    const provider = request.rules.climbProvider;
    if (!allowed.has('ladder') || provider === undefined) return false;
    const key = cellKeyOf(point);
    const cached = climbSourceCache.get(key);
    if (cached !== undefined) return cached;
    const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
    const coversFeet = (candidate: Vec3Like): boolean => {
      const readCell = read.cell(candidate.x, candidate.y, candidate.z);
      if (readCell.kind !== 'observed') return false;
      const resolution = provider.resolve(
        { cell: candidate, state: readCell.state, body: { ...body, feet: point } },
        read,
      );
      return resolution.kind === 'regions'
        && Array.isArray(resolution.regions)
        && resolution.regions.some((region) =>
          region !== null
          && typeof region === 'object'
          && Number.isFinite(region.minFeetY)
          && Number.isFinite(region.maxFeetY)
          && region.minFeetY <= point.y + EPS
          && region.maxFeetY >= point.y - EPS);
    };
    // A ladder top can put the feet in the air cell above the source block, so
    // the cell one below the feet is also a legitimate climb source there.
    const climbable = coversFeet(cell)
      || coversFeet({ ...cell, y: cell.y - 1 });
    climbSourceCache.set(key, climbable);
    return climbable;
  };
  const finish = (
    status: LandSearchStatus,
    reason: string,
    points: Vec3Like[] = [],
    transitions: LandSearchTransition[] = [],
    cost = 0,
  ): LandSearchResult => {
    // One bounded atomic check before publishing, not an O(S) scan per edge.
    // Residency changes do not emit ChangeReport, including unload/reload with
    // the same section revision. No yield occurs between this check and return.
    for (const { key, generation } of dependencies.values()) {
      if (map.residencyGeneration(key.dim, key.cx, key.cz, key.sy) !== generation) {
        invalidated = true;
        break;
      }
    }
    if (request.rules.shapeProvider.version !== ruleVersion) invalidated = true;
    if (request.rules.jumpModel?.version !== jumpVersion) invalidated = true;
    if (request.rules.climbProvider?.version !== climbVersion) invalidated = true;
    if (edgePolicy !== undefined && edgePolicy.version !== policyVersion) invalidated = true;
    if (invalidated && status !== 'CANCELLED') {
      status = 'INVALIDATED';
      reason = invalidatedReason;
      points = [];
      transitions = [];
      cost = 0;
    }
    const at = clock();
    if (at >= deadline && status === 'FOUND') {
      status = 'BUDGET_EXHAUSTED';
      budget = 'time';
      reason = 'the original deadline expired while publishing the candidate';
      points = [];
      transitions = [];
      cost = 0;
    }
    // A prefix is a current-evidence delegation aid only. It is never derived
    // from remembered geometry, cancellation or invalidation, and it never
    // extends the original deadline. One linear reconstruction collects the
    // existing parent chain; no per-node route copies were kept during search.
    const buildPrefix = (finalStatus: LandSearchStatus): LandSearchPrefix | undefined => {
      if (evidenceMode !== 'current' || closest === null) return undefined;
      if (finalStatus === 'FOUND' || finalStatus === 'CANCELLED' || finalStatus === 'INVALIDATED') return undefined;
      if (request.signal?.aborted || invalidated) return undefined;
      if (clock() >= deadline) return undefined;
      const chain: SearchNode[] = [];
      let cursor: SearchNode | null = closest;
      while (cursor !== null) {
        chain.push(cursor);
        // Respect the output limit instead of publishing a partial chain that
        // no longer starts at the original start.
        if (chain.length > maxRoutePoints) return undefined;
        if (request.signal?.aborted || invalidated || clock() >= deadline) return undefined;
        cursor = cursor.parent;
      }
      chain.reverse();
      const endpoint = { ...chain[chain.length - 1]!.point };
      const prefixPoints = chain.map((node) => ({ ...node.point }));
      const prefixTransitions: LandSearchTransition[] = [];
      for (const node of chain) {
        if (node.via !== null) prefixTransitions.push(node.via);
      }
      const blocker = chain[chain.length - 1]!.blocker;
      const candidate: LandSearchPrefix = {
        endpoint,
        points: prefixPoints,
        transitions: prefixTransitions,
        distanceToTarget: targetDistance(endpoint),
        atTarget: reached(endpoint),
        atStart: prefixTransitions.length === 0,
        ...(blocker === undefined ? {} : {
          knownBlockerAhead: {
            ...blocker,
            from: { ...blocker.from },
            to: { ...blocker.to },
            ...(blocker.supportColumn && { supportColumn: { ...blocker.supportColumn } }),
          },
        }),
      };
      // Final check after the complete reverse/map/transition assembly. The
      // publication clock read in `finish` happens after this, so both checks
      // and the recorded duration include all prefix work.
      if (request.signal?.aborted || invalidated || clock() >= deadline) return undefined;
      return candidate;
    };
    const prefix = buildPrefix(status);
    const finishedAt = clock();
    const publishedPrefix = prefix !== undefined
      && !request.signal?.aborted
      && !invalidated
      && finishedAt < deadline
      ? prefix
      : undefined;
    stats.durationMs = Math.max(0, finishedAt - startedAt);
    stats.maxSyncSliceMs = Math.max(stats.maxSyncSliceMs, finishedAt - sliceStart);
    return {
      status, assurance: evidenceMode === 'remembered' ? 'historical_geometry' : 'geometry_only',
      evidenceMode, executable: false, needsRevalidation: true,
      from: start, target, arrival, goalMetric, points, transitions, cost, boundaries,
      ...(publishedPrefix === undefined ? {} : { prefix: publishedPrefix }),
      ...(edgePolicy === undefined ? {} : {
        policy: {
          version: policyVersion!,
          reads: policyReads,
          rejectedEdges: policyRejectedEdges,
          ...(policyFirstRejection === undefined ? {} : {
            firstRejection: {
              from: { ...policyFirstRejection.from },
              to: { ...policyFirstRejection.to },
              reason: policyFirstRejection.reason,
            },
          }),
        },
      }),
      ...(status !== 'FOUND' && stats.corridorSkipped > 0 ? { corridorLimited: true as const } : {}),
      unavailableSections: [...unavailable.values()], reason,
      ...(budget === undefined ? {} : { budget }), evaluatedAt: now, stats,
    };
  };
  const reached = (point: Vec3Like): boolean => arrival.kind === 'exact'
    ? Math.abs(point.x - target.x) <= EPS && (goalMetric === 'horizontal' || Math.abs(point.y - target.y) <= EPS)
      && Math.abs(point.z - target.z) <= EPS
    : targetDistance(point) <= arrival.radius + EPS;
  // Without jumps, walk costs 1, ladder costs 1, and step/drop costs 2+|dy|.
  // These bound horizontal L1 plus vertical distance, including floored cell Y:
  // its change is at most |dy|+1, covered by the step/drop overhead.
  // L1 inside a near sphere is at most sqrt(dimensions)*radius. Subtracting it
  // keeps the heuristic admissible and consistent; policy costs are nonnegative.
  // A jump costs its horizontal distance plus one, never less than the blocks it
  // covers, so the octile distance stays admissible with jumps enabled.
  const verticalHeuristic = heuristicMode === 'distance' && goalMetric === '3d';
  const heuristic = (point: Vec3Like): number => heuristicMode === 'zero' ? 0
    : Math.max(0, octile(Math.abs(coordinateDelta(point.x, target.x)), Math.abs(coordinateDelta(point.z, target.z)))
      + (verticalHeuristic ? Math.abs(coordinateDelta(point.y, target.y)) : 0)
      - (arrival.kind === 'near' ? Math.sqrt(verticalHeuristic ? 3 : 2) * arrival.radius : 0));
  const keyOf = (point: Vec3Like): string => `${Math.round(point.x - start.x)},${point.y},${Math.round(point.z - start.z)}`;

  const initialStop = stopped();
  if (initialStop !== null) return finish(initialStop, 'search stopped before reading the map');
  if (arrival.kind === 'exact' && [target.x - start.x, target.z - start.z]
    .some((delta) => Math.abs(delta - Math.round(delta)) > EPS)) {
    return finish('UNSUPPORTED', 'exact target is outside the start-relative horizontal lattice; no centering move was authorized');
  }
  // The walk evaluator is synchronous. Reject an oversized sweep before its cell loops.
  if ((Math.ceil(body.width) + 2) ** 2 * (Math.ceil(body.height) + 2) > geometryLimits.maxCandidateCells) {
    budget = 'geometry';
    return finish('BUDGET_EXHAUSTED', 'body sweep exceeds the bounded geometry capacity');
  }
  if (reached(start)) return finish('FOUND', 'start geometrically satisfies the target; measured arrival is still required', [start]);

  const startNode: SearchNode = { point: start, g: 0, parent: null, via: null };
  const nodes = new Map<string, SearchNode>([[keyOf(start), startNode]]);
  const open = new MinHeap();
  open.push({ key: keyOf(start), g: 0, f: heuristic(start) });
  closest = startNode;
  closestMetric = remainingMetric(start);
  let found: SearchNode | null = null;
  const unsubscribe = map.subscribeChanges((report) => {
    if (report.sections.some((section) => dependencies.has(sectionKeyString(section.key))
      && (section.invalidated || (evidenceMode === 'current'
        && section.cells.some((cell) => cell.kind === 'refreshed' && refreshSensitiveCells.has(cellKeyOf(cell.pos))))))) invalidated = true;
  });
  try {
    search: while (open.size > 0) {
      if (stopped() !== null) break;
      const head = open.pop()!;
      const node = nodes.get(head.key)!;
      if (head.g !== node.g) continue;
      if (reached(node.point)) { found = node; break; }
      stats.nodesExpanded += 1;
      request.onExpand?.({ ...node.point });
      // Both action endpoints must be inside the corridor. An actual start that
      // is already outside never authorizes a "return to corridor" move because
      // the from-endpoint remains outside, so every candidate here is skipped.
      const fromInCorridor = corridor === undefined || corridorContains(node.point);
      /**
       * One bounded candidate edge shared by horizontal and ladder expansion.
       * Returns 'stop' only for a search-wide budget/cancellation stop; policy
       * rejection is a delegation restriction and returns 'ok'.
       */
      const considerEdge = function* (
        kind: LandSearchKind,
        to: Vec3Like,
        dx: number,
        dz: number,
        // Diagonal candidates are shortcuts: the cardinal edges already report the
        // frontier, so a non-OPEN diagonal adds no boundary or blocker of its own.
        quiet = false,
      ): Generator<void, 'ok' | 'stop', void> {
        if (!allowed.has(kind)) {
          // Keep the diagnostic boundary, but never turn an authorization /
          // movement-kind restriction into an observed terrain blocker: no
          // geometry was evaluated for this candidate.
          boundary(node.point, to, 'UNSUPPORTED', `${kind} is outside the requested movement kinds`);
          return 'ok';
        }
        if (stats.edgesEvaluated >= maxEdges) { budget = 'edges'; return 'stop'; }
        const dy = to.y - node.point.y;
        const edgeBody = { ...body, feet: node.point };
        const scope = { worldId: request.worldId, dim: request.dim, sessionId: request.sessionId, body: edgeBody };
        // Walk predates LandLimits. Bound provider-derived work for it as well
        // as for step/drop/ladder, without silently translating capacity into an obstacle.
        let shapeBoxes = 0;
        let supportFaces = 0;
        let neighborReads = 0;
        let shapeWork = 0;
        const shapeProvider: CollisionShapeProvider = {
          version: ruleVersion,
          resolve(state, cell, neighbor) {
            shapeWork += 1;
            if (shapeWork > geometryLimits.maxWork) throw new LandSearchGeometryBudgetExceeded();
            const resolution = request.rules.shapeProvider.resolve(state, cell, {
              cell(nx, ny, nz) {
                neighborReads += 1;
                shapeWork += 1;
                if (neighborReads > geometryLimits.maxNeighborReads || shapeWork > geometryLimits.maxWork) {
                  throw new LandSearchGeometryBudgetExceeded();
                }
                const view = neighbor.cell(nx, ny, nz);
                if (evidenceMode === 'current' && view.kind === 'stale') refreshSensitiveCells.add(cellKeyOf(view.pos));
                return view;
              },
            });
            if (resolution.kind === 'shape') {
              shapeBoxes += resolution.shape.boxes.length;
              supportFaces += resolution.shape.supportFaces.length;
              shapeWork += resolution.shape.boxes.length + resolution.shape.supportFaces.length;
              if (shapeBoxes > geometryLimits.maxShapeBoxes || supportFaces > geometryLimits.maxSupportFaces
                || shapeWork > geometryLimits.maxWork) throw new LandSearchGeometryBudgetExceeded();
            }
            return resolution;
          },
        };
        const rules = { ...request.rules, shapeProvider };
        stats.edgesEvaluated += 1;
        const diagonal = kind === 'walk' && dx !== 0 && dz !== 0;
        const evaluation = diagonal
          ? evaluateWalkTo(map, { ...scope, mode: 'walk', direction: { axis: 'x', sign: dx as 1 | -1 } }, to, shapeProvider, now,
            { remembered: evidenceMode === 'remembered' })
          : kind === 'walk'
          ? evidenceMode === 'remembered'
            ? evaluateRememberedWalkStep(map, { ...scope, mode: 'walk', direction: dx === 0 ? { axis: 'z', sign: dz as 1 | -1 } : { axis: 'x', sign: dx as 1 | -1 } }, shapeProvider, now)
            : evaluateWalkStep(map, { ...scope, mode: 'walk', direction: dx === 0 ? { axis: 'z', sign: dz as 1 | -1 } : { axis: 'x', sign: dx as 1 | -1 } }, shapeProvider, now)
          : evidenceMode === 'remembered'
            ? evaluateRememberedLandTransition(map, { ...scope, transition: { kind, from: node.point, to } }, rules, now, geometryLimits)
            : evaluateLandTransition(map, { ...scope, transition: { kind, from: node.point, to } }, rules, now, geometryLimits);
        evaluation.dependencies.forEach((dependency) => addDependency(dependency.key));
        if ('reasons' in evaluation) {
          evaluation.reasons.filter((reason) => reason.kind === 'stale' || reason.kind === 'expired' || reason.kind === 'wrong_session')
            .flatMap((reason) => reason.cells).forEach((cell) => refreshSensitiveCells.add(cellKeyOf(cell)));
        } else if ('problem' in evaluation && evaluation.problem?.kind === 'stale') {
          evaluation.problem.cells.forEach((cell) => refreshSensitiveCells.add(cellKeyOf(cell)));
        }
        if ('work' in evaluation && evaluation.work.exhausted) budget = 'geometry';
        if ('limitGap' in evaluation && evaluation.limitGap !== undefined) budget = 'geometry';
        const status = 'geometry' in evaluation
          ? evaluation.geometry === 'PASSABLE' ? 'OPEN'
            : evaluation.geometry === 'OBSTRUCTED' ? 'BLOCKED' : evaluation.geometry
          : evaluation.status;
        if (status !== 'OPEN') {
          const reason = typeof evaluation.reason === 'string'
            ? evaluation.reason : evaluation.reason?.detail ?? 'transition geometry is not available';
          if (!quiet) {
            boundary(node.point, to, status, reason);
            noteBlocker(node, to, status, reason);
          }
          return 'ok';
        }
        let cost = diagonal ? Math.SQRT2 : kind === 'walk' ? 1 : kind === 'ladder' ? 1
          : kind === 'jump' ? Math.hypot(dx, dz) + 1 : 2 + Math.abs(dy);
        if (edgePolicy !== undefined) {
          if (stopped() !== null) return 'stop';
          policyReadsThisEdge = 0;
          const edge: LandSearchPolicyEdge = {
            kind,
            from: { ...node.point },
            to: { ...to },
            baseCost: cost,
            hazards: evaluation.hazards ?? [],
            evidenceMode,
          };
          let decision!: LandSearchPolicyDecision;
          try {
            decision = validatePolicyDecision(edgePolicy.evaluate(edge, policyRead));
          } catch (error) {
            if (error instanceof LandSearchPolicyAborted) return 'stop';
            throw error;
          }
          if (stopped() !== null) return 'stop';
          if (decision.allow) {
            const extraCost = decision.extraCost ?? 0;
            cost += extraCost;
            if (!Number.isFinite(cost)) {
              throw new Error('land search edge policy produced a non-finite path cost');
            }
          } else {
            policyRejectedEdges += 1;
            policyFirstRejection ??= {
              from: { ...node.point },
              to: { ...to },
              reason: decision.reason,
            };
            // Rejections are delegation restrictions, not terrain facts.
            yield* pause();
            return 'ok';
          }
        }
        const g = node.g + cost;
        if (edgePolicy !== undefined && !Number.isFinite(g)) {
          throw new Error('land search edge policy produced non-finite accumulated path cost');
        }
        const key = keyOf(to);
        const previous = nodes.get(key);
        if (previous === undefined || g < previous.g) {
          if (previous === undefined && nodes.size >= maxNodes) { budget = 'nodes'; return 'stop'; }
          const via = { kind, from: { ...node.point }, to: { ...to }, cost, hazards: evaluation.hazards ?? [] };
          const next: SearchNode = { point: to, g, parent: node, via };
          // A point can be reached again with a lower g. Carry the bounded
          // node blocker forward, and re-point `closest` when it still
          // referenced the superseded object so the prefix follows the new
          // (cheaper, already evaluated) parent chain.
          if (previous !== undefined && previous.blocker !== undefined) next.blocker = previous.blocker;
          nodes.set(key, next);
          stats.nodesReached = nodes.size;
          // Track the closest actually reached node on insertion, not on
          // pop: a goal queued just before a budget stop still counts.
          const metric = remainingMetric(to);
          if (closest === previous || metric < closestMetric) {
            closest = next;
            closestMetric = metric;
          }
          open.push({ key, g, f: g + heuristic(to) });
        }
        yield* pause();
        return 'ok';
      };
      // A node held by a climb source has no ordinary support. Its horizontal
      // moves must be proved as ladder exit (or ladder-to-ladder), not as a
      // walk that silently assumes a platform under the ladder.
      const nodeClimb = allowed.has('ladder') && fromInCorridor && isClimbSource(node.point);
      if (!nodeClimb) {
        for (const [dx, dz] of DIRECTIONS) {
          const x = node.point.x + dx;
          const z = node.point.z + dz;
          if (!fromInCorridor || !corridorContains({ x, y: node.point.y, z })) {
            // Delegation limit only: no boundary, no map read, no terrain claim.
            stats.corridorSkipped += 1;
            continue;
          }
          const { surfaces, gaps: columnGaps, minY, maxY } = yield* columnSurfaces(x, z, node.point.y);
          if (stopped() !== null) break search;
          if (surfaces.size === 0) {
            // Stale support evidence is a more specific fact than cells that were
            // never observed: the column did have recorded geometry, it is no longer
            // current. Keep it distinguishable from a plain evidence gap.
            const columnStatus = columnGaps.has('STALE') ? 'STALE' : columnGaps.has('UNKNOWN') ? 'UNKNOWN'
              : columnGaps.has('UNSUPPORTED') ? 'UNSUPPORTED' : 'BLOCKED';
            const columnReason = columnStatus === 'BLOCKED'
              ? 'fully observed column has no support within the requested step/drop range'
              : columnStatus === 'STALE'
                ? 'support-surface evidence in the bounded column is stale and is not treated as current geometry'
                : 'support-surface coverage or shape rules are incomplete in the bounded column';
            const candidate = { x, y: node.point.y, z };
            const supportColumn = { minY, maxY };
            boundary(node.point, candidate, columnStatus, columnReason, supportColumn);
            noteBlocker(node, candidate, columnStatus, columnReason, supportColumn);
          }
          for (const y of surfaces) {
            if (stopped() !== null) break search;
            const dy = y - node.point.y;
            const kind: LandSearchKind = Math.abs(dy) <= EPS ? 'walk' : dy > 0 ? 'step' : 'drop';
            const to = { x, y, z };
            const outcome = yield* considerEdge(kind, to, dx, dz);
            if (outcome === 'stop') break search;
          }
        }
        // Remembered geometry is only a candidate that execution re-verifies step by
        // step. Keeping it cardinal makes a refused step stop at an axis-aligned
        // frontier that an observation can resolve, instead of a cut corner.
        if (allowed.has('walk') && fromInCorridor && evidenceMode === 'current') {
          for (const [dx, dz] of DIAGONALS) {
            const to = { x: node.point.x + dx, y: node.point.y, z: node.point.z + dz };
            if (!corridorContains(to)) {
              stats.corridorSkipped += 1;
              continue;
            }
            // Only a recorded same-height support face makes a diagonal worth evaluating.
            const { surfaces } = yield* columnSurfaces(to.x, to.z, node.point.y);
            if (stopped() !== null) break search;
            if (!surfaces.has(node.point.y)) continue;
            const outcome = yield* considerEdge('walk', to, dx, dz, true);
            if (outcome === 'stop') break search;
          }
        }
      }
      if (allowed.has('jump') && fromInCorridor && !nodeClimb) {
        const maxJumpCells = Math.floor(geometryLimits.maxJumpDistance + EPS);
        for (const [dx, dz] of DIRECTIONS) {
          for (let distance = 2; distance <= maxJumpCells; distance++) {
            if (stopped() !== null) break search;
            const to = {
              x: node.point.x + dx * distance,
              y: node.point.y,
              z: node.point.z + dz * distance,
            };
            if (!corridorContains(to)) {
              stats.corridorSkipped += 1;
              continue;
            }
            // Jump geometry still needs a local landing surface at the same
            // feet height; the transition evaluator then proves the swept body
            // envelope and the observed gap.
            const { surfaces } = yield* columnSurfaces(to.x, to.z, node.point.y);
            if (stopped() !== null) break search;
            if (!surfaces.has(node.point.y)) continue;
            const outcome = yield* considerEdge('jump', to, dx * distance, dz * distance);
            if (outcome === 'stop') break search;
          }
        }
      }
      if (allowed.has('ladder') && fromInCorridor) {
        for (const dy of [1, -1]) {
          if (stopped() !== null) break search;
          const to = { x: node.point.x, y: node.point.y + dy, z: node.point.z };
          if (!corridorContains(to)) {
            stats.corridorSkipped += 1;
            continue;
          }
          if (!nodeClimb && !isClimbSource(to)) continue;
          const outcome = yield* considerEdge('ladder', to, 0, 0);
          if (outcome === 'stop') break search;
        }
        for (const [dx, dz] of DIRECTIONS) {
          if (stopped() !== null) break search;
          const to = { x: node.point.x + dx, y: node.point.y, z: node.point.z + dz };
          if (!corridorContains(to)) {
            stats.corridorSkipped += 1;
            continue;
          }
          // From a platform, only entry into a climb source is a ladder edge.
          // From a climb source, every adjacent move is an exit candidate and
          // the evaluator proves the destination platform support.
          if (!nodeClimb && !isClimbSource(to)) continue;
          const outcome = yield* considerEdge('ladder', to, dx, dz);
          if (outcome === 'stop') break search;
        }
      }
    }
    const stop = stopped();
    if (stop !== null) return finish(stop, budgetDetail ?? (stop === 'INVALIDATED'
      ? invalidatedReason
      : 'search stopped within its original cancellation or work budget'));
    if (found === null) {
      const evidenceGap = counts.UNKNOWN > 0 || counts.STALE > 0 || counts.INCOMPLETE > 0;
      const baseReason = 'no candidate was found within the available remembered geometry and requested movement kinds';
      const corridorReason = 'no candidate was found within the available geometry, requested movement kinds and requested corridor; candidates outside the corridor were not expanded';
      const plainReason = stats.corridorSkipped > 0 ? corridorReason : baseReason;
      if (evidenceGap) return finish('INSUFFICIENT_EVIDENCE', plainReason);
      if (policyRejectedEdges > 0) {
        return finish('UNSUPPORTED',
          'the caller edge policy excluded geometrically open candidate edges; this is a delegation restriction and does not prove whether a route exists without the policy'
          + (stats.corridorSkipped > 0 ? '; candidates outside the requested corridor were not expanded' : ''));
      }
      if (counts.UNSUPPORTED > 0) return finish('UNSUPPORTED', plainReason);
      return finish('NO_PATH_IN_MEMORY', plainReason);
    }
    const points: Vec3Like[] = [];
    const transitions: LandSearchTransition[] = [];
    let cursor: SearchNode | null = found;
    while (cursor !== null) {
      if (points.length >= maxRoutePoints) { budget = 'points'; break; }
      const stop = stopped();
      if (stop !== null) return finish(stop, 'search stopped while reconstructing the candidate');
      points.push({ ...cursor.point });
      if (cursor.via !== null) transitions.push(cursor.via);
      cursor = cursor.parent;
      yield* pause();
    }
    if (budget !== undefined) return finish('BUDGET_EXHAUSTED', 'candidate exceeds the output point budget');
    points.reverse();
    transitions.reverse();
    const finalStop = stopped();
    if (finalStop !== null) return finish(finalStop, 'search stopped before publishing the candidate');
    return finish('FOUND', 'voxel geometry candidate found; current action checks and measured arrival remain required', points, transitions, found.g);
  } catch (error) {
    if (!(error instanceof LandSearchGeometryBudgetExceeded)) throw error;
    budget = 'geometry';
    return finish('BUDGET_EXHAUSTED', 'shape-provider work exceeded the per-edge geometry budget');
  } finally {
    unsubscribe();
  }
}

/** Synchronous bounded search for offline callers; it does not yield the event loop. */
export function searchLandRoute(map: VoxelMap, request: LandSearchRequest, now = Date.now()): LandSearchResult {
  const chunks = searchChunks(map, request, now, false);
  let step = chunks.next();
  while (!step.done) step = chunks.next();
  return step.value;
}

/** Cooperative Node-compatible search. All output is task-local and never saved as a route. */
export async function searchLandRouteAsync(map: VoxelMap, request: LandSearchRequest, now = Date.now()): Promise<LandSearchResult> {
  const chunks = searchChunks(map, request, now, true);
  let step = chunks.next();
  while (!step.done) {
    // A zero-delay timer can wait a whole platform timer tick per slice.
    // Node's check phase still yields to I/O/timers without that minimum delay;
    // other runtimes retain the task-based timer fallback (never a microtask).
    await new Promise<void>((resolve) => {
      if (typeof globalThis.setImmediate === 'function') globalThis.setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
    step = chunks.next();
  }
  return step.value;
}
