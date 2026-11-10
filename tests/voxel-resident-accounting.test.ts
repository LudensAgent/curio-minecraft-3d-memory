import { describe, expect, it } from 'vitest';

import type { Observation } from '../src/observation/types.js';
import { estimateVoxelSectionResidentBytes } from '../src/voxel/snapshot.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';

const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 };

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: key.worldId,
    dim: key.dim,
    sessionId: 's1',
    observedAt: 1_000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: { name: 'minecraft:stone', properties: {} },
    pos: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function manualMap(maxResidentBytes?: number) {
  const map = new VoxelMap(key.worldId, {
    manualResidency: true,
    residencyLimits: { maxResidentBytes },
    now: () => 2_000,
  });
  map.installDirectory([]);
  map.beginSession('s1');
  return map;
}

describe('incremental resident accounting', () => {
  it('allows a full-capacity cell to refresh repeatedly without reserving another section', () => {
    const probe = manualMap();
    probe.observe(observation());
    const size = probe.residentSize();
    const map = manualMap(size.bytes);
    map.observe(observation());
    map.observeBatch({
      observations: Array.from({ length: 256 }, (_, index) => observation({ observedAt: 1_001 + index })),
      unobserved: [],
    });
    expect(map.residentSize()).toEqual(size);
    expect(map.cellAt(key.dim, 0, 0, 0)).toMatchObject({ evidence: { observation: { observedAt: 1_256 } } });
    expect(map.checkpointCounts()).toMatchObject({ sections: 1, observedCells: 1, paletteEntries: 2 });
  });

  it('ignores rejected observations when computing capacity and preserves batch atomicity', () => {
    const probe = manualMap();
    probe.observe(observation());
    const map = manualMap(probe.residentSize().bytes);
    map.observe(observation());
    const saveRevision = map.saveRevision;
    const largeState = { name: 'minecraft:stone', properties: { detail: 'x'.repeat(10_000) } };
    map.observeBatch({ observations: [
      observation({ observedAt: 999, state: largeState }),
      observation({ observedAt: 2_000, state: largeState, sessionId: 'foreign', pos: { x: 160, y: 0, z: 0 } }),
      observation(),
    ], unobserved: [] });
    expect(map.saveRevision).toBe(saveRevision);
    expect(map.residentSize()).toEqual(probe.residentSize());

    expect(() => map.observeBatch({ observations: [
      observation({ observedAt: 1_001 }),
      observation({ observedAt: 1_002, actionId: 'larger-metadata', evidence: 'confirmed_effect', source: 'agent_action' }),
    ], unobserved: [] })).toThrow(/maxResidentBytes/);
    expect(map.saveRevision).toBe(saveRevision);
    expect(map.cellAt(key.dim, 0, 0, 0)).toMatchObject({ evidence: { observation: { observedAt: 1_000 } } });
    map.observe(observation({ state: largeState }));
    expect(map.cellAt(key.dim, 0, 0, 0)).toMatchObject({ evidence: { freshness: 'STALE', staleReason: 'conflict' } });
    expect(map.residentSize()).toEqual(probe.residentSize());
  });

  it('counts one new section and one cell for a batch of repeated observations', () => {
    const probe = manualMap();
    probe.observe(observation());
    const map = manualMap(probe.residentSize().bytes);
    map.observeBatch({
      observations: Array.from({ length: 100 }, (_, index) => observation({ observedAt: 1_000 + index })),
      unobserved: [],
    });
    expect(map.residentSize()).toEqual(probe.residentSize());
    expect(map.checkpointCounts().observedCells).toBe(1);
  });

  it('reuses capacity released by smaller metadata before inserting another cell in the batch', () => {
    const initial = observation({ actionId: 'x'.repeat(4_096), source: 'agent_action', evidence: 'confirmed_effect' });
    const probe = manualMap();
    probe.observe(initial);
    const map = manualMap(probe.residentSize().bytes);
    map.observe(initial);
    map.observeBatch({ observations: [
      observation({ observedAt: 1_001 }),
      observation({ pos: { x: 1, y: 0, z: 0 }, observedAt: 1_002 }),
    ], unobserved: [] });
    expect(map.checkpointCounts().observedCells).toBe(2);
    expect(map.residentSize().bytes).toBeLessThan(probe.residentSize().bytes);
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(map.sectionAt(key.dim, 0, 0, 0)!));
  });

  it('matches section billing after palette growth, metadata changes and stale transitions', () => {
    const map = manualMap();
    map.markTraversed(key.dim, { x: 0, y: 0, z: 0 });
    const updates = Array.from({ length: 12 }, (_, index) => observation({
      pos: { x: index, y: 0, z: 0 },
      state: { name: 'minecraft:oak_log', properties: { sample: String(index) } },
      actionId: index % 2 === 0 ? `action-${index}` : undefined,
      evidence: index % 2 === 0 ? 'confirmed_effect' : 'seen',
      source: index % 2 === 0 ? 'agent_action' : 'vision',
    }));
    map.observeBatch({ observations: updates, unobserved: [] });
    map.observe(observation({ observedAt: 1_100, stateComplete: false, actionId: 'updated-action', evidence: 'confirmed_effect', source: 'agent_action' }));
    map.observe(observation({ observedAt: 1_100, state: { name: 'minecraft:dirt', properties: {} } }));
    map.markStale(key.dim, 'unloaded');
    map.beginSession('s2');
    map.observe(observation({ sessionId: 's2', observedAt: 2_001 }));
    const section = map.sectionAt(key.dim, 0, 0, 0)!;
    const bytes = estimateVoxelSectionResidentBytes(section);
    expect(map.residentSize()).toEqual({ sections: 1, bytes });
    expect(map.residentBytesOf([key])).toBe(bytes);
  });

  it('restores and unloads the exact billed amount after a palette change', () => {
    const source = manualMap();
    source.observe(observation());
    const snapshots = source.checkpointSnapshot().sections;
    const map = new VoxelMap(key.worldId, { manualResidency: true });
    map.installDirectory([{ key, seq: 0, bytes: 100, observedCells: 1, paletteEntries: 2, revision: 1 }]);
    map.installLoadedSections(snapshots);
    map.beginSession('s1');
    map.observe(observation({ observedAt: 2_000, state: { name: 'minecraft:dirt', properties: {} } }));
    expect(map.residentSize().bytes).toBe(estimateVoxelSectionResidentBytes(map.sectionAt(key.dim, 0, 0, 0)!));
    map.confirmSections(map.saveRevision);
    expect(map.unloadSections([key]).unloaded).toEqual([key]);
    expect(map.residentSize()).toEqual({ sections: 0, bytes: 0 });
  });

  it('initializes manual billing on full restore and rejects an oversized restore atomically', () => {
    const source = manualMap();
    source.observe(observation());
    const snapshot = source.checkpointSnapshot();
    const bytes = source.residentSize().bytes;
    const map = new VoxelMap(key.worldId, { manualResidency: true, residencyLimits: { maxResidentBytes: bytes } });
    map.restoreSnapshot(snapshot);
    map.installDirectory([{ key, seq: 0, bytes: 100, observedCells: 1, paletteEntries: 2, revision: 1 }]);
    map.observe(observation({ observedAt: 2_000 }));
    expect(map.residentSize()).toEqual({ sections: 1, bytes });
    expect(map.residentBytesOf([key])).toBe(bytes);
    map.confirmSections(map.saveRevision);
    map.unloadSections([key]);
    expect(map.residentSize()).toEqual({ sections: 0, bytes: 0 });

    const limited = new VoxelMap(key.worldId, { manualResidency: true, residencyLimits: { maxResidentBytes: bytes - 1 } });
    expect(() => limited.restoreSnapshot(snapshot)).toThrow(/maxResidentBytes/);
    expect(limited.residentSize()).toEqual({ sections: 0, bytes: 0 });
    expect(limited.cellAt(key.dim, 0, 0, 0)).toEqual({ observed: false });
    expect(limited.saveRevision).toBe(0);
  });
});
