/**
 * Bounded land-route *geometry* validation.
 *
 * This module answers a deliberately narrow question for one explicitly typed
 * transition between two exact feet positions: does the declared continuous
 * corridor/trajectory, plus the required support/contact, currently have
 * complete and current evidence?
 *
 * It does **not** prove physical reachability, Minecraft dynamics, body
 * capability, authorization, existing executor support, actual movement or
 * arrival. Every result therefore carries `assurance: 'geometry_only'` and
 * `executable: false`.
 *
 * Supported geometric subsets and their canonical corridors:
 *
 * - `step`: one-axis horizontal move of one block with a positive rise of at
 *   most one block. Lift vertically at the original XZ, then translate at the
 *   target foot height. Both legs must be continuously collision-free; start
 *   and destination must be standable.
 * - `drop`: one-axis horizontal move of one block to a lower target column.
 *   Translate horizontally at the original foot height, then descend at the
 *   exact target XZ. Start and selected landing must be standable.
 * - `jump`: one-axis same-height horizontal traverse with an explicit,
 *   versioned `LandMotionModel` that returns a quadratic arc. The whole body
 *   AABB is swept analytically (no sampled waypoints). Start and landing
 *   support are required; no support is required or assumed in the air.
 * - `ladder`: fixed-XZ vertical travel covered continuously by an explicit,
 *   versioned `ClimbRegionProvider` plus continuous body collision clearance.
 *   Source cells are every cell touched by the continuously swept body, not only
 *   cells in the feet-travel interval; the provider asserts the permitted world
 *   feet regions under current evidence.
 *
 * Evidence is read only through `VoxelMap` snapshots and the controlled
 * `NeighborRead` passed to providers. Every read records its Section revision,
 * residency and generation, and its minimum evidence validity. Missing, stale,
 * expired, foreign-session, incomplete and committed-but-non-resident evidence
 * are kept distinct; none of them can produce `OPEN`.
 */

import type { CellEvidence, Observation } from '../observation/types.js';
import type { BlockState, Vec3Like } from '../types.js';
import { blockToSection, cellIndex } from '../voxel/coordinates.js';
import type { SectionKey } from '../voxel/section.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionResidency } from '../voxel/residency.js';
import type { SectionRef, VoxelMap } from '../voxel/voxel-map.js';
import type {
  CollisionShape,
  CollisionShapeProvider,
  NeighborCellView,
  NeighborRead,
  UnitBox,
} from './collision-shape.js';
import {
  LAND_EPS,
  bodyAabb,
  cellsInAabbBounded,
  jumpEnvelope,
  jumpHitsBox,
  rectsOverlapPositive,
  segmentHitsBox,
  supportCandidateCells,
  uncoveredIntervals,
  unionAabb,
} from './land-geometry.js';
import type { BoundedCells } from './land-geometry.js';
import type { BodyContext } from './step.js';
import type { HazardFact, ObstacleEvidence } from './types.js';

/** The four passage states plus the capability gap and unfinished work. */
export type LandTransitionStatus = 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED' | 'INCOMPLETE';

/** The explicitly declared geometric transition kinds. Kind is never inferred from coordinates. */
export type LandTransitionKind = 'step' | 'drop' | 'jump' | 'ladder';

/**
 * One explicitly typed transition between exact, continuous feet positions.
 * Coordinates are never rounded, snapped or re-derived from a polyline.
 */
export interface LandTransition {
  kind: LandTransitionKind;
  from: Vec3Like;
  to: Vec3Like;
}

/** One transition plus the fixed body and evidence scope under which it is evaluated. */
export interface LandTransitionQuery {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Fixed width/height/standing pose; `feet` must exactly equal `transition.from`. */
  body: BodyContext;
  transition: LandTransition;
}

/** Input passed to an explicit jump motion model. */
export interface LandMotionInput {
  from: Vec3Like;
  to: Vec3Like;
  body: BodyContext;
}

/**
 * The only shape this increment accepts as a jump proof: a continuous quadratic
 * feet arc `y(t) = y0 + 4·apexHeight·t·(1−t)` with linear X/Z interpolation.
 * A list of sampled waypoints is not a supported trajectory representation.
 */
export interface LandJumpTrajectory {
  /** Positive, finite apex height above the common foot height. */
  apexHeight: number;
}

export type LandMotionResolution =
  | { kind: 'supported'; trajectory: LandJumpTrajectory }
  | { kind: 'unsupported'; detail: string };

/**
 * Explicit, versioned jump motion model. This library ships no Minecraft motion
 * model and does not validate body capability; a test provider is a geometric
 * curve only. The version participates in the route proof identity.
 */
export interface LandMotionModel {
  version: string;
  resolve(input: LandMotionInput): LandMotionResolution;
}

/** Input passed to an explicit climb-region provider for one observed block cell. */
export interface ClimbCellInput {
  cell: Vec3Like;
  /** Complete observed state of `cell`; the evaluator never supplies an inferred name. */
  state: BlockState;
  /** Fixed body width/height/standing pose; providers must not use body-independent regions. */
  body: BodyContext;
}

/** A provider-asserted continuous world-Y feet interval for this body at this source cell. */
export interface ClimbRegion {
  minFeetY: number;
  maxFeetY: number;
}

export type ClimbRegionResolution =
  | { kind: 'regions'; regions: readonly ClimbRegion[] }
  | { kind: 'unsupported'; detail: string };

/**
 * Explicit, versioned climb-region provider. It resolves complete state + cell +
 * body through controlled neighbor reads into permitted feet regions. The
 * evaluator never infers a ladder from a block name, empty collision or
 * proximity. The version participates in the route proof identity.
 */
export interface ClimbRegionProvider {
  version: string;
  resolve(input: ClimbCellInput, read: NeighborRead): ClimbRegionResolution;
}

/** Injected, versioned evidence/model rules. No host globals are imported. */
export interface LandRules {
  shapeProvider: CollisionShapeProvider;
  /** Required for `jump`; missing means UNSUPPORTED even in empty space. */
  jumpModel?: LandMotionModel;
  /** Required for `ladder`; missing means UNSUPPORTED. */
  climbProvider?: ClimbRegionProvider;
}

/**
 * Hard finite implementation limits. They bound synchronous allocations and
 * work, not game capability. Exceeding one is an explicit range/budget result,
 * never a terrain BLOCKED conclusion.
 */
export interface LandLimits {
  /** Maximum transitions in one registered route. */
  maxTransitions: number;
  /** Maximum candidate cells in one sweep/climb scan. */
  maxCandidateCells: number;
  /** Maximum controlled provider neighbor reads in one evaluation. */
  maxNeighborReads: number;
  /** Maximum collision/support box count examined in one evaluation. */
  maxShapeBoxes: number;
  /** Maximum support-face count examined in one evaluation. */
  maxSupportFaces: number;
  /** Maximum climb regions accepted from providers in one evaluation. */
  maxClimbRegions: number;
  /** Maximum same-height horizontal distance accepted for a jump, in blocks. */
  maxJumpDistance: number;
  /** Maximum synchronous work units in one evaluation. */
  maxWork: number;
}

export const DEFAULT_LAND_LIMITS: LandLimits = {
  maxTransitions: 1024,
  maxCandidateCells: 8192,
  maxNeighborReads: 16384,
  maxShapeBoxes: 4096,
  maxSupportFaces: 2048,
  maxClimbRegions: 4096,
  maxJumpDistance: 4,
  maxWork: 65536,
};

/** Resolve optional limits with validated finite, positive defaults. */
export function resolveLandLimits(partial: Partial<LandLimits> = {}): LandLimits {
  const limits: LandLimits = { ...DEFAULT_LAND_LIMITS };
  for (const key of Object.keys(partial) as (keyof LandLimits)[]) {
    const value = partial[key];
    if (value !== undefined) limits[key] = value;
  }
  assertLandLimits(limits);
  return limits;
}

/** One Section actually consulted while evaluating a transition. */
export interface LandSectionDependency {
  key: SectionKey;
  /** Live Section revision at read time; 0 for a section with no resident payload. */
  revision: number;
  /** Residency state observed at read time. */
  residency: SectionResidency;
  /** Residency generation at read time (unload/reload changes it without a revision bump). */
  generation: number;
  /** Minimum `validUntil` over still-valid evidence read in this Section; Infinity when none. */
  validUntil: number;
}

/** Work actually consumed by one evaluation, with an explicit lower bound when budget ran out. */
export interface LandWorkReport {
  used: number;
  limit: number;
  /** Minimum work a complete evaluation of this transition needs from scratch; a lower bound. */
  requiredAtLeast: number;
  /** True only when the per-evaluation work budget stopped the evaluation. */
  exhausted: boolean;
}

export type LandTransitionReasonKind =
  | 'collision'
  | 'missing_support'
  | 'missing_climb_contact'
  | 'unobserved'
  | 'incomplete_evidence'
  | 'nonresident'
  | 'stale'
  | 'expired'
  | 'wrong_session'
  | 'unsupported_shape'
  | 'unsupported_model'
  | 'unsupported_provider'
  | 'unsupported_range'
  | 'capacity'
  | 'budget';

/** Configured implementation limits that can stop otherwise-complete work. */
export type LandLimitField =
  | 'maxCandidateCells'
  | 'maxNeighborReads'
  | 'maxShapeBoxes'
  | 'maxSupportFaces'
  | 'maxClimbRegions';

/**
 * Structured capacity shortfall: a configured limit, not a terrain fact. The
 * transition is INCOMPLETE; raising the named limit (or recreating the verifier
 * with a larger one) allows a later complete evaluation.
 */
export interface LandLimitGap {
  field: LandLimitField;
  /** Configured value that stopped complete evaluation. */
  value: number;
  /** Lower bound on a larger configured value that would allow completion, when known. */
  requiredAtLeast?: number;
  detail: string;
}

/** Structured explanation for a non-OPEN conclusion. */
export interface LandTransitionReason {
  kind: LandTransitionReasonKind;
  detail: string;
  /** Cells relevant to this reason; empty when the reason is not cell-scoped. */
  cells: Vec3Like[];
}

/** Complete read-only geometry verdict for one declared transition. */
export interface LandTransitionEvaluation {
  status: LandTransitionStatus;
  /** Always `geometry_only`: this is never an execution or arrival guarantee. */
  assurance: 'geometry_only';
  /** Always false: no executor support or body capability is asserted here. */
  executable: false;
  kind: LandTransitionKind;
  from: Vec3Like;
  to: Vec3Like;
  /** Primary reason when `status !== 'OPEN'`. */
  reason?: LandTransitionReason;
  /** Every structured problem found; may contain several evidence categories. */
  reasons: LandTransitionReason[];
  /** Confirmed obstacles from accepted observations (never unseen names). */
  obstacles: ObstacleEvidence[];
  /** Objective hazards such as the actual declared drop height; never a veto policy. */
  hazards: HazardFact[];
  /** Sections actually consulted, with revision/residency/generation/validity. */
  dependencies: LandSectionDependency[];
  /** Assumed jump model identity, when a model was used. */
  model?: { kind: 'jump'; version: string };
  /** Assumed climb provider identity, when a provider was used. */
  provider?: { kind: 'climb'; version: string };
  /** Configured capacity shortfall when `status` is INCOMPLETE for that reason. */
  limitGap?: LandLimitGap;
  sessionId: string;
  computedAt: number;
  /** min validUntil over dependencies with still-valid evidence; Infinity when none. */
  validUntil: number;
  work: LandWorkReport;
}

type LandCellRead =
  | { kind: 'observed'; evidence: CellEvidence }
  | { kind: 'unobserved'; key: SectionKey }
  | { kind: 'nonresident'; key: SectionKey }
  | { kind: 'incomplete'; key: SectionKey }
  | { kind: 'stale'; reason: 'stale' | 'expired' | 'session'; key: SectionKey };

type ShapeResult =
  | { kind: 'shape'; shape: CollisionShape }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'gap'; view: NeighborCellView };

class LandBudgetExhausted extends Error {}
class LandRangeLimitError extends Error {}
class LandCapacityIncomplete extends Error {}

/** Full unit cell; used to ask whether the body actually occupies a candidate cell. */
const FULL_CELL: UnitBox = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };

/**
 * Evaluate one explicitly typed land transition from current map evidence.
 *
 * Pure with respect to the map: it reads Section snapshots and never writes,
 * loads, scans, refreshes evidence, moves the body, digs, places or executes.
 * Invalid boundary inputs throw; geometric ranges outside this increment's
 * supported subsets return `UNSUPPORTED` (`unsupported_range`).
 */
export function evaluateLandTransition(
  map: VoxelMap,
  query: LandTransitionQuery,
  rules: LandRules,
  now: number,
  limits: LandLimits,
): LandTransitionEvaluation {
  return evaluateLandGeometry(map, query, rules, now, limits, false);
}

/** Historical geometry has no current passage status or execution guarantee. */
export interface RememberedLandGeometry {
  geometry: 'PASSABLE' | 'OBSTRUCTED' | 'UNKNOWN' | 'UNSUPPORTED' | 'INCOMPLETE';
  assurance: 'historical_geometry';
  executable: false;
  from: Vec3Like;
  to: Vec3Like;
  reason?: LandTransitionReason;
  hazards: HazardFact[];
  obstacles: ObstacleEvidence[];
  dependencies: LandSectionDependency[];
  work: LandWorkReport;
  limitGap?: LandLimitGap;
}

/** Internal planning boundary; source observations, sessions and times stay intact. */
export function evaluateRememberedLandTransition(
  map: VoxelMap,
  query: LandTransitionQuery,
  rules: LandRules,
  now: number,
  limits: LandLimits,
): RememberedLandGeometry {
  const result = evaluateLandGeometry(map, query, rules, now, limits, true);
  return {
    geometry: result.status === 'OPEN' ? 'PASSABLE'
      : result.status === 'BLOCKED' ? 'OBSTRUCTED'
      : result.status === 'STALE' ? 'UNKNOWN' : result.status,
    assurance: 'historical_geometry',
    executable: false,
    from: result.from,
    to: result.to,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    hazards: result.hazards,
    obstacles: result.obstacles,
    dependencies: result.dependencies,
    work: result.work,
    ...(result.limitGap === undefined ? {} : { limitGap: result.limitGap }),
  };
}

function evaluateLandGeometry(
  map: VoxelMap,
  query: LandTransitionQuery,
  rules: LandRules,
  now: number,
  limits: LandLimits,
  remembered: boolean,
): LandTransitionEvaluation {
  if (query.worldId !== map.worldId) {
    throw new Error(`query worldId "${query.worldId}" does not match map worldId "${map.worldId}"`);
  }
  if (query.dim.length === 0) throw new Error('query dim must be a non-empty string');
  if (query.sessionId.length === 0) throw new Error('query sessionId must be a non-empty string');
  if (!Number.isFinite(now)) throw new Error(`now must be a finite number: ${now}`);
  assertLandLimits(limits);
  assertBody(query.body);
  assertTransition(query.transition);
  if (
    query.body.feet.x !== query.transition.from.x ||
    query.body.feet.y !== query.transition.from.y ||
    query.body.feet.z !== query.transition.from.z
  ) {
    throw new Error(
      `body.feet (${query.body.feet.x}, ${query.body.feet.y}, ${query.body.feet.z}) must exactly equal transition.from (${query.transition.from.x}, ${query.transition.from.y}, ${query.transition.from.z})`,
    );
  }
  assertVersion(rules.shapeProvider.version, 'shapeProvider.version');
  if (rules.jumpModel !== undefined) assertVersion(rules.jumpModel.version, 'jumpModel.version');
  if (rules.climbProvider !== undefined) assertVersion(rules.climbProvider.version, 'climbProvider.version');

  const { transition, body, dim, sessionId } = query;
  const { from, to } = transition;
  const half = body.width / 2;
  const height = body.height;

  const deps = new Map<string, LandSectionDependency>();
  const sectionCache = new Map<string, SectionRef | null>();
  const residencyCache = new Map<string, SectionResidency>();

  const unobserved = new Map<string, Vec3Like>();
  const incomplete = new Map<string, Vec3Like>();
  const nonresident = new Map<string, { cell: Vec3Like; key: SectionKey }>();
  const stale = new Map<string, Vec3Like>();
  const expired = new Map<string, Vec3Like>();
  const session = new Map<string, Vec3Like>();
  const missingSupport = new Map<string, Vec3Like>();
  const missingClimb = new Map<string, Vec3Like>();
  const unsupportedShape: Array<{ cell: Vec3Like; detail: string }> = [];
  const unsupportedModel: string[] = [];
  const unsupportedProvider: string[] = [];
  const unsupportedRange: string[] = [];
  const collisions: Array<{ cell: Vec3Like; observation: Observation }> = [];

  let workUsed = 0;
  let minimumRequired = 1;
  let budgetExhausted = false;
  let limitGap: LandLimitGap | undefined;
  let shapeBoxCount = 0;
  let supportFaceCount = 0;
  let climbRegionCount = 0;
  let neighborReads = 0;
  let modelIdentity: LandTransitionEvaluation['model'];
  let climbIdentity: LandTransitionEvaluation['provider'];
  const hazards: HazardFact[] = [];

  const charge = (units = 1): void => {
    if (workUsed + units > limits.maxWork) {
      budgetExhausted = true;
      throw new LandBudgetExhausted();
    }
    workUsed += units;
  };

  /** Record the first configured-capacity shortfall and stop this evaluation. */
  const noteCapacity = (
    field: LandLimitField,
    value: number,
    requiredAtLeast: number | undefined,
    detail: string,
  ): never => {
    if (limitGap === undefined) {
      limitGap = { field, value, ...(requiredAtLeast === undefined ? {} : { requiredAtLeast }), detail };
    }
    throw new LandCapacityIncomplete();
  };

  const keyOf = (cell: Vec3Like): string => `${cell.x},${cell.y},${cell.z}`;
  const addCell = (map: Map<string, Vec3Like>, cell: Vec3Like): void => {
    const key = keyOf(cell);
    if (!map.get(key)) map.set(key, { x: cell.x, y: cell.y, z: cell.z });
  };

  /**
   * Evidence-gap destination. Collision/corridor reads write to the global
   * collections; support-only provider calls are buffered per candidate so an
   * optional candidate cannot poison a transition whose required support is
   * already proven, and a candidate cannot prove support while hiding its own
   * consulted gap. Section dependencies and TTLs are recorded globally either way.
   */
  interface GapSink {
    unobserved: Map<string, Vec3Like>;
    incomplete: Map<string, Vec3Like>;
    nonresident: Map<string, { cell: Vec3Like; key: SectionKey }>;
    stale: Map<string, Vec3Like>;
    expired: Map<string, Vec3Like>;
    session: Map<string, Vec3Like>;
  }
  const makeGapSink = (): GapSink => ({
    unobserved: new Map(),
    incomplete: new Map(),
    nonresident: new Map(),
    stale: new Map(),
    expired: new Map(),
    session: new Map(),
  });
  const globalGaps: GapSink = { unobserved, incomplete, nonresident, stale, expired, session };
  let activeGaps: GapSink = globalGaps;
  const gapSinkHasGaps = (sink: GapSink): boolean =>
    sink.unobserved.size > 0 ||
    sink.incomplete.size > 0 ||
    sink.nonresident.size > 0 ||
    sink.stale.size > 0 ||
    sink.expired.size > 0 ||
    sink.session.size > 0;
  const mergeGapSinkInto = (target: GapSink, source: GapSink): void => {
    for (const cell of source.unobserved.values()) addCell(target.unobserved, cell);
    for (const cell of source.incomplete.values()) addCell(target.incomplete, cell);
    for (const [key, entry] of source.nonresident) target.nonresident.set(key, entry);
    for (const cell of source.stale.values()) addCell(target.stale, cell);
    for (const cell of source.expired.values()) addCell(target.expired, cell);
    for (const cell of source.session.values()) addCell(target.session, cell);
  };
  const mergeGapSink = (sink: GapSink): void => mergeGapSinkInto(globalGaps, sink);

  const recordDependency = (
    key: SectionKey,
    revision: number,
    residency: SectionResidency,
    generation: number,
  ): LandSectionDependency => {
    const ks = sectionKeyString(key);
    let dep = deps.get(ks);
    if (dep === undefined) {
      dep = {
        key: { ...key },
        revision,
        residency,
        generation,
        validUntil: Number.POSITIVE_INFINITY,
      };
      deps.set(ks, dep);
    }
    return dep;
  };

  const noteRead = (read: LandCellRead, cell: Vec3Like): void => {
    switch (read.kind) {
      case 'unobserved':
        addCell(activeGaps.unobserved, cell);
        break;
      case 'incomplete':
        addCell(activeGaps.incomplete, cell);
        break;
      case 'nonresident':
        activeGaps.nonresident.set(keyOf(cell), { cell: { ...cell }, key: { ...read.key } });
        break;
      case 'stale':
        if (read.reason === 'stale') addCell(activeGaps.stale, cell);
        else if (read.reason === 'expired') addCell(activeGaps.expired, cell);
        else addCell(activeGaps.session, cell);
        break;
      case 'observed':
        break;
    }
  };

  const readCell = (x: number, y: number, z: number): LandCellRead => {
    charge(1);
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const key: SectionKey = { worldId: query.worldId, dim, cx, cz, sy };
    const ks = sectionKeyString(key);
    let section = sectionCache.get(ks);
    if (section === undefined) {
      section = map.sectionRef(dim, x, y, z);
      sectionCache.set(ks, section);
    }
    if (section === null) {
      let residency = residencyCache.get(ks);
      if (residency === undefined) {
        residency = map.sectionResidency(key).residency;
        residencyCache.set(ks, residency);
      }
      const generation = map.residencyGeneration(dim, cx, cz, sy);
      recordDependency(key, 0, residency, generation);
      return residency === 'not_resident' || residency === 'loading' || residency === 'load_failed'
        ? { kind: 'nonresident', key }
        : { kind: 'unobserved', key };
    }

    const generation = map.residencyGeneration(dim, cx, cz, sy);
    const dep = recordDependency(key, section.revision, 'resident', generation);
    const evidence = section.evidence.get(cellIndex(lx, ly, lz));
    if (evidence === undefined) return { kind: 'unobserved', key };
    if (!remembered && evidence.freshness === 'STALE') return { kind: 'stale', reason: 'stale', key };
    if (!remembered && evidence.observation.sessionId !== sessionId) return { kind: 'stale', reason: 'session', key };
    if (!remembered && now > evidence.validUntil) return { kind: 'stale', reason: 'expired', key };
    dep.validUntil = Math.min(dep.validUntil, evidence.validUntil);
    if (!evidence.observation.stateComplete) return { kind: 'incomplete', key };
    // The live SectionRef is not copied. Copy the evidence/observation that
    // leaves this evaluation so a caller/provider cannot mutate the store and
    // cannot retain a live view across a write.
    return { kind: 'observed', evidence: { ...evidence, observation: cloneObservation(evidence.observation) } };
  };

  const noteGap = (view: NeighborCellView): void => {
    switch (view.kind) {
      case 'unobserved':
        addCell(activeGaps.unobserved, view.pos);
        break;
      case 'incomplete':
        addCell(activeGaps.incomplete, view.pos);
        break;
      case 'stale':
        if (view.reason === 'stale') addCell(activeGaps.stale, view.pos);
        else if (view.reason === 'expired') addCell(activeGaps.expired, view.pos);
        else addCell(activeGaps.session, view.pos);
        break;
      case 'observed':
        break;
    }
  };

  const neighborRead: NeighborRead = {
    cell(x, y, z) {
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) {
        throw new Error(`neighbor read coordinates must be safely representable integers: (${x}, ${y}, ${z})`);
      }
      if (neighborReads >= limits.maxNeighborReads) {
        noteCapacity(
          'maxNeighborReads',
          limits.maxNeighborReads,
          neighborReads + 1,
          `controlled neighbor reads exceed maxNeighborReads (${limits.maxNeighborReads})`,
        );
      }
      neighborReads += 1;
      const pos = { x, y, z };
      const read = readCell(x, y, z);
      switch (read.kind) {
        case 'observed':
          return { pos, kind: 'observed', state: read.evidence.observation.state };
        case 'unobserved':
          noteRead(read, pos);
          return { pos, kind: 'unobserved' };
        case 'nonresident':
          noteRead(read, pos);
          return { pos, kind: 'unobserved' };
        case 'incomplete':
          noteRead(read, pos);
          return { pos, kind: 'incomplete' };
        case 'stale':
          noteRead(read, pos);
          return { pos, kind: 'stale', reason: read.reason };
      }
    },
  };

  const resolveShape = (state: BlockState, cell: Vec3Like): ShapeResult => {
    charge(1);
    const resolution = rules.shapeProvider.resolve(state, cell, neighborRead);
    if (resolution.kind === 'unsupported_shape') {
      return { kind: 'unsupported', detail: resolution.detail };
    }
    if (resolution.kind === 'neighbor_gap') {
      noteGap(resolution.view);
      return { kind: 'gap', view: resolution.view };
    }
    const shape = resolution.shape as CollisionShape | undefined;
    if (
      shape === null ||
      typeof shape !== 'object' ||
      !Array.isArray(shape.boxes) ||
      !Array.isArray(shape.supportFaces)
    ) {
      return { kind: 'unsupported', detail: 'shape provider returned a malformed CollisionShape' };
    }
    shapeBoxCount += shape.boxes.length;
    supportFaceCount += shape.supportFaces.length;
    if (shapeBoxCount > limits.maxShapeBoxes) {
      noteCapacity(
        'maxShapeBoxes',
        limits.maxShapeBoxes,
        shapeBoxCount,
        `provider shape boxes exceed maxShapeBoxes (${limits.maxShapeBoxes})`,
      );
    }
    if (supportFaceCount > limits.maxSupportFaces) {
      noteCapacity(
        'maxSupportFaces',
        limits.maxSupportFaces,
        supportFaceCount,
        `provider support faces exceed maxSupportFaces (${limits.maxSupportFaces})`,
      );
    }
    return { kind: 'shape', shape };
  };

  /** Exact count before allocation; the work budget is charged before any array exists. */
  const countAndChargeCells = (total: number): void => {
    minimumRequired = Math.max(minimumRequired, workUsed + total);
    charge(total);
  };

  const boundedCells = (bounded: BoundedCells, label: string): Vec3Like[] => {
    switch (bounded.kind) {
      case 'numeric':
        // Coordinates outside exact integer representation are not a configurable
        // capacity: no budget or limit increase can make the geometry evaluable.
        throw new LandRangeLimitError(`${label}: ${bounded.detail}`);
      case 'capacity':
        return noteCapacity(
          'maxCandidateCells',
          limits.maxCandidateCells,
          bounded.total,
          `${label} exceed maxCandidateCells (${limits.maxCandidateCells})`,
        );
      case 'ok':
        minimumRequired = Math.max(minimumRequired, bounded.total);
        return bounded.cells;
    }
  };

  const scanCollision = (
    cells: readonly Vec3Like[],
    hits: (cell: Vec3Like, box: UnitBox) => boolean,
    occupied?: (cell: Vec3Like) => boolean,
  ): void => {
    for (const cell of cells) {
      // A candidate from the bounding envelope may be a cell the body never
      // positively occupies. Exclude it before demanding evidence.
      if (occupied !== undefined && !occupied(cell)) continue;
      const read = readCell(cell.x, cell.y, cell.z);
      if (read.kind !== 'observed') {
        noteRead(read, cell);
        continue;
      }
      const shape = resolveShape(read.evidence.observation.state, cell);
      if (shape.kind === 'unsupported') {
        unsupportedShape.push({ cell: { ...cell }, detail: shape.detail });
        continue;
      }
      if (shape.kind === 'gap') continue;
      for (const box of shape.shape.boxes) {
        charge(1);
        if (hits(cell, box)) {
          collisions.push({ cell: { ...cell }, observation: cloneObservation(read.evidence.observation) });
          break;
        }
      }
    }
  };

  /**
   * Check one exact feet position for a standable top face. At least one
   * observed face at exactly `feet.y` with positive-area footprint overlap is
   * required. Unknown candidates keep a missing face from becoming a known
   * absence; all-observed candidates with no matching face is a known gap.
   */
  const checkSupport = (feet: Vec3Like): void => {
    const candidate = boundedCells(
      supportCandidateCells(feet, half, limits.maxCandidateCells, countAndChargeCells),
      'support candidates',
    );
    let supported = false;
    const knownAbsent: Vec3Like[] = [];
    const localUnsupported: Array<{ cell: Vec3Like; detail: string }> = [];
    // Buffer evidence gaps from support candidates that do not themselves form a
    // complete witness: the read, provider controlled neighbor reads and
    // neighbor_gap results. Each candidate is isolated so a provider's own gap
    // cannot be discarded by a face it still returns, while a different
    // candidate's optional gap cannot poison a separate complete witness.
    const buffer = makeGapSink();
    const previousGaps = activeGaps;

    for (const cell of candidate) {
      const candidateGaps = makeGapSink();
      activeGaps = candidateGaps;
      let observedShape = false;
      let cellSupports = false;
      try {
        const read = readCell(cell.x, cell.y, cell.z);
        if (read.kind === 'observed') {
          const shape = resolveShape(read.evidence.observation.state, cell);
          if (shape.kind === 'unsupported') {
            localUnsupported.push({ cell: { ...cell }, detail: shape.detail });
          } else if (shape.kind === 'shape') {
            observedShape = true;
            for (const face of shape.shape.supportFaces) {
              charge(1);
              if (Math.abs(cell.y + face.top - feet.y) > LAND_EPS) continue;
              if (
                rectsOverlapPositive(
                  feet.x - half,
                  feet.x + half,
                  feet.z - half,
                  feet.z + half,
                  cell.x + face.minX,
                  cell.x + face.maxX,
                  cell.z + face.minZ,
                  cell.z + face.maxZ,
                )
              ) {
                cellSupports = true;
                break;
              }
            }
          }
          // A `gap` result was already buffered by resolveShape.
        } else {
          noteRead(read, cell);
        }
      } finally {
        activeGaps = previousGaps;
      }

      // One complete positive-area face at the exact feet height is enough. A
      // candidate whose own read or provider consultation left an evidence gap
      // is not complete: the returned face depends on the missing evidence.
      if (cellSupports && !gapSinkHasGaps(candidateGaps)) {
        supported = true;
        break;
      }
      mergeGapSinkInto(buffer, candidateGaps);
      // Only a fully observed, gap-free candidate without a matching face is a
      // known absence. A candidate that supports only with its own gap remains
      // inconclusive, not absent.
      if (observedShape && !cellSupports && !gapSinkHasGaps(candidateGaps)) knownAbsent.push(cell);
    }

    if (supported) return;

    // No complete witness. Unknown candidates could still supply one, so only
    // an all-observed, gap-free set is a known absence.
    if (localUnsupported.length > 0 || gapSinkHasGaps(buffer)) {
      for (const entry of localUnsupported) unsupportedShape.push(entry);
      mergeGapSink(buffer);
      return;
    }
    for (const cell of knownAbsent) addCell(missingSupport, cell);
  };

  const runCollisionThenSupport = (legs: ReadonlyArray<{ from: Vec3Like; to: Vec3Like }>, supports: boolean): void => {
    // Candidate cells are the union of each leg's own envelope. A single AABB
    // around a two-leg corridor would include corners the body never occupies and
    // would demand evidence for cells outside the declared corridor.
    const byKey = new Map<string, Vec3Like>();
    for (const leg of legs) {
      const envelope = unionAabb(bodyAabb(leg.from, half, height), bodyAabb(leg.to, half, height));
      for (const cell of boundedCells(
        cellsInAabbBounded(envelope, limits.maxCandidateCells, countAndChargeCells),
        'collision candidates',
      )) {
        const key = keyOf(cell);
        if (!byKey.has(key)) {
          byKey.set(key, cell);
          if (byKey.size > limits.maxCandidateCells) {
            noteCapacity(
              'maxCandidateCells',
              limits.maxCandidateCells,
              byKey.size,
              `collision candidates exceed maxCandidateCells (${limits.maxCandidateCells})`,
            );
          }
        }
      }
    }
    const cells = [...byKey.values()];
    minimumRequired = Math.max(minimumRequired, cells.length);
    scanCollision(cells, (cell, box) => {
      for (const leg of legs) {
        if (segmentHitsBox(cell, box, leg.from, leg.to, half, height)) return true;
      }
      return false;
    });
    if (collisions.length > 0) return;
    if (supports) {
      checkSupport(from);
      checkSupport(to);
    }
  };

  const finalize = (): LandTransitionEvaluation => {
    const capped = budgetExhausted || limitGap !== undefined;
    let status: LandTransitionStatus;
    if (collisions.length > 0 || missingSupport.size > 0 || missingClimb.size > 0) {
      status = 'BLOCKED';
    } else if (capped) {
      // A configured capacity or work budget stopped the evaluation. This is
      // never a terrain conclusion, and it must not be reported as complete.
      status = 'INCOMPLETE';
    } else if (
      unsupportedShape.length > 0 ||
      unsupportedModel.length > 0 ||
      unsupportedProvider.length > 0 ||
      unsupportedRange.length > 0
    ) {
      status = 'UNSUPPORTED';
    } else if (stale.size > 0 || expired.size > 0 || session.size > 0) {
      status = 'STALE';
    } else if (unobserved.size > 0 || incomplete.size > 0 || nonresident.size > 0) {
      status = 'UNKNOWN';
    } else {
      status = 'OPEN';
    }

    const reasons: LandTransitionReason[] = [];
    const addReason = (kind: LandTransitionReasonKind, detail: string, cells: Vec3Like[]): void => {
      reasons.push({ kind, detail, cells: cells.map((cell) => ({ ...cell })) });
    };

    if (collisions.length > 0) {
      addReason(
        'collision',
        `collision with ${collisions[0]!.observation.state.name} at (${collisions[0]!.cell.x}, ${collisions[0]!.cell.y}, ${collisions[0]!.cell.z})`,
        collisions.map((entry) => entry.cell),
      );
    }
    if (missingSupport.size > 0) {
      addReason('missing_support', 'no observed standable face at the exact required feet height', [...missingSupport.values()]);
    }
    if (missingClimb.size > 0) {
      addReason('missing_climb_contact', 'proven climb regions do not continuously cover the vertical travel', [...missingClimb.values()]);
    }
    if (limitGap !== undefined) {
      addReason('capacity', limitGap.detail, []);
    }
    if (budgetExhausted) {
      addReason(
        'budget',
        `work budget ${limits.maxWork} exhausted before the transition was fully evaluated`,
        [],
      );
    }
    if (unsupportedShape.length > 0) {
      addReason(
        'unsupported_shape',
        unsupportedShape[0]!.detail,
        unsupportedShape.map((entry) => entry.cell),
      );
    }
    for (const detail of unsupportedModel) addReason('unsupported_model', detail, []);
    for (const detail of unsupportedProvider) addReason('unsupported_provider', detail, []);
    for (const detail of unsupportedRange) addReason('unsupported_range', detail, []);
    if (stale.size > 0) addReason('stale', 'required evidence is marked stale', [...stale.values()]);
    if (expired.size > 0) addReason('expired', 'required evidence passed its validity horizon', [...expired.values()]);
    if (session.size > 0) addReason('wrong_session', 'required evidence belongs to another observation session', [...session.values()]);
    if (unobserved.size > 0) addReason('unobserved', 'required cells have not been observed', [...unobserved.values()]);
    if (incomplete.size > 0) addReason('incomplete_evidence', 'required evidence lacks complete block state', [...incomplete.values()]);
    if (nonresident.size > 0) {
      addReason(
        'nonresident',
        'required Sections are committed but not resident in memory',
        [...nonresident.values()].map((entry) => entry.cell),
      );
    }

    const primary = reasons[0];

    return {
      status,
      assurance: 'geometry_only',
      executable: false,
      kind: transition.kind,
      from: { ...from },
      to: { ...to },
      reason: primary,
      reasons,
      obstacles: collisions.map((entry) => ({
        kind: 'block',
        observation: cloneObservation(entry.observation),
      })),
      hazards: hazards.map((hazard) => ({ ...hazard, pos: { ...hazard.pos } })),
      dependencies: [...deps.values()].map((dep) => ({
        key: { ...dep.key },
        revision: dep.revision,
        residency: dep.residency,
        generation: dep.generation,
        validUntil: dep.validUntil,
      })),
      model: modelIdentity,
      provider: climbIdentity,
      limitGap: limitGap === undefined ? undefined : { ...limitGap },
      sessionId,
      computedAt: now,
      validUntil: [...deps.values()].reduce(
        (min, dep) => Math.min(min, dep.validUntil),
        Number.POSITIVE_INFINITY,
      ),
      work: {
        used: workUsed,
        limit: limits.maxWork,
        requiredAtLeast: budgetExhausted ? Math.max(workUsed + 1, minimumRequired) : workUsed,
        exhausted: budgetExhausted,
      },
    };
  };

  try {
    switch (transition.kind) {
      case 'step': {
        const unsupported = stepRangeProblem(from, to);
        if (unsupported !== null) {
          unsupportedRange.push(unsupported);
          break;
        }
        const targetXz = { x: from.x, y: to.y, z: from.z };
        runCollisionThenSupport(
          [
            { from, to: targetXz },
            { from: targetXz, to },
          ],
          true,
        );
        break;
      }
      case 'drop': {
        const unsupported = dropRangeProblem(from, to);
        if (unsupported !== null) {
          unsupportedRange.push(unsupported);
          break;
        }
        hazards.push({
          kind: 'fall',
          pos: { ...to },
          basis: 'derived',
          detail: `declared drop of ${from.y - to.y} block(s) from feet y=${from.y} to y=${to.y}`,
        });
        const targetXz = { x: to.x, y: from.y, z: to.z };
        runCollisionThenSupport(
          [
            { from, to: targetXz },
            { from: targetXz, to },
          ],
          true,
        );
        break;
      }
      case 'jump': {
        const unsupported = jumpRangeProblem(from, to, limits.maxJumpDistance);
        if (unsupported !== null) {
          unsupportedRange.push(unsupported);
          break;
        }
        const model = rules.jumpModel;
        if (model === undefined) {
          unsupportedModel.push('jump requires an explicit versioned LandMotionModel');
          break;
        }
        charge(1);
        const resolution = model.resolve({ from, to, body });
        if (resolution.kind !== 'supported') {
          unsupportedModel.push(resolution.detail);
          break;
        }
        const apexHeight = (resolution.trajectory as LandJumpTrajectory | undefined)?.apexHeight;
        if (typeof apexHeight !== 'number' || !Number.isFinite(apexHeight) || apexHeight <= 0) {
          unsupportedModel.push(
            `jump model returned an invalid apexHeight (${String(apexHeight)}); a positive finite value is required`,
          );
          break;
        }
        modelIdentity = { kind: 'jump', version: model.version };
        const envelope = jumpEnvelope(from, to, apexHeight, half, height);
        const cells = boundedCells(
          cellsInAabbBounded(envelope, limits.maxCandidateCells, countAndChargeCells),
          'jump candidates',
        );
        scanCollision(
          cells,
          (cell, box) => jumpHitsBox(cell, box, from, to, apexHeight, half, height),
          // The jump envelope includes corners the body never occupies. Use the
          // exact continuous full-cell predicate before requiring evidence.
          (cell) => jumpHitsBox(cell, FULL_CELL, from, to, apexHeight, half, height),
        );
        if (collisions.length === 0) {
          checkSupport(from);
          checkSupport(to);
        }
        break;
      }
      case 'ladder': {
        const unsupported = ladderRangeProblem(from, to);
        if (unsupported !== null) {
          unsupportedRange.push(unsupported);
          break;
        }
        const provider = rules.climbProvider;
        if (provider === undefined) {
          unsupportedProvider.push('ladder requires an explicit versioned ClimbRegionProvider');
          break;
        }
        climbIdentity = { kind: 'climb', version: provider.version };

        // Enumerate the whole continuously swept body envelope once. The same
        // bounded candidates serve required collision clearance and climb-source
        // contact: a tall body can overlap a climb cell above its feet, so the
        // source set is not limited to the feet-travel interval [lo, hi]. No
        // second enumeration is charged for the provider scan.
        const bodyCells = boundedCells(
          cellsInAabbBounded(
            unionAabb(bodyAabb(from, half, height), bodyAabb(to, half, height)),
            limits.maxCandidateCells,
            countAndChargeCells,
          ),
          'ladder body candidates',
        );
        scanCollision(bodyCells, (cell, box) => segmentHitsBox(cell, box, from, to, half, height));
        if (collisions.length > 0) break;

        const lo = Math.min(from.y, to.y);
        const hi = Math.max(from.y, to.y);

        const regions: Array<[number, number]> = [];
        for (const cell of bodyCells) {
          const read = readCell(cell.x, cell.y, cell.z);
          if (read.kind !== 'observed') {
            noteRead(read, cell);
            continue;
          }
          charge(1);
          const resolution = provider.resolve(
            { cell: { ...cell }, state: read.evidence.observation.state, body },
            neighborRead,
          );
          if (resolution.kind === 'unsupported') {
            unsupportedProvider.push(resolution.detail);
            continue;
          }
          if (!Array.isArray(resolution.regions)) {
            unsupportedProvider.push('climb provider returned a non-array region list');
            continue;
          }
          climbRegionCount += resolution.regions.length;
          if (climbRegionCount > limits.maxClimbRegions) {
            noteCapacity(
              'maxClimbRegions',
              limits.maxClimbRegions,
              climbRegionCount,
              `climb regions exceed maxClimbRegions (${limits.maxClimbRegions})`,
            );
          }
          for (const region of resolution.regions) {
            charge(1);
            if (
              region === null ||
              typeof region !== 'object' ||
              !Number.isFinite(region.minFeetY) ||
              !Number.isFinite(region.maxFeetY) ||
              region.minFeetY > region.maxFeetY
            ) {
              unsupportedProvider.push(
                `climb provider returned an invalid feet region [${String(region.minFeetY)}, ${String(region.maxFeetY)}]`,
              );
              continue;
            }
            regions.push([region.minFeetY, region.maxFeetY]);
          }
        }

        const gaps = uncoveredIntervals(regions, lo, hi);
        if (gaps.length > 0) {
          // A gap is only a known absence when every candidate cell was observed
          // and the provider returned no unsupported result. Otherwise the gap is
          // still an evidence/range problem and cannot become BLOCKED.
          const alreadyExplained =
            unsupportedShape.length > 0 ||
            unsupportedProvider.length > 0 ||
            unsupportedRange.length > 0 ||
            stale.size > 0 ||
            expired.size > 0 ||
            session.size > 0 ||
            unobserved.size > 0 ||
            incomplete.size > 0 ||
            nonresident.size > 0;
          if (!alreadyExplained) {
            for (const [gapLo, gapHi] of gaps) {
              const midY = Math.floor((gapLo + gapHi) / 2);
              const gapCells = bodyCells.filter((cell) => cell.y === midY);
              const chosen = gapCells.length > 0 ? gapCells : bodyCells.slice(0, 1);
              for (const cell of chosen) addCell(missingClimb, cell);
            }
          }
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof LandBudgetExhausted) {
      budgetExhausted = true;
    } else if (error instanceof LandCapacityIncomplete) {
      // limitGap was recorded by noteCapacity before aborting.
    } else if (error instanceof LandRangeLimitError) {
      unsupportedRange.push(error.message);
    } else {
      throw error;
    }
  }

  return finalize();
}

function stepRangeProblem(from: Vec3Like, to: Vec3Like): string | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  const xZero = Math.abs(dx) <= LAND_EPS;
  const zZero = Math.abs(dz) <= LAND_EPS;
  const xUnit = Math.abs(Math.abs(dx) - 1) <= LAND_EPS;
  const zUnit = Math.abs(Math.abs(dz) - 1) <= LAND_EPS;
  if (!((xUnit && zZero) || (zUnit && xZero))) {
    return 'step must move exactly one block along one horizontal axis';
  }
  if (!(dy > LAND_EPS && dy <= 1 + LAND_EPS)) {
    return 'step rise must be positive and at most one explicit implementation block';
  }
  return null;
}

function dropRangeProblem(from: Vec3Like, to: Vec3Like): string | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  const xZero = Math.abs(dx) <= LAND_EPS;
  const zZero = Math.abs(dz) <= LAND_EPS;
  const xUnit = Math.abs(Math.abs(dx) - 1) <= LAND_EPS;
  const zUnit = Math.abs(Math.abs(dz) - 1) <= LAND_EPS;
  if (!((xUnit && zZero) || (zUnit && xZero))) {
    return 'drop must move exactly one block along one horizontal axis';
  }
  if (!(dy < -LAND_EPS)) return 'drop target feet must be lower than the start feet';
  return null;
}

function jumpRangeProblem(from: Vec3Like, to: Vec3Like, maxJumpDistance: number): string | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  if (Math.abs(dy) > LAND_EPS) return 'jump must keep the same feet height';
  const xZero = Math.abs(dx) <= LAND_EPS;
  const zZero = Math.abs(dz) <= LAND_EPS;
  if (xZero && zZero) return 'jump must travel horizontally';
  if (!xZero && !zZero) return 'jump must travel along exactly one horizontal axis';
  const distance = xZero ? Math.abs(dz) : Math.abs(dx);
  if (!(distance <= maxJumpDistance + LAND_EPS)) {
    return `jump distance ${distance} exceeds the explicit implementation limit ${maxJumpDistance}`;
  }
  return null;
}

function ladderRangeProblem(from: Vec3Like, to: Vec3Like): string | null {
  if (Math.abs(to.x - from.x) > LAND_EPS || Math.abs(to.z - from.z) > LAND_EPS) {
    return 'ladder travel must keep a fixed XZ position';
  }
  if (Math.abs(to.y - from.y) <= LAND_EPS) return 'ladder travel must change feet height';
  return null;
}

function assertLandLimits(limits: LandLimits): void {
  const integerKeys = [
    'maxTransitions',
    'maxCandidateCells',
    'maxNeighborReads',
    'maxShapeBoxes',
    'maxSupportFaces',
    'maxClimbRegions',
    'maxWork',
  ] as const;
  for (const key of integerKeys) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive safe integer: ${String(value)}`);
    }
  }
  if (!Number.isFinite(limits.maxJumpDistance) || limits.maxJumpDistance <= 0) {
    throw new Error(`maxJumpDistance must be a positive finite number: ${limits.maxJumpDistance}`);
  }
}

function assertBody(body: BodyContext): void {
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
  if (body.pose !== 'standing') throw new Error(`body pose must be "standing": ${String(body.pose)}`);
}

function assertTransition(transition: LandTransition): void {
  if (
    transition.kind !== 'step' &&
    transition.kind !== 'drop' &&
    transition.kind !== 'jump' &&
    transition.kind !== 'ladder'
  ) {
    throw new Error(`unknown land transition kind: ${String(transition.kind)}`);
  }
  for (const [label, point] of [
    ['transition.from', transition.from],
    ['transition.to', transition.to],
  ] as const) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      throw new Error(`${label} must be finite numbers`);
    }
  }
}

function assertVersion(version: string, label: string): void {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { ...observation.pos },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

/** Deep-copy an evaluation so route snapshots never alias internal state. Internal helper. */
export function cloneLandTransitionEvaluation(evaluation: LandTransitionEvaluation): LandTransitionEvaluation {
  return {
    ...evaluation,
    from: { ...evaluation.from },
    to: { ...evaluation.to },
    reason: evaluation.reason === undefined ? undefined : cloneReason(evaluation.reason),
    reasons: evaluation.reasons.map(cloneReason),
    obstacles: evaluation.obstacles.map((obstacle) =>
      obstacle.kind === 'block'
        ? { kind: 'block', observation: cloneObservation(obstacle.observation) }
        : { kind: 'contact', pos: { ...obstacle.pos }, observedAt: obstacle.observedAt, sessionId: obstacle.sessionId },
    ),
    hazards: evaluation.hazards.map((hazard) => ({ ...hazard, pos: { ...hazard.pos } })),
    dependencies: evaluation.dependencies.map((dep) => ({ ...dep, key: { ...dep.key } })),
    model: evaluation.model === undefined ? undefined : { ...evaluation.model },
    provider: evaluation.provider === undefined ? undefined : { ...evaluation.provider },
    limitGap: evaluation.limitGap === undefined ? undefined : { ...evaluation.limitGap },
    work: { ...evaluation.work },
  };
}

function cloneReason(reason: LandTransitionReason): LandTransitionReason {
  return { ...reason, cells: reason.cells.map((cell) => ({ ...cell })) };
}
