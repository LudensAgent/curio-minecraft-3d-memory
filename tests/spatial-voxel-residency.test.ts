import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  RouteVerifier,
  TraversabilityCache,
  VoxelMap,
  VoxelResidencyError,
} from '../src/index.js';
import type { CellView, Observation, SectionKey } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';
import { AIR, STONE, bodyAt, fakeProvider, obs, stepQuery } from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };

function voxelObs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
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

function sectionKey(dim: string, x: number, y: number, z: number): SectionKey {
  return {
    worldId: WORLD,
    dim,
    cx: Math.floor(x / 16),
    cz: Math.floor(z / 16),
    sy: Math.floor(y / 16),
  };
}

function evidence(
  map: { cellAt(dim: string, x: number, y: number, z: number): CellView },
  x: number,
  y: number,
  z: number,
  dim = DIM,
) {
  const view = map.cellAt(dim, x, y, z);
  if (!view.observed) throw new Error(`expected observed cell at ${x},${y},${z}`);
  return view.evidence;
}

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-5d1-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Pure VoxelMap residency (no SQLite)
// ==============================================================================

describe('VoxelMap manual residency (pure core)', () => {
  function manualMap(overrides: ConstructorParameters<typeof VoxelMap>[1] = {}) {
    return new VoxelMap(WORLD, { manualResidency: true, ...overrides });
  }

  function directoryEntry(dim: string, x: number, y: number, z: number, revision = 1) {
    const key = sectionKey(dim, x, y, z);
    return { key, seq: 0, bytes: 100, observedCells: 1, paletteEntries: 2, revision };
  }

  it('distinguishes no_record / not_resident / resident via sectionResidency', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);

    expect(map.sectionResidency(sectionKey(DIM, 0, 0, 0))).toMatchObject({ residency: 'not_resident' });
    expect(map.sectionResidency(sectionKey(DIM, 100, 0, 100))).toMatchObject({ residency: 'no_record' });
  });

  it('rejects a write to a saved-but-not-resident section and reports the keys', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');
    try {
      map.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
      expect.unreachable('observe should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoxelResidencyError);
      expect((err as VoxelResidencyError).keys).toEqual([sectionKey(DIM, 0, 0, 0)]);
    }
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
  });

  it('accepts a brand-new section and enforces the resident-section bound', () => {
    const map = manualMap({ residencyLimits: { maxResidentSections: 1 } });
    map.installDirectory([]);
    map.beginSession('s1');
    map.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } })); // new section A
    expect(() => map.observe(voxelObs({ pos: { x: 100, y: 0, z: 100 } }))).toThrow(/maxResidentSections/);
  });

  it('observeBatch rejects the whole batch before writing any new section', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');
    expect(() =>
      map.observeBatch({
        observations: [
          voxelObs({ pos: { x: 0, y: 0, z: 0 } }), // saved, not resident → requires load
          voxelObs({ pos: { x: 100, y: 0, z: 100 } }), // brand-new
        ],
        unobserved: [],
      }),
    ).toThrow(VoxelResidencyError);
    expect(map.cellAt(DIM, 100, 0, 100)).toEqual({ observed: false }); // no half-write
  });

  it('installLoadedSections installs atomically and never dirties or refreshes', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');
    const source = new VoxelMap(WORLD);
    source.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    const snapshot = source.checkpointSnapshot();

    const installed = map.installLoadedSections(snapshot.sections);
    expect(installed).toEqual([sectionKey(DIM, 0, 0, 0)]);
    expect(map.sectionResidency(sectionKey(DIM, 0, 0, 0)).residency).toBe('resident');
    expect(map.captureDirtySections()).toHaveLength(0); // load never dirties
    expect(map.checkpointDirtyMeasure().count).toBe(0);
    // Restored evidence is STALE, not a fresh/current observation.
    expect(evidence(map, 0, 0, 0).freshness).toBe('STALE');
  });

  it('unload refuses pinned, dirty and uncommitted sections with reasons', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');

    const source = new VoxelMap(WORLD);
    source.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    map.installLoadedSections(source.checkpointSnapshot().sections);

    const key = sectionKey(DIM, 0, 0, 0);
    const lease = map.pinSections([key]);
    expect(map.unloadSections([key]).rejected).toContainEqual(expect.objectContaining({ reason: 'pinned' }));
    map.releasePins([lease.token]);

    map.observe(voxelObs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    expect(map.unloadSections([key]).rejected).toContainEqual(expect.objectContaining({ reason: 'dirty' }));
    map.confirmSections(map.saveRevision);

    expect(map.unloadSections([key]).unloaded).toEqual([key]);
    expect(map.sectionResidency(key).residency).toBe('not_resident'); // directory kept, not no_record

    map.observe(voxelObs({ pos: { x: 100, y: 0, z: 100 }, observedAt: 3000, sequence: 3 }));
    expect(map.unloadSections([sectionKey(DIM, 100, 0, 100)]).rejected).toContainEqual(
      expect.objectContaining({ reason: 'not_committed' }),
    );
  });

  it('pin leases are independent and an old release never drops a new lease', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');
    const source = new VoxelMap(WORLD);
    source.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    map.installLoadedSections(source.checkpointSnapshot().sections);

    const key = sectionKey(DIM, 0, 0, 0);
    const a = map.pinSections([key]);
    const b = map.pinSections([key]);
    map.releasePins([a.token]);
    expect(map.unloadSections([key]).rejected).toContainEqual(expect.objectContaining({ reason: 'pinned' }));
    map.releasePins([a.token]); // duplicate release is a no-op
    expect(map.unloadSections([key]).rejected).toContainEqual(expect.objectContaining({ reason: 'pinned' }));
    map.releasePins([b.token]);
    expect(map.unloadSections([key]).unloaded).toEqual([key]);
  });

  it('checkpointFullCounts includes non-resident directory sections', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0), directoryEntry(DIM, 100, 0, 100)]);
    expect(map.checkpointFullCounts().sections).toBe(2);
    expect(map.checkpointCounts().sections).toBe(0); // resident-only
  });

  it('checkpointSnapshot refuses a partial-resident map', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    expect(() => map.checkpointSnapshot()).toThrow(/fully resident/);
  });

  it('installLoadedSections refuses to overwrite a resident section', () => {
    const map = manualMap();
    map.installDirectory([directoryEntry(DIM, 0, 0, 0)]);
    map.beginSession('s1');
    const source = new VoxelMap(WORLD);
    source.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    map.installLoadedSections(source.checkpointSnapshot().sections); // now resident

    const newer = new VoxelMap(WORLD);
    newer.observe(voxelObs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    expect(() => map.installLoadedSections(newer.checkpointSnapshot().sections)).toThrow(/already resident/);
    // The resident fact is not overwritten.
    expect(evidence(map, 0, 0, 0).observation.state).toEqual(stone);
  });

  it('pinSections rejects a key from another world before any state change', () => {
    const map = manualMap();
    map.installDirectory([]);
    expect(() => map.pinSections([{ worldId: 'other-world', dim: DIM, cx: 0, cz: 0, sy: 0 }])).toThrow(/worldId/);
    expect(map.unloadSections([sectionKey(DIM, 0, 0, 0)]).unloaded).toEqual([]);
  });

  it('markStale accounts for resident byte growth', () => {
    const map = manualMap();
    map.installDirectory([]);
    map.beginSession('s1');
    map.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    map.confirmSections(map.saveRevision);
    const before = map.residentSize().bytes;
    map.markStale(DIM, 'unloaded');
    expect(map.residentSize().bytes).toBeGreaterThan(before); // staleReason growth accounted
  });
});

// ==============================================================================
// Cache / route residency invalidation (pure core)
// ==============================================================================

describe('residency invalidation of derived conclusions', () => {
  function openMap() {
    const map = new VoxelMap('world');
    map.beginSession('s1');
    // A +X step from (0.5,0,0.5) is OPEN: support below both feet, air in the sweep.
    map.observe(obs(STONE, { x: 0, y: -1, z: 0 }));
    map.observe(obs(STONE, { x: 1, y: -1, z: 0 }));
    map.observe(obs(AIR, { x: 0, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: 0, y: 1, z: 0 }));
    map.observe(obs(AIR, { x: 1, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: 1, y: 1, z: 0 }));
    return map;
  }

  const supportKey: SectionKey = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: -1 };
  const unrelatedKey: SectionKey = { worldId: 'world', dim: 'overworld', cx: 9, cz: 9, sy: 9 };

  it('invalidateSections drops only entries depending on the given sections', () => {
    const map = openMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('OPEN');
    expect(cache.size).toBe(1);

    cache.invalidateSections([unrelatedKey]);
    expect(cache.size).toBe(1); // unrelated section untouched

    cache.invalidateSections([supportKey]);
    expect(cache.size).toBe(0); // dependent entry dropped
  });

  it('RouteVerifier.invalidateSections drops dependent step results only', () => {
    const map = openMap();
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      points: [
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0, z: 0.5 },
      ],
    });
    verifier.advance(2);
    expect(verifier.status()!.steps[0]!.kind).toBe('verified');

    verifier.invalidateSections([unrelatedKey]);
    expect(verifier.status()!.steps[0]!.kind).toBe('verified');

    verifier.invalidateSections([supportKey]);
    expect(verifier.status()!.steps[0]!.kind).toBe('pending');
  });

  // A manual-residency map whose +X step from (0.5,0,0.5) is OPEN: the support
  // section (sy=-1) is committed + clean, the swept air (sy=0) is resident FRESH.
  function openManualMap() {
    const map = new VoxelMap('world', { manualResidency: true });
    const supportKey: SectionKey = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: -1 };
    map.installDirectory([{ key: supportKey, seq: 0, bytes: 100, observedCells: 2, paletteEntries: 2, revision: 2 }]);
    map.beginSession('s1');
    const source = new VoxelMap('world');
    source.observe(obs(STONE, { x: 0, y: -1, z: 0 }));
    source.observe(obs(STONE, { x: 1, y: -1, z: 0 }));
    map.installLoadedSections(source.checkpointSnapshot().sections);
    map.observe(obs(STONE, { x: 0, y: -1, z: 0 }, { observedAt: 2000, sequence: 1 }));
    map.observe(obs(STONE, { x: 1, y: -1, z: 0 }, { observedAt: 2000, sequence: 2 }));
    map.observe(obs(AIR, { x: 0, y: 0, z: 0 }, { observedAt: 2000, sequence: 3 }));
    map.observe(obs(AIR, { x: 0, y: 1, z: 0 }, { observedAt: 2000, sequence: 4 }));
    map.observe(obs(AIR, { x: 1, y: 0, z: 0 }, { observedAt: 2000, sequence: 5 }));
    map.observe(obs(AIR, { x: 1, y: 1, z: 0 }, { observedAt: 2000, sequence: 6 }));
    map.confirmSections(map.saveRevision);
    return { map, supportKey };
  }

  function supportSnapshot() {
    const source = new VoxelMap('world');
    source.observe(obs(STONE, { x: 0, y: -1, z: 0 }));
    source.observe(obs(STONE, { x: 1, y: -1, z: 0 }));
    return source.checkpointSnapshot().sections;
  }

  it('cache auto-invalidates on unload and reload without an explicit call', () => {
    const { map, supportKey } = openManualMap();
    const cache = new TraversabilityCache(map, { now: () => 2000 });
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('OPEN');

    // Unload the support section: no explicit invalidateSections — the next get
    // re-evaluates (residency generation changed) and reads the support as missing.
    expect(map.unloadSections([supportKey]).unloaded).toEqual([supportKey]);
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('UNKNOWN');

    // Reload: the restored support is STALE, not stuck at the pre-load UNKNOWN.
    map.installLoadedSections(supportSnapshot());
    expect(cache.get(stepQuery(), fakeProvider).status).toBe('STALE');
  });

  it('RouteVerifier auto-invalidates a verified step when its section is unloaded', () => {
    const { map, supportKey } = openManualMap();
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      points: [
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0, z: 0.5 },
      ],
    });
    verifier.advance(2);
    expect(verifier.status()!.steps[0]!.kind).toBe('verified');

    map.unloadSections([supportKey]);
    expect(verifier.status()!.steps[0]!.kind).toBe('pending');
  });

  it('pins a route\'s actual dependency sections and releases them', () => {
    const { map, supportKey } = openManualMap();
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      points: [
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0, z: 0.5 },
      ],
    });
    verifier.advance(2);
    const step = verifier.status()!.steps[0]!;
    expect(step.kind).toBe('verified');
    const deps = step.kind === 'verified' ? step.result.dependencies.map((d) => ({ ...d.key })) : [];
    expect(deps).toContainEqual(supportKey); // the support section is a real dependency

    const lease = map.pinSections(deps);
    expect(map.unloadSections([supportKey]).rejected).toContainEqual(expect.objectContaining({ reason: 'pinned' }));
    map.releasePins([lease.token]);
    expect(map.unloadSections([supportKey]).unloaded).toEqual([supportKey]);
  });
});

// ==============================================================================
// SQLite manual-mode session (real worker + real SQLite + temp files)
// ==============================================================================

describe('SQLite manual voxel loading', () => {
  it('manual open reads only the directory; load restores original facts as STALE', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const key = sectionKey(DIM, 0, 0, 0);
    expect(s2.sectionResidency(key).residency).toBe('not_resident');
    expect(s2.voxel.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });

    const result = await s2.loadSections([key]);
    expect(result.loaded).toEqual([key]);
    expect(result.missing).toEqual([]);
    expect(s2.sectionResidency(key).residency).toBe('resident');

    const ev = evidence(s2.voxel, 0, 0, 0);
    expect(ev.observation.state).toEqual(stone);
    expect(ev.observation.observedAt).toBe(1000);
    expect(ev.observation.sessionId).toBe('s1');
    expect(ev.freshness).toBe('STALE');
    await s2.close();
  });

  it('loadSections reports missing keys and leaves the rest untouched', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const present = sectionKey(DIM, 0, 0, 0);
    const absent = sectionKey(DIM, 500, 0, 500);
    const result = await s2.loadSections([present, absent]);
    expect(result.loaded).toEqual([present]);
    expect(result.missing).toEqual([absent]);
    expect(s2.sectionResidency(absent).residency).toBe('no_record');
    await s2.close();
  });

  it('observe is rejected until the section is loaded, then re-submits with original time', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const key = sectionKey(DIM, 0, 0, 0);
    s2.voxel.beginSession('s2');
    expect(() =>
      s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 })),
    ).toThrow(/explicit load/);

    await s2.loadSections([key]);
    s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    const ev = evidence(s2.voxel, 0, 0, 0);
    expect(ev.observation.state).toEqual(dirt);
    expect(ev.observation.observedAt).toBe(2000); // original observation time, not load time
    await s2.close();
  });

  it('observe → checkpoint → unload → reload keeps every cell of the section', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 1, y: 0, z: 0 }, observedAt: 1000, sequence: 2 }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const key = sectionKey(DIM, 0, 0, 0);
    await s2.loadSections([key]);
    s2.voxel.beginSession('s2');
    s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    await s2.checkpoint();

    expect(s2.unloadSections([key]).unloaded).toEqual([key]);
    expect(s2.sectionResidency(key).residency).toBe('not_resident');

    await s2.loadSections([key]);
    expect(evidence(s2.voxel, 0, 0, 0).observation.state).toEqual(dirt);
    expect(evidence(s2.voxel, 1, 0, 0).observation.state).toEqual(stone); // sibling cell preserved
    expect(evidence(s2.voxel, 1, 0, 0).observation.observedAt).toBe(1000);
    await s2.close();
  });

  it('partial-resident incremental checkpoint does not delete unloaded records', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 })); // A (cx 0)
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 20, y: 0, z: 0 }, observedAt: 1000, sequence: 2 })); // B (cx 1)
    await s1.checkpoint();
    await s1.close();

    const before = sectionRows(dbPath);

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    await s2.loadSections([sectionKey(DIM, 0, 0, 0)]); // load A only
    s2.voxel.beginSession('s2');
    s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    await s2.checkpoint();
    await s2.close();

    const after = sectionRows(dbPath);
    expect(after.get(sectionId(DIM, 1, 0, 0))).toBe(before.get(sectionId(DIM, 1, 0, 0))); // B untouched
    expect(after.get(sectionId(DIM, 0, 0, 0))).not.toBe(before.get(sectionId(DIM, 0, 0, 0))); // A updated
  });

  it('a failed load reads as load_failed, never as no_record', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    // Corrupt the payload directly: the directory (metadata columns) is intact,
    // but decoding the payload will fail.
    const db = new Database(dbPath);
    db.prepare("UPDATE spatial_sections SET payload = 'corrupt' WHERE world_id = ?").run(WORLD);
    db.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const key = sectionKey(DIM, 0, 0, 0);
    await expect(s2.loadSections([key])).rejects.toMatchObject({ kind: 'data' });
    expect(s2.sectionResidency(key).residency).toBe('load_failed');
    s2.voxel.beginSession('s2');
    expect(() => s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 } }))).toThrow(
      /explicit load/,
    );
    await s2.close();
  });

  it('loadSections is busy while a checkpoint is in flight', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } })); // brand-new section (no baseline)
    const p = s1.checkpoint();
    await expect(s1.loadSections([sectionKey(DIM, 0, 0, 0)])).rejects.toMatchObject({ kind: 'busy' });
    await p;
    await s1.close();
  });

  it('negative coordinates and multiple dimensions load correctly in manual mode', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: -1, y: 5, z: -2 }, observedAt: 100 }));
    s1.voxel.observe(voxelObs({ state: stone, dim: 'the_nether', pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const k1 = sectionKey(DIM, -1, 5, -2);
    const k2 = sectionKey('the_nether', 0, 0, 0);
    await s2.loadSections([k1, k2]);
    expect(evidence(s2.voxel, -1, 5, -2).observation.state).toEqual(stone);
    expect(evidence(s2.voxel, 0, 0, 0, 'the_nether').observation.state).toEqual(stone);
    await s2.close();
  });

  it('reopens a manual-mode database with a saved baseline as dirty=false initially', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    expect(s2.getPersistenceState().dirty).toBe(false);
    await s2.close();
  });

  it('a confirmed checkpoint updates the directory so unload is safe (no longer not_committed)', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ pos: { x: 0, y: 0, z: 0 } })); // brand-new section, no baseline yet
    const key = sectionKey(DIM, 0, 0, 0);
    expect(s1.unloadSections([key]).rejected).toContainEqual(expect.objectContaining({ reason: 'not_committed' }));

    await s1.checkpoint(); // full baseline → committed
    expect(s1.sectionResidency(key).committed).toMatchObject({ observedCells: 1, paletteEntries: 2 });
    expect(s1.unloadSections([key]).unloaded).toEqual([key]);
    await s1.close();
  });

  it('an incremental checkpoint refreshes the committed metadata of a changed section', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(voxelObs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const key = sectionKey(DIM, 0, 0, 0);
    await s2.loadSections([key]);
    const committedBefore = s2.sectionResidency(key).committed;
    s2.voxel.beginSession('s2');
    s2.voxel.observe(voxelObs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    await s2.checkpoint();

    const committedAfter = s2.sectionResidency(key).committed!;
    expect(committedAfter.revision).toBeGreaterThan(committedBefore!.revision);
    expect(s2.unloadSections([key]).unloaded).toEqual([key]); // clean after checkpoint
    await s2.close();
  });
});

// --- SQLite test helpers -----------------------------------------------------

function sectionId(dim: string, cx: number, cz: number, sy: number): string {
  return JSON.stringify([dim, cx, cz, sy]);
}

function sectionRows(dbPath: string): Map<string, string> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, payload FROM spatial_sections WHERE world_id = ?').all(WORLD) as {
    id: string;
    payload: string;
  }[];
  db.close();
  return new Map(rows.map((r) => [r.id, r.payload]));
}
