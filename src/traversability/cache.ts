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
import type { ChangeReport, VoxelMap } from '../voxel/voxel-map.js';
import type { CollisionShapeProvider } from './collision-shape.js';
import { evaluateWalkStep } from './step.js';
import type { StepConstraints, StepEvaluation, StepQuery } from './step.js';

export interface TraversabilityCacheOptions {
  /** Clock used to check entry validity; defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  evaluation: StepEvaluation;
  validUntil: number;
}

export class TraversabilityCache {
  private readonly map: VoxelMap;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly bySection = new Map<string, Set<string>>();

  constructor(map: VoxelMap, options: TraversabilityCacheOptions = {}) {
    this.map = map;
    this.now = options.now ?? Date.now;
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
    const key = stepKey(query, shapeProvider.version);
    const entry = this.entries.get(key);
    if (entry !== undefined && now <= entry.validUntil) {
      return cloneEvaluation(entry.evaluation);
    }
    const evaluation = evaluateWalkStep(this.map, query, shapeProvider, now);
    this.store(key, evaluation);
    return cloneEvaluation(evaluation);
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

  private store(key: string, evaluation: StepEvaluation): void {
    this.removeEntry(key);
    this.entries.set(key, { evaluation, validUntil: evaluation.validUntil });
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
    dependencies: e.dependencies.map((d) => ({ key: { ...d.key }, revision: d.revision })),
  };
}
