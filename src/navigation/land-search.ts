/**
 * Bounded voxel A* extracted from the host's observed-voxel land search.
 * The heap, support-surface expansion and cooperative search remain here;
 * host geometry data, risk policy, body control and permanent history do not.
 */
import type { Vec3Like } from '../types.js';
import type { CollisionShapeProvider, NeighborCellView, NeighborRead } from '../traversability/collision-shape.js';
import {
  evaluateLandTransition,
  evaluateRememberedLandTransition,
  resolveLandLimits,
} from '../traversability/land-transition.js';
import type { LandLimits, LandRules } from '../traversability/land-transition.js';
import { evaluateRememberedWalkStep, evaluateWalkStep } from '../traversability/step.js';
import type { BodyContext } from '../traversability/step.js';
import type { HazardFact } from '../traversability/types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { VoxelMap } from '../voxel/voxel-map.js';

export type LandSearchKind = 'walk' | 'step' | 'drop';
export type LandSearchArrival = { kind: 'exact' } | { kind: 'near'; radius: number };
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

export interface LandSearchRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  /** Original continuous feet target. Neither target nor start is centered or snapped. */
  to: Vec3Like;
  arrival?: LandSearchArrival;
  rules: LandRules;
  /** Historical candidates use recorded geometry; they never become current OPEN proofs. */
  evidenceMode?: 'current' | 'remembered';
  allowed?: readonly LandSearchKind[];
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
  /** 'zero' runs the same graph and costs as Dijkstra, for comparison. */
  heuristic?: 'horizontal' | 'zero';
  signal?: AbortSignal;
  /** Budget clock; evidence freshness is evaluated at the entry point's `now` argument. */
  clock?: () => number;
}

export interface LandSearchTransition {
  kind: LandSearchKind;
  from: Vec3Like;
  to: Vec3Like;
  /** Cost units are geometric search weights, not elapsed time or risk estimates. */
  cost: number;
  hazards: HazardFact[];
}

export interface LandSearchBoundary {
  from: Vec3Like;
  to: Vec3Like;
  status: LandSearchBoundaryStatus;
  reason: string;
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
  points: Vec3Like[];
  transitions: LandSearchTransition[];
  cost: number;
  boundaries: LandSearchBoundary[];
  /** Saved pages were not loaded implicitly; the caller can prepare them and retry. */
  unavailableSections: SectionKey[];
  reason: string;
  budget?: LandSearchBudget;
  evaluatedAt: number;
  stats: {
    nodesReached: number;
    nodesExpanded: number;
    edgesEvaluated: number;
    /** Candidate support reads only; not a total of evaluator-internal evidence reads. */
    surfaceReads: number;
    sectionsRead: number;
    staleReads: number;
    boundariesTruncated: boolean;
    durationMs: number;
    yieldCount: number;
    maxSyncSliceMs: number;
  };
}

const EPS = 1e-9;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

class LandSearchGeometryBudgetExceeded extends Error {}

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
  const evidenceMode = request.evidenceMode ?? 'current';
  if (evidenceMode !== 'current' && evidenceMode !== 'remembered') throw new Error('unsupported land search evidence mode');
  const heuristicMode = request.heuristic ?? 'horizontal';
  if (heuristicMode !== 'horizontal' && heuristicMode !== 'zero') throw new Error('unsupported land search heuristic');
  const allowed = new Set(request.allowed ?? ['walk', 'step', 'drop']);
  if ([...allowed].some((kind) => kind !== 'walk' && kind !== 'step' && kind !== 'drop')) {
    throw new Error('land search supports walk, step and drop geometry only');
  }
  const maxDrop = request.maxDrop ?? 4;
  if (!Number.isFinite(maxDrop) || maxDrop < 0) throw new Error('maxDrop must be finite and nonnegative');
  const maxNodes = positive(request.maxNodes, 2048, 'maxNodes');
  const maxEdges = positive(request.maxEdges, 8192, 'maxEdges');
  const maxSurfaceReads = positive(request.maxSurfaceReads, 262144, 'maxSurfaceReads');
  const maxSections = positive(request.maxSections, 1024, 'maxSections');
  const maxRoutePoints = positive(request.maxRoutePoints, 2048, 'maxRoutePoints');
  const maxBoundaries = positive(request.maxBoundaries, 64, 'maxBoundaries');
  const maxSearchMs = positive(request.maxSearchMs, 1500, 'maxSearchMs', false);
  const maxSliceMs = positive(request.maxSliceMs, 5, 'maxSliceMs', false);
  const maxWorkPerSlice = positive(request.maxWorkPerSlice, 32, 'maxWorkPerSlice');
  const geometryLimits = resolveLandLimits(request.geometryLimits);
  const ruleVersion = request.rules.shapeProvider.version;
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
    sectionsRead: 0, staleReads: 0, boundariesTruncated: false,
    durationMs: 0, yieldCount: 0, maxSyncSliceMs: 0,
  };
  const dependencies = new Map<string, { key: SectionKey; generation: number }>();
  const unavailable = new Map<string, SectionKey>();
  const boundaries: LandSearchBoundary[] = [];
  const counts = { UNKNOWN: 0, STALE: 0, BLOCKED: 0, UNSUPPORTED: 0, INCOMPLETE: 0 };
  let invalidated = false;
  let budget: LandSearchBudget | undefined;
  const stopped = (): LandSearchStatus | null => {
    if (request.signal?.aborted) return 'CANCELLED';
    if (invalidated) return 'INVALIDATED';
    if (clock() >= deadline) budget = 'time';
    return budget === undefined ? null : 'BUDGET_EXHAUSTED';
  };
  const boundary = (from: Vec3Like, to: Vec3Like, status: LandSearchBoundaryStatus, reason: string): void => {
    counts[status] += 1;
    if (boundaries.length < maxBoundaries) boundaries.push({ from: { ...from }, to: { ...to }, status, reason });
    else stats.boundariesTruncated = true;
  };
  const addDependency = (key: SectionKey): void => {
    const id = sectionKeyString(key);
    if (dependencies.has(id)) return;
    if (dependencies.size >= maxSections) { budget = 'sections'; return; }
    dependencies.set(id, { key: { ...key }, generation: map.residencyGeneration(key.dim, key.cx, key.cz, key.sy) });
    stats.sectionsRead = dependencies.size;
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
      const staleReason = evidence.freshness === 'STALE' ? 'stale'
        : evidence.observation.sessionId !== request.sessionId ? 'session'
        : now > evidence.validUntil ? 'expired' : null;
      if (staleReason !== null) {
        stats.staleReads += 1;
        if (evidenceMode === 'current') return { pos, kind: 'stale', reason: staleReason };
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
    if (invalidated && status !== 'CANCELLED') {
      status = 'INVALIDATED';
      reason = 'a section used by this search changed or was unloaded/reloaded';
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
    stats.durationMs = Math.max(0, at - startedAt);
    stats.maxSyncSliceMs = Math.max(stats.maxSyncSliceMs, at - sliceStart);
    return {
      status, assurance: evidenceMode === 'remembered' ? 'historical_geometry' : 'geometry_only',
      evidenceMode, executable: false, needsRevalidation: true,
      from: start, target, arrival, points, transitions, cost, boundaries,
      unavailableSections: [...unavailable.values()], reason,
      ...(budget === undefined ? {} : { budget }), evaluatedAt: now, stats,
    };
  };
  const reached = (point: Vec3Like): boolean => arrival.kind === 'exact'
    ? Math.abs(point.x - target.x) <= EPS && Math.abs(point.y - target.y) <= EPS && Math.abs(point.z - target.z) <= EPS
    : Math.hypot(point.x - target.x, point.y - target.y, point.z - target.z) <= arrival.radius + EPS;
  // Each edge changes one horizontal coordinate by exactly one and costs >= 1.
  // Subtracting sqrt(2)*radius is an admissible L1 lower bound for a near sphere.
  // Vertical distance is deliberately absent: a four-block drop costs six, not nine.
  const heuristic = (point: Vec3Like): number => heuristicMode === 'zero' ? 0
    : Math.max(0, Math.abs(point.x - target.x) + Math.abs(point.z - target.z)
      - (arrival.kind === 'near' ? Math.SQRT2 * arrival.radius : 0));
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
  let found: SearchNode | null = null;
  const unsubscribe = map.subscribeChanges((report) => {
    if (report.sections.some((section) => dependencies.has(sectionKeyString(section.key))
      && (evidenceMode === 'current' || section.invalidated))) invalidated = true;
  });
  try {
    search: while (open.size > 0) {
      if (stopped() !== null) break;
      const head = open.pop()!;
      const node = nodes.get(head.key)!;
      if (head.g !== node.g) continue;
      if (reached(node.point)) { found = node; break; }
      stats.nodesExpanded += 1;
      for (const [dx, dz] of DIRECTIONS) {
        const x = node.point.x + dx;
        const z = node.point.z + dz;
        const half = body.width / 2;
        const surfaces = new Set<number>();
        const columnGaps = new Set<LandSearchBoundaryStatus>();
        // Candidate heights come from actual support faces under the body footprint.
        // No top-of-column shortcut merges a bridge with the cave below it.
        for (let bx = Math.floor(x - half + EPS); bx <= Math.floor(x + half - EPS); bx++) {
          for (let bz = Math.floor(z - half + EPS); bz <= Math.floor(z + half - EPS); bz++) {
            for (let by = Math.floor(node.point.y - maxDrop) - 1; by <= Math.ceil(node.point.y + 1); by++) {
              if (stopped() !== null) break search;
              const cell = read.cell(bx, by, bz);
              if (cell.kind === 'stale') columnGaps.add('STALE');
              if (cell.kind === 'unobserved' || cell.kind === 'incomplete') columnGaps.add('UNKNOWN');
              if (cell.kind === 'observed') {
                const resolution = request.rules.shapeProvider.resolve(cell.state, cell.pos, read);
                if (resolution.kind === 'shape') {
                  if (resolution.shape.supportFaces.length > geometryLimits.maxSupportFaces
                    || resolution.shape.boxes.length > geometryLimits.maxShapeBoxes) {
                    budget = 'geometry';
                    break search;
                  }
                  for (const face of resolution.shape.supportFaces) {
                    const y = by + face.top;
                    if (y < node.point.y - maxDrop - EPS || y > node.point.y + 1 + EPS) continue;
                    if (bx + face.maxX <= x - half + EPS || bx + face.minX >= x + half - EPS
                      || bz + face.maxZ <= z - half + EPS || bz + face.minZ >= z + half - EPS) continue;
                    surfaces.add(Math.abs(y - node.point.y) <= EPS ? node.point.y : y);
                  }
                } else if (resolution.kind === 'unsupported_shape') columnGaps.add('UNSUPPORTED');
                else columnGaps.add(resolution.view.kind === 'stale' ? 'STALE' : 'UNKNOWN');
              }
              yield* pause();
            }
          }
        }
        if (surfaces.size === 0) {
          const columnStatus = columnGaps.has('UNKNOWN') ? 'UNKNOWN' : columnGaps.has('STALE') ? 'STALE'
            : columnGaps.has('UNSUPPORTED') ? 'UNSUPPORTED' : 'BLOCKED';
          boundary(node.point, { x, y: node.point.y, z }, columnStatus, columnStatus === 'BLOCKED'
            ? 'fully observed column has no support within the requested step/drop range'
            : 'support-surface coverage or shape rules are incomplete in the bounded column');
        }
        for (const y of surfaces) {
          if (stopped() !== null) break search;
          const dy = y - node.point.y;
          const kind: LandSearchKind = Math.abs(dy) <= EPS ? 'walk' : dy > 0 ? 'step' : 'drop';
          const to = { x, y, z };
          if (!allowed.has(kind)) {
            boundary(node.point, to, 'UNSUPPORTED', `${kind} is outside the requested movement kinds`);
            continue;
          }
          if (stats.edgesEvaluated >= maxEdges) { budget = 'edges'; break search; }
          const edgeBody = { ...body, feet: node.point };
          const scope = { worldId: request.worldId, dim: request.dim, sessionId: request.sessionId, body: edgeBody };
          // Walk predates LandLimits. Bound provider-derived work for it as well
          // as for step/drop, without silently translating capacity into an obstacle.
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
                  return neighbor.cell(nx, ny, nz);
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
          const evaluation = kind === 'walk'
            ? evidenceMode === 'remembered'
              ? evaluateRememberedWalkStep(map, { ...scope, mode: 'walk', direction: dx === 0 ? { axis: 'z', sign: dz as 1 | -1 } : { axis: 'x', sign: dx as 1 | -1 } }, shapeProvider, now)
              : evaluateWalkStep(map, { ...scope, mode: 'walk', direction: dx === 0 ? { axis: 'z', sign: dz as 1 | -1 } : { axis: 'x', sign: dx as 1 | -1 } }, shapeProvider, now)
            : evidenceMode === 'remembered'
              ? evaluateRememberedLandTransition(map, { ...scope, transition: { kind, from: node.point, to } }, rules, now, geometryLimits)
              : evaluateLandTransition(map, { ...scope, transition: { kind, from: node.point, to } }, rules, now, geometryLimits);
          evaluation.dependencies.forEach((dependency) => addDependency(dependency.key));
          if ('work' in evaluation && evaluation.work.exhausted) budget = 'geometry';
          if ('limitGap' in evaluation && evaluation.limitGap !== undefined) budget = 'geometry';
          const status = 'geometry' in evaluation
            ? evaluation.geometry === 'PASSABLE' ? 'OPEN'
              : evaluation.geometry === 'OBSTRUCTED' ? 'BLOCKED' : evaluation.geometry
            : evaluation.status;
          if (status !== 'OPEN') {
            boundary(node.point, to, status, typeof evaluation.reason === 'string'
              ? evaluation.reason : evaluation.reason?.detail ?? 'transition geometry is not available');
          } else {
            const cost = kind === 'walk' ? 1 : 2 + Math.abs(dy);
            const g = node.g + cost;
            const key = keyOf(to);
            const previous = nodes.get(key);
            if (previous === undefined || g < previous.g) {
              if (previous === undefined && nodes.size >= maxNodes) { budget = 'nodes'; break search; }
              const via = { kind, from: { ...node.point }, to: { ...to }, cost, hazards: evaluation.hazards ?? [] };
              nodes.set(key, { point: to, g, parent: node, via });
              stats.nodesReached = nodes.size;
              open.push({ key, g, f: g + heuristic(to) });
            }
          }
          yield* pause();
        }
      }
    }
    const stop = stopped();
    if (stop !== null) return finish(stop, stop === 'INVALIDATED'
      ? 'a section used by this search changed; retry against the updated map'
      : 'search stopped within its original cancellation or work budget');
    if (found === null) {
      const status = counts.UNKNOWN > 0 || counts.STALE > 0 || counts.INCOMPLETE > 0 ? 'INSUFFICIENT_EVIDENCE'
        : counts.UNSUPPORTED > 0 ? 'UNSUPPORTED' : 'NO_PATH_IN_MEMORY';
      return finish(status, 'no candidate was found within the available remembered geometry and requested movement kinds');
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    step = chunks.next();
  }
  return step.value;
}
