/**
 * Runnable example for bounded working-set management.
 *
 * Shows the closed loop on a manual session with a small (3-section) working
 * set: prepare → evict LRU-eligible to fit → load → re-observe → bounded land
 * search → protect the route's declared Sections → release → free.
 *
 * The search returns a candidate only. The host decides whether and how to
 * execute it with its own movement primitives. It imports the built package by
 * its public name and subpath, so it exercises the package `exports` entry:
 *
 *   npm run build
 *   npx tsx examples/working-set.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchLandRoute } from 'curio-minecraft-3d-memory';
import type { CollisionShapeProvider, SectionKey } from 'curio-minecraft-3d-memory';
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';
const AIR = { name: 'minecraft:air', properties: {} };
const STONE = { name: 'minecraft:stone', properties: {} };

function keyAt(cx: number, sy: number): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

const provider: CollisionShapeProvider = {
  version: 'example-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    return { kind: 'shape', shape: { boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }] } };
  },
};

const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' } as const;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // 1. Establish a saved corridor: support at y=-1, air at y=0/1.
    const setup = await openSpatialSession({ databasePath, worldId: WORLD });
    setup.voxel.beginSession('setup');
    for (let x = 0; x <= 3; x++) {
      setup.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'setup', observedAt: 1000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: STONE, pos: { x, y: -1, z: 0 } });
      setup.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'setup', observedAt: 1000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 0, z: 0 } });
      setup.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'setup', observedAt: 1000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 1, z: 0 } });
    }
    await setup.checkpoint();
    await setup.close();

    // 2. Reopen in manual mode with a 3-section working set and a manager.
    const session = await openSpatialSession({ databasePath, worldId: WORLD, voxelLoading: 'manual', residencyLimits: { maxResidentSections: 3 } });
    const manager = new WorkingSetManager(session);

    const supportKey = keyAt(0, -1);
    const airKey = keyAt(0, 0);
    const initial = await manager.prepare([supportKey, airKey]);
    console.log('prepared:', initial.loaded.length, 'loaded |', initial.evicted.length, 'evicted');
    session.releasePins([initial.lease.token]);

    // 3. Restore current evidence with fresh observations.
    session.voxel.beginSession('live');
    for (let x = 0; x <= 3; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: STONE, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 1, z: 0 } });
    }

    // 4. Bounded land search over the restored evidence.
    const search = searchLandRoute(session.voxel, {
      worldId: WORLD,
      dim: DIM,
      sessionId: 'live',
      body: BODY,
      to: { x: 2.5, y: 0, z: 0.5 },
      arrival: { kind: 'exact' },
      rules: { shapeProvider: provider },
      allowed: ['walk', 'step', 'drop'],
      maxNodes: 256,
      maxEdges: 1024,
    }, 2000);
    console.log('search status:', search.status, '| executable:', search.executable, '| points:', search.points.length);

    // 5. Protect the Sections the caller selected for that route.
    const lease = await manager.prepare([supportKey, airKey]);
    console.log('free while pinned evicted:', manager.free().evicted.length);
    session.releasePins([lease.lease.token]);
    await session.checkpoint();
    console.log('free after release evicted:', manager.free().evicted.length);

    console.log('final stats:', JSON.stringify(manager.stats()));
    await session.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

void main();
