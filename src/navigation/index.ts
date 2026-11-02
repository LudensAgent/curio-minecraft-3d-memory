/**
 * L2 navigation primitives (design §7): `navigate_to`, `follow_known_path`,
 * `inspect_route`, `frontier_candidates`.
 *
 * Only the request/result *contracts* are declared here. The executing
 * primitives land in phase 3 (design §10) and flow through the host's
 * arbitration, cancellation and nesting chain — they are not directly
 * invokable `api.act` entries today.
 */

export type {
  ActionRecord,
  ArrivalSpec,
  FollowKnownPathRequest,
  Frontier,
  NavigateRequest,
  NavOutcome,
  NavProblem,
  NavResult,
} from './types.js';
