/**
 * Bounded, read-only same-height walk route search (design §7 first step).
 *
 * `WalkRouteSearch` composes the existing single-step walk evaluator over the
 * in-memory `VoxelMap`. It expands the four horizontal neighbours (±1 X / ±1 Z)
 * of a *fixed continuous feet position* and traverses an edge only when
 * `evaluateWalkStep` currently reports `OPEN`. It never digs, places, selects a
 * goal, explores unknown cells, or reads raw game/chunk data.
 *
 * The result is a *candidate*: a zero-or-more-edge stance sequence. It is not a
 * navigation success. Callers must still pass the candidate through
 * `RouteVerifier` and confirm arrival from measured body positions.
 *
 * Only the fixed same-height X/Z lattice is supported. Instances of that lattice
 * are `body.feet + (integer X, integer Z)` at exactly the original feet height.
 * An exact target that is not on that lattice (or has a different height) is an
 * explicit `UNSUPPORTED` capability limitation — the target is never rounded or
 * silently projected. A near target is checked against its full XYZ distance at
 * each reached stance; it is never replaced with a nearby lattice point.
 *
 * Search progress is incremental: `advance(n)` evaluates at most `n` edges and
 * snapshots are read with `status()`. Finite node/edge/frontier/diagnostic caps
 * bound all work and output. A search never refreshes observations, scans the
 * world, or mutates map evidence/time/version.
 *
 * Evidence invalidation is explicit. The caller feeds each `ChangeReport` from
 * `VoxelMap.observe`/`observeBatch`/`beginSession`/`markStale` to `invalidate`,
 * and section residency changes to `invalidateSections`. A relevant change, an
 * expired evidence window, a shape-rule version change, or a residency change
 * moves the search to `INVALIDATED`; it is never resumed on a mix of old and new
 * evidence. There is no automatic retry. Unrelated section changes are ignored.
 */

import type { CellEvidence, Observation } from '../observation/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import { blockToSection } from '../voxel/coordinates.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionKey } from '../voxel/section.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import { evaluateWalkStep } from '../traversability/step.js';
import type { BodyContext, StepEvaluation, StepProblem, StepQuery } from '../traversability/step.js';

/** Supported completion conditions. `reach_block` is deliberately not part of this search. */
export type WalkSearchArrival = { kind: 'exact' } | { kind: 'near'; radius: number };

/**
 * Search lifecycle. `PENDING` means more work is allowed; every other state is
 * terminal until a new `start`. `FOUND` is only a candidate, never an arrival.
 */
export type WalkSearchState =
  | 'PENDING'
  | 'FOUND'
  | 'NO_VERIFIED_PATH'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNSUPPORTED'
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'INVALIDATED';

export interface WalkSearchRequest {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  /** Fixed body size/pose plus the fixed continuous feet origin (never floored). */
  body: BodyContext;
  /** Caller-selected target, stored verbatim. Never rounded or replaced. */
  target: Vec3Like;
  arrival: WalkSearchArrival;
  shapeProvider: CollisionShapeProvider;
}

export interface WalkSearchLimits {
  maxNodes: number;
  maxEdges: number;
  maxFrontiers: number;
  maxDiagnostics: number;
}

export interface WalkSearchOptions {
  /** Clock for evidence expiry; must return values comparable to observation times. Defaults to `Date.now`. */
  now?: () => number;
  /** Maximum reached lattice nodes, including the start. Defaults to 2048. */
  maxNodes?: number;
  /** Maximum evaluated edges (actual `evaluateWalkStep` calls). Defaults to 8192. */
  maxEdges?: number;
  /** Maximum reported frontier candidates and unavailable-saved-section gaps, each. Defaults to 64. */
  maxFrontiers?: number;
  /** Maximum reported per-edge diagnostics. Defaults to 64. */
  maxDiagnostics?: number;
}

/** A candidate stance sequence. Empty edges means the start already satisfies the target. */
export interface WalkSearchCandidate {
  /** Continuous feet positions, starting at the fixed origin. */
  points: Vec3Like[];
  edgeCount: number;
  reachedAt: Vec3Like;
  /** Original caller target (identity snapshot). */
  target: Vec3Like;
  arrival: WalkSearchArrival;
  /** Full XYZ Euclidean distance from `reachedAt` to `target`. */
  distanceToTarget: number;
  /** Earliest `validUntil` along the path's OPEN edges; Infinity for a zero-edge candidate. */
  validUntil: number;
}

export type WalkSearchUnavailableResidency = 'not_resident' | 'loading' | 'load_failed';

export interface WalkSearchUnavailableSection {
  key: SectionKey;
  residency: WalkSearchUnavailableResidency;
  /** Committed revision when the saved section has a directory record. */
  committedRevision?: number;
}

/**
 * A never-observed gap adjacent to a currently OPEN-reachable stance. The
 * reachable side is `stance`; `to` and `gap` are not claimed reachable and were
 * not entered. `basis` contains the locally observed stance cells
 * (feet/head/support) that make the boundary interpretable.
 */
export interface WalkSearchFrontier {
  stance: Vec3Like;
  to: Vec3Like;
  gap: Vec3Like[];
  /** Reachability of `stance` only. */
  reachability: 'OPEN';
  basis: Observation[];
  reason: string;
  computedAt: number;
  validUntil: number;
}

/**
 * An UNKNOWN boundary whose evidence belongs to a saved section that is not
 * resident/loading/load_failed. This is old evidence that is currently
 * unavailable, not a newly discovered frontier.
 */
export interface WalkSearchUnavailableEvidence {
  stance: Vec3Like;
  to: Vec3Like;
  gap: Vec3Like[];
  sections: WalkSearchUnavailableSection[];
  basis: Observation[];
  reason: string;
  computedAt: number;
  validUntil: number;
}

/** One bounded, factual non-OPEN boundary-edge observation. */
export interface WalkSearchDiagnostic {
  stance: Vec3Like;
  to: Vec3Like;
  status: 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED';
  reason: string;
  problem?: StepProblem;
  computedAt: number;
}

export interface WalkSearchCounters {
  nodesReached: number;
  nodesExpanded: number;
  edgesEvaluated: number;
  edgesOpen: number;
  edgesBlocked: number;
  edgesUnknown: number;
  edgesStale: number;
  edgesUnsupported: number;
  /** Edges skipped because the neighbour was already reached (no duplicate work). */
  edgesSkippedReached: number;
  frontierCandidates: number;
  frontiersReported: number;
  frontierLimitReached: boolean;
  unavailableHistoricalCandidates: number;
  unavailableHistoricalReported: number;
  unavailableHistoricalLimitReached: boolean;
  diagnosticsReported: number;
  diagnosticsTruncated: boolean;
  /** True only while the search is PENDING and has unprocessed work. */
  hasMoreWork: boolean;
}

export type WalkSearchProblem =
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'unsupported_target'; detail: string }
  | {
      kind: 'budget_exhausted';
      nodeLimitReached: boolean;
      edgeLimitReached: boolean;
      maxNodes: number;
      maxEdges: number;
      nodesReached: number;
      edgesEvaluated: number;
    }
  | {
      kind: 'insufficient_evidence';
      unknownEdges: number;
      staleEdges: number;
      unsupportedEdges: number;
      unavailableHistoricalEdges: number;
    }
  | { kind: 'no_verified_path'; blockedEdges: number; detail?: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'invalidated'; reason: string };

/** Read-only search snapshot. Every field is a copy; mutating it never reaches the search. */
export interface WalkSearchSnapshot {
  state: WalkSearchState;
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  body: BodyContext;
  from: Vec3Like;
  target: Vec3Like;
  arrival: WalkSearchArrival;
  ruleVersion: string;
  limits: WalkSearchLimits;
  candidate: WalkSearchCandidate | null;
  frontiers: WalkSearchFrontier[];
  unavailableHistorical: WalkSearchUnavailableEvidence[];
  diagnostics: WalkSearchDiagnostic[];
  counters: WalkSearchCounters;
  reason: string;
  problem?: WalkSearchProblem;
  computedAt: number;
  /** Candidate path validity when FOUND; otherwise the accumulated search-evidence window. */
  validUntil: number;
  cancellation?: { reason: string };
}

const DEFAULT_MAX_NODES = 2048;
const DEFAULT_MAX_EDGES = 8192;
const DEFAULT_MAX_FRONTIERS = 64;
const DEFAULT_MAX_DIAGNOSTICS = 64;

/** Tolerance for a floating-point delta that represents an exact lattice/height match. */
const EPS = 1e-9;

interface Direction {
  axis: 'x' | 'z';
  sign: 1 | -1;
  dx: number;
  dz: number;
}

/** Deterministic four-neighbour order. */
const DIRECTIONS: readonly Direction[] = [
  { axis: 'x', sign: 1, dx: 1, dz: 0 },
  { axis: 'x', sign: -1, dx: -1, dz: 0 },
  { axis: 'z', sign: 1, dx: 0, dz: 1 },
  { axis: 'z', sign: -1, dx: 0, dz: -1 },
];

interface SearchNode {
  key: string;
  ix: number;
  iz: number;
  depth: number;
  parentKey: string | null;
  /** min validUntil along the OPEN tree path from the start. */
  routeValidUntil: number;
}

interface ActiveSearch {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  body: BodyContext;
  start: Vec3Like;
  target: Vec3Like;
  arrival: WalkSearchArrival;
  shapeProvider: CollisionShapeProvider;
  ruleVersion: string;
  /** Exact lattice offsets; null for a near target or an unsupported request. */
  exact: { ix: number; iz: number } | null;
  nearRadius: number | null;
  nodes: Map<string, SearchNode>;
  /** Discovery order (breadth-first). */
  order: string[];
  nextNodeIndex: number;
  pendingEdge: { nodeKey: string; dirIndex: number } | null;
  state: WalkSearchState;
  reason: string;
  problem: WalkSearchProblem | undefined;
  candidate: WalkSearchCandidate | null;
  /** Keyed by the adjacent neighbour lattice key. */
  frontiers: Map<string, WalkSearchFrontier>;
  unavailable: Map<string, WalkSearchUnavailableEvidence>;
  diagnostics: WalkSearchDiagnostic[];
  dependencySections: Set<string>;
  dependencyResidency: Map<string, { key: SectionKey; generation: number }>;
  nodesExpanded: number;
  edgesEvaluated: number;
  edgesOpen: number;
  edgesBlocked: number;
  edgesUnknown: number;
  edgesStale: number;
  edgesUnsupported: number;
  edgesSkippedReached: number;
  frontierCandidates: number;
  unavailableCandidates: number;
  diagnosticsTruncated: boolean;
  frontierLimitReached: boolean;
  unavailableLimitReached: boolean;
  nodeLimitReached: boolean;
  edgeLimitReached: boolean;
  /**
   * Earliest validity of any evidence already used for reachable stances or
   * boundary claims. Expiring it invalidates the accumulated search instead of
   * mixing old OPEN edges with newer evidence.
   */
  searchValidUntil: number;
  computedAt: number;
  cancellationReason: string | null;
}

/**
 * Incremental same-height, four-neighbour walk route search over one
 * `VoxelMap`. One instance tracks one search at a time; `start` replaces it.
 *
 * @example
 * ```ts
 * const search = new WalkRouteSearch(map, { now, maxNodes: 512 });
 * search.start({ worldId, dim, sessionId, mode: 'walk', body, target, arrival: { kind: 'near', radius: 2 }, shapeProvider });
 * while (search.status()?.state === 'PENDING') search.advance(32);
 * const result = search.status();
 * if (result?.state === 'FOUND') {
 *   verifier.register({ worldId, dim, sessionId, mode: 'walk', body, shapeProvider, points: result.candidate.points });
 *   verifier.advance(1024); // candidate is still only a candidate
 * }
 * // After every map.observe(...) the caller forwards its ChangeReport:
 * // search.invalidate(report);
 * ```
 */
export class WalkRouteSearch {
  private readonly map: VoxelMap;
  private readonly now: () => number;
  private readonly maxNodes: number;
  private readonly maxEdges: number;
  private readonly maxFrontiers: number;
  private readonly maxDiagnostics: number;
  private search: ActiveSearch | null = null;

  constructor(map: VoxelMap, options: WalkSearchOptions = {}) {
    this.map = map;
    this.now = options.now ?? Date.now;
    this.maxNodes = resolveLimit(options.maxNodes, DEFAULT_MAX_NODES, 'maxNodes');
    this.maxEdges = resolveLimit(options.maxEdges, DEFAULT_MAX_EDGES, 'maxEdges');
    this.maxFrontiers = resolveLimit(options.maxFrontiers, DEFAULT_MAX_FRONTIERS, 'maxFrontiers');
    this.maxDiagnostics = resolveLimit(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS, 'maxDiagnostics');
  }

  /**
   * Start (or replace) a search. All validation happens before the previous
   * search is replaced, so a rejected request leaves the old search intact.
   */
  start(request: WalkSearchRequest): WalkSearchSnapshot {
    if (request.worldId !== this.map.worldId) {
      throw new Error(`request worldId "${request.worldId}" does not match map worldId "${this.map.worldId}"`);
    }
    const body = snapshotBody(request.body);
    validateBody(body);
    const target = snapshotVec(request.target);
    assertFinite(target.x, 'target.x');
    assertFinite(target.y, 'target.y');
    assertFinite(target.z, 'target.z');
    const arrival = snapshotArrival(request.arrival);
    const now = this.currentNow();

    const search: ActiveSearch = {
      worldId: request.worldId,
      dim: request.dim,
      sessionId: request.sessionId,
      mode: request.mode,
      body,
      start: { ...body.feet },
      target,
      arrival,
      // Keep the caller's provider object so a class method keeps its receiver.
      shapeProvider: request.shapeProvider,
      ruleVersion: request.shapeProvider.version,
      exact: null,
      nearRadius: null,
      nodes: new Map(),
      order: [],
      nextNodeIndex: 0,
      pendingEdge: null,
      state: 'PENDING',
      reason: 'search registered; call advance() to evaluate walk edges',
      problem: undefined,
      candidate: null,
      frontiers: new Map(),
      unavailable: new Map(),
      diagnostics: [],
      dependencySections: new Set(),
      dependencyResidency: new Map(),
      nodesExpanded: 0,
      edgesEvaluated: 0,
      edgesOpen: 0,
      edgesBlocked: 0,
      edgesUnknown: 0,
      edgesStale: 0,
      edgesUnsupported: 0,
      edgesSkippedReached: 0,
      frontierCandidates: 0,
      unavailableCandidates: 0,
      diagnosticsTruncated: false,
      frontierLimitReached: false,
      unavailableLimitReached: false,
      nodeLimitReached: false,
      edgeLimitReached: false,
      searchValidUntil: Number.POSITIVE_INFINITY,
      computedAt: now,
      cancellationReason: null,
    };

    if (request.mode !== 'walk') {
      unsupported(search, {
        kind: 'unsupported_mode',
        mode: request.mode,
        detail: 'the walk route search supports mode "walk" only',
      });
    } else if (arrival.kind === 'exact') {
      const dy = target.y - search.start.y;
      if (Math.abs(dy) > EPS) {
        unsupported(search, {
          kind: 'unsupported_target',
          detail: `exact target changes feet height by ${dy}; only the fixed feet height ${search.start.y} is supported`,
        });
      } else {
        classifyExactTarget(search);
      }
    } else {
      search.nearRadius = arrival.radius;
      // Near target: full XYZ distance. The same-height lattice can never be
      // within a radius smaller than the target's fixed height difference.
      const dy = Math.abs(target.y - search.start.y);
      if (dy > arrival.radius + EPS) {
        search.state = 'NO_VERIFIED_PATH';
        search.reason =
          `near radius ${arrival.radius} is smaller than the target height difference ${dy}; ` +
          'no same-height stance can satisfy the full XYZ completion condition';
        search.problem = { kind: 'no_verified_path', blockedEdges: 0, detail: search.reason };
      }
    }

    if (search.state === 'PENDING') {
      const startNode: SearchNode = {
        key: latticeKey(0, 0),
        ix: 0,
        iz: 0,
        depth: 0,
        parentKey: null,
        routeValidUntil: Number.POSITIVE_INFINITY,
      };
      search.nodes.set(startNode.key, startNode);
      search.order.push(startNode.key);

      const startDistance = distance3d(search.start, target);
      if (search.exact !== null) {
        if (search.exact.ix === 0 && search.exact.iz === 0) {
          foundZeroEdge(search, startDistance);
        }
      } else if (startDistance <= arrivalRadius(search) + EPS) {
        foundZeroEdge(search, startDistance);
      }
    }

    search.computedAt = now;
    this.search = search;
    return this.snapshot(now);
  }

  /** Read-only snapshot; `null` before any search has been started. */
  status(): WalkSearchSnapshot | null {
    const search = this.search;
    if (search === null) return null;
    const now = this.currentNow();
    this.checkValidity(search, now);
    return this.snapshot(now);
  }

  /**
   * Evaluate at most `budget` edge items. The search remains `PENDING` when the
   * per-advance budget runs out with work left; it is terminal otherwise.
   */
  advance(budget: number): WalkSearchSnapshot {
    const search = this.requireSearch();
    validateBudget(budget);
    const now = this.currentNow();
    this.checkValidity(search, now);
    if (search.state !== 'PENDING') {
      search.computedAt = now;
      return this.snapshot(now);
    }

    let processed = 0;
    while (processed < budget) {
      const pending = this.nextEdge(search);
      if (pending === null) break;
      this.evaluateEdge(search, pending.nodeKey, DIRECTIONS[pending.dirIndex]!, now);
      processed += 1;

      if (pending.dirIndex + 1 >= DIRECTIONS.length) search.pendingEdge = null;
      else search.pendingEdge = { nodeKey: pending.nodeKey, dirIndex: pending.dirIndex + 1 };

      if (search.state !== 'PENDING') break;
      if (search.edgeLimitReached || search.nodeLimitReached) break;
    }

    if (search.state === 'PENDING') {
      if (search.edgeLimitReached || search.nodeLimitReached) {
        this.finalize(search);
      } else if (this.hasMoreWork(search)) {
        search.reason = `advance budget of ${budget} edge evaluation(s) exhausted; search still pending`;
      } else {
        this.finalize(search);
      }
    }

    search.computedAt = now;
    return this.snapshot(now);
  }

  /**
   * Cancel the search. Already-reached nodes, counters and any candidate found
   * before cancellation are kept; no further edges are evaluated.
   */
  cancel(reason = 'cancelled by caller'): WalkSearchSnapshot {
    const search = this.requireSearch();
    const now = this.currentNow();
    if (search.state !== 'CANCELLED') {
      search.state = 'CANCELLED';
      search.reason = `search cancelled: ${reason}`;
      search.problem = { kind: 'cancelled', reason };
      search.cancellationReason = reason;
      search.pendingEdge = null;
    }
    search.computedAt = now;
    return this.snapshot(now);
  }

  /**
   * Consume a `ChangeReport`. If any section the search already read changed in
   * content, the accumulated conclusions are invalidated. Refresh-only reports
   * and unrelated sections are ignored (the caller may still register a fresh
   * search when it wants refreshed evidence).
   */
  invalidate(report: ChangeReport): void {
    const search = this.search;
    if (search === null || !evidenceBasedState(search.state)) return;
    for (const section of report.sections) {
      if (!section.invalidated) continue;
      if (search.dependencySections.has(sectionKeyString(section.key))) {
        this.invalidateSearch(search, `section ${sectionKeyString(section.key)} changed after the search read it`);
        return;
      }
    }
  }

  /**
   * Consume a residency change (unload/load/load failure) for one or more
   * sections. A residency change does not advance `Section.revision`, so it is
   * reported separately from `ChangeReport`. Per-dependency residency
   * generations are also checked on each advance/status, so this is an explicit
   * caller hook rather than the only protection.
   */
  invalidateSections(keys: readonly SectionKey[]): void {
    const search = this.search;
    if (search === null || !evidenceBasedState(search.state)) return;
    for (const key of keys) {
      if (search.dependencySections.has(sectionKeyString(key))) {
        this.invalidateSearch(search, `section ${sectionKeyString(key)} changed residency after the search read it`);
        return;
      }
    }
  }

  /** Drop the tracked search. A later `status()` returns null. */
  clear(): void {
    this.search = null;
  }

  // --- internals ---

  private requireSearch(): ActiveSearch {
    if (this.search === null) throw new Error('no walk search started');
    return this.search;
  }

  private currentNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error(`now() must return a finite number: ${now}`);
    return now;
  }

  private nextEdge(search: ActiveSearch): { nodeKey: string; dirIndex: number } | null {
    if (search.pendingEdge !== null) return search.pendingEdge;
    if (search.nextNodeIndex >= search.order.length) return null;
    const nodeKey = search.order[search.nextNodeIndex]!;
    search.nextNodeIndex += 1;
    search.nodesExpanded += 1;
    search.pendingEdge = { nodeKey, dirIndex: 0 };
    return search.pendingEdge;
  }

  private evaluateEdge(
    search: ActiveSearch,
    nodeKey: string,
    dir: Direction,
    now: number,
  ): void {
    const node = search.nodes.get(nodeKey);
    if (node === undefined) return;
    const nx = node.ix + dir.dx;
    const nz = node.iz + dir.dz;
    const neighborKey = latticeKey(nx, nz);
    const stance = nodePosition(search, node);
    const to = {
      x: search.start.x + nx,
      y: search.start.y,
      z: search.start.z + nz,
    };

    if (search.nodes.has(neighborKey)) {
      search.edgesSkippedReached += 1;
      return;
    }
    if (search.edgesEvaluated >= this.maxEdges) {
      search.edgeLimitReached = true;
      return;
    }

    const query: StepQuery = {
      worldId: search.worldId,
      dim: search.dim,
      sessionId: search.sessionId,
      mode: 'walk',
      body: {
        feet: stance,
        width: search.body.width,
        height: search.body.height,
        pose: search.body.pose,
      },
      direction: { axis: dir.axis, sign: dir.sign },
    };
    const evaluation = evaluateWalkStep(this.map, query, search.shapeProvider, now);
    search.edgesEvaluated += 1;
    for (const dep of evaluation.dependencies) {
      const ks = sectionKeyString(dep.key);
      search.dependencySections.add(ks);
      search.dependencyResidency.set(ks, {
        key: { ...dep.key },
        generation: this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy),
      });
    }

    if (evaluation.status === 'OPEN') {
      search.edgesOpen += 1;
      if (search.nodes.size >= this.maxNodes) {
        search.nodeLimitReached = true;
        return;
      }
      const routeValidUntil = Math.min(node.routeValidUntil, evaluation.validUntil);
      const newNode: SearchNode = {
        key: neighborKey,
        ix: nx,
        iz: nz,
        depth: node.depth + 1,
        parentKey: nodeKey,
        routeValidUntil,
      };
      search.nodes.set(neighborKey, newNode);
      search.order.push(neighborKey);
      // The adjacent stance is now known reachable; an earlier UNKNOWN boundary
      // record for the same neighbour is no longer a boundary claim.
      search.frontiers.delete(neighborKey);
      search.unavailable.delete(neighborKey);
      search.searchValidUntil = Math.min(search.searchValidUntil, routeValidUntil);

      if (this.reachesTarget(search, nx, nz, to)) {
        search.candidate = this.buildCandidate(search, neighborKey);
        search.state = 'FOUND';
        search.problem = undefined;
        search.reason =
          `found a currently OPEN ${search.candidate.edgeCount}-edge walk candidate; ` +
          'it is not an arrival and must be verified and measured by the caller';
      }
      return;
    }

    this.addDiagnostic(search, stance, to, evaluation, now);

    if (evaluation.status === 'BLOCKED') {
      search.edgesBlocked += 1;
    } else if (evaluation.status === 'UNKNOWN') {
      search.edgesUnknown += 1;
      this.recordUnknownBoundary(search, node, stance, to, neighborKey, evaluation, now);
    } else if (evaluation.status === 'STALE') {
      search.edgesStale += 1;
    } else {
      search.edgesUnsupported += 1;
    }
  }

  private reachesTarget(search: ActiveSearch, ix: number, iz: number, pos: Vec3Like): boolean {
    if (search.exact !== null) return ix === search.exact.ix && iz === search.exact.iz;
    return distance3d(pos, search.target) <= arrivalRadius(search) + EPS;
  }

  private buildCandidate(search: ActiveSearch, nodeKey: string): WalkSearchCandidate {
    const chain: SearchNode[] = [];
    let cursor: string | null = nodeKey;
    while (cursor !== null) {
      const node = search.nodes.get(cursor);
      if (node === undefined) break;
      chain.push(node);
      cursor = node.parentKey;
    }
    chain.reverse();
    const points = chain.map((node) => nodePosition(search, node));
    const reachedAt = { ...points[points.length - 1]! };
    return {
      points,
      edgeCount: points.length - 1,
      reachedAt,
      target: { ...search.target },
      arrival: cloneArrival(search.arrival),
      distanceToTarget: distance3d(reachedAt, search.target),
      validUntil: search.nodes.get(nodeKey)?.routeValidUntil ?? Number.POSITIVE_INFINITY,
    };
  }

  /**
   * An UNKNOWN edge is either a genuine never-observed frontier or a gap in old
   * evidence whose section is saved but not resident. The latter is reported
   * separately and never labelled as a new frontier.
   */
  private recordUnknownBoundary(
    search: ActiveSearch,
    node: SearchNode,
    stance: Vec3Like,
    to: Vec3Like,
    neighborKey: string,
    evaluation: StepEvaluation,
    now: number,
  ): void {
    const gap = dedupeCells(evaluation.problem?.cells ?? []);
    const cells = gap.length > 0 ? gap : [feetCell(to)];
    const unavailableSections = new Map<string, WalkSearchUnavailableSection>();
    for (const cell of cells) {
      const { cx, cz, sy } = blockToSection(cell.x, cell.y, cell.z);
      const key: SectionKey = { worldId: search.worldId, dim: search.dim, cx, cz, sy };
      const info = this.map.sectionResidency(key);
      if (info.residency === 'not_resident' || info.residency === 'loading' || info.residency === 'load_failed') {
        const ks = sectionKeyString(key);
        if (!unavailableSections.has(ks)) {
          unavailableSections.set(ks, {
            key: { ...key },
            residency: info.residency,
            committedRevision: info.committed?.revision,
          });
        }
      }
    }

    const basis = this.stanceBasis(search, node, now);
    const validUntil = Math.min(node.routeValidUntil, evaluation.validUntil, basis.validUntil);
    search.searchValidUntil = Math.min(search.searchValidUntil, validUntil);
    const reason = evaluation.reason ?? 'required cells are unobserved or state-incomplete';

    if (unavailableSections.size > 0) {
      search.unavailableCandidates += 1;
      if (search.unavailable.has(neighborKey)) return;
      if (search.unavailable.size >= this.maxFrontiers) {
        search.unavailableLimitReached = true;
        return;
      }
      search.unavailable.set(neighborKey, {
        stance: { ...stance },
        to: { ...to },
        gap: cells.map((cell) => ({ ...cell })),
        sections: [...unavailableSections.values()].map((section) => ({
          ...section,
          key: { ...section.key },
        })),
        basis: basis.observations,
        reason,
        computedAt: now,
        validUntil,
      });
      return;
    }

    search.frontierCandidates += 1;
    if (search.frontiers.has(neighborKey)) return;
    if (search.frontiers.size >= this.maxFrontiers) {
      search.frontierLimitReached = true;
      return;
    }
    search.frontiers.set(neighborKey, {
      stance: { ...stance },
      to: { ...to },
      gap: cells.map((cell) => ({ ...cell })),
      reachability: 'OPEN',
      basis: basis.observations,
      reason,
      computedAt: now,
      validUntil,
    });
  }

  /** Bounded locally observed basis for a reachable stance; never a world scan. */
  private stanceBasis(
    search: ActiveSearch,
    node: SearchNode,
    now: number,
  ): { observations: Observation[]; validUntil: number } {
    const pos = nodePosition(search, node);
    const x = Math.floor(pos.x + EPS);
    const z = Math.floor(pos.z + EPS);
    const feetY = Math.floor(pos.y + EPS);
    const supportY = Math.ceil(pos.y - EPS) - 1;
    const cells = [
      { x, y: feetY, z },
      { x, y: feetY + 1, z },
      { x, y: supportY, z },
    ];
    const seen = new Set<string>();
    const observations: Observation[] = [];
    let validUntil = Number.POSITIVE_INFINITY;
    for (const cell of cells) {
      const key = `${cell.x},${cell.y},${cell.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const view = this.map.cellAt(search.dim, cell.x, cell.y, cell.z);
      if (!view.observed) continue;
      const evidence: CellEvidence = view.evidence;
      if (
        evidence.freshness !== 'FRESH' ||
        evidence.observation.sessionId !== search.sessionId ||
        now > evidence.validUntil
      ) {
        continue;
      }
      observations.push(cloneObservation(evidence.observation));
      validUntil = Math.min(validUntil, evidence.validUntil);
    }
    return { observations, validUntil };
  }

  private addDiagnostic(
    search: ActiveSearch,
    stance: Vec3Like,
    to: Vec3Like,
    evaluation: StepEvaluation,
    now: number,
  ): void {
    if (evaluation.status === 'OPEN') return;
    if (search.diagnostics.length >= this.maxDiagnostics) {
      search.diagnosticsTruncated = true;
      return;
    }
    search.diagnostics.push({
      stance: { ...stance },
      to: { ...to },
      status: evaluation.status,
      reason: evaluation.reason ?? evaluation.status,
      problem: evaluation.problem === undefined ? undefined : cloneProblem(evaluation.problem),
      computedAt: now,
    });
  }

  /** Terminal-state selection after the reachable region has been exhausted. */
  private finalize(search: ActiveSearch): void {
    if (search.state !== 'PENDING') return;
    if (search.edgeLimitReached || search.nodeLimitReached) {
      const edgeLimitReached = search.edgeLimitReached;
      const nodeLimitReached = search.nodeLimitReached;
      search.state = 'BUDGET_EXHAUSTED';
      const facts: string[] = [];
      if (nodeLimitReached) facts.push(`node limit maxNodes=${this.maxNodes} reached (${search.nodes.size} nodes)`);
      if (edgeLimitReached) facts.push(`edge limit maxEdges=${this.maxEdges} reached (${search.edgesEvaluated} edges)`);
      search.reason = `search budget exhausted: ${facts.join('; ')}; the OPEN-reachable region was not fully explored`;
      search.problem = {
        kind: 'budget_exhausted',
        nodeLimitReached,
        edgeLimitReached,
        maxNodes: this.maxNodes,
        maxEdges: this.maxEdges,
        nodesReached: search.nodes.size,
        edgesEvaluated: search.edgesEvaluated,
      };
      return;
    }

    if (search.edgesUnknown > 0 || search.edgesStale > 0 || search.edgesUnsupported > 0) {
      search.state = 'INSUFFICIENT_EVIDENCE';
      search.reason =
        `search could not prove a current route: ${search.edgesUnknown} UNKNOWN, ` +
        `${search.edgesStale} STALE and ${search.edgesUnsupported} UNSUPPORTED boundary edge(s); ` +
        `${search.frontiers.size} never-observed frontier(s) and ${search.unavailable.size} unavailable saved-section gap(s)`;
      search.problem = {
        kind: 'insufficient_evidence',
        unknownEdges: search.edgesUnknown,
        staleEdges: search.edgesStale,
        unsupportedEdges: search.edgesUnsupported,
        unavailableHistoricalEdges: search.unavailableCandidates,
      };
      return;
    }

    search.state = 'NO_VERIFIED_PATH';
    search.reason =
      `no currently OPEN walk route reaches the target from the fixed feet position; ` +
      `${search.edgesBlocked} boundary edge(s) were BLOCKED and no unresolved boundary evidence remains`;
    search.problem = { kind: 'no_verified_path', blockedEdges: search.edgesBlocked };
  }

  private hasMoreWork(search: ActiveSearch): boolean {
    return search.pendingEdge !== null || search.nextNodeIndex < search.order.length;
  }

  /**
   * Revoke accumulated conclusions when the evidence they rest on is no longer
   * current: rule-version change, expiry, or a section residency change. There
   * is no automatic re-search; the caller must start a fresh request.
   */
  private checkValidity(search: ActiveSearch, now: number): void {
    if (search.state !== 'PENDING' && search.state !== 'FOUND') return;
    if (search.shapeProvider.version !== search.ruleVersion) {
      this.invalidateSearch(
        search,
        `collision rule version changed from "${search.ruleVersion}" to "${search.shapeProvider.version}"`,
      );
      return;
    }
    if (now > search.searchValidUntil) {
      this.invalidateSearch(
        search,
        `evidence used by the search was valid until ${search.searchValidUntil}, before ${now}`,
      );
      return;
    }
    for (const dep of search.dependencyResidency.values()) {
      const current = this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy);
      if (current !== dep.generation) {
        this.invalidateSearch(
          search,
          `section ${sectionKeyString(dep.key)} appears to have changed residency`,
        );
        return;
      }
    }
  }

  private invalidateSearch(search: ActiveSearch, detail: string): void {
    search.state = 'INVALIDATED';
    search.reason = `search evidence invalidated: ${detail}; start a fresh search request`;
    search.problem = { kind: 'invalidated', reason: detail };
    search.candidate = null;
    search.frontiers.clear();
    search.unavailable.clear();
    search.pendingEdge = null;
  }

  private snapshot(now: number): WalkSearchSnapshot {
    const search = this.search;
    if (search === null) throw new Error('no walk search started');
    return {
      state: search.state,
      worldId: search.worldId,
      dim: search.dim,
      sessionId: search.sessionId,
      mode: search.mode,
      body: cloneBody(search.body),
      from: { ...search.start },
      target: { ...search.target },
      arrival: cloneArrival(search.arrival),
      ruleVersion: search.ruleVersion,
      limits: {
        maxNodes: this.maxNodes,
        maxEdges: this.maxEdges,
        maxFrontiers: this.maxFrontiers,
        maxDiagnostics: this.maxDiagnostics,
      },
      candidate:
        search.candidate === null
          ? null
          : {
              ...search.candidate,
              points: search.candidate.points.map((point) => ({ ...point })),
              reachedAt: { ...search.candidate.reachedAt },
              target: { ...search.candidate.target },
              arrival: cloneArrival(search.candidate.arrival),
            },
      frontiers: [...search.frontiers.values()].map(cloneFrontier),
      unavailableHistorical: [...search.unavailable.values()].map(cloneUnavailable),
      diagnostics: search.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        stance: { ...diagnostic.stance },
        to: { ...diagnostic.to },
        problem: diagnostic.problem === undefined ? undefined : cloneProblem(diagnostic.problem),
      })),
      counters: {
        nodesReached: search.nodes.size,
        nodesExpanded: search.nodesExpanded,
        edgesEvaluated: search.edgesEvaluated,
        edgesOpen: search.edgesOpen,
        edgesBlocked: search.edgesBlocked,
        edgesUnknown: search.edgesUnknown,
        edgesStale: search.edgesStale,
        edgesUnsupported: search.edgesUnsupported,
        edgesSkippedReached: search.edgesSkippedReached,
        frontierCandidates: search.frontierCandidates,
        frontiersReported: search.frontiers.size,
        frontierLimitReached: search.frontierLimitReached,
        unavailableHistoricalCandidates: search.unavailableCandidates,
        unavailableHistoricalReported: search.unavailable.size,
        unavailableHistoricalLimitReached: search.unavailableLimitReached,
        diagnosticsReported: search.diagnostics.length,
        diagnosticsTruncated: search.diagnosticsTruncated,
        hasMoreWork: search.state === 'PENDING' && this.hasMoreWork(search),
      },
      reason: search.reason,
      problem: search.problem === undefined ? undefined : { ...search.problem },
      computedAt: now,
      validUntil:
        search.candidate !== null ? search.candidate.validUntil : search.searchValidUntil,
      cancellation:
        search.cancellationReason === null ? undefined : { reason: search.cancellationReason },
    };
  }
}

/** Apply an exact lattice classification or an explicit capability limitation. */
function classifyExactTarget(search: ActiveSearch): void {
  const dx = search.target.x - search.start.x;
  const dz = search.target.z - search.start.z;
  const ix = Math.round(dx);
  const iz = Math.round(dz);
  if (!Number.isSafeInteger(ix) || Math.abs(dx - ix) > EPS) {
    unsupported(search, {
      kind: 'unsupported_target',
      detail:
        `exact target X offset ${dx} is not an integer number of ±1 X steps on the fixed feet lattice; ` +
        'the target was not rounded',
    });
    return;
  }
  if (!Number.isSafeInteger(iz) || Math.abs(dz - iz) > EPS) {
    unsupported(search, {
      kind: 'unsupported_target',
      detail:
        `exact target Z offset ${dz} is not an integer number of ±1 Z steps on the fixed feet lattice; ` +
        'the target was not rounded',
    });
    return;
  }
  search.exact = { ix, iz };
}

function unsupported(search: ActiveSearch, problem: WalkSearchProblem): void {
  search.state = 'UNSUPPORTED';
  search.problem = problem;
  search.reason =
    problem.kind === 'unsupported_mode' || problem.kind === 'unsupported_target'
      ? `unsupported capability: ${problem.detail}`
      : 'unsupported capability';
}

function foundZeroEdge(search: ActiveSearch, distance: number): void {
  search.state = 'FOUND';
  search.candidate = {
    points: [{ ...search.start }],
    edgeCount: 0,
    reachedAt: { ...search.start },
    target: { ...search.target },
    arrival: cloneArrival(search.arrival),
    distanceToTarget: distance,
    validUntil: Number.POSITIVE_INFINITY,
  };
  search.reason =
    'the fixed start already satisfies the target completion condition; ' +
    'this is a zero-edge candidate only, not ARRIVED and not evidence of movement';
}

function arrivalRadius(search: ActiveSearch): number {
  return search.nearRadius ?? 0;
}

function nodePosition(search: ActiveSearch, node: SearchNode): Vec3Like {
  return { x: search.start.x + node.ix, y: search.start.y, z: search.start.z + node.iz };
}

function latticeKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

function distance3d(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function feetCell(pos: Vec3Like): Vec3Like {
  return {
    x: Math.floor(pos.x + EPS),
    y: Math.floor(pos.y + EPS),
    z: Math.floor(pos.z + EPS),
  };
}

function dedupeCells(cells: readonly Vec3Like[]): Vec3Like[] {
  const seen = new Set<string>();
  const out: Vec3Like[] = [];
  for (const cell of cells) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: cell.x, y: cell.y, z: cell.z });
  }
  return out;
}

function evidenceBasedState(state: WalkSearchState): boolean {
  return (
    state === 'PENDING' ||
    state === 'FOUND' ||
    state === 'NO_VERIFIED_PATH' ||
    state === 'INSUFFICIENT_EVIDENCE' ||
    state === 'BUDGET_EXHAUSTED'
  );
}

function resolveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer: ${value}`);
  }
  return value;
}

function validateBudget(budget: number): void {
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`budget must be a positive integer: ${budget}`);
  }
}

function validateBody(body: BodyContext): void {
  if (
    !Number.isFinite(body.feet.x) ||
    !Number.isFinite(body.feet.y) ||
    !Number.isFinite(body.feet.z) ||
    !Number.isFinite(body.width) ||
    !Number.isFinite(body.height)
  ) {
    throw new Error('body feet and dimensions must be finite numbers');
  }
  if (body.width <= 0 || body.height <= 0) {
    throw new Error(`body dimensions must be positive: width ${body.width}, height ${body.height}`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number: ${value}`);
}

function snapshotVec(value: Vec3Like): Vec3Like {
  return { x: value.x, y: value.y, z: value.z };
}

function snapshotBody(body: BodyContext): BodyContext {
  return { feet: { ...body.feet }, width: body.width, height: body.height, pose: body.pose };
}

function cloneBody(body: BodyContext): BodyContext {
  return { feet: { ...body.feet }, width: body.width, height: body.height, pose: body.pose };
}

function snapshotArrival(arrival: WalkSearchArrival): WalkSearchArrival {
  if (arrival.kind === 'exact') return { kind: 'exact' };
  if (arrival.kind === 'near') {
    if (!Number.isFinite(arrival.radius) || arrival.radius < 0) {
      throw new Error(`near radius must be a finite non-negative number: ${arrival.radius}`);
    }
    return { kind: 'near', radius: arrival.radius };
  }
  throw new Error(`arrival.kind must be "exact" or "near"`);
}

function cloneArrival(arrival: WalkSearchArrival): WalkSearchArrival {
  return arrival.kind === 'exact' ? { kind: 'exact' } : { kind: 'near', radius: arrival.radius };
}

function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { ...observation.pos },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

function cloneProblem(problem: StepProblem): StepProblem {
  return {
    ...problem,
    cells: problem.cells.map((cell) => ({ ...cell })),
  };
}

function cloneFrontier(frontier: WalkSearchFrontier): WalkSearchFrontier {
  return {
    ...frontier,
    stance: { ...frontier.stance },
    to: { ...frontier.to },
    gap: frontier.gap.map((cell) => ({ ...cell })),
    basis: frontier.basis.map(cloneObservation),
  };
}

function cloneUnavailable(entry: WalkSearchUnavailableEvidence): WalkSearchUnavailableEvidence {
  return {
    ...entry,
    stance: { ...entry.stance },
    to: { ...entry.to },
    gap: entry.gap.map((cell) => ({ ...cell })),
    sections: entry.sections.map((section) => ({ ...section, key: { ...section.key } })),
    basis: entry.basis.map(cloneObservation),
  };
}
