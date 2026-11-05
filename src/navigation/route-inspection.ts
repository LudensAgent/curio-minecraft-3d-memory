/**
 * Read-only projections of an existing `WalkSearchSnapshot` (design §7
 * `inspect_route` / `frontier_candidates` first step).
 *
 * These functions take data the caller already holds. They do not receive a
 * `VoxelMap`, a `FragmentStore`, a host adapter or a clock, so they cannot load,
 * observe, revalidate, pin, save, move the body, turn the head or start an
 * action. Every returned value is a fresh copy.
 *
 * A `FOUND` snapshot is still a candidate. `inspectRoute` therefore reports
 * `arrivalConfirmed: false` and `executionStarted: false` as literals, and
 * `frontierCandidates` reports `selected: false` and `explorationStarted: false`.
 */

import type { Observation } from '../observation/types.js';
import type { StepProblem } from '../traversability/step.js';
import type { MoveMode, Vec3Like } from '../types.js';
import type {
  WalkSearchArrival,
  WalkSearchCandidate,
  WalkSearchCounters,
  WalkSearchDiagnostic,
  WalkSearchFrontier,
  WalkSearchLimits,
  WalkSearchProblem,
  WalkSearchSnapshot,
  WalkSearchState,
  WalkSearchUnavailableEvidence,
} from './walk-search.js';

/** One factual non-OPEN boundary edge copied from the snapshot diagnostics. */
export interface RouteBoundaryFact {
  status: WalkSearchDiagnostic['status'];
  stance: Vec3Like;
  to: Vec3Like;
  reason: string;
  computedAt: number;
  problem?: StepProblem;
}

/**
 * Caller-supplied historical lookup for {@link frontierCandidates}.
 *
 * The callback is the caller's query over its own history store. This module
 * does not import topology, so it cannot fabricate `true`/`false`: `undefined`
 * (or any non-boolean) is projected as `'unknown'`.
 */
export type HistoricalConnectionLookup = (candidate: {
  pos: Vec3Like;
  stance: Vec3Like;
  gap: Vec3Like[];
}) => boolean | undefined;

/** Options for {@link frontierCandidates}. */
export interface FrontierCandidatesOptions {
  /**
   * Optional history lookup. Only a real `true`/`false` returned by the caller's
   * own lookup is reported; the library never queries topology here.
   */
  historicalConnection?: HistoricalConnectionLookup;
}

/**
 * A never-observed boundary projected from `WalkSearchFrontier`.
 *
 * `pos` is the adjacent boundary point (`to`), which was not entered and is not
 * claimed reachable. `stance` is the OPEN-verified stance the boundary is next
 * to. `historicalConnection` is `'unknown'` unless the caller supplied a history
 * lookup that returned a boolean for this candidate; this projection itself
 * never queries history.
 */
export interface FrontierCandidateView {
  pos: Vec3Like;
  stance: Vec3Like;
  gap: Vec3Like[];
  /** Reachability of `stance` only, never of `pos` or `gap`. */
  reachability: 'OPEN';
  basis: Observation[];
  historicalConnection: boolean | 'unknown';
  reason: string;
  computedAt: number;
  validUntil: number;
}

export interface FrontierCandidatesResult {
  source: 'walk_search_snapshot';
  worldId: string;
  dim: string;
  sessionId: string;
  state: WalkSearchState;
  /** Fresh copies; never ranked, selected or entered. */
  candidates: FrontierCandidateView[];
  /** No target was chosen from the candidates. */
  selected: false;
  /** No exploration was started. */
  explorationStarted: false;
  /** True when the snapshot hit `maxFrontiers`; the list remains bounded. */
  truncated: boolean;
  unavailableHistoricalCount: number;
  unavailableHistoricalTruncated: boolean;
  computedAt: number;
}

export interface RouteInspection {
  source: 'walk_search_snapshot';
  state: WalkSearchState;
  worldId: string;
  dim: string;
  sessionId: string;
  mode: MoveMode;
  from: Vec3Like;
  target: Vec3Like;
  arrival: WalkSearchArrival;
  computedAt: number;
  validUntil: number;
  reason: string;
  problem?: WalkSearchProblem;
  /** Candidate only; never an arrival. */
  candidate: WalkSearchCandidate | null;
  /** This query does not measure the body. */
  arrivalConfirmed: false;
  /** This query does not start an executor or a move. */
  executionStarted: false;
  boundaries: RouteBoundaryFact[];
  frontiers: FrontierCandidateView[];
  unavailableHistorical: WalkSearchUnavailableEvidence[];
  counters: WalkSearchCounters;
  limits: WalkSearchLimits;
  ruleVersion: string;
  diagnosticsTruncated: boolean;
}

/** Project the bounded frontier candidates already in `snapshot`. */
export function frontierCandidates(
  snapshot: WalkSearchSnapshot,
  options: FrontierCandidatesOptions = {},
): FrontierCandidatesResult {
  const lookup = options.historicalConnection;
  return {
    source: 'walk_search_snapshot',
    worldId: snapshot.worldId,
    dim: snapshot.dim,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    candidates: snapshot.frontiers.map((frontier) => {
      const connection = lookup === undefined
        ? undefined
        : lookup({
            pos: { ...frontier.to },
            stance: { ...frontier.stance },
            gap: frontier.gap.map((cell) => ({ ...cell })),
          });
      return cloneFrontierCandidate(
        frontier,
        connection === true || connection === false ? connection : 'unknown',
      );
    }),
    selected: false,
    explorationStarted: false,
    truncated: snapshot.counters.frontierLimitReached,
    unavailableHistoricalCount: snapshot.counters.unavailableHistoricalReported,
    unavailableHistoricalTruncated: snapshot.counters.unavailableHistoricalLimitReached,
    computedAt: snapshot.computedAt,
  };
}

/** Inspect an existing `snapshot` without revalidating or advancing anything. */
export function inspectRoute(snapshot: WalkSearchSnapshot): RouteInspection {
  return {
    source: 'walk_search_snapshot',
    state: snapshot.state,
    worldId: snapshot.worldId,
    dim: snapshot.dim,
    sessionId: snapshot.sessionId,
    mode: snapshot.mode,
    from: { ...snapshot.from },
    target: { ...snapshot.target },
    arrival: cloneArrival(snapshot.arrival),
    computedAt: snapshot.computedAt,
    validUntil: snapshot.validUntil,
    reason: snapshot.reason,
    problem: snapshot.problem === undefined ? undefined : { ...snapshot.problem },
    candidate: snapshot.candidate === null ? null : cloneCandidate(snapshot.candidate),
    arrivalConfirmed: false,
    executionStarted: false,
    boundaries: snapshot.diagnostics.map((diagnostic) => ({
      status: diagnostic.status,
      stance: { ...diagnostic.stance },
      to: { ...diagnostic.to },
      reason: diagnostic.reason,
      computedAt: diagnostic.computedAt,
      problem: diagnostic.problem === undefined ? undefined : cloneStepProblem(diagnostic.problem),
    })),
    frontiers: snapshot.frontiers.map((frontier) => cloneFrontierCandidate(frontier, 'unknown')),
    unavailableHistorical: snapshot.unavailableHistorical.map(cloneUnavailable),
    counters: { ...snapshot.counters },
    limits: { ...snapshot.limits },
    ruleVersion: snapshot.ruleVersion,
    diagnosticsTruncated: snapshot.counters.diagnosticsTruncated,
  };
}

function cloneFrontierCandidate(
  frontier: WalkSearchFrontier,
  historicalConnection: boolean | 'unknown',
): FrontierCandidateView {
  return {
    pos: { ...frontier.to },
    stance: { ...frontier.stance },
    gap: frontier.gap.map((cell) => ({ ...cell })),
    reachability: frontier.reachability,
    basis: frontier.basis.map(cloneObservation),
    historicalConnection,
    reason: frontier.reason,
    computedAt: frontier.computedAt,
    validUntil: frontier.validUntil,
  };
}

function cloneCandidate(candidate: WalkSearchCandidate): WalkSearchCandidate {
  return {
    points: candidate.points.map((point) => ({ ...point })),
    edgeCount: candidate.edgeCount,
    reachedAt: { ...candidate.reachedAt },
    target: { ...candidate.target },
    arrival: cloneArrival(candidate.arrival),
    distanceToTarget: candidate.distanceToTarget,
    validUntil: candidate.validUntil,
  };
}

function cloneUnavailable(entry: WalkSearchUnavailableEvidence): WalkSearchUnavailableEvidence {
  return {
    ...entry,
    stance: { ...entry.stance },
    to: { ...entry.to },
    gap: entry.gap.map((cell) => ({ ...cell })),
    sections: entry.sections.map((section) => ({ ...section, key: { ...section.key } })),
    basis: entry.basis.map(cloneObservation),
  };
}

function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { ...observation.pos },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

function cloneStepProblem(problem: StepProblem): StepProblem {
  return {
    ...problem,
    cells: problem.cells.map((cell) => ({ ...cell })),
  };
}

function cloneArrival(arrival: WalkSearchArrival): WalkSearchArrival {
  return arrival.kind === 'exact' ? { kind: 'exact' } : { kind: 'near', radius: arrival.radius };
}
