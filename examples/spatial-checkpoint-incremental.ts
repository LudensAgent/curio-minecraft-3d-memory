/**
 * Runnable example for the bounded, explicit incremental voxel checkpoint (phase 5C).
 *
 * Shows how, once a voxel save baseline exists, `checkpoint()` only copies, encodes
 * and writes the sections that actually changed:
 *
 *  1. observe several sections and `checkpoint()` → full baseline;
 *  2. reopen, change exactly one section, `checkpoint()` again → incremental;
 *  3. reopen and verify every record survived (the changed section carries the new
 *     fact; the untouched sections keep their original facts and times).
 *
 * This example imports the built package by its public name and subpath (not the
 * source path), so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/spatial-checkpoint-incremental.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };
const air = { name: 'minecraft:air', properties: {} };

function cellName(map: { cellAt(dim: string, x: number, y: number, z: number): unknown }, x: number, y: number, z: number): string {
  const view = map.cellAt(DIM, x, y, z) as { observed: boolean; evidence?: { observation: { state: { name: string } } } };
  return view.observed ? view.evidence!.observation.state.name : 'unknown';
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-incremental-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // 1. Baseline: three sections (two chunks + confirmed air).
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    session.voxel.beginSession('session-a');
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-a', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x: 0, y: 64, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-a', observedAt: 1000, sequence: 2,
      source: 'vision', evidence: 'seen', stateComplete: true, state: air, pos: { x: 0, y: 65, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-a', observedAt: 1000, sequence: 3,
      source: 'vision', evidence: 'seen', stateComplete: true, state: dirt, pos: { x: 20, y: 64, z: 0 },
    });
    const baseline = await session.checkpoint();
    console.log('baseline checkpoint:', baseline.checkpointId, '| sections:', session.voxel.checkpointCounts().sections);
    await session.close();

    // 2. Reopen, change only the section at x=0 (new state), checkpoint incrementally.
    const reopened = await openSpatialSession({ databasePath, worldId: WORLD });
    reopened.voxel.beginSession('session-b');
    reopened.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-b', observedAt: 2000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true, state: dirt, pos: { x: 0, y: 64, z: 0 },
    });
    const incremental = await reopened.checkpoint();
    console.log('incremental checkpoint:', incremental.checkpointId);
    await reopened.close();

    // 3. Reopen: the changed section has the new fact, the untouched ones are intact.
    const verified = await openSpatialSession({ databasePath, worldId: WORLD });
    console.log('reopened x=0:', cellName(verified.voxel, 0, 64, 0), '(changed to dirt)');
    console.log('reopened x=0,y=65:', cellName(verified.voxel, 0, 65, 0), '(air preserved)');
    console.log('reopened x=20:', cellName(verified.voxel, 20, 64, 0), '(dirt preserved)');
    await verified.close();

    console.log('note: no world scan, no current OPEN/BLOCKED, no move was produced above.');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

void main();
