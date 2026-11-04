/**
 * Runnable reference for the *host* lifecycle of one shared spatial session.
 *
 * The library owns the facts and the execution orchestration; the host (Curio)
 * owns the connection, the real perception, and the body. This example pins down
 * the wiring order that Curio must follow, using Fake perception and a Fake body
 * so it runs without a game server:
 *
 *   1. host startup        — host supplies databasePath + worldId, awaits the map
 *   2. shared map          — every perception update and walk delegation reuses `session.voxel`
 *   3. connect / reconnect — sessionId comes from the connection lifecycle; late old-session evidence is rejected
 *   4. perception update   — host writes observations first, forwards the ChangeReport to the active route
 *   5. route lifecycle     — verify → execute → release; cancelling one delegation never closes the shared session
 *   6. save & close        — checkpoint (capture+commit) → flush (wait) → close (bounded shutdown)
 *   7. restore             — history + original times come back STALE; passability is re-established, not reused
 *
 * It uses the default `eager` voxel loading, which restores every committed
 * section at open and is only appropriate when the world fits the session's
 * working-set budget. For on-demand residency and route pin protection, see
 * `examples/working-set.ts` and the "manual on-demand section residency" README
 * section — this example does not imply eager loading suits every world.
 *
 * Run with (the package self-resolves its own name through `exports`):
 *
 *   npm run build
 *   npx tsx examples/shared-session-lifecycle.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteVerifier, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  ChangeReport,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Observation,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';
const STONE = { name: 'minecraft:stone', properties: {} };
const AIR = { name: 'minecraft:air', properties: {} };

const shapeProvider: CollisionShapeProvider = {
  version: 'host-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
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
        observedAt: NOW,
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

const NOW = 2000;

/**
 * Host perception: write one real observation into the shared map and hand the
 * resulting `ChangeReport` back so the caller can forward it to any active route
 * (via `RouteVerifier.apply` / `WalkRouteExecutor.observe`). The library never
 * scans the world; it only diffs what the host actually saw.
 */
function observe(
  session: { voxel: { observe: (o: Observation) => ChangeReport } },
  sessionId: string,
  state: { name: string; properties: Record<string, string> },
  pos: Vec3Like,
  sequence: number,
): ChangeReport {
  return session.voxel.observe({
    worldId: WORLD, dim: DIM, sessionId, observedAt: NOW, sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state, pos,
  });
}

function sampleAt(executionId: string, pos: Vec3Like): BodySample {
  return {
    worldId: WORLD, dim: DIM, sessionId: 'conn-1', executionId, sequence: 1,
    pos: { ...pos }, observedAt: NOW, alive: true, connected: true,
    observationReady: true, onGround: true, inWater: false,
  };
}

const POINTS: Vec3Like[] = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' } as const;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-session-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // ---- 1. Host startup: host owns the path + worldId, awaits the map ----
    // `openSpatialSession` resolves only after the committed state (if any) has
    // been restored. Use the returned `session.voxel` — do not construct a new
    // VoxelMap per action.
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    const map = session.voxel; // the single shared map

    // ---- 2. Perception: the host writes what it actually saw ----
    map.beginSession('conn-1');
    let seq = 0;
    for (let x = 0; x <= 3; x++) {
      observe(session, 'conn-1', STONE, { x, y: -1, z: 0 }, ++seq);
      observe(session, 'conn-1', AIR, { x, y: 0, z: 0 }, ++seq);
      observe(session, 'conn-1', AIR, { x, y: 1, z: 0 }, ++seq);
    }

    // ---- 5. Route lifecycle: verify → execute → release (delegation 1) ----
    // Two walk delegations share the same `map`; the library orchestrates each
    // one independently. Cancelling/ending one never touches the other or the
    // shared session.
    const loopA = new WalkRouteExecutor(map, new FakeExecutor(), { now: () => NOW });
    const started = loopA.start({
      worldId: WORLD, dim: DIM, sessionId: 'conn-1', mode: 'walk', body: BODY,
      points: POINTS, arrival: { kind: 'exact' }, shapeProvider,
      deadlineMs: 100_000, timeoutMs: 10_000,
    });
    loopA.onSample(sampleAt(started.delegationId, POINTS[0]!));
    loopA.advance(10);
    await Promise.resolve();
    loopA.advance(10);
    await Promise.resolve();
    console.log('delegation A outcome:', loopA.status()!.result?.outcome);

    // ---- 4. Perception update mid-flight: forward the ChangeReport ----
    // A second delegation runs on the same map. A fresh observation is written
    // first, then its report invalidates/re-verifies the affected steps.
    const verifier = new RouteVerifier(map, { now: () => NOW });
    verifier.register({
      worldId: WORLD, dim: DIM, sessionId: 'conn-1', mode: 'walk', body: BODY,
      shapeProvider, points: POINTS,
    });
    verifier.advance(10);
    console.log('route verdict after perception:', verifier.status()!.verdict);

    const report = observe(session, 'conn-1', AIR, { x: 2, y: 0, z: 0 }, ++seq);
    verifier.apply(report, 10); // only the touched steps re-verify
    console.log('route verdict after ChangeReport:', verifier.status()!.verdict);

    // ---- 3. Reconnect: a new connection session; late old evidence is dropped ----
    map.beginSession('conn-2'); // host reconnected; same worldId stays
    const late = observe(session, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, ++seq);
    console.log('late conn-1 evidence changed sections:', late.sections.length);

    // ---- 6. Save & close: checkpoint → flush → close ----
    // `checkpoint` captures and commits the current state (the only save
    // trigger). `flush` only waits for an already-accepted save; it never
    // captures new changes. `close` performs a bounded shutdown.
    await session.checkpoint();
    const flushed = await session.flush();
    const closed = await session.close();
    console.log('close completed:', closed.completed, '| dirty:', closed.dirty, '| flush dirty:', flushed.dirty);

    // ---- 7. Restore: history + original times return STALE ----
    const reopened = await openSpatialSession({ databasePath, worldId: WORLD });
    const cell = reopened.voxel.cellAt(DIM, 0, -1, 0);
    console.log(
      'restored cell:',
      cell.observed ? `${cell.evidence.observation.state.name}@${cell.evidence.observation.observedAt} (${cell.evidence.freshness})` : 'unobserved',
    );
    // Restored evidence is STALE: passability must be re-established with a new
    // observation session, not read back from disk as a current OPEN.
    await reopened.close();

    console.log('note: no world scan, no real body control, no current OPEN reused above.');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

void main();
