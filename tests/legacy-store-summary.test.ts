import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-store-summary-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** Create the current schema first, then add retired tables with raw SQL. */
async function initializeSchema(dbPath: string, worldId = WORLD): Promise<void> {
  const session = await openSpatialSession({ databasePath: dbPath, worldId });
  await session.close();
}

/**
 * Add the retired route tables and rows directly with raw SQL. This is the only
 * way the current library can still encounter them; it never writes them.
 */
function seedLegacyRows(
  dbPath: string,
  worldId: string,
  rows: { fragments?: string[]; traversals?: string[]; nodes?: string[]; edges?: string[] },
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS path_fragments (
        world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (world_id, id)
      );
      CREATE TABLE IF NOT EXISTS traversal_evidence (
        world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (world_id, id)
      );
      CREATE TABLE IF NOT EXISTS spatial_nodes (
        world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (world_id, id)
      );
      CREATE TABLE IF NOT EXISTS spatial_edges (
        world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (world_id, id)
      );
    `);
    const insert = (table: string, ids: string[]): void => {
      const run = db.prepare(`INSERT INTO ${table} (world_id, seq, id, payload) VALUES (?, ?, ?, ?)`);
      ids.forEach((id, index) => run.run(worldId, index, id, JSON.stringify({ id, worldId })));
    };
    insert('path_fragments', rows.fragments ?? []);
    insert('traversal_evidence', rows.traversals ?? []);
    insert('spatial_nodes', rows.nodes ?? []);
    insert('spatial_edges', rows.edges ?? []);
  } finally {
    db.close();
  }
}

function legacyRows(dbPath: string): Record<string, unknown[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const read = (table: string): unknown[] =>
      db.prepare(`SELECT world_id, seq, id, payload FROM ${table} ORDER BY world_id, seq`).all();
    return {
      fragments: read('path_fragments'),
      traversals: read('traversal_evidence'),
      nodes: read('spatial_nodes'),
      edges: read('spatial_edges'),
    };
  } finally {
    db.close();
  }
}

describe('legacyStoreSummary', () => {
  it('reports zeros when the retired tables do not exist', async () => {
    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
    });
    try {
      expect(session.legacyStoreSummary).toEqual({
        fragments: 0,
        traversals: 0,
        nodes: 0,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await session.close();
    }
  });

  it('counts old rows without loading them and never overwrites them on checkpoint', async () => {
    const dbPath = makeDbPath();
    await initializeSchema(dbPath);
    seedLegacyRows(dbPath, WORLD, {
      fragments: ['f1'],
      traversals: ['t1'],
      nodes: ['n1'],
      edges: ['e1'],
    });
    const before = legacyRows(dbPath);

    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(session.legacyStoreSummary).toEqual({
        fragments: 1,
        traversals: 1,
        nodes: 1,
        edges: 1,
        migrationMarker: false,
      });
      session.facts.upsertPlace({
        id: 'base',
        kind: 'base',
        label: 'home',
        worldId: WORLD,
        dim: DIM,
        location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } },
        observedAt: 5000,
        source: { source: 'agent' },
        gone: false,
      });
      await session.checkpoint();
    } finally {
      await session.close();
    }

    expect(legacyRows(dbPath)).toEqual(before);
  });

  it('scopes counts to the opened world', async () => {
    const dbPath = makeDbPath();
    await initializeSchema(dbPath, 'world-a');
    seedLegacyRows(dbPath, 'world-a', { fragments: ['a1', 'a2'], nodes: ['a-node'] });
    seedLegacyRows(dbPath, 'world-b', { fragments: ['b1'], nodes: ['b-node'] });

    const reopenedA = await openSpatialSession({ databasePath: dbPath, worldId: 'world-a' });
    try {
      expect(reopenedA.legacyStoreSummary).toEqual({
        fragments: 2,
        traversals: 0,
        nodes: 1,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await reopenedA.close();
    }

    const reopenedB = await openSpatialSession({ databasePath: dbPath, worldId: 'world-b' });
    try {
      expect(reopenedB.legacyStoreSummary).toEqual({
        fragments: 1,
        traversals: 0,
        nodes: 1,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await reopenedB.close();
    }
  });

  it('reports the old curio:migration marker without treating it as a facts receipt', async () => {
    const dbPath = makeDbPath();
    await initializeSchema(dbPath);
    seedLegacyRows(dbPath, WORLD, { nodes: ['curio:migration'] });

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(reopened.legacyStoreSummary).toMatchObject({ nodes: 1, migrationMarker: true });
      expect(reopened.legacyFactsMigrationVersion).toBe(0);
      expect(reopened.factsMigration.committed).toBe(false);
    } finally {
      await reopened.close();
    }
  });

  it('keeps old rows byte-identical across voxel and facts checkpoints', async () => {
    const dbPath = makeDbPath();
    await initializeSchema(dbPath);
    seedLegacyRows(dbPath, WORLD, {
      fragments: ['f1'],
      traversals: ['t1'],
      nodes: ['n1', 'curio:migration'],
      edges: ['e1'],
    });
    const before = legacyRows(dbPath);
    const summary = {
      fragments: 1,
      traversals: 1,
      nodes: 2,
      edges: 1,
      migrationMarker: true,
    };

    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(session.legacyStoreSummary).toEqual(summary);
      session.voxel.observe({
        worldId: WORLD,
        dim: DIM,
        sessionId: 's1',
        observedAt: 1000,
        sequence: 1,
        source: 'vision',
        evidence: 'seen',
        stateComplete: true,
        state: { name: 'minecraft:stone', properties: {} },
        pos: { x: 0, y: 64, z: 0 },
      });
      await session.checkpoint();
    } finally {
      await session.close();
    }

    expect(legacyRows(dbPath)).toEqual(before);

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(reopened.legacyStoreSummary).toEqual(summary);
    } finally {
      await reopened.close();
    }
  });
});
