/**
 * Host capability report (contract §2.3) for the voxel + facts composition.
 *
 * `false` is a contract fact, not advice. The retired fragment/topology/route
 * domains are not advertised: a host that needs them must treat the capability
 * as unavailable rather than fall back to a removed implementation.
 *
 * The report is deliberately split by domain so that partially wired hosts can
 * be honest. `memory` describes the evidence write port, `query` the read-only
 * projection and `persistence` the SQLite/working-set channel. Body execution
 * and route planning are host responsibilities and are not advertised here.
 */

export type ContractVersion = 'memory-host-contract/2';

export const CONTRACT_VERSION: ContractVersion = 'memory-host-contract/2';

export interface MemoryHostCapabilities {
  contract: ContractVersion;

  memory: {
    observeBatch: boolean;
    beginSession: boolean;
    markStale: boolean;
    markTraversed: boolean;
    markModified: boolean;
    checkpoint: boolean;
    flush: boolean;
    close: boolean;
  };
  query: {
    cells: boolean;
    /** Facts-backed semantic place projection. */
    nodes: boolean;
    /** Bounded places-only paging over semantic facts. */
    places: boolean;
    resourceAnchors: boolean;
    containerAnchors: boolean;
    /** Always false: container contents are owned by the host precise ledger. */
    containerContents: false;
    snapshot: boolean;
    capabilities: boolean;
  };
  persistence: {
    sqlite: boolean;
    manualResidency: boolean;
    workingSet: boolean;
    migrationAuthoritySwitch: boolean;
  };
}

// ---------------------------------------------------------------------------
// Library / host composition
// ---------------------------------------------------------------------------

export const CAPABILITY_DOMAINS = ['memory', 'query', 'persistence'] as const;

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
