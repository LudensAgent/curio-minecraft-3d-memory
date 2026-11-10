/**
 * L2 navigation primitives (design §7): `navigate_to`, `follow_known_path`,
 * `inspect_route`, `frontier_candidates`.
 *
 * The request/result *contracts* live here, plus caller-driven implementations:
 *
 * - `navigateTo` runs the measured start → bounded `WalkRouteSearch` →
 *   re-verifying `WalkRouteExecutor` pipeline in a caller-supplied environment;
 * - `followKnownPath` starts one named historical fragment on the same executor
 *   and can drive it to a measured `NavResult`;
 * - `startKnownWalkRoute` remains the pure start boundary;
 * - `inspectRoute` / `inspectKnownRoute` and `frontierCandidates` are read-only
 *   projections and never move, observe, pin or save.
 *
 * No navigation primitive is registered as a host `api.act` action, and no
 * host arbitration, nesting or scheduler-cancellation wiring is implemented
 * here. `parentActionId` is metadata only.
 */

export type {
  ActionRecord,
  ArrivalSpec,
  FollowKnownPathRequest,
  Frontier,
  LastObservation,
  NavigateRequest,
  NavOutcome,
  NavProblem,
  NavResult,
} from './types.js';
export type {
  ChangeReportSource,
  WalkBodyPort,
  WalkPathEnvironment,
  WalkPathOutcome,
  WalkPathRequest,
  WalkPathResult,
} from './walk-path-types.js';
export {
  createWalkPath,
  createWalkPathExecution,
  DEFAULT_START_TOLERANCE,
} from './walk-path.js';
export type {
  WalkPath,
  WalkPathExecute,
  WalkPathExecutionOptions,
  WalkPathInvalidationReason,
  WalkPathOptions,
  WalkPathRegistry,
  WalkPathStartContext,
} from './walk-path.js';
export { followKnownPath, navigateTo } from './navigate.js';
export type {
  FollowKnownPathEnvironment,
  FollowKnownPathOutcome,
  NavigateEnvironment,
  NavigateOutcome,
  NavigateSearchSource,
  NavigateSegment,
  NavigationMemoryWrite,
} from './navigate.js';
export { inspectKnownRoute } from './known-route-inspection.js';
export type {
  InspectKnownRouteOptions,
  KnownRouteCurrentFacts,
  KnownRouteEvidence,
  KnownRouteInspection,
  KnownRouteInspectionResult,
  KnownRouteNotFound,
  KnownRouteTraversalView,
} from './known-route-inspection.js';
export { startKnownWalkRoute } from './known-walk-route.js';
export {
  NAVIGATION_CAPABILITIES,
  NAVIGATION_CAPABILITY_STATUSES,
  ROUTE_PLAN_CAPABILITIES,
} from './capabilities.js';
export type {
  NavigationCapability,
  NavigationCapabilityEffects,
  NavigationCapabilityName,
  NavigationCapabilityStatus,
  RoutePlanCapabilities,
  RoutePlanCapabilityName,
} from './capabilities.js';
export { planRoute } from './route-plan.js';
export type {
  CancellationOrigin,
  RouteBoundary,
  RouteEvidence,
  RoutePlan,
  RoutePlanConstraints,
  RoutePlanDraft,
  RoutePlanEnvironment,
  RoutePlanRegistrar,
  RoutePlanRequest,
  RoutePlanResult,
  RoutePlanScope,
  RoutePlanSegment,
  RoutePlanSource,
  RouteUnsupported,
} from './route-plan-types.js';
export {
  RoutePlanRegistryCapacityError,
  RoutePlanRegistryImpl,
} from './route-plan-registry.js';
export type {
  RoutePlanRegistry,
  RoutePlanRegistryOptions,
  RoutePlanRegistryProblem,
} from './route-plan-registry.js';
export { createWalkRouteSearchSource } from './route-search.js';
export type { RouteSearchSource } from './route-search.js';
export { frontierCandidates, inspectRoute } from './route-inspection.js';
export type {
  FrontierCandidateView,
  FrontierCandidatesOptions,
  FrontierCandidatesResult,
  HistoricalConnectionLookup,
  RouteBoundaryFact,
  RouteInspection,
} from './route-inspection.js';
export type {
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  KnownWalkRouteSnapshot,
  KnownWalkRouteStart,
} from './known-walk-route.js';
export { WalkRouteSearch } from './walk-search.js';
export { searchLandRoute, searchLandRouteAsync } from './land-search.js';
export type {
  LandSearchArrival,
  LandSearchBoundary,
  LandSearchBoundaryStatus,
  LandSearchBudget,
  LandSearchKind,
  LandSearchRequest,
  LandSearchResult,
  LandSearchStatus,
  LandSearchTransition,
} from './land-search.js';
export type {
  WalkSearchArrival,
  WalkSearchCandidate,
  WalkSearchCounters,
  WalkSearchDiagnostic,
  WalkSearchFrontier,
  WalkSearchLimits,
  WalkSearchOptions,
  WalkSearchProblem,
  WalkSearchRequest,
  WalkSearchSnapshot,
  WalkSearchState,
  WalkSearchUnavailableEvidence,
  WalkSearchUnavailableResidency,
  WalkSearchUnavailableSection,
} from './walk-search.js';
