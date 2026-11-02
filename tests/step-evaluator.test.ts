import { describe, expect, it } from 'vitest';

import { evaluateWalkStep, VoxelMap } from '../src/index.js';
import type { Section } from '../src/index.js';
import { AIR, bodyAt, fakeProvider, obs, SLAB, STONE, stepQuery, THIN } from './fakes.js';

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
});
