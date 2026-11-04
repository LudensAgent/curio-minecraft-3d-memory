import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VoxelMap } from '../dist/index.js';
import { PersistenceError } from '../dist/storage/sqlite/index.js';
import {
  DIM,
  HangingExecutor,
  NOW,
  WORLD,
  assertCancelled,
  assertCleanSaveRun,
  assertDisconnected,
  registerConn1Verifier,
  runCancelChannel,
  runCapacityLifecycle,
  runDisconnectScenario,
  runPrimaryLifecycle,
  seedCorridor,
  startConn1Walk,
  writeRunReport,
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

  it('negative A: the shared invariant fails when the verifier report is omitted', () => {
    // Omit only the report dispatch to the readonly verifier and run the *shared*
    // invariant — the verifier stays OPEN, so the success assertion must throw.
    expect(() => assertDisconnected(runDisconnectScenario(() => NOW, { skipVerifierReport: true }))).toThrow(
      'old verifier must no longer be OPEN',
    );
  });

  it('cancel channel positive: the real cancel ends the in-flight step and stops only the old move', () => {
    // The isolated channel: in-flight step + empty report + the *real* cancel. The
    // empty report cannot end the step, so the success invariant holds only via cancel.
    assertCancelled(runCancelChannel(freshMap(), () => NOW));
  });

  it('cancel channel negative: without the cancel an empty report cannot end the step', () => {
    // Same isolated channel with the cancel omitted; the empty report does nothing, so
    // the old step stays in flight and the shared success assertion must throw.
    expect(() => assertCancelled(runCancelChannel(freshMap(), () => NOW, true))).toThrow(
      'cancel must end the old step immediately',
    );
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
  it('normal save and close report confirmed, clean fields, and the dir is cleaned up', async () => {
    // The same boundary `main` uses; the shared assertion checks the full close fields.
    const run = await runPrimaryLifecycle();
    assertCleanSaveRun(run);
    expect(existsSync(run.dir)).toBe(false); // cleaned up only after known clean closure
  });

  it('reopen happens only after the primary session is closed', async () => {
    const order: string[] = [];
    const run = await runPrimaryLifecycle({
      closeSession: async (session) => {
        const real = await session.close();
        order.push('close');
        return real;
      },
      afterReopen: () => order.push('reopen'),
    });
    // primary close → reopen → boundary closes the reopened session.
    expect(order).toEqual(['close', 'reopen', 'close']);
    assertCleanSaveRun(run);
  });

  it('the conn-2 re-observation survives save/restore with its original time and scope', async () => {
    let restored: { sessionId: string; observedAt: number; freshness: string } | null = null;
    const run = await runPrimaryLifecycle({
      afterReopen: (reopened) => {
        const cell = reopened.voxel.cellAt(DIM, 0, 0, 0);
        if (cell.observed) {
          restored = {
            sessionId: cell.evidence.observation.sessionId,
            observedAt: cell.evidence.observation.observedAt,
            freshness: cell.evidence.freshness,
          };
        }
      },
    });

    assertCleanSaveRun(run);
    expect(restored).toEqual({
      sessionId: 'conn-2', // the re-observation scope is preserved
      observedAt: NOW + 1000, // the original time is preserved
      freshness: 'STALE', // restored, not re-freshened
    });
  });

  it('a non-clean primary close prevents reopen', async () => {
    let reopened = false;
    const run = await runPrimaryLifecycle({
      closeSession: async (session) => {
        const real = await session.close(); // still terminate the real worker
        return { ...real, completed: false, error: new PersistenceError('worker_communication', 'injected close failure') };
      },
      afterReopen: () => {
        reopened = true;
      },
    });

    expect(reopened).toBe(false); // failure prevents reopen
    expect(run.closes.length).toBe(1); // only the primary close happened
    expect(run.primary).toBeInstanceOf(Error);
    expect(run.retained).toBe(true);
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
    expect(existsSync(run.dir)).toBe(true); // retained directory still on disk
    expect(run.closes[0]!.dirty).toBe(true); // unsaved observations remain
  });

  it('cleanup failure alone is a failure and retains the directory', async () => {
    const run = await runPrimaryLifecycle({
      cleanupDir: () => {
        throw new Error('injected cleanup failure');
      },
    });

    expect(run.ok).toBe(false);
    expect(run.primary).toBeNull(); // no domain error: the cleanup failure is the failure
    expect(run.cleanupError).toBeInstanceOf(Error);
    expect(run.retained).toBe(true);
    expect(existsSync(run.dir)).toBe(true);
  });

  it('a non-clean close after a primary error retains the directory and preserves the primary', async () => {
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
    expect(existsSync(run.dir)).toBe(true);
  });

  it('a thrown close after a primary error is secondary (no fabricated CloseResult) and retains the dir', async () => {
    const run = await runCapacityLifecycle({
      closeSession: async (session) => {
        await session.close(); // still terminate the real worker
        throw new Error('injected close throw');
      },
    });

    expect(run.primary).toBeInstanceOf(PersistenceError);
    expect((run.primary as PersistenceError).kind).toBe('capacity');
    expect(run.closes).toHaveLength(0); // no fabricated close record
    expect(run.closeErrors).toHaveLength(1); // the original close exception, secondary
    expect(run.retained).toBe(true);
  });

  it('the shared report keeps the capacity primary and shows the retained directory', async () => {
    const run = await runCapacityLifecycle({
      closeSession: async (session) => {
        const real = await session.close();
        return { ...real, completed: false, error: new PersistenceError('worker_communication', 'injected close failure') };
      },
    });

    const lines: string[] = [];
    writeRunReport((line) => lines.push(line), 'L2 capacity', run);
    const text = lines.join('\n');
    expect(text).toContain('capacity');
    expect(text).toContain('maxVoxelSections');
    expect(text).toContain('retainedDir=');
    expect(text).toContain(run.dir);
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
