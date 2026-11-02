import { describe, expect, it } from 'vitest';

import type { CellEvidence, Observation } from '../src/observation/types.js';
import {
  blockToSection,
  cellIndex,
  localCoord,
  sectionCoord,
  serializeBlockState,
  VoxelMap,
} from '../src/index.js';
import type { Section } from '../src/index.js';
import { bitsRequired, readCell, repack, writeCell } from '../src/voxel/palette.js';

const air = { name: 'minecraft:air', properties: {} };
const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };
const oakDoorClosed = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'false' } };
const oakDoorOpen = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'true' } };

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: stone,
    pos: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function evidenceAt(map: VoxelMap, dim: string, x: number, y: number, z: number): CellEvidence {
  const view = map.cellAt(dim, x, y, z);
  if (!view.observed) throw new Error(`expected observed cell at ${x},${y},${z}`);
  return view.evidence;
}

function sectionAt(map: VoxelMap, dim: string, x: number, y: number, z: number): Section {
  const section = map.sectionAt(dim, x, y, z);
  if (section === null) throw new Error(`expected section at ${x},${y},${z}`);
  return section;
}

describe('section coordinate math', () => {
  it('uses floor for section index on negative coordinates', () => {
    expect(sectionCoord(-1)).toBe(-1);
    expect(sectionCoord(-16)).toBe(-1);
    expect(sectionCoord(-17)).toBe(-2);
    expect(sectionCoord(0)).toBe(0);
    expect(sectionCoord(15)).toBe(0);
    expect(sectionCoord(16)).toBe(1);
  });

  it('normalizes local coordinates to [0, 15] on both signs', () => {
    expect(localCoord(-1)).toBe(15);
    expect(localCoord(-16)).toBe(0);
    expect(localCoord(-17)).toBe(15);
    expect(localCoord(15)).toBe(15);
    expect(localCoord(16)).toBe(0);
  });

  it('decomposes a negative block position into the correct section and cell', () => {
    expect(blockToSection(-1, -1, -1)).toEqual({ cx: -1, cz: -1, sy: -1, lx: 15, ly: 15, lz: 15 });
    expect(blockToSection(-16, -32, 48)).toEqual({ cx: -1, cz: 3, sy: -2, lx: 0, ly: 0, lz: 0 });
  });

  it('indexes cells x-fastest, then z, then y', () => {
    expect(cellIndex(0, 0, 0)).toBe(0);
    expect(cellIndex(15, 0, 0)).toBe(15);
    expect(cellIndex(0, 0, 15)).toBe(15 * 16);
    expect(cellIndex(0, 15, 0)).toBe(15 * 16 * 16);
    expect(cellIndex(15, 15, 15)).toBe(4095);
  });
});

describe('palette and bit packing', () => {
  it('computes bit width from palette length', () => {
    expect(bitsRequired(1)).toBe(1);
    expect(bitsRequired(2)).toBe(1);
    expect(bitsRequired(3)).toBe(2);
    expect(bitsRequired(4)).toBe(2);
    expect(bitsRequired(5)).toBe(3);
  });

  it('round-trips packed values and repack preserves them', () => {
    const cells = new Uint8Array(512);
    writeCell(cells, 1, 0, 1);
    writeCell(cells, 1, 5, 0);
    writeCell(cells, 1, 4095, 1);
    expect(readCell(cells, 1, 0)).toBe(1);
    expect(readCell(cells, 1, 5)).toBe(0);
    expect(readCell(cells, 1, 4095)).toBe(1);

    const wider = repack(cells, 1, 3);
    expect(readCell(wider, 3, 0)).toBe(1);
    expect(readCell(wider, 3, 5)).toBe(0);
    expect(readCell(wider, 3, 4095)).toBe(1);
  });

  it('palette expansion does not corrupt existing cells', () => {
    const map = new VoxelMap('world');
    const blocks = [
      { name: 'minecraft:stone', properties: {} },
      { name: 'minecraft:dirt', properties: {} },
      { name: 'minecraft:grass_block', properties: {} },
      { name: 'minecraft:cobblestone', properties: {} },
      { name: 'minecraft:oak_planks', properties: {} },
    ];
    blocks.forEach((state, i) => {
      map.observe(obs({ state, pos: { x: i, y: 0, z: 0 } }));
    });

    const section = sectionAt(map, 'overworld', 0, 0, 0);
    expect(section.palette.length).toBe(6); // air + 5 blocks
    expect(section.bits).toBe(3);

    for (let i = 0; i < blocks.length; i++) {
      const paletteIndex = section.palette.indexOf(serializeBlockState(blocks[i]!));
      expect(readCell(section.cells, section.bits, cellIndex(i, 0, 0))).toBe(paletteIndex);
      expect(evidenceAt(map, 'overworld', i, 0, 0).observation.state).toEqual(blocks[i]);
    }
  });
});

describe('known air vs unknown cell', () => {
  it('distinguishes confirmed air from a never-observed cell', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: air, pos: { x: 0, y: 0, z: 0 } }));

    const observed = map.cellAt('overworld', 0, 0, 0);
    expect(observed.observed).toBe(true);
    if (observed.observed) {
      expect(observed.evidence.observation.state.name).toBe('minecraft:air');
    }

    expect(map.cellAt('overworld', 1, 0, 0)).toEqual({ observed: false });
  });

  it('air has an explored bit and evidence; unknown has neither', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: air, pos: { x: 0, y: 0, z: 0 } }));
    const section = sectionAt(map, 'overworld', 0, 0, 0);

    expect(section.explored[0]! & 1).not.toBe(0); // cell 0 explored
    expect(section.evidence.has(cellIndex(0, 0, 0))).toBe(true);
    expect(section.evidence.has(cellIndex(1, 0, 0))).toBe(false);
  });
});

describe('state identity', () => {
  it('serializes property keys order-independently', () => {
    const a = serializeBlockState({ name: 'minecraft:oak_door', properties: { open: 'true', half: 'lower' } });
    const b = serializeBlockState({ name: 'minecraft:oak_door', properties: { half: 'lower', open: 'true' } });
    expect(a).toBe(b);
  });

  it('treats a same-name property change as a content change', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: oakDoorClosed, pos: { x: 0, y: 0, z: 0 } }));
    const before = evidenceAt(map, 'overworld', 0, 0, 0);

    const report = map.observe(obs({ state: oakDoorOpen, pos: { x: 0, y: 0, z: 0 }, sequence: 2, observedAt: 2000 }));
    expect(report.sections[0]!.contentChanged).toBe(true);
    expect(report.sections[0]!.cells[0]!.kind).toBe('changed');

    const after = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.observation.state).toEqual(oakDoorOpen);
  });

  it('re-confirming the same state (different key order) is a refresh, not a change', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: oakDoorOpen, pos: { x: 0, y: 0, z: 0 } }));
    const sectionBefore = sectionAt(map, 'overworld', 0, 0, 0).revision;
    const before = evidenceAt(map, 'overworld', 0, 0, 0);

    const report = map.observe(
      obs({
        state: { name: 'minecraft:oak_door', properties: { open: 'true', half: 'lower' } },
        pos: { x: 0, y: 0, z: 0 },
        sequence: 2,
        observedAt: 2000,
      }),
    );
    expect(report.sections[0]!.contentChanged).toBe(false);
    expect(report.sections[0]!.cells[0]!.kind).toBe('refreshed');

    const after = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(after.revision).toBe(before.revision); // unchanged
    expect(after.observation.observedAt).toBe(2000); // refreshed
    expect(sectionAt(map, 'overworld', 0, 0, 0).revision).toBe(sectionBefore);
  });
});

describe('evidence refresh scope', () => {
  it('re-observing one cell does not refresh its neighbours', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100, sequence: 1 }));
    map.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 }, observedAt: 100, sequence: 1 }));

    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 300, sequence: 2 }));

    const neighbour = evidenceAt(map, 'overworld', 1, 0, 0);
    expect(neighbour.observation.observedAt).toBe(100);
    expect(neighbour.observation.state).toEqual(dirt);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.observedAt).toBe(300);
  });
});

describe('ordering and scope isolation', () => {
  it('ignores a stale same-session observation with a lower sequence', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, sequence: 5, observedAt: 100 }));
    const report = map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, sequence: 3, observedAt: 200 }));

    expect(report.sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(stone);
  });

  it('isolates observations by dimension', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, dim: 'overworld' }));
    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, dim: 'the_nether' }));

    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(stone);
    expect(evidenceAt(map, 'the_nether', 0, 0, 0).observation.state).toEqual(dirt);
  });

  it('rejects an observation from a different world', () => {
    const map = new VoxelMap('world');
    expect(() => map.observe(obs({ worldId: 'other' }))).toThrow(/does not match/);
  });

  it('a new session supersedes an old one, and a late old-session scan cannot overwrite it', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ sessionId: 'A', observedAt: 100, sequence: 1, state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ sessionId: 'B', observedAt: 200, sequence: 1, state: dirt, pos: { x: 0, y: 0, z: 0 } }));
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(dirt);

    // Late-arriving scan from the old session A (acquired before B) must not overwrite B.
    map.observe(obs({ sessionId: 'A', observedAt: 150, sequence: 999, state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(dirt);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.sessionId).toBe('B');
  });
});

describe('localized change reports', () => {
  it('a change only invalidates its own section', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ state: stone, pos: { x: 100, y: 0, z: 0 } })); // section cx=6

    const other = sectionAt(map, 'overworld', 100, 0, 0);
    const otherRevision = other.revision;

    const report = map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, sequence: 2, observedAt: 2000 }));
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.key.cx).toBe(0);
    expect(other.revision).toBe(otherRevision); // untouched
  });
});

describe('read-only queries', () => {
  it('querying does not change evidence time or version', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100, sequence: 1 }));
    const section = sectionAt(map, 'overworld', 0, 0, 0);
    const revisionBefore = section.revision;
    const lastObservedBefore = section.lastObservedAt;

    map.cellAt('overworld', 0, 0, 0);
    map.sectionAt('overworld', 0, 0, 0);
    const evidence = evidenceAt(map, 'overworld', 0, 0, 0);

    expect(evidence.observation.observedAt).toBe(100);
    expect(evidence.revision).toBe(1);
    expect(section.revision).toBe(revisionBefore);
    expect(section.lastObservedAt).toBe(lastObservedBefore);
  });
});
