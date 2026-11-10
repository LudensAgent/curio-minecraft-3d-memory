import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import { VoxelMap } from '../src/index.js';
import type { Observation, VoxelSectionSnapshot } from '../src/index.js';
import {
  decodeVoxelSectionPayload,
  encodeVoxelSectionPayload,
  readVoxelSectionGameVersion,
  UNKNOWN_GAME_VERSION,
} from '../src/voxel/serialization.js';
import {
  DEFAULT_LEDGER_LIMITS,
  resolveJournalLimits,
  resolveSnapshotLimits,
} from '../src/storage/sqlite/types.js';
import { PersistenceError } from '../src/storage/sqlite/types.js';
import type { WorkerRequest } from '../src/storage/sqlite/types.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };

const tempDirs: string[] = [];
const workers: Worker[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-v8-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

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

/** One real section snapshot, produced by the map rather than hand-built. */
function sectionSnapshot(): VoxelSectionSnapshot {
  const map = new VoxelMap(WORLD);
  map.observe(obs());
  return map.checkpointSnapshot().sections[0]!;
}

function fragment() {
  return {
    id: 'f-history',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked' as const,
    entrances: [{ x: 0.5, y: 64, z: 0.5 }],
    polyline: [{ x: 0.5, y: 64, z: 0.5 }],
    geometrySource: 'traversal' as const,
    deepestY: 64,
    createdAt: 1,
    lastUsedAt: 2,
    uses: 3,
  };
}

function schemaVersion(db: Database.Database): string {
  return (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value;
}

type WorkerReply = { type: string; requestId: number } & Record<string, unknown>;

/** Spawn the real built worker and expose one request/reply round-trip. */
function startWorker(dbPath: string): {
  send: (message: WorkerRequest) => Promise<WorkerReply>;
  close: (requestId: number) => Promise<void>;
} {
  const worker = new Worker(new URL('../dist/storage/sqlite/worker.js', import.meta.url));
  workers.push(worker);
  const send = (message: WorkerRequest): Promise<WorkerReply> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker reply timeout (${message.type})`)), 30_000);
      const onMessage = (reply: WorkerReply): void => {
        if (reply.requestId !== message.requestId) return;
        worker.off('message', onMessage);
        clearTimeout(timer);
        if (reply.type === 'error') reject(Object.assign(new Error(String(reply.message)), { kind: reply.kind }));
        else resolve(reply);
      };
      worker.on('message', onMessage);
      worker.postMessage(message);
    });
  return {
    send,
    close: async (requestId) => {
      await send({ type: 'close', requestId });
    },
  };
}

function spatialOpen(dbPath: string, requestId: number): WorkerRequest {
  return {
    type: 'open',
    requestId,
    databasePath: dbPath,
    worldId: WORLD,
    limits: resolveSnapshotLimits(undefined),
    journalLimits: resolveJournalLimits(undefined),
    voxelLoading: 'eager',
    ledgerLimits: DEFAULT_LEDGER_LIMITS,
  };
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('voxel payload game version', () => {
  it('records unknown, never the library target version, when none is supplied', () => {
    const payload = encodeVoxelSectionPayload(sectionSnapshot());
    expect(payload.v).toBe(2);
    expect(payload.gv).toBe(UNKNOWN_GAME_VERSION);
    expect(payload.gv).not.toBe('1.20.1');
    expect(readVoxelSectionGameVersion(payload)).toBe(UNKNOWN_GAME_VERSION);
  });

  it('records an explicitly supplied version', () => {
    const payload = encodeVoxelSectionPayload(sectionSnapshot(), '1.20.1');
    expect(payload.gv).toBe('1.20.1');
    expect(readVoxelSectionGameVersion(JSON.parse(JSON.stringify(payload)))).toBe('1.20.1');
  });

  it('decodes legacy v2 and v1 payloads and reports "never recorded" as null', () => {
    const section = sectionSnapshot();
    const v2 = JSON.parse(JSON.stringify(encodeVoxelSectionPayload(section, '1.20.1'))) as Record<string, unknown>;
    delete v2.gv;
    expect(readVoxelSectionGameVersion(v2)).toBeNull();
    expect(decodeVoxelSectionPayload(v2).evidence[0]!.index).toBe(section.evidence[0]!.index);

    const v1 = {
      ...v2,
      v: 1,
      evidence: section.evidence.map((cell) => ({ i: cell.index, e: cell.evidence })),
    };
    expect(readVoxelSectionGameVersion(v1)).toBeNull();
    expect(decodeVoxelSectionPayload(v1).evidence[0]!.index).toBe(section.evidence[0]!.index);
  });
});

describe('schema v8 game version records', () => {
  it('marks checkpoint and section rows unknown when the caller supplies no version', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs());
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath, { readonly: true });
    expect(schemaVersion(db)).toBe('10');
    const sectionRows = db
      .prepare('SELECT payload, game_version FROM spatial_sections WHERE world_id = ?')
      .all(WORLD) as { payload: string; game_version: string }[];
    expect(sectionRows).toHaveLength(1);
    expect(sectionRows[0]!.game_version).toBe(UNKNOWN_GAME_VERSION);
    expect(sectionRows[0]!.game_version).not.toBe('1.20.1');
    expect(JSON.parse(sectionRows[0]!.payload).gv).toBe(UNKNOWN_GAME_VERSION);

    const checkpointRows = db
      .prepare('SELECT game_version FROM checkpoints WHERE world_id = ?')
      .all(WORLD) as { game_version: string }[];
    expect(checkpointRows).toHaveLength(1);
    expect(checkpointRows[0]!.game_version).toBe(UNKNOWN_GAME_VERSION);
    db.close();
  });

  it("writes and restores the caller's explicit version through the worker protocol", async () => {
    const dbPath = makeDbPath();
    const section = sectionSnapshot();

    const first = startWorker(dbPath);
    const opened = await first.send(spatialOpen(dbPath, 1));
    expect(opened.type).toBe('open_ok');
    expect(opened.gameVersion).toBeNull(); // no committed checkpoint yet

    const written = await first.send({
      type: 'checkpoint',
      requestId: 2,
      checkpointId: 'cp-explicit-version',
      worldId: WORLD,
      voxelMode: 'full',
      voxelRevision: 1,
      voxelSnapshot: { worldId: WORLD, sections: [section] },
      journalMode: 'none',
      journalRevision: 0,
      journalBatch: { actions: [], events: [] },
      ledgerMode: 'none',
      gameVersion: '1.20.1',
    });
    expect(written.type).toBe('checkpoint_ok');
    await first.close(3);

    const db = new Database(dbPath, { readonly: true });
    const sectionRow = db.prepare('SELECT payload, game_version FROM spatial_sections').get() as {
      payload: string;
      game_version: string;
    };
    expect(sectionRow.game_version).toBe('1.20.1');
    expect(readVoxelSectionGameVersion(JSON.parse(sectionRow.payload))).toBe('1.20.1');
    const checkpointRow = db.prepare('SELECT game_version FROM checkpoints').get() as { game_version: string };
    expect(checkpointRow.game_version).toBe('1.20.1');
    db.close();

    // Reopen reports the recorded version as a recovery fact.
    const second = startWorker(dbPath);
    const reopened = await second.send(spatialOpen(dbPath, 1));
    expect(reopened.type).toBe('open_ok');
    expect(reopened.gameVersion).toBe('1.20.1');
    await second.close(2);
  });

  it('surfaces the recorded version on reopen via persistence state, and unknown when none was supplied', async () => {
    const explicitPath = makeDbPath();
    const explicit = await openSpatialSession({ databasePath: explicitPath, worldId: WORLD, gameVersion: '1.20.1' });
    expect(explicit.getPersistenceState().restoredGameVersion).toBeNull();
    explicit.voxel.beginSession('s1');
    explicit.voxel.observe(obs());
    await explicit.checkpoint();
    expect(explicit.getPersistenceState().restoredGameVersion).toBe('1.20.1');
    await explicit.close();

    const reopened = await openSpatialSession({ databasePath: explicitPath, worldId: WORLD });
    expect(reopened.getPersistenceState().restoredGameVersion).toBe('1.20.1');
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    await reopened.close();

    const unversionedPath = makeDbPath();
    const unversioned = await openSpatialSession({ databasePath: unversionedPath, worldId: WORLD });
    unversioned.voxel.beginSession('s1');
    unversioned.voxel.observe(obs());
    await unversioned.checkpoint();
    expect(unversioned.getPersistenceState().restoredGameVersion).toBe(UNKNOWN_GAME_VERSION);
    await unversioned.close();

    const reopenedUnversioned = await openSpatialSession({ databasePath: unversionedPath, worldId: WORLD });
    expect(reopenedUnversioned.getPersistenceState().restoredGameVersion).toBe(UNKNOWN_GAME_VERSION);
    expect(reopenedUnversioned.getPersistenceState().restoredGameVersion).not.toBe('1.20.1');
    await reopenedUnversioned.close();
  });

  it('keeps the voxel baseline version across a second incremental checkpoint', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, gameVersion: '1.20.1' });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs());
    const first = await session.checkpoint();
    expect(session.getPersistenceState().restoredGameVersion).toBe('1.20.1');

    // In-session incremental checkpoints still write the session's version.
    const second = await session.checkpoint();
    expect(second.checkpointId).not.toBe(first.checkpointId);
    expect(session.getPersistenceState().restoredGameVersion).toBe('1.20.1');
    await session.close();
  });

  it('rejects an empty game version at the checkpoint boundary without writing a checkpoint', async () => {
    const dbPath = makeDbPath();
    // A valid baseline first, so a rejected write would be visible as a changed id.
    const baseline = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, gameVersion: '1.20.1' });
    baseline.voxel.beginSession('s1');
    baseline.voxel.observe(obs());
    const baselineCheckpoint = await baseline.checkpoint();
    await baseline.close();

    const first = startWorker(dbPath);
    await first.send(spatialOpen(dbPath, 1));
    const rejected = await first
      .send({
        type: 'checkpoint',
        requestId: 2,
        checkpointId: 'cp-empty-version',
        worldId: WORLD,
        voxelMode: 'incremental',
        voxelRevision: 1,
        voxelSnapshot: { worldId: WORLD, sections: [] },
        journalMode: 'none',
        journalRevision: 0,
        journalBatch: { actions: [], events: [] },
        ledgerMode: 'none',
        gameVersion: '',
      })
      .then(
        () => ({ accepted: true }),
        (error: Error) => ({ accepted: false, message: error.message, kind: (error as { kind?: string }).kind }),
      );
    expect(rejected).toEqual({ accepted: false, kind: 'invalid_argument', message: 'game version must be a non-empty string' });
    await first.close(3);

    const db = new Database(dbPath, { readonly: true });
    const ids = db.prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? ORDER BY seq').all(WORLD) as {
      checkpoint_id: string;
    }[];
    expect(ids.map((row) => row.checkpoint_id)).toEqual([baselineCheckpoint.checkpointId]);
    db.close();

    // At the host layer, `undefined` means "not supplied" (opens and records
    // `'unknown'`) while an explicitly empty string is rejected before any write.
    const omitted = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(omitted.getPersistenceState().restoredGameVersion).toBe('1.20.1');
    expect(omitted.getPersistenceState().voxelBaselineCheckpointId).toBe(baselineCheckpoint.checkpointId);
    await omitted.close();

    const empty = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, gameVersion: '' }).then(
      async (session) => {
        await session.close();
        return { opened: true as const };
      },
      (error: PersistenceError) => ({ opened: false as const, kind: error.kind }),
    );
    expect(empty).toEqual({ opened: false, kind: 'invalid_argument' });
  });

  it('marks pre-v8 rows unknown during the v7 to v8 upgrade and keeps them readable', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs());
    await session.checkpoint();
    await session.close();

    // Simulate a real v7 database: no version columns and payloads without `gv`.
    const legacy = new Database(dbPath);
    legacy.exec(`
      ALTER TABLE spatial_sections DROP COLUMN game_version;
      ALTER TABLE checkpoints DROP COLUMN game_version;
      ALTER TABLE checkpoints ADD COLUMN topology_extras TEXT NOT NULL DEFAULT '{}';
      DROP TABLE IF EXISTS fact_places;
      DROP TABLE IF EXISTS fact_resources;
      DROP TABLE IF EXISTS fact_containers;
      DROP TABLE IF EXISTS fact_domain;
      DELETE FROM schema_meta WHERE key IN ('fact_migration_version', 'fact_migration_target');
      UPDATE schema_meta SET value = '7' WHERE key = 'schema_version';
    `);
    const legacyRows = legacy.prepare('SELECT rowid, payload FROM spatial_sections').all() as {
      rowid: number;
      payload: string;
    }[];
    const updatePayload = legacy.prepare('UPDATE spatial_sections SET payload = ? WHERE rowid = ?');
    legacyRows.forEach((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      delete payload.gv;
      updatePayload.run(JSON.stringify(payload), row.rowid);
    });
    legacy.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    await reopened.close();

    const db = new Database(dbPath, { readonly: true });
    expect(schemaVersion(db)).toBe('10');
    const sectionRow = db.prepare('SELECT payload, game_version FROM spatial_sections').get() as {
      payload: string;
      game_version: string;
    };
    // Upgraded rows are marked unknown; the legacy payload still records nothing.
    expect(sectionRow.game_version).toBe(UNKNOWN_GAME_VERSION);
    expect(sectionRow.game_version).not.toBe('1.20.1');
    expect(readVoxelSectionGameVersion(JSON.parse(sectionRow.payload))).toBeNull();
    const checkpointRow = db.prepare('SELECT game_version FROM checkpoints').get() as { game_version: string };
    expect(checkpointRow.game_version).toBe(UNKNOWN_GAME_VERSION);
    expect(checkpointRow.game_version).not.toBe('1.20.1');
    db.close();
  });
});
