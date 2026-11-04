/**
 * Independent consumer acceptance for the packed `curio-minecraft-3d-memory`
 * package. Run from a throwaway directory that installs the real `.tgz` (never a
 * source path, `../dist`, `npm link`, or a dev-machine alias) so every import
 * below resolves through the installed package's public `exports`.
 *
 * This file is copied into the consumer directory by `run.mjs`; it imports only
 * by package name and public subpath:
 *
 *   curio-minecraft-3d-memory                 (root entry)
 *   curio-minecraft-3d-memory/storage/sqlite  (SQLite persistence entry)
 *
 * Every check is a hard `node:assert` — a failure throws and exits non-zero, so
 * "success" is never a printed summary. It exercises the combined lifecycle that
 * the existing unit tests do not cover in isolation: install → worker startup →
 * save/restore → post-restore STALE passability boundary → fresh re-observation
 * isolation → route protection + Fake walk execution → final persistence.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RouteVerifier, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import {
  openSpatialSession,
  WorkingSetManager,
} from 'curio-minecraft-3d-memory/storage/sqlite';

const WORLD = 'world';
const DIM = 'overworld';
const STONE = { name: 'minecraft:stone', properties: {} };
const AIR = { name: 'minecraft:air', properties: {} };

// A deliberately tiny shape provider: air is empty, everything else is a full
// cube with a walkable top face. This matches the Fake fixtures already used by
// the library's own walk-route tests.
const shapeProvider = {
  version: 'consumer-1',
  resolve(state) {
    if (state.name === 'minecraft:air') {
      return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    }
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
  },
};

class FakeExecutor {
  constructor() {
    this.seq = 1;
  }
  move(request) {
    // Sequence must strictly increase per sample or the executor drops the move
    // result as out-of-order (same contract the library's own Fake fixtures use).
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
  stop() {}
}

function sampleAt(executionId, pos) {
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

function keyAt(cx, sy) {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

/** Observe support (y=-1) + air (y=0,1) along x = 0..3 for a flat walkable line. */
function observeRoute(session, sessionId, observedAt) {
  session.voxel.beginSession(sessionId);
  let sequence = 0;
  for (let x = 0; x <= 3; x++) {
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: STONE,
      pos: { x, y: -1, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: AIR,
      pos: { x, y: 0, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: AIR,
      pos: { x, y: 1, z: 0 },
    });
  }
}

const POINTS = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

function routeRequest(sessionId) {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId,
    mode: 'walk',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    shapeProvider,
    points: POINTS,
  };
}

function collectDeps(status) {
  const deps = [];
  const seen = new Set();
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
  return deps;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-acceptance-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // ===== 1. Entry points + worker startup =====
    assert.equal(typeof RouteVerifier, 'function', 'root entry exports RouteVerifier');
    assert.equal(typeof WalkRouteExecutor, 'function', 'root entry exports WalkRouteExecutor');
    assert.equal(typeof openSpatialSession, 'function', 'storage/sqlite exports openSpatialSession');
    assert.equal(typeof WorkingSetManager, 'function', 'storage/sqlite exports WorkingSetManager');

    // ===== 2. Save & restore =====
    {
      const s = await openSpatialSession({ databasePath, worldId: WORLD });
      assert.equal(s.lifecycle, 'open', 'worker starts and session is open');
      observeRoute(s, 'setup', 1000);
      assert.equal(s.getPersistenceState().dirty, true, 'dirty before first checkpoint');

      const cp = await s.checkpoint();
      assert.ok(cp.checkpointId, 'checkpoint returns a confirmation id');
      assert.equal(s.getPersistenceState().dirty, false, 'clean after checkpoint');

      const closed = await s.close();
      assert.equal(closed.completed, true, 'close completes cleanly');
      assert.equal(closed.dirty, false, 'nothing dirty at close');
    }

    // ===== 3. Restore: original facts, STALE, passability boundary =====
    {
      const s = await openSpatialSession({ databasePath, worldId: WORLD });
      const stone = s.voxel.cellAt(DIM, 0, -1, 0);
      assert.equal(stone.observed, true, 'restored stone cell observed');
      assert.equal(stone.evidence.freshness, 'STALE', 'restored evidence is STALE');
      assert.equal(stone.evidence.observation.state.name, 'minecraft:stone', 'restored state preserved');
      assert.equal(stone.evidence.observation.observedAt, 1000, 'original observedAt preserved');

      // Restored STALE evidence must never read as a current OPEN passability.
      const verifier = new RouteVerifier(s.voxel, { now: () => 2000 });
      verifier.register(routeRequest('live'));
      const status = verifier.advance(10);
      assert.equal(status.verdict, 'STALE', 'restored STALE evidence is not OPEN');

      // A new observation session re-observes exactly one cell; only that cell
      // becomes FRESH — an untouched neighbour must not ride along.
      s.voxel.beginSession('live');
      s.voxel.observe({
        worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1,
        source: 'vision', evidence: 'seen', stateComplete: true, state: STONE,
        pos: { x: 0, y: -1, z: 0 },
      });
      assert.equal(s.voxel.cellAt(DIM, 0, -1, 0).evidence.freshness, 'FRESH', 're-observed cell is FRESH');
      assert.equal(s.voxel.cellAt(DIM, 1, -1, 0).evidence.freshness, 'STALE', 'neighbour stays STALE');

      await s.close();
    }

    // ===== 4. Route protection + Fake walk execution (manual residency) =====
    {
      const s = await openSpatialSession({
        databasePath,
        worldId: WORLD,
        voxelLoading: 'manual',
        residencyLimits: { maxResidentSections: 3 },
      });
      const manager = new WorkingSetManager(s);

      const init = await manager.prepare([keyAt(0, -1), keyAt(0, 0)]);
      assert.equal(init.status, 'ready', 'initial prepare is ready');
      s.releasePins([init.lease.token]);

      // Loaded facts are STALE; restore current evidence with fresh observations.
      observeRoute(s, 'live', 2000);

      const verifier = new RouteVerifier(s.voxel, { now: () => 2000 });
      verifier.register(routeRequest('live'));
      const status = verifier.advance(10);
      assert.equal(status.verdict, 'OPEN', 'route is OPEN with fresh evidence');

      // Protect the sections the route actually depends on.
      const deps = collectDeps(status);
      assert.ok(deps.length > 0, 'route reports concrete section dependencies');
      const lease = await manager.prepare(deps);
      assert.equal(lease.status, 'ready', 'route dependencies prepared and protected');

      // Execute a Fake walk while the dependencies are pinned.
      const loop = new WalkRouteExecutor(s.voxel, new FakeExecutor(), { now: () => 2000 });
      const started = loop.start({
        ...routeRequest('live'),
        arrival: { kind: 'exact' },
        deadlineMs: 100_000,
        timeoutMs: 10_000,
      });
      loop.onSample(sampleAt(started.delegationId, POINTS[0]));
      loop.advance(10);
      await Promise.resolve();
      loop.advance(10);
      await Promise.resolve();
      assert.equal(loop.status().result?.outcome, 'ARRIVED', 'Fake walk reaches ARRIVED');

      // While pinned, freeing space must not evict the route's dependencies.
      const freeWhilePinned = manager.free();
      assert.equal(freeWhilePinned.evicted.length, 0, 'pinned sections are not evicted during execution');

      // Releasing this task's pin lets the manager reclaim them, then save.
      s.releasePins([lease.lease.token]);
      await s.checkpoint();
      const closed = await s.close();
      assert.equal(closed.completed, true, 'manual session closes cleanly');
    }

    // ===== 5. Final persistence =====
    {
      const s = await openSpatialSession({ databasePath, worldId: WORLD });
      const stone = s.voxel.cellAt(DIM, 2, -1, 0);
      assert.equal(stone.observed, true, 'final reopen has persisted stone');
      assert.equal(stone.evidence.observation.state.name, 'minecraft:stone', 'final state preserved');
      const closed = await s.close();
      assert.equal(closed.completed, true, 'final session closes cleanly');
    }

    console.log('consumer acceptance: PASS (all assertions held)');
  } finally {
    // Cleanup is best-effort: on Windows a just-closed SQLite file can remain
    // briefly locked, and a cleanup failure must not mask a passing run (the
    // close() results were already asserted above). The extra retries match the
    // library's own test-suite cleanup.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* ignore cleanup-only failure */
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('consumer acceptance: FAIL');
    console.error(err);
    process.exit(1);
  },
);
