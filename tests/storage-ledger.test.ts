import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import type { Observation } from '../src/index.js';
import type { PortalEndpointEvidence, SpatialEvent } from '../src/storage/sqlite/types.js';
import {
  openSpatialSession,
  PersistenceError,
  portalTraversalIdentity,
} from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };
const air = { name: 'minecraft:air', properties: {} };

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
    pos: { x: 0, y: 64, z: 0 },
    ...overrides,
  };
}

function endpoint(
  id: string,
  dim: string,
  pos: { x: number; y: number; z: number },
  observedAt: number,
): PortalEndpointEvidence {
  return {
    id,
    worldId: WORLD,
    dim,
    pos,
    kind: 'nether_portal',
    portalObserved: true,
    observedAt,
  };
}

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-ledger-'));
  tempDirs.push(dir);
  return join(dir, 'ledger.db');
}

function tempDirOf(dbPath: string): string {
  return dirname(dbPath);
}

function schemaVersion(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
  db.close();
  return row.value;
}

/** Recreate a true v4 database shape from the current v5 fixture. */
function downgradeToV4(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS placed_blocks');
  db.exec('DROP TABLE IF EXISTS chunk_visits');
  db.exec('DROP TABLE IF EXISTS portal_traversals');
  db.exec('DROP INDEX IF EXISTS spatial_sections_world_coords');
  db.exec('ALTER TABLE checkpoints DROP COLUMN ledger_revision');
  db.exec('ALTER TABLE checkpoints DROP COLUMN has_ledger');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN dimension');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cx');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cz');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN sy');
  db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('placement / visit / portal ledger persistence', () => {
  it('round-trips names, LRU serials, visit counts and raw portal evidence', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    session.ledger.putPlaced(DIM, { x: -1, y: 63, z: 2 }, 'minecraft:cobblestone');
    expect(session.ledger.visitChunk(DIM, 0, 0).record.count).toBe(1);
    expect(session.ledger.visitChunk(DIM, 0, 0).record.count).toBe(1); // same chunk: no increment
    expect(session.ledger.visitChunk(DIM, -1, 2).record.count).toBe(1);
    expect(session.ledger.visitChunk(DIM, 0, 0).record.count).toBe(2);

    const from = endpoint('ep_a', DIM, { x: 0.5, y: 64, z: 0.5 }, 1000);
    const to = endpoint('ep_b', 'the_nether', { x: 2.5, y: 70, z: 3.5 }, 1100);
    const traversal = session.ledger.recordPortalTraversal({
      fromId: 'ep_a',
      toId: 'ep_b',
      ts: 1200,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 7,
      toObservation: 8,
      fromEndpoint: from,
      toEndpoint: to,
    });
    expect(traversal.id).toBe(
      portalTraversalIdentity({
        kind: 'traversal',
        fromId: 'ep_a',
        toId: 'ep_b',
        ts: 1200,
        fromSession: 's1',
        toSession: 's2',
        fromObservation: 7,
        toObservation: 8,
      }),
    );
    expect(traversal.direction).toBe('unclassified');
    expect(session.getPersistenceState().dirty).toBe(true);

    const checkpoint = await session.checkpoint();
    expect(checkpoint.ledgerRevision).toBe(session.ledger.revision);
    expect(session.getPersistenceState()).toMatchObject({
      dirty: false,
      confirmedLedgerRevision: session.ledger.revision,
      ledgerBaselineCheckpointId: checkpoint.checkpointId,
    });
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.ledger.placedBlocks()).toEqual([
      {
        key: `${WORLD}:${DIM}:0,64,0`,
        worldId: WORLD,
        dim: DIM,
        pos: { x: 0, y: 64, z: 0 },
        name: 'minecraft:torch',
        lruAt: 1,
        source: 'live',
      },
      {
        key: `${WORLD}:${DIM}:-1,63,2`,
        worldId: WORLD,
        dim: DIM,
        pos: { x: -1, y: 63, z: 2 },
        name: 'minecraft:cobblestone',
        lruAt: 2,
        source: 'live',
      },
    ]);
    expect(reopened.ledger.chunkVisitCount(DIM, 0, 0)).toBe(2);
    expect(reopened.ledger.chunkVisitCount(DIM, -1, 2)).toBe(1);
    expect(reopened.ledger.portalTraversals()).toEqual([traversal]);
    expect(reopened.ledger.portalReturnVerified(traversal)).toBe(false);
    expect(reopened.getPersistenceState()).toMatchObject({
      dirty: false,
      ledgerBaselineCheckpointId: checkpoint.checkpointId,
    });

    // A return crossing is separate raw evidence; the derived return flag follows it.
    reopened.ledger.recordPortalTraversal({
      fromId: 'ep_b',
      toId: 'ep_a',
      ts: 1300,
      fromSession: 's2',
      toSession: 's3',
      fromObservation: 9,
      toObservation: 10,
      fromEndpoint: to,
      toEndpoint: from,
    });
    expect(reopened.ledger.portalReturnVerified(traversal)).toBe(true);
    await reopened.close();
  });

  it('preserves the LRU serial as an order fact, never as time', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.importPlaced({ dim: DIM, pos: { x: 4, y: 64, z: 4 }, name: 'minecraft:glass', lruAt: 5 });
    session.ledger.importPlaced({ dim: DIM, pos: { x: 5, y: 64, z: 4 }, name: 'minecraft:dirt', lruAt: 9 });
    expect(session.ledger.placedBlocks().map((record) => record.lruAt)).toEqual([5, 9]);
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const records = reopened.ledger.placedBlocks();
    expect(records.map((record) => record.lruAt)).toEqual([5, 9]);
    expect(records.every((record) => record.source === 'legacy')).toBe(true);
    // No observation/placement timestamp is manufactured from the LRU serial.
    expect(records.every((record) => !('observedAt' in record))).toBe(true);

    // A lookup refreshes the serial (a use), never the name or position.
    const near = reopened.ledger.queryPlacedNear(DIM, { x: 4, y: 64, z: 4 }, 0.5);
    expect(near.map((hit) => hit.record.name)).toEqual(['minecraft:glass']);
    expect(near[0]!.record.lruAt).toBe(10);
    await reopened.checkpoint();
    await reopened.close();

    const again = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(again.ledger.getPlaced(DIM, { x: 4, y: 64, z: 4 })!.lruAt).toBe(10);
    expect(again.ledger.getPlaced(DIM, { x: 5, y: 64, z: 4 })!.lruAt).toBe(9);
    await again.close();
  });

  it('persists deletions and full-replacement semantics', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    first.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    first.ledger.putPlaced(DIM, { x: 1, y: 64, z: 0 }, 'minecraft:torch');
    await first.checkpoint();
    expect(first.ledger.removePlaced(DIM, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(first.ledger.removePlaced(DIM, { x: 99, y: 64, z: 0 })).toBe(false);
    await first.checkpoint();
    await first.close();

    const second = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(second.ledger.placedBlocks().map((record) => record.pos)).toEqual([{ x: 1, y: 64, z: 0 }]);
    second.ledger.removePlaced(DIM, { x: 1, y: 64, z: 0 });
    await second.checkpoint();
    await second.close();

    const third = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(third.ledger.placedBlocks()).toEqual([]);
    await third.close();
  });

  it('isolates worlds in one database and never mixes ledger rows', async () => {
    const dbPath = makeDbPath();
    const a = await openSpatialSession({ databasePath: dbPath, worldId: 'world-a' });
    a.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    a.ledger.visitChunk(DIM, 0, 0);
    a.ledger.recordPortalTraversal({
      fromId: 'ep_a',
      toId: 'ep_b',
      ts: 1,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 1,
      toObservation: 2,
      worldId: 'world-a',
      fromEndpoint: { ...endpoint('ep_a', DIM, { x: 0, y: 64, z: 0 }, 1), worldId: 'world-a' },
      toEndpoint: { ...endpoint('ep_b', 'the_nether', { x: 1, y: 64, z: 0 }, 2), worldId: 'world-a' },
    });
    await a.checkpoint();
    await a.close();

    const b = await openSpatialSession({ databasePath: dbPath, worldId: 'world-b' });
    expect(b.ledger.placedBlocks()).toEqual([]);
    expect(b.ledger.chunkVisits()).toEqual([]);
    expect(b.ledger.portalTraversals()).toEqual([]);
    b.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:dirt');
    await b.checkpoint();
    await b.close();

    const reopenedA = await openSpatialSession({ databasePath: dbPath, worldId: 'world-a' });
    expect(reopenedA.ledger.placedBlocks().map((record) => record.name)).toEqual(['minecraft:torch']);
    await reopenedA.close();
  });

  it('rejects ledger rows without a ledger baseline instead of reading them as empty', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare('DELETE FROM checkpoints WHERE world_id = ?').run(WORLD);
    db.close();

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'data',
    });
  });
});

describe('v4 → v5 schema migration and section payload compatibility', () => {
  it('adds explicit section coordinates and ledger tables while preserving committed facts', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    save.ledger.putPlaced(DIM, { x: 3, y: 64, z: 3 }, 'minecraft:torch');
    await save.checkpoint();
    await save.close();

    const db = new Database(dbPath);
    downgradeToV4(db);
    db.close();
    expect(schemaVersion(dbPath)).toBe('4');

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(schemaVersion(dbPath)).toBe('6');
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    // The ledger was not part of v4, so the upgraded database starts with no
    // ledger baseline rather than a synthesized placement.
    expect(reopened.getPersistenceState()).toMatchObject({
      ledgerBaselineCheckpointId: null,
      ledgerRevision: 0,
    });
    expect(reopened.ledger.placedBlocks()).toEqual([]);
    await reopened.close();

    const check = new Database(dbPath, { readonly: true });
    const columns = check.prepare('PRAGMA table_info(spatial_sections)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['world_id', 'dimension', 'cx', 'cz', 'sy', 'id', 'payload']),
    );
    const row = check.prepare('SELECT id, dimension, cx, cz, sy FROM spatial_sections').get() as {
      id: string;
      dimension: string;
      cx: number;
      cz: number;
      sy: number;
    };
    expect(JSON.parse(row.id)).toEqual([row.dimension, row.cx, row.cz, row.sy]);
    expect(row.dimension).toBe(DIM);
    for (const table of ['placed_blocks', 'chunk_visits', 'portal_traversals']) {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toMatchObject({
        name: table,
      });
    }
    check.close();

    const backups = readdirSync(tempDirOf(dbPath)).filter((name) => name.includes('.pre-v5-'));
    expect(backups).toHaveLength(1);
  });

  it('writes v2 section payloads without a duplicate blockstate and still reads v1 payloads', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await save.checkpoint();
    await save.close();

    const db = new Database(dbPath);
    const row = db.prepare('SELECT payload FROM spatial_sections WHERE world_id = ?').get(WORLD) as { payload: string };
    const payload = JSON.parse(row.payload) as {
      v: number;
      palette: string[];
      bits: number;
      cells: string;
      revision: number;
      evidence: { i: number; sc: boolean; e: string; at: number; s: string; ses: string }[];
    };
    expect(payload.v).toBe(2);
    expect(payload.palette).toContain('minecraft:stone');
    expect(payload.evidence).toHaveLength(1);
    expect(payload.evidence[0]).toMatchObject({ sc: true, e: 'seen', s: 'vision' });
    expect('observation' in payload.evidence[0]!).toBe(false);

    // Rewrite the same section as a v1 payload (full observation state inline),
    // then verify the worker still decodes it.
    const v1 = {
      v: 1,
      dim: DIM,
      cx: 0,
      cz: 0,
      sy: 0,
      palette: payload.palette,
      bits: payload.bits,
      cells: payload.cells,
      evidence: [
        {
          i: 0,
          e: {
            observation: {
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
            },
            revision: 1,
            freshness: 'FRESH',
            validUntil: 61000,
          },
        },
      ],
      revision: payload.revision,
    };
    db.prepare('UPDATE spatial_sections SET payload = ? WHERE world_id = ?').run(JSON.stringify(v1), WORLD);
    db.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toMatchObject({
      observed: true,
      evidence: { freshness: 'STALE', observation: { state: stone } },
    });
    await reopened.close();
  });
});

describe('spatial event kinds and ledger bounds', () => {
  type CellKind = 'cell_blocked' | 'cell_cleared' | 'cell_revalidated';
  function cellEvent(kind: CellKind, id: string, state = stone): Extract<SpatialEvent, { kind: CellKind }> {
    return {
      kind,
      id,
      observedAt: 1000,
      worldId: WORLD,
      dim: DIM,
      sessionId: 's1',
      pos: { x: 0, y: 64, z: 0 },
      evidence: obs({ state, observedAt: 1000 }),
    };
  }

  it('accepts, persists and filters blocked/cleared/revalidated events', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordBatch({
      events: [
        cellEvent('cell_blocked', 'ev_blocked', stone),
        cellEvent('cell_cleared', 'ev_cleared', air),
        cellEvent('cell_revalidated', 'ev_revalidated', stone),
      ],
    });
    await session.checkpoint();
    const blocked = await session.queryEvents({ kind: 'cell_blocked' });
    expect(blocked.records).toHaveLength(1);
    expect(blocked.records[0]).toMatchObject({
      kind: 'cell_blocked',
      id: 'ev_blocked',
      sessionId: 's1',
      observedAt: 1000,
    });
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const cleared = await reopened.queryEvents({ kind: 'cell_cleared' });
    expect(cleared.records).toHaveLength(1);
    expect(cleared.records[0]).toMatchObject({ kind: 'cell_cleared', id: 'ev_cleared' });
    const all = await reopened.queryEvents();
    expect(all.records.map((event) => event.kind)).toEqual([
      'cell_blocked',
      'cell_cleared',
      'cell_revalidated',
    ]);
    await reopened.close();
  });

  it('rejects a cell event whose evidence scope or time does not match', async () => {
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    const wrongSession = cellEvent('cell_blocked', 'ev_a');
    wrongSession.evidence = obs({ sessionId: 'other' });
    expect(() => session.journal.recordEvent(wrongSession)).toThrow(PersistenceError);

    const wrongTime = cellEvent('cell_cleared', 'ev_b', air);
    wrongTime.evidence = obs({ observedAt: 2000, state: air });
    expect(() => session.journal.recordEvent(wrongTime)).toThrow(PersistenceError);

    const wrongScope = cellEvent('cell_revalidated', 'ev_c');
    wrongScope.evidence = obs({ pos: { x: 1, y: 64, z: 0 } });
    expect(() => session.journal.recordEvent(wrongScope)).toThrow(PersistenceError);
    expect(session.journal.readPending().events).toEqual([]);
    await session.close();
  });

  it('bounds ledger capacities and oversized event payloads without partial state', async () => {
    const ledgerSession = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      ledgerLimits: { maxPlacedBlocks: 1 },
    });
    ledgerSession.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    expect(() => ledgerSession.ledger.putPlaced(DIM, { x: 1, y: 64, z: 0 }, 'minecraft:torch')).toThrow(
      /maxPlacedBlocks/,
    );
    expect(ledgerSession.ledger.placedBlocks()).toHaveLength(1);
    await ledgerSession.close();

    const visitSession = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      ledgerLimits: { maxChunkVisits: 1 },
    });
    visitSession.ledger.visitChunk(DIM, 0, 0);
    expect(() => visitSession.ledger.visitChunk(DIM, 1, 0)).toThrow(/maxChunkVisits/);
    // A refused visit must not leave same-chunk dedupe state pointing at a record
    // that was never inserted; the retry must throw again, not return undefined.
    expect(() => visitSession.ledger.visitChunk(DIM, 1, 0)).toThrow(/maxChunkVisits/);
    await visitSession.close();

    const endpointSession = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      ledgerLimits: { maxEndpointBytes: 200 },
    });
    expect(() =>
      endpointSession.ledger.recordPortalTraversal({
        fromId: 'ep_a',
        toId: 'ep_b',
        ts: 1,
        fromSession: 's1',
        toSession: 's2',
        fromObservation: 1,
        toObservation: 2,
        fromEndpoint: endpoint('ep_a', 'd'.repeat(500), { x: 0, y: 0, z: 0 }, 1),
        toEndpoint: endpoint('ep_b', 'the_nether', { x: 0, y: 0, z: 0 }, 2),
      }),
    ).toThrow(/maxEndpointBytes/);
    expect(endpointSession.ledger.portalTraversals()).toEqual([]);
    await endpointSession.close();

    const journalSession = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      journalLimits: { maxRecordBytes: 600, maxPendingBytes: 1200, maxBatchBytes: 600 },
    });
    expect(() =>
      journalSession.journal.recordEvent({ ...cellEvent('cell_blocked', 'x'.repeat(600)) }),
    ).toThrow(/maxRecordBytes/);
    expect(journalSession.journal.readPending().events).toEqual([]);
    await journalSession.close();
  });

  it('rejects restored portal endpoints that belong to another world', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.recordPortalTraversal({
      fromId: 'ep_a',
      toId: 'ep_b',
      ts: 1,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 1,
      toObservation: 2,
      fromEndpoint: endpoint('ep_a', DIM, { x: 0, y: 64, z: 0 }, 1),
      toEndpoint: endpoint('ep_b', 'the_nether', { x: 1, y: 64, z: 0 }, 2),
    });
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    const row = db.prepare('SELECT id, from_endpoint FROM portal_traversals').get() as {
      id: string;
      from_endpoint: string;
    };
    const stored = JSON.parse(row.from_endpoint) as Record<string, unknown>;
    stored['worldId'] = 'other-world';
    db.prepare('UPDATE portal_traversals SET from_endpoint = ? WHERE id = ?').run(
      JSON.stringify(stored),
      row.id,
    );
    db.close();

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'data',
    });
  });
});
