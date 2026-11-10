import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { VoxelMap } from '../src/index.js';
import type { CellView, Observation } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-batch-backlog-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

/** Stable on-disk id for one voxel section row. */
function sectionId(dim: string, cx: number, cz: number, sy: number): string {
  return JSON.stringify([dim, cx, cz, sy]);
}

/** Raw `spatial_sections` payloads keyed by section id. */
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

/** Pending section/removal count. Bounded API rejects `Infinity`, so use a large finite cap. */
function pendingCount(map: { checkpointDirtyMeasureBounded(maxBytes: number): { count: number } }): number {
  return map.checkpointDirtyMeasureBounded(Number.MAX_SAFE_INTEGER).count;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Pure VoxelMap: bounded capture, late ACK and re-dirty/new-section interaction
// ==============================================================================

describe('VoxelMap bounded batch late ACK (pure core)', () => {
  it('a late ACK for a bounded batch leaves a re-dirtied section and a new section pending', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // cx 0
    map.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } })); // cx 1
    map.observe(obs({ state: air, pos: { x: 40, y: 0, z: 0 } })); // cx 2
    expect(pendingCount(map)).toBe(3);

    // The cap selects exactly the first dirty section (cx 0).
    const batch = map.captureDirtySectionsBounded(1);
    expect(batch.sections).toHaveLength(1);
    expect(batch.keys).toHaveLength(1);
    expect(batch.keys[0]).toMatchObject({ dim: DIM, cx: 0, cz: 0, sy: 0 });

    // Re-dirty the captured section and add a brand-new one before the ACK lands.
    map.observe(obs({ state: doorClosed, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    map.observe(obs({ state: stone, pos: { x: 60, y: 0, z: 0 }, observedAt: 2000, sequence: 3 })); // cx 3

    map.confirmCapturedSections(batch.keys, batch.capturedRevision);

    // Captured-but-re-dirtied (cx 0), the untouched tail (cx 1, cx 2) and the new
    // section (cx 3) all remain pending; only the exact captured revision cleared.
    expect(pendingCount(map)).toBe(4);
    expect(map.hasPendingChanges()).toBe(true);
    const pendingCx = map.captureDirtySections().map((section) => section.cx).sort((a, b) => a - b);
    expect(pendingCx).toEqual([0, 1, 2, 3]);
    const captured = map.sectionAt(DIM, 0, 0, 0);
    expect(captured?.evidence.get(0)?.observation.state).toEqual(doorClosed);

    // A later full capture still reports the newest state for every pending section.
    const later = map.captureDirtySectionsBounded(Number.MAX_SAFE_INTEGER);
    expect(later.sections).toHaveLength(4);
    const latestCell = later.sections.find((section) => section.cx === 0);
    // Snapshot cells carry evidence metadata, not a duplicated blockstate: assert
    // the newest observation time (the state lives in palette + packed cells).
    expect(latestCell?.evidence.map((cell) => cell.evidence.observedAt)).toEqual([2000]);
    map.confirmCapturedSections(later.keys, later.capturedRevision);

    expect(map.hasPendingChanges()).toBe(false);
    expect(pendingCount(map)).toBe(0);
  });

  it('rotates past a persistently re-dirtied head instead of starving the tail', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // cx 0
    map.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } })); // cx 1

    const first = map.captureDirtySectionsBounded(1);
    expect(first.keys[0]).toMatchObject({ cx: 0 });

    // Re-dirty the captured head before the ACK; it stays pending.
    map.observe(obs({ state: air, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    map.confirmCapturedSections(first.keys, first.capturedRevision);
    expect(pendingCount(map)).toBe(2);

    // The next cap-1 batch must rotate to cx1; the re-dirtied head must not starve it.
    const second = map.captureDirtySectionsBounded(1);
    expect(second.keys[0]).toMatchObject({ cx: 1 });
    map.confirmCapturedSections(second.keys, second.capturedRevision);
    expect(pendingCount(map)).toBe(1);

    const third = map.captureDirtySectionsBounded(1);
    expect(third.keys[0]).toMatchObject({ cx: 0 });
    map.confirmCapturedSections(third.keys, third.capturedRevision);
    expect(map.hasPendingChanges()).toBe(false);
  });

  it('bounded measure does not advance the rotation cursor and matches capture', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } }));
    map.observe(obs({ state: air, pos: { x: 40, y: 0, z: 0 } }));

    // Move the cursor to cx1 with a first cap-1 capture.
    const first = map.captureDirtySectionsBounded(1);
    expect(first.keys[0]).toMatchObject({ cx: 0 });
    map.confirmCapturedSections(first.keys, first.capturedRevision);

    const measureA = map.checkpointDirtyMeasureBounded(1);
    const measureB = map.checkpointDirtyMeasureBounded(1);
    expect(measureB).toEqual(measureA);
    const batch = map.captureDirtySectionsBounded(1);
    expect(batch.keys).toHaveLength(measureA.count);
    expect(batch.capturedRevision).toBe(measureA.capturedRevision);
    expect(batch.keys[0]).toMatchObject({ cx: 1 });
  });

  it('falls back to the insertion-order head when the cursor key is no longer pending', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } })); // cx 0
    map.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } })); // cx 1
    map.observe(obs({ state: air, pos: { x: 40, y: 0, z: 0 } })); // cx 2

    const first = map.captureDirtySectionsBounded(1);
    expect(first.keys[0]).toMatchObject({ cx: 0 }); // cursor now points at cx1
    // Clear every pending entry through the legacy global path; the cursor key vanishes.
    map.confirmSections(map.saveRevision);
    expect(pendingCount(map)).toBe(0);

    map.observe(obs({ state: stone, pos: { x: 40, y: 0, z: 0 }, observedAt: 2000, sequence: 2 })); // cx 2
    const next = map.captureDirtySectionsBounded(1);
    expect(next.keys[0]).toMatchObject({ cx: 2 });
  });
});

// ==============================================================================
// Real SQLite: late ACK, failed batch/backlog, and bounded backlog progress
// ==============================================================================

describe('SQLite bounded batch late ACK', () => {
  it('commits the captured batch, keeps re-dirtied/new sections pending and persists the newest state later', async () => {
    const dbPath = makeDbPath();

    // Baseline section cx 0.
    const baseline = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    baseline.voxel.beginSession('s1');
    baseline.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await baseline.checkpoint();
    await baseline.close();

    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      voxelBatchMaxBytes: 1, // one dirty section per checkpoint
    });
    session.voxel.beginSession('s2');
    session.voxel.observe(obs({ sessionId: 's2', state: dirt, pos: { x: 20, y: 0, z: 0 }, observedAt: 2000, sequence: 1 })); // cx 1

    // Capture the single dirty section, then change it and add a new section
    // before the worker ACK arrives. Both observations happen after the capture.
    const first = session.checkpoint();
    session.voxel.observe(obs({ sessionId: 's2', state: air, pos: { x: 20, y: 0, z: 0 }, observedAt: 3000, sequence: 2 })); // re-dirty cx 1
    session.voxel.observe(obs({ sessionId: 's2', state: dirt, pos: { x: 40, y: 0, z: 0 }, observedAt: 3000, sequence: 3 })); // new cx 2
    const firstResult = await first;

    // The ACK covers only the captured revision; the newer local revision and the
    // new section are still pending and the session is still dirty.
    expect(firstResult.voxelRevision).toBeLessThan(session.voxel.saveRevision);
    expect(session.voxel.hasPendingChanges()).toBe(true);
    expect(session.getPersistenceState().dirty).toBe(true);
    expect(pendingCount(session.voxel)).toBe(2);

    // Later checkpoints persist the newest state for both sections.
    let batches = 0;
    while (session.voxel.hasPendingChanges() && batches < 6) {
      await session.checkpoint();
      batches += 1;
    }
    expect(batches).toBe(2);
    expect(session.voxel.hasPendingChanges()).toBe(false);
    expect(session.getPersistenceState().dirty).toBe(false);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(reopened.voxel, 0, 0, 0).observation.state).toEqual(stone);
    expect(evidence(reopened.voxel, 0, 0, 0).observation.observedAt).toBe(1000);
    expect(evidence(reopened.voxel, 20, 0, 0).observation.state).toEqual(air); // newest, not the captured dirt
    expect(evidence(reopened.voxel, 20, 0, 0).observation.observedAt).toBe(3000);
    expect(evidence(reopened.voxel, 40, 0, 0).observation.state).toEqual(dirt);
    await reopened.close();
  });
});

describe('SQLite bounded batch failure and backlog', () => {
  it('keeps committed batches readable and the failed batch pending, then completes honestly', async () => {
    const dbPath = makeDbPath();

    // Baseline section cx 0.
    const baseline = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    baseline.voxel.beginSession('s1');
    baseline.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await baseline.checkpoint();
    await baseline.close();

    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      voxelBatchMaxBytes: 1, // one dirty section per checkpoint
    });
    session.voxel.beginSession('s2');
    for (let i = 1; i <= 4; i++) {
      session.voxel.observe(
        obs({ sessionId: 's2', state: dirt, pos: { x: i * 20, y: 0, z: 0 }, observedAt: 2000, sequence: i }),
      ); // sections cx 1..4
    }

    // Fail the second batch only: the trigger aborts an upsert of section cx 2.
    // The first batch (cx 1) must still commit, so this distinguishes a failed
    // later batch from a failed whole checkpoint stream.
    const failedSectionId = sectionId(DIM, 2, 0, 0);
    const db = new Database(dbPath);
    db.exec(
      `CREATE TRIGGER fail_batch BEFORE INSERT ON spatial_sections WHEN NEW.id = '${failedSectionId}' ` +
        "BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;",
    );
    db.close();

    await session.checkpoint(); // batch 1: cx 1 commits
    expect(pendingCount(session.voxel)).toBe(3);
    expect(session.voxel.hasPendingChanges()).toBe(true);

    const committed = sectionRows(dbPath);
    expect(committed.size).toBe(2); // baseline cx 0 + batch 1 cx 1

    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'sql' }); // batch 2: cx 2 fails

    // The failed batch rolled back on disk, but memory facts and dirty survive.
    expect(evidence(session.voxel, 40, 0, 0).observation.state).toEqual(dirt);
    expect(session.voxel.hasPendingChanges()).toBe(true);
    expect(pendingCount(session.voxel)).toBe(3); // cx 2, 3, 4 still pending
    expect(session.getPersistenceState().dirty).toBe(true);
    expect(session.getPersistenceState().lastError?.kind).toBe('sql');

    const afterFailure = sectionRows(dbPath);
    expect(voxelRowCount(dbPath)).toBe(2);
    expect(afterFailure.get(sectionId(DIM, 0, 0, 0))).toBe(committed.get(sectionId(DIM, 0, 0, 0)));
    expect(afterFailure.get(sectionId(DIM, 1, 0, 0))).toBe(committed.get(sectionId(DIM, 1, 0, 0)));
    expect(afterFailure.has(failedSectionId)).toBe(false); // uncommitted, not fabricated

    // Removing the injected fault lets the backlog drain. The same session and
    // worker remain usable; no fabricated success is reported for the failed run.
    const repair = new Database(dbPath);
    repair.exec('DROP TRIGGER fail_batch');
    repair.close();

    let batches = 0;
    while (session.voxel.hasPendingChanges() && batches < 8) {
      await session.checkpoint();
      batches += 1;
    }
    expect(batches).toBe(3); // cx 2, 3, 4
    expect(session.voxel.hasPendingChanges()).toBe(false);
    expect(session.getPersistenceState().dirty).toBe(false);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(reopened.voxel, 0, 0, 0).observation.state).toEqual(stone);
    for (let i = 1; i <= 4; i++) {
      expect(evidence(reopened.voxel, i * 20, 0, 0).observation.state).toEqual(dirt);
    }
    expect(reopened.voxel.checkpointCounts().sections).toBe(5);
    await reopened.close();
  });

  it('drains a many-section backlog one bounded batch at a time without losing a section', async () => {
    const sectionCount = 8;
    const dbPath = makeDbPath();

    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      voxelBatchMaxBytes: 1, // one dirty section per checkpoint
    });
    session.voxel.beginSession('s1');
    const states = [stone, dirt, air, stone, dirt, air, stone, dirt];
    for (let i = 0; i < sectionCount; i++) {
      session.voxel.observe(
        obs({ state: states[i]!, pos: { x: i * 20, y: 0, z: 0 }, observedAt: 1000 + i, sequence: i + 1 }),
      );
    }
    expect(pendingCount(session.voxel)).toBe(sectionCount);

    const revisions: number[] = [];
    let batches = 0;
    // Bound the loop independently of the pending flag so a non-progressing
    // implementation fails the assertion instead of hanging.
    while (session.voxel.hasPendingChanges() && batches < sectionCount + 2) {
      const before = pendingCount(session.voxel);
      const result = await session.checkpoint();
      const after = pendingCount(session.voxel);

      expect(after).toBe(before - 1); // exactly one section confirmed per batch
      revisions.push(result.voxelRevision);
      batches += 1;
    }

    expect(batches).toBe(sectionCount); // every checkpoint made progress
    expect(session.voxel.hasPendingChanges()).toBe(false);
    expect(session.getPersistenceState().dirty).toBe(false);
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]!).toBeGreaterThan(revisions[i - 1]!); // captured revisions advance
    }
    expect(new Set(revisions).size).toBe(sectionCount);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.checkpointCounts().sections).toBe(sectionCount);
    for (let i = 0; i < sectionCount; i++) {
      expect(evidence(reopened.voxel, i * 20, 0, 0).observation.state).toEqual(states[i]);
      expect(evidence(reopened.voxel, i * 20, 0, 0).observation.observedAt).toBe(1000 + i);
    }
    await reopened.close();
  });
});
