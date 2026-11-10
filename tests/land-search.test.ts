import { describe, expect, it } from 'vitest';
import { searchLandRoute, searchLandRouteAsync } from '../src/navigation/index.js';
import type { LandSearchRequest } from '../src/navigation/index.js';
import { evaluateRememberedWalkStep, evaluateWalkStep } from '../src/traversability/step.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
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

function terrainObserved(columns: readonly (Column & { observedAt?: number })[]): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  columns.forEach(({ x, z, height, observedAt }) => {
    for (let y = -6; y <= 10; y++) {
      const state = y + 1 <= height ? STONE
        : y < height ? SLAB : AIR;
      map.observe(obs(state, { x, y, z }, observedAt === undefined ? {} : { observedAt }));
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
    expect(result.prefix).toBeUndefined();
  });
});

describe('constrained corridor expansion', () => {
  const detour: Column[] = [
    { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 5 }, { x: 2, z: 0, height: 0 },
    { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 }, { x: 2, z: 1, height: 0 },
  ];

  it('excludes a real outside detour without reading its columns or changing the map', () => {
    const map = terrain(detour);
    const before = map.checkpointSnapshot();
    const query = request({ body: bodyAt(0.5, 0, 0.5), to: { x: 2.5, y: 0, z: 0.5 } });
    const corridorReads: { x: number; y: number; z: number }[] = [];
    const corridorProvider: CollisionShapeProvider = {
      version: 'recording-corridor',
      resolve(state, cell, read) {
        corridorReads.push({ ...cell });
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const relaxedReads: { x: number; y: number; z: number }[] = [];
    const relaxedProvider: CollisionShapeProvider = {
      version: 'recording-relaxed',
      resolve(state, cell, read) {
        relaxedReads.push({ ...cell });
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const corridor = searchLandRoute(map, {
      ...query,
      rules: { shapeProvider: corridorProvider },
      corridor: { origin: { x: 0.5, y: 0, z: 0.5 }, bearing: { x: 1, z: 0 }, maxLateral: 0.5 },
    }, 2000);
    const relaxed = searchLandRoute(map, { ...query, rules: { shapeProvider: relaxedProvider } }, 2000);
    const wide = searchLandRoute(map, {
      ...query,
      corridor: { origin: { x: 0.5, y: 0, z: 0.5 }, bearing: { x: 1, z: 0 }, maxLateral: 2 },
    }, 2000);

    expect(relaxed.status).toBe('FOUND');
    expect(wide.status).toBe('FOUND');
    expect(corridor.status).not.toBe('FOUND');
    expect(corridor.corridorLimited).toBe(true);
    expect(corridor.stats.corridorSkipped).toBeGreaterThan(0);
    // No excluded detour column became a boundary/terrain claim.
    expect(corridor.boundaries.every((entry) => Math.abs(entry.to.z - 0.5) <= 1e-9)).toBe(true);
    expect(corridor.stats.surfaceReads).toBeLessThan(relaxed.stats.surfaceReads);
    // The recorder proves excluded observed columns (z=±1) never reached shape
    // resolution. Allowed footprint/clearance reads at z=0 remain recorded.
    expect(corridorReads.length).toBeGreaterThan(0);
    expect(corridorReads.every((cell) => cell.z === 0)).toBe(true);
    expect(relaxedReads.some((cell) => cell.z === 1)).toBe(true);
    // The prefix never leaves the corridor and never invents a route outside it.
    expect(corridor.prefix).toBeDefined();
    expect(corridor.prefix!.points.every((point) => Math.abs(point.z - 0.5) <= 0.5 + 1e-9)).toBe(true);
    expect(corridor.prefix!.knownBlockerAhead === undefined
      || Math.abs(corridor.prefix!.knownBlockerAhead.to.z - 0.5) <= 1e-9).toBe(true);
    expect(relaxed.prefix).toBeUndefined();
    expect(map.checkpointSnapshot()).toEqual(before);
  });

  it('uses continuous feet for exact corridor edges on negative fractional coordinates', () => {
    const map = terrain([
      { x: -3, z: -1, height: 0 }, { x: -3, z: 0, height: 0 }, { x: -3, z: -2, height: 0 },
    ]);
    const from = bodyAt(-2.4, 0, -0.3);
    const positiveZ = request({ body: from, to: { x: -2.4, y: 0, z: 0.7 } });
    // Actual lateral offset is exactly 1.0; centered block coordinates would
    // produce a different value and make these two outcomes indistinguishable.
    expect(searchLandRoute(map, {
      ...positiveZ,
      corridor: { origin: { x: -2.4, y: 0, z: -0.3 }, bearing: { x: 1, z: 0 }, maxLateral: 0.9 },
    }, 2000).status).not.toBe('FOUND');
    expect(searchLandRoute(map, {
      ...positiveZ,
      corridor: { origin: { x: -2.4, y: 0, z: -0.3 }, bearing: { x: 1, z: 0 }, maxLateral: 1 },
    }, 2000).status).toBe('FOUND');

    const negativeZ = request({ body: from, to: { x: -2.4, y: 0, z: -1.3 } });
    expect(searchLandRoute(map, {
      ...negativeZ,
      corridor: { origin: { x: -2.4, y: 0, z: -0.3 }, bearing: { x: 1, z: 0 }, maxLateral: 0.999 },
    }, 2000).status).not.toBe('FOUND');
    expect(searchLandRoute(map, {
      ...negativeZ,
      corridor: { origin: { x: -2.4, y: 0, z: -0.3 }, bearing: { x: 1, z: 0 }, maxLateral: 1 },
    }, 2000).status).toBe('FOUND');
  });

  it('copies and normalizes the bearing without mutating the caller input', () => {
    const map = terrain([
      { x: -3, z: -1, height: 0 }, { x: -3, z: 0, height: 0 },
    ]);
    const corridor = {
      origin: { x: -2.4, y: 0, z: -0.3 },
      bearing: { x: 2, z: 0 },
      maxLateral: 1,
    };
    const before = { origin: { ...corridor.origin }, bearing: { ...corridor.bearing }, maxLateral: corridor.maxLateral };
    const result = searchLandRoute(map, request({
      body: bodyAt(-2.4, 0, -0.3), to: { x: -2.4, y: 0, z: 0.7 }, corridor,
    }), 2000);
    expect(result.status).toBe('FOUND');
    expect(corridor.origin).toEqual(before.origin);
    expect(corridor.bearing).toEqual(before.bearing);
    expect(corridor.maxLateral).toBe(before.maxLateral);
  });

  it.each([
    ['nonfinite origin', { origin: { x: Number.NaN, y: 0, z: 0 }, bearing: { x: 1, z: 0 }, maxLateral: 1 }],
    ['nonfinite bearing', { origin: { x: 0, y: 0, z: 0 }, bearing: { x: Number.POSITIVE_INFINITY, z: 0 }, maxLateral: 1 }],
    ['zero bearing', { origin: { x: 0, y: 0, z: 0 }, bearing: { x: 0, z: 0 }, maxLateral: 1 }],
    ['negative lateral limit', { origin: { x: 0, y: 0, z: 0 }, bearing: { x: 1, z: 0 }, maxLateral: -1 }],
    ['nonfinite lateral limit', { origin: { x: 0, y: 0, z: 0 }, bearing: { x: 1, z: 0 }, maxLateral: Number.POSITIVE_INFINITY }],
  ] as const)('rejects %s once at the request boundary', (_label, corridor) => {
    expect(() => searchLandRoute(terrain(flat()), request({ corridor }), 2000)).toThrow();
  });

  it('does not authorize returning to the corridor from an out-of-corridor start', () => {
    const map = terrain(detour);
    const result = searchLandRoute(map, request({
      body: bodyAt(0.5, 0, 1.5), to: { x: 2.5, y: 0, z: 1.5 },
      corridor: { origin: { x: 0.5, y: 0, z: 0.5 }, bearing: { x: 1, z: 0 }, maxLateral: 0.5 },
    }), 2000);
    expect(result.status).not.toBe('FOUND');
    expect(result.corridorLimited).toBe(true);
    expect(result.stats.corridorSkipped).toBeGreaterThan(0);
    expect(result.prefix!.atStart).toBe(true);
    expect(result.prefix!.endpoint).toEqual({ x: 0.5, y: 0, z: 1.5 });
    expect(result.boundaries.every((entry) => entry.status !== 'BLOCKED')).toBe(true);
  });
});

describe('current-evidence candidate prefix', () => {
  it('stops at the last current edge before stale evidence and never refreshes timestamps', () => {
    const map = terrainObserved([
      { x: 0, z: 0, height: 0, observedAt: 60000 },
      { x: 1, z: 0, height: 0, observedAt: 60000 },
      { x: 2, z: 0, height: 0, observedAt: 1000 },
    ]);
    const before = map.checkpointSnapshot();
    const result = searchLandRoute(map, request({ to: { x: 2.5, y: 0, z: 0.5 } }), 62000);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.points).toEqual([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ]);
    expect(result.prefix!.transitions.map((transition) => transition.kind)).toEqual(['walk']);
    expect(result.prefix!.endpoint).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(result.prefix!.atTarget).toBe(false);
    expect(result.prefix!.atStart).toBe(false);
    expect(result.prefix!.distanceToTarget).toBe(1);
    expect(result.points).toEqual([]);
    expect(map.checkpointSnapshot()).toEqual(before);
  });

  it('stops at unknown evidence with only the proven prefix', () => {
    const map = terrain(flat(3));
    const result = searchLandRoute(map, request({ to: { x: 3.5, y: 0, z: 0.5 } }), 2000);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.prefix!.points).toEqual([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ]);
    expect(result.prefix!.endpoint).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(result.prefix!.atTarget).toBe(false);
    expect(result.prefix!.points.length).toBe(result.prefix!.transitions.length + 1);
  });

  it('allows an at-start zero-transition prefix for current evidence only', () => {
    const map = terrain([{ x: 0, z: 0, height: 0 }]);
    const current = searchLandRoute(map, request(), 2000);
    expect(current.status).not.toBe('FOUND');
    expect(current.prefix).toEqual({
      endpoint: { x: 0.5, y: 0, z: 0.5 },
      points: [{ x: 0.5, y: 0, z: 0.5 }],
      transitions: [],
      distanceToTarget: 2,
      atTarget: false,
      atStart: true,
    });
    const remembered = searchLandRoute(map, request({ evidenceMode: 'remembered' }), 2000);
    expect(remembered.status).not.toBe('FOUND');
    expect(remembered.prefix).toBeUndefined();
  });

  it('retains a real forward blocker on a distant endpoint even when boundaries are truncated', () => {
    const map = terrain([
      { x: -2, z: 0, height: 0 }, { x: -1, z: 0, height: 0 }, { x: 0, z: 0, height: 0 },
      { x: 1, z: 0, height: 0 }, { x: 2, z: 0, height: 0 }, { x: 3, z: 0, height: 0 },
      { x: 4, z: 0, height: 5 },
    ]);
    const result = searchLandRoute(map, request({
      body: bodyAt(-1.5, 0, 0.5), to: { x: 4.5, y: 0, z: 0.5 }, maxBoundaries: 1,
    }), 2000);
    expect(result.status).not.toBe('FOUND');
    expect(result.stats.boundariesTruncated).toBe(true);
    expect(result.boundaries).toHaveLength(1);
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.endpoint).toEqual({ x: 3.5, y: 0, z: 0.5 });
    expect(result.prefix!.knownBlockerAhead).toMatchObject({
      from: { x: 3.5, y: 0, z: 0.5 },
      to: { x: 4.5, y: 0, z: 0.5 },
      status: 'BLOCKED',
    });
    // The same blocker was not available through the truncated global array.
    expect(result.boundaries.some((entry) => entry.to.x === 4.5)).toBe(false);
  });

  it('follows the cheaper replacement when a better g reaches the closest point', () => {
    // S (feet y=1) reaches A (feet y=2) for cost 7 via A->P, while B reaches
    // the same P for cost 4. P is replaced after being selected as closest.
    const heights = new Map<string, number>([
      ['0,0', 1], ['1,0', 2], ['0,1', 0], ['1,1', 0],
    ]);
    const build = (): VoxelMap => {
      const map = new VoxelMap('world', { now: () => 1000 });
      for (let x = -2; x <= 4; x++) {
        for (let z = -2; z <= 3; z++) {
          const height = heights.get(`${x},${z}`);
          for (let y = -6; y <= 4; y++) {
            const state = height === undefined ? AIR
              : y + 1 <= height ? STONE
                : y < height ? SLAB : AIR;
            map.observe(obs(state, { x, y, z }));
          }
        }
      }
      return map;
    };
    const query = request({ body: bodyAt(0.5, 1, 0.5), to: { x: 2.5, y: 0, z: 1.5 } });
    const result = searchLandRoute(build(), query, 2000);
    expect(result.status).toBe('NO_PATH_IN_MEMORY');
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.points).toEqual([
      { x: 0.5, y: 1, z: 0.5 },
      { x: 0.5, y: 0, z: 1.5 },
      { x: 1.5, y: 0, z: 1.5 },
    ]);
    expect(result.prefix!.transitions.map((transition) => [transition.kind, transition.cost]))
      .toEqual([['drop', 3], ['walk', 1]]);
    expect(result.prefix!.endpoint).toEqual({ x: 1.5, y: 0, z: 1.5 });
    expect(result.prefix!.knownBlockerAhead).toMatchObject({
      from: { x: 1.5, y: 0, z: 1.5 },
      to: { x: 2.5, y: 0, z: 1.5 },
      status: 'BLOCKED',
    });

    const truncated = searchLandRoute(build(), { ...query, maxBoundaries: 1 }, 2000);
    expect(truncated.status).toBe('NO_PATH_IN_MEMORY');
    expect(truncated.boundaries).toHaveLength(1);
    expect(truncated.prefix!.points).toEqual(result.prefix!.points);
    expect(truncated.prefix!.knownBlockerAhead).toMatchObject({
      status: 'BLOCKED', to: { x: 2.5, y: 0, z: 1.5 },
    });
  });

  it('keeps only allowed walk transitions in an alternate route or a partial prefix', () => {
    const alternate = terrain([
      { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 1 }, { x: 2, z: 0, height: 0 },
      { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 }, { x: 2, z: 1, height: 0 },
    ]);
    const found = searchLandRoute(alternate, request({ allowed: ['walk'] }), 2000);
    expect(found.status).toBe('FOUND');
    expect(found.transitions.every((transition) => transition.kind === 'walk')).toBe(true);

    // A floating block gives the target column only a step surface (top at
    // y=1) and no same-height walk candidate, so the disallowed step is the
    // only forward action from the endpoint.
    const blockedStep = terrain([
      { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 0 },
    ]);
    for (let y = -6; y <= 10; y++) {
      blockedStep.observe(obs(y === 0 ? STONE : AIR, { x: 2, y, z: 0 }));
    }
    const partial = searchLandRoute(blockedStep, request({
      to: { x: 2.5, y: 1, z: 0.5 }, allowed: ['walk'],
    }), 2000);
    expect(partial.status).not.toBe('FOUND');
    expect(partial.prefix).toBeDefined();
    expect(partial.prefix!.transitions.every((transition) => transition.kind === 'walk')).toBe(true);
    expect(partial.prefix!.endpoint).toEqual({ x: 1.5, y: 0, z: 0.5 });
    // The blocked step is an authorization/movement-kind restriction, not a
    // known terrain blocker.
    expect(partial.prefix!.knownBlockerAhead).toBeUndefined();
  });

  it('never turns empty movement kinds into a known blocker', () => {
    const result = searchLandRoute(terrain(flat()), request({ allowed: [] }), 2000);
    expect(result.status).not.toBe('FOUND');
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.atStart).toBe(true);
    expect(result.prefix!.knownBlockerAhead).toBeUndefined();
    expect(result.boundaries.some((entry) => entry.status === 'UNSUPPORTED'
      && entry.reason.includes('outside the requested'))).toBe(true);
  });
});

describe('prefix budget and cancellation semantics', () => {
  it('publishes an edge-budget prefix within the original deadline', () => {
    // Lower buried support faces would otherwise spend allowed drop-edge work
    // before the first walk; constrain the fixture to the intended walk graph.
    const result = searchLandRoute(terrain(flat(6)), request({
      to: { x: 5.5, y: 0, z: 0.5 }, maxEdges: 3, allowed: ['walk'], maxDrop: 0,
    }), 2000);
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.budget).toBe('edges');
    expect(result.points).toEqual([]);
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.endpoint).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(result.prefix!.points).toEqual([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ]);
    expect(result.prefix!.points.length).toBe(result.prefix!.transitions.length + 1);
    expect(result.prefix!.endpoint).toEqual(result.prefix!.points.at(-1));
  });

  it('lets a goal queued before a node-budget stop yield atTarget without ARRIVED', () => {
    const map = terrain([
      { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 0 },
      { x: 2, z: 0, height: 0 }, { x: 1, z: 1, height: 0 },
    ]);
    const result = searchLandRoute(map, request({ maxNodes: 3 }), 2000);
    expect(result.status).toBe('BUDGET_EXHAUSTED');
    expect(result.status).not.toBe('FOUND');
    expect(result.budget).toBe('nodes');
    expect(result.points).toEqual([]);
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.atTarget).toBe(true);
    expect(result.prefix!.endpoint).toEqual({ x: 2.5, y: 0, z: 0.5 });
  });

  it('omits the prefix when the output limit or the original deadline is reached', () => {
    const points = searchLandRoute(terrain(flat()), request({ maxRoutePoints: 1 }), 2000);
    expect(points.status).toBe('BUDGET_EXHAUSTED');
    expect(points.budget).toBe('points');
    expect(points.prefix).toBeUndefined();

    let tick = 0;
    const timed = searchLandRoute(terrain(flat(20)), request({
      to: { x: 19.5, y: 0, z: 0.5 }, clock: () => (tick += 100), maxSearchMs: 500,
    }), 2000);
    expect(timed.status).toBe('BUDGET_EXHAUSTED');
    expect(timed.budget).toBe('time');
    expect(timed.prefix).toBeUndefined();
  });

  it('counts prefix reconstruction and refuses publication once the original deadline expires', () => {
    const query = () => request({ to: { x: 3.5, y: 0, z: 0.5 } });
    // Probe the exact clock-call sequence with a clock that never expires.
    let probeCalls = 0;
    const probe = searchLandRoute(terrain(flat(3)), {
      ...query(),
      clock: () => { probeCalls += 1; return 1000; },
      maxSearchMs: 100000,
    }, 2000);
    expect(probe.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(probe.prefix).toBeDefined();
    expect(probeCalls).toBeGreaterThan(0);

    // Expire at the final prefix-publication check. Every earlier call stays
    // below the original deadline, so the search itself is unchanged.
    const start = 1000;
    const step = 10;
    let calls = 0;
    const result = searchLandRoute(terrain(flat(3)), {
      ...query(),
      clock: () => { calls += 1; return start + calls * step; },
      maxSearchMs: 1000000,
      deadlineMs: start + (probeCalls - 1) * step,
    }, 2000);
    expect(calls).toBe(probeCalls);
    expect(result.status).toBe(probe.status);
    expect(result.prefix).toBeUndefined();
    expect(result.stats.durationMs).toBe((probeCalls - 1) * step);
  });

  it('drops the prefix on cancellation, invalidation and provider-version change', async () => {
    const cancelled = new AbortController();
    const cancelledPending = searchLandRouteAsync(terrain(flat(8)), request({
      signal: cancelled.signal, to: { x: 7.5, y: 0, z: 0.5 }, maxWorkPerSlice: 1,
    }), 2000);
    cancelled.abort();
    const cancelledResult = await cancelledPending;
    expect(cancelledResult.status).toBe('CANCELLED');
    expect(cancelledResult.prefix).toBeUndefined();

    const changedMap = terrain(flat());
    const changedPending = searchLandRouteAsync(changedMap, request({ maxWorkPerSlice: 1 }), 2000);
    changedMap.observe(obs(AIR, { x: 1, y: -1, z: 0 }, { observedAt: 1500 }));
    const changed = await changedPending;
    expect(changed.status).toBe('INVALIDATED');
    expect(changed.prefix).toBeUndefined();

    let version = 'before';
    const provider = {
      get version() { return version; },
      resolve: fakeProvider.resolve,
    };
    const versionPending = searchLandRouteAsync(terrain(flat(8)), request({
      rules: { shapeProvider: provider }, to: { x: 7.5, y: 0, z: 0.5 }, maxWorkPerSlice: 1,
    }), 2000);
    version = 'after';
    const versionResult = await versionPending;
    expect(versionResult.status).toBe('INVALIDATED');
    expect(versionResult.prefix).toBeUndefined();
  });

  it.each([false, true])('drops a current prefix when a used page is unloaded (reload=%s)', async (reload) => {
    const sections = terrain(flat()).checkpointSnapshot().sections;
    const manual = new VoxelMap('world', { manualResidency: true });
    manual.installDirectory(sections.map((section, seq) => ({
      key: { worldId: 'world', dim: section.dim, cx: section.cx, cz: section.cz, sy: section.sy },
      seq, bytes: 10000, observedCells: section.evidence.length,
      paletteEntries: section.palette.length, revision: section.revision,
    })));
    manual.installLoadedSections(sections);
    const pending = searchLandRouteAsync(manual, request({ maxWorkPerSlice: 1 }), 2000);
    const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: -1 };
    expect(manual.unloadSections([key]).unloaded).toEqual([key]);
    if (reload) manual.installLoadedSections(sections.filter((section) => section.sy === -1));
    const result = await pending;
    expect(result.status).toBe('INVALIDATED');
    expect(result.prefix).toBeUndefined();
  });

  it('keeps a prefix across an unrelated change but not a related one', async () => {
    const map = terrain(flat(8));
    const pending = searchLandRouteAsync(map, request({
      to: { x: 7.5, y: 1, z: 0.5 }, maxWorkPerSlice: 8,
    }), 2000);
    map.observe(obs(STONE, { x: 128, y: 0, z: 128 }, { observedAt: 1500 }));
    const result = await pending;
    expect(result.status).not.toBe('FOUND');
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.endpoint).toEqual({ x: 7.5, y: 0, z: 0.5 });
  });
});

describe('prefix consistency', () => {
  const budgeted = () => request({
    to: { x: 5.5, y: 0, z: 0.5 }, maxEdges: 3, allowed: ['walk'], maxDrop: 0,
  });

  it('matches synchronous, asynchronous and zero-heuristic prefixes', async () => {
    const sync = searchLandRoute(terrain(flat(6)), budgeted(), 2000);
    const asyncResult = await searchLandRouteAsync(terrain(flat(6)), budgeted(), 2000);
    const dijkstra = searchLandRoute(terrain(flat(6)), { ...budgeted(), heuristic: 'zero' }, 2000);
    expect(asyncResult.status).toBe(sync.status);
    expect(asyncResult.prefix).toEqual(sync.prefix);
    expect(dijkstra.status).toBe(sync.status);
    expect(dijkstra.prefix!.endpoint).toEqual(sync.prefix!.endpoint);
    expect(dijkstra.prefix!.distanceToTarget).toBe(sync.prefix!.distanceToTarget);
    expect(sync.prefix!.atStart).toBe(false);
  });
});
