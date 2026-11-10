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
 * The prepare/free operation gate is held by the *session*, not this manager, so
 * multiple managers and the direct load/checkpoint entries share one mutual
 * exclusion. Read-only queries (`stats`) do not load, evict, save, or scan the
 * world; they only read the in-memory resident set (bounded by `maxResidentSections`)
 * and the manager's own LRU index.
 */

import { sectionKeyString } from '../../voxel/section.js';
import type { SectionKey } from '../../voxel/section.js';
import { LruOrder } from '../../voxel/lru.js';
import type { ResolvedResidencyLimits, UnloadRejectionReason } from '../../voxel/residency.js';
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

/** Why a working-set request was refused or could not be satisfied. */
export type WorkingSetRejectionKind =
  | 'busy'
  | 'closed'
  | 'capacity'
  | 'no_record'
  | 'not_ready'
  | 'read_failed'
  | 'invalid_argument';

/**
 * One observable refusal. `keys` are the caller-supplied request keys (bounded);
 * `kind` distinguishes a transient gate (`busy`) from an unavailable record
 * (`no_record`) and from a hard bound (`capacity`). A rejection is a fact about
 * the request, never a claim that the data was deleted or never observed.
 */
export interface WorkingSetRejection {
  operation: 'prepare' | 'free';
  kind: WorkingSetRejectionKind;
  detail: string;
  keys: SectionKey[];
}

/**
 * Cumulative work actually performed through this manager. It reports real
 * prepare/free results only: requests rejected before any load or eviction
 * still count as requested, never as loaded/evicted.
 */
export interface WorkingSetCounters {
  /** Unique sections submitted to `prepare`, across all calls. */
  requestedSections: number;
  /** Requested sections that were already resident (no disk read). */
  alreadyResidentSections: number;
  /** Sections actually installed by a completed `prepare`. */
  loadedSections: number;
  /** Estimated resident bytes of the sections installed by `prepare`. */
  loadBytes: number;
  /** Wall time spent measuring and installing sections that were installed. */
  loadMs: number;
  /** Sections actually unloaded by `prepare` or `free`. */
  evictedSections: number;
  /** Candidate unloads refused by the map (pinned/dirty/not_committed). */
  rejectedSections: number;
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
  /**
   * Every observed section in the full map (resident + non-resident directory
   * sections). This is an observation fact, not a residency fact.
   */
  observedSections: number;
  /** Every observed cell in the full map. */
  observedCells: number;
  /** Sections currently decoded in memory. */
  residentObservedSections: number;
  /** Observed sections that are not resident (committed, on disk only). */
  notResidentSections: number;
  /**
   * Clean sections whose latest change is covered by a confirmed checkpoint.
   * `observedSections - pendingSections`; it is not a row count and never
   * refreshes evidence time.
   */
  persistedSections: number;
  /** Sections changed since the last confirmed checkpoint (queued for saving). */
  pendingSections: number;
  pendingBytes: number;
  /** Cumulative request refusals by kind (busy/closed/capacity/no_record/not_ready). */
  rejections: Record<WorkingSetRejectionKind, number>;
  /** Cumulative real prepare/free work; never derived from residency alone. */
  counters: WorkingSetCounters;
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
 * behavior is untouched. It reuses the session's `measureSections` / `installSections` /
 * `unloadSections` / `pinSections` / `releasePins` / `sectionResidency` and the map's
 * resident accounting, never a parallel load/unload path.
 */
export class WorkingSetManager {
  private readonly session: SpatialSession;
  private readonly residency: ResolvedResidencyLimits;
  private readonly bounds: ResolvedWorkingSetLimits;
  private readonly lru = new LruOrder();
  /** Section key string → SectionKey, rebuilt from the resident set on reconcile. */
  private readonly keyIndex = new Map<string, SectionKey>();
  /** Cumulative request refusals by kind. */
  private readonly rejectionCounts: Record<WorkingSetRejectionKind, number> = {
    busy: 0,
    closed: 0,
    capacity: 0,
    no_record: 0,
    not_ready: 0,
    read_failed: 0,
    invalid_argument: 0,
  };
  /** Bounded ledger of recent refusals; the oldest entries are dropped first. */
  private readonly rejectionLedger: WorkingSetRejection[] = [];
  /** Bound for `recentRejections`; the ledger never grows without limit. */
  private static readonly MAX_REJECTION_LEDGER = 64;
  /** Cumulative real work; saturated so a long-lived session cannot overflow. */
  private readonly counters: WorkingSetCounters = {
    requestedSections: 0,
    alreadyResidentSections: 0,
    loadedSections: 0,
    loadBytes: 0,
    loadMs: 0,
    evictedSections: 0,
    rejectedSections: 0,
  };

  constructor(session: SpatialSession, options: WorkingSetLimits = {}) {
    if (session.voxelLoading !== 'manual') {
      throw new PersistenceError('invalid_argument', 'WorkingSetManager requires a manual-residency session');
    }
    this.session = session;
    this.residency = session.residencyLimits;
    this.bounds = resolveWorkingSetLimits(options);
  }

  /**
   * Explicitly prepare a set of sections: validate, protect, measure, evict to fit,
   * load, and return the resident + protected set with a lease. Never observes the
   * world, never fabricates a section for a missing record, and never treats a load
   * as a current observation or an OPEN passability conclusion.
   *
   * Throws `PersistenceError` (before any mutation) when the session is busy,
   * closing or closed, or when another manager operation is in flight.
   */
  async prepare(keys: readonly SectionKey[]): Promise<PrepareResult> {
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

    try {
      this.session.acquireWorkingSetOperation();
    } catch (error) {
      this.recordRejection('prepare', rejectionKindOf(error), messageOf(error), keys);
      throw error;
    }
    let toLoad: SectionKey[] = [];
    let lease: { token: string; keys: SectionKey[] } = { token: '', keys: [] };
    let hardFailure = false;
    let complete = true;
    let deduped: SectionKey[] = [];
    try {
      try {
        deduped = this.validateKeys(keys);
      } catch (error) {
        this.recordRejection('prepare', rejectionKindOf(error), messageOf(error), keys);
        throw error;
      }
      if (deduped.length > this.residency.maxLoadBatchSections) {
        result.capacity = this.gap(
          'request_too_large',
          `request has ${deduped.length} sections, exceeding maxLoadBatchSections (${this.residency.maxLoadBatchSections})`,
        );
        diagnostics.push(result.capacity.message);
        return result;
      }
      this.bump('requestedSections', deduped.length);

      const resident: SectionKey[] = [];
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

      // Sound count pre-check over the *whole* request (already-resident + to-load):
      // reject before any eviction so an impossible request has no side effects.
      if (resident.length + toLoad.length > this.residency.maxResidentSections) {
        result.capacity = this.gap(
          'count_capacity',
          `request needs ${resident.length + toLoad.length} resident sections, exceeding maxResidentSections (${this.residency.maxResidentSections})`,
        );
        diagnostics.push(result.capacity.message);
        return result;
      }

      result.alreadyResident = resident.map((k) => ({ ...k }));
      this.bump('alreadyResidentSections', resident.length);

      // Protect the sections that are (or will be) resident, so the manager can never
      // evict the first half of the request to make room for the second half.
      const protectedKeys = [...resident, ...toLoad];
      try {
        lease = this.session.pinSections(protectedKeys);
      } catch (err) {
        throw this.toPersistenceError(err);
      }

      this.reconcile();
      for (const key of resident) this.lru.touch(sectionKeyString(key));

      if (toLoad.length > 0) {
        const protectedSet = new Set(protectedKeys.map(sectionKeyString));
        const loadStarted = Date.now();
        try {
          const measured = await this.session.measureSections(toLoad);
          for (const missing of measured.missing) result.noRecord.push({ ...missing });

          // A close() may have run while we awaited the measure; re-check before any
          // eviction so a session that is no longer open never evicts its cache.
          if (this.session.lifecycle !== 'open') {
            result.capacity = this.gap('closed', 'session is closing or closed');
            hardFailure = true;
            this.session.voxel.markLoadFailed(toLoad); // abandon the measured, uninstalled sections
          } else {
            // Sound pre-fit byte check over the request's *own* footprint: the
            // already-resident request sections (which cannot be evicted) plus the
            // measured to-install cost. If this alone exceeds the byte budget, reject
            // before evicting anything — a request that cannot fit even on an empty
            // working set must not first evict the existing cache.
            const residentRequestBytes = this.session.voxel.residentBytesOf(resident);
            if (residentRequestBytes + measured.residentBytes > this.residency.maxResidentBytes) {
              result.capacity = this.gap(
                'byte_capacity',
                `request needs ${residentRequestBytes + measured.residentBytes} resident bytes, exceeding maxResidentBytes (${this.residency.maxResidentBytes})`,
              );
              hardFailure = true;
              this.session.voxel.markLoadFailed(toLoad); // abandon the measured, uninstalled sections
            } else {
              const eviction = this.evictToFit(toLoad.length, measured.residentBytes, protectedSet, diagnostics);
              result.evicted = eviction.evicted.map((k) => ({ ...k }));
              result.evictionRejected = eviction.rejected.map((r) => ({ key: { ...r.key }, reason: r.reason }));
              this.bump('evictedSections', eviction.evicted.length);
              this.bump('rejectedSections', eviction.rejected.length);
              if (eviction.gap !== null) {
                result.capacity = eviction.gap;
                hardFailure = true;
                this.session.voxel.markLoadFailed(toLoad); // abandon the measured, uninstalled sections
              } else {
                const installed = this.session.installSections(measured.sections);
                result.loaded = installed.map((k) => ({ ...k }));
                for (const key of installed) this.lru.insert(sectionKeyString(key));
                this.bump('loadedSections', installed.length);
                this.bump('loadBytes', measured.residentBytes);
                this.bump('loadMs', Date.now() - loadStarted);
                this.reconcile();
              }
            }
          }
        } catch (err) {
          result.capacity = this.mapLoadError(err);
          hardFailure = true;
        }
      }

      complete = !hardFailure && result.noRecord.length === 0 && result.notReady.length === 0;
    } finally {
      this.session.releaseWorkingSetOperation();
    }

    // Status and lease/protection must be consistent: only a fully-prepared,
    // fully-protected request is "ready" and keeps the lease; anything else releases
    // the temporary lease and reports `prepared` as empty.
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

    for (const key of result.loaded) diagnostics.push(`loaded ${fmt(key)}`);
    for (const key of result.evicted) diagnostics.push(`evicted ${fmt(key)}`);

    // Every non-ready outcome is an observable rejection: the request keys keep
    // their individual state above, and the aggregate ledger names why.
    if (result.status === 'failed') {
      const kind = result.capacity === null ? 'read_failed' : capacityKind(result.capacity.kind);
      this.recordRejection('prepare', kind, result.capacity?.message ?? 'working-set prepare failed', deduped.length > 0 ? deduped : keys);
    } else if (result.status === 'incomplete') {
      if (result.noRecord.length > 0) {
        this.recordRejection('prepare', 'no_record', 'requested sections have no committed record', result.noRecord);
      }
      if (result.notReady.length > 0) {
        this.recordRejection('prepare', 'not_ready', 'requested sections are loading or failed a previous load', result.notReady);
      }
    }
    return result;
  }

  /**
   * Bounded, newest-last ledger of recent refusals. Read-only; it never loads,
   * evicts, or mutates request state. `max` is clamped to the ledger bound.
   */
  recentRejections(max = 16): WorkingSetRejection[] {
    if (!Number.isSafeInteger(max) || max < 0) {
      throw new PersistenceError('invalid_argument', `max must be a non-negative safe integer: ${String(max)}`);
    }
    const take = Math.min(max, this.rejectionLedger.length);
    return this.rejectionLedger.slice(this.rejectionLedger.length - take).map((entry) => ({
      ...entry,
      keys: entry.keys.map((key) => ({ ...key })),
    }));
  }

  private recordRejection(
    operation: WorkingSetRejection['operation'],
    kind: WorkingSetRejectionKind,
    detail: string,
    keys: readonly SectionKey[],
  ): void {
    this.rejectionCounts[kind] += 1;
    this.rejectionLedger.push({
      operation,
      kind,
      detail,
      keys: keys.slice(0, 256).map((key) => ({ ...key })),
    });
    while (this.rejectionLedger.length > WorkingSetManager.MAX_REJECTION_LEDGER) {
      this.rejectionLedger.shift();
    }
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
    try {
      this.session.acquireWorkingSetOperation();
    } catch (error) {
      this.recordRejection('free', rejectionKindOf(error), messageOf(error), []);
      throw error;
    }
    try {
      const diagnostics = new DiagnosticBuffer(this.bounds.maxDiagnostics);
      const result: FreeResult = { evicted: [], evictionRejected: [], capacity: null, diagnostics: diagnostics.items };

      if (target !== undefined && target.sections !== undefined && (!Number.isSafeInteger(target.sections) || target.sections < 0)) {
        const detail = `free target.sections must be a non-negative safe integer: ${String(target.sections)}`;
        this.recordRejection('free', 'invalid_argument', detail, []);
        throw new PersistenceError('invalid_argument', detail);
      }
      if (target !== undefined && target.bytes !== undefined && (!Number.isSafeInteger(target.bytes) || target.bytes < 0)) {
        const detail = `free target.bytes must be a non-negative safe integer: ${String(target.bytes)}`;
        this.recordRejection('free', 'invalid_argument', detail, []);
        throw new PersistenceError('invalid_argument', detail);
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
          this.bump('evictedSections', 1);
        } else {
          const reason = res.rejected[0]?.reason ?? 'not_committed';
          result.evictionRejected.push({ key: { ...next.candidate }, reason });
          this.bump('rejectedSections', 1);
        }
      }
      if (result.capacity !== null) {
        this.recordRejection(
          'free',
          capacityKind(result.capacity.kind),
          result.capacity.message,
          result.evictionRejected.map((entry) => entry.key),
        );
      }
      return result;
    } finally {
      this.session.releaseWorkingSetOperation();
    }
  }

  /**
   * Bounded read-only snapshot of the working set (no load/evict/save/world
   * scan). Observation, residency, dirty and persistence state are reported as
   * separate counts so "observed", "resident" and "persisted" never stand in for
   * one another.
   */
  stats(): WorkingSetStats {
    this.reconcile();
    const size = this.session.voxel.residentSize();
    const pins = this.session.voxel.pinState();
    const full = this.session.voxel.checkpointFullCounts();
    const dirty = this.session.voxel.checkpointDirtyMeasure();
    return {
      residentSections: size.sections,
      residentBytes: size.bytes,
      maxResidentSections: this.residency.maxResidentSections,
      maxResidentBytes: this.residency.maxResidentBytes,
      lruTracked: this.lru.size,
      pinnedLeases: pins.leases,
      pinnedSections: pins.pinnedSections,
      observedSections: full.sections,
      observedCells: full.observedCells,
      residentObservedSections: size.sections,
      notResidentSections: Math.max(0, full.sections - size.sections),
      persistedSections: Math.max(0, full.sections - dirty.count),
      pendingSections: dirty.count,
      pendingBytes: dirty.bytes,
      rejections: { ...this.rejectionCounts },
      counters: { ...this.counters },
    };
  }

  // --- internals ---

  /** Saturating cumulative counter; it never wraps or becomes non-finite. */
  private bump(field: keyof WorkingSetCounters, amount: number): void {
    this.counters[field] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[field] + amount);
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
   * and byte budgets, or a bound/exhaustion is hit. The byte figure is the *exact*
   * resident cost measured from the decoded snapshots, so a remaining byte overflow
   * after candidates are exhausted is a genuine `byte_capacity`. The final dirty/pin/
   * commit check always goes through `unloadSections` (never a cached eligibility
   * guess). The candidate list is snapshotted once and walked with a cursor, so every
   * candidate is visited at most once (no O(n²) re-scan).
   */
  private evictToFit(
    toLoadCount: number,
    toLoadBytes: number,
    protectedSet: Set<string>,
    diagnostics: DiagnosticBuffer,
  ): { evicted: SectionKey[]; rejected: EvictionRejection[]; gap: CapacityGap | null } {
    const evicted: SectionKey[] = [];
    const rejected: EvictionRejection[] = [];
    const candidates = this.lru.oldestFirst();
    let cursor = 0;
    let candidateChecks = 0;
    let unloadCount = 0;

    for (;;) {
      const size = this.session.voxel.residentSize();
      const needCount = size.sections + toLoadCount - this.residency.maxResidentSections;
      const needBytes = size.bytes + toLoadBytes - this.residency.maxResidentBytes;
      if (needCount <= 0 && needBytes <= 0) break;

      const next = this.nextCandidate(candidates, cursor, protectedSet);
      if (next === null) {
        if (needCount > 0) {
          return {
            evicted,
            rejected,
            gap: this.gap(
              'count_capacity',
              `cannot fit ${toLoadCount} sections to load: no eligible candidate to evict`,
            ),
          };
        }
        return {
          evicted,
          rejected,
          gap: this.gap(
            'byte_capacity',
            `cannot fit ${toLoadCount} sections (${toLoadBytes} resident bytes): no eligible candidate to evict`,
          ),
        };
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
          // The install refuses either the section-count bound or the byte bound;
          // preserve the distinction so the caller can react to the real constraint.
          return /maxResidentSections/.test(err.message)
            ? this.gap('count_capacity', err.message)
            : this.gap('byte_capacity', err.message);
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a thrown persistence error to the observable rejection taxonomy. */
function rejectionKindOf(error: unknown): WorkingSetRejectionKind {
  if (error instanceof PersistenceError) {
    switch (error.kind) {
      case 'busy':
        return 'busy';
      case 'closing':
      case 'closed':
        return 'closed';
      case 'invalid_argument':
        return 'invalid_argument';
      default:
        return 'read_failed';
    }
  }
  return 'read_failed';
}

/** Map a `CapacityGap` kind to the observable rejection taxonomy. */
function capacityKind(kind: CapacityGapKind): WorkingSetRejectionKind {
  switch (kind) {
    case 'busy':
      return 'busy';
    case 'closed':
      return 'closed';
    case 'read_failed':
      return 'read_failed';
    default:
      return 'capacity';
  }
}
