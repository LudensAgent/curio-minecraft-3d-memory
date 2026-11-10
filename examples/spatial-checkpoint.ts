/**
 * Runnable example for the bounded, explicit spatial checkpoint.
 *
 * Shows the persistence lifecycle for the current voxel + facts runtime:
 *
 *  1. observe known blocks and air, and record one semantic place fact;
 *  2. `checkpoint()` captures and commits voxel + facts (and journal/ledger if
 *     changed) in one SQLite transaction;
 *  3. `close()` shuts the persistence channel down;
 *  4. reopen restores the committed cells, uniformly re-marked STALE, and the
 *     exact fact record;
 *  5. a new observation session re-observes exactly one cell → only that cell is
 *     FRESH again;
 *  6. `checkpoint()` confirms the refreshed state.
 *
 * This example imports the built package by its public name and subpath (not the
 * source path), so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/spatial-checkpoint.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };
const air = { name: 'minecraft:air', properties: {} };

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-checkpoint-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // 1. observe known blocks + air, save, close.
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    session.voxel.beginSession('session-a');
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-a', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: stone, pos: { x: 0, y: 64, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-a', observedAt: 1000, sequence: 2,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: air, pos: { x: 0, y: 65, z: 0 },
    });
    session.facts.upsertPlace({
      id: 'base',
      kind: 'base',
      label: 'home',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
      observedAt: 1000,
      source: { source: 'agent' },
      gone: false,
    });

    console.log('dirty before checkpoint:', session.getPersistenceState().dirty);
    const cp = await session.checkpoint();
    console.log('checkpoint committed:', cp.checkpointId, '| voxelRevision:', cp.voxelRevision);
    await session.close();

    // 2. reopen: original facts queryable, all STALE (need re-verification).
    const reopened = await openSpatialSession({ databasePath, worldId: WORLD });
    const stoneCell = reopened.voxel.cellAt(DIM, 0, 64, 0);
    console.log(
      'reopened stone freshness:',
      stoneCell.observed ? stoneCell.evidence.freshness : 'unknown',
      '| state:',
      stoneCell.observed ? stoneCell.evidence.observation.state.name : 'unknown',
    );
    const airCell = reopened.voxel.cellAt(DIM, 0, 65, 0);
    console.log('reopened air state:', airCell.observed ? airCell.evidence.observation.state.name : 'unknown');
    console.log('reopened facts:', reopened.facts.places().items.map((fact) => `${fact.id}:${fact.label}`).join(','));

    // 3. a new observation session re-observes exactly one cell.
    reopened.voxel.beginSession('session-b');
    reopened.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'session-b', observedAt: 2000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: stone, pos: { x: 0, y: 64, z: 0 },
    });

    const refreshed = reopened.voxel.cellAt(DIM, 0, 64, 0);
    const untouchedAir = reopened.voxel.cellAt(DIM, 0, 65, 0);
    console.log(
      're-observed cell freshness:',
      refreshed.observed ? refreshed.evidence.freshness : 'unknown',
      '| untouched neighbour freshness:',
      untouchedAir.observed ? untouchedAir.evidence.freshness : 'unknown',
    );

    // 4. save again to confirm the refreshed state.
    await reopened.checkpoint();
    console.log('dirty after final checkpoint:', reopened.getPersistenceState().dirty);
    await reopened.close();

    console.log('note: no world scan, no current OPEN/BLOCKED, no move was produced above.');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

void main();
