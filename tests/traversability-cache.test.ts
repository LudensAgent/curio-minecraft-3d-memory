import { describe, expect, it } from 'vitest';

import { evaluateWalkStep, TraversabilityCache, VoxelMap } from '../src/index.js';
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
  it('serves a repeated identical query from cache without re-evaluating', () => {
    const map = openMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    let resolves = 0;
    const counting: CollisionShapeProvider = {
      version: 'fake-1',
      resolve(state, cell, read) {
        resolves += 1;
        return fakeProvider.resolve(state, cell, read);
      },
    };

    const first = cache.get(stepQuery(), counting);
    expect(first.status).toBe('OPEN');
    const afterFirst = resolves;

    cache.get(stepQuery(), counting);
    expect(resolves).toBe(afterFirst); // cache hit — no new shape resolutions
    expect(cache.size).toBe(1);
  });

  it('does not serve a cached OPEN past the evidence validUntil', () => {
    const map = openMap();
    let clock = 2000;
    const cache = new TraversabilityCache(map, { now: () => clock });

    expect(cache.get(stepQuery(), fakeProvider).status).toBe('OPEN');

    clock = 70_000; // past observedAt 1000 + 60_000 window
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('STALE');
  });

  it('recovers to OPEN after expiry when the same state is re-observed', () => {
    const map = openMap();
    let clock = 2000;
    const cache = new TraversabilityCache(map, { now: () => clock });
    const q = stepQuery();

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');

    clock = 70_000;
    expect(cache.get(q, fakeProvider).status).toBe('STALE');

    clock = 71_000;
    for (const cell of [
      [0, -1, 0],
      [1, -1, 0],
      ...SWEPT_AIR,
    ] as Cell[]) {
      const state = cell[1] === -1 ? STONE : AIR;
      cache.invalidate(map.observe(obs(state, { x: cell[0], y: cell[1], z: cell[2] }, { observedAt: 71_000 })));
    }

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
    expect(evaluateWalkStep(map, q, fakeProvider, 71_000).status).toBe('OPEN');
  });

  it('UNKNOWN with partial evidence expires to STALE, matching direct evaluation', () => {
    const map = new VoxelMap('world');
    let clock = 2000;
    const cache = new TraversabilityCache(map, { now: () => clock });
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, SWEPT_AIR); // (1,-1,0) unobserved → UNKNOWN
    const q = stepQuery();

    expect(cache.get(q, fakeProvider).status).toBe('UNKNOWN');

    clock = 70_000;
    expect(cache.get(q, fakeProvider).status).toBe('STALE'); // observed cells expired, not stale UNKNOWN
    expect(evaluateWalkStep(map, q, fakeProvider, 70_000).status).toBe('STALE');
  });

  it('invalidates only entries depending on the changed section', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    let resolves = 0;
    const counting: CollisionShapeProvider = {
      version: 'fake-1',
      resolve(state, cell, read) {
        resolves += 1;
        return fakeProvider.resolve(state, cell, read);
      },
    };

    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
      [100, -1, 0],
      [101, -1, 0],
    ]);
    fill(map, AIR, [...SWEPT_AIR, [100, 0, 0], [100, 1, 0], [101, 0, 0], [101, 1, 0]]);

    const qA = stepQuery({ body: bodyAt(0.5, 0, 0.5) });
    const qB = stepQuery({ body: bodyAt(100.5, 0, 0.5) });
    expect(cache.get(qA, counting).status).toBe('OPEN');
    expect(cache.get(qB, counting).status).toBe('OPEN');

    // Change a cell in qA's section (cx=0), not qB's (cx=6).
    cache.invalidate(map.observe(obs(AIR, { x: 0, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 })));

    expect(cache.get(qA, counting).status).toBe('BLOCKED'); // support under qA now missing

    const beforeQb = resolves;
    expect(cache.get(qB, counting).status).toBe('OPEN'); // untouched section
    expect(resolves).toBe(beforeQb); // qB served from cache — no re-evaluation
  });

  it('re-evaluates an UNKNOWN result once the missing cell is first observed', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, SWEPT_AIR);
    const q = stepQuery();

    expect(cache.get(q, fakeProvider).status).toBe('UNKNOWN');
    const report = map.observe(obs(STONE, { x: 1, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    cache.invalidate(report);
    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
  });

  it('re-evaluates once a missing section is first observed', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    fill(map, STONE, [[15, -1, 0]]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
    ]);
    const q = stepQuery({ body: bodyAt(15.5, 0, 0.5) });
    expect(cache.get(q, fakeProvider).status).toBe('UNKNOWN');

    cache.invalidate(map.observe(obs(STONE, { x: 16, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 })));
    cache.invalidate(map.observe(obs(AIR, { x: 16, y: 0, z: 0 }, { observedAt: 1500, sequence: 3 })));
    cache.invalidate(map.observe(obs(AIR, { x: 16, y: 1, z: 0 }, { observedAt: 1500, sequence: 4 })));

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
  });

  it('STALE recovers to OPEN after the section is re-observed and invalidated', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const cache = new TraversabilityCache(map, { now: () => clock });
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);
    const q = stepQuery();

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');

    cache.invalidate(map.markStale('overworld', 'unloaded'));
    expect(cache.get(q, fakeProvider).status).toBe('STALE');

    clock = 3000;
    for (const cell of [
      [0, -1, 0],
      [1, -1, 0],
      ...SWEPT_AIR,
    ] as Cell[]) {
      const state = cell[1] === -1 ? STONE : AIR;
      cache.invalidate(map.observe(obs(state, { x: cell[0], y: cell[1], z: cell[2] }, { observedAt: 3000 })));
    }

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
  });

  it('changes to body context, direction or constraints are never cross-reused', () => {
    const map = openMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    const q = stepQuery();

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
    expect(cache.size).toBe(1);

    cache.get(stepQuery({ body: bodyAt(0.5, 0, 0.5, 1.2, 1.8) }), fakeProvider);
    expect(cache.size).toBe(2);

    cache.get(stepQuery({ direction: { axis: 'z', sign: 1 } }), fakeProvider);
    expect(cache.size).toBe(3);

    cache.get(stepQuery({ constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }), fakeProvider);
    expect(cache.size).toBe(4);

    cache.get(stepQuery({ constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }), fakeProvider);
    expect(cache.size).toBe(4);
  });

  it('rule version participates in the cache key', () => {
    const map = openMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    const q = stepQuery();

    const solid: CollisionShapeProvider = {
      version: 'solid-stone',
      resolve: (state) =>
        state.name === 'minecraft:stone'
          ? {
              kind: 'shape',
              shape: {
                boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
                supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
              },
            }
          : { kind: 'shape', shape: { boxes: [], supportFaces: [] } },
    };
    const hollow: CollisionShapeProvider = {
      version: 'hollow-stone',
      resolve: () => ({ kind: 'shape', shape: { boxes: [], supportFaces: [] } }),
    };

    expect(cache.get(q, solid).status).toBe('OPEN');
    expect(cache.get(q, hollow).status).toBe('BLOCKED');
    expect(cache.size).toBe(2);
  });

  it('full loop: observe → ChangeReport → invalidate → re-evaluate', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache(map, { now: () => 2000 });

    expect(cache.get(stepQuery(), fakeProvider).status).toBe('UNKNOWN');

    for (const [state, cells] of [
      [STONE, [[0, -1, 0], [1, -1, 0]]],
      [AIR, SWEPT_AIR],
    ] as [BlockState, Cell[]][]) {
      for (const [x, y, z] of cells) {
        cache.invalidate(map.observe(obs(state, { x, y, z }, { observedAt: 1500 })));
      }
    }

    expect(cache.get(stepQuery(), fakeProvider).status).toBe('OPEN');
  });

  it('isolates two VoxelMap instances even with the same worldId', () => {
    const mapA = openMap();
    const mapB = new VoxelMap('world'); // same worldId, no evidence
    const cacheA = new TraversabilityCache(mapA, { now: () => 2000 });
    const cacheB = new TraversabilityCache(mapB, { now: () => 2000 });

    expect(cacheA.get(stepQuery(), fakeProvider).status).toBe('OPEN');
    expect(cacheB.get(stepQuery(), fakeProvider).status).toBe('UNKNOWN');
    expect(cacheA.get(stepQuery(), fakeProvider).status).toBe('OPEN'); // A not polluted

    expect(() => cacheA.get(stepQuery({ worldId: 'other' }), fakeProvider)).toThrow(/does not match/);
  });

  it('returns copies: mutating a result cannot pollute the cache', () => {
    const map = openMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    let resolves = 0;
    const counting: CollisionShapeProvider = {
      version: 'fake-1',
      resolve(state, cell, read) {
        resolves += 1;
        return fakeProvider.resolve(state, cell, read);
      },
    };

    const first = cache.get(stepQuery(), counting);
    expect(first.status).toBe('OPEN');
    const afterFirst = resolves;

    first.status = 'BLOCKED';
    first.from.x = 999;
    first.to.y = 888;
    first.problem = { kind: 'collision', cells: [{ x: 1, y: 2, z: 3 }] };
    first.obstacles.push({ kind: 'contact', pos: { x: 0, y: 0, z: 0 }, observedAt: 1, sessionId: 'x' });
    first.dependencies[0]!.key.cx = 999;

    const second = cache.get(stepQuery(), counting);
    expect(resolves).toBe(afterFirst); // served from cache, not re-evaluated
    expect(second.status).toBe('OPEN');
    expect(second.from).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(second.to).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(second.problem).toBeUndefined();
    expect(second.obstacles).toEqual([]);
    expect(second.dependencies[0]!.key.cx).not.toBe(999);
  });

  it('cleans every reverse index when an entry is invalidated', () => {
    const map = new VoxelMap('world');
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    // Cross-boundary step depends on sections cx=0 and cx=1 across sy=-1 and sy=0.
    fill(map, STONE, [
      [15, -1, 0],
      [16, -1, 0],
    ]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
      [16, 0, 0],
      [16, 1, 0],
    ]);
    const q = stepQuery({ body: bodyAt(15.5, 0, 0.5) });

    expect(cache.get(q, fakeProvider).status).toBe('OPEN');
    expect(cache.dependencyIndexSize).toBeGreaterThan(0);

    // Change one support cell → invalidates the entry and removes its key from all indexes.
    cache.invalidate(map.observe(obs(AIR, { x: 15, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 })));
    expect(cache.size).toBe(0);
    expect(cache.dependencyIndexSize).toBe(0);
  });

  it('rejects a non-finite clock on both cache hit and miss', () => {
    const map = openMap();
    let clock = 2000;
    const cache = new TraversabilityCache(map, { now: () => clock });
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('OPEN');

    clock = Number.NEGATIVE_INFINITY;
    expect(() => cache.get(stepQuery(), fakeProvider)).toThrow(/finite/);

    const fresh = new TraversabilityCache(map, { now: () => Number.NEGATIVE_INFINITY });
    expect(() => fresh.get(stepQuery(), fakeProvider)).toThrow(/finite/);
  });
});
