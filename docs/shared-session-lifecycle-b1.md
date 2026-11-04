# Shared-session lifecycle — B1 evidence

Scope: `examples/shared-session-lifecycle.ts` and `tests/shared-session-lifecycle.test.ts`.
No `src`, package manifest, existing design doc, or unrelated worktree file was changed.

## What changed

The reference example now encodes the fixed disconnect order and the bounded
save/close/restore sequence, and exports reusable pieces (`observe`, `sampleAt`,
`walkRequest`, `HangingExecutor`, `shapeProvider`, `POINTS`, `BODY`, constants)
so tests can exercise the same wiring without a game server or a CLI run.

1. **Disconnect order (L1).** On disconnect the host cancels the old delegation
   first (`WalkRouteExecutor.cancel('lifecycle', …)`), then produces and dispatches
   the `markStale` / `beginSession` lifecycle `ChangeReport`s to both the readonly
   `RouteVerifier` and the executor. No further `advance`/`onSample` frame runs after
   the cancel.
2. **Save/close (L2).** The normal save path asserts `checkpointId ==
   lastConfirmedCheckpointId`, `voxelRevision == confirmedVoxelRevision`,
   `dirty === false`, and full `close()` fields. Every opened session (primary,
   reopened, capacity) is closed in a `finally` before temp-dir cleanup, including
   when a later assertion fails.
3. **Capacity (L2).** A real `snapshotLimits: { maxVoxelSections: 1 }` rejection is
   asserted as the primary `PersistenceError(kind: 'capacity')`; close/cleanup is
   secondary and never replaces it.
4. **Windows lock release (L2).** After close the example/tests `renameSync` the
   database file, which only succeeds once no worker/db handle remains. No
   `process.exit`; the example sets `process.exitCode` on failure and lets the
   process exit naturally.

## Validation

Commands (cwd = worktree root), all exited 0:

- `npm run build` → 0
- `npm run typecheck` → 0 (pretypecheck also rebuilds)
- `npx vitest run tests/shared-session-lifecycle.test.ts` → 6 passed

Test evidence:

- Positive: disconnect cancels the pending walk (`result.outcome === 'CANCELLED'`,
  `activeStepIndex === null`) and stales the route (`verdict !== 'OPEN'`); late
  `conn-1` evidence is rejected and only the re-observed cell is `FRESH` while its
  neighbour stays `STALE`.
- Negative A: with report dispatch omitted, the readonly verifier still reads `OPEN`
  even though the walk was cancelled — the verifier bug is independent of executor
  cancel.
- Negative B: an empty lifecycle report plus no cancel leaves the walk pending
  (`activeStepIndex !== null`, `result === null`) — report dispatch does not mask a
  missing cancel.
- L2: checkpoint/close report clean, confirmed save fields; capacity rejection keeps
  `kind: 'capacity'` and names `maxVoxelSections`; reopened evidence restores `STALE`
  and the reopened session closes before a `renameSync` proves the DB handle released.

## Remaining limitation

The example was not run directly via `npx tsx` (the standalone run requires an
interactive approval in this environment, and is outside the approved command
list). Its `main()` orchestration reuses exactly the functions and classes the six
passing tests cover, and the `isMain` guard prevents `main()` from running on
import (the tests import the example module with no side effects). A later session
may run `npx tsx examples/shared-session-lifecycle.ts` to confirm the natural
subprocess exit end-to-end.
