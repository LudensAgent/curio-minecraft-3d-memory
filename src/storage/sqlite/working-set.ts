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
import type { LoadSectionsResult, SpatialSession } from './types.js';

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

/** Result of `prepare`: an accurate account of what was prepared, evicted, and why. */
export interface PrepareResult {
  worldId: string;
  /** Sections now resident *and* protected by the returned lease (alreadyResident ∪ loaded). */
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
  /** The bounded capacity/failure outcome, or null when the request was fully prepared. */
  capacity: CapacityGap | null;
  /**
   * The protection lease over the prepared sections, handed to the caller. Empty
   * (`token: ''`) when the request hit a hard failure and the temporary lease was
   * released. The caller owns release; a late release never drops a newer lease.
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
   */
  async prepare(keys: readonly SectionKey[]): Promise<PrepareResult> {
    const worldId = this.session.voxel.worldId;
    const diagnostics = new DiagnosticBuffer(this.bounds.maxDiagnostics);
    const result: PrepareResult = {
      worldId,
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
      const info = this.session.sectionResidency(key);
      switch (info.residency) {
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

    // Protect the whole request before any eviction, so the manager can never evict
    // the first half of the request to make room for the second half.
    let lease: { token: string; keys: SectionKey[] };
    try {
      lease = this.session.pinSections(deduped);
    } catch (err) {
      // Over the pin budget (maxPins / maxPinnedSections): nothing was evicted yet.
      throw this.toPersistenceError(err);
    }

    result.alreadyResident = resident.map((k) => ({ ...k }));
    result.prepared.push(...resident.map((k) => ({ ...k })));

    let hardFailure = false;
    try {
      this.reconcile();
      // A successful request hit (an already-resident section) advances its LRU
      // position; a load inserts it at MRU below. Both are runtime cache metadata.
      for (const key of resident) this.lru.touch(sectionKeyString(key));
      const protectedSet = new Set(deduped.map(sectionKeyString));

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
          for (const key of loaded.loaded) {
            result.prepared.push({ ...key });
            this.lru.insert(sectionKeyString(key));
          }
          for (const missing of loaded.missing) {
            result.noRecord.push({ ...missing });
          }
          this.reconcile();
        } catch (err) {
          result.capacity = this.mapLoadError(err);
          hardFailure = true;
        }
      }
    } finally {
      if (hardFailure) {
        this.session.releasePins([lease.token]);
        result.lease = { token: '', keys: [] };
        // A hard failure after partial eviction/load must not leave a phantom lease.
      } else {
        result.lease = { token: lease.token, keys: lease.keys.map((k) => ({ ...k })) };
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
   */
  free(target?: { sections?: number; bytes?: number }): FreeResult {
    const diagnostics = new DiagnosticBuffer(this.bounds.maxDiagnostics);
    const result: FreeResult = { evicted: [], evictionRejected: [], capacity: null, diagnostics: diagnostics.items };

    if (target !== undefined && target.sections !== undefined && !Number.isSafeInteger(target.sections)) {
      throw new PersistenceError('invalid_argument', `free target.sections must be a safe integer: ${String(target.sections)}`);
    }
    if (target !== undefined && target.bytes !== undefined && !Number.isSafeInteger(target.bytes)) {
      throw new PersistenceError('invalid_argument', `free target.bytes must be a safe integer: ${String(target.bytes)}`);
    }

    this.reconcile();
    const checked = new Set<string>();
    let candidateChecks = 0;
    let unloadCount = 0;

    for (;;) {
      // With a target, stop once the working set is at or under it. Without a
      // target, evict every eligible section until a bound or exhaustion is hit.
      if (target !== undefined) {
        const size = this.session.voxel.residentSize();
        const countOk = target.sections === undefined || size.sections <= target.sections;
        const bytesOk = target.bytes === undefined || size.bytes <= target.bytes;
        if (countOk && bytesOk) break;
      }

      const candidate = this.nextEvictionCandidate(new Set(), checked);
      if (candidate === null) {
        result.capacity = this.gap('no_eligible_candidates', 'no eligible section is available to evict');
        diagnostics.push(result.capacity.message);
        break;
      }
      candidateChecks += 1;
      if (candidateChecks > this.bounds.maxEvictionCandidates) {
        result.capacity = this.gap(
          'candidate_budget_exhausted',
          `candidate checks exceeded maxEvictionCandidates (${this.bounds.maxEvictionCandidates})`,
        );
        diagnostics.push(result.capacity.message);
        break;
      }

      const res = this.session.unloadSections([candidate]);
      if (res.unloaded.length === 1) {
        result.evicted.push({ ...candidate });
        this.lru.remove(sectionKeyString(candidate));
        diagnostics.push(`evicted ${fmt(candidate)}`);
        unloadCount += 1;
        if (unloadCount > this.bounds.maxUnloadSections) {
          result.capacity = this.gap(
            'unload_budget_exhausted',
            `unloads exceeded maxUnloadSections (${this.bounds.maxUnloadSections})`,
          );
          diagnostics.push(result.capacity.message);
          break;
        }
      } else {
        const reason = res.rejected[0]?.reason ?? 'not_committed';
        result.evictionRejected.push({ key: { ...candidate }, reason });
        checked.add(sectionKeyString(candidate));
      }
    }
    return result;
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
   */
  private evictToFit(
    toLoad: SectionKey[],
    protectedSet: Set<string>,
    diagnostics: DiagnosticBuffer,
  ): { evicted: SectionKey[]; rejected: EvictionRejection[]; gap: CapacityGap | null } {
    const evicted: SectionKey[] = [];
    const rejected: EvictionRejection[] = [];
    const checked = new Set<string>();
    let candidateChecks = 0;
    let unloadCount = 0;

    const loadBytesEstimate = toLoad.reduce((sum, key) => {
      const committed = this.session.sectionResidency(key).committed;
      return sum + (committed === undefined ? 0 : estimateVoxelSectionResidentBytesFromCommitted(committed));
    }, 0);

    for (;;) {
      const size = this.session.voxel.residentSize();
      const needCount = size.sections + toLoad.length - this.residency.maxResidentSections;
      const needBytes = size.bytes + loadBytesEstimate - this.residency.maxResidentBytes;
      if (needCount <= 0 && needBytes <= 0) break;

      const candidate = this.nextEvictionCandidate(protectedSet, checked);
      if (candidate === null) {
        return {
          evicted,
          rejected,
          gap: this.gap(
            needCount > 0 ? 'count_capacity' : 'byte_capacity',
            `cannot fit the request (${toLoad.length} to load): no eligible candidate to evict`,
          ),
        };
      }
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

      const res = this.session.unloadSections([candidate]);
      if (res.unloaded.length === 1) {
        evicted.push({ ...candidate });
        this.lru.remove(sectionKeyString(candidate));
        diagnostics.push(`evicted ${fmt(candidate)}`);
        unloadCount += 1;
        if (unloadCount > this.bounds.maxUnloadSections) {
          return {
            evicted,
            rejected,
            gap: this.gap(
              'unload_budget_exhausted',
              `unloads exceeded maxUnloadSections (${this.bounds.maxUnloadSections})`,
            ),
          };
        }
      } else {
        const reason = res.rejected[0]?.reason ?? 'not_committed';
        rejected.push({ key: { ...candidate }, reason });
        checked.add(sectionKeyString(candidate));
      }
    }
    return { evicted, rejected, gap: null };
  }

  /**
   * The oldest LRU candidate that is resident and not protected/checked. Committed
   * or not, dirty or clean, pinned or free: the final judgment is left to
   * `unloadSections`, which reports the structured refusal reason. A resident
   * section that is not in the LRU index is skipped and marked checked.
   */
  private nextEvictionCandidate(protectedSet: Set<string>, checked: Set<string>): SectionKey | null {
    for (const keyStr of this.lru.oldestFirst()) {
      if (protectedSet.has(keyStr) || checked.has(keyStr)) continue;
      const key = this.keyIndex.get(keyStr);
      if (key === undefined) {
        checked.add(keyStr);
        continue;
      }
      const info = this.session.sectionResidency(key);
      if (info.residency === 'resident') return key;
      checked.add(keyStr);
    }
    return null;
  }

  private mapLoadError(err: unknown): CapacityGap {
    if (err instanceof PersistenceError) {
      switch (err.kind) {
        case 'busy':
          return this.gap('busy', err.message);
        case 'closed':
        case 'closing':
          return this.gap('closed', err.message);
        case 'capacity':
          return this.gap('byte_capacity', err.message);
        case 'data':
        case 'timeout':
          return this.gap('read_failed', err.message);
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
