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
    status: 'implemented',
    entry: ['navigateTo'],
    contracts: ['NavigateRequest', 'NavResult', 'NavProblem', 'ActionRecord', 'NavigateEnvironment'],
    seams: ['WalkRouteSearch', 'WalkRouteExecutor', 'RouteVerifier'],
    effects: {
      movesBody: true,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: true,
    },
    supported: [
      'measured start, bounded WalkRouteSearch, per-segment re-verification and execution through a caller-supplied WalkRouteExecutor',
      'exact foot-position arrival only, confirmed from the executor result and a measured lastPosition plus lastObservation',
      'returns ARRIVED immediately from a measured position already satisfying the exact target, without generating a route',
      'structured NO_PATH, BLOCKED, CANCELLED, TIMEOUT, unsupported, unobserved, budget and execution failures; a search candidate or budget stop is never an arrival',
      'cancellation and timeout preserve measured displacement, last observation and original trace',
      'explicit segmented delegations report PARTIAL only when an earlier segment completed and a later one failed',
      'one ActionRecord per delegation with requested target, parsed target, modes, arrival, flags, materials, exploration, sub-actions and confirmed outcome',
      'optional host memory-write callback; the library never claims saved without the host status',
    ],
    unsupported: [
      'near or reach_block arrival',
      'non-walk modes (jump, swim, climb, ladder, drop, sneak)',
      'digging, placing, towering and material spending',
      'non-empty avoid constraints and frontier exploration',
      'host action registration, arbitration, scheduling, nesting, prompt or action-catalog wiring',
      'automatic target substitution, rescue, retry escalation or world observation',
      'real Minecraft/mineflayer execution; this table describes the library pipeline only',
    ],
    notes:
      'The caller supplies the search source, executor, shape provider, body, measured sample provider, clock and budgets. movesBody is true because the entry drives WalkRouteExecutor.advance(); the body itself remains the caller-supplied MoveExecutor. writesLibrary stays false: persistence is an optional host callback.',
  },
  {
    name: 'follow_known_path',
    status: 'implemented',
    entry: ['startKnownWalkRoute', 'followKnownPath'],
    contracts: ['FollowKnownPathRequest', 'KnownWalkRouteRequest', 'KnownWalkRouteStart', 'KnownWalkRouteSnapshot'],
    seams: ['WalkRouteExecutor', 'FragmentStore.getFragment'],
    effects: {
      movesBody: true,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: true,
    },
    supported: [
      'select one caller-named historical fragment (pathId, or the fragmentId alias) and start its stored polyline on a caller-supplied WalkRouteExecutor',
      'optionally drive the started delegation to a measured NavResult with the same driver as navigateTo (drive: true)',
      'walk mode only; exact foot-position arrival only',
      'same-height, one-cell ±X/±Z polyline with a correct scope, start and point budget',
      'history is read as geometry; the executor still verifies every segment against current evidence',
    ],
    unsupported: [
      'near or reach_block arrival',
      'non-walk modes',
      'non-empty avoid constraints',
      'diagonal, duplicate-point or height-changing stored geometry',
      'navigating, selecting or switching to another path',
      'host action registration, arbitration, nesting and scheduler cancellation',
      'movement when drive is false; the start boundary registers a delegation but does not call MoveExecutor.move',
    ],
    notes:
      'movesBody applies only when environment.drive is true. With drive false (default) this is still the §7 start boundary and body steps begin only when the caller drives WalkRouteExecutor.advance().',
  },
  {
    name: 'inspect_route',
    status: 'read_only',
    entry: ['inspectRoute', 'inspectKnownRoute'],
    contracts: ['RouteInspection', 'RouteBoundaryFact', 'KnownRouteInspection', 'KnownRouteEvidence'],
    seams: ['WalkSearchSnapshot', 'FragmentStore.getFragment', 'FragmentStore.traversals'],
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
      'pure projection of one stored fragment: geometry, ends, legacy links, source precision and bounded historical traversal records',
      'current openness and freshness are explicitly unknown unless the caller supplies evidence; even supplied evidence never yields "open" without whole-route coverage',
    ],
    unsupported: [
      'no map, world or section load; no observation; no pin; no save; no world read',
      'no evidence revalidation or implicit rescan',
      'no movement, head turn or action start',
      'no arrival confirmation',
      'no fabricated current-open claim from history',
    ],
    notes:
      'Both entries take data the caller already holds. Freshness means the supplied snapshot/evidence fields only; it is not a new observation.',
  },
  {
    name: 'frontier_candidates',
    status: 'read_only',
    entry: ['frontierCandidates'],
    contracts: ['FrontierCandidatesResult', 'FrontierCandidateView', 'FrontierCandidatesOptions'],
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
      'optional caller-supplied history lookup can report historicalConnection true/false for a candidate',
    ],
    unsupported: [
      'no target selection or ranking',
      'no exploration start or world scan',
      'no topology lookup by this module; absent a caller lookup, historicalConnection stays "unknown"',
      'no reachability claim for the boundary point or gap',
      'no movement, head turn, observation, pin or save',
    ],
    notes:
      'The list is bounded by the search snapshot maxFrontiers; truncated reports the snapshot counter. Only the caller-supplied lookup can emit a boolean historicalConnection; the library never fabricates one.',
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
