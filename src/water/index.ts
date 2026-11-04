/**
 * Water-surface and mounted-boat validation module.
 *
 * Public entry for the bounded, read-only M5 validation slice:
 * `evaluateWaterRoute` verifies a caller-selected constant-height route, and
 * `checkWaterArrival` verifies a separate completion goal over measured body
 * samples. Neither function searches a route, executes a controller, or mounts,
 * dismounts, builds or recovers a boat.
 */

export { checkWaterArrival, evaluateWaterRoute } from './verify.js';

export type {
  BoatDockGoal,
  Box3,
  ControlledNeighborRead,
  DryShoreGoal,
  FixedOrientation,
  FluidRiskFact,
  FluidShape,
  FluidShapeProvider,
  FluidShapeResolution,
  FluidSurfacePatch,
  FluidVolume,
  MountedBoatProfile,
  SurfaceSwimProfile,
  SurfaceTargetGoal,
  WaterArrivalGoal,
  WaterArrivalProblem,
  WaterArrivalRequest,
  WaterArrivalResult,
  WaterArrivalScope,
  WaterArrivalStatus,
  WaterBodySample,
  WaterBudgetReport,
  WaterLimits,
  WaterProfile,
  WaterProfileKind,
  WaterRouteEvaluation,
  WaterRouteProblem,
  WaterRouteQuery,
  WaterRouteStatus,
  WaterValidationLimits,
} from './types.js';
