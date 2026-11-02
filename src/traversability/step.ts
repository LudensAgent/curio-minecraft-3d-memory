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
 */

import type { CellEvidence } from '../observation/types.js';
import type { MoveMode, Vec3Like } from '../types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { Section, SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShapeProvider, UnitBox } from './collision-shape.js';
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
    | 'incomplete_state'
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
  /** min validUntil over dependency evidence; Infinity when not evidence-bound. */
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
  | { kind: 'incomplete'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'observed'; sectionKey: SectionKey; sectionRevision: number; evidence: CellEvidence };

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
  if (body.width <= 0 || body.height <= 0) {
    throw new Error(`body dimensions must be positive: width ${body.width}, height ${body.height}`);
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
      problem: { kind: 'unsupported_mode', cells: [], detail: `supported mode: walk` },
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
    if (evidence.freshness === 'STALE') {
      return { kind: 'stale', sectionKey, sectionRevision: section.revision };
    }
    if (now > evidence.validUntil) {
      return { kind: 'expired', sectionKey, sectionRevision: section.revision };
    }
    if (!evidence.observation.stateComplete) {
      return { kind: 'incomplete', sectionKey, sectionRevision: section.revision };
    }
    minValidUntil = Math.min(minValidUntil, evidence.validUntil);
    return { kind: 'observed', sectionKey, sectionRevision: section.revision, evidence };
  };

  const resolveBoxes = (evidence: CellEvidence, cell: Vec3Like): UnitBox[] | null => {
    const resolution = shapeProvider.resolve(evidence.observation.state);
    if (resolution.kind === 'unsupported_shape') {
      if (acc.unsupported === null) {
        acc.unsupported = {
          problem: { kind: 'unsupported_shape', cells: [cell], detail: resolution.detail },
        };
      }
      return null;
    }
    return [...resolution.shape.boxes];
  };

  // Collision: the body sweep must not intersect any solid shape.
  for (const cell of cellsInAabb(sweep)) {
    const read = readCell(cell.x, cell.y, cell.z);
    if (read.kind === 'missing') {
      acc.unknownCells.push(cell);
      continue;
    }
    if (read.kind === 'stale' || read.kind === 'expired') {
      acc.staleCells.push(cell);
      continue;
    }
    if (read.kind === 'incomplete') {
      acc.unknownCells.push(cell);
      continue;
    }
    const boxes = resolveBoxes(read.evidence, cell);
    if (boxes === null) continue;
    for (const box of boxes) {
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

  // Support: both feet positions need a standable surface at their exact height.
  const classifySupport = (foot: Vec3Like): void => {
    const byLow = Math.floor(foot.y) - 1;
    const byHigh = Math.floor(foot.y);
    const minBX = Math.floor(foot.x - half);
    const maxBX = Math.floor(foot.x + half - EPS);
    const minBZ = Math.floor(foot.z - half);
    const maxBZ = Math.floor(foot.z + half - EPS);

    let supported = false;
    let footStale = false;
    let footUnknown = false;

    for (let bx = minBX; bx <= maxBX; bx++) {
      for (let bz = minBZ; bz <= maxBZ; bz++) {
        for (const by of [byLow, byHigh]) {
          const cell = { x: bx, y: by, z: bz };
          const read = readCell(bx, by, bz);
          if (read.kind === 'observed') {
            const resolution = shapeProvider.resolve(read.evidence.observation.state);
            if (resolution.kind === 'unsupported_shape') {
              if (acc.unsupported === null) {
                acc.unsupported = {
                  problem: { kind: 'unsupported_shape', cells: [cell], detail: resolution.detail },
                };
              }
              continue;
            }
            const top = resolution.shape.supportTop;
            if (top !== null && Math.abs(by + top - foot.y) < EPS) {
              supported = true;
            }
          } else if (read.kind === 'stale' || read.kind === 'expired') {
            acc.staleCells.push(cell);
            footStale = true;
          } else {
            // missing or incomplete
            acc.unknownCells.push(cell);
            footUnknown = true;
          }
        }
      }
    }

    if (supported) return;
    if (footStale) return;
    if (footUnknown) return;
    // Every support cell was observed and none provides a surface at the feet height.
    if (acc.blocked === null) {
      const supportCell = { x: Math.floor(foot.x), y: byLow, z: Math.floor(foot.z) };
      acc.blocked = {
        reason: `no support under (${supportCell.x}, ${supportCell.y}, ${supportCell.z}) at feet height ${foot.y}`,
        problem: { kind: 'missing_support', cells: [supportCell], detail: `no standable surface at y=${foot.y}` },
        obstacles: [],
      };
    }
  };

  classifySupport(body.feet);
  classifySupport(to);

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
    validUntil: status === 'OPEN' || status === 'BLOCKED' ? minValidUntil : Number.POSITIVE_INFINITY,
  };
}
