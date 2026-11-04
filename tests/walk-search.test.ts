import { describe, expect, it } from 'vitest';

import { RouteVerifier, VoxelMap, WalkRouteSearch } from '../src/index.js';
import type {
  SectionKey,
  WalkSearchRequest,
  WalkSearchSnapshot,
} from '../src/index.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

function fill(map: VoxelMap, state: BlockState, cells: Cell[], observedAt = 1000): void {
  for (const [x, y, z] of cells) {
    map.observe(obs(state, { x, y, z }, { observedAt, sequence: observedAt === 1000 ? 1 : 2 }));
  }
}

/** One standable/air column at each integer XZ cell. */
function floorCells(map: VoxelMap, xs: readonly number[], zs: readonly number[]): void {
  for (const x of xs) {
    for (const z of zs) {
      map.observe(obs(STONE, { x, y: -1, z }));
      map.observe(obs(AIR, { x, y: 0, z }));
      map.observe(obs(AIR, { x, y: 1, z }));
    }
  }
}

function request(overrides: Partial<WalkSearchRequest> = {}): WalkSearchRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    target: { x: 1.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    ...overrides,
  };
}

function drain(search: WalkRouteSearch, budget = 1000): WalkSearchSnapshot {
  let snapshot = search.status();
  if (snapshot === null) throw new Error('expected a started search');
  for (let i = 0; i < 10_000 && snapshot.state === 'PENDING'; i++) {
    snapshot = search.advance(budget);
  }
  return snapshot;
}

function sectionKey(cx: number, sy: number): SectionKey {
  return { worldId: 'world', dim: 'overworld', cx, cz: 0, sy };
}

describe('WalkRouteSearch — positive and negative routes', () => {
  it('finds a bounded detour around a blocked straight line', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0, 1]);
    // Wall at x=2, z=0 blocks the three-edge straight line.
    fill(map, STONE, [[2, 0, 0], [2, 1, 0]], 1500);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('FOUND');
    expect(result.candidate).not.toBeNull();
    expect(result.candidate!.edgeCount).toBeGreaterThan(3); // a detour, not the blocked straight line
    expect(result.candidate!.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(result.candidate!.points.at(-1)).toEqual({ x: 3.5, y: 0, z: 0.5 });
    expect(result.counters.edgesBlocked).toBeGreaterThan(0);
    expect(result.problem).toBeUndefined();
  });

  it('reports a fully blocked enclosure as NO_VERIFIED_PATH, not as unknown or blocked policy', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);
    fill(
      map,
      STONE,
      [
        [1, 0, 0],
        [1, 1, 0],
        [-1, 0, 0],
        [-1, 1, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 0, -1],
        [0, 1, -1],
      ],
      1500,
    );

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('NO_VERIFIED_PATH');
    expect(result.problem).toEqual({ kind: 'no_verified_path', blockedEdges: 4 });
    expect(result.counters.edgesBlocked).toBe(4);
    expect(result.frontiers).toEqual([]);
    expect(result.unavailableHistorical).toEqual([]);
    expect(result.candidate).toBeNull();
  });

  it('handles negative coordinates and an X section boundary', () => {
    const map = new VoxelMap('world');
    floorCells(map, [-3, -2, -1], [-1]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(
      request({
        body: bodyAt(-0.5, 0, -0.5),
        target: { x: -2.5, y: 0, z: -0.5 },
      }),
    );
    const result = drain(search);

    expect(result.state).toBe('FOUND');
    expect(result.candidate!.points).toEqual([
      { x: -0.5, y: 0, z: -0.5 },
      { x: -1.5, y: 0, z: -0.5 },
      { x: -2.5, y: 0, z: -0.5 },
    ]);
    expect(result.candidate!.edgeCount).toBe(2);
  });

  it('accepts fractional continuous feet without rounding and keeps the original target', () => {
    const map = new VoxelMap('world');
    floorCells(map, [1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    const started = search.start(
      request({
        body: bodyAt(1.3, 0, 0.5),
        target: { x: 2.3, y: 0, z: 0.5 },
      }),
    );
    expect(started.target).toEqual({ x: 2.3, y: 0, z: 0.5 });
    const result = drain(search);

    expect(result.state).toBe('FOUND');
    expect(result.candidate!.points[0]).toEqual({ x: 1.3, y: 0, z: 0.5 });
    expect(result.candidate!.points[1]!.x).toBeCloseTo(2.3, 10);
    expect(result.candidate!.distanceToTarget).toBeLessThan(1e-9);
    expect(result.target).toEqual({ x: 2.3, y: 0, z: 0.5 });
  });
});

describe('WalkRouteSearch — arrival semantics', () => {
  it('returns a zero-edge candidate at the start, clearly not ARRIVED', () => {
    const map = new VoxelMap('world');
    const search = new WalkRouteSearch(map, { now: () => 2000 });
    const result = search.start(
      request({
        body: bodyAt(0.5, 0, 0.5),
        target: { x: 0.5, y: 0, z: 0.5 },
      }),
    );

    expect(result.state).toBe('FOUND');
    expect(result.candidate).toEqual({
      points: [{ x: 0.5, y: 0, z: 0.5 }],
      edgeCount: 0,
      reachedAt: { x: 0.5, y: 0, z: 0.5 },
      target: { x: 0.5, y: 0, z: 0.5 },
      arrival: { kind: 'exact' },
      distanceToTarget: 0,
      validUntil: Number.POSITIVE_INFINITY,
    });
    expect(result.reason).toMatch(/zero-edge candidate/);
    expect(result.reason).toMatch(/not ARRIVED/);
    expect(result.counters.edgesEvaluated).toBe(0);
  });

  it('checks near completion with full XYZ distance at each reached stance', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(
      request({
        target: { x: 2.5, y: 0, z: 0.5 },
        arrival: { kind: 'near', radius: 0.6 },
      }),
    );
    const result = drain(search);

    expect(result.state).toBe('FOUND');
    expect(result.candidate!.reachedAt).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(result.candidate!.distanceToTarget).toBe(0);
    expect(result.arrival).toEqual({ kind: 'near', radius: 0.6 });
    expect(result.target).toEqual({ x: 2.5, y: 0, z: 0.5 });
  });

  it('does not accept a horizontal-only near hit when the full XYZ distance is too large', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);
    // Close the corridor: -X at x=-1, +X at x=3, and both Z sides for all stances.
    fill(map, STONE, [[-1, 0, 0], [-1, 1, 0], [3, 0, 0], [3, 1, 0]], 1500);
    const sides: Cell[] = [];
    for (const x of [0, 1, 2]) {
      sides.push([x, 0, 1], [x, 1, 1], [x, 0, -1], [x, 1, -1]);
    }
    fill(map, STONE, sides, 1500);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(
      request({
        target: { x: 2, y: 0.5, z: 0.5 },
        arrival: { kind: 'near', radius: 0.6 },
      }),
    );
    const result = drain(search);

    // XZ-only distance at x=1.5/2.5 is 0.5, but full XYZ distance is ≈0.707 > 0.6.
    expect(result.state).toBe('NO_VERIFIED_PATH');
    expect(result.problem?.kind).toBe('no_verified_path');
    expect(result.candidate).toBeNull();
  });

  it('rejects a near radius that cannot cover the fixed height difference', () => {
    const map = new VoxelMap('world');
    const search = new WalkRouteSearch(map, { now: () => 2000 });
    const result = search.start(
      request({
        target: { x: 0.5, y: 1, z: 0.5 },
        arrival: { kind: 'near', radius: 0.5 },
      }),
    );

    expect(result.state).toBe('NO_VERIFIED_PATH');
    expect(result.problem).toMatchObject({ kind: 'no_verified_path', blockedEdges: 0 });
    expect(result.reason).toMatch(/height difference/);
    expect(result.counters.edgesEvaluated).toBe(0);
  });

  it('returns an explicit capability limitation for exact wrong-height and fractional targets', () => {
    const map = new VoxelMap('world');
    const search = new WalkRouteSearch(map, { now: () => 2000 });

    const wrongHeight = search.start(request({ target: { x: 0.5, y: 1, z: 0.5 } }));
    expect(wrongHeight.state).toBe('UNSUPPORTED');
    expect(wrongHeight.problem).toMatchObject({ kind: 'unsupported_target' });
    expect(wrongHeight.reason).toMatch(/height/);

    const fractional = search.start(request({ target: { x: 1, y: 0, z: 0.5 } }));
    expect(fractional.state).toBe('UNSUPPORTED');
    expect(fractional.problem).toMatchObject({ kind: 'unsupported_target' });
    expect(fractional.reason).toMatch(/not an integer/);
    expect(fractional.reason).toMatch(/not rounded/);
    // The caller's target is retained exactly; it was never changed to a nearby lattice point.
    expect(fractional.target).toEqual({ x: 1, y: 0, z: 0.5 });
  });

  it('reports a non-walk mode as an unsupported capability', () => {
    const map = new VoxelMap('world');
    const search = new WalkRouteSearch(map, { now: () => 2000 });
    const result = search.start(request({ mode: 'jump' }));

    expect(result.state).toBe('UNSUPPORTED');
    expect(result.problem).toEqual({
      kind: 'unsupported_mode',
      mode: 'jump',
      detail: 'the walk route search supports mode "walk" only',
    });
    expect(result.counters.edgesEvaluated).toBe(0);
  });
});

describe('WalkRouteSearch — unknown, stale and unsupported evidence', () => {
  it('distinguishes never-observed frontier evidence from blocked terrain', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.problem).toMatchObject({
      kind: 'insufficient_evidence',
      unknownEdges: 4,
      staleEdges: 0,
      unsupportedEdges: 0,
    });
    expect(result.counters.edgesUnknown).toBe(4);
    expect(result.frontiers).toHaveLength(4);
    expect(result.unavailableHistorical).toEqual([]);
    expect(result.diagnostics.every((d) => d.status === 'UNKNOWN')).toBe(true);
  });

  it('reports stale evidence separately and never as a new frontier', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1], [0]);

    // Observations are at 1000 with a 60s window; the search clock is far past it.
    const search = new WalkRouteSearch(map, { now: () => 70_000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.counters.edgesStale).toBeGreaterThan(0);
    expect(result.counters.edgesUnknown).toBe(0);
    expect(result.frontiers).toEqual([]);
    expect(result.diagnostics.some((d) => d.status === 'STALE')).toBe(true);
  });

  it('reports an unresolvable shape as UNSUPPORTED evidence, distinct from UNKNOWN and STALE', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);
    // fakeProvider has no rule for chest → unsupported_shape.
    fill(map, { name: 'minecraft:chest', properties: {} }, [[1, 0, 0]], 1500);
    fill(map, STONE, [[1, -1, 0]], 1500);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.counters.edgesUnsupported).toBeGreaterThan(0);
    expect(result.counters.edgesUnknown).toBeGreaterThan(0); // the other directions
    expect(result.diagnostics.some((d) => d.status === 'UNSUPPORTED')).toBe(true);
    expect(
      result.diagnostics.some(
        (d) => d.status === 'UNSUPPORTED' && d.problem?.kind === 'unsupported_shape',
      ),
    ).toBe(true);
  });

  it('carries a reachable stance, an unentered gap, observed basis and validity for a frontier', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.candidate).toBeNull();
    expect(result.frontiers.length).toBeGreaterThan(0);
    for (const frontier of result.frontiers) {
      expect(frontier.reachability).toBe('OPEN'); // the stance only
      expect(frontier.stance).toEqual({ x: 0.5, y: 0, z: 0.5 });
      expect(frontier.to).not.toEqual(frontier.stance); // the gap itself is not claimed reachable
      expect(frontier.gap.length).toBeGreaterThan(0);
      expect(frontier.basis.length).toBeGreaterThan(0); // observed stance cells
      expect(frontier.basis.every((o) => o.sessionId === 's1')).toBe(true);
      expect(frontier.computedAt).toBe(2000);
      expect(Number.isFinite(frontier.validUntil)).toBe(true);
      expect(frontier.validUntil).toBeLessThanOrEqual(61_000);
      expect(frontier.reason.length).toBeGreaterThan(0);
    }
    expect(result.diagnostics[0]?.computedAt).toBe(2000);
  });

  it('bounds frontier and diagnostic output without continuing work past the caps', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000, maxFrontiers: 1, maxDiagnostics: 2 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.frontiers).toHaveLength(1);
    expect(result.counters.frontierCandidates).toBe(4);
    expect(result.counters.frontiersReported).toBe(1);
    expect(result.counters.frontierLimitReached).toBe(true);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.counters.diagnosticsTruncated).toBe(true);
    expect(result.counters.hasMoreWork).toBe(false);
  });

  it.each([
    ['not_resident', 'not_resident'],
    ['loading', 'loading'],
    ['load_failed', 'load_failed'],
  ] as const)(
    'reports an unavailable saved section (%s) separately, not as a new frontier',
    (_label, expectedResidency) => {
      const map = new VoxelMap('world', { manualResidency: true });
      const saved = sectionKey(1, 0);
      map.installDirectory([
        { key: saved, seq: 0, bytes: 100, observedCells: 1, paletteEntries: 2, revision: 1 },
      ]);
      if (expectedResidency === 'loading') map.markLoading([saved]);
      if (expectedResidency === 'load_failed') map.markLoadFailed([saved]);

      // Start at x=15.5 in cx=0; the +X stance at x=16.5 is in the saved, unavailable cx=1.
      floorCells(map, [15], [0]);
      fill(
        map,
        STONE,
        [
          [14, 0, 0],
          [14, 1, 0],
          [15, 0, 1],
          [15, 1, 1],
          [15, 0, -1],
          [15, 1, -1],
        ],
        1500,
      );

      const search = new WalkRouteSearch(map, { now: () => 2000 });
      search.start(
        request({
          body: bodyAt(15.5, 0, 0.5),
          target: { x: 16.5, y: 0, z: 0.5 },
        }),
      );
      const result = drain(search);

      expect(map.sectionResidency(saved).residency).toBe(expectedResidency);
      expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.frontiers).toEqual([]);
      expect(result.unavailableHistorical).toHaveLength(1);
      expect(result.unavailableHistorical[0]!.stance).toEqual({ x: 15.5, y: 0, z: 0.5 });
      expect(result.unavailableHistorical[0]!.to).toEqual({ x: 16.5, y: 0, z: 0.5 });
      expect(result.unavailableHistorical[0]!.sections).toContainEqual({
        key: saved,
        residency: expectedResidency,
        committedRevision: 1,
      });
      expect(result.counters.unavailableHistoricalCandidates).toBe(1);
      expect(result.candidate).toBeNull();
    },
  );
});

describe('WalkRouteSearch — incremental work and hard budgets', () => {
  it('advances in bounded slices and only reports FOUND after enough work', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    const started = search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    expect(started.state).toBe('PENDING');
    expect(started.counters.hasMoreWork).toBe(true);

    const one = search.advance(1);
    expect(one.state).toBe('PENDING');
    expect(one.candidate).toBeNull();
    expect(one.counters.edgesEvaluated).toBe(1);
    expect(one.reason).toMatch(/budget/);

    const two = search.advance(1);
    expect(two.state).toBe('PENDING');
    expect(two.counters.edgesEvaluated).toBe(2);

    const done = drain(search, 100);
    expect(done.state).toBe('FOUND');
    expect(done.candidate!.edgeCount).toBe(2);

    const again = search.advance(10);
    expect(again.state).toBe('FOUND');
    expect(again.counters.edgesEvaluated).toBe(done.counters.edgesEvaluated);
  });

  it('stops at the hard edge limit with an explicit budget_exhausted problem', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000, maxEdges: 1 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('BUDGET_EXHAUSTED');
    expect(result.problem).toMatchObject({
      kind: 'budget_exhausted',
      edgeLimitReached: true,
      maxEdges: 1,
      edgesEvaluated: 1,
    });
    expect(result.counters.edgesEvaluated).toBe(1);
    expect(result.counters.hasMoreWork).toBe(false);
  });

  it('stops at the hard node limit with an explicit budget_exhausted problem', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000, maxNodes: 1 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);

    expect(result.state).toBe('BUDGET_EXHAUSTED');
    expect(result.problem).toMatchObject({
      kind: 'budget_exhausted',
      nodeLimitReached: true,
      maxNodes: 1,
      nodesReached: 1,
    });
    expect(result.counters.nodesReached).toBe(1);
  });

  it('rejects invalid budgets and options', () => {
    const map = new VoxelMap('world');
    expect(() => new WalkRouteSearch(map, { maxNodes: 0 })).toThrow(/positive safe integer/);
    expect(() => new WalkRouteSearch(map, { maxEdges: 1.5 })).toThrow(/positive safe integer/);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request());
    expect(() => search.advance(0)).toThrow(/positive integer/);
    expect(() => search.advance(-1)).toThrow(/positive integer/);
    expect(() => search.advance(1.5)).toThrow(/positive integer/);
  });
});

describe('WalkRouteSearch — cancellation', () => {
  it('cancels before any advance without evaluating an edge', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));

    const cancelled = search.cancel('user abort');
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.cancellation).toEqual({ reason: 'user abort' });
    expect(cancelled.counters.edgesEvaluated).toBe(0);

    const after = search.advance(10);
    expect(after.state).toBe('CANCELLED');
    expect(after.counters.edgesEvaluated).toBe(0);
  });

  it('cancels mid-search and keeps the work already performed', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    const partial = search.advance(1);
    expect(partial.state).toBe('PENDING');
    expect(partial.counters.edgesEvaluated).toBe(1);

    const cancelled = search.cancel('scheduler abort');
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.counters.edgesEvaluated).toBe(1);
    expect(cancelled.counters.nodesReached).toBe(partial.counters.nodesReached);

    const after = search.advance(10);
    expect(after.state).toBe('CANCELLED');
    expect(after.counters.edgesEvaluated).toBe(1);
  });
});

describe('WalkRouteSearch — evidence invalidation and expiry', () => {
  it('invalidates rather than combining old OPEN edges with a changed section', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    expect(search.advance(1).state).toBe('PENDING');

    const report = map.observe(
      obs(STONE, { x: 2, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }),
    );
    search.invalidate(report);

    const invalidated = search.status();
    expect(invalidated?.state).toBe('INVALIDATED');
    expect(invalidated?.candidate).toBeNull();
    expect(invalidated?.problem).toMatchObject({ kind: 'invalidated' });
    expect(invalidated?.reason).toMatch(/start a fresh search request/);

    const after = search.advance(10);
    expect(after.state).toBe('INVALIDATED');
    expect(after.counters.edgesEvaluated).toBe(1);
  });

  it('preserves the search across an unrelated section change', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    expect(search.advance(1).state).toBe('PENDING');

    const report = map.observe(
      obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }),
    );
    search.invalidate(report);

    const stillPending = search.status();
    expect(stillPending?.state).toBe('PENDING');
    expect(stillPending?.counters.edgesEvaluated).toBe(1);
  });

  it('invalidates when the evidence window expires between slices', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    floorCells(map, [0, 1, 2, 3], [0]);

    const search = new WalkRouteSearch(map, { now: () => clock });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    expect(search.advance(1).state).toBe('PENDING');

    clock = 70_000; // past observedAt 1000 + 60_000
    const expired = search.status();
    expect(expired?.state).toBe('INVALIDATED');
    expect(expired?.candidate).toBeNull();
    expect(expired?.problem).toMatchObject({ kind: 'invalidated' });
    expect(expired?.reason).toMatch(/valid until/);

    clock = 71_000;
    expect(search.advance(10).state).toBe('INVALIDATED');
  });

  it('invalidates a FOUND candidate when its evidence expires', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    floorCells(map, [0, 1], [0]);

    const search = new WalkRouteSearch(map, { now: () => clock });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const found = drain(search);
    expect(found.state).toBe('FOUND');
    expect(found.candidate).not.toBeNull();

    clock = 70_000;
    const expired = search.status();
    expect(expired?.state).toBe('INVALIDATED');
    expect(expired?.candidate).toBeNull();
  });

  it('invalidates when the shape-rule version changes between slices', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0]);
    const provider = { ...fakeProvider };

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 }, shapeProvider: provider }));
    expect(search.advance(1).state).toBe('PENDING');

    provider.version = 'fake-2';
    const invalidated = search.status();
    expect(invalidated?.state).toBe('INVALIDATED');
    expect(invalidated?.reason).toMatch(/rule version/);
  });
});

describe('WalkRouteSearch — read-only and snapshot isolation', () => {
  it('never mutates map evidence, time or save revision', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);
    const sectionBefore = map.sectionAt('overworld', 0, 0, 0);
    const cellBefore = map.cellAt('overworld', 0, 0, 0);
    const revisionBefore = map.saveRevision;

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    const result = drain(search);
    search.status();

    expect(result.state).toBe('FOUND');
    expect(map.saveRevision).toBe(revisionBefore);
    expect(map.sectionAt('overworld', 0, 0, 0)).toEqual(sectionBefore);
    expect(map.cellAt('overworld', 0, 0, 0)).toEqual(cellBefore);
    expect(map.cellAt('overworld', 50, 0, 50)).toEqual({ observed: false });
  });

  it('snapshots the request and never aliases returned snapshots', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const req = request({ target: { x: 2.5, y: 0, z: 0.5 } });
    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(req);

    // Mutating the caller-owned request after start cannot change the search.
    req.body.feet.x = 999;
    req.body.width = 999;
    req.target.x = 999;
    if (req.arrival.kind === 'near') req.arrival.radius = 999;

    const found = drain(search);
    expect(found.state).toBe('FOUND');
    expect(found.from).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(found.body.width).toBe(0.6);
    expect(found.target).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(found.candidate!.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });

    // Mutating a returned snapshot cannot pollute later reads.
    found.candidate!.points[0]!.x = 999;
    found.candidate!.target.x = 999;
    found.body.feet.x = 999;
    found.from.x = 999;
    found.target.x = 999;
    found.limits.maxNodes = 1;

    const again = search.status();
    expect(again?.candidate!.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(again?.candidate!.target).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(again?.body.feet.x).toBe(0.5);
    expect(again?.from.x).toBe(0.5);
    expect(again?.target.x).toBe(2.5);
    expect(again?.limits.maxNodes).toBe(2048);
  });

  it('snapshots frontier basis, gap and diagnostic problem cells', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const result = drain(search);
    expect(result.frontiers.length).toBeGreaterThan(0);
    const originalGapX = result.frontiers[0]!.gap[0]!.x;

    result.frontiers[0]!.stance.x = 999;
    result.frontiers[0]!.to.x = 999;
    result.frontiers[0]!.gap[0]!.x = 999;
    result.frontiers[0]!.basis[0]!.state.properties['mutated'] = 'yes';
    const diagnosticProblem = result.diagnostics[0]!.problem;
    if (diagnosticProblem !== undefined) diagnosticProblem.cells[0]!.x = 999;

    const again = search.status();
    expect(again?.frontiers[0]!.stance.x).toBe(0.5);
    expect(again?.frontiers[0]!.to.x).not.toBe(999);
    expect(again?.frontiers[0]!.gap[0]!.x).toBe(originalGapX);
    expect(again?.frontiers[0]!.basis[0]!.state.properties['mutated']).toBeUndefined();
    expect(again?.diagnostics[0]!.problem?.cells[0]!.x).not.toBe(999);
  });
});

describe('WalkRouteSearch — candidate hand-off', () => {
  it('produces a candidate that RouteVerifier accepts as currently OPEN', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    const result = drain(search);
    expect(result.state).toBe('FOUND');
    const points = result.candidate!.points;

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      mode: 'walk',
      body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
      shapeProvider: fakeProvider,
      points,
    });
    const verified = verifier.advance(1000);

    expect(verified.verdict).toBe('OPEN');
    expect(verified.points).toEqual(points);
    // The search itself never claims arrival.
    expect('outcome' in result).toBe(false);
  });
});
