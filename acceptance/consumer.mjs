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
 * isolation → pin protection independent of dirty (route + hanging walk) → final
 * persistence with a unique fact and exact checkpoint confirmation.
 *
 * CLI mutation modes (each is a separate process run against a fresh temp dir;
 * a mutation makes a specific *positive* assertion fail so the orchestrator sees
 * a non-zero exit — it is never treated as success by this consumer itself):
 *
 *   --early-release-pin      release the pin lease before the in-flight free(),
 *                            so the "dependency is pinned" assertions fail.
 *   --skip-final-checkpoint  skip the final checkpoint, so the reopened unique
 *                            fact is absent and the final-fact assertions fail.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { RouteVerifier, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import {
  openSpatialSession,
  WorkingSetManager,
} from 'curio-minecraft-3d-memory/storage/sqlite';

const MUTATIONS = {
  earlyReleasePin: process.argv.includes('--early-release-pin'),
  skipFinalCheckpoint: process.argv.includes('--skip-final-checkpoint'),
};

const WORLD = 'world';
const DIM = 'overworld';
const STONE = { name: 'minecraft:stone', properties: {} };
const AIR = { name: 'minecraft:air', properties: {} };
// A unique final fact: a never-before-observed cell with a nonempty-property state.
const UNIQUE_STATE = { name: 'minecraft:oak_log', properties: { axis: 'y' } };

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

/**
 * A controllable single-step executor whose `move` never resolves on its own.
 * The test drives completion explicitly (deferred resolve) so the in-flight walk
 * is truly held while pin-protection assertions run, and can be finished or
 * cancelled at a chosen time.
 */
class HangingExecutor {
  constructor(observedAt = 2000) {
    this.seq = 1;
    this.observedAt = observedAt;
    this.pending = [];
    this.stoppedIds = [];
  }

  move(request) {
    return new Promise((resolveMove) => {
      this.pending.push({ request, resolveMove });
    });
  }

  stop(executionId) {
    this.stoppedIds.push(executionId);
    // Deliberately no-op: the caller controls completion, so stop() must not
    // resolve the pending move (that would defeat the hanging-body contract).
  }

  /** Resolve the oldest in-flight move with a confirming sample at `pos`. */
  complete(pos) {
    const entry = this.pending.shift();
    if (!entry) throw new Error('no in-flight move to complete');
    entry.resolveMove({
      sample: {
        worldId: entry.request.worldId,
        dim: entry.request.dim,
        sessionId: entry.request.sessionId,
        executionId: entry.request.executionId,
        sequence: ++this.seq,
        pos: { ...pos },
        observedAt: this.observedAt,
        alive: true,
        connected: true,
        observationReady: true,
        onGround: true,
        inWater: false,
      },
    });
  }
}

function sampleAt(executionId, pos, observedAt = 2000) {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 'live',
    executionId,
    sequence: 1,
    pos: { ...pos },
    observedAt,
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

function sameKey(a, b) {
  return a.worldId === b.worldId && a.dim === b.dim && a.cx === b.cx && a.cz === b.cz && a.sy === b.sy;
}

function fmtKey(key) {
  return `(${key.dim}, ${key.cx}, ${key.cz}, ${key.sy})`;
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

/** True when `child` is a strict descendant of `parent` (both absolute paths). */
function isDescendant(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-acceptance-'));
  const databasePath = join(dir, 'spatial.db');
  const opened = [];

  const open = async (options = {}) => {
    const s = await openSpatialSession({ databasePath, worldId: WORLD, ...options });
    opened.push(s);
    return s;
  };

  let primaryError = null;
  try {
    // ===== 1. Entry points + worker startup =====
    assert.equal(typeof RouteVerifier, 'function', 'root entry exports RouteVerifier');
    assert.equal(typeof WalkRouteExecutor, 'function', 'root entry exports WalkRouteExecutor');
    assert.equal(typeof openSpatialSession, 'function', 'storage/sqlite exports openSpatialSession');
    assert.equal(typeof WorkingSetManager, 'function', 'storage/sqlite exports WorkingSetManager');

    // ===== 2. Save & restore (baseline at observedAt=1000) =====
    {
      const s = await open();
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
      const s = await open();
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

    // ===== 4. Pin protection independent of dirty (manual residency) =====
    {
      const s = await open({
        voxelLoading: 'manual',
        residencyLimits: { maxResidentSections: 6 },
      });
      const manager = new WorkingSetManager(s);

      // (Re)establish fresh + clean route facts at `t`: load the sections, observe
      // at `t`, checkpoint (clean), verify OPEN, and collect the real dependency
      // keys. Returns those keys. A later re-establish uses a newer `t` so the
      // re-observation genuinely restores FRESH (same-timestamp re-observation is a
      // no-op), which matters after a previous case evicted the sections.
      async function establishFreshCleanDeps(t) {
        const load = await manager.prepare([keyAt(0, -1), keyAt(0, 0)]);
        assert.equal(load.status, 'ready', 'route sections load');
        s.releasePins([load.lease.token]);

        observeRoute(s, 'live', t);
        const cp = await s.checkpoint();
        assert.ok(cp.checkpointId, 'route facts checkpointed');
        assert.equal(s.getPersistenceState().dirty, false, 'clean after route checkpoint');

        const verifier = new RouteVerifier(s.voxel, { now: () => t });
        verifier.register(routeRequest('live'));
        const status = verifier.advance(10);
        assert.equal(status.verdict, 'OPEN', 'route OPEN with fresh evidence');
        const deps = collectDeps(status);
        assert.ok(deps.length > 0, 'route reports concrete section dependencies');

        // Every dependency section is clean: global dirty is false and each section
        // has a committed (on-disk) record, so nothing is pending/dirty at pin time.
        for (const key of deps) {
          const residency = s.sectionResidency(key);
          assert.equal(residency.residency, 'resident', `dependency ${fmtKey(key)} resident`);
          assert.ok(residency.committed !== undefined, `dependency ${fmtKey(key)} committed`);
        }
        return deps;
      }

      // One pin case: protect deps, run a hanging walk, free while active, finish
      // (ARRIVED) or cancel, then release the pin and prove recyclability.
      async function pinCase(deps, completion, earlyRelease, t) {
        const lease = await manager.prepare(deps);
        assert.equal(lease.status, 'ready', 'route dependencies prepared');
        assert.ok(lease.lease.token, 'prepare hands out a valid lease token');

        const body = new HangingExecutor(t);
        const loop = new WalkRouteExecutor(s.voxel, body, { now: () => t });
        const started = loop.start({
          ...routeRequest('live'),
          arrival: { kind: 'exact' },
          deadlineMs: 100_000,
          timeoutMs: 10_000,
        });
        loop.onSample(sampleAt(started.delegationId, POINTS[0], t));
        loop.advance(10);
        await Promise.resolve();
        const active = loop.status();
        assert.notEqual(active.activeStepIndex, null, 'a step is in flight');
        assert.equal(active.result, null, 'no terminal result while in flight');

        if (earlyRelease) {
          // NEGATIVE mutation: drop protection before the in-flight free so the
          // "pinned" assertions below must fail (deps become evictable).
          s.releasePins([lease.lease.token]);
        }

        const freeActive = manager.free();
        for (const key of deps) {
          const rejected = freeActive.evictionRejected.find((r) => sameKey(r.key, key));
          assert.ok(rejected, `dependency ${fmtKey(key)} stays pinned during the active walk`);
          assert.equal(rejected.reason, 'pinned', `dependency ${fmtKey(key)} rejection reason is exactly 'pinned'`);
        }
        assert.equal(freeActive.evicted.length, 0, 'nothing evicted while dependencies are pinned');

        if (completion === 'finish') {
          body.complete(POINTS[1]);
          await Promise.resolve();
          loop.advance(10);
          await Promise.resolve();
          body.complete(POINTS[2]);
          await Promise.resolve();
          loop.advance(10);
          await Promise.resolve();
          assert.equal(loop.status().result?.outcome, 'ARRIVED', 'walk finishes ARRIVED');
        } else {
          const cancelled = loop.cancel('user', 'acceptance cancellation');
          assert.equal(cancelled.outcome, 'CANCELLED', 'walk cancels cleanly');
        }

        // Release the caller's pin: the deps must now be recyclable with no other
        // pin and no new dirty (they were committed before pinning).
        s.releasePins([lease.lease.token]);
        const freeAfter = manager.free();
        for (const key of deps) {
          const rejected = freeAfter.evictionRejected.find((r) => sameKey(r.key, key));
          assert.equal(rejected, undefined, `dependency ${fmtKey(key)} recycled after release`);
          assert.ok(freeAfter.evicted.some((k) => sameKey(k, key)), `dependency ${fmtKey(key)} actually reclaimed`);
        }
      }

      const deps = await establishFreshCleanDeps(2000);
      await pinCase(deps, 'finish', MUTATIONS.earlyReleasePin, 2000);

      await establishFreshCleanDeps(3000);
      await pinCase(deps, 'cancel', false, 3000);

      // Two overlapping leases over the same deps (now STALE-but-committed after the
      // cancellation case reclaimed them): releasing the old token must leave the new
      // lease protecting the deps; releasing the new token must allow real reclamation.
      {
        const lease1 = await manager.prepare(deps);
        assert.equal(lease1.status, 'ready', 'first overlapping lease ready');
        const lease2 = await manager.prepare(deps);
        assert.equal(lease2.status, 'ready', 'second overlapping lease ready');

        s.releasePins([lease1.lease.token]);
        const freeOverlap1 = manager.free();
        for (const key of deps) {
          const rejected = freeOverlap1.evictionRejected.find((r) => sameKey(r.key, key));
          assert.ok(rejected, `old token released but ${fmtKey(key)} still protected by new lease`);
          assert.equal(rejected.reason, 'pinned', 'remaining protection reason is exactly pinned');
        }

        s.releasePins([lease2.lease.token]);
        const freeOverlap2 = manager.free();
        for (const key of deps) {
          const rejected = freeOverlap2.evictionRejected.find((r) => sameKey(r.key, key));
          assert.equal(rejected, undefined, `new token released so ${fmtKey(key)} reclaimed`);
          assert.ok(freeOverlap2.evicted.some((k) => sameKey(k, key)), `dependency ${fmtKey(key)} actually reclaimed`);
        }
      }

      const closed = await s.close();
      assert.equal(closed.completed, true, 'manual session closes cleanly');
    }

    // ===== 5. Final persistence: unique fact + exact confirmation + reopen =====
    {
      const s = await open();

      // A unique new cell with a nonempty-property state, live session, observedAt 2000.
      s.voxel.beginSession('live');
      s.voxel.observe({
        worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1,
        source: 'vision', evidence: 'seen', stateComplete: true, state: UNIQUE_STATE,
        pos: { x: 4, y: 0, z: 0 },
      });

      if (!MUTATIONS.skipFinalCheckpoint) {
        const cp = await s.checkpoint();
        assert.ok(cp.checkpointId, 'final checkpoint returns a confirmation id');
        const ps = s.getPersistenceState();
        assert.equal(ps.lastConfirmedCheckpointId, cp.checkpointId, 'final checkpointId confirmed');
        assert.equal(ps.confirmedVoxelRevision, cp.voxelRevision, 'voxel revision confirmed');
        assert.equal(ps.dirty, false, 'clean after final checkpoint (no later writes)');
      }

      // Neither flush nor close auto-saves an uncheckpointed fact.
      const flush = await s.flush();
      assert.equal(flush.pending, false, 'flush never captures new memory changes');

      const closed = await s.close();
      assert.equal(closed.completed, true, 'final session closes cleanly');
      assert.equal(closed.unconfirmedRequest, false, 'no unconfirmed request at close');
      assert.equal(closed.error, null, 'no error at close');
      if (MUTATIONS.skipFinalCheckpoint) {
        // The uncheckpointed fact is still dirty: close did not silently save it.
        assert.equal(closed.dirty, true, 'close does not auto-save the uncheckpointed fact');
      } else {
        assert.equal(closed.dirty, false, 'nothing dirty at final close');
      }

      // Reopen and verify the full unique fact; a skipped checkpoint reads the old
      // baseline where this cell was never observed (so the next assertion fails).
      const s2 = await open();
      const cell = s2.voxel.cellAt(DIM, 4, 0, 0);
      assert.equal(cell.observed, true, 'reopen has the unique final fact');
      assert.equal(cell.evidence.freshness, 'STALE', 'restored unique fact is STALE');
      assert.equal(cell.evidence.observation.state.name, 'minecraft:oak_log', 'unique state name preserved');
      assert.deepEqual(cell.evidence.observation.state.properties, { axis: 'y' }, 'full exact properties preserved');
      assert.equal(cell.evidence.observation.observedAt, 2000, 'original observedAt preserved');
      assert.equal(cell.evidence.observation.sessionId, 'live', 'original live session preserved');
      assert.equal(cell.evidence.observation.stateComplete, true, 'state completeness preserved');

      // Reads never refresh evidence time or dirty the session.
      const again = s2.voxel.cellAt(DIM, 4, 0, 0);
      assert.equal(again.evidence.freshness, 'STALE', 'read keeps the fact STALE');
      assert.equal(again.evidence.observation.observedAt, 2000, 'read never refreshes observation time');
      assert.equal(s2.getPersistenceState().dirty, false, 'read never dirties the session');

      const closed2 = await s2.close();
      assert.equal(closed2.completed, true, 'reopen session closes cleanly');
    }

    console.log('consumer acceptance: PASS (all assertions held)');
  } catch (err) {
    primaryError = err;
  }

  // Close every still-open session (secondary cleanup); never mask the primary error.
  const closeErrors = [];
  for (const s of opened) {
    if (s.lifecycle === 'closed') continue;
    try {
      await s.close();
    } catch (err) {
      closeErrors.push(err);
    }
  }

  // Clean up only after closure; the dir is created here so it is an absolute
  // descendant of tmpdir, but verify before recursive removal. Preserve the dir
  // (and never print a false "saved") when a close failed.
  if (closeErrors.length === 0 && isDescendant(tmpdir(), dir)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      closeErrors.push(err);
    }
  }

  if (primaryError) {
    console.error('consumer acceptance: FAIL (primary)');
    console.error(primaryError);
  }
  if (closeErrors.length > 0) {
    console.error(`consumer acceptance: secondary close/cleanup error(s); preserving directory ${dir}`);
    for (const err of closeErrors) console.error(err);
  }

  return primaryError ? 1 : 0;
}

run().then((code) => {
  process.exitCode = code;
});
