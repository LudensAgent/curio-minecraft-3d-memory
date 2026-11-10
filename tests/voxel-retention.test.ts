import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { VoxelMap } from '../src/index.js';
import type { Observation } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };

function obs(x: number, observedAt: number, overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD, dim: DIM, sessionId: 's1', observedAt, sequence: observedAt, source: 'vision', evidence: 'seen',
    stateComplete: true, state: stone, pos: { x, y: 0, z: 0 }, ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'voxel-retention-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}
function rows(dbPath: string): { ids: string[]; cells: number } {
  const db = new Database(dbPath, { readonly: true });
  const list = db.prepare('SELECT id, observed_cells AS n FROM spatial_sections WHERE world_id = ?').all(WORLD) as { id: string; n: number }[];
  db.close();
  return { ids: list.map((r) => r.id).sort(), cells: list.reduce((sum, r) => sum + r.n, 0) };
}

describe('VoxelMap.retainNewestObservedCells', () => {
  it('keeps the newest cells, forgets older ones as unknown, and removes emptied sections', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs(0, 1000)); // section cx=0, oldest
    map.observe(obs(1, 2000)); // section cx=0
    map.observe(obs(20, 3000)); // section cx=1
    map.observe(obs(40, 4000)); // section cx=2, newest
    map.confirmSections(map.saveRevision);
    const reports: unknown[] = [];
    map.subscribeChanges((r) => reports.push(r));

    const result = map.retainNewestObservedCells(2);
    expect(result).toEqual({ forgottenCells: 2, removedSections: 1, keptCells: 2 });
    expect(map.cellAt(DIM, 0, 0, 0).observed).toBe(false);
    expect(map.cellAt(DIM, 1, 0, 0).observed).toBe(false);
    expect(map.cellAt(DIM, 20, 0, 0).observed).toBe(true);
    expect(map.cellAt(DIM, 40, 0, 0).observed).toBe(true);
    expect(map.checkpointCounts()).toMatchObject({ sections: 2, observedCells: 2 });
    expect(map.captureRemovedSections()).toEqual([{ dim: DIM, cx: 0, cz: 0, sy: 0 }]);
    expect(reports).toHaveLength(1);
    expect((reports[0] as { sections: { invalidated: boolean }[] }).sections.every((s) => s.invalidated)).toBe(true);

    map.confirmSections(map.saveRevision);
    expect(map.captureRemovedSections()).toEqual([]);
  });

  it('keeps a section that carries traversed history even when all its observations are forgotten', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs(0, 1000));
    map.markTraversed(DIM, { x: 0, y: 1, z: 0 });
    map.observe(obs(20, 2000));
    const result = map.retainNewestObservedCells(1);
    expect(result).toMatchObject({ forgottenCells: 1, removedSections: 0 });
    expect(map.cellAt(DIM, 0, 0, 0).observed).toBe(false);
    expect(map.captureRemovedSections()).toEqual([]);
    expect(map.checkpointCounts()).toMatchObject({ sections: 2, observedCells: 1 });
  });

  it('is a no-op under the limit and rejects manual residency instead of under-trimming', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs(0, 1000));
    const revision = map.saveRevision;
    expect(map.retainNewestObservedCells(5)).toEqual({ forgottenCells: 0, removedSections: 0, keptCells: 1 });
    expect(map.saveRevision).toBe(revision);
    expect(() => new VoxelMap(WORLD, { manualResidency: true }).retainNewestObservedCells(1)).toThrow(/eager residency/);
  });
});

describe('observation retention persists through incremental checkpoints', () => {
  it('deletes removed section rows and rewrites trimmed ones; a reopened store sees only the kept cells', async () => {
    const dbPath = makeDbPath();
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs(0, 1000));
    s1.voxel.observe(obs(1, 2000));
    s1.voxel.observe(obs(20, 3000));
    s1.voxel.observe(obs(40, 4000));
    await s1.checkpoint(); // full baseline: 3 sections, 4 cells
    expect(rows(dbPath)).toMatchObject({ cells: 4 });
    expect(rows(dbPath).ids).toHaveLength(3);

    s1.voxel.retainNewestObservedCells(2);
    await s1.checkpoint(); // incremental: delete cx=0, keep cx=1/cx=2
    expect(rows(dbPath)).toEqual({ ids: [JSON.stringify([DIM, 1, 0, 0]), JSON.stringify([DIM, 2, 0, 0])].sort(), cells: 2 });

    // A cell in the removed section observed again is written back as a fresh row.
    s1.voxel.observe(obs(2, 5000));
    await s1.checkpoint();
    expect(rows(dbPath).ids).toContain(JSON.stringify([DIM, 0, 0, 0]));
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(s2.voxel.checkpointCounts()).toMatchObject({ sections: 3, observedCells: 3 });
    expect(s2.voxel.cellAt(DIM, 0, 0, 0).observed).toBe(false);
    expect(s2.voxel.cellAt(DIM, 2, 0, 0).observed).toBe(true);
    await s2.close();
  });
});
