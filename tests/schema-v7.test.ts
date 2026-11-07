import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import type { PathFragment, SpatialNode } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-v7-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

function fragment(): PathFragment {
  return {
    id: 'f1',
    worldId: WORLD,
    dim: DIM,
    kind: 'dug',
    entrances: [{ x: 0, y: 64, z: 0 }],
    polyline: [{ x: 0, y: 64, z: 0 }],
    geometrySource: 'legacy',
    deepestY: 64,
    createdAt: 1,
    lastUsedAt: 2,
    uses: 3,
    externalRef: 'psg_f1',
    metadata: { curio: { v: 1, dug: 7, ores: { iron_ore: 2 }, archivedAt: 4 } },
  };
}

function node(): SpatialNode {
  return {
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
    metadata: { curio: { v: 1, type: 'chest', contents: { items: [{ name: 'dirt', count: 12 }] } } },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('schema v7 and metadata persistence', () => {
  it('round-trips fragment and node metadata through checkpoint and reopen', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(fragment());
    session.topology.saveNode(node());
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.getFragment('f1')).toMatchObject({
      externalRef: 'psg_f1',
      metadata: { curio: { v: 1, dug: 7, ores: { iron_ore: 2 }, archivedAt: 4 } },
    });
    expect(reopened.topology.getNode('n1')).toMatchObject({
      externalRef: `${WORLD}:${DIM}:1,64,1`,
      durable: true,
      metadata: { curio: { v: 1, type: 'chest' } },
    });
    await reopened.close();
  });

  it('upgrades a v6 placed table that required a non-null dimension', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.putPlaced(DIM, { x: 2, y: 64, z: 2 }, 'minecraft:torch');
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE placed_blocks_v6 (
        key TEXT PRIMARY KEY,
        world_id TEXT,
        dim TEXT,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        name TEXT NOT NULL,
        lru_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        CHECK ((world_id IS NULL AND dim IS NULL) OR (world_id IS NOT NULL AND dim IS NOT NULL))
      );
      INSERT INTO placed_blocks_v6 SELECT key, world_id, dim, x, y, z, name, lru_at, source FROM placed_blocks;
      DROP TABLE placed_blocks;
      ALTER TABLE placed_blocks_v6 RENAME TO placed_blocks;
      CREATE INDEX placed_blocks_world_lru ON placed_blocks (world_id, dim, lru_at);
      UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
    `);
    db.close();

    const upgraded = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(upgraded.ledger.placedBlocks(DIM).map((record) => record.name)).toEqual(['minecraft:torch']);
    // The relaxed CHECK accepts a known world with an unknown dimension.
    upgraded.ledger.importUnattributedPlaced({ pos: { x: 3, y: 64, z: 3 }, name: 'minecraft:dirt', lruAt: 9 });
    await upgraded.checkpoint();
    await upgraded.close();

    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('8');
    expect(check.prepare('SELECT count(*) AS n FROM placed_blocks WHERE dim IS NULL').get()).toEqual({ n: 1 });
    check.close();
  });
});
