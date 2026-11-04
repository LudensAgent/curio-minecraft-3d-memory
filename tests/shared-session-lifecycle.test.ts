import { describe, expect, it } from 'vitest';
import { VoxelMap } from '../dist/index.js';
import { PersistenceError } from '../dist/storage/sqlite/index.js';
import {
  DIM,
  HangingExecutor,
  NOW,
  WORLD,
  assertCleanSaveRun,
  assertDisconnected,
  registerConn1Verifier,
  runCapacityLifecycle,
  runDisconnectScenario,
  runPrimaryLifecycle,
  seedCorridor,
  startConn1Walk,
} from '../examples/shared-session-lifecycle.js';

function freshMap(): VoxelMap {
  return new VoxelMap(WORLD, { now: () => NOW, requireSession: true });
}

describe('shared-session lifecycle — disconnect wiring (L1)', () => {
  it('positive: the shared disconnect wiring cancels, stales, and ignores old evidence', () => {
    // The exact same wiring `main` runs — deleting the cancel or report-dispatch
    // channel makes this assertion fail.
    assertDisconnected(runDisconnectScenario());
  });

  it('negative A: without report dispatch the readonly verifier stays OPEN', () => {
    const map = freshMap();
    seedCorridor(map);
    const verifier = registerConn1Verifier(map, () => NOW);
    const { walk } = startConn1Walk(map, () => NOW);

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
    const { walk } = startConn1Walk(map, () => NOW);

    // Disconnect with no cancel and no body frames; the lifecycle report is empty
    // (a dimension with no observed sections), so dispatch cannot end the walk.
    const empty = map.markStale('nether', 'observation_gap');
    expect(empty.sections.length).toBe(0);
    walk.observe(empty, 10);

    expect(walk.status()!.activeStepIndex).not.toBeNull();
    expect(walk.status()!.result).toBeNull();
  });

  it('late old body frame cannot reactivate control or rewrite the result', () => {
    const map = freshMap();
    seedCorridor(map);
    const { walk, body } = startConn1Walk(map, () => NOW);

    const delegationId = walk.status()!.delegationId;
    walk.cancel('lifecycle', 'connection lost');
    map.beginSession('conn-2');

    // A late frame from the old delegation, after the new connection.
    walk.onSample({
      worldId: WORLD, dim: DIM, sessionId: 'conn-1', executionId: delegationId,
      sequence: 2, pos: { x: 1.5, y: 0, z: 0.5 }, observedAt: NOW + 1000,
      alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
    });

    expect(walk.status()!.result?.outcome).toBe('CANCELLED'); // not rewritten
    expect(walk.status()!.activeStepIndex).toBeNull(); // not reactivated
    expect(body.stopCalls).toEqual([`${delegationId}-step-0`]); // stop ownership, exactly once
    expect(body.lastRequest?.executionId).toBe(`${delegationId}-step-0`); // no new move
  });
});

describe('shared-session lifecycle — save, close, restore (L2)', () => {
  it('normal save and close report confirmed, clean fields', async () => {
    // The same boundary `main` uses; the shared assertion checks the full close fields.
    assertCleanSaveRun(await runPrimaryLifecycle());
  });

  it('capacity rejection keeps the primary PersistenceError; cleanup failure is secondary', async () => {
    const run = await runCapacityLifecycle({
      cleanupDir: () => {
        throw new Error('injected cleanup failure');
      },
    });

    expect(run.primary).toBeInstanceOf(PersistenceError);
    expect((run.primary as PersistenceError).kind).toBe('capacity');
    expect((run.primary as PersistenceError).message).toContain('maxVoxelSections');
    expect(run.cleanupError).toBeInstanceOf(Error);
    expect(run.retained).toBe(true);
    expect(run.closes[0]!.dirty).toBe(true); // unsaved observations remain
  });

  it('cleanup failure alone is a failure', async () => {
    const run = await runPrimaryLifecycle({
      cleanupDir: () => {
        throw new Error('injected cleanup failure');
      },
    });

    expect(run.ok).toBe(false);
    expect(run.primary).toBeNull(); // no domain error: the cleanup failure is the failure
    expect(run.cleanupError).toBeInstanceOf(Error);
    expect(run.retained).toBe(true);
  });

  it('close failure after a primary error retains the directory and preserves the primary', async () => {
    const run = await runCapacityLifecycle({
      closeSession: async (session) => {
        const real = await session.close(); // still terminate the worker (no leak)
        return { ...real, completed: false, error: new PersistenceError('worker_communication', 'injected close failure') };
      },
    });

    expect(run.primary).toBeInstanceOf(PersistenceError);
    expect((run.primary as PersistenceError).kind).toBe('capacity');
    expect(run.closes[0]!.completed).toBe(false);
    expect(run.retained).toBe(true); // shutdown not clean: directory retained
  });

  it('an injected assertion failure after reopen still closes the reopened session', async () => {
    const run = await runPrimaryLifecycle({
      afterReopen: () => {
        throw new Error('injected assertion failure after reopen');
      },
    });

    expect(run.primary).toBeInstanceOf(Error);
    expect(run.closes.length).toBe(2); // primary + reopened both closed by the boundary
    expect(run.closes.every((c) => c.completed)).toBe(true);
    expect(run.retained).toBe(false); // close was clean, cleanup ran
  });
});
