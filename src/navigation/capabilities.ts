/**
 * Machine-readable status of the design §7 navigation names.
 *
 * The design contract is not an implementation claim. This table is the public
 * source of truth for what each name actually does in this package:
 *
 * - `implemented` — a public runtime entry carries out the declared supported
 *   scope. It may still be a start boundary or a partial pipeline; `supported`
 *   and `unsupported` say exactly how far it goes.
 * - `read_only` — a public runtime entry exists but only projects supplied
 *   snapshots; it never moves, observes, pins, saves, or starts an action.
 * - `host_approximation` — the host may have a related action, but this library
 *   has no entry that implements the §7 contract.
 * - `not_implemented` — no public runtime entry exists for the name. Compile-time
 *   contracts or separate building blocks may still exist; they do not together
 *   constitute the capability.
 *
 * `effects` describes the public entry, not every related seam. A `null` entry
 * therefore has all effects false. In particular, an OPEN search candidate is
 * never an arrival, and `geometry_only` validation is never execution.
 */

export type NavigationCapabilityName =
  | 'navigate_to'
  | 'follow_known_path'
  | 'inspect_route'
  | 'frontier_candidates'
  | 'recall_route';

export type NavigationCapabilityStatus =
  | 'implemented'
  | 'read_only'
  | 'host_approximation'
  | 'not_implemented';

export const NAVIGATION_CAPABILITY_STATUSES: readonly NavigationCapabilityStatus[] = [
  'implemented',
  'read_only',
  'host_approximation',
  'not_implemented',
];

/** Side effects of the named public entry. Reads are not effects. */
export interface NavigationCapabilityEffects {
  movesBody: boolean;
  turnsHead: boolean;
  writesLibrary: boolean;
  pinsSections: boolean;
  triggersObservation: boolean;
  startsAction: boolean;
}

interface NavigationCapabilityBase {
  name: NavigationCapabilityName;
  /** Related compile-time contract types; declarations alone are not execution. */
  contracts: readonly string[];
  /**
   * Existing building blocks that do not by themselves implement the §7 name.
   * A seam is listed for auditability, never as a substitute implementation.
   */
  seams: readonly string[];
  effects: NavigationCapabilityEffects;
  supported: readonly string[];
  unsupported: readonly string[];
  notes: string;
}

export type NavigationCapability =
  | (NavigationCapabilityBase & {
      status: 'implemented' | 'read_only';
      /** Non-empty: these statuses require a real public runtime entry. */
      entry: readonly [string, ...string[]];
    })
  | (NavigationCapabilityBase & {
      status: 'not_implemented';
      entry: null;
    })
  | (NavigationCapabilityBase & {
      status: 'host_approximation';
      entry: readonly [string, ...string[]] | null;
    });

export const NAVIGATION_CAPABILITIES = [
  {
    name: 'navigate_to',
    status: 'not_implemented',
    entry: null,
    contracts: ['NavigateRequest', 'NavResult', 'NavProblem', 'ActionRecord'],
    seams: ['WalkRouteSearch', 'WalkRouteExecutor'],
    effects: {
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: false,
    },
    supported: [],
    unsupported: [
      'no public navigate_to function or host action registration',
      'no integrated search → verify → execute → measured-arrival pipeline',
      'no digging, placing, towering or material spending',
      'no host arbitration, scheduling, nesting, prompt or action-catalog wiring',
      'no ARRIVED confirmation: WalkRouteSearch returns a candidate and WalkRouteExecutor executes only caller-supplied verified points',
    ],
    notes:
      'The request/result contracts are declared. The candidate search and the caller-driven executor are separate seams and are not a navigate_to implementation.',
  },
  {
    name: 'follow_known_path',
    status: 'implemented',
    entry: ['startKnownWalkRoute'],
    contracts: ['KnownWalkRouteRequest', 'KnownWalkRouteStart', 'KnownWalkRouteSnapshot'],
    seams: ['WalkRouteExecutor', 'FragmentStore.getFragment'],
    effects: {
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: true,
    },
    supported: [
      'select one caller-named historical fragment and start its stored polyline on a caller-supplied WalkRouteExecutor',
      'walk mode only',
      'exact foot-position arrival only',
      'same-height, one-cell ±X/±Z polyline with a correct scope, start and point budget',
      'history is read as geometry; the executor still verifies every segment against current evidence',
    ],
    unsupported: [
      'near or reach_block arrival',
      'non-walk modes',
      'non-empty avoid constraints',
      'diagonal, duplicate-point or height-changing stored geometry',
      'navigating, selecting or switching to another path',
      'auto-driving the executor, host action registration, arbitration, nesting and scheduler cancellation',
      'the start seam itself does not confirm arrival; a measured arrival is confirmed only by the executor',
    ],
    notes:
      'This is the §7 start boundary. It registers a delegation; it does not call MoveExecutor.move. Body steps begin only when the caller drives WalkRouteExecutor.advance().',
  },
  {
    name: 'inspect_route',
    status: 'read_only',
    entry: ['inspectRoute'],
    contracts: ['RouteInspection', 'RouteBoundaryFact'],
    seams: ['WalkSearchSnapshot'],
    effects: {
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: false,
    },
    supported: [
      'pure projection of an existing WalkSearchSnapshot',
      'reports search state, reason, problem, candidate route, boundary diagnostics, frontiers, unavailable historical evidence, counters, limits and validity times',
      'candidate presence is reported as a candidate only; arrivalConfirmed and executionStarted are always false',
    ],
    unsupported: [
      'no pathId or FragmentStore inspection',
      'no map, world or section load; no observation; no pin; no save',
      'no evidence revalidation or implicit rescan',
      'no movement, head turn or action start',
      'no arrival confirmation',
    ],
    notes:
      'The query takes data the caller already holds. Freshness means the snapshot fields only; it is not a new observation.',
  },
  {
    name: 'frontier_candidates',
    status: 'read_only',
    entry: ['frontierCandidates'],
    contracts: ['FrontierCandidatesResult', 'FrontierCandidateView'],
    seams: ['WalkSearchSnapshot.frontiers'],
    effects: {
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: false,
    },
    supported: [
      'bounded projection of the never-observed boundaries already present in a WalkSearchSnapshot',
      'each candidate keeps the OPEN-verified stance, the unentered boundary point, the unobserved gap, observed basis and validity',
    ],
    unsupported: [
      'no target selection or ranking',
      'no exploration start or world scan',
      'no topology lookup: historicalConnection is always "unknown"',
      'no reachability claim for the boundary point or gap',
      'no movement, head turn, observation, pin or save',
    ],
    notes:
      'The list is bounded by the search snapshot maxFrontiers; truncated reports the snapshot counter. The design Frontier contract is not populated with an invented historicalConnection boolean.',
  },
  {
    name: 'recall_route',
    status: 'not_implemented',
    entry: null,
    contracts: [],
    seams: ['FragmentStore.getFragment', 'TopologyStore.route'],
    effects: {
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: false,
    },
    supported: [],
    unsupported: [
      'no public recall_route function',
      'no pathId-based route recall that returns an executable route or an arrival claim',
      'historical fragment and topology route queries return geometry/history facts and do not implement this name',
      'no host action registration, arbitration, scheduling, nesting or cancellation wiring',
    ],
    notes:
      'The nearest existing read-only primitives are historical queries. They neither select nor execute a route.',
  },
] as const satisfies readonly NavigationCapability[];
