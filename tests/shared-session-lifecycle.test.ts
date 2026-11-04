import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteVerifier, VoxelMap, WalkRouteExecutor } from '../src/index.js';
import { openSpatialSession, PersistenceError } from '../dist/storage/sqlite/index.js';
import type { CloseResult, SpatialSession } from '../dist/storage/sqlite/index.js';
import {
  AIR,
  BODY,
  DIM,
  HangingExecutor,
  NOW,
  POINTS,
  STONE,
  WORLD,
  observe,
  sampleAt,
  shapeProvider,
  walkRequest,
} from '../examples/shared-session-lifecycle.js';

function freshMap(): VoxelMap {
  return new VoxelMap(WORLD, { now: () => NOW, requireSession: true });
}

function seedCorridor(map: VoxelMap): void {
  map.beginSession('conn-1');
  let seq = 0;
  for (let x = 0; x <= 3; x++) {
    observe(map, 'conn-1', STONE, { x, y: -1, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 0, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 1, z: 0 }, ++seq, NOW);
  }
}

function registerVerifier(map: VoxelMap): RouteVerifier {
  const verifier = new RouteVerifier(map, { now: () => NOW });
  verifier.register({
    worldId: WORLD, dim: DIM, sessionId: 'conn-1', mode: 'walk',
    body: BODY, shapeProvider, points: POINTS,
  });
  verifier.advance(10);
  return verifier;
}

function startPendingWalk(map: VoxelMap): WalkRouteExecutor {
  const walk = new WalkRouteExecutor(map, new HangingExecutor(), { now: () => NOW });
  const started = walk.start(walkRequest('conn-1'));
  walk.onSample(sampleAt(started.delegationId, 'conn-1', POINTS[0]!));
  walk.advance(10);
  return walk;
}

describe('shared-session lifecycle — disconnect wiring (L1)', () => {
  it('disconnect cancels the pending walk then stales the open route and rejects old evidence', () => {
    const map = freshMap();
    seedCorridor(map);
    const verifier = registerVerifier(map);
    const walk = startPendingWalk(map);

    expect(verifier.status()!.verdict).toBe('OPEN');
    expect(walk.status()!.activeStepIndex).not.toBeNull();
    expect(walk.status()!.result).toBeNull();

    // Cancel first — no further physics frame — then dispatch lifecycle reports.
    walk.cancel('lifecycle', 'connection lost');
    const stale = map.markStale(DIM, 'observation_gap');
    const switched = map.beginSession('conn-2');
    verifier.apply(stale, 10);
    verifier.apply(switched, 10);
    walk.observe(stale, 10);
    walk.observe(switched, 10);

    expect(verifier.status()!.verdict).not.toBe('OPEN');
    expect(walk.status()!.activeStepIndex).toBeNull();
    expect(walk.status()!.result?.outcome).toBe('CANCELLED');

    // Old conn-1 evidence is rejected; only a freshly re-observed cell is FRESH.
    expect(observe(map, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, 99, NOW).sections.length).toBe(0);
    expect(observe(map, 'conn-2', AIR, { x: 0, y: 0, z: 0 }, 100, NOW + 1000).sections.length).toBeGreaterThan(0);
    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true, evidence: { freshness: 'FRESH' } });
    expect(map.cellAt(DIM, 1, 0, 0)).toMatchObject({ observed: true, evidence: { freshness: 'STALE' } });
  });

  it('negative A: without report dispatch the readonly verifier stays OPEN', () => {
    const map = freshMap();
    seedCorridor(map);
    const verifier = registerVerifier(map);
    const walk = startPendingWalk(map);

    // Disconnect WITHOUT dispatching lifecycle reports to the readonly verifier.
    walk.cancel('lifecycle', 'connection lost');
    map.markStale(DIM, 'observation_gap');
    map.beginSession('conn-2');

    // The walk is cancelled, but the untouched verifier still reads OPEN — the bug
    // this control identifies is independent of the executor cancel.
    expect(walk.status()!.result?.outcome).toBe('CANCELLED');
    expect(verifier.status()!.verdict).toBe('OPEN');
  });

  it('negative B: an empty lifecycle report and no cancel leaves the walk pending', () => {
    const map = freshMap();
    seedCorridor(map);
    const walk = startPendingWalk(map);

    // Disconnect with no cancel and no body frames; the lifecycle report is empty
    // (a dimension with no observed sections), so dispatch cannot end the walk.
    const empty = map.markStale('nether', 'observation_gap');
    expect(empty.sections.length).toBe(0);
    walk.observe(empty, 10);

    expect(walk.status()!.activeStepIndex).not.toBeNull();
    expect(walk.status()!.result).toBeNull();
  });
});

describe('shared-session lifecycle — save, close, restore (L2)', () => {
  it('checkpoint and close report confirmed, clean save fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-save-'));
    const db = join(dir, 'spatial.db');
    try {
      const session = await openSpatialSession({ databasePath: db, worldId: WORLD });
      try {
        session.voxel.beginSession('conn-1');
        observe(session.voxel, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, 1, NOW);
        observe(session.voxel, 'conn-1', AIR, { x: 0, y: 0, z: 0 }, 2, NOW);

        const cp = await session.checkpoint();
        const flushed = await session.flush();
        const state = session.getPersistenceState();
        expect(cp.checkpointId).toBe(state.lastConfirmedCheckpointId);
        expect(cp.voxelRevision).toBe(state.confirmedVoxelRevision);
        expect(state.dirty).toBe(false);
        expect(flushed.dirty).toBe(false);
      } finally {
        const closed = await session.close();
        expect(closed.completed).toBe(true);
        expect(closed.unconfirmedRequest).toBe(false);
        expect(closed.dirty).toBe(false);
        expect(closed.error).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('capacity rejection retains the primary PersistenceError; close is secondary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-cap-'));
    const db = join(dir, 'capacity.db');
    let primary: PersistenceError | null = null;
    let closeResult: CloseResult | null = null;
    try {
      const session = await openSpatialSession({
        databasePath: db,
        worldId: WORLD,
        snapshotLimits: { maxVoxelSections: 1 },
      });
      try {
        session.voxel.beginSession('cap-1');
        observe(session.voxel, 'cap-1', STONE, { x: 0, y: -1, z: 0 }, 1, NOW); // section sy = -1
        observe(session.voxel, 'cap-1', AIR, { x: 0, y: 0, z: 0 }, 2, NOW); // section sy = 0
        try {
          await session.checkpoint();
          throw new Error('checkpoint unexpectedly succeeded under maxVoxelSections=1');
        } catch (err) {
          if (!(err instanceof PersistenceError)) throw err;
          primary = err;
        }
      } finally {
        closeResult = await session.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }

    expect(primary).not.toBeNull();
    expect(primary!.kind).toBe('capacity');
    expect(primary!.message).toContain('maxVoxelSections');
    // The unsaved observations remain after a rejected save.
    expect(closeResult!.dirty).toBe(true);
  });

  it('reopened session is closed before cleanup and DB locks release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-reopen-'));
    const db = join(dir, 'spatial.db');
    try {
      const session = await openSpatialSession({ databasePath: db, worldId: WORLD });
      session.voxel.beginSession('conn-1');
      observe(session.voxel, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, 1, NOW);
      observe(session.voxel, 'conn-1', AIR, { x: 0, y: 0, z: 0 }, 2, NOW);
      await session.checkpoint();
      await session.close();

      const reopened: SpatialSession = await openSpatialSession({ databasePath: db, worldId: WORLD });
      let closedCleanly = false;
      try {
        const cell = reopened.voxel.cellAt(DIM, 0, 0, 0);
        expect(cell).toMatchObject({ observed: true, evidence: { freshness: 'STALE' } });
      } finally {
        await reopened.close();
        closedCleanly = reopened.lifecycle === 'closed';
      }
      expect(closedCleanly).toBe(true);

      // A rename succeeds only when no worker/db handle remains open (Windows lock).
      renameSync(db, join(dir, 'closed.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
