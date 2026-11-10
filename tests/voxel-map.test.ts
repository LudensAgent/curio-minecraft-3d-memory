import { describe, expect, it } from 'vitest';

import type { CellEvidence, Observation, ObservationGap } from '../src/observation/types.js';
import {
  blockToSection,
  cellIndex,
  localCoord,
  sectionCoord,
  serializeBlockState,
  VoxelMap,
} from '../src/index.js';
import type { ChangeReport, Section } from '../src/index.js';
import { bitsRequired, getBit, readCell, repack, writeCell } from '../src/voxel/palette.js';

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
    expect(report.sections[0]!.invalidated).toBe(true);
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
    expect(report.sections[0]!.invalidated).toBe(false);
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
  it('rejects an older acquisition even when received later (same session)', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 200, sequence: 1 }));
    const report = map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 100, sequence: 2 }));

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

  it('a new session supersedes the old one and rejects late old-session scans', () => {
    const map = new VoxelMap('world');
    map.beginSession('A');
    map.observe(obs({ sessionId: 'A', observedAt: 100, sequence: 1, state: stone, pos: { x: 0, y: 0, z: 0 } }));

    const staleReport = map.beginSession('B');
    expect(staleReport.sections).toHaveLength(1);
    expect(staleReport.sections[0]!.invalidated).toBe(true);
    expect(staleReport.sections[0]!.cells[0]!.kind).toBe('staled');
    expect(evidenceAt(map, 'overworld', 0, 0, 0).freshness).toBe('STALE');

    map.observe(obs({ sessionId: 'B', observedAt: 200, sequence: 1, state: dirt, pos: { x: 0, y: 0, z: 0 } }));
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(dirt);

    // A late-arriving scan from the old session is rejected even if its observedAt is newer.
    const lateReport = map.observe(
      obs({ sessionId: 'A', observedAt: 250, sequence: 999, state: stone, pos: { x: 0, y: 0, z: 0 } }),
    );
    expect(lateReport.sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.sessionId).toBe('B');
    expect(evidenceAt(map, 'overworld', 0, 0, 0).observation.state).toEqual(dirt);
  });
});

describe('lifecycle invalidation', () => {
  it('beginSession with no prior session is a no-op report', () => {
    const map = new VoxelMap('world');
    expect(map.beginSession('A').sections).toEqual([]);
  });

  it('markStale marks cells STALE and reports the validity change', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    const revisionBefore = sectionAt(map, 'overworld', 0, 0, 0).revision;

    const report = map.markStale('overworld', 'unloaded');
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.invalidated).toBe(true);
    expect(report.sections[0]!.cells[0]!.kind).toBe('staled');

    const ev = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(ev.freshness).toBe('STALE');
    expect(ev.staleReason).toBe('unloaded');
    expect(ev.revision).toBe(2); // 1 (insert) + 1 (stale)
    expect(sectionAt(map, 'overworld', 0, 0, 0).revision).toBe(revisionBefore + 1);
  });

  it('recovering from stale advances version and reports restored', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    map.markStale('overworld', 'unloaded');
    const revisionAfterStale = sectionAt(map, 'overworld', 0, 0, 0).revision;

    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 200, sequence: 2 }));
    expect(report.sections[0]!.invalidated).toBe(true);
    expect(report.sections[0]!.cells[0]!.kind).toBe('restored');

    expect(evidenceAt(map, 'overworld', 0, 0, 0).revision).toBe(3); // insert + stale + restore
    expect(sectionAt(map, 'overworld', 0, 0, 0).revision).toBe(revisionAfterStale + 1);
  });

  it('keeps the stale bitmap in sync with validity transitions', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    expect(getBit(sectionAt(map, 'overworld', 0, 0, 0).stale, cellIndex(0, 0, 0))).toBe(false);

    map.markStale('overworld', 'unloaded');
    expect(getBit(sectionAt(map, 'overworld', 0, 0, 0).stale, cellIndex(0, 0, 0))).toBe(true);

    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 200, sequence: 2 }));
    expect(getBit(sectionAt(map, 'overworld', 0, 0, 0).stale, cellIndex(0, 0, 0))).toBe(false);
  });

  it('rejects observations acquired before an interruption from restoring staleness', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    map.markStale('overworld', 'unloaded');

    const pre = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 150, sequence: 2 }));
    expect(pre.sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).freshness).toBe('STALE');

    const post = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 165, sequence: 3 }));
    expect(post.sections[0]!.invalidated).toBe(true);
    expect(post.sections[0]!.cells[0]!.kind).toBe('restored');
    expect(evidenceAt(map, 'overworld', 0, 0, 0).freshness).toBe('FRESH');
  });

  it('rejects pre-interruption observations for previously-unknown cells', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    map.markStale('overworld', 'unloaded');

    // A delayed observation of a never-observed cell, acquired before the
    // interruption, must not be written as FRESH.
    const report = map.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 }, observedAt: 150 }));
    expect(report.sections).toEqual([]);
    expect(map.cellAt('overworld', 1, 0, 0).observed).toBe(false);
  });

  it('records the interruption boundary even when the dimension has no sections yet', () => {
    const map = new VoxelMap('world', { now: () => 160 });
    map.markStale('overworld', 'unloaded'); // empty dimension

    // First observation, acquired before the interruption, is rejected.
    const pre = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 150 }));
    expect(pre.sections).toEqual([]);
    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(false);

    // A post-interruption observation is accepted.
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 170, sequence: 2 }));
    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(true);
  });
});

describe('input and read isolation', () => {
  it('does not alias the caller observation object', () => {
    const map = new VoxelMap('world');
    const input = obs({ state: { name: 'minecraft:stone', properties: { a: '1' } }, pos: { x: 0, y: 0, z: 0 } });
    map.observe(input);

    input.state.name = 'minecraft:air';
    input.state.properties.a = '2';
    input.pos.x = 99;

    const ev = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(ev.observation.state.name).toBe('minecraft:stone');
    expect(ev.observation.state.properties).toEqual({ a: '1' });
    expect(ev.observation.pos).toEqual({ x: 0, y: 0, z: 0 });

    expect(sectionAt(map, 'overworld', 0, 0, 0).palette[1]).toBe('minecraft:stone[a=1]');
  });

  it('cellAt returns a snapshot that cannot mutate the store', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    const view = map.cellAt('overworld', 0, 0, 0);
    if (!view.observed) throw new Error('expected observed');
    view.evidence.observation.state.name = 'minecraft:air';
    view.evidence.revision = 999;

    const again = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(again.observation.state.name).toBe('minecraft:stone');
    expect(again.revision).toBe(1);
  });

  it('sectionAt returns a snapshot that cannot mutate the store', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    const section = map.sectionAt('overworld', 0, 0, 0)!;
    section.evidence.clear();
    section.palette.length = 0;
    section.key.dim = 'the_nether';

    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(true);
    const fresh = map.sectionAt('overworld', 0, 0, 0)!;
    expect(fresh.evidence.size).toBe(1);
    expect(fresh.palette.length).toBe(2);
    expect(fresh.key.dim).toBe('overworld');
  });

  it('sectionRef reads the live section without copying or changing it', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const saveRevisionBefore = map.saveRevision;

    const ref = map.sectionRef('overworld', 0, 0, 0)!;
    const snapshot = map.sectionAt('overworld', 0, 0, 0)!;

    // Live view = fresh shallow binding per call over shared payload; public
    // read = a deep copy each time.
    const again = map.sectionRef('overworld', 0, 0, 0)!;
    expect(again).not.toBe(ref);
    expect(again.palette).toBe(ref.palette);
    expect(again.evidence).toBe(ref.evidence);
    expect(map.sectionAt('overworld', 0, 0, 0)).not.toBe(snapshot);
    expect(ref).not.toBe(snapshot);
    expect(snapshot.palette).not.toBe(ref.palette);

    // The cheap read reports the same section content as the defensive copy.
    expect(ref.key).toEqual(snapshot.key);
    expect(ref.revision).toBe(snapshot.revision);
    expect(ref.palette).toEqual(snapshot.palette);
    expect(ref.bits).toBe(snapshot.bits);
    expect([...ref.cells]).toEqual([...snapshot.cells]);
    expect([...ref.explored]).toEqual([...snapshot.explored]);
    expect([...ref.traversed]).toEqual([...snapshot.traversed]);
    expect([...ref.stale]).toEqual([...snapshot.stale]);
    expect([...ref.risk]).toEqual([...snapshot.risk]);
    expect([...ref.modified]).toEqual([...snapshot.modified]);
    expect([...ref.evidence.keys()]).toEqual([...snapshot.evidence.keys()]);
    expect(ref.evidence.get(cellIndex(0, 0, 0))).toEqual(snapshot.evidence.get(cellIndex(0, 0, 0)));
    expect(ref.lastObservedAt).toBe(snapshot.lastObservedAt);

    // Reading is read-only: no evidence, revision or save change, and an
    // unallocated section still reads as null with the same coordinate guard.
    expect(map.saveRevision).toBe(saveRevisionBefore);
    expect(map.sectionRef('overworld', 0, 0, 0)!.revision).toBe(snapshot.revision);
    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(true);
    expect(map.sectionRef('overworld', 100, 0, 0)).toBeNull();
    expect(() => map.sectionRef('overworld', 0, 0.5, 0)).toThrow(/integer/);
  });

  it('mutating the sectionAt snapshot never reaches the sectionRef view', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    const snapshot = map.sectionAt('overworld', 0, 0, 0)!;
    snapshot.evidence.clear();
    snapshot.palette.length = 0;
    snapshot.revision = 999;
    snapshot.key.dim = 'the_nether';

    const ref = map.sectionRef('overworld', 0, 0, 0)!;
    expect(ref.evidence.size).toBe(1);
    expect(ref.palette.length).toBe(2);
    expect(ref.revision).toBe(1);
    expect(ref.key.dim).toBe('overworld');
  });

  it('sectionRef view rejects palette and evidence writes at the type level', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    // The body is type-checked even though the test never calls it: if the view
    // type were not narrowed, these `@ts-expect-error` lines would fail tsc.
    const mutateView = (ref: NonNullable<ReturnType<VoxelMap['sectionRef']>>): void => {
      // @ts-expect-error palette is readonly
      ref.palette.push('minecraft:dirt');
      // @ts-expect-error evidence is a ReadonlyMap (no set)
      ref.evidence.set(cellIndex(0, 0, 0), {} as CellEvidence);
      // @ts-expect-error evidence values are Readonly<CellEvidence> (no freshness write)
      ref.evidence.get(0)!.freshness = 'STALE';
    };
    expect(mutateView).toBeTypeOf('function');

    const ref = map.sectionRef('overworld', 0, 0, 0)!;
    expect(ref.palette.length).toBe(2);
    expect(ref.evidence.size).toBe(1);
  });

  it('change report key is isolated from the store', () => {
    const map = new VoxelMap('world');
    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    report.sections[0]!.key.dim = 'the_nether';

    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(true);
    expect(map.cellAt('the_nether', 0, 0, 0).observed).toBe(false);

    const second = map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    expect(second.sections[0]!.key.dim).toBe('overworld');
  });

  it('rejects non-integer query coordinates', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 1 } }));
    expect(() => map.cellAt('overworld', 0, 0.0625, 0)).toThrow(/integer/);
    expect(() => map.sectionAt('overworld', 0, 0.0625, 0)).toThrow(/integer/);
  });
});

describe('batch atomicity', () => {
  it('validates the whole batch before writing anything', () => {
    const map = new VoxelMap('world');
    const valid = obs({ state: stone, pos: { x: 0, y: 0, z: 0 } });
    const badWorld = obs({ worldId: 'other', pos: { x: 1, y: 0, z: 0 } });

    expect(() => map.observeBatch({ observations: [valid, badWorld], unobserved: [] })).toThrow(
      /does not match/,
    );
    expect(map.cellAt('overworld', 0, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt('overworld', 1, 0, 0)).toEqual({ observed: false });
  });
});

describe('localized change reports', () => {
  it('a change only invalidates its own section', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ state: stone, pos: { x: 100, y: 0, z: 0 } })); // section cx=6

    const otherRevision = sectionAt(map, 'overworld', 100, 0, 0).revision;

    const report = map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, sequence: 2, observedAt: 2000 }));
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.key.cx).toBe(0);
    expect(sectionAt(map, 'overworld', 100, 0, 0).revision).toBe(otherRevision); // untouched
  });
});

describe('read-only queries', () => {
  it('querying does not change evidence time or version', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100, sequence: 1 }));
    const revisionBefore = sectionAt(map, 'overworld', 0, 0, 0).revision;
    const lastObservedBefore = sectionAt(map, 'overworld', 0, 0, 0).lastObservedAt;

    map.cellAt('overworld', 0, 0, 0);
    map.sectionAt('overworld', 0, 0, 0);
    const evidence = evidenceAt(map, 'overworld', 0, 0, 0);

    expect(evidence.observation.observedAt).toBe(100);
    expect(evidence.revision).toBe(1);
    expect(sectionAt(map, 'overworld', 0, 0, 0).revision).toBe(revisionBefore);
    expect(sectionAt(map, 'overworld', 0, 0, 0).lastObservedAt).toBe(lastObservedBefore);
  });
});

describe('conflicting and invalid observations', () => {
  it('a same-timestamp conflicting observation invalidates the old conclusion', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: air, pos: { x: 0, y: 0, z: 0 } }));

    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 2 }));

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.invalidated).toBe(true);
    expect(report.sections[0]!.cells[0]!.kind).toBe('staled');

    const evidence = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(evidence.freshness).toBe('STALE');
    expect(evidence.staleReason).toBe('conflict');
    expect(evidence.observation.state).toEqual(air); // last-confirmed kept, but no longer trusted
  });

  it('a same-timestamp duplicate with identical content is a no-op', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const before = evidenceAt(map, 'overworld', 0, 0, 0);

    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 2 }));

    expect(report.sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).freshness).toBe(before.freshness);
  });

  it('rejects a non-finite observedAt', () => {
    const map = new VoxelMap('world');
    expect(() => map.observe(obs({ observedAt: Number.NaN }))).toThrow(/finite/);
  });

  it('does not re-invalidate when the same conflict is re-submitted', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: air, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 2 }));
    const revisionAfterConflict = evidenceAt(map, 'overworld', 0, 0, 0).revision;

    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 3 }));
    expect(report.sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).revision).toBe(revisionAfterConflict);
  });

  it('rejects a non-finite validityWindowMs', () => {
    expect(() => new VoxelMap('world', { validityWindowMs: Number.NaN })).toThrow(/finite/);
  });

  it('rejects a non-finite interruption clock', () => {
    const map = new VoxelMap('world', { now: () => Number.NaN });
    expect(() => map.markStale('overworld', 'unloaded')).toThrow(/finite/);
  });
});

describe('history marks (traversed / modified)', () => {
  it('marks traversed from a measured stance without inventing evidence', () => {
    const map = new VoxelMap('world');
    const report = map.markTraversed('overworld', { x: 3, y: 4, z: 5 });

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.cells[0]!.kind).toBe('traversed');
    expect(report.sections[0]!.invalidated).toBe(false);

    // The cell is history-only: never observed, never air, never explored.
    expect(map.cellAt('overworld', 3, 4, 5)).toEqual({ observed: false });
    expect(map.historyAt('overworld', 3, 4, 5)).toEqual({
      explored: false,
      traversed: true,
      modified: false,
      risk: false,
      stale: false,
    });
    const section = sectionAt(map, 'overworld', 3, 4, 5);
    expect(getBit(section.traversed, cellIndex(3, 4, 5))).toBe(true);
    expect(getBit(section.explored, cellIndex(3, 4, 5))).toBe(false);
    expect(section.evidence.size).toBe(0);

    // Idempotent: re-marking does not dirty the section again.
    const revision = map.saveRevision;
    expect(map.markTraversed('overworld', { x: 3, y: 4, z: 5 }).sections).toEqual([]);
    expect(map.saveRevision).toBe(revision);
  });

  it('handles negative coordinates and does not touch block-content revision', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: -1, y: -1, z: -1 } }));
    const sectionRevision = sectionAt(map, 'overworld', -1, -1, -1).revision;

    const report = map.markTraversed('overworld', { x: -1, y: -1, z: -1 });
    expect(report.sections[0]!.revision).toBe(sectionRevision);
    expect(sectionAt(map, 'overworld', -1, -1, -1).revision).toBe(sectionRevision);
    expect(getBit(sectionAt(map, 'overworld', -1, -1, -1).traversed, cellIndex(15, 15, 15))).toBe(true);
    expect(map.historyAt('overworld', -1, -1, -1)).toMatchObject({ traversed: true, explored: true });
  });

  it('requires a confirmed actionId for modified and never infers a stance', () => {
    const map = new VoxelMap('world');
    expect(() => map.markModified('overworld', { x: 0, y: 0, z: 0 }, '')).toThrow(/actionId/);

    const report = map.markModified('overworld', { x: 0, y: 0, z: 0 }, 'act-1');
    expect(report.sections[0]!.cells[0]!.kind).toBe('modified');
    expect(map.historyAt('overworld', 0, 0, 0)).toMatchObject({
      traversed: false,
      modified: true,
      explored: false,
    });
    expect(map.cellAt('overworld', 0, 0, 0)).toEqual({ observed: false });
  });

  it('unknown cells are never marked by reads or rejected input', () => {
    const map = new VoxelMap('world');
    expect(map.historyAt('overworld', 10, 10, 10)).toEqual({
      explored: false,
      traversed: false,
      modified: false,
      risk: false,
      stale: false,
    });
    expect(() => map.markTraversed('overworld', { x: 0.5, y: 0, z: 0 })).toThrow(/integer/);
    expect(map.historyAt('overworld', 0, 0, 0)).toMatchObject({ traversed: false, explored: false });
  });
});

describe('pending action effects', () => {
  it('invalidates the old conclusion without writing an expected new state', () => {
    const map = new VoxelMap('world');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));

    const report = map.invalidatePendingEffect('overworld', { x: 0, y: 0, z: 0 }, 'act-1');
    expect(report.sections[0]!.invalidated).toBe(true);
    expect(report.sections[0]!.cells[0]!.kind).toBe('staled');

    const view = evidenceAt(map, 'overworld', 0, 0, 0);
    expect(view.freshness).toBe('STALE');
    expect(view.staleReason).toBe('pending_effect');
    expect(view.revision).toBe(2);
    expect(view.observation.state).toEqual(stone); // no guessed air/new state
    expect(map.historyAt('overworld', 0, 0, 0).stale).toBe(true);

    // Repeating the same pending effect is a no-op.
    expect(map.invalidatePendingEffect('overworld', { x: 0, y: 0, z: 0 }, 'act-1').sections).toEqual([]);

    // Unknown cells stay unknown.
    expect(map.invalidatePendingEffect('overworld', { x: 5, y: 0, z: 0 }, 'act-2').sections).toEqual([]);
    expect(map.cellAt('overworld', 5, 0, 0)).toEqual({ observed: false });
  });

  it('does not invalidate evidence already confirmed by that same action', () => {
    const map = new VoxelMap('world');
    map.observe(
      obs({
        state: stone,
        pos: { x: 0, y: 0, z: 0 },
        source: 'agent_action',
        evidence: 'confirmed_effect',
        actionId: 'act-1',
      }),
    );

    expect(map.invalidatePendingEffect('overworld', { x: 0, y: 0, z: 0 }, 'act-1').sections).toEqual([]);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).freshness).toBe('FRESH');

    // A different pending action still invalidates the old conclusion.
    expect(map.invalidatePendingEffect('overworld', { x: 0, y: 0, z: 0 }, 'act-2').sections).toHaveLength(1);
    expect(evidenceAt(map, 'overworld', 0, 0, 0).staleReason).toBe('pending_effect');
  });
});

describe('observation boundary validation', () => {
  it('rejects unknown enums, bad scopes and inconsistent evidence semantics', () => {
    const map = new VoxelMap('world');
    expect(() => map.observe(obs({ source: 'radio' as unknown as Observation['source'] }))).toThrow(/source/);
    expect(() => map.observe(obs({ evidence: 'guess' as unknown as Observation['evidence'] }))).toThrow(/evidence/);
    expect(() => map.observe(obs({ dim: '' }))).toThrow(/dim/);
    expect(() => map.observe(obs({ sessionId: '' }))).toThrow(/sessionId/);
    expect(() => map.observe(obs({ stateComplete: 'yes' as unknown as boolean }))).toThrow(/stateComplete/);
    expect(() => map.observe(obs({ sequence: 1.5 }))).toThrow(/sequence/);
    expect(() => map.observe(obs({ observedWorldTick: Number.NaN }))).toThrow(/observedWorldTick/);
    expect(() => map.observe(obs({ state: { name: '', properties: {} } }))).toThrow(/state name/);
    expect(() =>
      map.observe(obs({ state: { name: 'minecraft:stone', properties: { a: 1 as unknown as string } } })),
    ).toThrow(/strings/);
  });

  it('requires verified action attribution for confirmed effects', () => {
    const map = new VoxelMap('world');
    expect(() => map.observe(obs({ evidence: 'confirmed_effect' }))).toThrow(/actionId/);
    expect(() => map.observe(obs({ actionId: 'act-1' }))).toThrow(/confirmed_effect/);
    expect(() => map.observe(obs({ source: 'agent_action' }))).toThrow(/confirmed_effect/);

    expect(() =>
      map.observe(
        obs({ source: 'agent_action', evidence: 'confirmed_effect', actionId: 'act-1', pos: { x: 0, y: 0, z: 0 } }),
      ),
    ).not.toThrow();
    expect(map.cellAt('overworld', 0, 0, 0).observed).toBe(true);
  });
});

describe('batch gaps', () => {
  it('returns bounded gaps without writing them as cells or air', () => {
    const map = new VoxelMap('world');
    const report = map.observeBatch({
      observations: [obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })],
      unobserved: [
        { pos: { x: 1, y: 0, z: 0 }, reason: 'occluded' },
        { pos: { x: 2, y: 0, z: 0 }, reason: 'budget_not_scanned' },
      ],
    });

    expect(report.gaps).toEqual([
      { pos: { x: 1, y: 0, z: 0 }, reason: 'occluded' },
      { pos: { x: 2, y: 0, z: 0 }, reason: 'budget_not_scanned' },
    ]);
    expect(map.cellAt('overworld', 1, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt('overworld', 2, 0, 0)).toEqual({ observed: false });
    expect(map.historyAt('overworld', 1, 0, 0).explored).toBe(false);

    // The returned gaps are copies: mutating them cannot reach the map.
    report.gaps[0]!.pos.x = 99;
    expect(map.cellAt('overworld', 99, 0, 0)).toEqual({ observed: false });
  });

  it('rejects malformed gap positions and reasons before writing anything', () => {
    const map = new VoxelMap('world');
    expect(() =>
      map.observeBatch({
        observations: [obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })],
        unobserved: [{ pos: { x: 0.5, y: 0, z: 0 }, reason: 'unknown' }],
      }),
    ).toThrow(/integer/);
    expect(() =>
      map.observeBatch({
        observations: [],
        unobserved: [{ pos: { x: 0, y: 0, z: 0 }, reason: 'guessed' as unknown as ObservationGap['reason'] }],
      }),
    ).toThrow(/reason/);
    expect(map.cellAt('overworld', 0, 0, 0)).toEqual({ observed: false });
  });
});

describe('synchronous change hook', () => {
  it('fires once per batch, after the fact is applied, and not for no-ops', () => {
    const reports: ChangeReport[] = [];
    const map = new VoxelMap('world', { onChange: (report) => reports.push(report) });

    let observedDuringCallback = false;
    const observingMap = new VoxelMap('world', {
      onChange: () => {
        observedDuringCallback = observingMap.cellAt('overworld', 0, 0, 0).observed;
      },
    });
    observingMap.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(observedDuringCallback).toBe(true);

    map.observeBatch({
      observations: [
        obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }),
        obs({ state: dirt, pos: { x: 1, y: 0, z: 0 } }),
      ],
      unobserved: [],
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sections[0]!.cells).toHaveLength(2);

    // Idempotent duplicate → no report → no callback.
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(reports).toHaveLength(1);

    // Lifecycle invalidation also fires once with its report.
    map.markStale('overworld', 'unloaded');
    expect(reports).toHaveLength(2);
    expect(reports[1]!.sections[0]!.invalidated).toBe(true);
  });
});

describe('manual directory paging', () => {
  it('returns stable seq pages without loading payloads', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory(Array.from({ length: 5 }, (_, i) => ({
      key: { worldId: 'world', dim: 'overworld', cx: i, cz: 0, sy: 0 },
      seq: 10 + i,
      bytes: 100 + i,
      observedCells: 1,
      paletteEntries: 1,
      revision: 1,
    })));
    const first = map.directoryPage({ limit: 2 });
    expect(first.items.map((entry) => entry.seq)).toEqual([10, 11]);
    expect(first.nextAfter).toBe(11);
    const second = map.directoryPage({ after: first.nextAfter, limit: 2 });
    expect(second.items.map((entry) => entry.seq)).toEqual([12, 13]);
    const last = map.directoryPage({ after: second.nextAfter, limit: 2 });
    expect(last.items.map((entry) => entry.seq)).toEqual([14]);
    expect(last.nextAfter).toBeUndefined();
    expect(map.directoryPage({ after: 14, limit: 2 }).items).toEqual([]);
  });

  it('rejects an invalid cursor or limit and is manual-only', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    expect(() => map.directoryPage({ after: -1 })).toThrow(/after/);
    expect(() => map.directoryPage({ limit: 0 })).toThrow(/limit/);
    expect(() => new VoxelMap('world').directoryPage()).toThrow(/manual/);
  });
});
