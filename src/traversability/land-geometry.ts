/**
 * Shared continuous geometry for land-transition validation.
 *
 * These helpers never read the world: they only describe the declared body
 * envelope swept by a transition. They are deliberately separate from the
 * evidence reader in `land-transition.ts` so the same exact interval math is
 * used by every subset (linear step/drop legs, the quadratic jump arc and the
 * vertical ladder corridor).
 *
 * Every collision test is analytic and continuous. An envelope corner that the
 * body never occupies is only a candidate-cell filter, never a collision; exact
 * boundary contact has zero positive overlap and is not a collision.
 */

import type { Vec3Like } from '../types.js';
import type { UnitBox } from './collision-shape.js';

/** Tolerance for treating exact boundary contact as non-overlap and touching intervals as continuous. */
export const LAND_EPS = 1e-9;

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Candidate cells for one sweep, or an overflow marker when the hard cell limit is exceeded. */
export interface BoundedCells {
  cells: Vec3Like[];
  /** True when the cell count exceeds the caller's limit; no array is allocated. */
  overflow: boolean;
  /** Exact count when known, otherwise `Infinity`. */
  total: number;
}

export function bodyAabb(feet: Vec3Like, half: number, height: number): Aabb {
  return {
    minX: feet.x - half,
    maxX: feet.x + half,
    minY: feet.y,
    maxY: feet.y + height,
    minZ: feet.z - half,
    maxZ: feet.z + half,
  };
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/** Envelope of the whole jump arc: X/Z linear, Y from the common foot height to the quadratic apex. */
export function jumpEnvelope(
  from: Vec3Like,
  to: Vec3Like,
  apexHeight: number,
  half: number,
  height: number,
): Aabb {
  return {
    minX: Math.min(from.x, to.x) - half,
    maxX: Math.max(from.x, to.x) + half,
    minY: from.y,
    maxY: from.y + apexHeight + height,
    minZ: Math.min(from.z, to.z) - half,
    maxZ: Math.max(from.z, to.z) + half,
  };
}

/**
 * Integer cells overlapping a continuous AABB, using the same positive-overlap
 * convention as the walk evaluator: a body merely touching a cell boundary does
 * not make that cell a candidate. The count is checked before allocation.
 */
export function cellsInAabbBounded(aabb: Aabb, maxCells: number): BoundedCells {
  const minBX = Math.floor(aabb.minX + LAND_EPS);
  const maxBX = Math.floor(aabb.maxX - LAND_EPS);
  const minBY = Math.floor(aabb.minY + LAND_EPS);
  const maxBY = Math.floor(aabb.maxY - LAND_EPS);
  const minBZ = Math.floor(aabb.minZ + LAND_EPS);
  const maxBZ = Math.floor(aabb.maxZ - LAND_EPS);
  if (
    !Number.isFinite(minBX) ||
    !Number.isFinite(maxBX) ||
    !Number.isFinite(minBY) ||
    !Number.isFinite(maxBY) ||
    !Number.isFinite(minBZ) ||
    !Number.isFinite(maxBZ)
  ) {
    return { cells: [], overflow: true, total: Number.POSITIVE_INFINITY };
  }
  const nx = maxBX - minBX + 1;
  const ny = maxBY - minBY + 1;
  const nz = maxBZ - minBZ + 1;
  if (nx <= 0 || ny <= 0 || nz <= 0) return { cells: [], overflow: false, total: 0 };
  const total = nx * ny * nz;
  if (!Number.isSafeInteger(total) || total > maxCells) {
    return {
      cells: [],
      overflow: true,
      total: Number.isSafeInteger(total) ? total : Number.POSITIVE_INFINITY,
    };
  }
  const cells: Vec3Like[] = new Array(total);
  let i = 0;
  for (let x = minBX; x <= maxBX; x++) {
    for (let y = minBY; y <= maxBY; y++) {
      for (let z = minBZ; z <= maxBZ; z++) {
        cells[i++] = { x, y, z };
      }
    }
  }
  return { cells, overflow: false, total };
}

/**
 * Cells whose top face could lie at the exact feet height. A support face has
 * `top ∈ [0, 1]`, so the cell below an integer feet Y and the feet cell itself
 * both matter. Cells are keyed by the body footprint with positive-area overlap.
 */
export function supportCandidateCells(feet: Vec3Like, half: number, maxCells: number): BoundedCells {
  const minBX = Math.floor(feet.x - half + LAND_EPS);
  const maxBX = Math.floor(feet.x + half - LAND_EPS);
  const minBY = Math.floor(feet.y - LAND_EPS);
  const maxBY = Math.floor(feet.y + LAND_EPS);
  const minBZ = Math.floor(feet.z - half + LAND_EPS);
  const maxBZ = Math.floor(feet.z + half - LAND_EPS);
  const nx = maxBX - minBX + 1;
  const ny = maxBY - minBY + 1;
  const nz = maxBZ - minBZ + 1;
  if (nx <= 0 || ny <= 0 || nz <= 0) return { cells: [], overflow: false, total: 0 };
  const total = nx * ny * nz;
  if (!Number.isSafeInteger(total) || total > maxCells) {
    return {
      cells: [],
      overflow: true,
      total: Number.isSafeInteger(total) ? total : Number.POSITIVE_INFINITY,
    };
  }
  const cells: Vec3Like[] = new Array(total);
  let i = 0;
  for (let x = minBX; x <= maxBX; x++) {
    for (let y = minBY; y <= maxBY; y++) {
      for (let z = minBZ; z <= maxBZ; z++) {
        cells[i++] = { x, y, z };
      }
    }
  }
  return { cells, overflow: false, total };
}

/**
 * Time interval of positive overlap between the linearly moving interval
 * `[min0 + d·t, max0 + d·t]` and the static interval `[sMin, sMax]`, or null.
 */
export function linearOverlapTimes(
  min0: number,
  max0: number,
  delta: number,
  sMin: number,
  sMax: number,
): [number, number] | null {
  if (delta === 0) {
    return max0 - sMin > LAND_EPS && sMax - min0 > LAND_EPS ? [0, 1] : null;
  }
  const tA = (sMin - max0) / delta;
  const tB = (sMax - min0) / delta;
  const tMin = Math.max(0, Math.min(tA, tB));
  const tMax = Math.min(1, Math.max(tA, tB));
  return tMax - tMin > LAND_EPS ? [tMin, tMax] : null;
}

/**
 * Continuous swept collision of the moving body AABB (`from → to`) against one
 * box in `cell`. X, Y and Z overlap must share a common positive-length time
 * interval; a swept-envelope corner the body never occupies is not a hit.
 */
export function segmentHitsBox(
  cell: Vec3Like,
  box: UnitBox,
  from: Vec3Like,
  to: Vec3Like,
  half: number,
  height: number,
): boolean {
  const xTimes = linearOverlapTimes(
    from.x - half,
    from.x + half,
    to.x - from.x,
    cell.x + box.minX,
    cell.x + box.maxX,
  );
  if (xTimes === null) return false;
  const yTimes = linearOverlapTimes(
    from.y,
    from.y + height,
    to.y - from.y,
    cell.y + box.minY,
    cell.y + box.maxY,
  );
  if (yTimes === null) return false;
  const zTimes = linearOverlapTimes(
    from.z - half,
    from.z + half,
    to.z - from.z,
    cell.z + box.minZ,
    cell.z + box.maxZ,
  );
  if (zTimes === null) return false;
  const tMin = Math.max(xTimes[0], yTimes[0], zTimes[0]);
  const tMax = Math.min(xTimes[1], yTimes[1], zTimes[1]);
  return tMax - tMin > LAND_EPS;
}

interface Interval {
  lo: number;
  hi: number;
}

/** Open time intervals where the concave arc `y(t) = y0 + 4·h·t·(1−t)` exceeds `level`. */
function quadraticAbove(y0: number, apexHeight: number, level: number): Interval[] {
  if (apexHeight <= 0) return y0 > level ? [{ lo: 0, hi: 1 }] : [];
  const a = (level - y0) / apexHeight;
  if (a <= 0) return [{ lo: 0, hi: 1 }];
  if (a >= 1) return [];
  const root = Math.sqrt(Math.max(0, 1 - a));
  return [{ lo: (1 - root) / 2, hi: (1 + root) / 2 }];
}

/** Open time intervals where the concave arc is below `level`. */
function quadraticBelow(y0: number, apexHeight: number, level: number): Interval[] {
  if (apexHeight <= 0) return y0 < level ? [{ lo: 0, hi: 1 }] : [];
  const b = (level - y0) / apexHeight;
  if (b <= 0) return [];
  if (b >= 1) return [{ lo: 0, hi: 1 }];
  const root = Math.sqrt(Math.max(0, 1 - b));
  return [
    { lo: 0, hi: (1 - root) / 2 },
    { lo: (1 + root) / 2, hi: 1 },
  ];
}

function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const left of a) {
    for (const right of b) {
      const lo = Math.max(left.lo, right.lo);
      const hi = Math.min(left.hi, right.hi);
      if (hi - lo > LAND_EPS) out.push({ lo, hi });
    }
  }
  return out;
}

/**
 * Time intervals during a quadratic jump where the body's vertical span
 * `[y(t), y(t) + bodyHeight]` positively overlaps `[boxMinY, boxMaxY]`.
 *
 * The body must be above the box bottom (`y(t) > boxMinY − bodyHeight`) and
 * below the box top (`y(t) < boxMaxY`). Both bounds are solved analytically; no
 * sampling or envelope-corner approximation is used.
 */
export function quadraticBodyOverlapIntervals(
  y0: number,
  apexHeight: number,
  bodyHeight: number,
  boxMinY: number,
  boxMaxY: number,
): Interval[] {
  const aboveBottom = quadraticAbove(y0, apexHeight, boxMinY - bodyHeight);
  const belowTop = quadraticBelow(y0, apexHeight, boxMaxY);
  return intersectIntervals(aboveBottom, belowTop);
}

/**
 * Continuous jump collision: the moving body AABB follows a quadratic Y arc and
 * linear X/Z interpolation. All three axes must intersect over a common
 * positive-length time interval.
 */
export function jumpHitsBox(
  cell: Vec3Like,
  box: UnitBox,
  from: Vec3Like,
  to: Vec3Like,
  apexHeight: number,
  half: number,
  height: number,
): boolean {
  const xTimes = linearOverlapTimes(
    from.x - half,
    from.x + half,
    to.x - from.x,
    cell.x + box.minX,
    cell.x + box.maxX,
  );
  if (xTimes === null) return false;
  const zTimes = linearOverlapTimes(
    from.z - half,
    from.z + half,
    to.z - from.z,
    cell.z + box.minZ,
    cell.z + box.maxZ,
  );
  if (zTimes === null) return false;
  const yIntervals = quadraticBodyOverlapIntervals(
    from.y,
    apexHeight,
    height,
    cell.y + box.minY,
    cell.y + box.maxY,
  );
  return yIntervals.some((interval) => {
    const tMin = Math.max(xTimes[0], zTimes[0], interval.lo);
    const tMax = Math.min(xTimes[1], zTimes[1], interval.hi);
    return tMax - tMin > LAND_EPS;
  });
}

/** Positive-area overlap of two axis-aligned rectangles in the XZ plane. */
export function rectsOverlapPositive(
  aMinX: number,
  aMaxX: number,
  aMinZ: number,
  aMaxZ: number,
  bMinX: number,
  bMaxX: number,
  bMinZ: number,
  bMaxZ: number,
): boolean {
  return (
    Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX) > LAND_EPS &&
    Math.min(aMaxZ, bMaxZ) - Math.max(aMinZ, bMinZ) > LAND_EPS
  );
}

/**
 * Maximal gaps within `[lo, hi]` left uncovered by the closed intervals.
 * Touching intervals (`next.lo <= current.hi + EPS`) count as continuous.
 */
export function uncoveredIntervals(
  intervals: ReadonlyArray<readonly [number, number]>,
  lo: number,
  hi: number,
): Array<[number, number]> {
  if (hi - lo <= LAND_EPS) return [];
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
    .filter(([a, b]) => b - a > LAND_EPS)
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [a, b] of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1] + LAND_EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      merged.push([a, b]);
    }
  }

  const gaps: Array<[number, number]> = [];
  let cursor = lo;
  for (const [a, b] of merged) {
    if (b <= cursor) continue;
    if (a > cursor + LAND_EPS) gaps.push([cursor, Math.min(a, hi)]);
    cursor = Math.max(cursor, b);
    if (cursor >= hi - LAND_EPS) break;
  }
  if (cursor < hi - LAND_EPS) gaps.push([cursor, hi]);
  return gaps;
}
