import { describe, expect, it } from 'vitest';
import { searchLandRoute, searchLandRouteAsync } from '../src/navigation/index.js';
import type { LandSearchRequest } from '../src/navigation/index.js';
import { evaluateRememberedWalkStep, evaluateWalkStep } from '../src/traversability/step.js';
import { evaluateRememberedLandTransition, resolveLandLimits } from '../src/traversability/land-transition.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { AIR, SLAB, STONE, bodyAt, fakeProvider, obs, stepQuery } from './fakes.js';

type Column = { x: number; z: number; height: number };

function terrain(columns: readonly Column[], omit = ''): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  columns.forEach(({ x, z, height }) => {
    for (let y = -6; y <= 10; y++) {
      if (`${x},${y},${z}` === omit) continue;
      const state = y + 1 <= height ? STONE
        : y < height ? SLAB : AIR;
      map.observe(obs(state, { x, y, z }));
    }
  });
  return map;
}

function request(overrides: Partial<LandSearchRequest> = {}): LandSearchRequest {
  return {
    worldId: 'world', dim: 'overworld', sessionId: 's1',
    body: bodyAt(0.5, 0, 0.5), to: { x: 2.5, y: 0, z: 0.5 },
    rules: { shapeProvider: fakeProvider }, ...overrides,
  };
}

const flat = (length = 3): Column[] => Array.from({ length }, (_, x) => ({ x, z: 0, height: 0 }));

describe('bounded voxel land search', () => {
  it('finds a voxel-only route across negative coordinates, slabs, steps and drops', () => {
    const map = terrain([
      { x: -2, z: -1, height: 0 }, { x: -1, z: -1, height: 0.5 },
      { x: 0, z: -1, height: 1.5 }, { x: 1, z: -1, height: 1 },
    ]);
    const before = map.checkpointSnapshot();
    const result = searchLandRoute(map, request({ body: bodyAt(-1.5, 0, -0.5), to: { x: 1.5, y: 1, z: -0.5 } }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['step', 'step', 'drop']);
    expect(result.points.map((point) => point.y)).toEqual([0, 0.5, 1.5, 1]);
    expect(result.cost).toBe(8);
    expect(result.executable).toBe(false);
    expect(result.needsRevalidation).toBe(true);
    expect(map.checkpointSnapshot()).toEqual(before);
  });

  it('preserves fractional starting offsets and exact targets without centering or height snapping', () => {
    const map = terrain(flat());
    const exact = request({ body: bodyAt(0.4, 0, 0.4), to: { x: 2.4, y: 0, z: 0.4 } });
    const result = searchLandRoute(map, exact, 2000);
    expect(result.status).toBe('FOUND');
    expect(result.points[0]).toEqual(exact.body.feet);
    expect(result.points.at(-1)).toEqual(exact.to);
    const offLattice = searchLandRoute(map, { ...exact, to: { x: 2.5, y: 0, z: 0.5 } }, 2000);
    expect(offLattice.status).toBe('UNSUPPORTED');
    expect(offLattice.target).toEqual({ x: 2.5, y: 0, z: 0.5 });
    const wrongHeight = searchLandRoute(map, request({ to: { x: 2.5, y: 0.25, z: 0.5 } }), 2000);
    expect(wrongHeight.status).not.toBe('FOUND');
    expect(wrongHeight.target.y).toBe(0.25);
  });

  it('keeps near-target completion in full XYZ without replacing the original target', () => {
    const map = terrain(flat());
    const to = { x: 2.7, y: 0.2, z: 0.5 };
    const result = searchLandRoute(map, request({ to, arrival: { kind: 'near', radius: 0.3 } }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.target).toEqual(to);
    expect(result.points.at(-1)).toEqual({ x: 2.5, y: 0, z: 0.5 });
    const tooHigh = searchLandRoute(map, request({ to: { ...to, y: 1 }, arrival: { kind: 'near', radius: 0.3 } }), 2000);
    expect(tooHigh.status).not.toBe('FOUND');
  });

  it('plans remembered geometry across sessions without refreshing or changing any source evidence', () => {
    const map = terrain(flat());
    map.beginSession('s2');
    const before = map.checkpointSnapshot();
    const current = searchLandRoute(map, request({ sessionId: 's2' }), 1000000);
    expect(current.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(current.boundaries.some((entry) => entry.status === 'STALE')).toBe(true);
    const remembered = searchLandRoute(map, request({ sessionId: 's2', evidenceMode: 'remembered' }), 1000000);
    expect(remembered.status).toBe('FOUND');
    expect(remembered.assurance).toBe('historical_geometry');
    expect(remembered.executable).toBe(false);
    expect(remembered.stats.staleReads).toBeGreaterThan(0);
    expect(map.checkpointSnapshot()).toEqual(before);
    expect(evaluateWalkStep(map, stepQuery({ sessionId: 's2' }), fakeProvider, 1000000).status).toBe('STALE');
  });

  it('does not turn unknown or incomplete headroom into remembered air', () => {
    const missing = terrain(flat(), '1,1,0');
    const unknown = searchLandRoute(missing, request({ evidenceMode: 'remembered' }), 2000);
    expect(unknown.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(unknown.points).toEqual([]);
    const incomplete = terrain(flat());
    incomplete.observe(obs(AIR, { x: 1, y: 1, z: 0 }, { observedAt: 1500, stateComplete: false }));
    const result = searchLandRoute(incomplete, request({ evidenceMode: 'remembered' }), 2000);
    expect(result.status).not.toBe('FOUND');
  });

  it('reports fully observed missing support as a geometric gap, not missing evidence', () => {
    const map = new VoxelMap('world');
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        for (let y = -5; y <= 2; y++) {
          map.observe(obs(x === 0 && y === -1 && z === 0 ? STONE : AIR, { x, y, z }));
        }
      }
    }
    const result = searchLandRoute(map, request({ to: { x: 1.5, y: 0, z: 0.5 } }), 2000);
    expect(result.status).toBe('NO_PATH_IN_MEMORY');
    expect(result.boundaries.every((entry) => entry.status === 'BLOCKED')).toBe(true);
  });

  it('keeps bridge and cave heights separate and never adds a flying edge', () => {
    const map = terrain(flat());
    flat().forEach(({ x }) => map.observe(obs(STONE, { x, y: 4, z: 0 }, { observedAt: 1500 })));
    const below = searchLandRoute(map, request(), 2000);
    expect(below.status).toBe('FOUND');
    expect(below.points.every((point) => point.y === 0)).toBe(true);
    const above = searchLandRoute(map, request({ body: bodyAt(0.5, 5, 0.5), to: { x: 2.5, y: 5, z: 0.5 } }), 2000);
    expect(above.status).toBe('FOUND');
    expect(above.points.every((point) => point.y === 5)).toBe(true);
    const fly = searchLandRoute(map, request({ to: { x: 2.5, y: 5, z: 0.5 } }), 2000);
    expect(fly.status).not.toBe('FOUND');
  });

  it('returns requested movement restrictions without treating them as terrain', () => {
    const map = terrain([{ x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 1 }]);
    const result = searchLandRoute(map, request({ to: { x: 1.5, y: 1, z: 0.5 }, allowed: ['walk'] }), 2000);
    expect(result.status).not.toBe('FOUND');
    expect(result.boundaries).toContainEqual(expect.objectContaining({ status: 'UNSUPPORTED', reason: expect.stringContaining('outside the requested') }));
  });

  it.each([
    ['nodes', { maxNodes: 1 }], ['edges', { maxEdges: 1 }],
    ['reads', { maxSurfaceReads: 1 }], ['sections', { maxSections: 1 }],
    ['points', { maxRoutePoints: 1 }], ['time', { deadlineMs: 0 }],
    ['geometry', { geometryLimits: { maxWork: 1 } }],
  ] as const)('reports %s exhaustion independently from a blocked path', (budget, limits) => {
    const result = searchLandRoute(terrain(flat()), request(limits), 2000);
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe(budget);
    expect(result.points).toEqual([]);
  });

  it('retains caller cancellation and does not claim a zero-distance arrival after cancellation', () => {
    const controller = new AbortController();
    controller.abort('caller stopped');
    const result = searchLandRoute(terrain(flat()), request({ signal: controller.signal, to: { x: 0.5, y: 0, z: 0.5 } }), 2000);
    expect(result.status).toBe('CANCELLED');
  });

  it('preserves third-party shape-provider failures instead of reclassifying them as terrain', () => {
    const failure = new Error('shape rules failed');
    const query = request({ rules: { shapeProvider: { version: 'failing-rule', resolve() { throw failure; } } } });
    expect(() => searchLandRoute(terrain(flat()), query, 2000)).toThrow(failure);
  });

  it('distinguishes saved nonresident pages from never observed cells without loading them', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: -1 };
    map.installDirectory([{ key, seq: 0, bytes: 1000, observedCells: 256, paletteEntries: 2, revision: 10 }]);
    const result = searchLandRoute(map, request({ evidenceMode: 'remembered' }), 2000);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.unavailableSections).toContainEqual(key);
    expect(map.sectionResidency(key).residency).toBe('not_resident');
    expect(map.residentSize().sections).toBe(0);
  });

  it('uses distinguishable historical geometry results instead of returning OPEN', () => {
    const map = terrain([{ x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 1 }]);
    map.beginSession('s2');
    const result = evaluateRememberedLandTransition(map, {
      worldId: 'world', dim: 'overworld', sessionId: 's2', body: bodyAt(0.5, 0, 0.5),
      transition: { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 0.5 } },
    }, { shapeProvider: fakeProvider }, 2000, resolveLandLimits());
    expect(result.geometry).toBe('PASSABLE');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('validUntil');
    const walkMap = terrain(flat());
    walkMap.beginSession('s2');
    const walk = evaluateRememberedWalkStep(walkMap, stepQuery({ sessionId: 's2' }), fakeProvider, 2000);
    expect(walk.geometry).toBe('PASSABLE');
    expect(walk).not.toHaveProperty('status');
  });
});

describe('A* cost and cooperative work', () => {
  it.each([
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [4, 0, 0, 4, 1, 0, 4, 2, 0],
    [0, 1, 2, 0, 1, 2, 0, 1, 2],
    [0, 3, 0, 1, 2, 0, 0, 1, 0],
  ])('matches an independent Dijkstra reference for terrain %j', (...heights: number[]) => {
    const columns = heights.map((height, index) => ({ x: index % 3 - 2, z: Math.floor(index / 3) - 2, height }));
    // Independent finite graph oracle. Every column has full observed clearance;
    // its known support height alone defines these cardinal walk/step/drop edges.
    const frontier = [{ index: 0, cost: 0 }];
    const best = new Map<number, number>([[0, 0]]);
    let expected = Infinity;
    while (frontier.length > 0) {
      frontier.sort((a, b) => a.cost - b.cost);
      const current = frontier.shift()!;
      if (current.cost !== best.get(current.index)) continue;
      if (current.index === 8) { expected = current.cost; break; }
      const column = columns[current.index]!;
      columns.forEach((next, index) => {
        if (Math.abs(next.x - column.x) + Math.abs(next.z - column.z) !== 1) return;
        const dy = next.height - column.height;
        if (dy > 1 || dy < -4) return;
        const cost = current.cost + (dy === 0 ? 1 : 2 + Math.abs(dy));
        if (cost >= (best.get(index) ?? Infinity)) return;
        best.set(index, cost);
        frontier.push({ index, cost });
      });
    }
    const query = request({ body: bodyAt(-1.5, heights[0]!, -1.5), to: { x: 0.5, y: heights[8]!, z: 0.5 } });
    const map = terrain(columns);
    const astar = searchLandRoute(map, query, 2000);
    const dijkstra = searchLandRoute(map, { ...query, heuristic: 'zero' }, 2000);
    expect(astar.status).toBe('FOUND');
    expect(astar.cost).toBe(expected);
    expect(dijkstra.cost).toBe(expected);
    expect(astar.stats.nodesExpanded).toBeLessThanOrEqual(astar.stats.nodesReached);
  });

  it('yields the event loop and preserves the synchronous result and counters', async () => {
    const map = terrain(flat(8));
    const query = request({ to: { x: 7.5, y: 0, z: 0.5 }, maxWorkPerSlice: 16, maxSearchMs: 5000 });
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const asyncResult = await searchLandRouteAsync(map, query, 2000);
    const syncResult = searchLandRoute(map, query, 2000);
    expect(asyncResult.status).toBe('FOUND');
    expect(timerRan).toBe(true);
    expect(asyncResult.points).toEqual(syncResult.points);
    expect(asyncResult.cost).toBe(syncResult.cost);
    expect(asyncResult.stats.edgesEvaluated).toBe(syncResult.stats.edgesEvaluated);
    expect(asyncResult.stats.yieldCount).toBeGreaterThan(0);
    expect(syncResult.stats.yieldCount).toBe(0);
  });

  it('invalidates a relevant map change during a slice and releases the change listener', async () => {
    const map = terrain(flat());
    const query = request({ maxWorkPerSlice: 1, evidenceMode: 'remembered' });
    const pending = searchLandRouteAsync(map, query, 2000);
    map.observe(obs(AIR, { x: 1, y: -1, z: 0 }, { observedAt: 1500 }));
    const result = await pending;
    expect(result.status).toBe('INVALIDATED');
    expect(result.points).toEqual([]);
    map.observe(obs(STONE, { x: 1, y: -1, z: 0 }, { observedAt: 1600 }));
    expect(searchLandRoute(map, request(), 2000).status).toBe('FOUND');
  });

  it('does not invalidate on a change in an unrelated section', async () => {
    const map = terrain(flat());
    const pending = searchLandRouteAsync(map, request({ maxWorkPerSlice: 8 }), 2000);
    map.observe(obs(STONE, { x: 128, y: 0, z: 128 }, { observedAt: 1500 }));
    expect((await pending).status).toBe('FOUND');
  });

  it.each([false, true])('invalidates a used page unloaded during a slice, including same-revision reload=%s', async (reload) => {
    const sections = terrain(flat()).checkpointSnapshot().sections;
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory(sections.map((section, seq) => ({
      key: { worldId: 'world', dim: section.dim, cx: section.cx, cz: section.cz, sy: section.sy },
      seq, bytes: 10000, observedCells: section.evidence.length,
      paletteEntries: section.palette.length, revision: section.revision,
    })));
    map.installLoadedSections(sections);
    const pending = searchLandRouteAsync(map, request({ evidenceMode: 'remembered', maxWorkPerSlice: 1 }), 2000);
    const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: -1 };
    expect(map.unloadSections([key]).unloaded).toEqual([key]);
    if (reload) map.installLoadedSections(sections.filter((section) => section.sy === -1));
    const result = await pending;
    expect(result.status).toBe('INVALIDATED');
    expect(result.points).toEqual([]);
  });
});
