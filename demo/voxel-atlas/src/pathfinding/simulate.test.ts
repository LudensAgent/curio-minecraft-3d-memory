import { describe, expect, it } from 'vitest';
import { deserializeBlockState } from '../../../../src/voxel/blockstate.ts';
import type { RegionData, ViewerCell } from '../types';
import { collisionProvider } from './collision';
import { simulateRoute } from './simulate';
import type { SimulationOptions } from './types';

function region(heights: number[] = [0, 0, 0]): RegionData {
  const cells: ViewerCell[] = heights.flatMap((height, i) => Array.from({ length: 12 }, (_, n) => {
    const y = n - 5;
    const state = y + 1 <= height ? 'minecraft:stone' : y < height
      ? 'minecraft:smooth_stone_slab[type=bottom,waterlogged=false]' : 'minecraft:air';
    return {
      x: i - 2, y, z: -1, state,
      observedAt: 1000, source: 'vision', evidence: 'seen', stateComplete: true,
      freshness: 'FRESH', sessionId: 'saved-session', traversed: false, modified: false, risk: false,
      snapshotEvidence: {
        stateComplete: true, evidence: 'seen', observedAt: 1000, source: 'vision',
        sessionId: 'saved-session', sequence: i * 12 + n, revision: 1, freshness: 'FRESH', validUntil: 61000,
      },
    };
  }));
  const bounds = { minX: -2, maxX: heights.length - 3, minY: -5, maxY: 6, minZ: -1, maxZ: -1 };
  return {
    query: { worldId: 'test', dimension: 'overworld', bounds }, bounds, cells, markers: [],
    stats: { sections: 2, observedCells: cells.length, airCells: 0, solidCells: 0, staleCells: 0, latestObservedAt: 1000 },
  };
}

const options: SimulationOptions = {
  from: { x: -2, y: 0, z: -1 }, to: { x: 0, y: 0, z: -1 }, evidenceMode: 'remembered', maxDrop: 2,
};

describe('offline voxel A* simulation', () => {
  it('uses real A* across negative columns and records actual expansion order without changing saved evidence', () => {
    const input = region();
    const before = structuredClone(input);
    const result = simulateRoute(input, options);
    expect(result.route.status).toBe('FOUND');
    expect(result.path).toEqual([{ x: -2, y: 0, z: -1 }, { x: -1, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }]);
    expect(result.explored).toEqual(result.path.slice(0, -1));
    expect(result.explored).toHaveLength(result.route.stats.nodesExpanded);
    expect(result.route.assurance).toBe('historical_geometry');
    expect(result.route.executable).toBe(false);
    expect(input).toEqual(before);
  });

  it('finds slabs, a one-block rise, and a bounded drop using their real state shapes', () => {
    const result = simulateRoute(region([0, 0.5, 1.5, 1]), { ...options, to: { x: 1, y: 1, z: -1 } });
    expect(result.route.status).toBe('FOUND');
    expect(result.route.transitions.map((edge) => edge.kind)).toEqual(['step', 'step', 'drop']);
    expect(result.path.map((point) => point.y)).toEqual([0, 0.5, 1.5, 1]);
  });

  it('does not turn missing air, incomplete blockstates, or strict restored evidence into traversability', () => {
    const missing = region();
    missing.cells = missing.cells.filter((cell) => !(cell.x === -1 && cell.y === 1));
    expect(simulateRoute(missing, options).route.status).toBe('INSUFFICIENT_EVIDENCE');
    const incomplete = region();
    const cell = incomplete.cells.find((candidate) => candidate.x === -1 && candidate.y === -1)!;
    cell.stateComplete = false;
    cell.snapshotEvidence!.stateComplete = false;
    expect(simulateRoute(incomplete, options).route.status).not.toBe('FOUND');
    expect(simulateRoute(region(), { ...options, evidenceMode: 'strict' }).route.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('skips cells without original metadata and rejects out-of-region and unbounded-drop requests', () => {
    const input = region();
    input.cells.forEach((cell) => { cell.snapshotEvidence = undefined; });
    const result = simulateRoute(input, options);
    expect(result.skippedCells).toBe(input.cells.length);
    expect(result.route.status).not.toBe('FOUND');
    expect(() => simulateRoute(region(), { ...options, to: { x: 512, y: 0, z: 0 } })).toThrow('已加载区域');
    expect(() => simulateRoute(region(), { ...options, maxDrop: 999 })).toThrow('0–4');
  });

  it('resolves complete door/stair states exactly and rejects missing properties', () => {
    const resolve = (state: string) => collisionProvider.resolve(deserializeBlockState(state), { x: 0, y: 0, z: 0 }, {
      cell: (x, y, z) => ({ kind: 'unobserved', pos: { x, y, z } }),
    });
    const closed = resolve('minecraft:oak_door[facing=east,half=lower,hinge=left,open=false,powered=false]');
    const open = resolve('minecraft:oak_door[facing=east,half=lower,hinge=left,open=true,powered=false]');
    expect(closed.kind).toBe('shape');
    expect(open.kind).toBe('shape');
    expect(open).not.toEqual(closed);
    expect(resolve('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]').kind).toBe('shape');
    expect(resolve('minecraft:oak_stairs').kind).toBe('unsupported_shape');
    expect(resolve('minecraft:nether_portal[axis=x]').kind).toBe('unsupported_shape');
  });
});
