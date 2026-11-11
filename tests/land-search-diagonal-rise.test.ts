import { describe, expect, it } from 'vitest';
import { searchLandRoute } from '../src/navigation/index.js';
import type { LandSearchRequest } from '../src/navigation/index.js';
import { evaluateWalkTo } from '../src/traversability/step.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import type { BlockState } from '../src/types.js';
import { AIR, STONE, bodyAt, fakeProvider, obs, stepQuery } from './fakes.js';

/** A 15/16-high block, like a dirt path: standing on it puts the feet 1/16 below the next full block. */
const PATH: BlockState = { name: 'test:path', properties: {} };
const provider: CollisionShapeProvider = {
  version: 'diagonal-rise-1',
  resolve(state, cell, read) {
    if (state.name !== 'test:path') return fakeProvider.resolve(state, cell, read);
    return { kind: 'shape', shape: {
      boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }],
      supportFaces: [{ top: 0.9375, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
    } };
  },
};

/** Columns keyed "x,z" → the state stack; omitted columns stay unobserved. */
function world(columns: Record<string, (y: number) => BlockState>): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  for (const [key, stateAt] of Object.entries(columns)) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    for (let y = -6; y <= 6; y++) map.observe(obs(stateAt(y), { x, y, z }));
  }
  return map;
}
const floor = (y: number) => y < 0 ? STONE : AIR;
const wall = (y: number) => y < 3 ? STONE : AIR;

function request(overrides: Partial<LandSearchRequest>): LandSearchRequest {
  return {
    worldId: 'world', dim: 'overworld', sessionId: 's1',
    body: bodyAt(0.5, 0, 0.5), to: { x: 2.5, y: 0, z: 2.5 },
    rules: { shapeProvider: provider }, ...overrides,
  };
}

const open3x3 = () => Object.fromEntries(
  [0, 1, 2].flatMap((x) => [0, 1, 2].map((z) => [`${x},${z}`, floor] as const)),
);

describe('diagonal walks', () => {
  it('crosses an open floor diagonally at √2 per cell', () => {
    const result = searchLandRoute(world(open3x3()), request({}), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['walk', 'walk']);
    expect(result.points).toEqual([{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 2.5 }]);
    expect(result.cost).toBeCloseTo(2 * Math.SQRT2, 9);
  });

  it('keeps remembered candidate routes cardinal', () => {
    const result = searchLandRoute(world(open3x3()), request({ evidenceMode: 'remembered' }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.transitions.every((transition) => transition.from.x === transition.to.x || transition.from.z === transition.to.z)).toBe(true);
    expect(result.cost).toBe(4);
  });

  it('never cuts a blocked corner: a wall beside the diagonal forces cardinal moves', () => {
    const columns = open3x3();
    columns['1,0'] = wall;
    const result = searchLandRoute(world(columns), request({ to: { x: 1.5, y: 0, z: 1.5 } }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.points).toEqual([{ x: 0.5, y: 0, z: 0.5 }, { x: 0.5, y: 0, z: 1.5 }, { x: 1.5, y: 0, z: 1.5 }]);
    const direct = evaluateWalkTo(world(columns), stepQuery({ body: bodyAt(0.5, 0, 0.5) }), { x: 1.5, y: 0, z: 1.5 }, provider, 2000);
    expect(direct.status).toBe('BLOCKED');
  });

  it('does not treat an unobserved corner as clear', () => {
    const columns = open3x3();
    delete columns['1,0'];
    const direct = evaluateWalkTo(world(columns), stepQuery({ body: bodyAt(0.5, 0, 0.5) }), { x: 1.5, y: 0, z: 1.5 }, provider, 2000);
    expect(direct.status).toBe('UNKNOWN');
  });

  it('adds no frontier boundary of its own; cardinal edges still report the gap', () => {
    const columns = open3x3();
    delete columns['1,1'];
    const result = searchLandRoute(world(columns), request({ to: { x: 1.5, y: 0, z: 1.5 } }), 2000);
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.boundaries.every((entry) => entry.from.x === entry.to.x || entry.from.z === entry.to.z)).toBe(true);
  });
});

describe('step rise up to one jump', () => {
  it('steps from a 15/16 surface onto the next full block (rise 1.0625)', () => {
    const map = world({
      '0,0': (y) => y < -1 ? STONE : y === -1 ? PATH : AIR,
      '1,0': (y) => y < 1 ? STONE : AIR,
    });
    const result = searchLandRoute(map, request({ body: bodyAt(0.5, -0.0625, 0.5), to: { x: 1.5, y: 1, z: 0.5 } }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['step']);
  });

  it('still refuses a rise above one jump', () => {
    const map = world({
      '0,0': (y) => y < -1 ? STONE : y === -1 ? PATH : AIR,
      '1,0': (y) => y < 2 ? STONE : AIR,
    });
    const result = searchLandRoute(map, request({ body: bodyAt(0.5, -0.0625, 0.5), to: { x: 1.5, y: 2, z: 0.5 } }), 2000);
    expect(result.status).not.toBe('FOUND');
  });
});
