export type {
  HazardFact,
  ObstacleEvidence,
  Traversability,
  TraversabilityEntry,
} from './types.js';
export type {
  CollisionShape,
  CollisionShapeProvider,
  NeighborCellView,
  NeighborRead,
  ShapeResolution,
  SupportFace,
  UnitBox,
} from './collision-shape.js';
export { evaluateWalkStep } from './step.js';
export type {
  BodyContext,
  StepConstraints,
  StepDirection,
  StepEvaluation,
  StepProblem,
  StepQuery,
  StepStatus,
} from './step.js';
export { TraversabilityCache } from './cache.js';
export type { TraversabilityCacheOptions } from './cache.js';
export { RouteVerifier } from './route.js';
export type {
  PendingReason,
  RouteRequest,
  RouteStatus,
  RouteStepState,
  RouteVerdict,
  RouteVerifierOptions,
} from './route.js';
export { DEFAULT_LAND_LIMITS, evaluateLandTransition, resolveLandLimits } from './land-transition.js';
export type {
  ClimbCellInput,
  ClimbRegion,
  ClimbRegionProvider,
  ClimbRegionResolution,
  LandJumpTrajectory,
  LandLimits,
  LandMotionInput,
  LandMotionModel,
  LandMotionResolution,
  LandRules,
  LandSectionDependency,
  LandTransition,
  LandTransitionEvaluation,
  LandTransitionKind,
  LandTransitionQuery,
  LandTransitionReason,
  LandTransitionReasonKind,
  LandTransitionStatus,
  LandWorkReport,
} from './land-transition.js';
export { LandRouteVerifier } from './land-route.js';
export type {
  LandRouteBudgetGap,
  LandRoutePendingReason,
  LandRouteRequest,
  LandRouteSegmentState,
  LandRouteStatus,
  LandRouteVerifierOptions,
  LandRuleVersions,
} from './land-route.js';
