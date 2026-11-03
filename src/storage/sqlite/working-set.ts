/**
 * Bounded working-set management (phase 5D2).
 *
 * `WorkingSetManager` is an explicit, caller-enabled composition over a manual
 * `SpatialSession`. It turns "submit the sections you need now" into a bounded
 * prepare loop that validates the whole request, protects the request set with a
 * temporary pin lease, evicts least-recently-used *eligible* sections within fixed
 * candidate/unload budgets, loads the missing sections through the session's single
 * worker, and returns an accurate result plus the protection lease.
 *
 * It never becomes a second authority over spatial facts, dirty state, or save
 * confirmation: every load/install/unload/pin goes through the existing
 * `SpatialSession` / `VoxelMap` entry points, whose residency generation, safe
 * unload, and exact resident-byte accounting remain the single source of truth. The
 * LRU order here is runtime cache metadata only (see `LruOrder`): it never persists,
 * never refreshes evidence time, and never substitutes for observed-at / sequence /
 * revision / save batch.
 *
 * Read-only queries (`stats`) do not load, evict, save, or scan the world; they
 * only read the in-memory resident set (bounded by `maxResidentSections`) and the
 * manager's own LRU index.
 */

import { sectionKeyString } from '../../voxel/section.js';
import type { SectionKey } from '../../voxel/section.js';
import { LruOrder } from '../../voxel/lru.js';
import type { ResolvedResidencyLimits, UnloadRejectionReason } from '../../voxel/residency.js';
import { estimateVoxelSectionResidentBytesFromCommitted } from '../../voxel/snapshot.js';
import { PersistenceError } from './types.js';
import type { SpatialSession } from './types.js';

/** Bounds on the manager's own processing (candidate checks, unloads, diagnostics). */
export interface WorkingSetLimits {
  /** Maximum candidate sections examined in one prepare/free. Default 1024. */
  maxEvictionCandidates?: number;
  /** Maximum sections unloaded in one prepare/free. Default 512. */
  maxUnloadSections?: number;
  /** Maximum diagnostic strings reported in one result. Default 256. */
  maxDiagnostics?: number;
}

/** `WorkingSetLimits` with every default resolved and validated. */
export interface ResolvedWorkingSetLimits {
  maxEvictionCandidates: number;
  maxUnloadSections: number;
  maxDiagnostics: number;
}

/** A bounded, structured capacity/failure outcome of `prepare` / `free`. */
export type CapacityGapKind =
  | 'request_too_large'
  | 'no_eligible_candidates'
  | 'candidate_budget_exhausted'
  | 'unload_budget_exhausted'
  | 'count_capacity'
  | 'byte_capacity'
  | 'busy'
  | 'closed'
  | 'read_failed';

export interface CapacityGap {
  kind: CapacityGapKind;
  message: string;
}

/** Why a candidate section was kept during eviction (the map's safe-unload refusal). */
export interface EvictionRejection {
  key: SectionKey;
  reason: UnloadRejectionReason;
}

/**
 * The outcome of a `prepare` request.
 *
 * - `ready`: every requested section is resident *and* protected by the returned
 *   lease; `prepared` is the full request and `capacity` is null.
 * - `incomplete`: no hard failure, but some requested sections have no committed
 *   record (`noRecord`) or are not loadable now (`notReady`). The temporary lease
 *   is released, so `prepared` is empty and `lease` is empty — "prepared" always
 *   reflects the actual protection state.
 * - `failed`: a hard failure (a capacity gap, a failed read, or — before any
 *   mutation — a busy/closed session, which throws instead). The temporary lease is
 *   released; `prepared` is empty and `lease` is empty.
 */
export type PrepareStatus = 'ready' | 'incomplete' | 'failed';

/** Result of `prepare`: an accurate account of what was prepared, evicted, and why. */
export interface PrepareResult {
  worldId: string;
  status: PrepareStatus;
  /** The full request when `status === 'ready'`; empty otherwise. */
  prepared: SectionKey[];
  /** Request sections that were already resident before this call. */
  alreadyResident: SectionKey[];
  /** Request sections loaded by this call. */
  loaded: SectionKey[];
  /** Request sections with no committed record (never fabricated, never observed). */
  noRecord: SectionKey[];
  /** Request sections that are loading or failed a previous load (not prepared now). */
  notReady: SectionKey[];
  /** Sections evicted this call to make room. */
  evicted: SectionKey[];
  /** Candidates kept during eviction, with the map's structured refusal reason. */
  evictionRejected: EvictionRejection[];
  /** The bounded capacity/failure outcome; non-null only when `status === 'failed'`. */
  capacity: CapacityGap | null;
  /**
   * The protection lease over the prepared sections, handed to the caller. Valid
   * (non-empty token) only when `status === 'ready'`; the caller owns release, and a
   * late release never drops a newer lease.
   */
  lease: { token: string; keys: SectionKey[] };
  diagnostics: string[];
}

/** Result of `free`: which sections were released and why the rest were kept. */
export interface FreeResult {
  evicted: SectionKey[];
  evictionRejected: EvictionRejection[];
  capacity: CapacityGap | null;
  diagnostics: string[];
}

/** Bounded read-only snapshot of the working set. */
export interface WorkingSetStats {
  residentSections: number;
  residentBytes: number;
  maxResidentSections: number;
  maxResidentBytes: number;
  /** Number of keys the LRU index currently tracks (reconciled to residency). */
  lruTracked: number;
  /** Active pin leases and distinct pinned sections (across the whole session). */
  pinnedLeases: number;
  pinnedSections: number;
}

const DEFAULT_MAX_EVICTION_CANDIDATES = 1024;
const DEFAULT_MAX_UNLOAD_SECTIONS = 512;
const DEFAULT_MAX_DIAGNOSTICS = 256;

/** Resolve and validate the manager's own processing bounds. */
export function resolveWorkingSetLimits(options: WorkingSetLimits | undefined): ResolvedWorkingSetLimits {
  const limits: ResolvedWorkingSetLimits = {
    maxEvictionCandidates: DEFAULT_MAX_EVICTION_CANDIDATES,
    maxUnloadSections: DEFAULT_MAX_UNLOAD_SECTIONS,
    maxDiagnostics: DEFAULT_MAX_DIAGNOSTICS,
  };
  if (options === undefined) return limits;
  const keys = ['maxEvictionCandidates', 'maxUnloadSections', 'maxDiagnostics'] as const;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new PersistenceError('invalid_argument', `${key} must be a positive safe integer: ${String(value)}`);
    }
    limits[key] = value;
  }
  return limits;
}

/**
 * Bounded working-set manager over a manual `SpatialSession`.
 *
 * The caller enables this explicitly by constructing it; the default eager session
 * behavior is untouched. It reuses the session's `loadSections` / `unloadSections` /
 * `pinSections` / `releasePins` / `sectionResidency` and the map's resident
 * accounting, never a parallel load/unload path.
 */
export class WorkingSetManager {
  private readonly session: SpatialSession;
  private readonly residency: ResolvedResidencyLimits;
  private readonly bounds: ResolvedWorkingSetLimits;
  private readonly lru = new LruOrder();
  /** Section key string → SectionKey, rebuilt from the resident set on reconcile. */
  private readonly keyIndex = new Map<string, SectionKey>();
  /** Re-entrancy guard: serializes prepare/free across their (async) duration. */
  private operationInFlight = false;

  constructor(session: SpatialSession, options: WorkingSetLimits = {}) {
    if (session.voxelLoading !== 'manual') {
      throw new PersistenceError('invalid_argument', 'WorkingSetManager requires a manual-residency session');
    }
    this.session = session;
    this.residency = session.residencyLimits;
    this.bounds = resolveWorkingSetLimits(options);
  }

  /**
   * Explicitly prepare a set of sections: validate, protect, evict to fit, load,
   * and return the resident + protected set with a lease. Never observes the world,
   * never fabricates a section for a missing record, and never treats a load as a
   * current observation or an OPEN passability conclusion.
   *
   * Throws `PersistenceError` (before any mutation) when the session is busy,
   * closing or closed, or when another manager operation is in flight.
   */
  async prepare(keys: readonly SectionKey[]): Promise<PrepareResult> {
    this.acquireGate();
    try {
      return await this.prepareGuarded(keys);
    } finally {
      this.releaseGate();
    }
  }

  private async prepareGuarded(keys: readonly SectionKey[]): Promise<PrepareResult> {
    const worldId = this.session.voxel.worldId;
    const diagnostics = new DiagnosticBuffer(this.bounds.maxDiagnostics);
    const result: PrepareResult = {
      worldId,
      status: 'failed',
      prepared: [],
      alreadyResident: [],
      loaded: [],
      noRecord: [],
      notReady: [],
      evicted: [],
      evictionRejected: [],
      capacity: null,
      lease: { token: '', keys: [] },
      diagnostics: diagnostics.items,
    };

    const deduped = this.validateKeys(keys);
    if (deduped.length > this.residency.maxLoadBatchSections) {
      result.capacity = this.gap(
        'request_too_large',
        `request has ${deduped.length} sections, exceeding maxLoadBatchSections (${this.residency.maxLoadBatchSections})`,
      );
      diagnostics.push(result.capacity.message);
      return result;
    }

    const resident: SectionKey[] = [];
    const toLoad: SectionKey[] = [];
    for (const key of deduped) {
      switch (this.session.sectionResidency(key).residency) {
        case 'resident':
          resident.push(key);
          break;
        case 'not_resident':
          toLoad.push(key);
          break;
        case 'no_record':
          result.noRecord.push(key);
          break;
        case 'loading':
        case 'load_failed':
          result.notReady.push(key);
          break;
      }
    }

    // Sound count pre-check: the request alone cannot fit even an empty working set.
    // Reject before any eviction so an impossible request has no side effects.
    if (toLoad.length > this.residency.maxResidentSections) {
      result.capacity = this.gap(
        'count_capacity',
        `request has ${toLoad.length} sections to load, exceeding maxResidentSections (${this.residency.maxResidentSections})`,
      );
      diagnostics.push(result.capacity.message);
      return result;
    }

    result.alreadyResident = resident.map((k) => ({ ...k }));

    // Protect the sections that are (or will be) resident, so the manager can never
    // evict the first half of the request to make room for the second half. noRecord
    // and notReady sections are not resident and need no protection.
    const protectedKeys = [...resident, ...toLoad];
    let lease: { token: string; keys: SectionKey[] };
    try {
      lease = this.session.pinSections(protectedKeys);
    } catch (err) {
      // Over the pin budget (maxPins / maxPinnedSections): nothing was evicted yet.
      throw this.toPersistenceError(err);
    }

    let hardFailure = false;
    try {
      this.reconcile();
      // A successful request hit (an already-resident section) advances its LRU
      // position; a load inserts it at MRU below. Both are runtime cache metadata.
      for (const key of resident) this.lru.touch(sectionKeyString(key));
      const protectedSet = new Set(protectedKeys.map(sectionKeyString));

      const eviction = this.evictToFit(toLoad, protectedSet, diagnostics);
      result.evicted = eviction.evicted.map((k) => ({ ...k }));
      result.evictionRejected = eviction.rejected.map((r) => ({ key: { ...r.key }, reason: r.reason }));
      if (eviction.gap !== null) {
        result.capacity = eviction.gap;
        hardFailure = true;
      }

      if (toLoad.length > 0 && !hardFailure) {
        try {
          const loaded = await this.session.loadSections(toLoad);
          result.loaded = loaded.loaded.map((k) => ({ ...k }));
          for (const key of loaded.loaded) this.lru.insert(sectionKeyString(key));
          for (const missing of loaded.missing) result.noRecord.push({ ...missing });
          this.reconcile();
        } catch (err) {
          result.capacity = this.mapLoadError(err);
          hardFailure = true;
        }
      }
    } finally {
      // Status and lease/protection must be consistent: only a fully-prepared,
      // fully-protected request is "ready" and keeps the lease; anything else releases
      // the temporary lease and reports `prepared` as empty.
      const complete = !hardFailure && result.noRecord.length === 0 && result.notReady.length === 0;
      if (hardFailure) {
        result.status = 'failed';
        this.session.releasePins([lease.token]);
        result.lease = { token: '', keys: [] };
        result.prepared = [];
      } else if (!complete) {
        result.status = 'incomplete';
        this.session.releasePins([lease.token]);
        result.lease = { token: '', keys: [] };
        result.prepared = [];
      } else {
        result.status = 'ready';
        result.lease = { token: lease.token, keys: lease.keys.map((k) => ({ ...k })) };
        result.prepared = deduped.map((k) => ({ ...k }));
      }
    }

    for (const key of result.loaded) diagnostics.push(`loaded ${fmt(key)}`);
    for (const key of result.evicted) diagnostics.push(`evicted ${fmt(key)}`);
    return result;
  }

  /**
   * Explicitly free space: evict LRU-eligible sections (oldest first) until the
   * resident working set is at or under `target.sections` / `target.bytes`, or until
   * no eligible candidate or a bound is exhausted. With no target, it evicts every
   * eligible section within `maxUnloadSections`.
   *
   * Throws `PersistenceError` on an invalid (negative/non-integer) target, or when
   * the session is busy/closing/closed or another manager operation is in flight —
   * always before any mutation.
   */
  free(target?: { sections?: number; bytes?: number }): FreeResult {
    this.acquireGate();
    try {
      const diagnostics = new DiagnosticBuffer(this.bounds.maxDiagnostics);
      const result: FreeResult = { evicted: [], evictionRejected: [], capacity: null, diagnostics: diagnostics.items };

      if (target !== undefined && target.sections !== undefined && (!Number.isSafeInteger(target.sections) || target.sections < 0)) {
        throw new PersistenceError('invalid_argument', `free target.sections must be a non-negative safe integer: ${String(target.sections)}`);
      }
      if (target !== undefined && target.bytes !== undefined && (!Number.isSafeInteger(target.bytes) || target.bytes < 0)) {
        throw new PersistenceError('invalid_argument', `free target.bytes must be a non-negative safe integer: ${String(target.bytes)}`);
      }

      this.reconcile();
      const candidates = this.lru.oldestFirst();
      let cursor = 0;
      let candidateChecks = 0;
      let unloadCount = 0;

      for (;;) {
        if (target !== undefined) {
          const size = this.session.voxel.residentSize();
          const countOk = target.sections === undefined || size.sections <= target.sections;
          const bytesOk = target.bytes === undefined || size.bytes <= target.bytes;
          if (countOk && bytesOk) break;
        }

        const next = this.nextCandidate(candidates, cursor, EMPTY_SET);
        if (next === null) {
          // No target means "evict everything eligible"; exhausting candidates is the
          // success condition, not a gap. Only a target reports an unreachable gap.
          if (target !== undefined) {
            result.capacity = this.gap('no_eligible_candidates', 'no eligible section is available to evict');
            diagnostics.push(result.capacity.message);
          }
          break;
        }
        cursor = next.cursor;
        candidateChecks += 1;
        if (candidateChecks > this.bounds.maxEvictionCandidates) {
          result.capacity = this.gap(
            'candidate_budget_exhausted',
            `candidate checks exceeded maxEvictionCandidates (${this.bounds.maxEvictionCandidates})`,
          );
          diagnostics.push(result.capacity.message);
          break;
        }
        if (unloadCount >= this.bounds.maxUnloadSections) {
          result.capacity = this.gap(
            'unload_budget_exhausted',
            `unloads reached maxUnloadSections (${this.bounds.maxUnloadSections})`,
          );
          diagnostics.push(result.capacity.message);
          break;
        }

        const res = this.session.unloadSections([next.candidate]);
        if (res.unloaded.length === 1) {
          result.evicted.push({ ...next.candidate });
          this.lru.remove(sectionKeyString(next.candidate));
          diagnostics.push(`evicted ${fmt(next.candidate)}`);
          unloadCount += 1;
        } else {
          const reason = res.rejected[0]?.reason ?? 'not_committed';
          result.evictionRejected.push({ key: { ...next.candidate }, reason });
        }
      }
      return result;
    } finally {
      this.releaseGate();
    }
  }

  /** Bounded read-only snapshot of the working set (no load/evict/save/world scan). */
  stats(): WorkingSetStats {
    this.reconcile();
    const size = this.session.voxel.residentSize();
    const pins = this.session.voxel.pinState();
    return {
      residentSections: size.sections,
      residentBytes: size.bytes,
      maxResidentSections: this.residency.maxResidentSections,
      maxResidentBytes: this.residency.maxResidentBytes,
      lruTracked: this.lru.size,
      pinnedLeases: pins.leases,
      pinnedSections: pins.pinnedSections,
    };
  }

  // --- internals ---

  /** Acquire the session-level operation gate before any pin/LRU/unload mutation. */
  private acquireGate(): void {
    if (this.operationInFlight) {
      throw new PersistenceError('busy', 'another working-set operation is in flight');
    }
    const lifecycle = this.session.lifecycle;
    if (lifecycle === 'closing') {
      throw new PersistenceError('closing', 'session is closing; working-set operations are not accepted');
    }
    if (lifecycle === 'closed') {
      throw new PersistenceError('closed', 'session is closed; working-set operations are not accepted');
    }
    if (this.session.busy) {
      throw new PersistenceError('busy', 'a persistence request is in flight');
    }
    this.operationInFlight = true;
  }

  private releaseGate(): void {
    this.operationInFlight = false;
  }

  /** Validate every key (scope, dim, integer coords) before any state change. */
  private validateKeys(keys: readonly SectionKey[]): SectionKey[] {
    const worldId = this.session.voxel.worldId;
    const out: SectionKey[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (key.worldId !== worldId) {
        throw new PersistenceError(
          'invalid_argument',
          `section key worldId "${key.worldId}" does not match session worldId "${worldId}"`,
        );
      }
      if (typeof key.dim !== 'string' || key.dim.length === 0) {
        throw new PersistenceError('invalid_argument', 'section key dim must be a non-empty string');
      }
      if (!Number.isInteger(key.cx) || !Number.isInteger(key.cz) || !Number.isInteger(key.sy)) {
        throw new PersistenceError(
          'invalid_argument',
          `section key coordinates must be integers: (${key.cx}, ${key.cz}, ${key.sy})`,
        );
      }
      const s = sectionKeyString(key);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ ...key });
    }
    return out;
  }

  /** Reconcile the LRU index with the real resident set after any direct map call. */
  private reconcile(): void {
    const resident = this.session.voxel.residentSectionKeys();
    const residentSet = new Set<string>();
    this.keyIndex.clear();
    for (const key of resident) {
      const s = sectionKeyString(key);
      residentSet.add(s);
      this.keyIndex.set(s, key);
    }
    for (const key of this.lru.oldestFirst()) {
      if (!residentSet.has(key)) this.lru.remove(key);
    }
    const known = new Set(this.lru.oldestFirst());
    const unknown = [...residentSet].filter((k) => !known.has(k)).sort();
    for (const key of unknown) this.lru.insert(key);
  }

  /**
   * Evict LRU-eligible sections until the to-load sections fit the resident count
   * and byte budgets, or a bound/exhaustion is hit. The final dirty/pin/commit check
   * always goes through `unloadSections` (never a cached eligibility guess).
   *
   * The candidate list is snapshotted once and walked with a cursor, so every
   * candidate is visited at most once (no O(n²) re-scan). A byte-only overflow of
   * the *conservative* estimate is not treated as a hard capacity gap: the estimate
   * is an upper bound and may exceed the budget while the exact resident cost fits,
   * so in that case control falls through to the load, whose exact accounting
   * (`installLoadedSections`) is authoritative.
   */
  private evictToFit(
    toLoad: SectionKey[],
    protectedSet: Set<string>,
    diagnostics: DiagnosticBuffer,
  ): { evicted: SectionKey[]; rejected: EvictionRejection[]; gap: CapacityGap | null } {
    const evicted: SectionKey[] = [];
    const rejected: EvictionRejection[] = [];

    const loadBytesEstimate = toLoad.reduce((sum, key) => {
      const committed = this.session.sectionResidency(key).committed;
      return sum + (committed === undefined ? 0 : estimateVoxelSectionResidentBytesFromCommitted(committed));
    }, 0);

    const candidates = this.lru.oldestFirst();
    let cursor = 0;
    let candidateChecks = 0;
    let unloadCount = 0;

    for (;;) {
      const size = this.session.voxel.residentSize();
      const needCount = size.sections + toLoad.length - this.residency.maxResidentSections;
      const needBytes = size.bytes + loadBytesEstimate - this.residency.maxResidentBytes;
      if (needCount <= 0 && needBytes <= 0) break;

      const next = this.nextCandidate(candidates, cursor, protectedSet);
      if (next === null) {
        // Only a genuine count overflow is a hard gap here; a byte-estimate overflow
        // falls through to the load, whose exact check decides.
        if (needCount > 0) {
          return {
            evicted,
            rejected,
            gap: this.gap(
              'count_capacity',
              `cannot fit ${toLoad.length} sections to load: no eligible candidate to evict`,
            ),
          };
        }
        return { evicted, rejected, gap: null };
      }
      cursor = next.cursor;
      candidateChecks += 1;
      if (candidateChecks > this.bounds.maxEvictionCandidates) {
        return {
          evicted,
          rejected,
          gap: this.gap(
            'candidate_budget_exhausted',
            `candidate checks exceeded maxEvictionCandidates (${this.bounds.maxEvictionCandidates})`,
          ),
        };
      }
      if (unloadCount >= this.bounds.maxUnloadSections) {
        return {
          evicted,
          rejected,
          gap: this.gap(
            'unload_budget_exhausted',
            `unloads reached maxUnloadSections (${this.bounds.maxUnloadSections})`,
          ),
        };
      }

      const res = this.session.unloadSections([next.candidate]);
      if (res.unloaded.length === 1) {
        evicted.push({ ...next.candidate });
        this.lru.remove(sectionKeyString(next.candidate));
        diagnostics.push(`evicted ${fmt(next.candidate)}`);
        unloadCount += 1;
      } else {
        const reason = res.rejected[0]?.reason ?? 'not_committed';
        rejected.push({ key: { ...next.candidate }, reason });
      }
    }
    return { evicted, rejected, gap: null };
  }

  /**
   * The next eligible candidate in a single LRU snapshot, advancing `cursor` past
   * every key (protected, stale, or non-resident) it skips. Each candidate is
   * visited at most once, so the whole eviction is linear in the resident set.
   */
  private nextCandidate(
    candidates: string[],
    cursor: number,
    protectedSet: ReadonlySet<string>,
  ): { candidate: SectionKey; cursor: number } | null {
    while (cursor < candidates.length) {
      const keyStr = candidates[cursor]!;
      cursor += 1;
      if (protectedSet.has(keyStr)) continue;
      const key = this.keyIndex.get(keyStr);
      if (key === undefined) continue;
      if (this.session.sectionResidency(key).residency !== 'resident') continue;
      return { candidate: key, cursor };
    }
    return null;
  }

  private mapLoadError(err: unknown): CapacityGap {
    if (err instanceof PersistenceError) {
      switch (err.kind) {
        case 'capacity':
          return this.gap('byte_capacity', err.message);
        case 'busy':
          return this.gap('busy', err.message);
        case 'closed':
        case 'closing':
          return this.gap('closed', err.message);
        default:
          return this.gap('read_failed', err.message);
      }
    }
    return this.gap('read_failed', err instanceof Error ? err.message : String(err));
  }

  private toPersistenceError(err: unknown): PersistenceError {
    if (err instanceof PersistenceError) return err;
    return new PersistenceError('invalid_argument', err instanceof Error ? err.message : String(err));
  }

  private gap(kind: CapacityGapKind, message: string): CapacityGap {
    return { kind, message };
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Bounded diagnostic collector: keeps the first N strings and drops the rest. */
class DiagnosticBuffer {
  readonly items: string[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(message: string): void {
    if (this.items.length < this.max) this.items.push(message);
  }
}

function fmt(key: SectionKey): string {
  return `(${key.dim}, ${key.cx}, ${key.cz}, ${key.sy})`;
}
