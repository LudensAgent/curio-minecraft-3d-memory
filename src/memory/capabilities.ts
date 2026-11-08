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
    /** Additive to contract §2.3: never-observed boundary projection from a caller snapshot. */
    frontiers: boolean;
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

// ---------------------------------------------------------------------------
// Library / host composition (Batch 5 C)
// ---------------------------------------------------------------------------

export const CAPABILITY_DOMAINS = ['memory', 'query', 'plan', 'execute', 'persistence'] as const;

export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export type CapabilityNameOf<D extends CapabilityDomain> = keyof MemoryHostCapabilities[D];

/**
 * What a host reports about its own wiring. It may declare only the domains it
 * actually consumes; an omitted domain is not silently treated as supported.
 * A host declaration can never raise a library `false` to `true`.
 */
export type HostCapabilityDeclaration = {
  contract?: ContractVersion;
} & {
  [D in CapabilityDomain]?: Partial<Record<CapabilityNameOf<D>, boolean>>;
};

export interface ComposedCapabilityReport {
  /** The report is host-composed; `library` remains the library's own facts. */
  owner: 'host_composed';
  contract: ContractVersion;
  /** Exactly what the library reports; never rewritten by composition. */
  library: MemoryHostCapabilities;
  /** Exactly what the host declared; missing keys are not claims. */
  host: HostCapabilityDeclaration;
  /** Effective capability = library AND host (omitted host key = library value). */
  effective: MemoryHostCapabilities;
  /**
   * Host declarations that claim `true` for a library `false`. They are reported
   * for diagnostics and never raise `effective`; a host should not call them.
   */
  overclaims: { domain: CapabilityDomain; name: string }[];
}

/** A host and library disagree about the negotiated contract version. */
export class CapabilityContractError extends Error {
  readonly code = 'capability_contract_mismatch';
  readonly library: ContractVersion;
  readonly host: ContractVersion;

  constructor(library: ContractVersion, host: ContractVersion) {
    super(`host contract "${host}" does not match library contract "${library}"`);
    this.name = 'CapabilityContractError';
    this.library = library;
    this.host = host;
  }
}

/** A call was made for a capability the effective report does not grant. */
export class CapabilityUnavailableError extends Error {
  readonly code = 'unsupported';
  readonly domain: CapabilityDomain;
  readonly capability: string;

  constructor(domain: CapabilityDomain, capability: string, detail?: string) {
    super(detail ?? `capability ${domain}.${capability} is not available`);
    this.name = 'CapabilityUnavailableError';
    this.domain = domain;
    this.capability = capability;
  }
}

/**
 * Combine the library report with the host's own declaration. The effective
 * value is the intersection: a capability is available only when both sides
 * report `true`. Omitted host keys inherit the library value; a host may not
 * widen a `false` library fact.
 */
export function composeCapabilities(
  library: MemoryHostCapabilities,
  host: HostCapabilityDeclaration = {},
): ComposedCapabilityReport {
  if (host.contract !== undefined && host.contract !== library.contract) {
    throw new CapabilityContractError(library.contract, host.contract);
  }
  const effective = cloneCapabilities(library);
  const overclaims: ComposedCapabilityReport['overclaims'] = [];
  for (const domain of CAPABILITY_DOMAINS) {
    const hostDomain = host[domain] as Record<string, boolean | undefined> | undefined;
    if (hostDomain === undefined) continue;
    const libraryDomain = library[domain] as Record<string, unknown>;
    const effectiveDomain = effective[domain] as Record<string, unknown>;
    for (const [name, value] of Object.entries(hostDomain)) {
      if (value === undefined) continue;
      if (!(name in libraryDomain)) {
        overclaims.push({ domain, name });
        continue;
      }
      const libraryValue = libraryDomain[name] === true;
      if (value === true && !libraryValue) overclaims.push({ domain, name });
      // Intersection, never union: the host cannot add a library capability.
      effectiveDomain[name] = libraryValue && value === true;
    }
  }
  return {
    owner: 'host_composed',
    contract: library.contract,
    library: cloneCapabilities(library),
    host: cloneHostDeclaration(host),
    effective,
    overclaims,
  };
}

/** Read one effective capability; unknown domain/name reads `false`. */
export function hasCapability(
  report: MemoryHostCapabilities | ComposedCapabilityReport,
  domain: CapabilityDomain,
  name: string,
): boolean {
  const effective = 'effective' in report ? report.effective : report;
  const domainValues = effective[domain] as Record<string, unknown> | undefined;
  return domainValues?.[name] === true;
}

/**
 * Throw `CapabilityUnavailableError` (`code:'unsupported'`) instead of calling a
 * capability the effective report does not grant. Use this at the call boundary
 * so a `false` capability is an explicit refusal, not a silent no-op or a
 * native error from an unwired backend.
 */
export function requireCapability(
  report: MemoryHostCapabilities | ComposedCapabilityReport,
  domain: CapabilityDomain,
  name: string,
): void {
  if (!hasCapability(report, domain, name)) {
    throw new CapabilityUnavailableError(domain, name);
  }
}

function cloneCapabilities(report: MemoryHostCapabilities): MemoryHostCapabilities {
  return {
    contract: report.contract,
    memory: { ...report.memory },
    query: { ...report.query },
    plan: { ...report.plan },
    execute: { ...report.execute },
    persistence: { ...report.persistence },
  };
}

function cloneHostDeclaration(host: HostCapabilityDeclaration): HostCapabilityDeclaration {
  const clone: HostCapabilityDeclaration = { ...host };
  for (const domain of CAPABILITY_DOMAINS) {
    const value = host[domain] as Record<string, boolean | undefined> | undefined;
    if (value !== undefined) (clone as Record<string, unknown>)[domain] = { ...value };
  }
  return clone;
}
