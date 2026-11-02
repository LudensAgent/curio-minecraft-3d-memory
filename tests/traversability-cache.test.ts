import { describe, expect, it } from 'vitest';

import { TraversabilityCache, VoxelMap } from '../src/index.js';
import type { BlockState } from '../src/types.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import { AIR, bodyAt, fakeProvider, obs, STONE, stepQuery } from './fakes.js';

type Cell = [number, number, number];

const SWEPT_AIR: Cell[] = [
  [0, 0, 0],
  [0, 1, 0],
  [1, 0, 0],
  [1, 1, 0],
];

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function openMap(): VoxelMap {
  const map = new VoxelMap('world');
  fill(map, STONE, [
    [0, -1, 0],
    [1, -1, 0],
  ]);
  fill(map, AIR, SWEPT_AIR);
  return map;
}

describe('TraversabilityCache', () => {
  it('serves a repeated identical query from cache', () => {
    const map = openMap();
    const cache = new TraversabilityCache({ now: () => 2000 });

    const first = cache.get(map, stepQuery(), fakeProvider);
    const second = cache.get(map, stepQuery(), fakeProvider);
    expect(first.status).toBe('OPEN');
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it('does not serve a cached OPEN past the evidence validUntil', () => {
    const map = openMap();
    let clock = 2000;
    const cache = new TraversabilityCache({ now: () => clock });

    expect(cache.get(map, stepQuery(), fakeProvider).status).toBe('OPEN');

    clock = 70_000; // past observedAt 1000 + 60_000 window
    expect(cache.get(map, stepQuery(), fakeProvider).status).toBe('STALE');

    clock = 80_000;
    expect(cache.get(map, stepQuery(), fakeProvider).status).toBe('STALE'); // cached STALE
  });

  it('invalidates only entries depending on the changed section', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache({ now: () => 2000 });

    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
      [100, -1, 0],
      [101, -1, 0],
    ]);
    fill(map, AIR, [...SWEPT_AIR, [100, 0, 0], [100, 1, 0], [101, 0, 0], [101, 1, 0]]);

    const qA = stepQuery({ body: bodyAt(0.5, 0, 0.5) });
    const qB = stepQuery({ body: bodyAt(100.5, 0, 0.5) });
    const a1 = cache.get(map, qA, fakeProvider);
    const b1 = cache.get(map, qB, fakeProvider);

    // Change a cell in qA's section (cx=0), not qB's (cx=6).
    const report = map.observe(obs(AIR, { x: 0, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    cache.invalidate(report);

    const a2 = cache.get(map, qA, fakeProvider);
    const b2 = cache.get(map, qB, fakeProvider);
    expect(a2).not.toBe(a1);
    expect(b2).toBe(b1);
  });

  it('re-evaluates an UNKNOWN result once the missing cell is first observed', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache({ now: () => 2000 });
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, SWEPT_AIR); // (1,-1,0) left unobserved

    const q = stepQuery();
    expect(cache.get(map, q, fakeProvider).status).toBe('UNKNOWN');
    expect(cache.get(map, q, fakeProvider).status).toBe('UNKNOWN'); // cached

    const report = map.observe(obs(STONE, { x: 1, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    cache.invalidate(report);
    expect(cache.get(map, q, fakeProvider).status).toBe('OPEN');
  });

  it('re-evaluates an UNKNOWN result once a missing section is first observed', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache({ now: () => 2000 });
    // Step +X from x=15.5 crosses the cx=0 / cx=1 boundary.
    fill(map, STONE, [[15, -1, 0]]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
    ]);

    const q = stepQuery({ body: bodyAt(15.5, 0, 0.5) });
    expect(cache.get(map, q, fakeProvider).status).toBe('UNKNOWN');

    let report = map.observe(obs(STONE, { x: 16, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    cache.invalidate(report);
    report = map.observe(obs(AIR, { x: 16, y: 0, z: 0 }, { observedAt: 1500, sequence: 3 }));
    cache.invalidate(report);
    report = map.observe(obs(AIR, { x: 16, y: 1, z: 0 }, { observedAt: 1500, sequence: 4 }));
    cache.invalidate(report);

    expect(cache.get(map, q, fakeProvider).status).toBe('OPEN');
  });

  it('STALE recovers to OPEN after the section is re-observed and invalidated', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const cache = new TraversabilityCache({ now: () => clock });
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);

    const q = stepQuery();
    expect(cache.get(map, q, fakeProvider).status).toBe('OPEN');

    cache.invalidate(map.markStale('overworld', 'unloaded'));
    expect(cache.get(map, q, fakeProvider).status).toBe('STALE');

    clock = 3000;
    for (const cell of [
      [0, -1, 0],
      [1, -1, 0],
      ...SWEPT_AIR,
    ] as Cell[]) {
      const state = cell[1] === -1 ? STONE : AIR;
      cache.invalidate(map.observe(obs(state, { x: cell[0], y: cell[1], z: cell[2] }, { observedAt: 3000 })));
    }

    expect(cache.get(map, q, fakeProvider).status).toBe('OPEN');
  });

  it('changes to body context, direction or constraints are never cross-reused', () => {
    const map = openMap();
    const cache = new TraversabilityCache({ now: () => 2000 });
    const q = stepQuery();

    expect(cache.get(map, q, fakeProvider).status).toBe('OPEN');
    expect(cache.size).toBe(1);

    cache.get(map, stepQuery({ body: bodyAt(0.5, 0, 0.5, 1.2, 1.8) }), fakeProvider);
    expect(cache.size).toBe(2); // different body width

    cache.get(map, stepQuery({ direction: { axis: 'z', sign: 1 } }), fakeProvider);
    expect(cache.size).toBe(3); // different direction

    cache.get(map, stepQuery({ constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }), fakeProvider);
    expect(cache.size).toBe(4); // different constraints

    cache.get(map, stepQuery({ constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }), fakeProvider);
    expect(cache.size).toBe(4); // identical constraints reuse
  });

  it('rule version participates in the cache key', () => {
    const map = openMap();
    const cache = new TraversabilityCache({ now: () => 2000 });
    const q = stepQuery();

    const solid: CollisionShapeProvider = {
      version: 'solid-stone',
      resolve: (state) =>
        state.name === 'minecraft:stone'
          ? { kind: 'shape', shape: { boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], supportTop: 1 } }
          : { kind: 'shape', shape: { boxes: [], supportTop: null } },
    };
    const hollow: CollisionShapeProvider = {
      version: 'hollow-stone',
      resolve: () => ({ kind: 'shape', shape: { boxes: [], supportTop: null } }),
    };

    expect(cache.get(map, q, solid).status).toBe('OPEN');
    expect(cache.get(map, q, hollow).status).toBe('BLOCKED'); // no support under hollow rules
    expect(cache.size).toBe(2);
  });

  it('full loop: observe → ChangeReport → invalidate → re-evaluate', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache({ now: () => 2000 });

    // Initially unknown: no evidence yet.
    expect(cache.get(map, stepQuery(), fakeProvider).status).toBe('UNKNOWN');

    // Observe support + swept air, feeding each report back into the cache.
    for (const [state, cells] of [
      [STONE, [[0, -1, 0], [1, -1, 0]]],
      [AIR, SWEPT_AIR],
    ] as [BlockState, Cell[]][]) {
      for (const [x, y, z] of cells) {
        cache.invalidate(map.observe(obs(state, { x, y, z }, { observedAt: 1500 })));
      }
    }

    expect(cache.get(map, stepQuery(), fakeProvider).status).toBe('OPEN');
  });
});
