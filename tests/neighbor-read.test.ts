import { describe, expect, it } from 'vitest';

import { evaluateWalkStep, TraversabilityCache, VoxelMap } from '../src/index.js';
import type { BlockState } from '../src/types.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import { AIR, bodyAt, EMPTY, fakeProvider, FULL_CUBE, obs, STONE, stepQuery } from './fakes.js';

type Cell = [number, number, number];

const GATE: BlockState = { name: 'minecraft:gate', properties: {} };

/**
 * Fake neighbour-dependent rule: a `gate` is passable when the cell directly in
 * front of it (x+1) is air, a full cube when that cell is solid, and reports a
 * `neighbor_gap` when that cell is not valid evidence.
 */
const gateProvider: CollisionShapeProvider = {
  version: 'gate-1',
  resolve(state, cell, read) {
    if (state.name !== 'minecraft:gate') return fakeProvider.resolve(state, cell, read);
    const front = read.cell(cell.x + 1, cell.y, cell.z);
    if (front.kind === 'observed') {
      return front.state.name === 'minecraft:air'
        ? { kind: 'shape', shape: EMPTY }
        : { kind: 'shape', shape: FULL_CUBE };
    }
    return { kind: 'neighbor_gap', view: front };
  },
};

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function fillAt(map: VoxelMap, state: BlockState, cells: Cell[], observedAt: number): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }, { observedAt }));
}

function gateMap(): VoxelMap {
  const map = new VoxelMap('world');
  fill(map, STONE, [
    [0, -1, 0],
    [1, -1, 0],
  ]);
  fill(map, AIR, [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ]);
  map.observe(obs(GATE, { x: 1, y: 0, z: 0 }));
  return map;
}

describe('neighbour-dependent shape rules', () => {
  it('neighbour state changes the gate shape and therefore the conclusion', () => {
    const map = gateMap();
    map.observe(obs(AIR, { x: 2, y: 0, z: 0 })); // front is air → gate passable
    const q = stepQuery();

    expect(evaluateWalkStep(map, q, gateProvider, 2000).status).toBe('OPEN');

    map.observe(obs(STONE, { x: 2, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    expect(evaluateWalkStep(map, q, gateProvider, 2000).status).toBe('BLOCKED');
  });

  it('a neighbour in another section locally invalidates the cached result', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [15, -1, 0],
      [16, -1, 0],
    ]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
      [16, 1, 0],
    ]);
    map.observe(obs(GATE, { x: 16, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: 17, y: 0, z: 0 })); // front is in section cx=1
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    const q = stepQuery({ body: bodyAt(15.5, 0, 0.5) });

    expect(cache.get(q, gateProvider).status).toBe('OPEN');

    cache.invalidate(map.observe(obs(STONE, { x: 17, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 })));
    expect(cache.get(q, gateProvider).status).toBe('BLOCKED');
  });

  it('an unobserved neighbour is a gap, and first observation recovers', () => {
    const map = gateMap(); // (2,0,0) left unobserved
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    const q = stepQuery();

    expect(cache.get(q, gateProvider).status).toBe('UNKNOWN');

    cache.invalidate(map.observe(obs(AIR, { x: 2, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 })));
    expect(cache.get(q, gateProvider).status).toBe('OPEN');
  });

  it('an expired neighbour cannot yield OPEN', () => {
    const map = new VoxelMap('world');
    fillAt(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ], 100_000);
    fillAt(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ], 100_000);
    map.observe(obs(GATE, { x: 1, y: 0, z: 0 }, { observedAt: 100_000 }));
    map.observe(obs(AIR, { x: 2, y: 0, z: 0 }, { observedAt: 1000 })); // expired by now=70_000

    expect(evaluateWalkStep(map, stepQuery(), gateProvider, 70_000).status).toBe('STALE');
  });

  it('an unrelated section change does not invalidate the cached entry', () => {
    const map = gateMap();
    map.observe(obs(AIR, { x: 2, y: 0, z: 0 }));
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    let resolves = 0;
    const counting: CollisionShapeProvider = {
      version: 'gate-1',
      resolve(state, cell, read) {
        resolves += 1;
        return gateProvider.resolve(state, cell, read);
      },
    };

    expect(cache.get(stepQuery(), counting).status).toBe('OPEN');
    const afterFirst = resolves;

    // Unrelated section (cx=6).
    cache.invalidate(map.observe(obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 })));

    expect(cache.get(stepQuery(), counting).status).toBe('OPEN');
    expect(resolves).toBe(afterFirst); // served from cache, not re-evaluated
  });
});
