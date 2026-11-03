import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { VoxelMap } from '../src/index.js';
import type { CellView, Observation, PathFragment } from '../src/index.js';
import { openHistorySession, openSpatialSession } from '../dist/storage/sqlite/index.js';
import { SNAPSHOT_FRAME_BYTES, VOXEL_FRAME_BYTES } from '../src/storage/sqlite/types.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };
const air = { name: 'minecraft:air', properties: {} };
const doorClosed = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'false' } };

function obs(overrides: Partial<Observation> = {}): Observation {
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

function frag(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'f1',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [{ x: 0.5, y: 64, z: 0.5 }],
    polyline: [
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
    ],
    geometrySource: 'traversal',
    deepestY: 12,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
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
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-5c-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

/** Stable on-disk id for one voxel section row. */
function sectionId(dim: string, cx: number, cz: number, sy: number): string {
  return JSON.stringify([dim, cx, cz, sy]);
}

/** Raw `spatial_sections` payloads keyed by section id, for write-scope assertions. */
function sectionRows(dbPath: string): Map<string, string> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, payload FROM spatial_sections WHERE world_id = ?').all(WORLD) as {
    id: string;
    payload: string;
  }[];
  db.close();
  return new Map(rows.map((r) => [r.id, r.payload]));
}

function voxelRowCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM spatial_sections WHERE world_id = ?').get(WORLD) as { n: number }).n;
  db.close();
  return n;
}

function octetLength(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true });
  const n = (
    db.prepare(`SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM ${table} WHERE world_id = ?`).get(WORLD) as {
      n: number;
    }
  ).n;
  db.close();
  return n;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Pure VoxelMap dirty-section tracking (no SQLite)
// ==============================================================================

describe('VoxelMap pending-section tracking', () => {
  it('captures only dirty sections and confirms exactly the captured revision', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // section A
    map.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } })); // section B

    expect(map.captureDirtySections().length).toBe(2);
    expect(map.checkpointDirtyMeasure().count).toBe(2);
    expect(map.checkpointCounts()).toMatchObject({ sections: 2, observedCells: 2, paletteEntries: 4 });

    map.confirmSections(map.saveRevision);
    expect(map.captureDirtySections().length).toBe(0);
    expect(map.checkpointDirtyMeasure().count).toBe(0);
  });

  it('a stale ACK does not clear a section re-dirtied after capture', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const capturedRevision = map.saveRevision; // 1

    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    map.confirmSections(capturedRevision); // late ACK for the earlier capture

    expect(map.captureDirtySections().length).toBe(1); // the dirt change stays pending
  });

  it('refresh-only updates are pending even though Section.revision does not advance', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.confirmSections(map.saveRevision);

    const sectionBefore = map.sectionAt(DIM, 0, 0, 0)!.revision;
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 })); // refresh
    const sectionAfter = map.sectionAt(DIM, 0, 0, 0)!.revision;
    expect(sectionAfter).toBe(sectionBefore); // refresh does not bump section revision
    expect(map.captureDirtySections().length).toBe(1); // but it is still pending
  });

  it('rejected, idempotent and read-only operations do not dirty a section', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.confirmSections(map.saveRevision);

    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // idempotent duplicate
    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 500, sequence: 2 })); // older
    map.cellAt(DIM, 0, 0, 0); // read-only
    map.checkpointCounts(); // read-only
    expect(map.captureDirtySections().length).toBe(0);
  });

  it('markStale dirties the affected sections', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.confirmSections(map.saveRevision);
    expect(map.captureDirtySections().length).toBe(0);

    map.markStale(DIM, 'unloaded');
    expect(map.captureDirtySections().length).toBe(1);
  });

  it('beginSession dirties the affected sections when it marks them stale', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // session s1, FRESH
    map.confirmSections(map.saveRevision);
    expect(map.captureDirtySections().length).toBe(0);

    map.beginSession('other-session'); // FRESH s1 cell → STALE
    expect(map.captureDirtySections().length).toBe(1);
  });
});

// ==============================================================================
// SQLite incremental checkpoint (real worker + real SQLite + temp files)
// ==============================================================================

describe('SQLite incremental voxel checkpoint', () => {
  it('first save establishes a full baseline; reopen fully recovers it', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    session.voxel.observe(obs({ state: air, pos: { x: 1, y: 0, z: 0 }, observedAt: 1000 }));
    session.voxel.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 }, observedAt: 1000 }));
    await session.checkpoint();
    expect(voxelRowCount(dbPath)).toBe(2); // two sections, full baseline
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.checkpointCounts()).toMatchObject({ sections: 2, observedCells: 3 });
    expect(evidence(reopened.voxel, 0, 0, 0).observation.state).toEqual(stone);
    expect(evidence(reopened.voxel, 1, 0, 0).observation.state.name).toBe('minecraft:air');
    expect(evidence(reopened.voxel, 20, 0, 0).observation.state).toEqual(dirt);
    await reopened.close();
  });

  it('updating one section only copies/encodes/writes that section, preserving the other', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 })); // section A (cx 0)
    s1.voxel.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 }, observedAt: 1000 })); // section B (cx 1)
    await s1.checkpoint();
    await s1.close();

    const before = sectionRows(dbPath);
    const bId = sectionId(DIM, 1, 0, 0);
    const bPayload = before.get(bId)!;

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s2.voxel.beginSession('s2');
    // Change only section A (same cell, new state).
    s2.voxel.observe(obs({ sessionId: 's2', state: doorClosed, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    await s2.checkpoint();
    await s2.close();

    const after = sectionRows(dbPath);
    expect(after.size).toBe(2); // no delete + re-insert-all
    expect(after.get(bId)).toBe(bPayload); // untouched section is byte-identical
    expect(after.get(sectionId(DIM, 0, 0, 0))).not.toBe(before.get(sectionId(DIM, 0, 0, 0))); // A changed

    const s3 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(s3.voxel, 0, 0, 0).observation.state).toEqual(doorClosed);
    expect(evidence(s3.voxel, 0, 0, 0).observation.observedAt).toBe(2000);
    expect(evidence(s3.voxel, 20, 0, 0).observation.state).toEqual(dirt); // B fact preserved
    expect(evidence(s3.voxel, 20, 0, 0).observation.observedAt).toBe(1000); // B original time preserved
    await s3.close();
  });

  it('same-state refresh enters the incremental save', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await s1.checkpoint();
    await s1.close();

    const before = sectionRows(dbPath).get(sectionId(DIM, 0, 0, 0))!;

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s2.voxel.beginSession('s2');
    s2.voxel.observe(obs({ sessionId: 's2', state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 5000, sequence: 1 }));
    await s2.checkpoint();
    await s2.close();

    const after = sectionRows(dbPath).get(sectionId(DIM, 0, 0, 0))!;
    expect(after).not.toBe(before); // the refresh was persisted
    const s3 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(s3.voxel, 0, 0, 0).observation.observedAt).toBe(5000);
    await s3.close();
  });

  it('persists property changes, observed air, negative coords and multiple dimensions', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: doorClosed, pos: { x: -1, y: 5, z: -2 }, observedAt: 100 }));
    session.voxel.observe(obs({ state: air, pos: { x: 0, y: 5, z: 0 }, observedAt: 100 }));
    session.voxel.observe(obs({ state: stone, dim: 'the_nether', pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(reopened.voxel, -1, 5, -2).observation.state).toEqual(doorClosed);
    expect(evidence(reopened.voxel, 0, 5, 0).observation.state.name).toBe('minecraft:air');
    expect(evidence(reopened.voxel, 0, 0, 0, 'the_nether').observation.state).toEqual(stone);
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    await reopened.close();
  });

  it('does not clear later changes when an older checkpoint is confirmed', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await session.checkpoint();

    // Same-section change during save.
    const p1 = session.checkpoint();
    session.voxel.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    await p1;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    expect(evidence(session.voxel, 0, 0, 0).observation.state).toEqual(dirt);

    // New section during save.
    const p2 = session.checkpoint();
    session.voxel.observe(obs({ state: stone, pos: { x: 20, y: 0, z: 0 }, observedAt: 3000, sequence: 3 }));
    await p2;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    expect(session.voxel.checkpointCounts().sections).toBe(2);

    // Refresh during save.
    const p3 = session.checkpoint();
    session.voxel.observe(obs({ state: stone, pos: { x: 20, y: 0, z: 0 }, observedAt: 4000, sequence: 4 }));
    await p3;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);

    // markStale during save.
    const p4 = session.checkpoint();
    session.voxel.markStale(DIM, 'unloaded');
    await p4;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);

    await session.close();
  });

  it('an empty increment is not a voxel clear', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const before = sectionRows(dbPath);
    expect(before.size).toBe(1);

    // Reopen and checkpoint with no voxel change (empty increment).
    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    await s2.checkpoint();
    await s2.close();

    const after = sectionRows(dbPath);
    expect(after.size).toBe(1);
    expect(after.get(sectionId(DIM, 0, 0, 0))).toBe(before.get(sectionId(DIM, 0, 0, 0)));
  });

  it('a history-only checkpoint never touches voxel rows', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    s1.history.saveFragment(frag());
    await s1.checkpoint();
    await s1.close();

    const voxelBefore = sectionRows(dbPath);

    const h = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    h.history.saveFragment(frag({ id: 'f2', kind: 'dug' }));
    await h.checkpoint();
    await h.close();

    expect(sectionRows(dbPath)).toEqual(voxelBefore); // voxel rows untouched

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(s2.history.getFragment('f2')).not.toBeNull(); // history still committed
    expect(evidence(s2.voxel, 0, 0, 0).freshness).toBe('STALE'); // voxel baseline intact
    await s2.close();
  });

  it('rolls back the whole batch on a SQL failure, preserving memory facts and dirty', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    // Inject a failure that aborts any future checkpoint row insert.
    const db = new Database(dbPath);
    db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    db.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s2.voxel.beginSession('s2');
    s2.voxel.observe(obs({ sessionId: 's2', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 1 }));
    await expect(s2.checkpoint()).rejects.toMatchObject({ kind: 'sql' });

    // Memory facts and dirty are preserved (not rolled back).
    expect(evidence(s2.voxel, 0, 0, 0).observation.state).toEqual(dirt);
    expect(s2.getPersistenceState().dirty).toBe(true);
    await s2.close();

    // The failed batch rolled back: the DB still has the stone baseline.
    const s3 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(s3.voxel, 0, 0, 0).observation.state).toEqual(stone);
    await s3.close();
  });

  it('rejects a second checkpoint while one is in flight (busy)', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const first = session.checkpoint();
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'busy' });
    await first;
    await session.close();
  });

  it('rejects an over-capacity incremental batch before copying', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes: 8192 } });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes: 8192 } });
    s2.voxel.beginSession('s2');
    const props: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) props[`p${i}`] = `value-${i}`;
    s2.voxel.observe(obs({ sessionId: 's2', state: { name: 'minecraft:stone', properties: props }, pos: { x: 100, y: 0, z: 0 } }));

    const copySpy = vi.spyOn(s2.voxel, 'captureDirtySections');
    await expect(s2.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    expect(copySpy).not.toHaveBeenCalled(); // rejected before the deep copy
    await s2.close();
  });

  it('rejects incremental growth that would exceed the full-set section limit', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxVoxelSections: 2 } });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxVoxelSections: 2 } });
    s2.voxel.beginSession('s2');
    s2.voxel.observe(obs({ sessionId: 's2', state: stone, pos: { x: 20, y: 0, z: 0 } }));
    await s2.checkpoint(); // 2 sections, still within limit
    s2.voxel.observe(obs({ sessionId: 's2', state: stone, pos: { x: 40, y: 0, z: 0 } }));
    await expect(s2.checkpoint()).rejects.toMatchObject({ kind: 'capacity' }); // 3 > 2
    await s2.close();

    // Still exactly two sections — the DB re-opens under the same limits.
    const s3 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxVoxelSections: 2 } });
    expect(s3.voxel.checkpointCounts().sections).toBe(2);
    await s3.close();
  });

  it('worker rejects when the post-increment full set exceeds maxBytes', async () => {
    const dbPath = makeDbPath();
    const state = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'false', facing: 'north', powered: 'false' } };
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state, pos: { x: 0, y: 0, z: 0 } }));
    await s1.checkpoint();
    await s1.close();

    const escapedWorldId = Buffer.byteLength(JSON.stringify(WORLD), 'utf8');
    const oneSectionBytes = octetLength(dbPath, 'spatial_sections');
    const historyBytes = SNAPSHOT_FRAME_BYTES + escapedWorldId; // empty history
    const oneSectionTotal = historyBytes + oneSectionBytes + VOXEL_FRAME_BYTES + escapedWorldId + 0;
    // Fits one section comfortably but cannot fit two of the same size.
    const maxBytes = oneSectionTotal + Math.floor(oneSectionBytes / 2);

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes } });
    s2.voxel.beginSession('s2');
    s2.voxel.observe(obs({ sessionId: 's2', state, pos: { x: 20, y: 0, z: 0 } }));
    // The batch (one section) fits, but the resulting full set (two sections) exceeds
    // maxBytes — the worker's post-increment check rejects before commit.
    await expect(s2.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    await s2.close();

    expect(voxelRowCount(dbPath)).toBe(1); // the failed increment was rolled back
  });
});
