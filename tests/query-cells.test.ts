import { describe, expect, it } from 'vitest';

import { VoxelMap } from '../src/index.js';
import type { ObservationGap, SectionKey } from '../src/index.js';
import type {
  CellQueryView,
  SpatialQueryResult,
} from '../src/query/index.js';
import { AIR, STONE, obs, pathFragment } from './fakes.js';
import {
  captureStoreState,
  DIM,
  makeQueryParts,
  runQuery,
  WORLD,
} from './query-fixtures.js';

const SECTION_ZERO: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

function cellsOf(result: SpatialQueryResult): CellQueryView[] {
  if (result.data?.kind !== 'cells') throw new Error('expected a cells result');
  return result.data.cells;
}

function gapsOf(result: SpatialQueryResult): ObservationGap[] {
  if (result.data?.kind !== 'cells') throw new Error('expected a cells result');
  return result.data.gaps;
}

function manualMap(): VoxelMap {
  return new VoxelMap(WORLD, { now: () => 5000, manualResidency: true });
}

describe('cells query — observed evidence', () => {
  it('projects observed air and stone with their full evidence metadata', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(AIR, { x: 0, y: 64, z: 0 }));
    parts.map.observe(obs(STONE, { x: 1, y: 64, z: 0 }));

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: 0, y: 64, z: 0 },
        { x: 1, y: 64, z: 0 },
      ],
    });

    expect(result.status).toBe('ok');
    expect(result.contract).toBe('memory-host-contract/1');
    expect(result.worldId).toBe(WORLD);
    expect(result.dim).toBe(DIM);
    expect(result.sessionId).toBe('s1');
    expect(result.readOnly).toBe(true);
    expect(result.executable).toBe(false);

    const cells = cellsOf(result);
    expect(cells).toHaveLength(2);
    expect(gapsOf(result)).toEqual([]);

    expect(cells[0]).toEqual({
      pos: { x: 0, y: 64, z: 0 },
      observed: true,
      state: { name: AIR.name, properties: {} },
      stateComplete: true,
      evidence: 'seen',
      freshness: 'FRESH',
      validUntil: 61_000,
    });
    // Residency fields are additive and only describe unobserved cells.
    expect(cells[0]).not.toHaveProperty('residency');
    expect(cells[0]).not.toHaveProperty('unobservedReason');
    expect(cells[1]).toEqual({
      pos: { x: 1, y: 64, z: 0 },
      observed: true,
      state: { name: STONE.name, properties: {} },
      stateComplete: true,
      evidence: 'seen',
      freshness: 'FRESH',
      validUntil: 61_000,
    });
  });

  it('preserves stateComplete=false and the exact properties', () => {
    const parts = makeQueryParts();
    const partial = {
      name: 'minecraft:oak_door',
      properties: { facing: 'north', open: 'false', half: 'lower' },
    };
    parts.map.observe(obs(partial, { x: 4, y: 70, z: 4 }, { stateComplete: false }));

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 4, y: 70, z: 4 }],
    });

    const [cell] = cellsOf(result);
    expect(cell!.observed).toBe(true);
    expect(cell!.stateComplete).toBe(false);
    expect(cell!.state).toEqual(partial);
    expect(cell!.state).not.toBe(partial);
  });

  it('resolves negative coordinates to the correct section and cell', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(AIR, { x: -1, y: -1, z: -1 }));
    parts.map.observe(obs(STONE, { x: -17, y: -2, z: -33 }));

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: -1, y: -1, z: -1 },
        { x: -17, y: -2, z: -33 },
      ],
    });

    const cells = cellsOf(result);
    expect(cells[0]!.state).toEqual({ name: AIR.name, properties: {} });
    expect(cells[0]!.pos).toEqual({ x: -1, y: -1, z: -1 });
    expect(cells[1]!.state).toEqual({ name: STONE.name, properties: {} });
    expect(cells[1]!.pos).toEqual({ x: -17, y: -2, z: -33 });
  });

  it('reports stale evidence with the recorded stale reason', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(STONE, { x: 0, y: 64, z: 0 }));
    parts.map.markStale(DIM, 'observation_gap');

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 64, z: 0 }],
    });

    const [cell] = cellsOf(result);
    expect(cell!.observed).toBe(true);
    expect(cell!.freshness).toBe('STALE');
    expect(cell!.staleReason).toBe('observation_gap');
    expect(cell!.state).toEqual({ name: STONE.name, properties: {} });
  });

  it('preserves duplicate positions in request order', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(STONE, { x: 0, y: 64, z: 0 }));

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: 0, y: 64, z: 0 },
        { x: 0, y: 64, z: 0 },
      ],
    });

    expect(cellsOf(result)).toHaveLength(2);
    expect(cellsOf(result).every((cell) => cell.observed)).toBe(true);
  });
});

describe('cells query — unobserved cells', () => {
  it('reports a never-observed cell in an allocated section without a gap', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(STONE, { x: 0, y: 64, z: 0 })); // allocates the section

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 1, y: 64, z: 0 }],
    });

    expect(result.status).toBe('ok');
    expect(gapsOf(result)).toEqual([]);
    expect(cellsOf(result)).toEqual([
      {
        pos: { x: 1, y: 64, z: 0 },
        observed: false,
        residency: 'resident',
        unobservedReason: 'resident',
      },
    ]);
  });

  it('reports a no-record section as unobserved without a gap (never observed is not unloaded)', () => {
    const parts = makeQueryParts();

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 100, y: 64, z: 100 }],
    });

    expect(result.status).toBe('ok');
    expect(gapsOf(result)).toEqual([]);
    expect(cellsOf(result)).toEqual([
      {
        pos: { x: 100, y: 64, z: 100 },
        observed: false,
        residency: 'no_record',
        unobservedReason: 'no_record',
      },
    ]);
    // A read-only query never allocates a Section to answer `no_record`.
    expect(parts.map.residentSize().sections).toBe(0);
  });

  it('distinguishes a no-record section from a resident section with an unobserved cell', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(STONE, { x: 0, y: 64, z: 0 })); // creates a resident Section

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: 1, y: 64, z: 0 }, // same Section, cell never observed
        { x: 100, y: 64, z: 100 }, // no Section record at all
      ],
    });

    expect(result.status).toBe('ok');
    expect(gapsOf(result)).toEqual([]);
    const [residentUnobserved, noRecord] = cellsOf(result);
    expect(residentUnobserved).toEqual({
      pos: { x: 1, y: 64, z: 0 },
      observed: false,
      residency: 'resident',
      unobservedReason: 'resident',
    });
    expect(noRecord).toEqual({
      pos: { x: 100, y: 64, z: 100 },
      observed: false,
      residency: 'no_record',
      unobservedReason: 'no_record',
    });
    // Neither is air: the Section state differs, but both remain unobserved.
    expect(residentUnobserved!.residency).not.toBe(noRecord!.residency);
  });
});

describe('cells query — residency gaps', () => {
  it('reports committed-but-not-resident sections as unloaded without loading them', () => {
    const map = manualMap();
    map.installDirectory([
      { key: SECTION_ZERO, seq: 1, bytes: 1, observedCells: 0, paletteEntries: 0, revision: 0 },
    ]);
    const parts = makeQueryParts({ map });

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 0, z: 0 }],
    });

    expect(result.status).toBe('partial');
    expect(gapsOf(result)).toEqual([{ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' }]);
    expect(cellsOf(result)).toEqual([
      {
        pos: { x: 0, y: 0, z: 0 },
        observed: false,
        residency: 'not_resident',
        gap: { pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' },
      },
    ]);

    // The query must not load, pin, or otherwise change residency.
    expect(map.sectionResidency(SECTION_ZERO).residency).toBe('not_resident');
    expect(map.residentSize().sections).toBe(0);
    expect(map.pinState()).toEqual({ leases: 0, pinnedSections: 0 });
  });

  it('reports loading sections as an unloaded gap', () => {
    const map = manualMap();
    map.installDirectory([]);
    map.markLoading([SECTION_ZERO]);
    const parts = makeQueryParts({ map });

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 0, z: 0 }],
    });

    expect(result.status).toBe('partial');
    expect(gapsOf(result)).toEqual([{ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' }]);
    expect(cellsOf(result)).toEqual([
      {
        pos: { x: 0, y: 0, z: 0 },
        observed: false,
        residency: 'loading',
        gap: { pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' },
      },
    ]);
    expect(map.sectionResidency(SECTION_ZERO).residency).toBe('loading');
  });

  it('reports load_failed sections as an unloaded gap', () => {
    const map = manualMap();
    map.installDirectory([]);
    map.markLoadFailed([SECTION_ZERO]);
    const parts = makeQueryParts({ map });

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 0, z: 0 }],
    });

    expect(result.status).toBe('partial');
    expect(gapsOf(result)).toEqual([{ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' }]);
    expect(cellsOf(result)).toEqual([
      {
        pos: { x: 0, y: 0, z: 0 },
        observed: false,
        residency: 'load_failed',
        gap: { pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' },
      },
    ]);
    expect(map.sectionResidency(SECTION_ZERO).residency).toBe('load_failed');
  });

  it('distinguishes not_resident, loading, and load_failed under the same unloaded gap', () => {
    const viewFor = (prepare: (map: VoxelMap) => void): CellQueryView => {
      const map = manualMap();
      prepare(map);
      const result = runQuery(makeQueryParts({ map }), {
        kind: 'cells',
        dim: DIM,
        positions: [{ x: 0, y: 0, z: 0 }],
      });
      expect(result.status).toBe('partial');
      expect(gapsOf(result)).toEqual([{ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' }]);
      return cellsOf(result)[0]!;
    };

    const unloaded = viewFor((map) =>
      map.installDirectory([
        { key: SECTION_ZERO, seq: 1, bytes: 1, observedCells: 0, paletteEntries: 0, revision: 0 },
      ]),
    );
    const loading = viewFor((map) => {
      map.installDirectory([]);
      map.markLoading([SECTION_ZERO]);
    });
    const loadFailed = viewFor((map) => {
      map.installDirectory([]);
      map.markLoadFailed([SECTION_ZERO]);
    });

    // The public gap stays `unloaded` for all three; only the additive field
    // separates them.
    for (const cell of [unloaded, loading, loadFailed]) {
      expect(cell.observed).toBe(false);
      expect(cell.gap).toEqual({ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' });
      expect(cell.unobservedReason).toBeUndefined();
    }
    expect([unloaded.residency, loading.residency, loadFailed.residency]).toEqual([
      'not_resident',
      'loading',
      'load_failed',
    ]);
  });

  it('mixes observed cells with gaps, reporting only the unavailable one', () => {
    const map = manualMap();
    map.installDirectory([
      { key: SECTION_ZERO, seq: 1, bytes: 1, observedCells: 0, paletteEntries: 0, revision: 0 },
    ]);
    // A brand-new section is writable even in manual mode.
    map.observe(obs(STONE, { x: 16, y: 0, z: 0 }));
    const parts = makeQueryParts({ map });

    const result = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: 16, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ],
    });

    expect(result.status).toBe('partial');
    const cells = cellsOf(result);
    expect(cells[0]!.observed).toBe(true);
    expect(cells[0]!.state).toEqual({ name: STONE.name, properties: {} });
    expect(cells[1]!.observed).toBe(false);
    expect(cells[1]!.residency).toBe('not_resident');
    expect(cells[1]!.gap).toEqual({ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' });

    expect(gapsOf(result)).toEqual([{ pos: { x: 0, y: 0, z: 0 }, reason: 'unloaded' }]);
  });
});

describe('cells query — validation and isolation', () => {
  it('rejects more than 4096 positions', () => {
    const parts = makeQueryParts();
    const positions = Array.from({ length: 4097 }, () => ({ x: 0, y: 0, z: 0 }));

    const result = runQuery(parts, { kind: 'cells', dim: DIM, positions });

    expect(result.status).toBe('invalid_request');
    expect(result.problem?.kind).toBe('invalid_request');
    expect(result.data).toBeUndefined();
  });

  it('returns copies that cannot mutate stored evidence', () => {
    const parts = makeQueryParts();
    const state = { name: 'minecraft:oak_log', properties: { axis: 'y' } };
    parts.map.observe(obs(state, { x: 0, y: 64, z: 0 }));

    const first = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 64, z: 0 }],
    });
    const firstCell = cellsOf(first)[0]!;
    firstCell.pos.x = 999;
    firstCell.state!.name = 'minecraft:mutated';
    firstCell.state!.properties.axis = 'x';
    gapsOf(first).push({ pos: { x: 1, y: 2, z: 3 }, reason: 'unknown' });

    const again = runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [{ x: 0, y: 64, z: 0 }],
    });
    const cell = cellsOf(again)[0]!;
    expect(cell.pos).toEqual({ x: 0, y: 64, z: 0 });
    expect(cell.state).toEqual({ name: 'minecraft:oak_log', properties: { axis: 'y' } });
    expect(gapsOf(again)).toEqual([]);
  });

  it('does not mutate store state across cell queries', () => {
    const parts = makeQueryParts();
    parts.map.observe(obs(AIR, { x: 0, y: 64, z: 0 }, { observedAt: 4321 }));
    parts.map.observe(obs(STONE, { x: 1, y: 64, z: 0 }));
    parts.fragments.saveFragment(pathFragment('frag-ab'));
    const before = captureStoreState(parts);

    runQuery(parts, {
      kind: 'cells',
      dim: DIM,
      positions: [
        { x: 0, y: 64, z: 0 },
        { x: 1, y: 64, z: 0 },
        { x: 2, y: 64, z: 0 },
      ],
    });
    runQuery(parts, { kind: 'cells', dim: DIM, positions: [{ x: 100, y: 0, z: 100 }] });

    // Evidence time and fragment use records are never refreshed by a query.
    expect(parts.map.cellAt(DIM, 0, 64, 0)).toMatchObject({
      observed: true,
      evidence: { observation: { observedAt: 4321 } },
    });
    expect(parts.fragments.getFragment('frag-ab')?.lastUsedAt).toBe(1000);
    expect(parts.fragments.getFragment('frag-ab')?.uses).toBe(1);
    expect(captureStoreState(parts)).toEqual(before);
  });
});
