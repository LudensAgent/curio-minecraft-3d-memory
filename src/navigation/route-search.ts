/**
 * `WalkRouteSearch` adapter for route planning (contract §6.3, plan M3.2).
 *
 * The planner consumes search as a bounded, incremental source with explicit
 * start/advance/snapshot/cancel operations. This adapter delegates to the real
 * `WalkRouteSearch`; it neither copies the search state nor adds any second
 * search implementation. A search instance still owns exactly one search at a
 * time and `start` replaces it.
 *
 * `concludeWalkSearch` is the single state→conclusion mapping used by planning.
 * It deliberately keeps `candidate` findings distinct from arrival and keeps
 * budget/evidence conclusions distinct from a real blocked path.
 */

import type {
  WalkRouteSearch,
  WalkSearchRequest,
  WalkSearchSnapshot,
  WalkSearchState,
} from './walk-search.js';

/** Search lifecycle exposed to planning; mirrors `WalkRouteSearch`. */
export interface RouteSearchSource {
  start(request: WalkSearchRequest): void;
  advance(budget: number): WalkSearchSnapshot;
  snapshot(): WalkSearchSnapshot;
  cancel(reason: string): void;
}

/** Planning-level meaning of a search snapshot state. */
export type RouteSearchConclusion =
  | 'pending'
  | 'found'
  | 'no_verified_path'
  | 'insufficient_evidence'
  | 'unsupported'
  | 'budget_exhausted'
  | 'cancelled'
  | 'invalidated';

/** Map a search state to its planning conclusion without reinterpreting facts. */
export function concludeWalkSearch(state: WalkSearchState): RouteSearchConclusion {
  switch (state) {
    case 'PENDING':
      return 'pending';
    case 'FOUND':
      return 'found';
    case 'NO_VERIFIED_PATH':
      return 'no_verified_path';
    case 'INSUFFICIENT_EVIDENCE':
      return 'insufficient_evidence';
    case 'UNSUPPORTED':
      return 'unsupported';
    case 'BUDGET_EXHAUSTED':
      return 'budget_exhausted';
    case 'CANCELLED':
      return 'cancelled';
    case 'INVALIDATED':
      return 'invalidated';
  }
}

/**
 * Adapt an existing bounded `WalkRouteSearch`. `start` discards the initial
 * snapshot because planning reads it through `snapshot()`; the search itself
 * remains the source of truth.
 */
export function createWalkRouteSearchSource(search: WalkRouteSearch): RouteSearchSource {
  return {
    start(request: WalkSearchRequest): void {
      search.start(request);
    },
    advance(budget: number): WalkSearchSnapshot {
      return search.advance(budget);
    },
    snapshot(): WalkSearchSnapshot {
      const snapshot = search.status();
      if (snapshot === null) {
        throw new Error('route planning read the search before start() registered it');
      }
      return snapshot;
    },
    cancel(reason: string): void {
      search.cancel(reason);
    },
  };
}
