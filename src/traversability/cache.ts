/**
 * Traversability cache (design §3.3, §6.2).
 *
 * Bound to one `VoxelMap`; entries are keyed by world/dim/session,
 * from/to/direction, mode + body context, delegation constraints and the
 * collision-rule version. It consumes the map's `ChangeReport` so that only
 * entries depending on a changed section are dropped — an unrelated section
 * never clears the cache.
 *
 * An entry is never served past its `validUntil`, which is the minimum
 * validUntil over the evidence that was still valid at evaluation time (observed
 * or incomplete cells — already-expired, stale, or session-mismatched cells are
 * excluded), so an expired OPEN/UNKNOWN re-evaluates to STALE instead of
 * sticking. Returned evaluations are deep copies: mutating them can never
 * pollute the cache or its reverse index.
 */

import type { Observation } from '../observation/types.js';
import { sectionKeyString } from '../voxel/section.js';
import type { SectionKey } from '../voxel/section.js';
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShapeProvider } from './collision-shape.js';
import { evaluateWalkStep } from './step.js';
import type { StepConstraints, StepEvaluation, StepQuery } from './step.js';

export interface TraversabilityCacheOptions {
  /** Clock used to check entry validity; defaults to `Date.now`. */
  now?: () => number;
  /** Maximum cached evaluations, including negative results. Default 2048. */
  maxEntries?: number;
  /** Maximum reuse age. Queries or pruneExpired() reclaim expired entries; no background timer. Default 60000 ms. */
  maxAgeMs?: number;
}

interface CacheEntry {
  evaluation: StepEvaluation;
  validUntil: number;
  expiresAt: number;
  /** Section key string → residency generation at store time, for each dependency. */
  residency: Map<string, number>;
}

export class TraversabilityCache {
  private readonly map: VoxelMap;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly bySection = new Map<string, Set<string>>();
  private sweepCursor: IterableIterator<[string, CacheEntry]> | undefined;

  constructor(map: VoxelMap, options: TraversabilityCacheOptions = {}) {
    this.map = map;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 2048;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('maxEntries must be a positive safe integer');
    }
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new Error('maxAgeMs must be a positive finite number');
    }
  }

  /** Number of cached entries; exposed for cache-hit observability (§6.2). */
  get size(): number {
    return this.entries.size;
  }

  /** Total reverse-index mappings; exposed to verify the index never leaks deleted entries. */
  get dependencyIndexSize(): number {
    let total = 0;
    for (const set of this.bySection.values()) total += set.size;
    return total;
  }

  /** Return a cached evaluation, or compute and cache it on miss/expiry. */
  get(query: StepQuery, shapeProvider: CollisionShapeProvider): StepEvaluation {
    if (query.worldId !== this.map.worldId) {
      throw new Error(`query worldId "${query.worldId}" does not match cache map worldId "${this.map.worldId}"`);
    }
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new Error(`now() must return a finite number: ${now}`);
    }
    this.sweepExpired(now, 16);
    const key = stepKey(query, shapeProvider.version);
    const entry = this.entries.get(key);
    if (entry !== undefined && now <= entry.validUntil && now <= entry.expiresAt && this.residencyCurrent(entry)) {
      // Map insertion order is the access order; capacity eviction removes the least recently used entry.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return cloneEvaluation(entry.evaluation);
    }
    const evaluation = evaluateWalkStep(this.map, query, shapeProvider, now);
    this.store(key, evaluation, now);
    return cloneEvaluation(evaluation);
  }

  /** Bounded idle maintenance. Removes expired entries without reading or refreshing the map. */
  pruneExpired(maxChecks = 64): number {
    if (!Number.isSafeInteger(maxChecks) || maxChecks < 1) {
      throw new Error('maxChecks must be a positive safe integer');
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error(`now() must return a finite number: ${now}`);
    return this.sweepExpired(now, maxChecks);
  }

  /** Release this task's derived data; observed map facts are unaffected. */
  clear(): void {
    this.entries.clear();
    this.bySection.clear();
    this.sweepCursor = undefined;
  }

  private sweepExpired(now: number, maxChecks: number): number {
    this.sweepCursor ??= this.entries.entries();
    let removed = 0;
    for (let checked = 0; checked < maxChecks; checked += 1) {
      const next = this.sweepCursor.next();
      if (next.done) {
        this.sweepCursor = undefined;
        break;
      }
      const [key, entry] = next.value;
      if (now <= entry.validUntil && now <= entry.expiresAt) continue;
      this.removeEntry(key);
      removed += 1;
    }
    return removed;
  }

  /**
   * Invalidate entries that depended on any section whose revision advanced.
   * Refresh-only (`invalidated: false`) changes invalidate only STALE or
   * UNSUPPORTED entries: they extend evidence validity, which the time-based
   * `validUntil` check handles for OPEN/BLOCKED/UNKNOWN, but a STALE/UNSUPPORTED
   * entry may have been limited by expired evidence and can only recover when the
   * refreshing report drops it.
   */
  invalidate(report: ChangeReport): void {
    const toDelete = new Set<string>();
    for (const section of report.sections) {
      const keys = this.bySection.get(sectionKeyString(section.key));
      if (keys === undefined) continue;
      for (const key of keys) {
        if (section.invalidated) {
          toDelete.add(key);
        } else {
          // Refresh-only: content is unchanged, but evidence validity was extended.
          // A STALE or UNSUPPORTED entry can have been limited by expired evidence
          // and only recover when the refreshing report drops it explicitly.
          const entry = this.entries.get(key);
          if (
            entry !== undefined &&
            (entry.evaluation.status === 'STALE' || entry.evaluation.status === 'UNSUPPORTED')
          ) {
            toDelete.add(key);
          }
        }
      }
    }
    for (const key of toDelete) this.removeEntry(key);
  }

  private store(key: string, evaluation: StepEvaluation, now: number): void {
    this.removeEntry(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.removeEntry(oldest.value);
    }
    const residency = new Map<string, number>();
    for (const dep of evaluation.dependencies) {
      residency.set(
        sectionKeyString(dep.key),
        this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy),
      );
    }
    this.entries.set(key, {
      evaluation,
      validUntil: evaluation.validUntil,
      expiresAt: now + this.maxAgeMs,
      residency,
    });
    for (const dep of evaluation.dependencies) {
      const depKey = sectionKeyString(dep.key);
      let set = this.bySection.get(depKey);
      if (set === undefined) {
        set = new Set();
        this.bySection.set(depKey, set);
      }
      set.add(key);
    }
  }

  /** True when no dependency section changed residency since this entry was stored. */
  private residencyCurrent(entry: CacheEntry): boolean {
    for (const dep of entry.evaluation.dependencies) {
      const current = this.map.residencyGeneration(dep.key.dim, dep.key.cx, dep.key.cz, dep.key.sy);
      if (entry.residency.get(sectionKeyString(dep.key)) !== current) return false;
    }
    return true;
  }

  /**
   * Drop every cached entry that depended on one of the given sections, regardless
   * of revision. A residency change (unload or reload) does not advance
   * `Section.revision`, so the revision-based `invalidate(report)` cannot see it;
   * the host calls this with the sections whose residency changed so an unloaded
   * section never keeps returning an old OPEN and a reloaded section never keeps a
   * pre-load UNKNOWN.
   */
  invalidateSections(keys: readonly SectionKey[]): void {
    for (const key of keys) {
      const entryKeys = this.bySection.get(sectionKeyString(key));
      if (entryKeys === undefined) continue;
      for (const entryKey of [...entryKeys]) this.removeEntry(entryKey);
    }
  }

  /** Remove one entry and clean its key out of every reverse-index set it was in. */
  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    for (const dep of entry.evaluation.dependencies) {
      const depKey = sectionKeyString(dep.key);
      const set = this.bySection.get(depKey);
      if (set === undefined) continue;
      set.delete(key);
      if (set.size === 0) this.bySection.delete(depKey);
    }
    this.entries.delete(key);
  }
}

function stepKey(query: StepQuery, ruleVersion: string): string {
  const b = query.body;
  return JSON.stringify([
    query.worldId,
    query.dim,
    query.sessionId,
    query.mode,
    b.feet.x,
    b.feet.y,
    b.feet.z,
    b.width,
    b.height,
    b.pose,
    query.direction.axis,
    query.direction.sign,
    normalizeConstraints(query.constraints),
    ruleVersion,
  ]);
}

function normalizeConstraints(constraints: StepConstraints | undefined): string {
  if (constraints === undefined) return '';
  const avoid = (constraints.avoid ?? [])
    .map((p) => `${p.x},${p.y},${p.z}`)
    .sort()
    .join(';');
  return `avoid=${avoid}`;
}

function cloneObservation(o: Observation): Observation {
  return { ...o, pos: { ...o.pos }, state: { name: o.state.name, properties: { ...o.state.properties } } };
}

/** Deep-copy an evaluation so callers can never mutate the cached copy. */
function cloneEvaluation(e: StepEvaluation): StepEvaluation {
  return {
    ...e,
    from: { ...e.from },
    to: { ...e.to },
    problem: e.problem === undefined ? undefined : { ...e.problem, cells: e.problem.cells.map((c) => ({ ...c })) },
    obstacles: e.obstacles.map((o) =>
      o.kind === 'block'
        ? { kind: 'block', observation: cloneObservation(o.observation) }
        : { kind: 'contact', pos: { ...o.pos }, observedAt: o.observedAt, sessionId: o.sessionId },
    ),
    hazards: e.hazards?.map((h) => ({ ...h, pos: { ...h.pos } })),
    dependencies: e.dependencies.map((d) => ({ key: { ...d.key }, revision: d.revision })),
  };
}
