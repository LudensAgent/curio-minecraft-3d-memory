/**
 * Host capability report (contract §2.3).
 *
 * This is the machine-checkable contract between the library and a host:
 * `false` is a contract fact, not advice. The host must check the relevant
 * capability before calling an interface, and must never silently fall back to
 * a wider backend when the answer is `false`.
 *
 * The report is deliberately split by domain so that partially wired hosts can
 * be honest. M2 fills `memory` from the store's per-method report and `query`
 * from the implemented query kinds. `plan` landed as a static M3 report and is
 * consolidated here as the single source in M5.4; `execute`/`persistence` remain
 * `false` (D-059).
 *
 * Additive note: `query.resourceAnchors` and `query.segments` are not present
 * in contract §2.3 v0.1; they are added because the request union exposes those
 * kinds and the host must be able to negotiate them. `query.containerContents`
 * stays a literal `false`: container contents belong to the host's precise
 * inventory ledger.
 *
 * Version note: adding the `containerContents`/`segments` kinds and requiring
 * `SpatialMemoryStore.query` are contract changes under §12.3. The pre-release
 * string remains `memory-host-contract/1` until M9 decides and synchronizes the
 * release version; hosts must negotiate capabilities rather than assume v1.
 *
 * Single source (D-010): `RoutePlanCapabilities` and `ROUTE_PLAN_CAPABILITIES`
 * live here, in the dependency-free memory core, and are consumed by both the
 * navigation layer and the query capability report. A pure-memory consumer can
 * therefore negotiate the plan block without importing `src/navigation/*`.
 */

export type ContractVersion = 'memory-host-contract/1';

export const CONTRACT_VERSION: ContractVersion = 'memory-host-contract/1';

/**
 * Planning capability report for the optional `planRoute` entry (contract §2.3
 * `plan`, plan M3.7; consolidated here in M5.4).
 *
 * `false` is a contract fact: the host must not call or emulate that planning
 * mode through `planRoute`. In particular near/reach_block arrival, digging,
 * placing, towering, swimming and boating are not planned in v1; unsupported
 * requests are rejected with structured problems rather than silently routed
 * to a wider backend.
 */
export interface RoutePlanCapabilities {
  walkSearch: boolean;
  walkHistory: boolean;
  walkAuto: boolean;
  nearArrival: boolean;
  reachBlockArrival: boolean;
  digPlaceTower: boolean;
  swim: boolean;
  boat: boolean;
}

export type RoutePlanCapabilityName = keyof RoutePlanCapabilities;

export const ROUTE_PLAN_CAPABILITIES = Object.freeze({
  walkSearch: true,
  walkHistory: true,
  walkAuto: true,
  nearArrival: false,
  reachBlockArrival: false,
  digPlaceTower: false,
  swim: false,
  boat: false,
} as const satisfies RoutePlanCapabilities);

export interface MemoryHostCapabilities {
  contract: ContractVersion;
  memory: {
    observeBatch: boolean;
    beginSession: boolean;
    markStale: boolean;
    markTraversed: boolean;
    markModified: boolean;
    saveFragment: boolean;
    addTraversal: boolean;
    recordNode: boolean;
    upsertEdge: boolean;
    savePortalEdge: boolean;
    checkpoint: boolean;
    flush: boolean;
    close: boolean;
  };
  query: {
    cells: boolean;
    fragments: boolean;
    traversals: boolean;
    nodes: boolean;
    edges: boolean;
    historyRoute: boolean;
    anchors: boolean;
    components: boolean;
    segments: boolean;
    portals: boolean;
    /** Additive to contract §2.3: resource anchors are a separate query kind. */
    resourceAnchors: boolean;
    containerAnchors: boolean;
    /** Always false: container contents are owned by the host precise ledger. */
    containerContents: false;
  };
  plan: RoutePlanCapabilities;
  execute: {
    walk: boolean;
    groundedArrival: boolean;
    invalidation: boolean;
    cancellation: boolean;
    swim: boolean;
    boat: boolean;
  };
  persistence: {
    sqlite: boolean;
    manualResidency: boolean;
    workingSet: boolean;
    migrationAuthoritySwitch: boolean;
  };
}
