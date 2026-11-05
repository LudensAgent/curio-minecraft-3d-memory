import { describe, expect, it } from 'vitest';

import { evaluateWalkStep, VoxelMap } from '../src/index.js';
import type { Section } from '../src/index.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import { evaluateGroundedWalkSegment } from '../src/traversability/step.js';
import type { BlockState } from '../src/types.js';
import { AIR, bodyAt, EMPTY, fakeProvider, obs, SLAB, STONE, stepQuery, THIN } from './fakes.js';

type Cell = [number, number, number];

function fill(map: VoxelMap, state: Parameters<typeof obs>[0], cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function sectionCxs(dependencies: { key: { cx: number } }[]): number[] {
  return [...new Set(dependencies.map((d) => d.key.cx))].sort((a, b) => a - b);
}

/** Air for every cell the body sweep (0.6 × 1.8) touches when stepping +X from (0.5,0,0.5). */
const SWEPT_AIR: Cell[] = [
  [0, 0, 0],
  [0, 1, 0],
  [1, 0, 0],
  [1, 1, 0],
];

describe('evaluateWalkStep — geometry and evidence', () => {
  it('OPEN: empty channel with reliable support under both feet', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('OPEN');
    expect(result.to).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(result.dependencies.length).toBeGreaterThan(0);
  });

  it('BLOCKED: solid wall in the swept body volume', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
    ]);

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('collision');
    expect(result.obstacles).toHaveLength(1);
  });

  it('BLOCKED: headroom blocked even when both feet cells are air', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
      [1, 1, 0], // headspace at destination; feet cell (1,0,0) is air
    ]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('collision');
  });

  it('BLOCKED: missing support at destination is a confirmed gap, not UNKNOWN', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      ...SWEPT_AIR,
      [1, -1, 0], // destination support is confirmed air
    ]);

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
  });

  it('partial-height slab supports feet at its top, not a full cube', () => {
    // Feet at 0.5 on a bottom slab (top 0.5): supported and open.
    const map = new VoxelMap('world');
    fill(map, SLAB, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    fill(map, AIR, [
      [0, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 2, 0],
      [1, 2, 0],
    ]);

    const onSlab = evaluateWalkStep(map, stepQuery({ body: bodyAt(0.5, 0.5, 0.5) }), fakeProvider, 2000);
    expect(onSlab.status).toBe('OPEN');

    // The same slab cannot stand in for a full block: feet at 1.0 has no support.
    fill(map, AIR, [
      [0, 1, 0],
      [1, 1, 0],
      [0, 2, 0],
      [1, 2, 0],
    ]);
    const expectingFullBlock = evaluateWalkStep(map, stepQuery({ body: bodyAt(0.5, 1, 0.5) }), fakeProvider, 2000);
    expect(expectingFullBlock.status).toBe('BLOCKED');
    expect(expectingFullBlock.problem?.kind).toBe('missing_support');
  });

  it('UNKNOWN: a required support cell is unobserved', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, SWEPT_AIR);
    // (1,-1,0) destination support is never observed.

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('unobserved');
  });

  it('UNKNOWN: state-incomplete evidence cannot conclude a shape', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);
    // Re-observe the destination head cell with incomplete state.
    map.observe(obs(STONE, { x: 1, y: 1, z: 0 }, { stateComplete: false, observedAt: 1500, sequence: 2 }));

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('UNKNOWN');
  });

  it('STALE: evidence past validUntil is treated as expired without mutating the map', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);

    const before = map.sectionAt('overworld', 0, 0, 0)?.revision;
    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 200_000);
    expect(result.status).toBe('STALE');
    expect(map.sectionAt('overworld', 0, 0, 0)?.revision).toBe(before); // unchanged
  });

  it('STALE: cells marked stale by a session switch report STALE', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);
    map.beginSession('s2');

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('STALE');
  });

  it('reads negative coordinates and cross-section support/clearance', () => {
    const map = new VoxelMap('world');
    // Step +X across the cx = -1 / cx = 0 boundary, at z = -1.
    fill(map, STONE, [
      [-1, -1, -1],
      [0, -1, -1],
    ]);
    fill(map, AIR, [
      [-1, 0, -1],
      [-1, 1, -1],
      [0, 0, -1],
      [0, 1, -1],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(-0.5, 0, -0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('OPEN');
    expect(sectionCxs(result.dependencies)).toEqual([-1, 0]);
  });

  it('UNSUPPORTED: a mode outside the walk evaluator range is a capability gap', () => {
    const map = new VoxelMap('world');
    const result = evaluateWalkStep(map, stepQuery({ mode: 'jump' }), fakeProvider, 2000);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('unsupported_mode');
  });

  it('UNSUPPORTED: a block state with no collision rule is a capability gap, not BLOCKED', () => {
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
    map.observe(obs({ name: 'minecraft:chest', properties: {} }, { x: 1, y: 0, z: 0 }));

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('unsupported_shape');
  });

  it('reading never mutates evidence time, freshness or section version', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);

    const revisionBefore = map.sectionAt('overworld', 0, 0, 0)!.revision;
    const cellBefore = map.cellAt('overworld', 0, -1, 0);

    evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);

    const cellAfter = map.cellAt('overworld', 0, -1, 0);
    expect(cellAfter).toEqual(cellBefore);
    expect(map.sectionAt('overworld', 0, 0, 0)!.revision).toBe(revisionBefore);
    const section: Section = map.sectionAt('overworld', 0, 0, 0)!;
    expect(section.lastObservedAt).toBe(1000);
  });

  it('continuous support: a one-cell gap mid-step is missing support, not OPEN', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [2, -1, 0],
    ]);
    fill(map, AIR, [
      [1, -1, 0], // the gap under the swept footprint
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.9, 0, 0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
    expect(result.problem?.cells).toContainEqual({ x: 1, y: -1, z: 0 }); // the gap, not the start
  });

  it('start-edge contact is not support', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[1, -1, 0]]);
    fill(map, AIR, [
      [0, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.7, 0, 0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
  });

  it('end-edge contact is not support', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [1, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.3, 0, 0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
  });

  it('two support intervals touching only at an endpoint are not continuous support', () => {
    const map = new VoxelMap('world');
    // body width 1.0 → faces [0,1] and [2,3] yield centre-valid intervals touching at 1.5
    fill(map, STONE, [
      [0, -1, 0],
      [2, -1, 0],
    ]);
    fill(map, AIR, [
      [1, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.5, 0, 0.5, 1.0, 1.8) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
  });

  it('partial overhang with positive contact remains supported', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [-1, -1, 0],
      [1, -1, 0],
      [-1, 0, 0],
      [-1, 1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.1, 0, 0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('OPEN');
  });

  it('support requires horizontal overlap of the top face with the footprint', () => {
    const map = new VoxelMap('world');
    fill(map, THIN, [[0, -1, 0]]); // face only covers [0,0.2]×[0,0.2]
    fill(map, AIR, [
      [1, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.8, 0, 0.8, 0.2, 1.8) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
  });

  it('an unresolvable support shape is UNSUPPORTED, never a fake missing_support', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    map.observe(obs({ name: 'minecraft:chest', properties: {} }, { x: 1, y: -1, z: 0 }));
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]);

    const result = evaluateWalkStep(map, stepQuery(), fakeProvider, 2000);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('unsupported_shape');
  });

  it('does not read or depend on a cell that cannot affect support', () => {
    const map = new VoxelMap('world');
    fill(map, SLAB, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    fill(map, AIR, [
      [0, 1, 0],
      [1, 1, 0],
      [0, 2, 0],
      [1, 2, 0],
    ]);
    // y = -1 is deliberately unobserved; it can never support feet at 0.5.

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.5, 0.5, 0.5) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('OPEN');
    expect(result.dependencies.every((d) => d.key.sy !== -1)).toBe(true);
  });

  it('a late query from an older session reports STALE, not OPEN', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, SWEPT_AIR);
    map.beginSession('s2');
    for (const cell of [
      [0, -1, 0],
      [1, -1, 0],
      ...SWEPT_AIR,
    ] as Cell[]) {
      const state = cell[1] === -1 ? STONE : AIR;
      map.observe(obs(state, { x: cell[0], y: cell[1], z: cell[2] }, { sessionId: 's2', observedAt: 2000, sequence: 2 }));
    }

    const stale = evaluateWalkStep(map, stepQuery({ sessionId: 's1' }), fakeProvider, 3000);
    expect(stale.status).toBe('STALE');

    const open = evaluateWalkStep(map, stepQuery({ sessionId: 's2' }), fakeProvider, 3000);
    expect(open.status).toBe('OPEN');
  });

  it('rejects non-finite coordinates, dimensions and query time', () => {
    const map = new VoxelMap('world');

    expect(() => evaluateWalkStep(map, stepQuery({ body: bodyAt(Number.NaN, 0, 0.5) }), fakeProvider, 2000)).toThrow(/finite/);
    expect(() => evaluateWalkStep(map, stepQuery({ body: bodyAt(0.5, 0, 0.5, Number.NaN, 1.8) }), fakeProvider, 2000)).toThrow(/finite/);
    expect(() => evaluateWalkStep(map, stepQuery({ body: bodyAt(0.5, 0, 0.5, 0.6, Number.NaN) }), fakeProvider, 2000)).toThrow(/finite/);
    expect(() => evaluateWalkStep(map, stepQuery(), fakeProvider, Number.NaN)).toThrow(/finite/);
  });

  it('unknown cells that cannot cover a confirmed gap do not mask BLOCKED', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [1, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
      [2, 1, 0],
    ]);
    // (2,-1,0) left unobserved; even as a full cube it cannot support the foot at x=1.5.

    const result = evaluateWalkStep(
      map,
      stepQuery({ body: bodyAt(0.9, 0, 0.5, 0.4, 1.8) }),
      fakeProvider,
      2000,
    );
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_support');
    expect(result.problem?.cells).toContainEqual({ x: 1, y: -1, z: 0 });
  });

  it('an unsupported candidate that is read but cannot cover the gap does not mask the real one', () => {
    const map = new VoxelMap('world');
    // Observed support is a thin slab (along-axis face [0,0.2], full Z). Its
    // support interval ends at x=0.7, leaving a gap [0.7, 1] that only x=1 can
    // cover. The chest at x=-1 is read (it is in the sweep) but its full-cell
    // potential (-1.5, 0.5) never reaches that gap.
    const thinXProvider: CollisionShapeProvider = {
      version: 'thin-x-1',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:thin_x') {
          return {
            kind: 'shape',
            shape: {
              boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 0.2, maxY: 1, maxZ: 1 }],
              supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 0.2, maxZ: 1 }],
            },
          };
        }
        return fakeProvider.resolve(state, cell, read);
      },
    };

    fill(map, AIR, [
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ]);
    map.observe(obs({ name: 'minecraft:chest', properties: {} }, { x: -1, y: -1, z: 0 }));
    map.observe(obs({ name: 'minecraft:thin_x', properties: {} }, { x: 0, y: -1, z: 0 }));
    // (1,-1,0) left unobserved (the real gap)

    const result = evaluateWalkStep(map, stepQuery({ body: bodyAt(0, 0, 0.5, 1.0, 1.0) }), thinXProvider, 2000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('unobserved');
    expect(result.problem?.cells).toContainEqual({ x: 1, y: -1, z: 0 });
    expect(result.problem?.cells).not.toContainEqual({ x: -1, y: -1, z: 0 });
  });
});

describe('evaluateGroundedWalkSegment — swept collision (diagonal correction)', () => {
  function diagonalMap(): VoxelMap {
    const map = new VoxelMap('world');
    // Support under the whole diagonal footprint, air for the body height.
    for (const x of [-1, 0, 1, 2]) for (const z of [-1, 0, 1, 2]) {
      fill(map, STONE, [[x, -1, z]]);
      fill(map, AIR, [[x, 0, z], [x, 1, z]]);
    }
    return map;
  }

  const sliverProvider: CollisionShapeProvider = {
    version: 'swept-1',
    resolve(state, cell, read) {
      if (state.name === 'minecraft:sliver') {
        return { kind: 'shape', shape: { boxes: [{ minX: 0.7, maxX: 0.9, minY: 0, maxY: 1, minZ: 0.25, maxZ: 0.5 }], supportFaces: [] } };
      }
      return fakeProvider.resolve(state, cell, read);
    },
  };

  // from (0.5,0,1.0) → to (1.5,0,0.5): +X and −Z, a genuine diagonal correction.
  const query = { worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk' as const, body: bodyAt(0.5, 0, 1.0), direction: { axis: 'x' as const, sign: 1 as const } };
  const to = { x: 1.5, y: 0, z: 0.5 };

  it('does not report a corner the body never actually sweeps', () => {
    const map = diagonalMap();
    // A sliver whose X overlap (t≈[0.9,1]) and Z overlap (t≈[0,0.1]) never coincide.
    map.observe(obs({ name: 'minecraft:sliver', properties: {} }, { x: 1, y: 0, z: 1 }, { observedAt: 1500, sequence: 2 }));
    const result = evaluateGroundedWalkSegment(map, query, to, sliverProvider, 2000, 0.05);
    expect(result.status).toBe('OPEN');
  });

  it('reports a real swept collision as BLOCKED', () => {
    const map = diagonalMap();
    // A full cube the body actually passes through (cell (1,0,0): X∈[1,2], Z∈[0,1]).
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const result = evaluateGroundedWalkSegment(map, query, to, sliverProvider, 2000, 0.05);
    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('collision');
  });
});

describe('evaluateGroundedWalkSegment — swept vertical collision', () => {
  function yMap(): VoxelMap {
    const map = new VoxelMap('world');
    for (const x of [-1, 0, 1, 2]) for (const z of [-1, 0, 1, 2]) {
      fill(map, STONE, [[x, -1, z]]);
      fill(map, AIR, [[x, 0, z], [x, 1, z]]);
    }
    return map;
  }

  const ceilingProvider: CollisionShapeProvider = {
    version: 'swept-y-1',
    resolve(state, cell, read) {
      if (state.name === 'minecraft:ceiling') {
        // Ceiling whose bottom is at 1.8125; the rising body's head reaches 1.84.
        return { kind: 'shape', shape: { boxes: [{ minX: 0, maxX: 1, minY: 0.8125, maxY: 1, minZ: 0, maxZ: 1 }], supportFaces: [] } };
      }
      return fakeProvider.resolve(state, cell, read);
    },
  };
  const lateSliverProvider: CollisionShapeProvider = {
    version: 'swept-y-2',
    resolve(state, cell, read) {
      if (state.name === 'minecraft:sliver') {
        // A sliver the descending body's X reaches only late (t≈[0.9,1]), after its
        // head has already dropped below the sliver's 1.82 bottom.
        return { kind: 'shape', shape: { boxes: [{ minX: 0.7, maxX: 0.8, minY: 0.82, maxY: 1, minZ: 0, maxZ: 1 }], supportFaces: [] } };
      }
      return fakeProvider.resolve(state, cell, read);
    },
  };

  it('detects a rise into a ceiling (head 1.8 → 1.84 over a 1.8125 bottom)', () => {
    const map = yMap();
    map.observe(obs({ name: 'minecraft:ceiling', properties: {} }, { x: 1, y: 1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const q = { worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk' as const, body: bodyAt(0.5, 0, 0.5), direction: { axis: 'x' as const, sign: 1 as const } };
    const r = evaluateGroundedWalkSegment(map, q, { x: 1.5, y: 0.04, z: 0.5 }, ceilingProvider, 2000, 0.05);
    expect(r.status).toBe('BLOCKED');
    expect(r.problem?.kind).toBe('collision');
  });

  it('treats an exact-touch ceiling contact as a touch, not a collision', () => {
    const map = yMap();
    map.observe(obs({ name: 'minecraft:ceiling', properties: {} }, { x: 1, y: 1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    // Feet rise 0 → 0.0125: head 1.8 → 1.8125, exactly the ceiling bottom (touch only).
    const q = { worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk' as const, body: bodyAt(0.5, 0, 0.5), direction: { axis: 'x' as const, sign: 1 as const } };
    const r = evaluateGroundedWalkSegment(map, q, { x: 1.5, y: 0.0125, z: 0.5 }, ceilingProvider, 2000, 0.05);
    expect(r.status).toBe('OPEN');
  });

  it('detects a rise that actually penetrates the ceiling', () => {
    const map = yMap();
    map.observe(obs({ name: 'minecraft:ceiling', properties: {} }, { x: 1, y: 1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    // Feet rise 0 → 0.02: head 1.82, past the 1.8125 bottom.
    const q = { worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk' as const, body: bodyAt(0.5, 0, 0.5), direction: { axis: 'x' as const, sign: 1 as const } };
    const r = evaluateGroundedWalkSegment(map, q, { x: 1.5, y: 0.02, z: 0.5 }, ceilingProvider, 2000, 0.05);
    expect(r.status).toBe('BLOCKED');
    expect(r.problem?.kind).toBe('collision');
  });

  it('does not block a descent that clears the obstacle', () => {
    const map = yMap();
    map.observe(obs({ name: 'minecraft:sliver', properties: {} }, { x: 1, y: 1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const q = { worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk' as const, body: bodyAt(0.5, 0.04, 0.5), direction: { axis: 'x' as const, sign: 1 as const } };
    const r = evaluateGroundedWalkSegment(map, q, { x: 1.5, y: 0, z: 0.5 }, lateSliverProvider, 2000, 0.05);
    expect(r.status).toBe('OPEN');
  });
});

describe('evaluateWalkStep — hazards and context', () => {
  const WATER: BlockState = { name: 'minecraft:water', properties: { level: '0' } };
  const LAVA: BlockState = { name: 'minecraft:lava', properties: {} };
  const BUBBLE: BlockState = { name: 'minecraft:bubble_column', properties: {} };

  const liquidProvider: CollisionShapeProvider = {
    version: 'liquid-1',
    resolve(state, cell, read) {
      if (
        state.name === 'minecraft:water' ||
        state.name === 'minecraft:lava' ||
        state.name === 'minecraft:bubble_column'
      ) {
        return { kind: 'shape', shape: EMPTY };
      }
      return fakeProvider.resolve(state, cell, read);
    },
  };

  function wetMap(destinationTop: BlockState): VoxelMap {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
    ]);
    fill(map, WATER, [[1, 0, 0]]);
    fill(map, destinationTop, [[1, 1, 0]]);
    return map;
  }

  it('reports water contact and submersion without changing OPEN status', () => {
    const map = wetMap(WATER);
    const result = evaluateWalkStep(map, stepQuery(), liquidProvider, 2000);

    expect(result.status).toBe('OPEN');
    expect(result.hazards).toContainEqual({
      kind: 'water_contact',
      pos: { x: 1, y: 0, z: 0 },
      basis: 'observed',
      detail: 'observed minecraft:water',
    });
    expect(result.hazards).toContainEqual({
      kind: 'submersion',
      pos: { x: 1.5, y: 0, z: 0.5 },
      basis: 'observed',
      detail: 'the destination body volume is observed water',
    });
  });

  it('reports lava and bubble columns as observed hazards', () => {
    const lava = evaluateWalkStep(wetMap(LAVA), stepQuery(), liquidProvider, 2000);
    expect(lava.status).toBe('OPEN');
    expect(lava.hazards?.some((h) => h.kind === 'lava_contact' && h.pos.x === 1 && h.pos.y === 1)).toBe(true);
    expect(lava.hazards?.some((h) => h.kind === 'submersion')).toBe(false);

    const bubble = evaluateWalkStep(wetMap(BUBBLE), stepQuery(), liquidProvider, 2000);
    expect(bubble.hazards?.some((h) => h.kind === 'bubble_column' && h.pos.y === 1)).toBe(true);
  });

  it('never invents a hazard for a cell outside the body path or for unknown cells', () => {
    const map = wetMap(WATER);
    fill(map, WATER, [[0, 2, 0]]); // above the 1.8-high body

    const result = evaluateWalkStep(map, stepQuery(), liquidProvider, 2000);
    expect(result.hazards?.some((h) => h.pos.y === 2)).toBe(false);

    const dry = new VoxelMap('world');
    fill(dry, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fill(dry, AIR, SWEPT_AIR);
    expect(evaluateWalkStep(dry, stepQuery(), fakeProvider, 2000).hazards).toEqual([]);
  });

  it('derives a fall hazard from a measured descent only', () => {
    const map = wetMap(WATER);
    const horizontal = evaluateWalkStep(map, stepQuery(), liquidProvider, 2000);
    expect(horizontal.hazards?.some((h) => h.kind === 'fall')).toBe(false);

    const descent = evaluateGroundedWalkSegment(
      map,
      stepQuery(),
      { x: 1.5, y: -1, z: 0.5 },
      liquidProvider,
      2000,
      0.5,
    );
    expect(descent.hazards).toContainEqual({
      kind: 'fall',
      pos: { x: 1.5, y: -1, z: 0.5 },
      basis: 'derived',
      detail: 'measured drop of 1 block(s)',
    });
  });

  it('publishes a deterministic contextKey that includes body, mode and constraints', () => {
    const map = wetMap(WATER);
    const base = evaluateWalkStep(map, stepQuery(), liquidProvider, 2000);
    expect(base.contextKey).toBeTypeOf('string');

    expect(evaluateWalkStep(map, stepQuery(), liquidProvider, 3000).contextKey).toBe(base.contextKey);
    expect(
      evaluateWalkStep(map, stepQuery({ constraints: { avoid: [{ x: 2, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }] } }), liquidProvider, 2000)
        .contextKey,
    ).toBe(
      evaluateWalkStep(map, stepQuery({ constraints: { avoid: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }] } }), liquidProvider, 2000)
        .contextKey,
    );
    expect(
      evaluateWalkStep(map, stepQuery({ mode: 'jump' }), liquidProvider, 2000).contextKey,
    ).not.toBe(base.contextKey);
    expect(
      evaluateWalkStep(map, stepQuery({ body: bodyAt(0.5, 0, 0.5, 1.2, 1.8) }), liquidProvider, 2000).contextKey,
    ).not.toBe(base.contextKey);
  });
});
