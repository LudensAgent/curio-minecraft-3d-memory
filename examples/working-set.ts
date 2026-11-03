/**
 * Runnable example for bounded working-set management (phase 5D2).
 *
 * Shows the full closed loop on a manual session with a small (3-section) working
 * set: prepare → evict LRU-eligible to fit → load → protect → Fake walk-route
 * execution over the prepared dependencies → release → free. It imports the built
 * package by its public name and subpath (not the source path), so it exercises
 * the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/working-set.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteVerifier, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  SectionKey,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
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

class FakeExecutor implements MoveExecutor {
  private seq = 1;
  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    return Promise.resolve({
      sample: {
        worldId: request.worldId,
        dim: request.dim,
        sessionId: request.sessionId,
        executionId: request.executionId,
        sequence: ++this.seq,
        pos: { ...request.to },
        observedAt: 2000,
        alive: true,
        connected: true,
        observationReady: true,
        onGround: true,
        inWater: false,
      },
    });
  }
  stop(): void {}
}

function sampleAt(executionId: string, pos: Vec3Like): BodySample {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 'live',
    executionId,
    sequence: 1,
    pos: { ...pos },
    observedAt: 2000,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'working-set-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // 1. Establish a saved record: a short walk route (support at y=-1, air at y=0/1).
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

    // 3. Restore current evidence with fresh observations, then verify the route.
    session.voxel.beginSession('live');
    for (let x = 0; x <= 3; x++) {
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 1, source: 'vision', evidence: 'seen', stateComplete: true, state: STONE, pos: { x, y: -1, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 2, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 0, z: 0 } });
      session.voxel.observe({ worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: x * 3 + 3, source: 'vision', evidence: 'seen', stateComplete: true, state: AIR, pos: { x, y: 1, z: 0 } });
    }

    const points: Vec3Like[] = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const verifier = new RouteVerifier(session.voxel, { now: () => 2000 });
    verifier.register({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' }, shapeProvider: provider, points });
    const status = verifier.advance(10);
    console.log('route verdict:', status.verdict);

    const deps: SectionKey[] = [];
    const seen = new Set<string>();
    for (const step of status.steps) {
      if (step.kind !== 'verified') continue;
      for (const d of step.result.dependencies) {
        const s = `${d.key.dim}|${d.key.cx},${d.key.cz},${d.key.sy}`;
        if (!seen.has(s)) {
          seen.add(s);
          deps.push({ ...d.key });
        }
      }
    }

    // 4. Protect the actual dependencies and execute.
    const lease = await manager.prepare(deps);
    const loop = new WalkRouteExecutor(session.voxel, new FakeExecutor(), { now: () => 2000 });
    const started = loop.start({ worldId: WORLD, dim: DIM, sessionId: 'live', mode: 'walk', body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' }, points, arrival: { kind: 'exact' }, shapeProvider: provider, deadlineMs: 100_000, timeoutMs: 10_000 });
    loop.onSample(sampleAt(started.delegationId, points[0]!));
    loop.advance(10);
    await Promise.resolve();
    loop.advance(10);
    await Promise.resolve();
    console.log('outcome:', loop.status()!.result?.outcome);

    // 5. While protected, free cannot evict; release + checkpoint → it can.
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
