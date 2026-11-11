import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createVoxelFactsQueryPort } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const dirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v011-persistence-'));
  dirs.push(dir);
  return join(dir, 'memory.sqlite');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('v0.11 voxel + facts persistence', () => {
  it('checkpoints and restores voxel, ledger and facts, then serves the query port', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, gameVersion: '1.20.1' });
    first.voxel.beginSession('s1');
    first.voxel.observe({
      worldId: WORLD,
      dim: DIM,
      sessionId: 's1',
      observedAt: 1000,
      sequence: 1,
      source: 'vision',
      evidence: 'seen',
      stateComplete: true,
      state: { name: 'minecraft:stone', properties: {} },
      pos: { x: -1, y: 64, z: 7 },
    });
    first.facts.upsertPlace({
      id: 'base',
      kind: 'base',
      label: 'home',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: -1, y: 64, z: 7 } },
      observedAt: 1000,
      source: { source: 'agent' },
      gone: false,
    });
    first.ledger.visitChunk(DIM, 0, 0);
    const checkpoint = await first.checkpoint();
    expect(checkpoint.factsCommitted).toBe(true);
    await first.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(reopened.getPersistenceState().restoredGameVersion).toBe('1.20.1');
      const cell = reopened.voxel.cellAt(DIM, -1, 64, 7);
      expect(cell).toMatchObject({
        observed: true,
        evidence: { freshness: 'FRESH' }, // a restore does not age evidence
      });
      expect(reopened.facts.places().items.map((fact) => fact.id)).toEqual(['base']);
      expect(reopened.ledger.chunkVisitCount(DIM, 0, 0)).toBe(1);

      const port = createVoxelFactsQueryPort({
        worldId: WORLD,
        voxel: reopened.voxel,
        facts: reopened.facts,
      });
      const cells = port.query({ kind: 'cells', dim: DIM, positions: [{ x: -1, y: 64, z: 7 }] });
      expect(cells.data?.kind === 'cells' && cells.data.cells[0]?.state?.name).toBe('minecraft:stone');
      const places = port.query({ kind: 'places', dim: DIM });
      expect(places.data?.kind === 'places' && places.data.items.map((item) => item.id)).toEqual(['base']);
      expect(places.data?.kind === 'places' && places.data.pageSource).toBe('memory');
    } finally {
      await reopened.close();
    }
  });

  it('a fresh database creates no retired route tables', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    await session.close();

    const db = new Database(dbPath, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name);
    db.close();
    for (const retired of ['path_fragments', 'traversal_evidence', 'spatial_nodes', 'spatial_edges']) {
      expect(tables).not.toContain(retired);
    }
    expect(tables).toEqual(
      expect.arrayContaining(['spatial_sections', 'fact_places', 'fact_resources', 'fact_containers', 'action_records', 'spatial_events']),
    );
  });
});
