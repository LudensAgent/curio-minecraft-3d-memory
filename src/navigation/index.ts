/**
 * L2 navigation primitives (design §7): `navigate_to`, `follow_known_path`,
 * `inspect_route`, `frontier_candidates`.
 *
 * The request/result *contracts* are declared here, plus a bounded read-only
 * same-height walk route search (`WalkRouteSearch`) whose output is still a
 * candidate, not an arrival. Full navigation primitives land in phase 3
 * (design §10) and flow through the host's arbitration, cancellation and
 * nesting chain — they are not directly invokable `api.act` entries today.
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
