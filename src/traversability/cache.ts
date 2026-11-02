/**
 * Traversability cache (design §3.3, §6.2).
 *
 * Memoizes single-step evaluations keyed by world/dim/session, from/to/direction,
 * mode + body context, delegation constraints and the collision-rule version. It
 * consumes the `VoxelMap`'s `ChangeReport` so that only entries depending on a
 * changed section are dropped — an unrelated section never clears the cache.
 *
 * An entry is never served past its `validUntil`: OPEN/BLOCKED carry the minimum
 * dependency validUntil, so advancing time past it forces a re-evaluation (which
 * then reports STALE). UNKNOWN/STALE/UNSUPPORTED are invalidated by change, not
 * time, so their entries are served until a relevant section changes.
 */

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
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly bySection = new Map<string, Set<string>>();

  constructor(options: TraversabilityCacheOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Number of cached entries; exposed for cache-hit observability (§6.2). */
  get size(): number {
    return this.entries.size;
  }

  /** Return a cached evaluation, or compute and cache it on miss/expiry. */
  get(map: VoxelMap, query: StepQuery, shapeProvider: CollisionShapeProvider): StepEvaluation {
    const key = stepKey(query, shapeProvider.version);
    const entry = this.entries.get(key);
    if (entry !== undefined && this.now() <= entry.validUntil) {
      return entry.evaluation;
    }
    const evaluation = evaluateWalkStep(map, query, shapeProvider, this.now());
    this.store(key, evaluation);
    return evaluation;
  }

  /**
   * Invalidate entries that depended on any section whose revision advanced.
   * Refresh-only (`invalidated: false`) changes do not invalidate: they only
   * extend evidence validity, never change content.
   */
  invalidate(report: ChangeReport): void {
    for (const section of report.sections) {
      if (!section.invalidated) continue;
      const keys = this.bySection.get(sectionKeyString(section.key));
      if (keys === undefined) continue;
      for (const key of keys) {
        this.entries.delete(key);
      }
      this.bySection.delete(sectionKeyString(section.key));
    }
  }

  private store(key: string, evaluation: StepEvaluation): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      for (const dep of previous.evaluation.dependencies) {
        this.bySection.get(sectionKeyString(dep.key))?.delete(key);
      }
    }
    this.entries.set(key, { evaluation, validUntil: evaluation.validUntil });
    for (const dep of evaluation.dependencies) {
      const depKey = sectionKeyString(dep.key);
      let keys = this.bySection.get(depKey);
      if (keys === undefined) {
        keys = new Set();
        this.bySection.set(depKey, keys);
      }
      keys.add(key);
    }
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
