import { describe, expect, it } from 'vitest';

import { RouteVerifier, VoxelMap } from '../src/index.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import type { StepEvaluation } from '../src/traversability/step.js';
import type { RouteRequest, RouteStatus } from '../src/traversability/route.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

/**
 * Internal-accessor discriminators for the RouteVerifier per-step fast path:
 * the ascending pending cursor, the once-per-section residency index, the
 * gated expiry scan, and `stepAt` agreeing with the `status()` projection.
 * These are internal seams (not package exports); the public semantics are
 * covered by `route-verifier.test.ts`.
 */

function openRouteMap(map: VoxelMap, nPoints: number): RouteRequest['points'] {
  for (let k = 0; k < nPoints; k++) {
    map.observe(obs(STONE, { x: k, y: -1, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 1, z: 0 }));
  }
  return Array.from({ length: nPoints }, (_, k) => ({ x: k + 0.5, y: 0, z: 0.5 }));
}

function routeRequest(
  points: RouteRequest['points'],
  shapeProvider: CollisionShapeProvider = fakeProvider,
): RouteRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider,
    points,
  };
}

function status(verifier: RouteVerifier): RouteStatus {
  const s = verifier.status();
  if (s === null) throw new Error('expected a registered route');
  return s;
}

function applyStatus(
  verifier: RouteVerifier,
  report: Parameters<RouteVerifier['apply']>[0],
  budget: number,
): RouteStatus {
  const s = verifier.apply(report, budget);
  if (s === null) throw new Error('expected a registered route');
  return s;
}

/** The `status()` projection of step `i`: its evaluation, or undefined when pending. */
function projectedStep(s: RouteStatus, i: number): StepEvaluation | undefined {
  const step = s.steps[i]!;
  return step.kind === 'verified' ? step.result : undefined;
}

function changeReport(changed: Map<number, Map<string, number>>): Parameters<RouteVerifier['apply']>[0] {
  return {
    sections: [...changed].flatMap(([cx, sections]) =>
      [...sections].map(([zy, revision]) => {
        const [cz, sy] = zy.split(',').map(Number);
        return {
          key: { worldId: 'world', dim: 'overworld', cx, cz: cz!, sy: sy! },
          revision,
          invalidated: true,
          cells: [],
        };
      }),
    ),
  };
}

describe('RouteVerifier — pending cursor discriminators', () => {
  it('an invalidation behind the cursor moves it back before later pending steps', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 20);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));

    // Three verified steps leave the cursor at 3 with a long unprocessed tail.
    expect(verifier.advance(3).verifiedStepIndexes).toEqual([0, 1, 2]);
    expect(status(verifier).steps[3]).toEqual({ kind: 'pending', reason: 'unprocessed' });

    // Invalidate cx=0 (steps 0..2 have results there) and give the round one
    // unit of budget. A cursor without a backwards reset would spend that unit
    // on step 3; the reset makes it re-verify step 0 in ascending order.
    const after = applyStatus(verifier, changeReport(new Map([[0, new Map([['0,0', 2]])]])), 1);
    expect(after.verifiedStepIndexes).toEqual([0]);
    expect(after.steps[0]!.kind).toBe('verified');
    expect(after.steps[1]).toEqual({ kind: 'pending', reason: 'invalidated' });
    expect(after.steps[3]).toEqual({ kind: 'pending', reason: 'unprocessed' });

    // The cursor keeps ascending through the invalidated prefix.
    const next = verifier.advance(2);
    expect(next.verifiedStepIndexes).toEqual([0, 1, 2]);
    expect(next.steps[3]).toEqual({ kind: 'pending', reason: 'unprocessed' });
  });
});

describe('RouteVerifier — residency index discriminators', () => {
  it('invalidates only the steps depending on a section whose residency changed', () => {
    const map = new VoxelMap('world');
    // x = 0..19 spans cx = 0 and cx = 1, so the dependency split is observable.
    const points = openRouteMap(map, 20);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    expect(verifier.advance(100).verdict).toBe('OPEN');
    expect(status(verifier).verifiedStepIndexes).toEqual(Array.from({ length: 19 }, (_, i) => i));

    // A residency change on a section no step depends on leaves every result
    // and its recorded generation untouched.
    verifier.invalidateSections([{ worldId: 'world', dim: 'overworld', cx: 50, cz: 50, sy: 50 }]);
    expect(status(verifier).verifiedStepIndexes).toHaveLength(19);

    // Steps are split by the swept footprint x∈[15,17]: steps 0..14 depend on
    // cx=0 only, steps 15..18 additionally on cx=1. Only the latter are re-queued.
    verifier.invalidate(changeReport(new Map([[1, new Map([['0,0', 2]])]])));
    const view = status(verifier);
    expect(view.verifiedStepIndexes).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(view.pendingStepIndexes).toEqual([15, 16, 17, 18]);
    expect(view.steps[15]).toEqual({ kind: 'pending', reason: 'invalidated' });

    // Replaying the same report is idempotent: the already-pending steps keep
    // their reason and the re-indexed section cannot resurrect a result.
    verifier.invalidate(changeReport(new Map([[1, new Map([['0,0', 2]])]])));
    expect(status(verifier).pendingStepIndexes).toEqual([15, 16, 17, 18]);
  });

  it('stepAt drops a result whose section residency generation changed', () => {
    // Manual residency lets us unload/reload a Section (which bumps its
    // generation) without a ChangeReport, exactly as the host does.
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory([]);
    const points = openRouteMap(map, 4);
    map.confirmSections(map.saveRevision);
    const checkpoint = map.checkpointSnapshot();
    map.commitDirectory('full', checkpoint.sections, []);

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');
    expect(verifier.stepAt(0)?.status).toBe('OPEN');

    const first = verifier.stepAt(0)!.dependencies[0]!.key;
    const key = { worldId: 'world', dim: first.dim, cx: first.cx, cz: first.cz, sy: first.sy };
    expect(map.unloadSections([key]).unloaded).toEqual([key]);
    const section = checkpoint.sections.find((s) => s.cx === key.cx && s.cz === key.cz && s.sy === key.sy);
    if (section === undefined) throw new Error('missing checkpoint section');
    map.installLoadedSections([section]);

    // Both the projection and the per-step accessor observe the generation bump.
    const after = status(verifier);
    expect(after.steps[0]).toEqual({ kind: 'pending', reason: 'invalidated' });
    expect(verifier.stepAt(0)).toBeUndefined();
  });
});

describe('RouteVerifier — expiry gate discriminators', () => {
  it('expires a step exactly at the first clock tick past its horizon', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    let now = 2000;
    const verifier = new RouteVerifier(map, { now: () => now });
    verifier.register(routeRequest(points));
    const verified = verifier.advance(10);
    expect(verified.verdict).toBe('OPEN');
    const horizon = verified.validUntil;
    expect(Number.isFinite(horizon)).toBe(true);

    // At the horizon the gate holds the cached scan; nothing has expired.
    now = horizon;
    expect(verifier.advance(10).verdict).toBe('OPEN');
    expect(verifier.stepAt(0)?.status).toBe('OPEN');

    // One tick later the gate reopens: every non-STALE result expires and is
    // re-verified (the evidence is itself expired, so the verdict is STALE).
    now = horizon + 1;
    expect(verifier.stepAt(0)).toBeUndefined();
    const after = verifier.advance(10);
    expect(after.verdict).toBe('STALE');
    expect(after.pendingStepIndexes).toEqual([]);
  });

  it('keeps a current STALE diagnosis from the horizon gate', () => {
    const map = new VoxelMap('world');
    // No evidence at all: every step is UNKNOWN, never STALE.
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    const points = Array.from({ length: 3 }, (_, k) => ({ x: k + 0.5, y: 0, z: 0.5 }));
    verifier.register(routeRequest(points));
    const s = verifier.advance(10);
    expect(s.verdict).toBe('UNKNOWN');
    expect(verifier.stepAt(0)?.status).toBe('UNKNOWN');
  });
});

describe('RouteVerifier — rule version through the accessors', () => {
  it('currentRuleVersion and stepAt follow a provider version change like status()', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4);
    const provider: CollisionShapeProvider = {
      version: 'v1',
      resolve(state, cell, read) {
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points, provider));
    expect(verifier.advance(10).verdict).toBe('OPEN');
    expect(verifier.currentRuleVersion()).toBe('v1');
    expect(verifier.stepAt(0)?.status).toBe('OPEN');

    provider.version = 'v2';
    // The accessor reconciles first, exactly like `status()`: every previously
    // verified step is re-queued as invalidated before any re-verification.
    expect(verifier.currentRuleVersion()).toBe('v2');
    expect(verifier.stepAt(0)).toBeUndefined();
    const view = status(verifier);
    expect(view.ruleVersion).toBe('v2');
    expect(view.steps[0]).toEqual({ kind: 'pending', reason: 'invalidated' });

    verifier.advance(10);
    expect(verifier.currentRuleVersion()).toBe('v2');
    expect(verifier.stepAt(0)?.status).toBe('OPEN');
  });
});

describe('RouteVerifier — advanceVerification equivalence', () => {
  it('leaves the same state as advance() without projecting a throwaway status', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 8);
    const viaAdvance = new RouteVerifier(map, { now: () => 2000 });
    const viaInternal = new RouteVerifier(map, { now: () => 2000 });
    viaAdvance.register(routeRequest(points));
    viaInternal.register(routeRequest(points));

    for (const budget of [3, 1, 2]) {
      viaAdvance.advance(budget);
      viaInternal.advanceVerification(budget);
    }
    expect(status(viaInternal)).toStrictEqual(status(viaAdvance));
  });
});

describe('RouteVerifier — stepAt agrees with the status projection', () => {
  it('matches the non-cloned evaluation across advance, apply and residency changes', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 6);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));

    const compare = () => {
      const s = status(verifier);
      for (let i = 0; i < s.stepCount; i++) {
        expect(verifier.stepAt(i)).toStrictEqual(projectedStep(s, i));
      }
    };

    verifier.advance(2);
    compare();
    verifier.apply(changeReport(new Map([[2, new Map([['0,0', 2]])]])), 3);
    compare();
    verifier.invalidateSections([{ worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 }]);
    compare();
    verifier.advance(100);
    compare();
  });
});
