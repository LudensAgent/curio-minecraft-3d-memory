/**
 * Runnable example for the explicit, bounded history checkpoint (phase 5A).
 *
 * Shows the persistence lifecycle for the four historical facts — path fragments,
 * traversal evidence, spatial nodes, and topology edges with their original
 * binding snapshots:
 *
 *  1. write into the in-memory stores (immediately queryable);
 *  2. `checkpoint()` captures and commits the full history in one SQLite transaction;
 *  3. `close()` shuts the persistence channel down;
 *  4. reopen restores the committed state;
 *  5. deleting evidence then re-saving leaves an edge reporting `missing`;
 *  6. replacing evidence under the same id leaves the edge reporting `mismatch`
 *     (the original binding is restored, never silently re-bound).
 *
 * This example imports the built package by its public name and subpath (not the
 * source path), so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/history-checkpoint.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'history-checkpoint-'));
  const databasePath = join(dir, 'history.db');

  try {
    // 1. open a fresh session, write the four facts, checkpoint, close.
    const session = await openHistorySession({ databasePath, worldId: WORLD });
    session.history.saveFragment({
      id: 'f1', worldId: WORLD, dim: DIM, kind: 'walked',
      entrances: [{ x: 0.5, y: 64, z: 0.5 }],
      polyline: [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }],
      geometrySource: 'traversal', deepestY: 12, createdAt: 1000, lastUsedAt: 1000, uses: 1,
    });
    session.history.addTraversal({
      id: 'ev1', fragmentId: 'f1', from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.5, y: 64, z: 0.5 },
      worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 1000, source: 'confirmed_walk', mode: 'walk',
    });
    session.topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } } });
    session.topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: { x: 1.5, y: 64, z: 0.5 } } });
    session.topology.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev1'] });

    console.log('dirty before checkpoint:', session.getPersistenceState().dirty);
    const cp = await session.checkpoint();
    console.log('checkpoint committed:', cp.checkpointId, '| dirty after:', session.getPersistenceState().dirty);
    await session.close();

    // 2. reopen: the committed state is restored, queries agree.
    const reopened = await openHistorySession({ databasePath, worldId: WORLD });
    console.log('reopened fragments:', reopened.history.fragments().total,
      '| traversal observedAt:', reopened.history.getTraversal('ev1')?.observedAt,
      '| edge resolution:', reopened.topology.getEdge('e1')?.resolution);
    await reopened.close();

    // 3. delete the fragment (cascade-deletes its evidence), re-checkpoint: the
    //    edge still exists and reports `missing`.
    const del = await openHistorySession({ databasePath, worldId: WORLD });
    del.history.forgetFragment('f1');
    await del.checkpoint();
    await del.close();
    const afterDelete = await openHistorySession({ databasePath, worldId: WORLD });
    console.log('after deleting evidence → edge resolution:', afterDelete.topology.getEdge('e1')?.resolution);
    await afterDelete.close();

    // 4. restore evidence under the same id with different content: the original
    //    binding is preserved, so the edge reports `mismatch` (never re-bound).
    const rebind = await openHistorySession({ databasePath, worldId: WORLD });
    rebind.history.saveFragment({
      id: 'f1', worldId: WORLD, dim: DIM, kind: 'walked',
      entrances: [{ x: 0.5, y: 64, z: 0.5 }],
      polyline: [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }],
      geometrySource: 'traversal', deepestY: 12, createdAt: 1000, lastUsedAt: 1000, uses: 1,
    });
    rebind.history.addTraversal({
      id: 'ev1', fragmentId: 'f1', from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.5, y: 64, z: 0.5 },
      worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 2000, source: 'confirmed_walk', mode: 'walk',
    });
    await rebind.checkpoint();
    await rebind.close();
    const afterRebind = await openHistorySession({ databasePath, worldId: WORLD });
    console.log('after same-id evidence change → edge resolution:', afterRebind.topology.getEdge('e1')?.resolution);
    await afterRebind.close();

    console.log('note: no world scan, no current OPEN/BLOCKED, no move was produced above.');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

void main();
