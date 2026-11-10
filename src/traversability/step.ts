/**
 * Read-only single-step walk evaluator (design §3.3, §10 phase 3 first step).
 *
 * Given evidence already accepted by a `VoxelMap`, a body context and a
 * direction, `evaluateWalkStep` answers whether a one-cell, same-height,
 * straight horizontal move along X or Z is OPEN / BLOCKED / UNKNOWN / STALE, or
 * UNSUPPORTED when the range is outside what this evaluator can judge.
 *
 * The body lives in continuous space (a feet position + an AABB); block cells
 * live on the integer grid. Conversion happens only at the query-vs-cell
 * boundary and never silently floors the body position. Everything the
 * evaluator needs (dimensions, pose, mode, session, time, shape rules) is
 * supplied by the caller or the injected provider — never read from host global
 * state. Reads go through the map's live read-only section view
 * (`VoxelMap.sectionRef`, no deep copy). The view is held only for the call;
 * no evidence object leaves it — an obstacle `Observation`, the mutable
 * `BlockState` handed to the shape provider, and observed states are all
 * copied — so an evaluation never mutates evidence, time or version.
 *
 * Support is checked continuously over the whole move: the swept footprint must
 * overlap some standable top face at every instant (exact interval coverage,
 * not fixed sampling), so a narrow gap is never missed and a partial overhang
 * is not mistaken for total loss of support.
 */

import { cloneObservation } from '../observation/clone.js';
import type { CellEvidence } from '../observation/types.js';
import type { BlockState, MoveMode, Vec3Like } from '../types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionRef, VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShape, CollisionShapeProvider, NeighborCellView, NeighborRead, UnitBox } from './collision-shape.js';
import type { HazardFact, ObstacleEvidence, Traversability } from './types.js';

/** The four passage states plus the capability gap they cannot express. */
export type StepStatus = Traversability | 'UNSUPPORTED';

export interface BodyContext {
  /** Feet position in continuous space; never silently floored to a cell. */
  feet: Vec3Like;
  /** AABB width (X/Z extent) and height (Y) in blocks, e.g. 0.6 × 1.8. */
  width: number;
  height: number;
  /** Fixed pose this round. */
  pose: 'standing';
}

export interface StepDirection {
  axis: 'x' | 'z';
  sign: 1 | -1;
}

/** Delegation constraints carried into the cache key; no walk-geometry constraint is consumed this round. */
export interface StepConstraints {
  avoid?: readonly Vec3Like[];
}

export interface StepQuery {
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  body: BodyContext;
  direction: StepDirection;
  constraints?: StepConstraints;
}

export interface StepProblem {
  kind:
    | 'collision'
    | 'missing_support'
    | 'unobserved'
    | 'stale'
    | 'unsupported_mode'
    | 'unsupported_shape';
  cells: Vec3Like[];
  detail?: string;
}

export interface StepEvaluation {
  status: StepStatus;
  from: Vec3Like;
  to: Vec3Like;
  mode: 'walk';
  reason?: string;
  problem?: StepProblem;
  /** Confirmed obstacle for a BLOCKED collision. */
  obstacles: ObstacleEvidence[];
  /**
   * Objective risk facts observed along the body path (water/lava contact,
   * submersion, bubble column) or derived from a measured drop. Independent of
   * the passage status: an OPEN step may still carry hazards.
   */
  hazards?: HazardFact[];
  /** Normalized body/pose/mode/delegation key this judgement was computed under. */
  contextKey?: string;
  /** Actual section reads (deduped), for local cache invalidation. */
  dependencies: { key: SectionKey; revision: number }[];
  sessionId: string;
  computedAt: number;
  /** min validUntil over evidence still valid at evaluation time; Infinity when no such evidence was read. */
  validUntil: number;
}

interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Epsilon for treating exact-boundary contact as non-overlap. */
const EPS = 1e-9;

type CellRead =
  | { kind: 'missing'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'stale'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'expired'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'session'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'incomplete'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'observed'; sectionKey: SectionKey; sectionRevision: number; evidence: Readonly<CellEvidence> };

type ShapeResult =
  | { kind: 'shape'; shape: CollisionShape }
  | { kind: 'unsupported'; cell: Vec3Like; detail: string }
  | { kind: 'gap'; view: NeighborCellView };

interface Accumulator {
  blocked: { reason: string; problem: StepProblem; obstacles: ObstacleEvidence[] } | null;
  unsupported: { problem: StepProblem } | null;
  staleCells: Vec3Like[];
  unknownCells: Vec3Like[];
}

type SupportCandidate = {
  kind: 'unsupported' | 'stale' | 'unknown';
  cell: Vec3Like;
  /** Best-case (full-cell) support interval, or null when the cell cannot reach the footprint. */
  interval: [number, number] | null;
};

function bodyAabb(feet: Vec3Like, half: number, height: number): Aabb {
  return {
    minX: feet.x - half,
    maxX: feet.x + half,
    minY: feet.y,
    maxY: feet.y + height,
    minZ: feet.z - half,
    maxZ: feet.z + half,
  };
}

function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/** Integer grid cells overlapping a continuous AABB. */
function cellsInAabb(aabb: Aabb): Vec3Like[] {
  const minBX = Math.floor(aabb.minX + EPS);
  const maxBX = Math.floor(aabb.maxX - EPS);
  const minBY = Math.floor(aabb.minY + EPS);
  const maxBY = Math.floor(aabb.maxY - EPS);
  const minBZ = Math.floor(aabb.minZ + EPS);
  const maxBZ = Math.floor(aabb.maxZ - EPS);
  const cells: Vec3Like[] = [];
  for (let x = minBX; x <= maxBX; x++) {
    for (let y = minBY; y <= maxBY; y++) {
      for (let z = minBZ; z <= maxBZ; z++) {
        cells.push({ x, y, z });
      }
    }
  }
  return cells;
}

/**
 * Time interval `[tMin, tMax] ⊆ [0, 1]` during which the linearly-moving interval
 * `[min0 + d·t, max0 + d·t]` overlaps the static interval `[sMin, sMax]`, or null
 * when there is no positive-length overlap. Overlap is strict (positive-area), so
 * a merely touching contact yields null.
 */
function axisSweepOverlapTimes(
  min0: number,
  max0: number,
  d: number,
  sMin: number,
  sMax: number,
): [number, number] | null {
  if (d === 0) {
    return max0 - sMin > EPS && sMax - min0 > EPS ? [0, 1] : null;
  }
  const tA = (sMin - max0) / d;
  const tB = (sMax - min0) / d;
  const tMin = Math.max(0, Math.min(tA, tB));
  const tMax = Math.min(1, Math.max(tA, tB));
  // A near-degenerate interval (e.g. an exact-touch contact whose computed time is
  // 0.999…6 rather than 1.0) is a touch, not a collision.
  return tMax - tMin > EPS ? [tMin, tMax] : null;
}

/**
 * Exact swept collision of the moving body AABB (feet `from → to`, constant height)
 * against one box. The body's X and Z overlaps must happen over a common time
 * interval — a corner of the swept *envelope* that the body never actually enters is
 * not a collision. The envelope (`cellsInAabb(sweep)`) is still used to filter
 * candidate cells; this is the precise confirm.
 */
function boxSweepOverlaps(
  cx: number,
  cy: number,
  cz: number,
  box: UnitBox,
  from: Vec3Like,
  to: Vec3Like,
  half: number,
  height: number,
): boolean {
  // The body's Y interval [feet.y, feet.y + height] also moves with the feet, so a
  // rise/fall (bodyArrival tolerates a foot-height deviation) must be swept too —
  // a constant start-height check would miss a rise into a ceiling or wrongly block
  // a descent that clears an obstacle.
  const xTimes = axisSweepOverlapTimes(from.x - half, from.x + half, to.x - from.x, cx + box.minX, cx + box.maxX);
  if (xTimes === null) return false;
  const yTimes = axisSweepOverlapTimes(from.y, from.y + height, to.y - from.y, cy + box.minY, cy + box.maxY);
  if (yTimes === null) return false;
  const zTimes = axisSweepOverlapTimes(from.z - half, from.z + half, to.z - from.z, cz + box.minZ, cz + box.maxZ);
  if (zTimes === null) return false;

  const tMin = Math.max(xTimes[0], yTimes[0], zTimes[0]);
  const tMax = Math.min(xTimes[1], yTimes[1], zTimes[1]);
  return tMax - tMin > EPS;
}

/**
 * Maximal closed sub-intervals of [segMin, segMax] that no support interval
 * covers. Intervals are open (positive-area contact only), so edge contact and
 * intervals that merely touch at an endpoint do not count as support.
 */
function uncoveredGaps(
  intervals: ReadonlyArray<readonly [number, number]>,
  segMin: number,
  segMax: number,
): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lo < last[1]) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }

  const gaps: Array<[number, number]> = [];
  let cursor = segMin;
  for (const [lo, hi] of merged) {
    if (hi <= cursor) continue;
    if (lo > segMax) break;
    if (lo >= cursor) {
      gaps.push([cursor, Math.min(lo, segMax)]);
      cursor = hi;
    } else {
      cursor = hi; // cursor is strictly inside (lo, hi)
    }
    if (cursor >= segMax) break;
  }
  if (cursor <= segMax) gaps.push([cursor, segMax]);
  return gaps;
}

/** True when an interval has positive overlap with any of the given gaps. */
function overlapsAnyGap(
  interval: readonly [number, number],
  gaps: ReadonlyArray<readonly [number, number]>,
): boolean {
  return gaps.some(([gapLo, gapHi]) => interval[1] > gapLo && interval[0] < gapHi);
}

/**
 * Evaluate one walk step. Pure with respect to the map: it reads snapshots and
 * never writes, scans, or refreshes evidence.
 */
export function evaluateWalkStep(
  map: VoxelMap,
  query: StepQuery,
  shapeProvider: CollisionShapeProvider,
  now: number,
): StepEvaluation {
  return evaluateWalkGeometry(map, query, shapeProvider, now);
}

/** Historical geometry is a candidate, never a current OPEN passage proof. */
export interface RememberedWalkGeometry {
  geometry: 'PASSABLE' | 'OBSTRUCTED' | 'UNKNOWN' | 'UNSUPPORTED';
  assurance: 'historical_geometry';
  executable: false;
  from: Vec3Like;
  to: Vec3Like;
  reason?: string;
  hazards: HazardFact[];
  obstacles: ObstacleEvidence[];
  dependencies: StepEvaluation['dependencies'];
}

/** Internal planning boundary: use recorded shapes without changing their evidence. */
export function evaluateRememberedWalkStep(
  map: VoxelMap,
  query: StepQuery,
  shapeProvider: CollisionShapeProvider,
  now: number,
): RememberedWalkGeometry {
  const result = evaluateWalkGeometry(map, query, shapeProvider, now, undefined, true);
  return {
    geometry: result.status === 'OPEN' ? 'PASSABLE'
      : result.status === 'BLOCKED' ? 'OBSTRUCTED'
      : result.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNKNOWN',
    assurance: 'historical_geometry',
    executable: false,
    from: result.from,
    to: result.to,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    hazards: result.hazards ?? [],
    obstacles: result.obstacles,
    dependencies: result.dependencies,
  };
}

/**
 * Continuous corridor from actual feet to the unchanged next route endpoint.
 * For measured execution/arrival, not route search: horizontal length is bounded
 * to one block plus the 0.12-block body arrival tolerance. All swept collision
 * and support evidence is checked at the supplied continuous coordinates.
 */
export function evaluateWalkSegment(
  map: VoxelMap,
  query: StepQuery,
  to: Vec3Like,
  shapeProvider: CollisionShapeProvider,
  now: number,
  feetTolerance: number,
): StepEvaluation {
  if (![to.x, to.y, to.z, feetTolerance].every(Number.isFinite)) {
    throw new Error('walk segment endpoint and feetTolerance must be finite');
  }
  if (feetTolerance < 0 || feetTolerance >= 0.5) {
    throw new Error('walk segment feetTolerance must be in [0, 0.5)');
  }
  if (Math.hypot(to.x - query.body.feet.x, to.z - query.body.feet.z) > 1.12 + EPS
    || Math.abs(to.y - query.body.feet.y) > feetTolerance + EPS) {
    return {
      status: 'UNSUPPORTED', from: { ...query.body.feet }, to: { ...to }, mode: 'walk',
      reason: 'measured walk segment exceeds the supported local correction range',
      problem: { kind: 'unsupported_mode', cells: [], detail: 'horizontal distance must be at most 1.12 blocks and vertical distance within feetTolerance' },
      obstacles: [], hazards: [], dependencies: [], sessionId: query.sessionId,
      computedAt: now, validUntil: Number.POSITIVE_INFINITY,
    };
  }
  return evaluateGroundedWalkSegment(map, query, to, shapeProvider, now, feetTolerance);
}

/** Internal measured corridor, including non-walk arrival diagnostics. */
export function evaluateGroundedWalkSegment(
  map: VoxelMap,
  query: StepQuery,
  to: Vec3Like,
  shapeProvider: CollisionShapeProvider,
  now: number,
  feetTolerance: number,
): StepEvaluation {
  return evaluateWalkGeometry(map, query, shapeProvider, now, { to, feetTolerance });
}

function evaluateWalkGeometry(
  map: VoxelMap,
  query: StepQuery,
  shapeProvider: CollisionShapeProvider,
  now: number,
  measured?: { to: Vec3Like; feetTolerance: number },
  remembered = false,
): StepEvaluation {
  if (query.worldId !== map.worldId) {
    throw new Error(`query worldId "${query.worldId}" does not match map worldId "${map.worldId}"`);
  }

  const { body, direction, dim, sessionId } = query;
  if (
    !Number.isFinite(body.feet.x) ||
    !Number.isFinite(body.feet.y) ||
    !Number.isFinite(body.feet.z) ||
    !Number.isFinite(body.width) ||
    !Number.isFinite(body.height)
  ) {
    throw new Error(`body feet and dimensions must be finite numbers`);
  }
  if (body.width <= 0 || body.height <= 0) {
    throw new Error(`body dimensions must be positive: width ${body.width}, height ${body.height}`);
  }
  if (!Number.isFinite(now)) {
    throw new Error(`now must be a finite number: ${now}`);
  }

  const base: StepEvaluation = {
    status: 'UNSUPPORTED',
    from: { ...body.feet },
    to: { ...body.feet },
    mode: 'walk',
    obstacles: [],
    hazards: [],
    contextKey: stepContextKey(query),
    dependencies: [],
    sessionId,
    computedAt: now,
    validUntil: Number.POSITIVE_INFINITY,
  };

  if (query.mode !== 'walk') {
    return {
      ...base,
      reason: `mode "${query.mode}" is not supported by the walk evaluator`,
      problem: { kind: 'unsupported_mode', cells: [], detail: 'supported mode: walk' },
    };
  }
  if (direction.axis !== 'x' && direction.axis !== 'z') {
    return {
      ...base,
      reason: `direction axis "${direction.axis}" is outside the walk evaluator's range`,
      problem: { kind: 'unsupported_mode', cells: [], detail: 'axis must be x or z' },
    };
  }
  if (direction.sign !== 1 && direction.sign !== -1) {
    return {
      ...base,
      reason: `direction sign ${direction.sign} is outside the walk evaluator's range`,
      problem: { kind: 'unsupported_mode', cells: [], detail: 'sign must be 1 or -1' },
    };
  }

  const to: Vec3Like = measured?.to ?? (
    direction.axis === 'x'
      ? { x: body.feet.x + direction.sign, y: body.feet.y, z: body.feet.z }
      : { x: body.feet.x, y: body.feet.y, z: body.feet.z + direction.sign });
  base.to = to;

  const half = body.width / 2;
  const sweep = unionAabb(bodyAabb(body.feet, half, body.height), bodyAabb(to, half, body.height));

  const acc: Accumulator = {
    blocked: null,
    unsupported: null,
    staleCells: [],
    unknownCells: [],
  };

  const deps = new Map<string, { key: SectionKey; revision: number }>();
  const recordDep = (key: SectionKey, revision: number): void => {
    const ks = sectionKeyString(key);
    if (!deps.has(ks)) deps.set(ks, { key: { ...key }, revision });
  };

  // Live read-only section views (no deep copy). The call holds them only for
  // its own duration; every mutable value that leaves it is copied below
  // (obstacle observations, `neighborRead` states, observed states).
  const sectionCache = new Map<string, SectionRef | null>();
  let minValidUntil = Number.POSITIVE_INFINITY;

  const readCell = (x: number, y: number, z: number): CellRead => {
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const sectionKey: SectionKey = { worldId: query.worldId, dim, cx, cz, sy };
    const cacheKey = `${cx},${cz},${sy}`;
    let section = sectionCache.get(cacheKey);
    if (section === undefined) {
      section = map.sectionRef(dim, x, y, z);
      sectionCache.set(cacheKey, section);
    }
    if (section === null) {
      recordDep(sectionKey, 0);
      return { kind: 'missing', sectionKey, sectionRevision: 0 };
    }
    recordDep(sectionKey, section.revision);
    const evidence = section.evidence.get(cellIndex(lx, ly, lz));
    if (evidence === undefined) {
      return { kind: 'missing', sectionKey, sectionRevision: section.revision };
    }
    if (!remembered && evidence.freshness === 'STALE') {
      return { kind: 'stale', sectionKey, sectionRevision: section.revision };
    }
    if (!remembered && evidence.observation.sessionId !== query.sessionId) {
      return { kind: 'session', sectionKey, sectionRevision: section.revision };
    }
    if (!remembered && now > evidence.validUntil) {
      return { kind: 'expired', sectionKey, sectionRevision: section.revision };
    }
    // Only evidence that is still valid at evaluation time bounds the conclusion's
    // validity. Already-stale/expired/session cells are reflected in a STALE result
    // (or are irrelevant to an OPEN/BLOCKED conclusion) and must not drag `validUntil`
    // into the past.
    minValidUntil = Math.min(minValidUntil, evidence.validUntil);
    if (!evidence.observation.stateComplete) {
      return { kind: 'incomplete', sectionKey, sectionRevision: section.revision };
    }
    return { kind: 'observed', sectionKey, sectionRevision: section.revision, evidence };
  };

  const neighborRead: NeighborRead = {
    cell(x, y, z) {
      const pos = { x, y, z };
      const read = readCell(x, y, z);
      switch (read.kind) {
        case 'observed':
          // `BlockState` is a mutable interface, so the provider gets a copy, not
          // the live evidence object.
          return { pos, kind: 'observed', state: cloneBlockState(read.evidence.observation.state) };
        case 'missing':
          return { pos, kind: 'unobserved' };
        case 'incomplete':
          return { pos, kind: 'incomplete' };
        case 'stale':
          return { pos, kind: 'stale', reason: 'stale' };
        case 'expired':
          return { pos, kind: 'stale', reason: 'expired' };
        case 'session':
          return { pos, kind: 'stale', reason: 'session' };
      }
    },
  };

  const resolveShape = (evidence: Readonly<CellEvidence>, cell: Vec3Like): ShapeResult => {
    // The state is a mutable `BlockState`; hand the host-supplied rules a copy.
    const resolution = shapeProvider.resolve(cloneBlockState(evidence.observation.state), cell, neighborRead);
    if (resolution.kind === 'unsupported_shape') {
      return { kind: 'unsupported', cell, detail: resolution.detail };
    }
    if (resolution.kind === 'neighbor_gap') {
      return { kind: 'gap', view: resolution.view };
    }
    return { kind: 'shape', shape: resolution.shape };
  };

  // Observed states along the body path, used only to report objective hazards.
  const observedStates = new Map<string, { pos: Vec3Like; state: BlockState }>();

  // Collision: the body sweep must not intersect any solid shape.
  for (const cell of cellsInAabb(sweep)) {
    const read = readCell(cell.x, cell.y, cell.z);
    if (read.kind === 'missing') {
      acc.unknownCells.push(cell);
      continue;
    }
    if (read.kind === 'stale' || read.kind === 'expired' || read.kind === 'session') {
      acc.staleCells.push(cell);
      continue;
    }
    if (read.kind === 'incomplete') {
      acc.unknownCells.push(cell);
      continue;
    }
    observedStates.set(`${cell.x},${cell.y},${cell.z}`, {
      pos: cell,
      state: cloneBlockState(read.evidence.observation.state),
    });
    const shape = resolveShape(read.evidence, cell);
    if (shape.kind === 'unsupported') {
      if (acc.unsupported === null) {
        acc.unsupported = { problem: { kind: 'unsupported_shape', cells: [cell], detail: shape.detail } };
      }
      continue;
    }
    if (shape.kind === 'gap') {
      if (shape.view.kind === 'stale') acc.staleCells.push(shape.view.pos);
      else acc.unknownCells.push(shape.view.pos);
      continue;
    }
    for (const box of shape.shape.boxes) {
      if (boxSweepOverlaps(cell.x, cell.y, cell.z, box, body.feet, to, half, body.height)) {
        if (acc.blocked === null) {
          const state = read.evidence.observation.state;
          acc.blocked = {
            reason: `collision with ${state.name} at (${cell.x}, ${cell.y}, ${cell.z})`,
            problem: { kind: 'collision', cells: [cell] },
            // The section view is live, so an obstacle observation that escapes the
            // evaluation must be a copy, exactly as it was under `sectionAt`.
            obstacles: [{ kind: 'block', observation: cloneObservation(read.evidence.observation) }],
          };
        }
        break;
      }
    }
  }

  // Support: the swept footprint must overlap a standable face at every instant.
  evaluateSupport(body.feet, to);

  let status: StepStatus;
  let reason: string | undefined;
  let problem: StepProblem | undefined;

  if (acc.blocked !== null) {
    status = 'BLOCKED';
    reason = acc.blocked.reason;
    problem = acc.blocked.problem;
    base.obstacles = acc.blocked.obstacles;
  } else if (acc.unsupported !== null) {
    status = 'UNSUPPORTED';
    problem = acc.unsupported.problem;
    reason = acc.unsupported.problem.detail;
  } else if (acc.staleCells.length > 0) {
    status = 'STALE';
    problem = { kind: 'stale', cells: acc.staleCells };
    reason = `${acc.staleCells.length} required cell(s) have stale or expired evidence`;
  } else if (acc.unknownCells.length > 0) {
    status = 'UNKNOWN';
    problem = { kind: 'unobserved', cells: acc.unknownCells };
    reason = `${acc.unknownCells.length} required cell(s) unobserved or state-incomplete`;
  } else {
    status = 'OPEN';
  }

  return {
    ...base,
    status,
    reason,
    problem,
    hazards: collectHazards(observedStates, body.feet, to, half, body.height),
    dependencies: [...deps.values()],
    validUntil: minValidUntil,
  };

  function evaluateSupport(from: Vec3Like, to: Vec3Like): void {
    const fy = from.y;
    const tolerance = measured?.feetTolerance ?? 0;
    const observedIntervals: Array<[number, number]> = [];
    const candidates: SupportCandidate[] = [];
    // Exact interval of positive-area overlap with a support face along the
    // measured XZ segment. Intersect both axes, including small turn corrections.
    const intervalFor = (minX: number, maxX: number, minZ: number, maxZ: number): [number, number] | null => {
      let lo = Number.NEGATIVE_INFINITY, hi = Number.POSITIVE_INFINITY;
      for (const [start, end, min, max] of [[from.x, to.x, minX - half, maxX + half], [from.z, to.z, minZ - half, maxZ + half]]) {
        const delta = end! - start!;
        if (Math.abs(delta) < EPS) {
          if (start! <= min! || start! >= max!) return null;
        } else {
          const a = (min! - start!) / delta, b = (max! - start!) / delta;
          lo = Math.max(lo, Math.min(a, b));
          hi = Math.min(hi, Math.max(a, b));
        }
      }
      return lo < hi ? [lo, hi] : null;
    };
    const minY = Math.floor(Math.min(from.y, to.y) - tolerance - EPS);
    const maxY = Math.floor(Math.max(from.y, to.y) + tolerance - EPS);
    const supportSweep = { ...sweep, minY, maxY: maxY + 1 };
    for (const cell of cellsInAabb(supportSweep)) {
      const { x, y, z } = cell;
      const read = readCell(x, y, z);
      const potential = intervalFor(x, x + 1, z, z + 1);
      if (read.kind === 'observed') {
        const shape = resolveShape(read.evidence, cell);
        if (shape.kind === 'unsupported') {
          candidates.push({ kind: 'unsupported', cell, interval: potential });
          continue;
        }
        if (shape.kind === 'gap') {
          candidates.push({ kind: shape.view.kind === 'stale' ? 'stale' : 'unknown', cell: shape.view.pos, interval: potential });
          continue;
        }
        for (const face of shape.shape.supportFaces) {
          if (Math.abs(y + face.top - from.y) > tolerance + EPS || Math.abs(y + face.top - to.y) > tolerance + EPS) continue;
          const interval = intervalFor(x + face.minX, x + face.maxX, z + face.minZ, z + face.maxZ);
          if (interval !== null) observedIntervals.push(interval);
        }
      } else if (read.kind === 'stale' || read.kind === 'expired' || read.kind === 'session') {
        candidates.push({ kind: 'stale', cell, interval: potential });
      } else {
        candidates.push({ kind: 'unknown', cell, interval: potential });
      }
    }
    const segMin = 0, segMax = 1;
    const observedGaps = uncoveredGaps(observedIntervals, segMin, segMax);
    if (observedGaps.length === 0) return; // confirmed support covers the sweep

    // A gap is only BLOCKED when it remains uncovered even if every unknown,
    // stale or unsupported candidate were a full cube.
    const potentialIntervals = candidates
      .map((c) => c.interval)
      .filter((i): i is [number, number] => i !== null);
    const confirmedGaps = uncoveredGaps([...observedIntervals, ...potentialIntervals], segMin, segMax);
    if (confirmedGaps.length === 0) {
      // The gap could be filled — report only the candidates whose potential
      // actually overlaps the uncovered gap, not unrelated ones.
      const relevant = candidates.filter(
        (c) => c.interval !== null && overlapsAnyGap(c.interval, observedGaps),
      );
      const unsupported = relevant.filter((c) => c.kind === 'unsupported');
      const stale = relevant.filter((c) => c.kind === 'stale');
      const unknown = relevant.filter((c) => c.kind === 'unknown');
      if (unsupported.length > 0) {
        if (acc.unsupported === null) {
          acc.unsupported = {
            problem: { kind: 'unsupported_shape', cells: unsupported.map((c) => c.cell), detail: 'support depends on an unresolvable shape' },
          };
        }
        return;
      }
      if (stale.length > 0) {
        acc.staleCells.push(...stale.map((c) => c.cell));
        return;
      }
      if (unknown.length > 0) {
        acc.unknownCells.push(...unknown.map((c) => c.cell));
        return;
      }
      return;
    }

    // Report the support cell under each confirmed gap, not the move start.
    if (acc.blocked === null) {
      const gapCells = confirmedGaps.map(([gapLo, gapHi]) => {
        const t = (gapLo + gapHi) / 2;
        return { x: Math.floor(from.x + (to.x - from.x) * t), y: Math.ceil(fy) - 1, z: Math.floor(from.z + (to.z - from.z) * t) };
      });
      acc.blocked = {
        reason: `no support under the move at feet height ${fy}`,
        problem: { kind: 'missing_support', cells: gapCells, detail: `no standable surface at y=${fy} covers the swept footprint` },
        obstacles: [],
      };
    }
  }
}

/** Copy a live `BlockState` before it crosses into host-supplied shape rules. */
function cloneBlockState(state: BlockState): BlockState {
  return { name: state.name, properties: { ...state.properties } };
}

/**
 * Normalized context key over body size/pose, mode and delegation constraints
 * (design §3.3). The step geometry itself is keyed separately by the cache.
 */
function stepContextKey(query: StepQuery): string {
  const avoid = (query.constraints?.avoid ?? [])
    .map((point) => `${point.x},${point.y},${point.z}`)
    .sort()
    .join(';');
  return JSON.stringify({
    mode: query.mode,
    pose: query.body.pose,
    width: query.body.width,
    height: query.body.height,
    avoid,
  });
}

function isWaterState(state: BlockState): boolean {
  return (
    state.name === 'water' ||
    state.name === 'minecraft:water' ||
    state.properties['waterlogged'] === 'true'
  );
}

function isLavaState(state: BlockState): boolean {
  return state.name === 'lava' || state.name === 'minecraft:lava';
}

function isBubbleColumnState(state: BlockState): boolean {
  return state.name === 'minecraft:bubble_column' || state.name === 'bubble_column';
}

/**
 * Objective hazards from observed states along the body path, plus a derived fall
 * for a measured descent. It never invents a hazard for an unknown cell, never
 * guesses flow direction/current from a single state, and never changes the
 * OPEN/BLOCKED/UNKNOWN/STALE conclusion.
 */
function collectHazards(
  observed: ReadonlyMap<string, { pos: Vec3Like; state: BlockState }>,
  from: Vec3Like,
  to: Vec3Like,
  half: number,
  height: number,
): HazardFact[] {
  const hazards: HazardFact[] = [];
  const seen = new Set<string>();
  const add = (hazard: HazardFact): void => {
    const key = `${hazard.kind}|${hazard.pos.x},${hazard.pos.y},${hazard.pos.z}`;
    if (seen.has(key)) return;
    seen.add(key);
    hazards.push(hazard);
  };

  for (const { pos, state } of observed.values()) {
    if (isWaterState(state)) {
      add({
        kind: 'water_contact',
        pos: { ...pos },
        basis: 'observed',
        detail: state.properties['waterlogged'] === 'true'
          ? `observed waterlogged ${state.name}`
          : `observed ${state.name}`,
      });
    }
    if (isLavaState(state)) {
      add({ kind: 'lava_contact', pos: { ...pos }, basis: 'observed', detail: `observed ${state.name}` });
    }
    if (isBubbleColumnState(state)) {
      add({ kind: 'bubble_column', pos: { ...pos }, basis: 'observed', detail: `observed ${state.name}` });
    }
  }

  // Submersion is only reported when the entire destination body volume is
  // positively observed as water; a partial or unknown volume is not enough.
  const destinationCells = cellsInAabb(bodyAabb(to, half, height));
  if (
    destinationCells.length > 0 &&
    destinationCells.every((cell) => {
      const view = observed.get(`${cell.x},${cell.y},${cell.z}`);
      return view !== undefined && isWaterState(view.state);
    })
  ) {
    add({
      kind: 'submersion',
      pos: { ...to },
      basis: 'observed',
      detail: 'the destination body volume is observed water',
    });
  }

  // A measured descent is an objective fall fact; it is not inferred for an
  // ordinary horizontal query.
  if (to.y < from.y - EPS) {
    add({
      kind: 'fall',
      pos: { ...to },
      basis: 'derived',
      detail: `measured drop of ${from.y - to.y} block(s)`,
    });
  }
  return hazards;
}
