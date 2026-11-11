import { describe, expect, it } from 'vitest';

import { SECTION_CELL_COUNT, VOXEL_SNAPSHOT_SCHEMA_VERSION } from '../src/constants.js';
import type { CellEvidence, Observation } from '../src/observation/types.js';
import type { CellView } from '../src/voxel/voxel-map.js';
import { bitsRequired, writeCell } from '../src/voxel/palette.js';
import { cellIndex } from '../src/voxel/coordinates.js';
import type { SectionKey } from '../src/voxel/section.js';
import {
  estimateVoxelSectionResidentBytes,
  type VoxelCellEvidenceSnapshot,
  type VoxelSectionSnapshot,
} from '../src/voxel/snapshot.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';

const WORLD = 'world';
const DIM = 'overworld';
const SECTION: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

const air = { name: 'minecraft:air', properties: {} };
const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1_000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: stone,
    pos: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function evidenceAt(map: VoxelMap, x: number, y: number, z: number): CellEvidence {
  const view: CellView = map.cellAt(DIM, x, y, z);
  if (!view.observed) throw new Error(`expected observed cell at ${x},${y},${z}`);
  return view.evidence;
}

function manualMap(maxResidentBytes?: number): VoxelMap {
  const map = new VoxelMap(WORLD, {
    manualResidency: true,
    residencyLimits: { maxResidentBytes },
    now: () => 10_000,
  });
  map.installDirectory([]);
  map.beginSession('s1');
  return map;
}

function sectionOf(map: VoxelMap) {
  const section = map.sectionAt(DIM, 0, 0, 0);
  if (section === null) throw new Error('expected section');
  return section;
}

/** Distinct local cell positions inside one 16×16×16 Section (x fastest, then z, then y). */
function cellPos(index: number): { x: number; y: number; z: number } {
  return {
    x: index % 16,
    y: Math.floor(index / 256),
    z: Math.floor(index / 16) % 16,
  };
}

/**
 * A legacy-looking snapshot whose palette carries many entries no observed cell
 * references. Its packing width is therefore much wider than the live state
 * needs, which is exactly the state an old append-only palette leaves behind.
 */
function snapshotWithUnusedPalette(observedAt = 1_000): VoxelSectionSnapshot {
  const palette = [
    'minecraft:air',
    'minecraft:stone',
    ...Array.from({ length: 200 }, (_, index) => `minecraft:unused[slot=${index}]`),
  ];
  const bits = bitsRequired(palette.length);
  const cells = new Uint8Array(Math.ceil((SECTION_CELL_COUNT * bits) / 8));
  const index = cellIndex(0, 0, 0);
  writeCell(cells, bits, index, 1);
  const evidence: VoxelCellEvidenceSnapshot = {
    stateComplete: true,
    evidence: 'seen',
    observedAt,
    source: 'vision',
    sessionId: 's1',
    sequence: 1,
    revision: 1,
    freshness: 'FRESH',
    validUntil: observedAt + 60_000,
  };
  const bitmapBytes = SECTION_CELL_COUNT / 8;
  return {
    dim: DIM,
    cx: 0,
    cz: 0,
    sy: 0,
    palette,
    bits,
    cells,
    evidence: [{ index, evidence }],
    revision: 1,
    traversed: new Uint8Array(bitmapBytes),
    modified: new Uint8Array(bitmapBytes),
    risk: new Uint8Array(bitmapBytes),
  };
}

describe('bounded palette reclamation', () => {
  it('does not grow the palette when one coordinate churns through thousands of states', () => {
    const map = new VoxelMap(WORLD);
    const pos = { x: -1, y: -1, z: -1 };
    map.observe(obs({ pos, state: air, observedAt: 1_000, sequence: 1 }));
    expect(evidenceAt(map, -1, -1, -1).observation.state).toEqual(air);
    expect(map.cellAt(DIM, -2, -1, -1)).toEqual({ observed: false });

    for (let index = 0; index < 3_000; index++) {
      map.observe(
        obs({
          pos,
          observedAt: 1_001 + index,
          sequence: 2 + index,
          state: { name: 'minecraft:stone', properties: { variant: String(index) } },
        }),
      );
    }

    const section = map.sectionAt(DIM, -1, -1, -1)!;
    expect(section.palette[0]).toBe('minecraft:air');
    expect(section.palette.length).toBeLessThanOrEqual(2);
    expect(section.bits).toBe(1);
    expect(evidenceAt(map, -1, -1, -1).observation.state.properties.variant).toBe('2999');
    expect(evidenceAt(map, -1, -1, -1).observation.observedAt).toBe(4_000);
    // An unobserved neighbouring cell never becomes observed air.
    expect(map.cellAt(DIM, -2, -1, -1)).toEqual({ observed: false });
    expect(map.historyAt(DIM, -2, -1, -1).explored).toBe(false);
  });

  it('reclaims one large dead state at minimum width and keeps air refreshes scan-free', () => {
    const map = manualMap();
    const pos = { x: 0, y: 0, z: 0 };
    map.observe(
      obs({
        pos,
        state: { name: 'minecraft:stone', properties: { blob: 'x'.repeat(10_000) } },
        observedAt: 1_000,
        sequence: 1,
      }),
    );
    expect(sectionOf(map).palette.length).toBe(2);
    expect(sectionOf(map).bits).toBe(1);
    expect(sectionOf(map).palette[1]!.length).toBeGreaterThan(10_000);

    // The release leaves a dead string but the packing width cannot shrink from
    // 1 bit. The byte threshold still justifies the one bounded remap.
    map.observe(
      obs({
        pos,
        state: air,
        observedAt: 2_000,
        sequence: 2,
        originObservationId: 42,
        observedWorldTick: 99,
      }),
    );
    let section = sectionOf(map);
    expect(section.palette).toEqual(['minecraft:air']);
    expect(section.bits).toBe(1);
    expect(section.evidence.size).toBe(1);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(section));
    expect(evidenceAt(map, 0, 0, 0)).toMatchObject({
      observation: {
        state: air,
        observedAt: 2_000,
        originObservationId: 42,
        observedWorldTick: 99,
      },
    });
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });

    // Repeated air observations are pure refreshes: no palette write, no scan,
    // no resurrected large entry, and the evidence identity/time stays current.
    for (let index = 0; index < 5; index++) {
      map.observe(
        obs({
          pos,
          state: air,
          observedAt: 3_000 + index,
          sequence: 3 + index,
          originObservationId: 42,
          observedWorldTick: 100 + index,
        }),
      );
    }
    section = sectionOf(map);
    expect(section.palette).toEqual(['minecraft:air']);
    expect(section.bits).toBe(1);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(section));
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(3_004);
    expect(evidenceAt(map, 0, 0, 0).observation.originObservationId).toBe(42);
    expect(evidenceAt(map, 0, 0, 0).observation.observedWorldTick).toBe(104);
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
  });

  it('keeps every simultaneously referenced state while a single cell reuses its slot', () => {
    const map = new VoxelMap(WORLD);
    const states = Array.from({ length: 40 }, (_, index) => ({
      name: 'minecraft:stone',
      properties: { cell: String(index) },
    }));
    states.forEach((state, index) => {
      const pos = cellPos(index);
      map.observe(obs({ pos, state, observedAt: 1_000 + index, sequence: 1 + index }));
    });

    let section = sectionOf(map);
    expect(section.palette.length).toBe(41);
    expect(section.bits).toBe(bitsRequired(41));

    // Same-state refreshes keep the incremental fast path: no new entries.
    states.forEach((state, index) => {
      const pos = cellPos(index);
      map.observe(obs({ pos, state, observedAt: 5_000 + index, sequence: 100 + index }));
    });
    section = sectionOf(map);
    expect(section.palette.length).toBe(41);
    expect(section.bits).toBe(bitsRequired(41));

    for (let index = 0; index < 100; index++) {
      map.observe(
        obs({
          pos: cellPos(0),
          observedAt: 10_000 + index,
          sequence: 200 + index,
          state: { name: 'minecraft:stone', properties: { churn: String(index) } },
        }),
      );
    }
    section = sectionOf(map);
    expect(section.palette.length).toBe(41);
    expect(section.bits).toBe(bitsRequired(41));
    expect(evidenceAt(map, cellPos(0).x, 0, cellPos(0).z).observation.state.properties.churn).toBe('99');
    for (let index = 1; index < states.length; index++) {
      const pos = cellPos(index);
      expect(evidenceAt(map, pos.x, pos.y, pos.z).observation.state).toEqual(states[index]);
    }
  });

  it('does not copy a dense palette for a manual same-state refresh', () => {
    // Build the dense fixture eagerly, then install it into a manual map so the
    // refresh exercises the pre-flight path without paying 4096 inserts.
    const source = new VoxelMap(WORLD);
    const states = Array.from({ length: 4_096 }, (_, index) => ({
      name: 'minecraft:stone',
      properties: { cell: String(index) },
    }));
    states.forEach((state, index) => {
      source.observe(obs({ pos: cellPos(index), state, observedAt: 1_000 + index, sequence: 1 + index }));
    });
    expect(sectionOf(source).palette.length).toBe(4_097);
    expect(sectionOf(source).bits).toBe(bitsRequired(4_097));

    const map = new VoxelMap(WORLD, { manualResidency: true });
    map.installDirectory([]);
    map.beginSession('s1');
    map.installLoadedSections(source.checkpointSnapshot().sections);
    const bytesBefore = map.residentSize().bytes;

    // The loaded cell keeps its saved FRESH state; both observations are
    // same-state refreshes. Neither may touch the palette.
    map.observe(obs({ pos: cellPos(0), state: states[0], observedAt: 20_000, sequence: 10_000 }));
    map.observe(obs({ pos: cellPos(0), state: states[0], observedAt: 20_001, sequence: 10_001 }));

    expect(sectionOf(map).palette.length).toBe(4_097);
    expect(sectionOf(map).bits).toBe(bitsRequired(4_097));
    expect(map.residentSize().bytes).toBe(bytesBefore);
    expect(evidenceAt(map, cellPos(0).x, cellPos(0).y, cellPos(0).z).observation.observedAt).toBe(20_001);
  });

  it('applies batch order and ignores rejected input without perturbing palette accounting', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ observedAt: 1_000, sequence: 1 }));
    map.observeBatch({
      observations: Array.from({ length: 200 }, (_, index) =>
        obs({
          observedAt: 2_000 + index,
          sequence: 2 + index,
          state: { name: 'minecraft:stone', properties: { step: String(index) } },
        })),
      unobserved: [],
    });

    let section = sectionOf(map);
    expect(section.palette.length).toBeLessThanOrEqual(2);
    expect(section.bits).toBe(1);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(2_199);
    expect(evidenceAt(map, 0, 0, 0).observation.state.properties.step).toBe('199');

    const saveRevision = map.saveRevision;
    const paletteLength = sectionOf(map).palette.length;
    map.observeBatch({
      observations: [
        // Older acquisition is rejected despite arriving later.
        obs({ observedAt: 1, sequence: 500, state: dirt }),
        // Foreign session is rejected until beginSession.
        obs({ sessionId: 'foreign', observedAt: 9_999, sequence: 501, state: dirt }),
      ],
      unobserved: [],
    });
    expect(map.saveRevision).toBe(saveRevision);
    expect(sectionOf(map).palette.length).toBe(paletteLength);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(2_199);

    // A same-timestamp conflict only marks the old conclusion stale; the last
    // confirmed state (and its palette reference) stays.
    const conflict = map.observe(obs({ observedAt: 2_199, sequence: 502, state: dirt }));
    expect(conflict.sections[0]!.cells[0]!.kind).toBe('staled');
    expect(sectionOf(map).palette.length).toBe(paletteLength);
    expect(evidenceAt(map, 0, 0, 0).observation.state.properties.step).toBe('199');
  });
});

describe('palette reference sharing and remapping', () => {
  it('keeps a shared slot alive until its last referencing cell releases it', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ pos: { x: 0, y: 0, z: 0 }, state: stone, observedAt: 1_000, sequence: 1 }));
    map.observe(obs({ pos: { x: 1, y: 0, z: 0 }, state: stone, observedAt: 1_001, sequence: 2 }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:stone']);

    // One cell changes away, but the other still references stone.
    map.observe(obs({ pos: { x: 0, y: 0, z: 0 }, state: dirt, observedAt: 2_000, sequence: 3 }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:stone', 'minecraft:dirt']);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(dirt);
    expect(evidenceAt(map, 1, 0, 0).observation.state).toEqual(stone);

    // Releasing the last stone reference allows the width to shrink.
    map.observe(obs({ pos: { x: 1, y: 0, z: 0 }, state: air, observedAt: 3_000, sequence: 4 }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:dirt']);
    expect(sectionOf(map).bits).toBe(1);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(dirt);
    expect(evidenceAt(map, 1, 0, 0).observation.state).toEqual(air);
    expect(map.cellAt(DIM, 2, 0, 0)).toEqual({ observed: false });

    // The last non-air reference returning to air leaves only a bounded dead
    // string at minimum width (below the amortized reclamation threshold).
    map.observe(obs({ pos: { x: 0, y: 0, z: 0 }, state: air, observedAt: 4_000, sequence: 5 }));
    expect(sectionOf(map).palette.length).toBeLessThanOrEqual(2);
    expect(sectionOf(map).palette[0]).toBe('minecraft:air');
    expect(sectionOf(map).bits).toBe(1);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(air);
    expect(evidenceAt(map, 1, 0, 0).observation.state).toEqual(air);
  });

  it('remaps cross-byte palette indices while preserving surviving evidence', () => {
    const map = new VoxelMap(WORLD);
    const states = Array.from({ length: 300 }, (_, index) => ({
      name: 'minecraft:stone',
      properties: { cell: String(index) },
    }));
    states.forEach((state, index) => {
      map.observe(
        obs({
          pos: cellPos(index),
          state,
          observedAt: 1_000 + index,
          sequence: 1 + index,
          originObservationId: 7_000 + index,
        }),
      );
    });
    expect(sectionOf(map).palette.length).toBe(301); // palette values cross 8-bit bytes
    expect(sectionOf(map).bits).toBe(bitsRequired(301));

    const survivors = new Set([0, 100, 299]);
    const airObservations = states.flatMap((_, index) => {
      if (survivors.has(index)) return [];
      return [obs({ pos: cellPos(index), state: air, observedAt: 5_000 + index, sequence: 1_000 + index })];
    });
    map.observeBatch({ observations: airObservations, unobserved: [] });

    const section = sectionOf(map);
    expect(section.palette.length).toBe(4); // air + three survivors
    expect(section.bits).toBe(bitsRequired(4));
    expect(section.palette[0]).toBe('minecraft:air');
    expect(section.evidence.size).toBe(300);

    for (const index of survivors) {
      const pos = cellPos(index);
      const evidence = evidenceAt(map, pos.x, pos.y, pos.z);
      expect(evidence.observation.state).toEqual(states[index]);
      expect(evidence.observation.observedAt).toBe(1_000 + index);
      expect(evidence.observation.originObservationId).toBe(7_000 + index);
      expect(map.historyAt(DIM, pos.x, pos.y, pos.z).explored).toBe(true);
    }
    const changed = cellPos(1);
    expect(evidenceAt(map, changed.x, changed.y, changed.z).observation.state).toEqual(air);
    expect(evidenceAt(map, changed.x, changed.y, changed.z).observation.observedAt).toBe(5_001);
    expect(map.historyAt(DIM, changed.x, changed.y, changed.z).explored).toBe(true);

    const unknown = cellPos(300);
    expect(map.cellAt(DIM, unknown.x, unknown.y, unknown.z)).toEqual({ observed: false });
    expect(map.historyAt(DIM, unknown.x, unknown.y, unknown.z).explored).toBe(false);

    // Snapshot/restore reconstructs state from the remapped packed cell stream,
    // so surviving states, an observed air cell and an unknown neighbour are
    // verified independently of the live evidence objects.
    const restored = new VoxelMap(WORLD);
    restored.restoreSnapshot({
      worldId: WORLD,
      schemaVersion: VOXEL_SNAPSHOT_SCHEMA_VERSION,
      sections: map.checkpointSnapshot().sections,
    });
    const restoredSection = restored.sectionAt(DIM, 0, 0, 0)!;
    expect(restoredSection.palette.length).toBe(4);
    expect(restoredSection.bits).toBe(bitsRequired(4));
    for (const index of survivors) {
      const pos = cellPos(index);
      const evidence = evidenceAt(restored, pos.x, pos.y, pos.z);
      expect(evidence.observation.state).toEqual(states[index]);
      expect(evidence.observation.observedAt).toBe(1_000 + index);
      expect(evidence.observation.originObservationId).toBe(7_000 + index);
      expect(evidence.freshness).toBe('FRESH'); // a restore keeps the saved freshness
    }
    const restoredAir = cellPos(1);
    const airEvidence = evidenceAt(restored, restoredAir.x, restoredAir.y, restoredAir.z);
    expect(airEvidence.observation.state).toEqual(air);
    expect(airEvidence.observation.observedAt).toBe(5_001);
    const restoredUnknown = cellPos(300);
    expect(restored.cellAt(DIM, restoredUnknown.x, restoredUnknown.y, restoredUnknown.z)).toEqual({
      observed: false,
    });
  });

});

describe('capacity pre-flight uses the same reclamation rules', () => {
  it('accepts a full-capacity replacement that reuses its old slot', () => {
    const probe = manualMap();
    probe.observe(obs({ observedAt: 1_000 }));
    const capacity = probe.residentSize().bytes;

    const map = manualMap(capacity);
    map.observe(obs({ observedAt: 1_000 }));
    expect(map.residentSize().bytes).toBe(capacity);

    // `dirt` is shorter than `stone`; append-only accounting would still bill a
    // whole new entry and reject this replacement at exactly full capacity.
    map.observe(obs({ observedAt: 2_000, sequence: 2, state: dirt }));
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(dirt);
    expect(map.residentSize().bytes).toBeLessThanOrEqual(capacity);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(sectionOf(map)));
  });

  it('rejects a genuinely oversized replacement atomically', () => {
    const probe = manualMap();
    probe.observe(obs({ observedAt: 1_000 }));
    const capacity = probe.residentSize().bytes;

    const map = manualMap(capacity);
    map.observe(obs({ observedAt: 1_000 }));
    map.observe(obs({ observedAt: 2_000, sequence: 2, state: dirt }));
    const before = map.residentSize();
    const beforeSaveRevision = map.saveRevision;

    expect(() =>
      map.observe(
        obs({
          observedAt: 3_000,
          sequence: 3,
          state: { name: 'minecraft:stone', properties: { blob: 'x'.repeat(10_000) } },
        }),
      ),
    ).toThrow(/maxResidentBytes/);

    // The rejected write did not reach evidence, palette or accounting.
    expect(map.residentSize()).toEqual(before);
    expect(map.saveRevision).toBe(beforeSaveRevision);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(2_000);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(dirt);
    expect(sectionOf(map).palette.length).toBe(2);
  });

  it('rejects a batch whose intermediate state would exceed the resident cap', () => {
    const probe = manualMap();
    probe.observe(obs({ observedAt: 1_000 }));
    const capacity = probe.residentSize().bytes;

    const map = manualMap(capacity);
    map.observe(obs({ observedAt: 1_000 }));
    const before = map.residentSize();
    const beforeSaveRevision = map.saveRevision;

    // The final observation returns to the original state, but applying the
    // huge intermediate state is a real allocation; a final-net check would
    // wrongly accept it.
    expect(() =>
      map.observeBatch({
        observations: [
          obs({
            observedAt: 2_000,
            sequence: 2,
            state: { name: 'minecraft:stone', properties: { blob: 'x'.repeat(10_000) } },
          }),
          obs({ observedAt: 3_000, sequence: 3, state: stone }),
        ],
        unobserved: [],
      }),
    ).toThrow(/maxResidentBytes/);

    expect(map.residentSize()).toEqual(before);
    expect(map.saveRevision).toBe(beforeSaveRevision);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(1_000);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(stone);
    expect(sectionOf(map).palette.length).toBe(2);
  });
});

describe('loading and restoring palettes with unused entries', () => {
  it('restores a 202-entry palette, reclaims it on a real change, and round-trips', () => {
    const map = new VoxelMap(WORLD);
    map.restoreSnapshot({
      worldId: WORLD,
      schemaVersion: VOXEL_SNAPSHOT_SCHEMA_VERSION,
      sections: [snapshotWithUnusedPalette(1_234)],
    });

    expect(sectionOf(map).palette.length).toBe(202); // air + stone + 200 unused
    expect(sectionOf(map).bits).toBe(8);
    // Loading never rewrites the original observation identity or time.
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(1_234);
    expect(evidenceAt(map, 0, 0, 0).freshness).toBe('FRESH');

    // A real state change reclaims every unused entry and the released stone
    // slot because the live palette now fits a one-bit width.
    map.observe(obs({ observedAt: 2_000, sequence: 2, state: dirt }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:dirt']);
    expect(sectionOf(map).bits).toBe(1);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(2_000);

    // Returning to air releases dirt; its small dead entry stays within the
    // amortized reclamation bound, so the palette does not widen again.
    map.observe(obs({ observedAt: 3_000, sequence: 3, state: air }));
    const section = sectionOf(map);
    expect(section.palette.length).toBeLessThanOrEqual(2);
    expect(section.palette[0]).toBe('minecraft:air');
    expect(section.bits).toBe(1);
    expect(evidenceAt(map, 0, 0, 0).observation.state).toEqual(air);
    expect(section.evidence.size).toBe(1); // other cells remain unknown
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });

    // The reclaimed section is still a valid snapshot (no format migration).
    const roundTrip = new VoxelMap(WORLD);
    roundTrip.restoreSnapshot({
      worldId: WORLD,
      schemaVersion: VOXEL_SNAPSHOT_SCHEMA_VERSION,
      sections: map.checkpointSnapshot().sections,
    });
    expect(evidenceAt(roundTrip, 0, 0, 0).observation.observedAt).toBe(3_000);
    expect(evidenceAt(roundTrip, 0, 0, 0).observation.state).toEqual(air);
    expect(roundTrip.sectionAt(DIM, 0, 0, 0)!.palette).toEqual(section.palette);
  });

  it('installs a saved section with unused entries and keeps byte accounting and unload exact', () => {
    const map = new VoxelMap(WORLD, { manualResidency: true, now: () => 10_000 });
    map.installDirectory([
      { key: SECTION, seq: 0, bytes: 100, observedCells: 1, paletteEntries: 202, revision: 1 },
    ]);
    map.beginSession('s1');
    map.installLoadedSections([snapshotWithUnusedPalette(1_234)]);

    expect(map.residentSize().sections).toBe(1);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(sectionOf(map)));
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(1_234);

    map.observe(obs({ observedAt: 2_000, sequence: 2, state: dirt }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:dirt']);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(sectionOf(map)));

    map.observe(obs({ observedAt: 3_000, sequence: 3, state: air }));
    expect(sectionOf(map).palette.length).toBeLessThanOrEqual(2);
    expect(sectionOf(map).palette[0]).toBe('minecraft:air');
    expect(sectionOf(map).bits).toBe(1);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(sectionOf(map)));

    map.commitDirectory('full', map.captureDirtySections(), []);
    map.confirmSections(map.saveRevision);
    expect(map.unloadSections([SECTION]).unloaded).toEqual([SECTION]);
    expect(map.residentSize()).toEqual({ sections: 0, bytes: 0 });
  });
});

describe('checkpoint capture stays independent of later reclamation', () => {
  it('preserves captured evidence times and a late ACK does not clear newer changes', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ observedAt: 1_000, sequence: 1, state: stone }));

    const capturedRevision = map.saveRevision;
    const captured = map.captureDirtySections();
    expect(captured).toHaveLength(1);

    for (let index = 0; index < 200; index++) {
      map.observe(
        obs({
          observedAt: 2_000 + index,
          sequence: 2 + index,
          state: { name: 'minecraft:stone', properties: { churn: String(index) } },
        }),
      );
    }
    expect(sectionOf(map).palette.length).toBeLessThanOrEqual(2);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(2_199);

    // A late ACK for the old capture must not clear the newer accepted changes.
    map.confirmSections(capturedRevision);
    expect(map.captureDirtySections()).toHaveLength(1);

    // The already-captured snapshot keeps its original content; palette
    // reclamation of the live Section never reaches it.
    const capturedEvidence = captured[0]!.evidence[0]!.evidence;
    expect(capturedEvidence.observedAt).toBe(1_000);
    expect(captured[0]!.revision).toBe(1);

    const restored = new VoxelMap(WORLD);
    restored.restoreSnapshot({
      worldId: WORLD,
      schemaVersion: VOXEL_SNAPSHOT_SCHEMA_VERSION,
      sections: captured,
    });
    expect(evidenceAt(restored, 0, 0, 0).observation.observedAt).toBe(1_000);
    expect(evidenceAt(restored, 0, 0, 0).freshness).toBe('FRESH');
  });

  it('reuses freed slots across an unload/reload round trip', () => {
    const map = new VoxelMap(WORLD, { manualResidency: true, now: () => 10_000 });
    map.installDirectory([]);
    map.beginSession('s1');
    map.observe(obs({ observedAt: 1_000, state: stone }));
    map.commitDirectory('full', map.captureDirtySections(), []);
    map.confirmSections(map.saveRevision);
    expect(map.unloadSections([SECTION]).unloaded).toEqual([SECTION]);

    map.installLoadedSections([snapshotWithUnusedPalette(1_500)]);
    expect(evidenceAt(map, 0, 0, 0).observation.observedAt).toBe(1_500);
    map.observe(obs({ observedAt: 2_000, sequence: 2, state: dirt }));
    expect(sectionOf(map).palette).toEqual(['minecraft:air', 'minecraft:dirt']);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(sectionOf(map)));
  });
});
