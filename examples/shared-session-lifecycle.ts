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
 * Disconnect order is fixed and matters: cancel the old delegation *first* (no
 * further physics frame), then produce and dispatch the lifecycle reports
 * (`markStale` / `beginSession`) to the active verifier and executor. A readonly
 * verifier never refreshes itself when the map session changes — it must receive
 * the report explicitly.
 *
 * Run with (the package self-resolves its own name through `exports`):
 *
 *   npm run build
 *   npx tsx examples/shared-session-lifecycle.ts
 */

import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  WalkRouteRequest,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

export const WORLD = 'world';
export const DIM = 'overworld';
export const STONE = { name: 'minecraft:stone', properties: {} };
export const AIR = { name: 'minecraft:air', properties: {} };
export const NOW = 2000;

export const shapeProvider: CollisionShapeProvider = {
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

/**
 * A Fake body that never advances on its own: `move` leaves the returned promise
 * pending until the host stops the delegation. This keeps a started step in flight
 * (`activeStepIndex !== null`, empty `result`) so the disconnect wiring can be
 * observed. `stop` belongs to the delegation and only releases the pending promise
 * with a cancellation — it never fabricates a body sample.
 */
export class HangingExecutor implements MoveExecutor {
  readonly stopCalls: string[] = [];
  lastRequest: ExecutableMove | null = null;
  private resolve: ((result: ExecutableMoveResult) => void) | null = null;

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.lastRequest = request;
    return new Promise<ExecutableMoveResult>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(executionId: string): void {
    this.stopCalls.push(executionId);
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve !== null) resolve({ failure: { kind: 'cancelled' } });
  }
}

/**
 * Host perception: write one real observation into the shared map and hand the
 * resulting `ChangeReport` back so the caller can forward it to any active route
 * (via `RouteVerifier.apply` / `WalkRouteExecutor.observe`). The library never
 * scans the world; it only diffs what the host actually saw.
 */
export function observe(
  map: { observe: (o: Observation) => ChangeReport },
  sessionId: string,
  state: { name: string; properties: Record<string, string> },
  pos: Vec3Like,
  sequence: number,
  observedAt: number,
): ChangeReport {
  return map.observe({
    worldId: WORLD, dim: DIM, sessionId, observedAt, sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state, pos,
  });
}

/** A measured body sample keyed to one execution. Host pushes use the delegation id. */
export function sampleAt(
  executionId: string,
  sessionId: string,
  pos: Vec3Like,
  sequence = 1,
  observedAt = NOW,
): BodySample {
  return {
    worldId: WORLD, dim: DIM, sessionId, executionId, sequence,
    pos: { ...pos }, observedAt, alive: true, connected: true,
    observationReady: true, onGround: true, inWater: false,
  };
}

export const POINTS: Vec3Like[] = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

export const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' } as const;

/** A walk delegation request for the shared route, bound to one connection session. */
export function walkRequest(sessionId: string): WalkRouteRequest {
  return {
    worldId: WORLD, dim: DIM, sessionId, mode: 'walk', body: BODY,
    points: POINTS, arrival: { kind: 'exact' }, shapeProvider,
    deadlineMs: 100_000, timeoutMs: 10_000,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Remove only the task-created temp directory (a child of the OS temp dir). */
function removeTaskDir(dir: string): void {
  const root = resolve(dir);
  const tmp = resolve(tmpdir());
  if (root !== tmp && !root.startsWith(tmp + sep)) {
    throw new Error(`refusing to delete outside the task temp dir: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Seed the shared map with the grounded corridor used by every scenario. */
function seedCorridor(map: { observe: (o: Observation) => ChangeReport }): void {
  let seq = 0;
  for (let x = 0; x <= 3; x++) {
    observe(map, 'conn-1', STONE, { x, y: -1, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 0, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 1, z: 0 }, ++seq, NOW);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-session-'));
  try {
    await runLifecycle(dir);
    console.log('shared-session-lifecycle: all checks passed; temp dir removed.');
  } finally {
    removeTaskDir(dir);
  }
}

async function runLifecycle(dir: string): Promise<void> {
  const databasePath = join(dir, 'spatial.db');
  const capacityPath = join(dir, 'capacity.db');

  // ---- 1–5. Primary session: perception, route lifecycle, disconnect, save ----
  let now = NOW;
  const session = await openSpatialSession({
    databasePath,
    worldId: WORLD,
    voxelOptions: { now: () => now },
  });
  try {
    const map = session.voxel;
    map.beginSession('conn-1');
    seedCorridor(map);

    // A readonly verifier and a pending walk, both under conn-1.
    const verifier = new RouteVerifier(map, { now: () => now });
    verifier.register({
      worldId: WORLD, dim: DIM, sessionId: 'conn-1', mode: 'walk',
      body: BODY, shapeProvider, points: POINTS,
    });
    verifier.advance(10);
    assert(verifier.status()!.verdict === 'OPEN', 'conn-1 route should verify OPEN');

    const body = new HangingExecutor();
    const walk = new WalkRouteExecutor(map, body, { now: () => now });
    const started = walk.start(walkRequest('conn-1'));
    walk.onSample(sampleAt(started.delegationId, 'conn-1', POINTS[0]!));
    walk.advance(10);
    assert(walk.status()!.activeStepIndex !== null && walk.status()!.result === null, 'walk should be in flight');

    // ---- 3. Disconnect: cancel first (no further frame), then dispatch reports ----
    walk.cancel('lifecycle', 'connection lost');
    const staleReport = map.markStale(DIM, 'observation_gap');
    const switchReport = map.beginSession('conn-2');
    verifier.apply(staleReport, 10);
    verifier.apply(switchReport, 10);
    walk.observe(staleReport, 10);
    walk.observe(switchReport, 10);

    assert(verifier.status()!.verdict !== 'OPEN', 'old verifier must no longer be OPEN');
    assert(walk.status()!.activeStepIndex === null, 'old walk must have ended');
    assert(walk.status()!.result?.outcome === 'CANCELLED', 'old walk must be cancelled');

    // Old evidence cannot refresh new facts; only a freshly re-observed cell is FRESH.
    const late = observe(map, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, 99, now);
    assert(late.sections.length === 0, 'late conn-1 evidence must be rejected');
    now = 3000;
    observe(map, 'conn-2', AIR, { x: 0, y: 0, z: 0 }, 100, now);
    const fresh = map.cellAt(DIM, 0, 0, 0);
    const neighbor = map.cellAt(DIM, 1, 0, 0);
    assert(fresh.observed && fresh.evidence.freshness === 'FRESH', 're-observed cell must be FRESH');
    assert(neighbor.observed && neighbor.evidence.freshness === 'STALE', 'neighbor cell must stay STALE');

    // ---- 6. Normal save: checkpoint → flush → close with confirmed, clean fields ----
    const cp = await session.checkpoint();
    const flushed = await session.flush();
    const state = session.getPersistenceState();
    assert(cp.checkpointId === state.lastConfirmedCheckpointId, 'checkpoint id must equal last confirmed');
    assert(cp.voxelRevision === state.confirmedVoxelRevision, 'voxel revision must equal confirmed');
    assert(state.dirty === false, 'save must not be dirty');
    assert(flushed.dirty === false, 'flush must report not dirty');
  } finally {
    const closed = await session.close();
    assert(closed.completed, 'primary session close must complete');
  }

  // ---- 7. Restore: reopened evidence comes back STALE; close even on a later failure ----
  const reopened = await openSpatialSession({ databasePath, worldId: WORLD });
  try {
    const cell = reopened.voxel.cellAt(DIM, 0, 0, 0);
    assert(cell.observed && cell.evidence.freshness === 'STALE', 'restored evidence must be STALE');
  } finally {
    await reopened.close();
  }

  // ---- L2: real capacity rejection; the PersistenceError stays primary ----
  const capSession = await openSpatialSession({
    databasePath: capacityPath,
    worldId: WORLD,
    snapshotLimits: { maxVoxelSections: 1 },
  });
  let primary: PersistenceError | null = null;
  try {
    const map = capSession.voxel;
    map.beginSession('cap-1');
    observe(map, 'cap-1', STONE, { x: 0, y: -1, z: 0 }, 1, now); // section sy = -1
    observe(map, 'cap-1', AIR, { x: 0, y: 0, z: 0 }, 2, now); // section sy = 0
    try {
      await capSession.checkpoint();
      throw new Error('checkpoint unexpectedly succeeded under maxVoxelSections=1');
    } catch (err) {
      if (!(err instanceof PersistenceError)) throw err;
      primary = err;
    }
  } finally {
    // Close is secondary cleanup: it must never replace the primary capacity error.
    const closed = await capSession.close();
    assert(closed.dirty, 'capacity rejection must leave unsaved observations');
  }
  assert(primary !== null && primary.kind === 'capacity', 'capacity rejection expected');
  assert(/maxVoxelSections/.test(primary.message), 'capacity message must name the limit');

  // ---- Windows proof: no handle remains — rename succeeds only with locks released ----
  renameSync(databasePath, join(dir, 'closed.db'));
}

const isMain =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error('shared-session-lifecycle failed:', err);
    process.exitCode = 1;
  });
}
