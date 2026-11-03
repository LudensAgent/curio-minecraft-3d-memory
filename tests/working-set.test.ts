import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  LruOrder,
  RouteVerifier,
  WalkRouteExecutor,
  estimateVoxelSectionResidentBytesFromCommitted,
} from '../dist/index.js';
import type {
  BodySample,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Observation,
  SectionKey,
  Vec3Like,
  WalkRouteRequest,
} from '../dist/index.js';
import { openSpatialSession, WorkingSetManager } from '../dist/storage/sqlite/index.js';
import type { OpenSpatialSessionOptions, WorkingSetLimits } from '../dist/storage/sqlite/index.js';
import { bodyAt } from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };

function keyAt(cx: number, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

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
    pos: { x: 0, y: 64, z: 0 },
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-5d2-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** Seed `count` committed sections (one stone cell each at cx = 0..count-1, sy=4). */
async function seed(dbPath: string, count: number): Promise<void> {
  const s = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  s.voxel.beginSession('s1');
  for (let i = 0; i < count; i++) {
    s.voxel.observe(voxelObs({ pos: { x: i * 16, y: 64, z: 0 }, observedAt: 1000, sequence: i + 1 }));
  }
  await s.checkpoint();
  await s.close();
}

async function manualSession(
  dbPath: string,
  overrides: Partial<OpenSpatialSessionOptions> = {},
  workingSetLimits: WorkingSetLimits = {},
) {
  const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual', ...overrides });
  const manager = new WorkingSetManager(session, workingSetLimits);
  return { session, manager };
}

// ==============================================================================
// Pure LRU order
// ==============================================================================

describe('LruOrder', () => {
  it('evicts least-recently-used first and touches move to MRU', () => {
    const lru = new LruOrder();
    lru.insert('a');
    lru.insert('b');
    lru.insert('c');
    expect(lru.oldestFirst()).toEqual(['a', 'b', 'c']);

    lru.touch('a'); // a → MRU
    expect(lru.oldestFirst()).toEqual(['b', 'c', 'a']);

    lru.insert('b'); // move existing b to MRU
    expect(lru.oldestFirst()).toEqual(['c', 'a', 'b']);
  });

  it('touch is a no-op for unknown keys and remove drops only that key', () => {
    const lru = new LruOrder();
    lru.insert('a');
    lru.touch('zzz');
    expect(lru.oldestFirst()).toEqual(['a']);
    lru.remove('a');
    expect(lru.size).toBe(0);
    lru.remove('a'); // idempotent
  });
});

// ==============================================================================
// Pure estimator sanity
// ==============================================================================

describe('estimateVoxelSectionResidentBytesFromCommitted', () => {
  it('is a conservative upper bound of the actual resident bytes (real SQLite)', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);
    await manager.prepare([keyAt(0)]);
    const committed = session.sectionResidency(keyAt(0)).committed!;
    const actual = session.voxel.residentSize().bytes;
    expect(estimateVoxelSectionResidentBytesFromCommitted({ bytes: committed.bytes, observedCells: committed.observedCells })).toBeGreaterThanOrEqual(actual);
    await session.close();
  });
});

// ==============================================================================
// WorkingSetManager — real SQLite
// ==============================================================================

describe('WorkingSetManager', () => {
  it('rejects an eager session at construction', async () => {
    const dbPath = makeDbPath();
    const eager = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(() => new WorkingSetManager(eager)).toThrow(/manual/);
    await eager.close();
  });

  it('prepare dedupes, validates scope before any change, and leaves no partial state', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 2 } });
    const before = session.voxel.residentSize();

    await expect(manager.prepare([{ worldId: 'other', dim: DIM, cx: 0, cz: 0, sy: 4 }])).rejects.toThrow(/worldId/);
    expect(session.voxel.residentSize()).toEqual(before); // no eviction, no load
    expect(session.voxel.pinState()).toEqual({ leases: 0, pinnedSections: 0 }); // no leaked lease

    await session.close();
  });

  it('prepares, protects, and returns a lease; free cannot evict while pinned', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const a = keyAt(0);

    const result = await manager.prepare([a]);
    expect(result.prepared).toEqual([a]);
    expect(result.loaded).toEqual([a]);
    expect(result.capacity).toBeNull();
    expect(result.lease.token).not.toBe('');

    // Pinned: free cannot evict it.
    const freed = manager.free();
    expect(freed.evicted).toEqual([]);
    expect(freed.evictionRejected).toEqual([expect.objectContaining({ reason: 'pinned' })]);

    session.releasePins([result.lease.token]);
    expect(manager.free().evicted).toEqual([a]);
    await session.close();
  });

  it('evicts LRU-eligible sections to make room, and a hit changes the victim', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 3);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 2 } });

    const l0 = await manager.prepare([keyAt(0)]);
    const l1 = await manager.prepare([keyAt(1)]); // resident: 0, 1 (0 oldest)
    session.releasePins([l0.lease.token, l1.lease.token]);

    await manager.prepare([keyAt(0)]); // touch 0 → 1 becomes oldest
    const third = await manager.prepare([keyAt(2)]); // must evict 1, not 0
    expect(third.evicted).toEqual([keyAt(1)]);
    expect(third.loaded).toEqual([keyAt(2)]);
    expect(session.sectionResidency(keyAt(0)).residency).toBe('resident');
    expect(session.sectionResidency(keyAt(1)).residency).toBe('not_resident');
    await session.close();
  });

  it('never evicts the request set itself', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 3);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 2 } });

    const l0 = await manager.prepare([keyAt(0)]);
    session.releasePins([l0.lease.token]);
    const r = await manager.prepare([keyAt(1), keyAt(2)]); // request {1,2} must load; only 0 is evictable
    expect(r.evicted).toEqual([keyAt(0)]);
    expect(r.loaded).toEqual([keyAt(1), keyAt(2)]);
    expect(session.sectionResidency(keyAt(1)).residency).toBe('resident');
    expect(session.sectionResidency(keyAt(2)).residency).toBe('resident');
    await session.close();
  });

  it('reports dirty, pinned and uncommitted candidates as structured rejections', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    // dirty: observe into a resident committed section, then prepare forces eviction.
    const dirty = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const dl = await dirty.manager.prepare([keyAt(0)]);
    dirty.session.releasePins([dl.lease.token]);
    dirty.session.voxel.beginSession('live');
    dirty.session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:dirt', properties: {} }, pos: { x: 0, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));
    const d = await dirty.manager.prepare([keyAt(1)]);
    expect(d.evictionRejected).toEqual([expect.objectContaining({ key: keyAt(0), reason: 'dirty' })]);
    expect(d.capacity?.kind).toBe('count_capacity');
    await dirty.session.close();

    // uncommitted: a brand-new observed section cannot be evicted.
    const uncommitted = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    uncommitted.session.voxel.beginSession('live');
    uncommitted.session.voxel.observe(voxelObs({ sessionId: 'live', pos: { x: 900, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));
    const u = await uncommitted.manager.prepare([keyAt(0)]);
    expect(u.evictionRejected).toContainEqual(expect.objectContaining({ reason: 'not_committed' }));
    expect(u.capacity?.kind).toBe('count_capacity');
    await uncommitted.session.close();
  });

  it('count budget sufficient but byte budget insufficient → byte_capacity', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath, {
      residencyLimits: { maxResidentSections: 100, maxResidentBytes: 10 },
    });
    const r = await manager.prepare([keyAt(0)]);
    expect(r.capacity?.kind).toBe('byte_capacity');
    expect(r.loaded).toEqual([]);
    expect(session.sectionResidency(keyAt(0)).residency).toBe('load_failed');
    await session.close();
  });

  it('byte budget sufficient but count budget insufficient → count_capacity', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const r = await manager.prepare([keyAt(0), keyAt(1)]);
    expect(r.capacity?.kind).toBe('count_capacity');
    expect(r.loaded).toEqual([]);
    await session.close();
  });

  it('reports request_too_large before any mutation', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 3);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxLoadBatchSections: 2 } });
    const r = await manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    expect(r.capacity?.kind).toBe('request_too_large');
    expect(r.loaded).toEqual([]);
    expect(r.evicted).toEqual([]);
    expect(session.voxel.pinState().leases).toBe(0); // no temp lease leaked
    await session.close();
  });

  it('reports candidate_budget_exhausted when every candidate is dirty', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 6);
    const { session, manager } = await manualSession(
      dbPath,
      { residencyLimits: { maxResidentSections: 5 } },
      { maxEvictionCandidates: 3 },
    );
    // Load 5, then dirty all of them so none is evictable; a 6th committed section forces eviction.
    await manager.prepare([keyAt(0), keyAt(1), keyAt(2), keyAt(3), keyAt(4)]);
    session.voxel.beginSession('live');
    for (let i = 0; i < 5; i++) {
      session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:dirt', properties: {} }, pos: { x: i * 16, y: 64, z: 0 }, observedAt: 2000, sequence: i + 1 }));
    }
    const r = await manager.prepare([keyAt(5)]);
    expect(r.capacity?.kind).toBe('candidate_budget_exhausted');
    await session.close();
  });

  it('distinguishes no_record from read_failed and notReady', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);

    // no_record: a section that was never committed.
    const s1 = await manualSession(dbPath);
    const noRecord = await s1.manager.prepare([keyAt(99)]);
    expect(noRecord.noRecord).toEqual([keyAt(99)]);
    expect(noRecord.prepared).toEqual([]);
    await s1.session.close();

    // read_failed: corrupt the committed payload, then prepare → read_failed.
    const db = new Database(dbPath);
    db.prepare("UPDATE spatial_sections SET payload = 'corrupt' WHERE world_id = ?").run(WORLD);
    db.close();
    const s2 = await manualSession(dbPath);
    const readFailed = await s2.manager.prepare([keyAt(0)]);
    expect(readFailed.capacity?.kind).toBe('read_failed');
    expect(s2.session.sectionResidency(keyAt(0)).residency).toBe('load_failed');
    await s2.session.close();
  });

  it('stats and read-only queries do not load, evict, save or scan', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath);

    const stats = manager.stats();
    expect(stats.residentSections).toBe(0);
    expect(session.sectionResidency(keyAt(0)).residency).toBe('not_resident'); // still not loaded
    expect(session.voxel.cellAt(DIM, 0, 64, 0)).toEqual({ observed: false });
    await session.close();
  });

  it('stays consistent after a direct loadSections bypasses the manager', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });

    await session.loadSections([keyAt(0)]); // direct call, manager unaware
    expect(manager.stats().lruTracked).toBe(1); // reconciled

    const r = await manager.prepare([keyAt(1)]); // must evict the directly-loaded section
    expect(r.evicted).toEqual([keyAt(0)]);
    expect(r.loaded).toEqual([keyAt(1)]);
    await session.close();
  });

  it('rejects a prepare while a checkpoint is in flight (gate before any eviction)', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath);
    const l = await manager.prepare([keyAt(0)]);
    session.releasePins([l.lease.token]);
    const p = session.checkpoint();
    await expect(manager.prepare([keyAt(1)])).rejects.toMatchObject({ kind: 'busy' });
    // Nothing was evicted before the gate rejected the request.
    expect(session.sectionResidency(keyAt(0)).residency).toBe('resident');
    await p;
    await session.close();
  });

  it('a checkpoint ACK does not clear changes re-dirtied during the save', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath);
    await manager.prepare([keyAt(0)]);
    session.voxel.beginSession('live');
    session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:dirt', properties: {} }, pos: { x: 0, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));
    const p = session.checkpoint();
    // Re-dirty during the in-flight save.
    session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:stone', properties: {} }, pos: { x: 0, y: 64, z: 0 }, observedAt: 3000, sequence: 2 }));
    await p;
    expect(session.getPersistenceState().dirty).toBe(true); // second change still unconfirmed
    await session.close();
  });

  it('free then re-observe works after a new-section capacity rejection', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const l = await manager.prepare([keyAt(0)]);
    session.releasePins([l.lease.token]);

    session.voxel.beginSession('live');
    expect(() =>
      session.voxel.observe(voxelObs({ sessionId: 'live', pos: { x: 900, y: 64, z: 0 }, observedAt: 2000, sequence: 1 })),
    ).toThrow(/maxResidentSections/);

    manager.free(); // evict the committed section
    session.voxel.observe(voxelObs({ sessionId: 'live', pos: { x: 900, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));
    expect(session.voxel.cellAt(DIM, 900, 64, 0).observed).toBe(true);
    await session.close();
  });

  it('long loop over a larger saved set leaves no drift in sections, bytes, pins or index', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 8);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 3 } });

    for (let round = 0; round < 12; round++) {
      const i = round % 8;
      const r = await manager.prepare([keyAt(i), keyAt((i + 1) % 8)]); // each prepare may evict
      session.releasePins([r.lease.token]); // the caller releases on completion
    }
    manager.free(); // release everything eligible
    const stats = manager.stats();
    expect(stats.residentSections).toBe(0);
    expect(stats.residentBytes).toBe(0);
    expect(stats.lruTracked).toBe(0);
    expect(session.voxel.pinState()).toEqual({ leases: 0, pinnedSections: 0 });
    await session.close();
  });

  it('rejects prepare and free after the session is closed', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath);
    await session.close();
    await expect(manager.prepare([keyAt(0)])).rejects.toMatchObject({ kind: 'closed' });
    expect(() => manager.free()).toThrow(/closed/);
  });

  it('rejects free while a checkpoint is in flight', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath);
    const l = await manager.prepare([keyAt(0)]);
    session.releasePins([l.lease.token]);
    const p = session.checkpoint();
    expect(() => manager.free()).toThrow(/in flight/);
    await p;
    await session.close();
  });

  it('a capacity-failed prepare leaves no protection (prepared empty, no pin)', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const l = await manager.prepare([keyAt(0)]);
    session.releasePins([l.lease.token]);

    const r = await manager.prepare([keyAt(0), keyAt(1)]); // needs 2, capacity 1
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('count_capacity');
    expect(r.prepared).toEqual([]); // A is NOT listed as prepared
    expect(r.lease.token).toBe(''); // no lease handed out
    expect(session.voxel.pinState().pinnedSections).toBe(0); // A is not protected
    expect(manager.free().evicted).toEqual([keyAt(0)]); // A can be evicted now
    await session.close();
  });

  it('a no-record request is incomplete, not ready, with no lease', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session, manager } = await manualSession(dbPath);
    const r = await manager.prepare([keyAt(0), keyAt(99)]); // keyAt(99) has no record
    expect(r.status).toBe('incomplete');
    expect(r.capacity).toBeNull();
    expect(r.noRecord).toEqual([keyAt(99)]);
    expect(r.prepared).toEqual([]);
    expect(r.lease.token).toBe('');
    expect(session.voxel.pinState().pinnedSections).toBe(0);
    await session.close();
  });

  it('enforces maxUnloadSections before the next unload (free)', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 3);
    const { session, manager } = await manualSession(
      dbPath,
      { residencyLimits: { maxResidentSections: 3 } },
      { maxUnloadSections: 1 },
    );
    const r = await manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    session.releasePins([r.lease.token]);
    const freed = manager.free();
    expect(freed.evicted).toHaveLength(1); // exactly the budget, never one over
    expect(freed.capacity?.kind).toBe('unload_budget_exhausted');
    await session.close();
  });

  it('rejects an obviously-unfittable request before evicting existing sections', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 5);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 2 } });
    const l = await manager.prepare([keyAt(0), keyAt(1)]);
    session.releasePins([l.lease.token]);

    const r = await manager.prepare([keyAt(2), keyAt(3), keyAt(4)]); // 3 > 2 → impossible
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('count_capacity');
    expect(r.evicted).toEqual([]); // existing 0,1 were NOT evicted
    expect(session.sectionResidency(keyAt(0)).residency).toBe('resident');
    expect(session.sectionResidency(keyAt(1)).residency).toBe('resident');
    await session.close();
  });

  it('does not treat the conservative byte estimate as authoritative', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);

    // Measure the actual resident bytes and the conservative planning estimate.
    const probe = await manualSession(dbPath);
    const pl = await probe.manager.prepare([keyAt(0)]);
    const actualBytes = probe.session.voxel.residentSize().bytes;
    const committed = probe.session.sectionResidency(keyAt(0)).committed!;
    const estimate = estimateVoxelSectionResidentBytesFromCommitted({ bytes: committed.bytes, observedCells: committed.observedCells });
    expect(estimate).toBeGreaterThan(actualBytes); // the estimate over-states the cost
    await probe.session.close();

    // A budget equal to the ACTUAL cost must accept the request, even though the
    // conservative estimate exceeds it.
    const { session, manager } = await manualSession(dbPath, {
      residencyLimits: { maxResidentSections: 100, maxResidentBytes: actualBytes },
    });
    const r = await manager.prepare([keyAt(0)]);
    expect(r.status).toBe('ready');
    expect(r.capacity).toBeNull();
    await session.close();
  });

  it('rejects a negative free target before any unload', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 3);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 3 } });
    const r = await manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    session.releasePins([r.lease.token]);

    expect(() => manager.free({ sections: -1 })).toThrow(/non-negative/);
    expect(() => manager.free({ bytes: -1 })).toThrow(/non-negative/);
    expect(session.voxel.residentSize().sections).toBe(3); // nothing unloaded
    await session.close();
  });

  it('visits each candidate once: no duplicate eviction rejections', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 4);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 4 } });
    const r = await manager.prepare([keyAt(0), keyAt(1), keyAt(2), keyAt(3)]);
    session.releasePins([r.lease.token]);
    session.voxel.beginSession('live');
    for (let i = 0; i < 4; i++) {
      session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:dirt', properties: {} }, pos: { x: i * 16, y: 64, z: 0 }, observedAt: 2000, sequence: i + 1 }));
    }
    const freed = manager.free({ sections: 0 }); // all 4 dirty → all rejected
    const keys = freed.evictionRejected.map((e) => e.key.cx);
    expect(new Set(keys).size).toBe(4); // each candidate rejected exactly once
    expect(freed.capacity?.kind).toBe('no_eligible_candidates');
    await session.close();
  });

  it('fits a request at the exact byte boundary using the measured cost, not the estimate', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 4);

    // Measure the exact resident cost of three sections.
    const probe = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 4 } });
    const pl = await probe.manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    const threeBytes = probe.session.voxel.residentSize().bytes;
    await probe.session.close();

    // Reopen: three sections fill the budget exactly; a 4th needs exactly one eviction.
    const { session, manager } = await manualSession(
      dbPath,
      { residencyLimits: { maxResidentSections: 4, maxResidentBytes: threeBytes } },
      { maxUnloadSections: 1 },
    );
    const a = await manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    session.releasePins([a.lease.token]);

    const r = await manager.prepare([keyAt(3)]); // must evict exactly 1 to fit
    expect(r.status).toBe('ready');
    expect(r.capacity).toBeNull();
    expect(r.evicted).toHaveLength(1);
    expect(r.loaded).toEqual([keyAt(3)]);
    expect(session.voxel.residentSize().sections).toBe(3);
    expect(session.voxel.residentSize().bytes).toBeLessThanOrEqual(threeBytes);
    await session.close();
  });

  it('rejects a request whose resident + to-load exceeds capacity before evicting', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 5);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 2 } });
    // A (keyAt 0) and Z (keyAt 4) resident.
    const l = await manager.prepare([keyAt(0), keyAt(4)]);
    session.releasePins([l.lease.token]);

    // Request A, B, C: A already resident, B/C to load → needs 3 sections > 2.
    const r = await manager.prepare([keyAt(0), keyAt(1), keyAt(2)]);
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('count_capacity');
    expect(r.evicted).toEqual([]); // Z was NOT evicted
    expect(session.sectionResidency(keyAt(4)).residency).toBe('resident');
    await session.close();
  });

  it('shares the operation gate across managers and direct checkpoint', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const m1 = new WorkingSetManager(session);
    const m2 = new WorkingSetManager(session);

    // m1.prepare holds the session-wide gate across its async measure.
    const pending = m1.prepare([keyAt(1)]);
    expect(() => m2.free()).toThrow(/in flight/);
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'busy' });
    await pending;
    await session.close();
  });

  it('classifies a load-time count overflow as count_capacity, not byte_capacity', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });

    // Start loading keyAt(0); while its measure awaits the worker, add a new section.
    const pending = manager.prepare([keyAt(0)]);
    session.voxel.beginSession('live');
    session.voxel.observe(voxelObs({ sessionId: 'live', pos: { x: 900, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));

    const r = await pending;
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('count_capacity'); // not byte_capacity
    await session.close();
  });

  it('rejects a request that cannot fit before evicting the existing cache', async () => {
    const dbPath = makeDbPath();
    // Seed A (1 cell, cx 0) and B (4 cells, cx 1).
    const setup = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    setup.voxel.beginSession('s1');
    setup.voxel.observe(voxelObs({ pos: { x: 0, y: 64, z: 0 } }));
    for (let i = 0; i < 4; i++) {
      setup.voxel.observe(voxelObs({ pos: { x: 16, y: 64, z: i }, observedAt: 1000, sequence: 2 + i }));
    }
    await setup.checkpoint();
    await setup.close();

    // Measure A's exact resident bytes to set a budget A fits but B (4 cells) does not.
    const probe = await manualSession(dbPath);
    const pa = await probe.manager.prepare([keyAt(0)]);
    const aBytes = probe.session.voxel.residentSize().bytes;
    await probe.session.close();

    const { session, manager } = await manualSession(dbPath, {
      residencyLimits: { maxResidentSections: 10, maxResidentBytes: aBytes },
    });
    const la = await manager.prepare([keyAt(0)]);
    session.releasePins([la.lease.token]);

    const r = await manager.prepare([keyAt(1)]); // B's measured cost (4 cells) exceeds the budget
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('byte_capacity');
    expect(r.evicted).toEqual([]); // A was NOT evicted
    expect(session.sectionResidency(keyAt(0)).residency).toBe('resident');
    await session.close();
  });

  it('installSections rejects a stale snapshot and a closed session', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });

    // Measure A (revision 1, stone@1000), install it, then advance and commit dirt@2000.
    const measured = await session.measureSections([keyAt(0)]);
    session.installSections(measured.sections);
    session.voxel.beginSession('live');
    session.voxel.observe(voxelObs({ sessionId: 'live', state: { name: 'minecraft:dirt', properties: {} }, pos: { x: 0, y: 64, z: 0 }, observedAt: 2000, sequence: 1 }));
    await session.checkpoint();
    session.unloadSections([keyAt(0)]);

    // The old snapshot (revision 1) no longer matches the committed revision (2).
    expect(() => session.installSections(measured.sections)).toThrow(/stale/);

    // Installing after close is rejected.
    await session.close();
    expect(() => session.installSections(measured.sections)).toThrow(/closed/);
  });

  it('close does not leave a fake loading state nor evict the existing cache', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 2);
    const { session, manager } = await manualSession(dbPath, { residencyLimits: { maxResidentSections: 1 } });
    const la = await manager.prepare([keyAt(0)]);
    session.releasePins([la.lease.token]);

    const pending = manager.prepare([keyAt(1)]); // measures B, awaits the worker
    await session.close(); // closes while prepare's measure is in flight

    const r = await pending;
    expect(r.status).toBe('failed');
    expect(r.capacity?.kind).toBe('closed');
    expect(session.sectionResidency(keyAt(0)).residency).toBe('resident'); // A was NOT evicted
    expect(session.sectionResidency(keyAt(1)).residency).toBe('load_failed'); // B not stuck 'loading'
  });

  it('residentBytesOf rejects a foreign-world key', async () => {
    const dbPath = makeDbPath();
    await seed(dbPath, 1);
    const { session } = await manualSession(dbPath);
    expect(() =>
      session.voxel.residentBytesOf([{ worldId: 'other-world', dim: DIM, cx: 0, cz: 0, sy: 4 }]),
    ).toThrow(/worldId/);
    await session.close();
  });
});

// ==============================================================================
// Working set + Fake route lifecycle (walk-route composition layer)
// ==============================================================================

/** Fake single-step executor whose move() resolves immediately at the target. */
class FakeMoveExecutor implements MoveExecutor {
  private seq = 1;
  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    return Promise.resolve({ sample: sampleAt(request.worldId, request.dim, request.sessionId, request.executionId, request.to, ++this.seq) });
  }
  stop(): void {}
}

/** Fake single-step executor whose move() hangs until the host resolves it — for mid-execution tests. */
class HangingExecutor implements MoveExecutor {
  private resolveMove: ((r: ExecutableMoveResult) => void) | null = null;
  private last: ExecutableMove | null = null;
  readonly stopped: string[] = [];

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.last = request;
    return new Promise((resolve) => {
      this.resolveMove = resolve;
    });
  }

  resolve(pos: Vec3Like): void {
    if (this.last === null || this.resolveMove === null) return;
    const request = this.last;
    this.last = null;
    this.resolveMove({ sample: sampleAt(request.worldId, request.dim, request.sessionId, request.executionId, pos, 999) });
    this.resolveMove = null;
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

function sampleAt(
  worldId: string,
  dim: string,
  sessionId: string,
  executionId: string,
  pos: Vec3Like,
  sequence: number,
): BodySample {
  return {
    worldId,
    dim,
    sessionId,
    executionId,
    sequence,
    pos: { ...pos },
    observedAt: 2000,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
  };
}

const provider: CollisionShapeProvider = {
  version: 'fake-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    if (state.name === 'minecraft:stone' || state.name === 'minecraft:dirt') {
      return { kind: 'shape', shape: { boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }] } };
    }
    return { kind: 'unsupported_shape', block: state.name, detail: `no rule for ${state.name}` };
  },
};

/** Seed support (sy=-1) and swept air (sy=0) for a short +X walk in one eager session. */
async function seedWalk(dbPath: string): Promise<void> {
  const s = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  s.voxel.beginSession('seed');
  for (let x = 0; x <= 3; x++) {
    s.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'seed', observedAt: 1000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x, y: -1, z: 0 } });
    s.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'seed', observedAt: 1000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 0, z: 0 } });
    s.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'seed', observedAt: 1000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 1, z: 0 } });
  }
  await s.checkpoint();
  await s.close();
}

describe('working-set + Fake walk-route lifecycle', () => {
  it('prepares dependencies, protects them through execution, and releases on completion', async () => {
    const dbPath = makeDbPath();
    await seedWalk(dbPath);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);

    const supportKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: -1 };
    const airKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

    // 1. Prepare the sections, then restore current evidence with fresh observations.
    const initial = await manager.prepare([supportKey, airKey]);
    session.releasePins([initial.lease.token]); // initial protection served its purpose
    session.voxel.beginSession('live');
    for (let x = 0; x <= 3; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 1, z: 0 } });
    }

    // 2. Verify the route and collect its actual dependency sections.
    const points: Vec3Like[] = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const verifier = new RouteVerifier(session.voxel, { now: () => 2000 });
    verifier.register({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: bodyAt(0.5, 0, 0.5), shapeProvider: provider, points });
    const verified = verifier.advance(10);
    expect(verified.verdict).toBe('OPEN');
    const deps: SectionKey[] = [];
    const seen = new Set<string>();
    for (const step of verified.steps) {
      if (step.kind !== 'verified') continue;
      for (const d of step.result.dependencies) {
        const s = `${d.key.dim}|${d.key.cx},${d.key.cz},${d.key.sy}`;
        if (!seen.has(s)) {
          seen.add(s);
          deps.push({ ...d.key });
        }
      }
    }
    expect(deps).toContainEqual(supportKey);

    // 3. Protect the actual dependencies (already resident) and execute.
    const lease = await manager.prepare(deps);
    expect(lease.lease.token).not.toBe('');
    const executor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(session.voxel, executor, { now: () => 2000 });
    const request: WalkRouteRequest = {
      worldId: WORLD,
      dim: DIM,
      sessionId: 'live',
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      points,
      arrival: { kind: 'exact' },
      shapeProvider: provider,
      deadlineMs: 100_000,
      timeoutMs: 10_000,
    };
    const started = loop.start(request);
    loop.onSample(sampleAt(WORLD, DIM, 'live', started.delegationId, points[0]!, 1));
    loop.advance(10);
    await Promise.resolve();
    loop.advance(10);
    await Promise.resolve();
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');

    // 4. Checkpoint first so the dependencies are CLEAN (committed): now the pin —
    // not the dirty state — is what blocks eviction.
    await session.checkpoint();
    expect(manager.free().evicted).toEqual([]); // clean but pinned → pin blocks

    // 5. Release → clean + unpinned → the dependencies are evictable.
    session.releasePins([lease.lease.token]);
    const freed = manager.free();
    expect(freed.evicted).toEqual(expect.arrayContaining([supportKey, airKey]));

    await session.close();
  });

  it('releases on cancel: a clean pinned dependency becomes evictable after release', async () => {
    const dbPath = makeDbPath();
    await seedWalk(dbPath);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);

    const supportKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: -1 };
    const airKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

    const initial = await manager.prepare([supportKey, airKey]);
    session.releasePins([initial.lease.token]);
    session.voxel.beginSession('live');
    for (let x = 0; x <= 1; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 1, z: 0 } });
    }
    await session.checkpoint(); // clean

    const lease = await manager.prepare([supportKey, airKey]); // already resident → pin
    expect(manager.free().evicted).toEqual([]); // clean but pinned

    // Task cancelled/replaced: the caller releases its own lease.
    session.releasePins([lease.lease.token]);
    expect(manager.free().evicted).toEqual(expect.arrayContaining([supportKey, airKey]));
    await session.close();
  });

  it('a late release of an old task does not drop a newer task protection', async () => {
    const dbPath = makeDbPath();
    await seedWalk(dbPath);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);

    const supportKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: -1 };
    const airKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

    const first = await manager.prepare([supportKey, airKey]);
    session.voxel.beginSession('live');
    session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x: 0, y: -1, z: 0 } });
    await session.checkpoint();
    session.releasePins([first.lease.token]);

    // A newer task pins the same dependencies.
    const second = await manager.prepare([supportKey, airKey]);
    // The old task's late release must not drop the newer task's protection.
    session.releasePins([first.lease.token]); // no-op: already released
    expect(manager.free().evicted).toEqual([]); // still pinned by the newer task

    session.releasePins([second.lease.token]);
    expect(manager.free().evicted).toEqual(expect.arrayContaining([supportKey, airKey]));
    await session.close();
  });

  it('protects clean deps under cache pressure during execution, then releases on cancel', async () => {
    const dbPath = makeDbPath();
    await seedWalk(dbPath);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);

    const supportKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: -1 };
    const airKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

    const initial = await manager.prepare([supportKey, airKey]);
    session.releasePins([initial.lease.token]);
    session.voxel.beginSession('live');
    for (let x = 0; x <= 1; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 1, z: 0 } });
    }
    await session.checkpoint(); // clean (committed) deps

    const points: Vec3Like[] = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ];
    const verifier = new RouteVerifier(session.voxel, { now: () => 2000 });
    verifier.register({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: bodyAt(0.5, 0, 0.5), shapeProvider: provider, points });
    const verified = verifier.advance(10);
    expect(verified.verdict).toBe('OPEN');
    const deps: SectionKey[] = [];
    const seenDeps = new Set<string>();
    for (const step of verified.steps) {
      if (step.kind !== 'verified') continue;
      for (const d of step.result.dependencies) {
        const s = `${d.key.dim}|${d.key.cx},${d.key.cz},${d.key.sy}`;
        if (!seenDeps.has(s)) {
          seenDeps.add(s);
          deps.push({ ...d.key });
        }
      }
    }

    const lease = await manager.prepare(deps); // pin the clean deps

    const executor = new HangingExecutor();
    const loop = new WalkRouteExecutor(session.voxel, executor, { now: () => 2000 });
    const started = loop.start({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: bodyAt(0.5, 0, 0.5), points, arrival: { kind: 'exact' }, shapeProvider: provider, deadlineMs: 100_000, timeoutMs: 10_000 });
    loop.onSample(sampleAt(WORLD, DIM, 'live', started.delegationId, points[0]!, 1));
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0); // move is in flight (hanging)

    // Cache pressure DURING execution: clean + pinned deps are not evicted.
    expect(manager.free().evicted).toEqual([]);

    // Cancel mid-execution.
    const cancelled = loop.cancel('user', 'test');
    expect(cancelled.outcome).toBe('CANCELLED');

    // Release → clean + unpinned deps become evictable.
    session.releasePins([lease.lease.token]);
    expect(manager.free().evicted).toEqual(expect.arrayContaining([supportKey, airKey]));
    await session.close();
  });

  it('a replaced task whose lease is released late does not drop the newer task protection', async () => {
    const dbPath = makeDbPath();
    await seedWalk(dbPath);
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    const manager = new WorkingSetManager(session);

    const supportKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: -1 };
    const airKey: SectionKey = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 0 };

    const initial = await manager.prepare([supportKey, airKey]);
    session.releasePins([initial.lease.token]);
    session.voxel.beginSession('live');
    for (let x = 0; x <= 1; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:air', properties: {} }, pos: { x, y: 1, z: 0 } });
    }
    await session.checkpoint();

    const points: Vec3Like[] = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ];

    // Task 1 pins the deps and starts a hanging execution on ONE loop.
    const first = await manager.prepare([supportKey, airKey]);
    const executor = new HangingExecutor();
    const loop = new WalkRouteExecutor(session.voxel, executor, { now: () => 2000 });
    const s1 = loop.start({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: bodyAt(0.5, 0, 0.5), points, arrival: { kind: 'exact' }, shapeProvider: provider, deadlineMs: 100_000, timeoutMs: 10_000 });
    loop.onSample(sampleAt(WORLD, DIM, 'live', s1.delegationId, points[0]!, 1));
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0); // task 1's move is actually in flight

    // Task 2 pins the same deps and replaces task 1 on the SAME loop.
    const second = await manager.prepare([supportKey, airKey]);
    const s2 = loop.start({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: bodyAt(0.5, 0, 0.5), points, arrival: { kind: 'exact' }, shapeProvider: provider, deadlineMs: 100_000, timeoutMs: 10_000 });
    // Replacement stops task 1's in-flight move and starts task 2's.
    expect(executor.stopped).toContain(`${s1.delegationId}-step-0`);
    loop.onSample(sampleAt(WORLD, DIM, 'live', s2.delegationId, points[0]!, 2));
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0); // task 2's move is now in flight

    // Task 1's late release must not drop task 2's protection.
    session.releasePins([first.lease.token]);
    expect(manager.free().evicted).toEqual([]);

    session.releasePins([second.lease.token]);
    expect(manager.free().evicted).toEqual(expect.arrayContaining([supportKey, airKey]));
    await session.close();
  });
});

// ==============================================================================
// v2 → v3 migration regressions (real SQLite)
// ==============================================================================

function voxelPayload(dim: string, cx: number, cz: number, sy: number): string {
  return JSON.stringify({
    v: 1,
    dim,
    cx,
    cz,
    sy,
    palette: ['minecraft:air', 'minecraft:stone'],
    bits: 1,
    cells: Buffer.alloc(Math.ceil((4096 * 1) / 8), 0).toString('base64'),
    evidence: [{ i: 0, e: { observation: { worldId: WORLD, dim, sessionId: 's', observedAt: 1, sequence: 1, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:stone', properties: {} }, pos: { x: cx * 16, y: sy * 16, z: 0 } }, revision: 1, freshness: 'FRESH', validUntil: 1 } }],
    revision: 1,
  });
}

/** Create a minimal v2 database with `count` committed sections (and one checkpoint row). */
function makeV2Db(dbPath: string, payloads: string[]): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE checkpoints (
      checkpoint_id TEXT PRIMARY KEY, world_id TEXT NOT NULL,
      fragment_revision INTEGER NOT NULL, topology_revision INTEGER NOT NULL,
      voxel_revision INTEGER NOT NULL DEFAULT 0, has_voxel INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL
    );
    CREATE INDEX checkpoints_world_seq ON checkpoints (world_id, seq);
    CREATE TABLE path_fragments (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE traversal_evidence (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE spatial_nodes (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE spatial_edges (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE spatial_sections (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2');
    INSERT INTO checkpoints (checkpoint_id, world_id, fragment_revision, topology_revision, voxel_revision, has_voxel, seq)
      VALUES ('cp1', '${WORLD}', 0, 0, 1, 1, 1);
  `);
  const insert = db.prepare('INSERT INTO spatial_sections (world_id, seq, id, payload) VALUES (?, ?, ?, ?)');
  payloads.forEach((payload, i) => {
    insert.run(WORLD, i, JSON.stringify([DIM, i, 0, 4]), payload);
  });
  db.close();
}

function sectionId(dim: string, cx: number, cz: number, sy: number): string {
  return JSON.stringify([dim, cx, cz, sy]);
}

function schemaVersion(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
  db.close();
  return row.value;
}

function spatialColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(spatial_sections)').all() as { name: string }[];
  db.close();
  return cols.map((c) => c.name);
}

describe('v2 → v3 migration (real SQLite)', () => {
  it('backfills across the 100-row metadata window', async () => {
    const dbPath = makeDbPath();
    // 130 sections span two 100-row windows, exercising the rowid cursor rollover.
    const payloads = Array.from({ length: 130 }, (_, i) => voxelPayload(DIM, i, 0, 4));
    makeV2Db(dbPath, payloads);

    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' });
    expect(schemaVersion(dbPath)).toBe('3');
    expect(spatialColumns(dbPath)).toEqual(expect.arrayContaining(['observed_cells', 'palette_entries', 'revision']));

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT observed_cells, palette_entries, revision FROM spatial_sections WHERE world_id = ? AND id = ?').get(WORLD, sectionId(DIM, 129, 0, 4)) as { observed_cells: number; palette_entries: number; revision: number };
    db.close();
    expect(row.observed_cells).toBe(1);
    expect(row.palette_entries).toBe(2);
    expect(row.revision).toBe(1);
    await session.close();
  });

  it('a later-batch backfill failure rolls the whole migration back to v2', async () => {
    const dbPath = makeDbPath();
    const payloads = Array.from({ length: 130 }, (_, i) => voxelPayload(DIM, i, 0, 4));
    payloads[120] = 'corrupt'; // a corrupt payload in the second 100-row window
    makeV2Db(dbPath, payloads);

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD, voxelLoading: 'manual' })).rejects.toThrow();

    // The failed transaction rolled back: still v2, no backfilled columns.
    expect(schemaVersion(dbPath)).toBe('2');
    expect(spatialColumns(dbPath)).not.toContain('observed_cells');
  });
});
