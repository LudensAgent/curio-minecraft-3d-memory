import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import {
  FACT_MIGRATION_TARGET,
  FACT_MIGRATION_VERSION,
  PersistentFactStore,
} from '../src/index.js';
import type {
  ContainerAnchorFact,
  FactCheckpointSnapshot,
  PathFragment,
  PlaceFact,
  ResourceAnchorFact,
  SpatialNode,
} from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';
import {
  DEFAULT_LEDGER_LIMITS,
  resolveJournalLimits,
  resolveSnapshotLimits,
} from '../src/storage/sqlite/types.js';
import type { WorkerRequest } from '../src/storage/sqlite/types.js';

const WORLD = 'world-1';
const DIM = 'overworld';
const SOURCE = { source: 'vision_scan', sessionId: 's1', observationIds: ['obs-1'] } as const;

function place(id: string, overrides: Partial<PlaceFact> = {}): PlaceFact {
  return {
    id,
    kind: 'base',
    label: `Place ${id}`,
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: -10, y: 64, z: -20 } },
    observedAt: 1_700_000_000_000,
    source: { ...SOURCE },
    gone: false,
    legacyId: `legacy-${id}`,
    ...overrides,
  };
}

function resource(id: string, overrides: Partial<ResourceAnchorFact> = {}): ResourceAnchorFact {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    label: 'iron_ore',
    sourceCell: { x: -3, y: 32, z: -7 },
    observedAt: 1_700_000_001_000,
    source: { ...SOURCE },
    revoked: false,
    ...overrides,
  };
}

function container(id: string, overrides: Partial<ContainerAnchorFact> = {}): ContainerAnchorFact {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    pos: { x: -12, y: 64, z: -30 },
    externalRef: 'chest:base:1',
    observedAt: 1_700_000_002_000,
    source: { ...SOURCE },
    gone: false,
    ledgerRef: 'ledger:7',
    ...overrides,
  };
}

const tempDirs: string[] = [];
const workers: Worker[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-facts-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

function schemaMeta(db: Database.Database, key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined
  )?.value;
}

type WorkerReply = { type: string; requestId: number } & Record<string, unknown>;

function startWorker(): {
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
    kind: 'spatial',
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

describe('PersistentFactStore revision lifecycle', () => {
  it('rejects foreign-world writes before mutation and tracks only changed host metadata', () => {
    const store = new PersistentFactStore({ worldId: WORLD });
    expect(() => store.upsertPlace(place('p', { worldId: 'other' }))).toThrow(/worldId/);
    expect(() => store.upsertResource(resource('r', { worldId: 'other' }))).toThrow(/worldId/);
    expect(() => store.upsertContainer(container('c', { worldId: 'other' }))).toThrow(/worldId/);
    expect(store.revision).toBe(0);
    expect(store.hasPendingChanges()).toBe(false);
    expect(store.checkpointSnapshot()).toMatchObject({ places: [], resources: [], containers: [] });

    const original = place('p');
    store.upsertPlace(original);
    store.confirmRevision(store.revision);
    expect(store.updateHostData('place', 'p', { primary: true }).outcome).toBe('updated');
    expect(store.revision).toBe(2);
    expect(store.places().items[0]).toEqual({ ...original, hostData: { primary: true } });
    store.confirmRevision(store.revision);
    expect(store.updateHostData('place', 'p', { primary: true }).outcome).toBe('duplicate');
    expect(store.hasPendingChanges()).toBe(false);
  });

  it('confirms only the captured revision and a late ACK cannot clear newer facts', () => {
    const store = new PersistentFactStore({ worldId: WORLD });
    expect(store.revision).toBe(0);
    expect(store.hasPendingChanges()).toBe(false);

    store.upsertPlace(place('base'));
    expect(store.revision).toBe(1);
    const first = store.checkpointSnapshot();
    expect(first.revision).toBe(1);

    // Write after capture: the next snapshot carries a newer revision.
    store.upsertPlace(place('base', { observedAt: 1_700_000_100_000, label: 'Renamed base' }));
    expect(store.revision).toBe(2);

    // A late ACK for the older capture confirms only revision 1.
    store.confirmRevision(first.revision);
    expect(store.confirmedRevision).toBe(1);
    expect(store.hasPendingChanges()).toBe(true);
    expect(store.places().items[0]?.label).toBe('Renamed base');

    const second = store.checkpointSnapshot();
    expect(second.revision).toBe(2);
    store.upsertResource(resource('ore'));
    expect(store.revision).toBe(3);

    store.confirmRevision(second.revision);
    expect(store.confirmedRevision).toBe(2);
    expect(store.hasPendingChanges()).toBe(true);

    // A delayed/replayed old ACK never lowers the marker or touches memory.
    store.confirmRevision(first.revision);
    expect(store.confirmedRevision).toBe(2);
    expect(store.places().items[0]?.label).toBe('Renamed base');
    expect(store.resources().total).toBe(1);

    store.confirmRevision(3);
    expect(store.hasPendingChanges()).toBe(false);
    expect(() => store.confirmRevision(4)).toThrow(/cannot confirm facts revision/);
    expect(() => store.confirmRevision(1.5)).toThrow(/non-negative safe integer/);
    expect(() => store.confirmRevision(-1)).toThrow(/non-negative safe integer/);
  });

  it('installs a committed snapshot without re-dating or re-keying records', () => {
    const source = new PersistentFactStore({ worldId: WORLD });
    source.upsertPlace(place('base'));
    source.upsertResource(resource('ore'));
    source.upsertContainer(container('chest'));
    source.markContainerGone('chest', {
      observedAt: 1_700_000_500_000,
      source: { source: 'gone_scan' },
    });
    const snapshot = source.checkpointSnapshot();
    expect(snapshot.revision).toBe(4);

    const restored = new PersistentFactStore({ worldId: WORLD });
    restored.installSnapshot(snapshot);
    expect(restored.revision).toBe(4);
    expect(restored.confirmedRevision).toBe(4);
    expect(restored.hasPendingChanges()).toBe(false);
    expect(restored.containers().total).toBe(0);
    expect(restored.containers({ includeGone: true }).items[0]).toMatchObject({
      id: 'chest',
      observedAt: 1_700_000_002_000,
      gone: true,
      goneAt: 1_700_000_500_000,
      goneSource: { source: 'gone_scan' },
    });

    expect(() =>
      restored.installSnapshot({ ...snapshot, worldId: 'other-world' } as FactCheckpointSnapshot),
    ).toThrow(/worldId does not match/);
  });

  it('treats an empty capture as a valid explicit empty domain', () => {
    const store = new PersistentFactStore({ worldId: WORLD });
    const snapshot = store.checkpointSnapshot();
    expect(snapshot).toEqual({
      worldId: WORLD,
      revision: 0,
      places: [],
      resources: [],
      containers: [],
    });
    const restored = new PersistentFactStore({ worldId: WORLD });
    restored.installSnapshot(snapshot);
    expect(restored.places({ includeGone: true }).total).toBe(0);
    expect(restored.resources({ includeGone: true }).total).toBe(0);
    expect(restored.containers({ includeGone: true }).total).toBe(0);
    expect(restored.hasPendingChanges()).toBe(false);
  });
});

describe('SQLite facts persistence', () => {
  it('persists host business metadata independently from observation times', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const records = {
      place: place('p', { hostData: { primary: false, farm: { cells: [{ x: 1, y: 64, z: 2 }], harvests: 3 } } }),
      resource: resource('r', { hostData: { role: 'ore' } }),
      container: container('c', { hostData: { block: 'furnace', roles: ['furnace', 'station'] } }),
    };
    session.facts.upsertPlace(records.place);
    session.facts.upsertResource(records.resource);
    session.facts.upsertContainer(records.container);
    session.facts.updateHostData('place', 'p', { ...records.place.hostData, primary: true });
    await session.checkpoint();
    await session.close();
    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.facts.places().items[0]).toEqual({ ...records.place, hostData: { ...records.place.hostData, primary: true } });
    expect(reopened.facts.resources().items[0]).toEqual(records.resource);
    expect(reopened.facts.containers().items[0]).toEqual(records.container);
    expect(reopened.facts.hasPendingChanges()).toBe(false);
    await reopened.close();
  });

  it('confirms a checkpoint and restores stable ids, times and provenance after restart', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.facts.upsertPlace(place('base'));
    session.facts.upsertResource(resource('ore'));
    session.facts.upsertContainer(container('chest'));
    expect(session.getPersistenceState()).toMatchObject({
      factsRevision: 3,
      confirmedFactsRevision: 0,
      factsBaselineCheckpointId: null,
      dirty: true,
    });

    const checkpoint = await session.checkpoint();
    expect(session.getPersistenceState()).toMatchObject({
      factsRevision: 3,
      confirmedFactsRevision: 3,
      factsBaselineCheckpointId: checkpoint.checkpointId,
      factsMigration: {
        version: FACT_MIGRATION_VERSION,
        target: FACT_MIGRATION_TARGET,
        committed: true,
      },
      dirty: false,
    });
    expect(checkpoint.factsRevision).toBe(3);
    await session.close();

    const db = new Database(dbPath, { readonly: true });
    expect(schemaMeta(db, 'schema_version')).toBe('9');
    expect(schemaMeta(db, 'fact_migration_version')).toBe(String(FACT_MIGRATION_VERSION));
    expect(schemaMeta(db, 'fact_migration_target')).toBe(FACT_MIGRATION_TARGET);
    expect(
      db.prepare('SELECT checkpoint_id, revision FROM fact_domain WHERE world_id = ?').get(WORLD),
    ).toEqual({ checkpoint_id: checkpoint.checkpointId, revision: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_places').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_resources').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_containers').get()).toEqual({ n: 1 });
    db.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.getPersistenceState()).toMatchObject({
      factsRevision: 3,
      confirmedFactsRevision: 3,
      factsBaselineCheckpointId: checkpoint.checkpointId,
      factsMigration: {
        version: FACT_MIGRATION_VERSION,
        target: FACT_MIGRATION_TARGET,
        committed: true,
      },
      dirty: false,
    });
    expect(reopened.facts.places().items[0]).toEqual(place('base'));
    expect(reopened.facts.resources().items[0]).toEqual(resource('ore'));
    expect(reopened.facts.containers().items[0]).toEqual(container('chest'));
    await reopened.close();
  });

  it('retains gone and revoked records with their original times across restart', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.facts.upsertPlace(place('base'));
    session.facts.upsertResource(resource('ore'));
    session.facts.upsertContainer(container('chest'));
    await session.checkpoint();

    session.facts.markPlaceGone('base', {
      observedAt: 1_700_000_300_000,
      source: { source: 'gone_scan', sessionId: 's2' },
    });
    session.facts.revokeResource('ore', {
      observedAt: 1_700_000_400_000,
      source: { source: 'removed_scan', sessionId: 's3' },
    });
    session.facts.markContainerGone('chest', {
      observedAt: 1_700_000_500_000,
      source: { source: 'gone_scan', sessionId: 's4' },
    });
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.facts.places().total).toBe(0);
    expect(reopened.facts.resources().total).toBe(0);
    expect(reopened.facts.containers().total).toBe(0);

    expect(reopened.facts.places({ includeGone: true }).items[0]).toMatchObject({
      id: 'base',
      observedAt: 1_700_000_000_000,
      gone: true,
      goneAt: 1_700_000_300_000,
      goneSource: { source: 'gone_scan', sessionId: 's2' },
    });
    expect(reopened.facts.resources({ includeGone: true }).items[0]).toMatchObject({
      id: 'ore',
      observedAt: 1_700_000_001_000,
      revoked: true,
      revokedAt: 1_700_000_400_000,
      revokedSource: { source: 'removed_scan', sessionId: 's3' },
    });
    expect(reopened.facts.containers({ includeGone: true }).items[0]).toMatchObject({
      id: 'chest',
      externalRef: 'chest:base:1',
      ledgerRef: 'ledger:7',
      observedAt: 1_700_000_002_000,
      gone: true,
      goneAt: 1_700_000_500_000,
      goneSource: { source: 'gone_scan', sessionId: 's4' },
    });
    await reopened.close();
  });

  it('never falls back to topology or fragments when the facts domain is absent', async () => {
    const fragment: PathFragment = {
      id: 'f1',
      worldId: WORLD,
      dim: DIM,
      kind: 'walked',
      entrances: [{ x: 0.5, y: 64, z: 0.5 }],
      polyline: [{ x: 0.5, y: 64, z: 0.5 }],
      geometrySource: 'traversal',
      deepestY: 64,
      createdAt: 1,
      lastUsedAt: 2,
      uses: 3,
    };
    const node: SpatialNode = {
      id: 'n1',
      kind: 'place',
      source: 'program',
      tag: 'resource',
      label: 'chest',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: 1, y: 64, z: 1 } },
      externalRef: `${WORLD}:${DIM}:1,64,1`,
      durable: true,
      metadata: { curio: { v: 1, type: 'chest' } },
    };

    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(fragment);
    session.topology.saveNode(node);
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_places').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_resources').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_containers').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_domain').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM path_fragments').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM spatial_nodes').get()).toEqual({ n: 1 });
    db.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.getFragment('f1')).not.toBeNull();
    expect(reopened.topology.getNode('n1')).not.toBeNull();
    // Old topology is restored as history, never projected into the fact domain.
    expect(reopened.facts.places({ includeGone: true }).total).toBe(0);
    expect(reopened.facts.resources({ includeGone: true }).total).toBe(0);
    expect(reopened.facts.containers({ includeGone: true }).total).toBe(0);
    expect(reopened.getPersistenceState()).toMatchObject({
      factsBaselineCheckpointId: null,
      factsMigration: {
        version: FACT_MIGRATION_VERSION,
        target: FACT_MIGRATION_TARGET,
        committed: false,
      },
    });
    await reopened.close();
  });

  it('persists an explicitly empty facts domain through the worker protocol', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker();
    const opened = await worker.send(spatialOpen(dbPath, 1));
    expect(opened.type).toBe('open_ok');
    expect(opened.factsSnapshot).toBeNull();
    expect(opened.factsMigration).toEqual({
      version: FACT_MIGRATION_VERSION,
      target: FACT_MIGRATION_TARGET,
      committed: false,
    });

    const written = await worker.send({
      type: 'checkpoint',
      requestId: 2,
      checkpointId: 'cp-empty-facts',
      worldId: WORLD,
      fragmentRevision: 0,
      topologyRevision: 0,
      snapshot: { worldId: WORLD, fragments: [], traversals: [], nodes: [], edges: [] },
      historyMode: 'none',
      topologyMode: 'none',
      voxelMode: 'none',
      voxelRevision: 0,
      voxelSnapshot: { worldId: WORLD, sections: [] },
      journalMode: 'none',
      journalRevision: 0,
      journalBatch: { actions: [], events: [] },
      ledgerMode: 'none',
      factsMode: 'full',
      factsRevision: 0,
      factsSnapshot: { worldId: WORLD, revision: 0, places: [], resources: [], containers: [] },
    });
    expect(written.type).toBe('checkpoint_ok');
    await worker.close(3);

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare('SELECT checkpoint_id, revision FROM fact_domain WHERE world_id = ?').get(WORLD),
    ).toEqual({ checkpoint_id: 'cp-empty-facts', revision: 0 });
    db.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.facts.places({ includeGone: true }).total).toBe(0);
    expect(reopened.facts.resources({ includeGone: true }).total).toBe(0);
    expect(reopened.facts.containers({ includeGone: true }).total).toBe(0);
    expect(reopened.getPersistenceState()).toMatchObject({
      factsRevision: 0,
      confirmedFactsRevision: 0,
      factsBaselineCheckpointId: 'cp-empty-facts',
      factsMigration: {
        version: FACT_MIGRATION_VERSION,
        target: FACT_MIGRATION_TARGET,
        committed: true,
      },
      dirty: false,
    });
    await reopened.close();
  });

  it('upgrades a v8 database to v9 and starts an explicit empty facts domain', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment({
      id: 'f1',
      worldId: WORLD,
      dim: DIM,
      kind: 'walked',
      entrances: [{ x: 0.5, y: 64, z: 0.5 }],
      polyline: [{ x: 0.5, y: 64, z: 0.5 }],
      geometrySource: 'traversal',
      deepestY: 64,
      createdAt: 1,
      lastUsedAt: 2,
      uses: 3,
    });
    await session.checkpoint();
    await session.close();

    // Simulate a real v8 database: no facts tables and no facts migration record.
    const v8 = new Database(dbPath);
    v8.exec(`
      DROP TABLE fact_places;
      DROP TABLE fact_resources;
      DROP TABLE fact_containers;
      DROP TABLE fact_domain;
      DELETE FROM schema_meta WHERE key IN ('fact_migration_version', 'fact_migration_target');
      UPDATE schema_meta SET value = '8' WHERE key = 'schema_version';
    `);
    v8.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.getFragment('f1')).not.toBeNull();
    expect(reopened.facts.places({ includeGone: true }).total).toBe(0);
    expect(reopened.getPersistenceState()).toMatchObject({
      factsBaselineCheckpointId: null,
      factsMigration: {
        version: FACT_MIGRATION_VERSION,
        target: FACT_MIGRATION_TARGET,
        committed: false,
      },
    });
    await reopened.close();

    const db = new Database(dbPath, { readonly: true });
    expect(schemaMeta(db, 'schema_version')).toBe('9');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['fact_places', 'fact_resources', 'fact_containers', 'fact_domain']),
    );
    // Old domains are physically retained, not deleted by the migration.
    expect(db.prepare('SELECT COUNT(*) AS n FROM path_fragments').get()).toEqual({ n: 1 });
    db.close();
  });
});
