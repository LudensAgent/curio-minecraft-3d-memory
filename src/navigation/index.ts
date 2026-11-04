/**
 * L2 navigation primitives (design §7): `navigate_to`, `follow_known_path`,
 * `inspect_route`, `frontier_candidates`.
 *
 * The request/result *contracts* are declared here, plus a bounded read-only
 * same-height walk route search (`WalkRouteSearch`) whose output is still a
 * candidate, not an arrival. Full navigation primitives land in phase 3
 * (design §10) and flow through the host's arbitration, cancellation and
 * nesting chain — they are not directly invokable `api.act` entries today.
 *
 * The request/result *contracts* live here, plus one implemented start seam:
 * `startKnownWalkRoute` hands an explicitly selected historical fragment's
 * stored polyline to a caller-supplied `WalkRouteExecutor`. It only starts that
 * delegation — segment re-validation, measured arrival, observation reports,
 * advancement and cancellation remain with the same executor.
 *
 * No navigation primitive is registered as a host `api.act` action, and no
 * host arbitration, nesting or scheduler-cancellation wiring is implemented
 * here. `parentActionId` on the start request is metadata only.
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
export { startKnownWalkRoute } from './known-walk-route.js';
export { NAVIGATION_CAPABILITIES, NAVIGATION_CAPABILITY_STATUSES } from './capabilities.js';
export type {
  NavigationCapability,
  NavigationCapabilityEffects,
  NavigationCapabilityName,
  NavigationCapabilityStatus,
} from './capabilities.js';
export { frontierCandidates, inspectRoute } from './route-inspection.js';
export type {
  FrontierCandidateView,
  FrontierCandidatesResult,
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
