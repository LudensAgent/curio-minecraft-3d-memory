/**
 * Navigation primitives for the voxel-first library.
 *
 * The current route search is `searchLandRoute` / `searchLandRouteAsync` over a
 * `VoxelMap`. Route planning registries, historical walk search and the old
 * compatibility pipeline are retired; the host executes a selected route with
 * its own `navigate_to` / `advance` body actions.
 *
 * This module also re-exports the shared delegation/result contracts
 * (`NavResult`, `NavProblem`, `ActionRecord`) used by the execution layer and
 * the journal.
 */

export type {
  ActionRecord,
  ArrivalSpec,
  LastObservation,
  NavOutcome,
  NavProblem,
  NavResult,
} from './types.js';

export { DEFAULT_LAND_SEARCH_MAX_EDGES, DEFAULT_LAND_SEARCH_MAX_NODES, searchLandRoute, searchLandRouteAsync } from './land-search.js';
export type {
  LandSearchArrival,
  LandSearchBoundary,
  LandSearchBoundaryStatus,
  LandSearchBudget,
  LandSearchCorridor,
  LandSearchEdgePolicy,
  LandSearchKind,
  LandSearchPolicyCell,
  LandSearchPolicyDecision,
  LandSearchPolicyEdge,
  LandSearchPolicyRead,
  LandSearchPolicyRejection,
  LandSearchPolicySummary,
  LandSearchPrefix,
  LandSearchRequest,
  LandSearchResult,
  LandSearchStatus,
  LandSearchTransition,
} from './land-search.js';
