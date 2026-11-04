/**
 * Read-only water-route and water-arrival validation.
 *
 * `evaluateWaterRoute` composes the existing solid `CollisionShapeProvider`
 * with a separate versioned `FluidShapeProvider` over an already-selected,
 * ordered, constant-height route. It sweeps the declared swimmer/hull/passenger
 * volumes exactly along every segment (common-time AABB intervals, not fixed
 * samples), requires continuous water-surface coverage under the declared
 * footprint and band, and keeps fluid facts independent from physical
 * collision. It never searches a route, rounds coordinates, inserts waypoints,
 * picks a shore, or begins an observation session.
 *
 * `checkWaterArrival` is a separate completion check over measured, ordered
 * body samples. It never translates a Promise result or a legacy `ok` flag into
 * ARRIVED, and it never mounts, dismounts, builds, recovers or rescues a boat.
 */

import type { CellEvidence, Observation } from '../observation/types.js';
import type { Vec3Like } from '../types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import { sectionKeyString } from '../voxel/section.js';
import type { Section, SectionKey } from '../voxel/section.js';
import type { SectionResidency } from '../voxel/residency.js';
import type { VoxelMap } from '../voxel/voxel-map.js';
import type {
  CollisionShape,
  CollisionShapeProvider,
  NeighborCellView,
  NeighborRead,
  UnitBox,
} from '../traversability/collision-shape.js';
import { evaluateGroundedWalkSegment } from '../traversability/step.js';
import type { StepEvaluation } from '../traversability/step.js';
import type { HazardFact, ObstacleEvidence } from '../traversability/types.js';
import type {
  BoatDockGoal,
  BoatMeasurement,
  Box3,
  ControlledNeighborRead,
  FluidRiskFact,
  FluidShape,
  FluidShapeResolution,
  FluidSurfacePatch,
  FluidVolume,
  WaterArrivalGoal,
  WaterArrivalLimits,
  WaterArrivalLimitsInput,
  WaterArrivalProblem,
  WaterArrivalRequest,
  WaterArrivalResult,
  WaterBodySample,
  WaterBudgetReport,
  WaterLimits,
  WaterProfile,
  WaterRouteEvaluation,
  WaterRouteProblem,
  WaterRouteQuery,
  WaterValidationLimits,
} from './types.js';

/** Epsilon for treating exact-boundary contact as non-overlap / zero-width gaps as none. */
const EPS = 1e-9;

/** Private sentinel: stop a provider's controlled-read loop without a partial shape. */
const CONTROLLED_READ_BUDGET_EXCEEDED = Symbol('water-controlled-read-budget-exceeded');

/** Private sentinel: stop the bounded shore provider loop. */
const SHORE_BUDGET_EXCEEDED = Symbol('water-shore-budget-exceeded');

const DEFAULT_LIMITS: WaterValidationLimits = {
  maxPoints: 256,
  maxProfileVolumes: 64,
  maxCandidateCells: 4096,
  maxReadCells: 8192,
  maxNeighborReads: 16384,
  maxShapeChecks: 131072,
  maxRiskFacts: 64,
};

const DEFAULT_ARRIVAL_LIMITS: WaterArrivalLimits = {
  maxSamples: 512,
  maxShoreCells: 4096,
  maxShoreShapeResolutions: 8192,
  maxShoreNeighborReads: 16384,
  maxShoreShapeParts: 4096,
};

/** One declared collision/clearance volume, in world-axis offsets from the route point. */
interface WorldVolume extends Box3 {
  name: 'body' | 'breathing' | 'hull' | 'passenger' | 'passengerBreathing';
  clearance: boolean;
  /** True for explicit head/breathing volumes that must stay air/lava-free. */
  breathing: boolean;
}

interface RouteGeometry {
  volumes: WorldVolume[];
  contactHalfX: number;
  contactHalfZ: number;
  surfaceBand: { minY: number; maxY: number };
  /** Relative vertical span of the body/hull that water must actually contact. */
  contactMinY: number;
  contactMaxY: number;
}

type CellRead =
  | {
      kind: 'observed';
      sectionKey: SectionKey;
      sectionRevision: number;
      evidence: CellEvidence;
    }
  | { kind: 'unobserved'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'not_resident'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'incomplete'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'stale'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'expired'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'session'; sectionKey: SectionKey; sectionRevision: number }
  | { kind: 'budget' };

type SolidResolved =
  | { kind: 'shape'; shape: CollisionShape }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'gap'; view: NeighborCellView };

type FluidResolved =
  | { kind: 'shape'; shape: FluidShape }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'gap'; view: NeighborCellView };

interface CellRecord {
  cell: Vec3Like;
  collisionRelevant: boolean;
  surfaceRelevant: boolean;
  read: CellRead;
  solid: SolidResolved | null;
  fluid: FluidResolved | null;
}

type UnresolvedCategory = 'unknown' | 'not_resident' | 'motion_unknown' | 'stale' | 'unsupported';

interface Unresolved {
  category: UnresolvedCategory;
  cell: Vec3Like;
  viaNeighborGap: boolean;
}

interface BudgetProblem {
  limit: keyof WaterValidationLimits;
  used: number;
  max: number;
  detail: string;
}

interface PotentialSurface extends Unresolved {
  intervals: Array<[number, number]>;
}

interface Segment {
  from: Vec3Like;
  to: Vec3Like;
}

const UNIT_BOX: UnitBox = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
const FULL_PATCH: FluidSurfacePatch = { y: 0, minX: 0, minZ: 0, maxX: 1, maxZ: 1 };

/**
 * Evaluate a caller-selected water route against current evidence.
 *
 * `now` is the caller's evidence clock and is compared with observations'
 * `validUntil`; this function never reads a host clock or mutates the map.
 */
export function evaluateWaterRoute(map: VoxelMap, query: WaterRouteQuery, now: number): WaterRouteEvaluation {
  if (query.worldId !== map.worldId) {
    throw new Error(`query worldId "${query.worldId}" does not match map worldId "${map.worldId}"`);
  }
  if (!Number.isFinite(now)) {
    throw new Error(`now must be a finite number: ${now}`);
  }
  if (!Array.isArray(query.points) || query.points.length < 2) {
    throw new Error(`a water route needs at least two points, got ${Array.isArray(query.points) ? query.points.length : 0}`);
  }

  const limits = resolveLimits(query.limits);
  const profileKind = query.profile.kind;
  const ruleVersions = {
    solid: query.solidShapeProvider.version,
    fluid: query.fluidShapeProvider.version,
  };
  const from = { ...query.points[0]! };
  const to = { ...query.points[query.points.length - 1]! };
  const budget: WaterBudgetReport = {
    points: query.points.length,
    profileVolumes: 0,
    candidateCells: 0,
    readCells: 0,
    neighborReads: 0,
    shapeChecks: 0,
    riskFacts: 0,
    limits,
  };

  const preBudget = (problem: BudgetProblem): WaterRouteEvaluation => ({
    status: 'UNSUPPORTED',
    assurance: 'geometry_only',
    executable: false,
    profileKind,
    ruleVersions,
    worldId: query.worldId,
    dim: query.dim,
    sessionId: query.sessionId,
    points: [],
    from,
    to,
    reason: problem.detail,
    problem: {
      kind: 'budget_exceeded',
      detail: problem.detail,
      limit: problem.limit,
      used: problem.used,
      max: problem.max,
    },
    hazards: [],
    obstacles: [],
    dependencies: [],
    budget,
    computedAt: now,
    validUntil: Number.POSITIVE_INFINITY,
  });

  // Bound the route count before copying or enumerating anything.
  if (query.points.length > limits.maxPoints) {
    return preBudget({
      limit: 'maxPoints',
      used: query.points.length,
      max: limits.maxPoints,
      detail: `route has ${query.points.length} points, exceeding maxPoints (${limits.maxPoints})`,
    });
  }
  for (const point of query.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      throw new Error('route point coordinates must be finite numbers');
    }
  }

  // Bound declared profile volume counts by length only, before inspecting or
  // copying any entry (an over-long array may contain throwing getters).
  const profileVolumes = profileVolumeCount(query.profile);
  if (!profileVolumes.safe || profileVolumes.count > limits.maxProfileVolumes) {
    return preBudget({
      limit: 'maxProfileVolumes',
      used: profileVolumes.count,
      max: limits.maxProfileVolumes,
      detail: profileVolumes.safe
        ? `profile declares ${profileVolumes.count} volumes, exceeding maxProfileVolumes (${limits.maxProfileVolumes})`
        : 'profile volume counts are not safe integers',
    });
  }
  budget.profileVolumes = profileVolumes.count;

  validateProfile(query.profile);
  const routeY = query.points[0]!.y;
  if (query.points.some((point) => point.y !== routeY)) {
    return {
      status: 'UNSUPPORTED',
      assurance: 'geometry_only',
      executable: false,
      profileKind,
      ruleVersions,
      worldId: query.worldId,
      dim: query.dim,
      sessionId: query.sessionId,
      points: query.points.map((point) => ({ x: point.x, y: point.y, z: point.z })),
      from,
      to,
      reason: 'varying-height and vertical water transitions are not supported by this slice',
      problem: {
        kind: 'unsupported_profile',
        cells: [],
        detail: `all route points must have exactly the same Y (start y=${routeY})`,
      },
      hazards: [],
      obstacles: [],
      dependencies: [],
      budget,
      computedAt: now,
      validUntil: Number.POSITIVE_INFINITY,
    };
  }

  const geometry = buildGeometry(query.profile, routeY);
  const segments: Segment[] = [];
  for (let i = 0; i < query.points.length - 1; i++) {
    segments.push({ from: query.points[i]!, to: query.points[i + 1]! });
  }

  const envelope = computeEnvelope(query.points, geometry);
  if (!envelope.safe) {
    return {
      status: 'UNSUPPORTED',
      assurance: 'geometry_only',
      executable: false,
      profileKind,
      ruleVersions,
      worldId: query.worldId,
      dim: query.dim,
      sessionId: query.sessionId,
      points: [],
      from,
      to,
      reason: 'the swept envelope is outside the safely enumerable integer range',
      problem: {
        kind: 'unsupported_range',
        cells: [],
        detail: 'envelope bounds/count are non-finite, unsafe integers, or would not advance monotonically',
      },
      hazards: [],
      obstacles: [],
      dependencies: [],
      budget,
      computedAt: now,
      validUntil: Number.POSITIVE_INFINITY,
    };
  }
  if (envelope.count > limits.maxCandidateCells) {
    return preBudget({
      limit: 'maxCandidateCells',
      used: envelope.count,
      max: limits.maxCandidateCells,
      detail: `swept envelope has ${envelope.count} candidate cells, exceeding maxCandidateCells (${limits.maxCandidateCells})`,
    });
  }

  const points = query.points.map((point) => ({ x: point.x, y: point.y, z: point.z }));

  const deps = new Map<string, {
    key: SectionKey;
    revision: number;
    residency: SectionResidency;
    residencyGeneration: number;
  }>();
  const recordDep = (key: SectionKey, revision: number, residency: SectionResidency): void => {
    const ks = sectionKeyString(key);
    if (!deps.has(ks)) {
      deps.set(ks, {
        key: { ...key },
        revision,
        residency,
        residencyGeneration: map.residencyGeneration(key.dim, key.cx, key.cz, key.sy),
      });
    }
  };

  const sectionCache = new Map<string, Section | null>();
  const cellReadCache = new Map<string, CellRead>();
  let minValidUntil = Number.POSITIVE_INFINITY;
  let budgetProblem: BudgetProblem | null = null;

  const failBudget = (limit: keyof WaterValidationLimits, used: number, max: number, detail: string): void => {
    if (budgetProblem === null) budgetProblem = { limit, used, max, detail };
  };

  const chargeShape = (): boolean => {
    budget.shapeChecks += 1;
    if (budget.shapeChecks > limits.maxShapeChecks) {
      failBudget(
        'maxShapeChecks',
        budget.shapeChecks,
        limits.maxShapeChecks,
        `geometry work exceeded maxShapeChecks (${limits.maxShapeChecks})`,
      );
      return false;
    }
    return true;
  };

  const budgetEvaluation = (): WaterRouteEvaluation => {
    const problem = budgetProblem!;
    return {
      status: 'UNSUPPORTED',
      assurance: 'geometry_only',
      executable: false,
      profileKind,
      ruleVersions,
      worldId: query.worldId,
      dim: query.dim,
      sessionId: query.sessionId,
      points: points.map((point) => ({ ...point })),
      from: { ...points[0]! },
      to: { ...points[points.length - 1]! },
      reason: problem.detail,
      problem: {
        kind: 'budget_exceeded',
        detail: problem.detail,
        limit: problem.limit,
        used: problem.used,
        max: problem.max,
      },
      hazards: [],
      obstacles: [],
      dependencies: [...deps.values()].map((dep) => ({
        key: { ...dep.key },
        revision: dep.revision,
        residency: dep.residency,
        residencyGeneration: dep.residencyGeneration,
      })),
      budget,
      computedAt: now,
      validUntil: minValidUntil,
    };
  };

  const readCell = (x: number, y: number, z: number): CellRead => {
    const cacheKey = `${x},${y},${z}`;
    const cached = cellReadCache.get(cacheKey);
    if (cached !== undefined) return cached;

    budget.readCells += 1;
    if (budget.readCells > limits.maxReadCells) {
      failBudget(
        'maxReadCells',
        budget.readCells,
        limits.maxReadCells,
        `cell reads exceeded maxReadCells (${limits.maxReadCells})`,
      );
      return { kind: 'budget' };
    }

    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const sectionKey: SectionKey = { worldId: query.worldId, dim: query.dim, cx, cz, sy };
    const sk = sectionKeyString(sectionKey);
    let section = sectionCache.get(sk);
    if (section === undefined) {
      section = map.sectionAt(query.dim, x, y, z);
      sectionCache.set(sk, section);
    }
    const residency = map.sectionResidency(sectionKey).residency;
    if (section === null) {
      recordDep(sectionKey, 0, residency);
      // A saved-but-not-resident section is unavailable history, not air and not
      // "never observed". Only a true no_record section is unobserved.
      const result: CellRead = residency === 'no_record'
        ? { kind: 'unobserved', sectionKey, sectionRevision: 0 }
        : { kind: 'not_resident', sectionKey, sectionRevision: 0 };
      cellReadCache.set(cacheKey, result);
      return result;
    }
    recordDep(sectionKey, section.revision, residency);
    const evidence = section.evidence.get(cellIndex(lx, ly, lz));
    const sectionRevision = section.revision;

    const finish = (result: CellRead): CellRead => {
      cellReadCache.set(cacheKey, result);
      return result;
    };
    if (evidence === undefined) return finish({ kind: 'unobserved', sectionKey, sectionRevision });
    if (evidence.freshness === 'STALE') return finish({ kind: 'stale', sectionKey, sectionRevision });
    if (evidence.observation.sessionId !== query.sessionId) {
      return finish({ kind: 'session', sectionKey, sectionRevision });
    }
    if (now > evidence.validUntil) return finish({ kind: 'expired', sectionKey, sectionRevision });
    // Only evidence still valid at evaluation time bounds the conclusion's validity.
    minValidUntil = Math.min(minValidUntil, evidence.validUntil);
    if (!evidence.observation.stateComplete) {
      return finish({ kind: 'incomplete', sectionKey, sectionRevision });
    }
    return finish({ kind: 'observed', sectionKey, sectionRevision, evidence });
  };

  const neighborRead: ControlledNeighborRead = {
    get budgetExhausted() {
      return budgetProblem !== null;
    },
    cell(x: number, y: number, z: number): NeighborCellView {
      if (budgetProblem !== null) throw CONTROLLED_READ_BUDGET_EXCEEDED;
      budget.neighborReads += 1;
      if (budget.neighborReads > limits.maxNeighborReads) {
        failBudget(
          'maxNeighborReads',
          budget.neighborReads,
          limits.maxNeighborReads,
          `provider neighbour reads exceeded maxNeighborReads (${limits.maxNeighborReads})`,
        );
        throw CONTROLLED_READ_BUDGET_EXCEEDED;
      }
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
        // A provider must ask for integer grid cells; a malformed request is a
        // missing neighbour, never a guessed state.
        return { pos: { x, y, z }, kind: 'unobserved' };
      }
      const read = readCell(x, y, z);
      if (read.kind === 'budget') throw CONTROLLED_READ_BUDGET_EXCEEDED;
      const pos = { x, y, z };
      switch (read.kind) {
        case 'observed':
          return { pos, kind: 'observed', state: read.evidence.observation.state };
        case 'incomplete':
          return { pos, kind: 'incomplete' };
        case 'stale':
          return { pos, kind: 'stale', reason: 'stale' };
        case 'expired':
          return { pos, kind: 'stale', reason: 'expired' };
        case 'session':
          return { pos, kind: 'stale', reason: 'session' };
        case 'unobserved':
          return { pos, kind: 'unobserved' };
        case 'not_resident':
          return { pos, kind: 'unobserved' };
      }
    },
  };

  /**
   * Call an injected provider and stop its controlled neighbour loop promptly
   * when this library's own read budget is exhausted. Other provider errors
   * propagate unchanged.
   */
  const callProvider = <T>(call: () => T): T | null => {
    try {
      return call();
    } catch (error) {
      if (error === CONTROLLED_READ_BUDGET_EXCEEDED) return null;
      throw error;
    }
  };

  const records: CellRecord[] = [];
  for (let x = envelope.xMin; x <= envelope.xMax; x++) {
    for (let y = envelope.yMin; y <= envelope.yMax; y++) {
      for (let z = envelope.zMin; z <= envelope.zMax; z++) {
        budget.candidateCells += 1;
        const cell = { x, y, z };
        const relevance = cellRelevance(cell);
        if (budgetProblem !== null) return budgetEvaluation();
        if (!relevance.collisionRelevant && !relevance.surfaceRelevant) continue;

        const read = readCell(x, y, z);
        if (read.kind === 'budget') return budgetEvaluation();

        let solid: SolidResolved | null = null;
        let fluid: FluidResolved | null = null;
        if (read.kind === 'observed') {
          const resolution = callProvider(() =>
            query.solidShapeProvider.resolve(read.evidence.observation.state, cell, neighborRead),
          );
          if (resolution === null || budgetProblem !== null) return budgetEvaluation();
          solid = toSolidResolution(resolution);
          const fluidResolution = callProvider(() =>
            query.fluidShapeProvider.resolve(read.evidence.observation.state, cell, neighborRead),
          );
          if (fluidResolution === null || budgetProblem !== null) return budgetEvaluation();
          fluid = toFluidResolution(fluidResolution);
        }
        records.push({
          cell,
          collisionRelevant: relevance.collisionRelevant,
          surfaceRelevant: relevance.surfaceRelevant,
          read,
          solid,
          fluid,
        });
      }
    }
  }

  // --- solid collision / head clearance over the exact linear sweep ---

  const solidUnresolved: Unresolved[] = [];
  const fluidUnresolved: Unresolved[] = [];
  const obstacles: ObstacleEvidence[] = [];
  let blocked: { problem: WaterRouteProblem } | null = null;

  const unresolvedCategory = (read: CellRead): UnresolvedCategory =>
    read.kind === 'stale' || read.kind === 'expired' || read.kind === 'session'
      ? 'stale'
      : read.kind === 'not_resident'
        ? 'not_resident'
        : 'unknown';

  for (const record of records) {
    if (!record.collisionRelevant) continue;
    if (record.read.kind !== 'observed') {
      solidUnresolved.push({
        category: unresolvedCategory(record.read),
        cell: record.cell,
        viaNeighborGap: false,
      });
      continue;
    }
    if (record.solid === null) {
      solidUnresolved.push({ category: 'unknown', cell: record.cell, viaNeighborGap: false });
      continue;
    }
    if (record.solid.kind === 'unsupported') {
      solidUnresolved.push({ category: 'unsupported', cell: record.cell, viaNeighborGap: false });
      continue;
    }
    if (record.solid.kind === 'gap') {
      solidUnresolved.push({
        category: record.solid.view.kind === 'stale' ? 'stale' : 'unknown',
        cell: record.cell,
        viaNeighborGap: true,
      });
      continue;
    }
    if (blocked !== null) continue;
    const observation = record.read.evidence.observation;
    const boxes = record.solid.shape.boxes;
    // Charge the provider's declared shape list before retrieving any element.
    if (!Number.isSafeInteger(boxes.length) || boxes.length > limits.maxShapeChecks - budget.shapeChecks) {
      failBudget(
        'maxShapeChecks',
        budget.shapeChecks + boxes.length,
        limits.maxShapeChecks,
        `solid shape parts exceeded the remaining maxShapeChecks (${limits.maxShapeChecks})`,
      );
      return budgetEvaluation();
    }

    for (const volume of geometry.volumes) {
      for (const segment of segments) {
        for (const box of record.solid.shape.boxes) {
          if (!chargeShape()) return budgetEvaluation();
          if (!boxSweepOverlaps(volume, segment.from, segment.to, record.cell, box)) continue;
          obstacles.push({ kind: 'block', observation: cloneObservation(observation) });
          blocked = {
            problem: volume.clearance
              ? {
                  kind: 'head_clearance',
                  cells: [record.cell],
                  detail: `${volume.name} clearance intersects a solid shape at (${record.cell.x}, ${record.cell.y}, ${record.cell.z})`,
                }
              : {
                  kind: 'collision',
                  cells: [record.cell],
                  detail: `${volume.name} volume intersects a solid shape at (${record.cell.x}, ${record.cell.y}, ${record.cell.z})`,
                },
          };
          break;
        }
        if (blocked !== null) break;
      }
      if (blocked !== null) break;
    }
  }

  // Fluid shapes are collected even when the cell is relevant only for surface coverage.
  for (const record of records) {
    if (!record.collisionRelevant && !record.surfaceRelevant) continue;
    if (record.read.kind !== 'observed') {
      if (record.surfaceRelevant) {
        fluidUnresolved.push({
          category: unresolvedCategory(record.read),
          cell: record.cell,
          viaNeighborGap: false,
        });
      }
      continue;
    }
    if (record.fluid === null) {
      fluidUnresolved.push({ category: 'unknown', cell: record.cell, viaNeighborGap: false });
      continue;
    }
    if (record.fluid.kind === 'unsupported') {
      fluidUnresolved.push({ category: 'unsupported', cell: record.cell, viaNeighborGap: false });
      continue;
    }
    if (record.fluid.kind === 'gap') {
      fluidUnresolved.push({
        category: record.fluid.view.kind === 'stale' ? 'stale' : 'unknown',
        cell: record.cell,
        viaNeighborGap: true,
      });
    }
    if (record.fluid.kind === 'shape') {
      const waterMotion = record.fluid.shape.water?.motion;
      const lavaMotion = record.fluid.shape.lava?.motion;
      if (waterMotion === 'unknown' || lavaMotion === 'unknown') {
        // motion 是 provider 的真实声明；unknown 不能被当作 still 或 OPEN。
        fluidUnresolved.push({ category: 'motion_unknown', cell: record.cell, viaNeighborGap: false });
      }
    }
  }

  // --- continuous water-surface contact under the declared footprint and band ---

  const observedSurfaceIntervals: Array<[number, number]> = [];
  const surfaceContributors = new Set<string>();
  const breathingViolationCells: Vec3Like[] = [];
  let breathingViolation = false;
  for (const record of records) {
    const shape = observedFluid(record);
    const water = shape?.water;
    if (water === null || water === undefined || typeof water.surface !== 'object') continue;
    const absoluteSurfaceY = record.cell.y + water.surface.y;
    if (absoluteSurfaceY < geometry.surfaceBand.minY - EPS || absoluteSurfaceY > geometry.surfaceBand.maxY + EPS) {
      continue;
    }
    // The surface must cross the body/hull vertical range, not merely touch its
    // bottom or top. A surface elsewhere inside a broad band is not a valid
    // waterline for this profile.
    if (
      absoluteSurfaceY <= routeY + geometry.contactMinY + EPS ||
      absoluteSurfaceY >= routeY + geometry.contactMaxY - EPS
    ) {
      continue;
    }
    // Breathing conclusions are deliberately not derived from this surface's
    // global height: the exact water-volume sweep below binds them to the
    // declared breathing volume's actual 3D overlap.
    for (let i = 0; i < segments.length; i++) {
      if (!chargeShape()) return budgetEvaluation();
      const interval = footprintInterval(
        segments[i]!.from,
        segments[i]!.to,
        geometry.contactHalfX,
        geometry.contactHalfZ,
        record.cell,
        water.surface,
      );
      const bounded = interval === null ? null : clampSegmentInterval(interval);
      if (bounded === null) continue;
      observedSurfaceIntervals.push([i + bounded[0], i + bounded[1]]);
      surfaceContributors.add(cellKey(record.cell));
    }
  }

  const segmentSpan = segments.length;
  let missingSurface: { problem: WaterRouteProblem } | null = null;
  let surfaceUnsupported: Unresolved[] = [];
  let surfaceStale: Unresolved[] = [];
  let surfaceNotResident: Unresolved[] = [];
  let surfaceUnknown: Unresolved[] = [];

  const observedGaps = uncoveredGaps(observedSurfaceIntervals, 0, segmentSpan);
  if (observedGaps.length > 0) {
    const potentials: PotentialSurface[] = [];
    for (const record of records) {
      if (!record.surfaceRelevant) continue;
      const potential = surfacePotential(record);
      if (potential === null) continue;
      const intervals: Array<[number, number]> = [];
      for (let i = 0; i < segments.length; i++) {
        if (!chargeShape()) return budgetEvaluation();
        const interval = footprintInterval(
          segments[i]!.from,
          segments[i]!.to,
          geometry.contactHalfX,
          geometry.contactHalfZ,
          record.cell,
          FULL_PATCH,
        );
        const bounded = interval === null ? null : clampSegmentInterval(interval);
        if (bounded !== null) intervals.push([i + bounded[0], i + bounded[1]]);
      }
      if (intervals.length > 0) potentials.push({ ...potential, intervals });
    }

    const potentialIntervals = potentials.flatMap((potential) => potential.intervals);
    const remaining = uncoveredGaps([...observedSurfaceIntervals, ...potentialIntervals], 0, segmentSpan);
    if (remaining.length > 0) {
      missingSurface = {
        problem: {
          kind: 'missing_surface',
          cells: remaining.map(([lo, hi]) => surfaceGapCell(segments, (lo + hi) / 2, geometry.surfaceBand.minY)),
          detail: `no observed water surface in the declared band covers ${remaining.length} route interval(s)`,
        },
      };
    } else {
      const relevant = potentials.filter((potential) => overlapsAnyGap(potential.intervals, observedGaps));
      const unsupported = relevant.filter((potential) => potential.category === 'unsupported');
      const stale = relevant.filter((potential) => potential.category === 'stale');
      const notResident = relevant.filter((potential) => potential.category === 'not_resident');
      const unknown = relevant.filter((potential) => potential.category === 'unknown');
      if (unsupported.length > 0) surfaceUnsupported = unsupported;
      else if (stale.length > 0) surfaceStale = stale;
      else if (notResident.length > 0) surfaceNotResident = notResident;
      else surfaceUnknown = unknown;
    }
    // `potentialIntervals` is only used for the conservative cover check above.
  }

  // --- independent hazard facts ---

  const hazards: HazardFact[] = [];
  const seenHazards = new Set<string>();
  const addHazard = (hazard: HazardFact): void => {
    const key = `${hazard.kind}|${cellKey(hazard.pos)}|${hazard.detail}`;
    if (seenHazards.has(key)) return;
    seenHazards.add(key);
    hazards.push(hazard);
  };

  for (const record of records) {
    const shape = observedFluid(record);
    if (shape === null) continue;

    let waterContact = false;
    let primaryContact = false;
    let waterBreathingContact = false;
    let lavaContact = false;
    let lavaBreathingContact = false;
    if (shape.water !== null) {
      for (const volume of geometry.volumes) {
        for (const segment of segments) {
          if (!chargeShape()) return budgetEvaluation();
          if (boxSweepOverlaps(volume, segment.from, segment.to, record.cell, shape.water.box)) {
            waterContact = true;
            // Only the primary body/hull can substantiate "the body/hull is
            // under this surface"; torso/clearance contact stays a contact fact.
            if (!volume.clearance) primaryContact = true;
            if (volume.breathing) waterBreathingContact = true;
            break;
          }
        }
      }
      if (waterContact) {
        addHazard({
          kind: 'water_contact',
          pos: { ...record.cell },
          basis: 'derived',
          detail: 'observed water volume intersects the declared body/hull/clearance sweep',
        });
      }
      const surfaceY = typeof shape.water.surface === 'object' ? shape.water.surface.y : null;
      if (
        primaryContact &&
        surfaceY !== null &&
        record.cell.y + surfaceY > routeY + geometry.contactMaxY + EPS
      ) {
        // The body/hull is under an observed surface: this is not surface travel.
        breathingViolation = true;
        breathingViolationCells.push({ ...record.cell });
        addHazard({
          kind: 'submersion',
          pos: { ...record.cell },
          basis: 'derived',
          detail: 'observed water surface lies above the declared body/hull top',
        });
      }
      if (waterBreathingContact) {
        breathingViolation = true;
        breathingViolationCells.push({ ...record.cell });
        addHazard({
          kind: 'submersion',
          pos: { ...record.cell },
          basis: 'derived',
          detail: 'observed water volume intersects a declared breathing volume',
        });
      }
    }
    if (shape.lava !== null) {
      for (const volume of geometry.volumes) {
        for (const segment of segments) {
          if (!chargeShape()) return budgetEvaluation();
          if (boxSweepOverlaps(volume, segment.from, segment.to, record.cell, shape.lava.box)) {
            lavaContact = true;
            if (volume.breathing) lavaBreathingContact = true;
            break;
          }
        }
      }
      if (lavaContact) {
        addHazard({
          kind: 'lava_contact',
          pos: { ...record.cell },
          basis: 'derived',
          detail: 'observed lava volume intersects the declared body/hull/clearance geometry',
        });
      }
      if (lavaBreathingContact) {
        breathingViolation = true;
        breathingViolationCells.push({ ...record.cell });
      }
    }

    if (waterContact || lavaContact || surfaceContributors.has(cellKey(record.cell))) {
      const risks = shape.risks;
      if (!Array.isArray(risks)) throw new Error('fluid provider returned a non-array risks value');
      // Provider-declared motion is authoritative: flowing/falling must not be
      // silently treated as still just because risks[] omitted it. `unknown`
      // already makes the route UNKNOWN via fluidUnresolved.
      const motionRisks: FluidRiskFact[] = [];
      const addMotionRisk = (volume: FluidVolume | null): void => {
        if (volume === null) return;
        const kind = volume.motion === 'flowing' ? 'current' : volume.motion === 'falling' ? 'falling' : null;
        if (kind === null || risks.some((risk) => risk.kind === kind)) return;
        motionRisks.push({
          kind,
          basis: 'observed',
          detail: `provider reports ${volume.kind} ${volume.motion}`,
        });
      };
      addMotionRisk(shape.water);
      addMotionRisk(shape.lava);
      const riskCount = risks.length + motionRisks.length;
      // Charge provider facts before enumerating them; an over-long list is
      // rejected without touching its elements.
      if (!Number.isSafeInteger(riskCount) || budget.riskFacts + riskCount > limits.maxRiskFacts) {
        failBudget(
          'maxRiskFacts',
          budget.riskFacts + riskCount,
          limits.maxRiskFacts,
          `fluid risk facts exceeded maxRiskFacts (${limits.maxRiskFacts})`,
        );
        return budgetEvaluation();
      }
      budget.riskFacts += riskCount;
      for (const risk of [...risks, ...motionRisks]) {
        addHazard({
          kind: risk.kind === 'falling' ? 'fall' : risk.kind,
          pos: { ...record.cell },
          basis: risk.basis,
          detail: risk.detail,
        });
      }
    }
  }

  if (budgetProblem !== null) return budgetEvaluation();

  // --- verdict precedence: budget, confirmed physical failure, capability, evidence ---

  const allUnresolved = [
    ...solidUnresolved,
    ...fluidUnresolved,
    ...surfaceUnsupported,
    ...surfaceStale,
    ...surfaceNotResident,
    ...surfaceUnknown,
  ];
  const dedupeCells = (entries: Unresolved[]): Vec3Like[] => {
    const seen = new Set<string>();
    return entries.flatMap((entry) => {
      const key = cellKey(entry.cell);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...entry.cell }];
    });
  };

  const base = {
    assurance: 'geometry_only' as const,
    executable: false as const,
    profileKind,
    ruleVersions,
    worldId: query.worldId,
    dim: query.dim,
    sessionId: query.sessionId,
    points: points.map((point) => ({ ...point })),
    from: { ...points[0]! },
    to: { ...points[points.length - 1]! },
    hazards,
    obstacles,
    dependencies: [...deps.values()].map((dep) => ({
      key: { ...dep.key },
      revision: dep.revision,
      residency: dep.residency,
      residencyGeneration: dep.residencyGeneration,
    })),
    budget,
    computedAt: now,
    validUntil: minValidUntil,
  };

  if (blocked !== null) {
    return {
      ...base,
      status: 'BLOCKED',
      reason: blocked.problem.detail,
      problem: blocked.problem,
    };
  }
  if (breathingViolation) {
    const cells = dedupeCells(
      breathingViolationCells.map((cell) => ({ category: 'unknown' as const, cell, viaNeighborGap: false })),
    );
    return {
      ...base,
      status: 'UNSUPPORTED',
      reason: 'the adopted waterline/water volume does not leave the declared breathing volume clear',
      problem: {
        kind: 'submerged_posture',
        cells,
        detail: 'surface-only travel is not supported when a breathing volume is submerged or wet',
      },
    };
  }
  if (missingSurface !== null) {
    return {
      ...base,
      status: 'BLOCKED',
      reason: missingSurface.problem.detail,
      problem: missingSurface.problem,
    };
  }

  const unsupported = allUnresolved.filter((entry) => entry.category === 'unsupported');
  if (unsupported.length > 0) {
    const detail = 'a required solid or fluid shape cannot be resolved from current evidence';
    return {
      ...base,
      status: 'UNSUPPORTED',
      reason: detail,
      problem: { kind: 'unsupported_shape', cells: dedupeCells(unsupported), detail },
    };
  }

  const stale = allUnresolved.filter((entry) => entry.category === 'stale');
  if (stale.length > 0) {
    const detail = `${stale.length} required cell(s) have stale or expired evidence`;
    return {
      ...base,
      status: 'STALE',
      reason: detail,
      problem: { kind: 'stale', cells: dedupeCells(stale), detail },
    };
  }

  const notResident = allUnresolved.filter((entry) => entry.category === 'not_resident');
  if (notResident.length > 0) {
    const detail = `${notResident.length} required cell(s) belong to saved but not resident sections; they are unavailable history, not unobserved air`;
    return {
      ...base,
      status: 'UNKNOWN',
      reason: detail,
      problem: { kind: 'not_resident', cells: dedupeCells(notResident), detail },
    };
  }

  const motionUnknown = allUnresolved.filter((entry) => entry.category === 'motion_unknown');
  if (motionUnknown.length > 0) {
    const detail = `${motionUnknown.length} required cell(s) have provider-declared unknown fluid motion`;
    return {
      ...base,
      status: 'UNKNOWN',
      reason: detail,
      problem: { kind: 'motion_unknown', cells: dedupeCells(motionUnknown), detail },
    };
  }

  const unknown = allUnresolved.filter((entry) => entry.category === 'unknown');
  if (unknown.length > 0) {
    const viaGap = unknown.some((entry) => entry.viaNeighborGap);
    const detail = viaGap
      ? 'a fluid/solid provider could not resolve a required neighbour from current evidence'
      : `${unknown.length} required cell(s) are unobserved or state-incomplete`;
    return {
      ...base,
      status: 'UNKNOWN',
      reason: detail,
      problem: {
        kind: viaGap ? 'neighbor_gap' : 'unobserved',
        cells: dedupeCells(unknown),
        detail,
      },
    };
  }

  return { ...base, status: 'OPEN' };

  // --- local closures (kept beside the evaluation so read/budget state is shared) ---

  function cellRelevance(cell: Vec3Like): { collisionRelevant: boolean; surfaceRelevant: boolean } {
    let collisionRelevant = false;
    outer: for (const volume of geometry.volumes) {
      for (const segment of segments) {
        if (!chargeShape()) return { collisionRelevant: false, surfaceRelevant: false };
        if (boxSweepOverlaps(volume, segment.from, segment.to, cell, UNIT_BOX)) {
          collisionRelevant = true;
          break outer;
        }
      }
    }

    let surfaceRelevant = false;
    const contactSurfaceMinY = Math.max(geometry.surfaceBand.minY, routeY + geometry.contactMinY);
    const contactSurfaceMaxY = Math.min(geometry.surfaceBand.maxY, routeY + geometry.contactMaxY);
    if (cell.y + 1 > contactSurfaceMinY + EPS && cell.y < contactSurfaceMaxY - EPS) {
      for (const segment of segments) {
        if (!chargeShape()) return { collisionRelevant, surfaceRelevant: false };
        const interval = footprintInterval(
          segment.from,
          segment.to,
          geometry.contactHalfX,
          geometry.contactHalfZ,
          cell,
          FULL_PATCH,
        );
        if (interval !== null && clampSegmentInterval(interval) !== null) {
          surfaceRelevant = true;
          break;
        }
      }
    }
    return { collisionRelevant, surfaceRelevant };
  }

  function surfacePotential(record: CellRecord): Unresolved | null {
    if (record.read.kind !== 'observed') {
      return {
        category: unresolvedCategory(record.read),
        cell: record.cell,
        viaNeighborGap: false,
      };
    }
    if (record.fluid === null) {
      return { category: 'unknown', cell: record.cell, viaNeighborGap: false };
    }
    if (record.fluid.kind === 'unsupported') {
      return { category: 'unsupported', cell: record.cell, viaNeighborGap: false };
    }
    if (record.fluid.kind === 'gap') {
      return {
        category: record.fluid.view.kind === 'stale' ? 'stale' : 'unknown',
        cell: record.cell,
        viaNeighborGap: true,
      };
    }
    const water = record.fluid.shape.water;
    if (water === null) return null;
    if (water.surface === 'none') return null;
    if (water.surface === 'unknown') {
      // An unknown surface can never be treated as "no water" or as OPEN.
      return { category: 'unknown', cell: record.cell, viaNeighborGap: false };
    }
    // A declared surface outside the band, or one in the band that did not cover
    // the footprint, is a definite geometry result rather than a missing-evidence
    // gap.
    return null;
  }

  function surfaceGapCell(routeSegments: readonly Segment[], t: number, surfaceY: number): Vec3Like {
    const clamped = Math.max(0, Math.min(routeSegments.length, t));
    const index = Math.min(routeSegments.length - 1, Math.max(0, Math.floor(clamped)));
    const local = clamped - index;
    const segment = routeSegments[index]!;
    const px = segment.from.x + (segment.to.x - segment.from.x) * local;
    const pz = segment.from.z + (segment.to.z - segment.from.z) * local;
    return { x: Math.floor(px), y: Math.floor(surfaceY), z: Math.floor(pz) };
  }
}

function toSolidResolution(resolution: ReturnType<CollisionShapeProvider['resolve']>): SolidResolved {
  if (resolution.kind === 'shape') return { kind: 'shape', shape: resolution.shape };
  if (resolution.kind === 'unsupported_shape') return { kind: 'unsupported', detail: resolution.detail };
  return { kind: 'gap', view: resolution.view };
}

function toFluidResolution(resolution: FluidShapeResolution): FluidResolved {
  if (resolution.kind === 'shape') return { kind: 'shape', shape: resolution.shape };
  if (resolution.kind === 'unsupported_fluid') return { kind: 'unsupported', detail: resolution.detail };
  return { kind: 'gap', view: resolution.view };
}

function observedFluid(record: CellRecord): FluidShape | null {
  return record.fluid !== null && record.fluid.kind === 'shape' ? record.fluid.shape : null;
}

function cellKey(cell: Vec3Like): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

function resolveLimits(limits: WaterLimits | undefined): WaterValidationLimits {
  const resolved: WaterValidationLimits = { ...DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof WaterValidationLimits>) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer: ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/** Length-only profile volume count, safe against throwing element getters. */
function profileVolumeCount(profile: WaterProfile): { safe: boolean; count: number } {
  if (profile.kind === 'surface_swim') return { safe: true, count: 2 };
  const clearance = profile.passengerClearance;
  const breathing = profile.passengerBreathing;
  if (!Array.isArray(clearance) || !Array.isArray(breathing)) {
    return { safe: false, count: 0 };
  }
  const count = 1 + clearance.length + breathing.length;
  return { safe: Number.isSafeInteger(count), count };
}

function resolveArrivalLimits(limits: WaterArrivalLimitsInput | undefined): WaterArrivalLimits {
  const resolved: WaterArrivalLimits = { ...DEFAULT_ARRIVAL_LIMITS };
  if (limits === undefined) return resolved;
  for (const key of Object.keys(DEFAULT_ARRIVAL_LIMITS) as Array<keyof WaterArrivalLimits>) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer: ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

function validateProfile(profile: WaterProfile): void {
  validateOrientation(profile.orientation);
  validateBand(profile.surfaceBand);
  if (profile.kind === 'surface_swim') {
    assertPositive(profile.body.width, 'body.width');
    assertPositive(profile.body.height, 'body.height');
    assertFinite(profile.breathing.minY, 'breathing.minY');
    assertPositive(profile.breathing.width, 'breathing.width');
    assertPositive(profile.breathing.height, 'breathing.height');
    return;
  }
  assertPositive(profile.hull.width, 'hull.width');
  assertPositive(profile.hull.length, 'hull.length');
  assertPositive(profile.hull.height, 'hull.height');
  if (profile.passengerClearance.length === 0) {
    throw new Error('mounted_boat requires at least one declared passengerClearance volume');
  }
  for (const box of profile.passengerClearance) {
    assertBox(box, 'passengerClearance');
  }
  if (profile.passengerBreathing.length === 0) {
    throw new Error('mounted_boat requires at least one declared passengerBreathing volume');
  }
  for (const box of profile.passengerBreathing) {
    assertBox(box, 'passengerBreathing');
  }
}

function validateOrientation(orientation: { quarterTurns: number }): void {
  if (
    !Number.isInteger(orientation.quarterTurns) ||
    orientation.quarterTurns < 0 ||
    orientation.quarterTurns > 3
  ) {
    throw new Error(`orientation.quarterTurns must be an integer in 0..3: ${orientation.quarterTurns}`);
  }
}

function validateBand(band: { minY: number; maxY: number }): void {
  assertFinite(band.minY, 'surfaceBand.minY');
  assertFinite(band.maxY, 'surfaceBand.maxY');
  if (band.minY > band.maxY) {
    throw new Error(`surfaceBand.minY (${band.minY}) must not exceed surfaceBand.maxY (${band.maxY})`);
  }
}

function assertBox(box: Box3, label: string): void {
  for (const [name, value] of [
    ['minX', box.minX],
    ['minY', box.minY],
    ['minZ', box.minZ],
    ['maxX', box.maxX],
    ['maxY', box.maxY],
    ['maxZ', box.maxZ],
  ] as const) {
    assertFinite(value, `${label}.${name}`);
  }
  if (box.minX >= box.maxX || box.minY >= box.maxY || box.minZ >= box.maxZ) {
    throw new Error(`${label} must have strictly positive extent`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number: ${value}`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new Error(`${label} must be positive: ${value}`);
}

function buildGeometry(profile: WaterProfile, routeY: number): RouteGeometry {
  if (profile.kind === 'surface_swim') {
    const body: WorldVolume = {
      name: 'body',
      clearance: false,
      breathing: false,
      minX: -profile.body.width / 2,
      maxX: profile.body.width / 2,
      minY: 0,
      maxY: profile.body.height,
      minZ: -profile.body.width / 2,
      maxZ: profile.body.width / 2,
    };
    const breathing: WorldVolume = {
      name: 'breathing',
      clearance: true,
      breathing: true,
      minX: -profile.breathing.width / 2,
      maxX: profile.breathing.width / 2,
      minY: profile.breathing.minY,
      maxY: profile.breathing.minY + profile.breathing.height,
      minZ: -profile.breathing.width / 2,
      maxZ: profile.breathing.width / 2,
    };
    if (
      profile.surfaceBand.maxY < routeY + body.minY - EPS ||
      profile.surfaceBand.minY > routeY + body.maxY + EPS
    ) {
      throw new Error('surfaceBand must intersect the swimmer body vertical span');
    }
    return {
      volumes: [body, breathing],
      contactHalfX: profile.body.width / 2,
      contactHalfZ: profile.body.width / 2,
      surfaceBand: { ...profile.surfaceBand },
      contactMinY: body.minY,
      contactMaxY: body.maxY,
    };
  }

  const hull = rotateLocalBox(
    {
      minX: -profile.hull.width / 2,
      maxX: profile.hull.width / 2,
      minY: 0,
      maxY: profile.hull.height,
      minZ: -profile.hull.length / 2,
      maxZ: profile.hull.length / 2,
    },
    profile.orientation.quarterTurns,
  );
  const passengerClearance = profile.passengerClearance.map<WorldVolume>((box) => ({
    ...rotateLocalBox(box, profile.orientation.quarterTurns),
    name: 'passenger',
    clearance: true,
    breathing: false,
  }));
  const passengerBreathing = profile.passengerBreathing.map<WorldVolume>((box) => ({
    ...rotateLocalBox(box, profile.orientation.quarterTurns),
    name: 'passengerBreathing',
    clearance: true,
    breathing: true,
  }));
  const volumes: WorldVolume[] = [
    { ...hull, name: 'hull', clearance: false, breathing: false },
    ...passengerClearance,
    ...passengerBreathing,
  ];
  if (
    profile.surfaceBand.maxY < routeY + hull.minY - EPS ||
    profile.surfaceBand.minY > routeY + hull.maxY + EPS
  ) {
    throw new Error('surfaceBand must intersect the mounted boat hull vertical span');
  }
  return {
    volumes,
    contactHalfX: Math.max(Math.abs(hull.minX), Math.abs(hull.maxX)),
    contactHalfZ: Math.max(Math.abs(hull.minZ), Math.abs(hull.maxZ)),
    surfaceBand: { ...profile.surfaceBand },
    contactMinY: hull.minY,
    contactMaxY: hull.maxY,
  };
}

function rotateLocalBox(box: Box3, quarterTurns: 0 | 1 | 2 | 3): Box3 {
  if (quarterTurns === 0) return { ...box };
  const xs = [box.minX, box.maxX];
  const zs = [box.minZ, box.maxZ];
  const rotated = xs.flatMap((x) => zs.map((z) => rotateXZ(x, z, quarterTurns)));
  return {
    minX: Math.min(...rotated.map(([x]) => x)),
    maxX: Math.max(...rotated.map(([x]) => x)),
    minY: box.minY,
    maxY: box.maxY,
    minZ: Math.min(...rotated.map(([, z]) => z)),
    maxZ: Math.max(...rotated.map(([, z]) => z)),
  };
}

function rotateXZ(x: number, z: number, quarterTurns: 0 | 1 | 2 | 3): [number, number] {
  switch (quarterTurns) {
    case 0:
      return [x, z];
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
  }
}

interface Envelope {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  count: number;
  /** False when bounds/count are non-finite, unsafe, or cannot advance by 1. */
  safe: boolean;
}

function computeEnvelope(points: readonly Vec3Like[], geometry: RouteGeometry): Envelope {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x - geometry.contactHalfX);
    maxX = Math.max(maxX, point.x + geometry.contactHalfX);
    minZ = Math.min(minZ, point.z - geometry.contactHalfZ);
    maxZ = Math.max(maxZ, point.z + geometry.contactHalfZ);
    for (const volume of geometry.volumes) {
      minX = Math.min(minX, point.x + volume.minX);
      maxX = Math.max(maxX, point.x + volume.maxX);
      minZ = Math.min(minZ, point.z + volume.minZ);
      maxZ = Math.max(maxZ, point.z + volume.maxZ);
      minY = Math.min(minY, point.y + volume.minY);
      maxY = Math.max(maxY, point.y + volume.maxY);
    }
  }

  const [xMin, xMax] = cellRange(minX, maxX);
  const [zMin, zMax] = cellRange(minZ, maxZ);
  // Surface cells need room for a surface anywhere inside the declared band; one
  // extra layer on each side keeps the envelope conservative.
  const bandYMin = Math.floor(geometry.surfaceBand.minY) - 1;
  const bandYMax = Math.floor(geometry.surfaceBand.maxY) + 1;
  const collisionYMin = Number.isFinite(minY) ? Math.floor(minY + EPS) : bandYMin;
  const collisionYMax = Number.isFinite(maxY) ? Math.floor(maxY - EPS) : bandYMax;
  const yMin = Math.min(collisionYMin, bandYMin);
  const yMax = Math.max(collisionYMax, bandYMax);

  const count = (xMax - xMin + 1) * (yMax - yMin + 1) * (zMax - zMin + 1);
  const bounds = [xMin, xMax, yMin, yMax, zMin, zMax];
  const safe =
    bounds.every(isSafeEnumeratedBound) &&
    Number.isSafeInteger(xMax - xMin) &&
    Number.isSafeInteger(yMax - yMin) &&
    Number.isSafeInteger(zMax - zMin) &&
    Number.isSafeInteger(count) &&
    count >= 0;
  return { xMin, xMax, yMin, yMax, zMin, zMax, count, safe };
}

function cellRange(min: number, max: number): [number, number] {
  const lo = Math.floor(min + EPS);
  const hi = Math.floor(max - EPS);
  if (hi < lo) return [Math.floor(min), Math.floor(min)];
  return [lo, hi];
}

/**
 * A bound that is a safe integer and whose successor still advances exactly.
 * This is arithmetic capability validation, not a world-border rule.
 */
function isSafeEnumeratedBound(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER - 2;
}

/**
 * Exact swept overlap of one moving world volume against one unit-local solid
 * box. All three axes must overlap over a common positive-time interval; contact
 * at an exact boundary is not penetration, and a corner of the swept envelope
 * the body never enters is not a collision.
 */
function boxSweepOverlaps(
  volume: Box3,
  from: Vec3Like,
  to: Vec3Like,
  cell: Vec3Like,
  box: UnitBox,
): boolean {
  const x = axisSweepOverlapTimes(
    from.x + volume.minX,
    from.x + volume.maxX,
    to.x - from.x,
    cell.x + box.minX,
    cell.x + box.maxX,
  );
  if (x === null) return false;
  const y = axisSweepOverlapTimes(
    from.y + volume.minY,
    from.y + volume.maxY,
    to.y - from.y,
    cell.y + box.minY,
    cell.y + box.maxY,
  );
  if (y === null) return false;
  const z = axisSweepOverlapTimes(
    from.z + volume.minZ,
    from.z + volume.maxZ,
    to.z - from.z,
    cell.z + box.minZ,
    cell.z + box.maxZ,
  );
  if (z === null) return false;
  const tMin = Math.max(x[0], y[0], z[0]);
  const tMax = Math.min(x[1], y[1], z[1]);
  return tMax - tMin > EPS;
}

function axisSweepOverlapTimes(
  min0: number,
  max0: number,
  delta: number,
  staticMin: number,
  staticMax: number,
): [number, number] | null {
  if (delta === 0) {
    return max0 - staticMin > EPS && staticMax - min0 > EPS ? [0, 1] : null;
  }
  const tA = (staticMin - max0) / delta;
  const tB = (staticMax - min0) / delta;
  const tMin = Math.max(0, Math.min(tA, tB));
  const tMax = Math.min(1, Math.max(tA, tB));
  return tMax - tMin > EPS ? [tMin, tMax] : null;
}

/** Exact time interval in which a moving rectangular footprint overlaps one surface patch. */
function footprintInterval(
  from: Vec3Like,
  to: Vec3Like,
  halfX: number,
  halfZ: number,
  cell: Vec3Like,
  patch: FluidSurfacePatch,
): [number, number] | null {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  const axes: Array<[number, number, number, number]> = [
    [from.x, to.x, cell.x + patch.minX - halfX, cell.x + patch.maxX + halfX],
    [from.z, to.z, cell.z + patch.minZ - halfZ, cell.z + patch.maxZ + halfZ],
  ];
  for (const [start, end, min, max] of axes) {
    const delta = end - start;
    if (Math.abs(delta) < EPS) {
      if (start <= min + EPS || start >= max - EPS) return null;
    } else {
      const a = (min - start) / delta;
      const b = (max - start) / delta;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
  }
  return hi - lo > EPS ? [lo, hi] : null;
}

/**
 * Clamp a segment-local interval to [0, 1] before it is globalized. Without
 * this, one segment's extended supporting line could cover unrelated later
 * segments.
 */
function clampSegmentInterval(interval: readonly [number, number]): [number, number] | null {
  const lo = Math.max(0, interval[0]);
  const hi = Math.min(1, interval[1]);
  return hi - lo > EPS ? [lo, hi] : null;
}

/**
 * Maximal closed sub-intervals of [segMin, segMax] not covered by any interval.
 * Intervals are open (positive-length contact only), so touching endpoints do
 * not cover a gap and zero-width gaps are never reported.
 */
function uncoveredGaps(
  intervals: ReadonlyArray<readonly [number, number]>,
  segMin: number,
  segMax: number,
): Array<[number, number]> {
  const sorted = intervals
    .filter(([lo, hi]) => hi - lo > EPS)
    .map(([lo, hi]) => [lo, hi] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lo <= last[1] + EPS) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }

  const gaps: Array<[number, number]> = [];
  let cursor = segMin;
  for (const [lo, hi] of merged) {
    if (hi <= cursor + EPS) continue;
    if (lo > cursor + EPS) gaps.push([cursor, Math.min(lo, segMax)]);
    cursor = Math.max(cursor, hi);
    if (cursor >= segMax - EPS) break;
  }
  if (segMax - cursor > EPS) gaps.push([cursor, segMax]);
  return gaps;
}

function overlapsAnyGap(
  intervals: ReadonlyArray<readonly [number, number]>,
  gaps: ReadonlyArray<readonly [number, number]>,
): boolean {
  return gaps.some(([gapLo, gapHi]) =>
    intervals.some(([lo, hi]) => hi > gapLo + EPS && lo < gapHi - EPS),
  );
}

// --- completion verification ---

/**
 * Validate one explicit completion goal over measured, bounded, ordered body
 * samples. Surface targets never require dry land; dry-shore targets require
 * measured dry/grounded evidence plus the existing geometric support check;
 * dock targets require a matching stable boat identity, low measured speed and
 * an ordered stable window.
 */
export function checkWaterArrival(request: WaterArrivalRequest): WaterArrivalResult {
  if (!Number.isFinite(request.now)) {
    throw new Error(`now must be a finite number: ${request.now}`);
  }
  if (!Number.isFinite(request.maxSampleAgeMs) || request.maxSampleAgeMs <= 0) {
    throw new Error(`maxSampleAgeMs must be a positive finite number: ${request.maxSampleAgeMs}`);
  }
  const limits = resolveArrivalLimits(request.limits);
  validateGoal(request.goal);
  const needsMap = request.goal.kind === 'dry_shore' || request.goal.kind === 'surface_target';
  if (needsMap) {
    if (request.map === undefined) {
      throw new Error(`${request.goal.kind} completion requires a VoxelMap for geometry confirmation`);
    }
    if (request.map.worldId !== request.scope.worldId) {
      throw new Error(
        `map worldId "${request.map.worldId}" does not match arrival scope worldId "${request.scope.worldId}"`,
      );
    }
  }

  const goal = cloneGoal(request.goal);
  const scope = { ...request.scope };
  const base = {
    goal,
    scope,
    computedAt: request.now,
  };

  if (request.samples.length > limits.maxSamples) {
    const detail = `sample set has ${request.samples.length} samples, exceeding maxSamples (${limits.maxSamples})`;
    return {
      ...base,
      status: 'UNCONFIRMED',
      reason: detail,
      problem: {
        kind: 'budget_exceeded',
        detail,
        limit: 'maxSamples',
        used: request.samples.length,
        max: limits.maxSamples,
      },
    };
  }

  let lastAccepted: WaterBodySample | null = null;
  let lastAcceptedIndex = -1;
  let stableSince: number | null = null;
  let stableSamples = 0;
  let lastBoatMeasurement: BoatMeasurement | null = null;
  let previousObservedAt: number | null = null;

  const evidenceValidUntil = (): number | undefined => {
    if (lastAccepted === null) return undefined;
    const earliest =
      goal.kind === 'boat_dock' && stableSince !== null ? stableSince : lastAccepted.observedAt;
    return earliest + request.maxSampleAgeMs;
  };

  for (let index = 0; index < request.samples.length; index++) {
    const sample = request.samples[index]!;
    const invalid = (problem: WaterArrivalProblem): WaterArrivalResult => ({
      ...base,
      status: 'UNCONFIRMED',
      reason: problem.detail,
      problem,
      ...(lastAccepted === null
        ? {}
        : { lastPosition: { ...lastAccepted.pos }, lastObservedAt: lastAccepted.observedAt }),
      ...(stableSince === null ? {} : { stableSince }),
      ...(goal.kind === 'boat_dock' ? { stableSamples } : {}),
      ...(goal.kind === 'boat_dock' && lastBoatMeasurement !== null
        ? {
            lastBoatPosition: { ...lastBoatMeasurement.pos },
            lastBoatObservedAt: lastBoatMeasurement.observedAt,
          }
        : {}),
      validUntil: evidenceValidUntil(),
    });

    if (!sampleFinite(sample)) {
      return invalid({ kind: 'invalid_sample', sampleIndex: index, detail: 'sample has a non-finite field' });
    }
    if (
      lastAccepted !== null &&
      (sample.sequence <= lastAccepted.sequence || sample.observedAt < lastAccepted.observedAt)
    ) {
      return invalid({
        kind: 'sample_order',
        sampleIndex: index,
        detail: 'sample sequence/time is replayed or out of order',
      });
    }
    if (
      sample.worldId !== scope.worldId ||
      sample.dim !== scope.dim ||
      sample.sessionId !== scope.sessionId
    ) {
      return invalid({
        kind: 'wrong_scope',
        sampleIndex: index,
        detail: 'sample world/dim/session does not match the arrival scope',
      });
    }
    if (sample.executionId !== scope.executionId) {
      return invalid({
        kind: 'wrong_execution',
        sampleIndex: index,
        detail: 'sample executionId does not match the arrival execution',
      });
    }
    if (request.now - sample.observedAt > request.maxSampleAgeMs) {
      return invalid({
        kind: 'stale',
        sampleIndex: index,
        observedAt: sample.observedAt,
        detail: 'sample is older than maxSampleAgeMs',
      });
    }
    if (sample.observedAt > request.now) {
      return invalid({
        kind: 'invalid_sample',
        sampleIndex: index,
        detail: 'sample observation time is later than the query time',
      });
    }
    if (!sample.alive || !sample.connected || !sample.observationReady) {
      return invalid({
        kind: 'unavailable',
        sampleIndex: index,
        detail: `alive=${sample.alive} connected=${sample.connected} observationReady=${sample.observationReady}`,
      });
    }
    if (sample.positionCorrected === true) {
      return invalid({
        kind: 'body_correction',
        sampleIndex: index,
        detail: 'the host applied a position correction around this sample',
      });
    }

    lastAccepted = sample;
    lastAcceptedIndex = index;

    if (goal.kind === 'boat_dock') {
      // A sparse receipt cannot prove the unobserved interval was stable. Break
      // the run at the caller-declared cadence boundary before starting a new one.
      if (
        previousObservedAt !== null &&
        sample.observedAt - previousObservedAt > goal.maxSampleGapMs
      ) {
        stableSince = null;
        stableSamples = 0;
      }
      const bound = dockBoatMeasurement(sample, scope);
      if (bound.kind === 'ok') lastBoatMeasurement = bound.measurement;
      const stable = stableDockSample(sample, goal, scope);
      if (!stable) {
        stableSince = null;
        stableSamples = 0;
      } else if (stableSince === null) {
        stableSince = sample.observedAt;
        stableSamples = 1;
      } else {
        stableSamples += 1;
      }
    }
    previousObservedAt = sample.observedAt;
  }

  if (lastAccepted === null) {
    return {
      ...base,
      status: 'UNCONFIRMED',
      reason: 'no measured body sample was provided',
      problem: { kind: 'no_evidence', detail: 'no measured body sample was provided' },
    };
  }

  const lastPosition = { ...lastAccepted.pos };
  const lastObservedAt = lastAccepted.observedAt;
  const sampleValidUntil = lastObservedAt + request.maxSampleAgeMs;
  const common = {
    ...base,
    lastPosition,
    lastObservedAt,
    ...(stableSince === null ? {} : { stableSince }),
    ...(goal.kind === 'boat_dock' ? { stableSamples } : {}),
    ...(goal.kind === 'boat_dock' && lastBoatMeasurement !== null
      ? {
          lastBoatPosition: { ...lastBoatMeasurement.pos },
          lastBoatObservedAt: lastBoatMeasurement.observedAt,
        }
      : {}),
  };

  const outsideTarget = (actual: Vec3Like, source: string): WaterArrivalResult => ({
    ...common,
    status: 'UNCONFIRMED',
    reason: `the measured ${source} position is outside the original target tolerances`,
    problem: {
      kind: 'outside_target',
      sampleIndex: lastAcceptedIndex,
      expected: { ...goal.target },
      actual: { ...actual },
      detail: `horizontal/vertical ${source} position does not satisfy the original goal`,
    },
    validUntil: evidenceValidUntil(),
  });

  if (goal.kind === 'surface_target') {
    if (!positionMatches(lastAccepted.pos, goal, goal.horizontalTolerance, goal.verticalTolerance)) {
      return outsideTarget(lastAccepted.pos, 'body');
    }
    if (!lastAccepted.inWater) {
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason: 'the measured position is at the surface target but the body is not in water',
        problem: {
          kind: 'not_in_water',
          sampleIndex: lastAcceptedIndex,
          detail: 'inWater=false; a surface target does not require dry land, but it does require water contact',
        },
        validUntil: sampleValidUntil,
      };
    }
    const surface = evaluateWaterRoute(
      request.map!,
      {
        worldId: scope.worldId,
        dim: scope.dim,
        sessionId: scope.sessionId,
        points: [{ ...lastAccepted.pos }, { ...lastAccepted.pos }],
        profile: goal.profile,
        solidShapeProvider: goal.solidShapeProvider,
        fluidShapeProvider: goal.fluidShapeProvider,
        limits: goal.geometryLimits,
      },
      request.now,
    );
    const dependencies = surface.dependencies.map((dep) => ({ key: { ...dep.key }, revision: dep.revision }));
    const combinedValidUntil = Math.min(sampleValidUntil, surface.validUntil);
    if (surface.status !== 'OPEN') {
      const reason = surface.reason ?? `surface geometry returned ${surface.status}`;
      if (surface.problem?.kind === 'budget_exceeded') {
        return {
          ...common,
          status: 'UNCONFIRMED',
          reason,
          problem: {
            kind: 'budget_exceeded',
            detail: surface.problem.detail,
            limit: surface.problem.limit,
            used: surface.problem.used,
            max: surface.problem.max,
          },
          surfaceGeometry: surface,
          dependencies,
          validUntil: combinedValidUntil,
        };
      }
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason,
        problem: {
          kind: 'surface_geometry',
          sampleIndex: lastAcceptedIndex,
          detail: `current-position surface geometry returned ${surface.status}`,
          evaluation: surface,
        },
        surfaceGeometry: surface,
        dependencies,
        validUntil: combinedValidUntil,
      };
    }
    return {
      ...common,
      status: 'ARRIVED',
      reason: `measured in-water position and current surface geometry satisfy ${fmt(goal.target)}`,
      surfaceGeometry: surface,
      dependencies,
      validUntil: combinedValidUntil,
    };
  }

  if (goal.kind === 'dry_shore') {
    if (!positionMatches(lastAccepted.pos, goal, goal.horizontalTolerance, goal.verticalTolerance)) {
      return outsideTarget(lastAccepted.pos, 'body');
    }
    if (!lastAccepted.onGround || lastAccepted.inWater) {
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason: 'the measured position is at the dry-shore target but is not dry/grounded',
        problem: {
          kind: 'not_dry_grounded',
          sampleIndex: lastAcceptedIndex,
          detail: `onGround=${lastAccepted.onGround} inWater=${lastAccepted.inWater}`,
        },
        validUntil: sampleValidUntil,
      };
    }
    const shore = evaluateBoundedShoreSupport(
      request.map!,
      scope,
      lastAccepted.pos,
      goal.body,
      goal.shapeProvider,
      request.now,
      goal.feetTolerance,
      limits,
    );
    if (shore.kind === 'budget') {
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason: shore.problem.detail,
        problem: shore.problem,
        validUntil: sampleValidUntil,
      };
    }
    if (shore.kind === 'unsupported_range') {
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason: shore.detail,
        problem: { kind: 'unsupported_range', detail: shore.detail },
        validUntil: sampleValidUntil,
      };
    }
    const support = shore.evaluation;
    const dependencies = support.dependencies.map((dep) => ({ key: { ...dep.key }, revision: dep.revision }));
    const combinedValidUntil = Math.min(sampleValidUntil, support.validUntil);
    if (support.status !== 'OPEN') {
      return {
        ...common,
        status: 'UNCONFIRMED',
        reason: `dry-shore support geometry is ${support.status}: ${support.reason ?? 'not OPEN'}`,
        problem: {
          kind: 'shore_support',
          sampleIndex: lastAcceptedIndex,
          detail: `stationary grounded check returned ${support.status}`,
          evaluation: support,
        },
        shoreSupport: support,
        dependencies,
        validUntil: combinedValidUntil,
      };
    }
    return {
      ...common,
      status: 'ARRIVED',
      reason: `measured dry/grounded position and geometry-confirmed support at ${fmt(goal.target)}`,
      shoreSupport: support,
      dependencies,
      validUntil: combinedValidUntil,
    };
  }

  // mounted-boat dock
  const dock = goal as BoatDockGoal;
  if (lastAccepted.boatId === undefined) {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the final measured sample does not carry an explicit mounted boat identity',
      problem: {
        kind: 'not_mounted',
        sampleIndex: lastAcceptedIndex,
        detail: 'boatId is absent; a display riding label is never treated as identity',
      },
      validUntil: evidenceValidUntil(),
    };
  }
  if (lastAccepted.boatId !== dock.boatId) {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the measured body mount identity does not match the dock goal',
      problem: {
        kind: 'boat_identity_mismatch',
        sampleIndex: lastAcceptedIndex,
        expected: dock.boatId,
        actual: lastAccepted.boatId,
        detail: 'the body is mounted on a different boat or was dismounted and moved',
      },
      validUntil: evidenceValidUntil(),
    };
  }
  const bound = dockBoatMeasurement(lastAccepted, scope);
  if (bound.kind === 'missing') {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the final measured sample has no same-receipt boat measurement',
      problem: {
        kind: 'boat_measurement_missing',
        sampleIndex: lastAcceptedIndex,
        detail: 'boat position/velocity were not measured for this receipt',
      },
      validUntil: evidenceValidUntil(),
    };
  }
  if (bound.kind === 'mismatch') {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the boat measurement is not bound to this sample receipt and scope',
      problem: {
        kind: 'boat_measurement',
        sampleIndex: lastAcceptedIndex,
        detail: bound.detail,
      },
      validUntil: evidenceValidUntil(),
    };
  }
  const boat = bound.measurement;
  if (boat.boatId !== dock.boatId) {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the measured boat entity identity does not match the dock goal',
      problem: {
        kind: 'boat_identity_mismatch',
        sampleIndex: lastAcceptedIndex,
        expected: dock.boatId,
        actual: boat.boatId,
        detail: 'the measured boat entity is not the dock goal boat',
      },
      validUntil: evidenceValidUntil(),
    };
  }
  if (!positionMatches(boat.pos, dock, dock.horizontalTolerance, dock.verticalTolerance)) {
    return outsideTarget(boat.pos, 'boat');
  }
  if (!velocityAtRest(boat.velocity, dock)) {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the measured boat speed is above the declared dock limits',
      problem: {
        kind: 'moving',
        sampleIndex: lastAcceptedIndex,
        detail: 'measured boat velocity exceeds maxHorizontalSpeed/maxVerticalSpeed',
      },
      validUntil: evidenceValidUntil(),
    };
  }
  const requiredSamples = dock.minStableSamples ?? 2;
  const stableMs = stableSince === null ? 0 : lastAccepted.observedAt - stableSince;
  if (stableSamples < requiredSamples || stableMs < dock.stableWindowMs) {
    return {
      ...common,
      status: 'UNCONFIRMED',
      reason: 'the ordered stable low-speed window is not satisfied',
      problem: {
        kind: 'insufficient_stable_window',
        sampleIndex: lastAcceptedIndex,
        detail: `${stableSamples} consecutive stable sample(s) spanning ${stableMs}ms`,
        stableMs,
        requiredMs: dock.stableWindowMs,
      },
      validUntil: evidenceValidUntil(),
    };
  }
  return {
    ...common,
    status: 'ARRIVED',
    reason: `measured docked boat ${dock.boatId} at ${fmt(dock.target)} after ${stableMs}ms stable`,
    validUntil: evidenceValidUntil(),
  };
}

type DockMeasurementBinding =
  | { kind: 'ok'; measurement: BoatMeasurement }
  | { kind: 'missing' }
  | { kind: 'mismatch'; detail: string };

function dockBoatMeasurement(sample: WaterBodySample, scope: WaterArrivalRequest['scope']): DockMeasurementBinding {
  const measurement = sample.boatMeasurement;
  if (measurement === undefined) return { kind: 'missing' };
  if (
    measurement.worldId !== scope.worldId ||
    measurement.dim !== scope.dim ||
    measurement.sessionId !== scope.sessionId
  ) {
    return { kind: 'mismatch', detail: 'boat measurement world/dim/session differs from the arrival scope' };
  }
  if (measurement.executionId !== scope.executionId) {
    return { kind: 'mismatch', detail: 'boat measurement executionId differs from the arrival execution' };
  }
  if (measurement.observedAt !== sample.observedAt || measurement.sequence !== sample.sequence) {
    return { kind: 'mismatch', detail: 'boat measurement is not bound to the same observation receipt' };
  }
  return { kind: 'ok', measurement };
}

function stableDockSample(sample: WaterBodySample, goal: BoatDockGoal, scope: WaterArrivalRequest['scope']): boolean {
  if (sample.boatId !== goal.boatId) return false;
  const bound = dockBoatMeasurement(sample, scope);
  if (bound.kind !== 'ok' || bound.measurement.boatId !== goal.boatId) return false;
  if (!positionMatches(bound.measurement.pos, goal, goal.horizontalTolerance, goal.verticalTolerance)) return false;
  return velocityAtRest(bound.measurement.velocity, goal);
}

function velocityAtRest(velocity: Vec3Like, goal: BoatDockGoal): boolean {
  return (
    Number.isFinite(velocity.x) &&
    Number.isFinite(velocity.y) &&
    Number.isFinite(velocity.z) &&
    Math.hypot(velocity.x, velocity.z) <= goal.maxHorizontalSpeed &&
    Math.abs(velocity.y) <= goal.maxVerticalSpeed
  );
}

function positionMatches(
  position: Vec3Like,
  goal: { target: Vec3Like },
  horizontalTolerance: number,
  verticalTolerance: number,
): boolean {
  return (
    Math.hypot(position.x - goal.target.x, position.z - goal.target.z) <= horizontalTolerance &&
    Math.abs(position.y - goal.target.y) <= verticalTolerance
  );
}

function sampleFinite(sample: WaterBodySample): boolean {
  const measurement = sample.boatMeasurement;
  return (
    Number.isFinite(sample.pos.x) &&
    Number.isFinite(sample.pos.y) &&
    Number.isFinite(sample.pos.z) &&
    Number.isFinite(sample.observedAt) &&
    Number.isFinite(sample.sequence) &&
    (sample.velocity === undefined ||
      (Number.isFinite(sample.velocity.x) &&
        Number.isFinite(sample.velocity.y) &&
        Number.isFinite(sample.velocity.z))) &&
    (measurement === undefined ||
      (Number.isFinite(measurement.pos.x) &&
        Number.isFinite(measurement.pos.y) &&
        Number.isFinite(measurement.pos.z) &&
        Number.isFinite(measurement.velocity.x) &&
        Number.isFinite(measurement.velocity.y) &&
        Number.isFinite(measurement.velocity.z) &&
        Number.isFinite(measurement.observedAt) &&
        Number.isFinite(measurement.sequence)))
  );
}

type ShoreSupportResult =
  | { kind: 'evaluation'; evaluation: StepEvaluation }
  | {
      kind: 'budget';
      problem: {
        kind: 'budget_exceeded';
        detail: string;
        limit: string;
        used: number;
        max: number;
      };
    }
  | { kind: 'unsupported_range'; detail: string };

/**
 * Bounded stationary dry-shore check. The existing grounded evaluator keeps its
 * shape semantics, but this wrapper preflights its candidate envelope and caps
 * provider resolutions, neighbour reads and total shape parts before the old
 * loops can traverse unbounded data.
 */
function evaluateBoundedShoreSupport(
  map: VoxelMap,
  scope: WaterArrivalRequest['scope'],
  feet: Vec3Like,
  body: { width: number; height: number },
  provider: CollisionShapeProvider,
  now: number,
  feetTolerance: number,
  limits: WaterArrivalLimits,
): ShoreSupportResult {
  const half = body.width / 2;
  const xMin = Math.floor(feet.x - half + EPS);
  const xMax = Math.floor(feet.x + half - EPS);
  const zMin = Math.floor(feet.z - half + EPS);
  const zMax = Math.floor(feet.z + half - EPS);
  const yMin = Math.floor(feet.y - feetTolerance - EPS);
  const yMax = Math.max(
    Math.floor(feet.y + body.height - EPS),
    Math.floor(feet.y + feetTolerance - EPS),
  );
  if (![xMin, xMax, zMin, zMax, yMin, yMax].every(isSafeEnumeratedBound)) {
    return {
      kind: 'unsupported_range',
      detail: 'stationary shore envelope bounds are outside the safely enumerable integer range',
    };
  }
  const count = (xMax - xMin + 1) * (yMax - yMin + 1) * (zMax - zMin + 1);
  if (!Number.isFinite(count) || count < 0) {
    return {
      kind: 'unsupported_range',
      detail: 'stationary shore envelope cell count is not a finite non-negative number',
    };
  }
  if (count > limits.maxShoreCells) {
    return {
      kind: 'budget',
      problem: {
        kind: 'budget_exceeded',
        detail: `stationary shore envelope has ${count} candidate cells, exceeding maxShoreCells (${limits.maxShoreCells})`,
        limit: 'maxShoreCells',
        used: count,
        max: limits.maxShoreCells,
      },
    };
  }

  let resolutions = 0;
  let shapeParts = 0;
  let neighborReads = 0;
  const budgetState: {
    value: { limit: string; used: number; max: number; detail: string } | null;
  } = { value: null };
  const fail = (limit: string, used: number, max: number, detail: string): void => {
    if (budgetState.value === null) budgetState.value = { limit, used, max, detail };
  };

  const boundedProvider: CollisionShapeProvider = {
    version: provider.version,
    resolve(state, cell, read) {
      if (budgetState.value !== null) throw SHORE_BUDGET_EXCEEDED;
      resolutions += 1;
      if (resolutions > limits.maxShoreShapeResolutions) {
        fail(
          'maxShoreShapeResolutions',
          resolutions,
          limits.maxShoreShapeResolutions,
          `shore shape resolutions exceeded maxShoreShapeResolutions (${limits.maxShoreShapeResolutions})`,
        );
        throw SHORE_BUDGET_EXCEEDED;
      }
      const boundedRead: NeighborRead = {
        cell(x, y, z) {
          if (budgetState.value !== null) throw SHORE_BUDGET_EXCEEDED;
          neighborReads += 1;
          if (neighborReads > limits.maxShoreNeighborReads) {
            fail(
              'maxShoreNeighborReads',
              neighborReads,
              limits.maxShoreNeighborReads,
              `shore neighbour reads exceeded maxShoreNeighborReads (${limits.maxShoreNeighborReads})`,
            );
            throw SHORE_BUDGET_EXCEEDED;
          }
          return read.cell(x, y, z);
        },
      };
      const resolution = provider.resolve(state, cell, boundedRead);
      if (resolution.kind === 'shape') {
        const parts = resolution.shape.boxes.length + resolution.shape.supportFaces.length;
        if (!Number.isSafeInteger(parts) || shapeParts + parts > limits.maxShoreShapeParts) {
          fail(
            'maxShoreShapeParts',
            shapeParts + parts,
            limits.maxShoreShapeParts,
            `shore shape parts exceeded maxShoreShapeParts (${limits.maxShoreShapeParts})`,
          );
          throw SHORE_BUDGET_EXCEEDED;
        }
        shapeParts += parts;
      }
      return resolution;
    },
  };

  try {
    const evaluation = evaluateGroundedWalkSegment(
      map,
      {
        worldId: scope.worldId,
        dim: scope.dim,
        sessionId: scope.sessionId,
        mode: 'walk',
        body: {
          feet: { ...feet },
          width: body.width,
          height: body.height,
          pose: 'standing',
        },
        direction: { axis: 'x', sign: 1 },
      },
      { ...feet },
      boundedProvider,
      now,
      feetTolerance,
    );
    if (budgetState.value !== null) {
      return {
        kind: 'budget',
        problem: {
          kind: 'budget_exceeded',
          detail: budgetState.value.detail,
          limit: budgetState.value.limit,
          used: budgetState.value.used,
          max: budgetState.value.max,
        },
      };
    }
    return { kind: 'evaluation', evaluation };
  } catch (error) {
    if (error !== SHORE_BUDGET_EXCEEDED) throw error;
    if (budgetState.value === null) {
      throw new Error('shore budget sentinel escaped without a recorded budget');
    }
    return {
      kind: 'budget',
      problem: {
        kind: 'budget_exceeded',
        detail: budgetState.value.detail,
        limit: budgetState.value.limit,
        used: budgetState.value.used,
        max: budgetState.value.max,
      },
    };
  }
}

function validateGoal(goal: WaterArrivalGoal): void {
  assertFinite(goal.target.x, 'goal.target.x');
  assertFinite(goal.target.y, 'goal.target.y');
  assertFinite(goal.target.z, 'goal.target.z');
  assertFinite(goal.horizontalTolerance, 'goal.horizontalTolerance');
  assertFinite(goal.verticalTolerance, 'goal.verticalTolerance');
  if (goal.horizontalTolerance <= 0) {
    throw new Error(`goal.horizontalTolerance must be positive: ${goal.horizontalTolerance}`);
  }
  if (goal.verticalTolerance < 0) {
    throw new Error(`goal.verticalTolerance must not be negative: ${goal.verticalTolerance}`);
  }
  if (goal.kind === 'surface_target') {
    if (goal.profile.kind !== 'surface_swim') {
      throw new Error('surface_target requires a surface_swim profile');
    }
    return;
  }
  if (goal.kind === 'dry_shore') {
    assertPositive(goal.body.width, 'goal.body.width');
    assertPositive(goal.body.height, 'goal.body.height');
    assertFinite(goal.feetTolerance, 'goal.feetTolerance');
    if (goal.feetTolerance < 0 || goal.feetTolerance >= 0.5) {
      throw new Error(`goal.feetTolerance must be in [0, 0.5): ${goal.feetTolerance}`);
    }
    return;
  }
  if (goal.kind === 'boat_dock') {
    if (typeof goal.boatId !== 'string' || goal.boatId.length === 0) {
      throw new Error('goal.boatId must be a non-empty stable identity string');
    }
    assertFinite(goal.stableWindowMs, 'goal.stableWindowMs');
    assertFinite(goal.maxSampleGapMs, 'goal.maxSampleGapMs');
    assertFinite(goal.maxHorizontalSpeed, 'goal.maxHorizontalSpeed');
    assertFinite(goal.maxVerticalSpeed, 'goal.maxVerticalSpeed');
    if (goal.stableWindowMs <= 0) {
      throw new Error(`goal.stableWindowMs must be positive: ${goal.stableWindowMs}`);
    }
    if (goal.maxSampleGapMs <= 0) {
      throw new Error(`goal.maxSampleGapMs must be positive: ${goal.maxSampleGapMs}`);
    }
    if (goal.maxHorizontalSpeed < 0 || goal.maxVerticalSpeed < 0) {
      throw new Error('goal speed limits must not be negative');
    }
    if (goal.minStableSamples !== undefined && (!Number.isSafeInteger(goal.minStableSamples) || goal.minStableSamples < 2)) {
      throw new Error(`goal.minStableSamples must be an integer ≥ 2: ${goal.minStableSamples}`);
    }
  }
}

function cloneGoal(goal: WaterArrivalGoal): WaterArrivalGoal {
  if (goal.kind === 'surface_target') {
    return {
      ...goal,
      target: { ...goal.target },
      profile: {
        ...goal.profile,
        orientation: { ...goal.profile.orientation },
        body: { ...goal.profile.body },
        breathing: { ...goal.profile.breathing },
        surfaceBand: { ...goal.profile.surfaceBand },
      },
    };
  }
  if (goal.kind === 'dry_shore') {
    return {
      ...goal,
      target: { ...goal.target },
      body: { ...goal.body },
    };
  }
  return { ...goal, target: { ...goal.target } };
}

function fmt(p: Vec3Like): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

// `Observation` is imported for the obstacle clone helper below; keep the type
// surface explicit rather than relying on structural inference at call sites.
function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { ...observation.pos },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}
