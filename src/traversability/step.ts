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
 * state. Reads go through the map's read-only snapshot API, so an evaluation
 * never mutates evidence, time or version.
 *
 * Support is checked continuously over the whole move: the swept footprint must
 * overlap some standable top face at every instant (exact interval coverage,
 * not fixed sampling), so a narrow gap is never missed and a partial overhang
 * is not mistaken for total loss of support.
 */

import type { CellEvidence } from '../observation/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { Section, SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShape, CollisionShapeProvider, NeighborCellView, NeighborRead, UnitBox } from './collision-shape.js';
import type { ObstacleEvidence, Traversability } from './types.js';

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
  /** Actual section reads (deduped), for local cache invalidation. */
  dependencies: { key: SectionKey; revision: number }[];
  sessionId: string;
  computedAt: number;
  /** min validUntil over all evidence read; Infinity only when no evidence was read. */
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
  | { kind: 'observed'; sectionKey: SectionKey; sectionRevision: number; evidence: CellEvidence };

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
  const minBX = Math.floor(aabb.minX);
  const maxBX = Math.floor(aabb.maxX - EPS);
  const minBY = Math.floor(aabb.minY);
  const maxBY = Math.floor(aabb.maxY - EPS);
  const minBZ = Math.floor(aabb.minZ);
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

function boxOverlaps(cx: number, cy: number, cz: number, box: UnitBox, aabb: Aabb): boolean {
  const minX = cx + box.minX;
  const maxX = cx + box.maxX;
  const minY = cy + box.minY;
  const maxY = cy + box.maxY;
  const minZ = cz + box.minZ;
  const maxZ = cz + box.maxZ;
  return (
    maxX > aabb.minX &&
    minX < aabb.maxX &&
    maxY > aabb.minY &&
    minY < aabb.maxY &&
    maxZ > aabb.minZ &&
    minZ < aabb.maxZ
  );
}

function overlaps(min1: number, max1: number, min2: number, max2: number): boolean {
  return max1 > min2 && min1 < max2;
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

  const to: Vec3Like =
    direction.axis === 'x'
      ? { x: body.feet.x + direction.sign, y: body.feet.y, z: body.feet.z }
      : { x: body.feet.x, y: body.feet.y, z: body.feet.z + direction.sign };
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

  const sectionCache = new Map<string, Section | null>();
  let minValidUntil = Number.POSITIVE_INFINITY;

  const readCell = (x: number, y: number, z: number): CellRead => {
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const sectionKey: SectionKey = { worldId: query.worldId, dim, cx, cz, sy };
    const cacheKey = `${cx},${cz},${sy}`;
    let section = sectionCache.get(cacheKey);
    if (section === undefined) {
      section = map.sectionAt(dim, x, y, z);
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
    minValidUntil = Math.min(minValidUntil, evidence.validUntil);
    if (evidence.freshness === 'STALE') {
      return { kind: 'stale', sectionKey, sectionRevision: section.revision };
    }
    if (evidence.observation.sessionId !== query.sessionId) {
      return { kind: 'session', sectionKey, sectionRevision: section.revision };
    }
    if (now > evidence.validUntil) {
      return { kind: 'expired', sectionKey, sectionRevision: section.revision };
    }
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
          return { pos, kind: 'observed', state: read.evidence.observation.state };
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

  const resolveShape = (evidence: CellEvidence, cell: Vec3Like): ShapeResult => {
    const resolution = shapeProvider.resolve(evidence.observation.state, cell, neighborRead);
    if (resolution.kind === 'unsupported_shape') {
      return { kind: 'unsupported', cell, detail: resolution.detail };
    }
    if (resolution.kind === 'neighbor_gap') {
      return { kind: 'gap', view: resolution.view };
    }
    return { kind: 'shape', shape: resolution.shape };
  };

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
      if (boxOverlaps(cell.x, cell.y, cell.z, box, sweep)) {
        if (acc.blocked === null) {
          const state = read.evidence.observation.state;
          acc.blocked = {
            reason: `collision with ${state.name} at (${cell.x}, ${cell.y}, ${cell.z})`,
            problem: { kind: 'collision', cells: [cell] },
            obstacles: [{ kind: 'block', observation: read.evidence.observation }],
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
    dependencies: [...deps.values()],
    validUntil: minValidUntil,
  };

  function evaluateSupport(from: Vec3Like, to: Vec3Like): void {
    const fy = from.y;
    const axis = direction.axis;

    // Perpendicular extent is fixed for the whole step.
    const perpCoord = axis === 'x' ? from.z : from.x;
    const perpMin = perpCoord - half;
    const perpMax = perpCoord + half;

    // Along-axis swept extent and the center segment that must stay supported.
    const fromA = axis === 'x' ? from.x : from.z;
    const toA = axis === 'x' ? to.x : to.z;
    const segMin = Math.min(fromA, toA);
    const segMax = Math.max(fromA, toA);
    const sweepAMin = segMin - half;
    const sweepAMax = segMax + half;

    // The only cell level whose top can equal the feet height: the block below
    // integer feet, or the slab level under fractional feet.
    const floorY = Math.floor(fy);
    const supportY = Number.isInteger(fy) ? floorY - 1 : floorY;

    const aCellMin = Math.floor(sweepAMin);
    const aCellMax = Math.floor(sweepAMax - EPS);
    const pCellMin = Math.floor(perpMin);
    const pCellMax = Math.floor(perpMax - EPS);

    const observedIntervals: Array<[number, number]> = [];
    const potentialIntervals: Array<[number, number]> = [];
    const unsupportedCells: Vec3Like[] = [];
    const staleCellsHere: Vec3Like[] = [];
    const unknownCellsHere: Vec3Like[] = [];

    // Best-case support a still-unknown cell could provide: a full-cell top face.
    const addPotential = (x: number, z: number): void => {
      const perpCellMin = axis === 'x' ? z : x;
      if (!overlaps(perpCellMin, perpCellMin + 1, perpMin, perpMax)) return;
      const alongCell = axis === 'x' ? x : z;
      potentialIntervals.push([alongCell - half, alongCell + 1 + half]);
    };

    for (let a = aCellMin; a <= aCellMax; a++) {
      for (let p = pCellMin; p <= pCellMax; p++) {
        const x = axis === 'x' ? a : p;
        const z = axis === 'x' ? p : a;
        const cell: Vec3Like = { x, y: supportY, z };
        const read = readCell(x, supportY, z);
        if (read.kind === 'observed') {
          const shape = resolveShape(read.evidence, cell);
          if (shape.kind === 'unsupported') {
            unsupportedCells.push(cell);
            addPotential(x, z);
            continue;
          }
          if (shape.kind === 'gap') {
            if (shape.view.kind === 'stale') staleCellsHere.push(shape.view.pos);
            else unknownCellsHere.push(shape.view.pos);
            addPotential(x, z);
            continue;
          }
          for (const face of shape.shape.supportFaces) {
            if (Math.abs(supportY + face.top - fy) >= EPS) continue;
            const [perpFaceMin, perpFaceMax] =
              axis === 'x' ? [z + face.minZ, z + face.maxZ] : [x + face.minX, x + face.maxX];
            if (!overlaps(perpFaceMin, perpFaceMax, perpMin, perpMax)) continue;
            const [alongFaceMin, alongFaceMax] =
              axis === 'x' ? [x + face.minX, x + face.maxX] : [z + face.minZ, z + face.maxZ];
            observedIntervals.push([alongFaceMin - half, alongFaceMax + half]);
          }
        } else if (read.kind === 'stale' || read.kind === 'expired' || read.kind === 'session') {
          staleCellsHere.push(cell);
          addPotential(x, z);
        } else {
          // missing or incomplete
          unknownCellsHere.push(cell);
          addPotential(x, z);
        }
      }
    }

    const observedGaps = uncoveredGaps(observedIntervals, segMin, segMax);
    if (observedGaps.length === 0) return; // confirmed support covers the sweep

    // A gap is only BLOCKED when it remains uncovered even if every unknown,
    // stale or unsupported candidate were a full cube. Otherwise those
    // candidates could fill it and the result stays UNKNOWN/STALE/UNSUPPORTED.
    const confirmedGaps = uncoveredGaps([...observedIntervals, ...potentialIntervals], segMin, segMax);
    if (confirmedGaps.length === 0) {
      if (unsupportedCells.length > 0) {
        if (acc.unsupported === null) {
          acc.unsupported = {
            problem: { kind: 'unsupported_shape', cells: unsupportedCells, detail: 'support depends on an unresolvable shape' },
          };
        }
        return;
      }
      if (staleCellsHere.length > 0) {
        acc.staleCells.push(...staleCellsHere);
        return;
      }
      if (unknownCellsHere.length > 0) {
        acc.unknownCells.push(...unknownCellsHere);
        return;
      }
      return;
    }

    // Report the support cell under each confirmed gap, not the move start.
    if (acc.blocked === null) {
      const gapCells = confirmedGaps.map(([gapLo, gapHi]) => {
        const along = Math.floor((gapLo + gapHi) / 2);
        const perp = Math.floor(perpCoord);
        return axis === 'x'
          ? { x: along, y: supportY, z: perp }
          : { x: perp, y: supportY, z: along };
      });
      acc.blocked = {
        reason: `no support under the move at feet height ${fy}`,
        problem: { kind: 'missing_support', cells: gapCells, detail: `no standable surface at y=${fy} covers the swept footprint` },
        obstacles: [],
      };
    }
  }
}
