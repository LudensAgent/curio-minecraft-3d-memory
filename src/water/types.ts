/**
 * Water-surface and mounted-boat validation contract (design §3.3, §3.4, §7;
 * M5 validation-only first slice).
 *
 * This module answers one bounded question: *given current evidence already
 * accepted by a `VoxelMap`, does the declared geometry contract for a
 * caller-selected, constant-height water route hold along its entire linear
 * sweep?* It is not a navigation service, does not search or smooth a route,
 * does not choose a shore, and does not execute any swim/boat controller.
 *
 * Solid collision stays in the existing `CollisionShapeProvider`. Fluid
 * geometry and water-surface semantics live in a separate injected
 * `FluidShapeProvider`, so a `waterlogged` block can keep both its solid shape
 * and its fluid volume. No Minecraft fluid-level formula is implemented here:
 * the provider is the versioned authority, and the library never turns a block
 * name into a surface height.
 */

import type { BodySample } from '../execution/types.js';
import type { BlockState, Vec3Like } from '../types.js';
import type {
  CollisionShapeProvider,
  NeighborCellView,
  NeighborRead,
  UnitBox,
} from '../traversability/collision-shape.js';
import type { StepEvaluation } from '../traversability/step.js';
import type { HazardFact, ObstacleEvidence, Traversability } from '../traversability/types.js';
import type { SectionKey } from '../voxel/section.js';
import type { VoxelMap } from '../voxel/voxel-map.js';

/** The two water profiles this slice can validate. Boats are deliberately not a `MoveMode`. */
export type WaterProfileKind = 'surface_swim' | 'mounted_boat';

/**
 * Fixed, axis-aligned body/vehicle orientation. This slice does not model
 * rotation over time or arbitrary yaw; only 90° quarter turns of the declared
 * local frame are exact under swept-AABB reasoning.
 */
export interface FixedOrientation {
  quarterTurns: 0 | 1 | 2 | 3;
}

/**
 * An axis-aligned box. For profile input it is expressed in the profile-local
 * frame (X = width, Y = up, Z = length) relative to the route point. The same
 * shape is reused for world-axis offsets in results.
 */
export interface Box3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Surface-swim geometry. The route point is the swimmer's feet position.
 *
 * `breathing` is the head/breathing clearance above the body. `surfaceBand` is
 * an absolute world-Y band that the observed water surface must occupy at every
 * point of the route; it must intersect the body's vertical span, otherwise the
 * declared contract is internally inconsistent. Waterline dynamics that move
 * outside this fixed band are not supported by this slice.
 */
export interface SurfaceSwimProfile {
  kind: 'surface_swim';
  orientation: FixedOrientation;
  /** Swimmer AABB width (X and Z) and height (Y), measured from the route point. */
  body: { width: number; height: number };
  /** Breathable clearance, measured upward from the route point. */
  breathing: { minY: number; width: number; height: number };
  /** Absolute world-Y band the observed water surface must lie in. */
  surfaceBand: { minY: number; maxY: number };
}

/**
 * Mounted-boat geometry. The route point is the hull's bottom center.
 *
 * `hull` and `passengerClearance` are declared in the local frame and rotated by
 * `orientation`. Passenger clearance volumes are separate from the hull: the
 * player AABB is not used as a substitute for actual hull width/length or for
 * headroom over seats.
 */
export interface MountedBoatProfile {
  kind: 'mounted_boat';
  orientation: FixedOrientation;
  /** Hull dimensions in the local frame. */
  hull: { width: number; length: number; height: number };
  /** Passenger clearance volumes in the local frame, relative to the hull bottom center. */
  passengerClearance: readonly Box3[];
  /** Absolute world-Y band the observed water surface must lie in. */
  surfaceBand: { minY: number; maxY: number };
}

export type WaterProfile = SurfaceSwimProfile | MountedBoatProfile;

/**
 * Explicit top surface of a fluid volume in unit-local cell coordinates.
 * `y` is provider-declared; this library never derives it from a block name.
 */
export interface FluidSurfacePatch {
  /** Surface Y in unit-local `[0,1]` coordinates. */
  y: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One fluid volume in a cell's unit-local `[0,1]^3` frame. */
export interface FluidVolume {
  kind: 'water' | 'lava';
  /** Occupied sub-volume; a waterlogged partial block is never promoted to a full cell. */
  box: UnitBox;
  /** What the provider actually knows about the fluid's motion. `unknown` never becomes `still`. */
  motion: 'still' | 'flowing' | 'falling' | 'unknown';
  /**
   * Explicit surface geometry. `'none'` means the provider positively knows the
   * volume has no horizontal surface; `'unknown'` means it cannot tell. The two
   * must not be conflated: an unknown surface can never produce OPEN.
   */
  surface: FluidSurfacePatch | 'none' | 'unknown';
}

/** Current, falling-water and bubble-column facts declared from actual state or derived neighbours. */
export interface FluidRiskFact {
  kind: 'current' | 'falling' | 'bubble_column';
  basis: 'observed' | 'derived';
  detail: string;
}

/**
 * A cell's fluid interpretation. `water` may coexist with a solid collision
 * shape (waterlogged blocks); this layer keeps both.
 */
export interface FluidShape {
  water: FluidVolume | null;
  lava: FluidVolume | null;
  risks: readonly FluidRiskFact[];
}

/** Resolution of one complete block state by a versioned fluid rule set. */
export type FluidShapeResolution =
  | { kind: 'shape'; shape: FluidShape }
  | { kind: 'unsupported_fluid'; block: string; detail: string }
  | { kind: 'neighbor_gap'; view: NeighborCellView };

/**
 * Controlled neighbour read. Every `cell()` call is budgeted and checked for
 * evidence freshness/completeness/session; once the budget is exhausted the
 * read reports `budgetExhausted` and returns `unobserved`, never a guessed air
 * cell. Providers may read neighbours only through this entry.
 */
export interface ControlledNeighborRead extends NeighborRead {
  readonly budgetExhausted: boolean;
}

/**
 * Versioned fluid rule set. `version` participates in the caller's cache key.
 * It must interpret the actual complete block state (properties included) and
 * its known neighbours; it must not rely on a name-only shortcut.
 */
export interface FluidShapeProvider {
  version: string;
  resolve(state: BlockState, cell: Vec3Like, read: ControlledNeighborRead): FluidShapeResolution;
}

/** Hard bounds applied before expensive enumeration or provider work. */
export interface WaterValidationLimits {
  /** Maximum route points (inclusive). */
  maxPoints: number;
  /** Maximum cells in the combined swept envelope before enumeration. */
  maxCandidateCells: number;
  /** Maximum distinct cells looked up in the evidence map. */
  maxReadCells: number;
  /** Maximum provider `read.cell()` calls, including duplicate neighbour reads. */
  maxNeighborReads: number;
  /** Maximum geometric box/interval checks. */
  maxShapeChecks: number;
}

export type WaterLimits = Partial<WaterValidationLimits>;

/** Caller-selected ordered water route plus its fixed evidence/profile context. */
export interface WaterRouteQuery {
  worldId: string;
  dim: string;
  sessionId: string;
  /**
   * Ordered caller-selected positions (≥ 2). Exact coordinates and order are
   * preserved: nothing is floored, smoothed, interpolated into new waypoints,
   * or replaced by a different target height.
   */
  points: readonly Vec3Like[];
  profile: WaterProfile;
  /** Solid collision rules; independent from the fluid provider. */
  solidShapeProvider: CollisionShapeProvider;
  /** Versioned fluid/water-surface rules. */
  fluidShapeProvider: FluidShapeProvider;
  limits?: WaterLimits;
}

/** The four passage states plus the capability gap they cannot express. */
export type WaterRouteStatus = Traversability | 'UNSUPPORTED';

export type WaterRouteProblem =
  | { kind: 'collision'; cells: Vec3Like[]; detail: string }
  | { kind: 'head_clearance'; cells: Vec3Like[]; detail: string }
  | { kind: 'missing_surface'; cells: Vec3Like[]; detail: string }
  | { kind: 'unobserved'; cells: Vec3Like[]; detail: string }
  | { kind: 'stale'; cells: Vec3Like[]; detail: string }
  | { kind: 'unsupported_profile'; cells: Vec3Like[]; detail: string }
  | { kind: 'unsupported_shape'; cells: Vec3Like[]; detail: string }
  | { kind: 'neighbor_gap'; cells: Vec3Like[]; detail: string }
  | {
      kind: 'budget_exceeded';
      detail: string;
      limit: keyof WaterValidationLimits;
      used: number;
      max: number;
    };

/** Actual work counts plus the limits that governed the evaluation. */
export interface WaterBudgetReport {
  points: number;
  candidateCells: number;
  readCells: number;
  neighborReads: number;
  shapeChecks: number;
  limits: WaterValidationLimits;
}

/**
 * One read-only route evaluation. `OPEN` means only that this bounded geometry
 * contract is supported by current evidence — never arrival, execution
 * success, authorization, or absence of risk. Hazards are independent of the
 * status; water/lava/current/bubble facts do not by themselves become BLOCKED.
 */
export interface WaterRouteEvaluation {
  status: WaterRouteStatus;
  profileKind: WaterProfileKind;
  ruleVersions: { solid: string; fluid: string };
  worldId: string;
  dim: string;
  sessionId: string;
  /**
   * Exact original route points (deep copy). Empty only when a pre-enumeration
   * budget rejected the request; `from`/`to` still preserve the original ends.
   */
  points: Vec3Like[];
  /** First route point, never rewritten. */
  from: Vec3Like;
  /** Last route point, never rewritten. */
  to: Vec3Like;
  reason?: string;
  problem?: WaterRouteProblem;
  /** Objective risk facts tied to observed cells; independent of `status`. */
  hazards: HazardFact[];
  /** Confirmed solid obstacles for a collision/head-clearance verdict. */
  obstacles: ObstacleEvidence[];
  /** Actual section reads (deduped), for local cache invalidation. */
  dependencies: { key: SectionKey; revision: number }[];
  budget: WaterBudgetReport;
  computedAt: number;
  /** No later than the validity of the still-valid evidence actually read. */
  validUntil: number;
}

// --- completion verification (separate from route verification) ---

/** A target whose completion only requires measured presence in water. */
export interface SurfaceTargetGoal {
  kind: 'surface_target';
  target: Vec3Like;
  horizontalTolerance: number;
  verticalTolerance: number;
}

/**
 * A dry-shore target. Completion requires measured dry/grounded evidence plus a
 * geometry-confirmed stationary support check. The original-shore position is
 * not accepted in place of this target.
 */
export interface DryShoreGoal {
  kind: 'dry_shore';
  target: Vec3Like;
  horizontalTolerance: number;
  verticalTolerance: number;
  /** Fixed body used for the stationary grounded check. */
  body: { width: number; height: number };
  /** Solid collision/support rules used by the existing walk evaluator. */
  shapeProvider: CollisionShapeProvider;
  /** Support-height tolerance passed to the existing grounded evaluator. */
  feetTolerance: number;
}

/**
 * A mounted-boat dock target. Completion requires an explicit stable boat
 * identity, still-mounted matching identity, measured low speed, and ordered
 * stable samples spanning the declared window.
 */
export interface BoatDockGoal {
  kind: 'boat_dock';
  target: Vec3Like;
  horizontalTolerance: number;
  verticalTolerance: number;
  /** Stable entity identity (for example UUID/entity id); never a display string. */
  boatId: string;
  /** Ordered stable samples must span at least this many ms. */
  stableWindowMs: number;
  /** Speed limits in blocks per physics tick (20 Hz). */
  maxHorizontalSpeed: number;
  maxVerticalSpeed: number;
  /** At least 2 by default. */
  minStableSamples?: number;
}

export type WaterArrivalGoal = SurfaceTargetGoal | DryShoreGoal | BoatDockGoal;

/**
 * One measured body sample extended with mount identity.
 *
 * `boatId` is the explicit stable identity this layer trusts. `ridingLabel` is
 * carried for host logs only and is never parsed to infer identity.
 */
export interface WaterBodySample extends BodySample {
  /** Stable boat identity the body was measured on. Absent = not provided. */
  boatId?: string;
  /** Display text for logs only; never used for completion. */
  ridingLabel?: string;
  /** True when the host applied a server position correction around this sample. */
  positionCorrected?: boolean;
}

export interface WaterArrivalScope {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Execution identity the samples must belong to. */
  executionId: string;
}

export interface WaterArrivalRequest {
  goal: WaterArrivalGoal;
  scope: WaterArrivalScope;
  /** Required for `dry_shore`; the read-only evidence map used for support geometry. */
  map?: VoxelMap;
  /** Measured samples in host order; replayed/out-of-order input is rejected. */
  samples: readonly WaterBodySample[];
  now: number;
  /** Samples older than `now - maxSampleAgeMs` are stale. */
  maxSampleAgeMs: number;
  /** Maximum samples processed (inclusive). Defaults to 512. */
  maxSamples?: number;
}

/** Completion is a separate confirmation from route verification. */
export type WaterArrivalStatus = 'ARRIVED' | 'UNCONFIRMED';

export type WaterArrivalProblem =
  | { kind: 'no_evidence'; detail: string }
  | { kind: 'invalid_sample'; sampleIndex: number; detail: string }
  | { kind: 'sample_order'; sampleIndex: number; detail: string }
  | { kind: 'wrong_scope'; sampleIndex: number; detail: string }
  | { kind: 'wrong_execution'; sampleIndex: number; detail: string }
  | { kind: 'stale'; sampleIndex: number; observedAt: number; detail: string }
  | { kind: 'unavailable'; sampleIndex: number; detail: string }
  | { kind: 'body_correction'; sampleIndex: number; detail: string }
  | {
      kind: 'outside_target';
      sampleIndex: number;
      expected: Vec3Like;
      actual: Vec3Like;
      detail: string;
    }
  | { kind: 'not_in_water'; sampleIndex: number; detail: string }
  | { kind: 'not_dry_grounded'; sampleIndex: number; detail: string }
  | {
      kind: 'shore_support';
      sampleIndex: number;
      detail: string;
      evaluation: StepEvaluation;
    }
  | { kind: 'not_mounted'; sampleIndex: number; detail: string }
  | {
      kind: 'boat_identity_mismatch';
      sampleIndex: number;
      expected: string;
      actual: string;
      detail: string;
    }
  | { kind: 'moving'; sampleIndex: number; detail: string }
  | {
      kind: 'insufficient_stable_window';
      sampleIndex: number;
      detail: string;
      stableMs: number;
      requiredMs: number;
    }
  | {
      kind: 'budget_exceeded';
      detail: string;
      limit: string;
      used: number;
      max: number;
    };

/**
 * Factual completion result. `ARRIVED` is only emitted for a measured,
 * in-scope, ordered sample set that satisfies the original goal; absence,
 * stale/replayed/wrong-scope/corrected evidence is `UNCONFIRMED`, never a
 * success translation.
 */
export interface WaterArrivalResult {
  status: WaterArrivalStatus;
  /** Exact original goal (deep copy, including target height and tolerances). */
  goal: WaterArrivalGoal;
  scope: WaterArrivalScope;
  reason?: string;
  problem?: WaterArrivalProblem;
  /** Last accepted measured sample position, if any. */
  lastPosition?: Vec3Like;
  /** Original observation time of the last accepted sample, never the query time. */
  lastObservedAt?: number;
  /** Dry shore: the actual read-only grounded geometry evaluation, not a boolean. */
  shoreSupport?: StepEvaluation;
  /** Dock: original observation time when the current stable run started. */
  stableSince?: number;
  /** Dock: number of consecutive stable samples in the current run. */
  stableSamples?: number;
  computedAt: number;
  /** Freshness ceiling of the samples (and shore geometry) relied on. */
  validUntil?: number;
}
