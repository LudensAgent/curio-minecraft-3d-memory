/**
 * Volatile route-handle registry (contract §6.6, implementation plan M3.6).
 *
 * A `RoutePlanRegistry` turns a planning result into a single-use `routeId`.
 * The registry is intentionally in-memory only:
 *
 * - it is bounded by a capacity (default 128) and a TTL (default 30 s, never
 *   extending a plan's own `expiresAt`);
 * - the first `consume` marks the handle consumed even when a later scope,
 *   expiry or executability check fails, so a failed start still needs a fresh
 *   plan;
 * - a successfully consumed plan is pinned until `release`, so an active
 *   execution cannot be evicted by later registrations;
 * - consumed handles are retained as tombstones (bounded by capacity) so a
 *   second call reports `route_consumed` rather than `route_not_found`;
 * - it never persists, never restores a route across a process restart and
 *   never accepts a host-invented id: only ids returned by `register` exist.
 *
 * The registry does not plan, verify, move or observe. It only performs the
 * atomic handle bookkeeping described above.
 */

import type {
  RouteEvidence,
  RoutePlan,
  RoutePlanDraft,
  RoutePlanRegistrar,
  RoutePlanScope,
  RouteUnsupported,
} from './route-plan-types.js';
import {
  cloneBoundary,
  cloneEvidence,
  clonePoint,
  cloneUnsupported,
} from './route-plan-support.js';

export type RoutePlanRegistryProblem =
  | { kind: 'invalid_request'; detail: string }
  | { kind: 'route_not_found'; routeId: string }
  | { kind: 'route_consumed'; routeId: string }
  | { kind: 'route_expired'; routeId: string; expiresAt: number }
  | { kind: 'scope_mismatch'; routeId: string; expected: RoutePlanScope; actual: RoutePlanScope }
  | { kind: 'route_not_executable'; routeId: string; reason: string };

export interface RoutePlanRegistryOptions {
  /** Maximum retained handles (available + pinned + consumed tombstones). Defaults to 128. */
  capacity?: number;
  /** Maximum handle lifetime in ms from registration. Defaults to 30 000. */
  ttlMs?: number;
  /** Clock used for registration/eviction bookkeeping; defaults to `Date.now`. */
  now?: () => number;
}

export interface RoutePlanRegistry extends RoutePlanRegistrar {
  /**
   * Atomically consume a handle. The handle is marked consumed even when the
   * expiry/scope/executability check that follows rejects it.
   */
  consume(routeId: string, scope: RoutePlanScope, now: number): RoutePlan | RoutePlanRegistryProblem;
  /** Release an execution pin after a terminal outcome; the handle stays consumed. */
  release(routeId: string): void;
  /** Retained handles, including consumed tombstones. */
  readonly size: number;
}

interface RegistryEntry {
  plan: RoutePlan;
  consumed: boolean;
  pinned: boolean;
  order: number;
}

const DEFAULT_CAPACITY = 128;
const DEFAULT_TTL_MS = 30_000;

/** Thrown when every retained handle is pinned by an active execution. */
export class RoutePlanRegistryCapacityError extends Error {
  override readonly name = 'RoutePlanRegistryCapacityError';
}

/**
 * Bounded in-memory route-handle registry. Create one per host process; it is
 * not a persistence layer and holds no world state.
 *
 * @example
 * ```ts
 * const registry = new RoutePlanRegistryImpl({ capacity: 64, ttlMs: 30_000 });
 * const plan = registry.register(draft); // routeId issued here
 * const consumed = registry.consume(plan.routeId, { worldId, dim, sessionId }, now);
 * if (!('kind' in consumed)) {
 *   startExecution(consumed); // caller-owned; release after the terminal outcome
 *   registry.release(plan.routeId);
 * }
 * ```
 */
export class RoutePlanRegistryImpl implements RoutePlanRegistry {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, RegistryEntry>();
  private nextOrdinal = 0;

  constructor(options: RoutePlanRegistryOptions = {}) {
    this.capacity = resolvePositiveInteger(options.capacity, DEFAULT_CAPACITY, 'capacity');
    this.ttlMs = resolvePositiveInteger(options.ttlMs, DEFAULT_TTL_MS, 'ttlMs');
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  register(draft: RoutePlanDraft): RoutePlan {
    const registeredAt = this.now();
    if (!Number.isFinite(registeredAt)) {
      throw new Error(`registry now() must return a finite number: ${registeredAt}`);
    }
    if (!Number.isFinite(draft.expiresAt)) {
      throw new Error('a route plan must have a finite expiresAt');
    }
    if (!Array.isArray(draft.points) || draft.points.length === 0) {
      throw new Error('a route plan must carry at least one point');
    }
    this.ensureCapacity(registeredAt);

    this.nextOrdinal += 1;
    const plan: RoutePlan = {
      ...cloneDraft(draft),
      routeId: `rt_${registeredAt}_${this.nextOrdinal}`,
      // The registry never extends a plan beyond its own expiry or its TTL.
      expiresAt: Math.min(draft.expiresAt, registeredAt + this.ttlMs),
    };
    this.entries.set(plan.routeId, {
      plan,
      consumed: false,
      pinned: false,
      order: this.nextOrdinal,
    });
    return clonePlan(plan);
  }

  consume(routeId: string, scope: RoutePlanScope, now: number): RoutePlan | RoutePlanRegistryProblem {
    if (!Number.isFinite(now)) {
      return { kind: 'invalid_request', detail: `consume now must be a finite epoch time: ${now}` };
    }
    const entry = this.entries.get(routeId);
    if (entry === undefined) return { kind: 'route_not_found', routeId };
    if (entry.consumed) return { kind: 'route_consumed', routeId };

    // The first call consumes the handle even if the checks below fail.
    entry.consumed = true;

    if (now > entry.plan.expiresAt) {
      return { kind: 'route_expired', routeId, expiresAt: entry.plan.expiresAt };
    }
    if (
      scope.worldId !== entry.plan.evidence.worldId ||
      scope.dim !== entry.plan.evidence.dim ||
      scope.sessionId !== entry.plan.evidence.sessionId
    ) {
      return {
        kind: 'scope_mismatch',
        routeId,
        expected: routeScopeOf(entry.plan.evidence),
        actual: cloneScope(scope),
      };
    }
    if (!entry.plan.executable) {
      return {
        kind: 'route_not_executable',
        routeId,
        reason: `plan confidence is "${entry.plan.confidence}"${entry.plan.unsupported === undefined ? '' : `: ${unsupportedDetail(entry.plan.unsupported)}`}`,
      };
    }

    // An executable handle becomes an active execution; capacity eviction must
    // not drop it until the execution reports a terminal outcome.
    entry.pinned = true;
    return clonePlan(entry.plan);
  }

  release(routeId: string): void {
    const entry = this.entries.get(routeId);
    if (entry !== undefined) entry.pinned = false;
  }

  // --- internals ---

  /** Purge expired handles and evict the oldest non-pinned one when full. */
  private ensureCapacity(now: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.pinned && now > entry.plan.expiresAt) this.entries.delete(id);
    }
    while (this.entries.size >= this.capacity) {
      const victim = this.oldestEvictable();
      if (victim === null) {
        throw new RoutePlanRegistryCapacityError(
          `route plan registry is full (capacity ${this.capacity}); every retained handle is pinned by an active execution`,
        );
      }
      this.entries.delete(victim);
    }
  }

  /** Prefer consumed tombstones, then the oldest available; never a pinned entry. */
  private oldestEvictable(): string | null {
    let consumedVictim: RegistryEntry | null = null;
    let availableVictim: RegistryEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.pinned) continue;
      if (entry.consumed) {
        if (consumedVictim === null || entry.order < consumedVictim.order) consumedVictim = entry;
      } else if (availableVictim === null || entry.order < availableVictim.order) {
        availableVictim = entry;
      }
    }
    const victim = consumedVictim ?? availableVictim;
    if (victim === null) return null;
    for (const [id, entry] of this.entries) {
      if (entry === victim) return id;
    }
    return null;
  }
}

function resolvePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer: ${resolved}`);
  }
  return resolved;
}

function routeScopeOf(evidence: RouteEvidence): RoutePlanScope {
  return {
    worldId: evidence.worldId,
    dim: evidence.dim,
    sessionId: evidence.sessionId,
  };
}

function cloneScope(scope: RoutePlanScope): RoutePlanScope {
  return { worldId: scope.worldId, dim: scope.dim, sessionId: scope.sessionId };
}

function cloneDraft(draft: RoutePlanDraft): RoutePlanDraft {
  return {
    ...draft,
    points: draft.points.map(clonePoint),
    segments: draft.segments.map((segment) => ({
      index: segment.index,
      mode: segment.mode,
      points: segment.points.map(clonePoint),
      cost: segment.cost,
    })),
    boundaries: draft.boundaries.map(cloneBoundary),
    ...(draft.unsupported === undefined ? {} : { unsupported: cloneUnsupported(draft.unsupported) }),
    evidence: cloneEvidence(draft.evidence),
    requestedTarget: clonePoint(draft.requestedTarget),
    resolvedTarget: clonePoint(draft.resolvedTarget),
    start: clonePoint(draft.start),
  };
}

function clonePlan(plan: RoutePlan): RoutePlan {
  return { ...cloneDraft(plan), routeId: plan.routeId };
}

function unsupportedDetail(unsupported: RouteUnsupported): string {
  return 'detail' in unsupported
    ? unsupported.detail
    : `required cells are unobserved: (${unsupported.gap.pos.x}, ${unsupported.gap.pos.y}, ${unsupported.gap.pos.z})`;
}
