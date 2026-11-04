# Shared-session lifecycle — B1 evidence (revised)

Scope: `examples/shared-session-lifecycle.ts` and `tests/shared-session-lifecycle.test.ts`.
No `src`, package manifest, acceptance, existing design doc, or unrelated worktree
file was changed.

## What changed

The example now owns the disconnect wiring and the save/close/resource boundary in
one reusable surface, and the tests call that same surface instead of re-implementing
it.

1. **Disconnect order (L1).** `runDisconnect` cancels the old delegation first
   (`WalkRouteExecutor.cancel('lifecycle', …)`), then dispatches the `markStale` /
   `beginSession` `ChangeReport`s to both the readonly `RouteVerifier` and the
   executor, then shows a late old-session observation is rejected and a late old
   body frame cannot reactivate control or rewrite the cancellation. `main` and the
   positive test both call `runDisconnectScenario()` and the shared
   `assertDisconnected`, so deleting the cancel or the report-dispatch channel fails
   the assertion.
2. **Resource boundary (L2).** `runOwned`/`OwnedSessions` own one temp directory and
   every session opened through them (primary, reopened, capacity). It always
   performs a bounded `close()` for every session — on success, on a thrown primary
   error, and on a later assertion failure — before any cleanup, and preserves the
   original `PersistenceError` identity/kind/message as primary while recording
   close/cleanup failures as secondary. Cleanup runs only after close outcomes; a
   non-clean close or a cleanup failure retains the temp directory.
3. **Save/close assertions (L2).** `runPrimaryLifecycle` asserts `checkpointId ===
   lastConfirmedCheckpointId`, `voxelRevision === confirmedVoxelRevision`, and
   `dirty === false`; `assertCleanSaveRun` checks the full close fields
   (`completed`/`dirty`/`unconfirmedRequest`/`error`) for both sessions.
4. **Capacity (L2).** `runCapacityLifecycle` exercises the real public
   `snapshotLimits: { maxVoxelSections: 1 }` rejection; the `PersistenceError(kind:
   'capacity')` propagates as primary and is never replaced by close/cleanup.
5. **Cleanup guard (L2).** `removeTaskDir` now removes only a direct child of the OS
   temp root (`dirname(dir) === tmpdir()`), rejecting the temp root itself and any
   unrelated child; no generic directory-deletion API was introduced.

## Validation

Commands (cwd = worktree root), all exited 0:

- `npm run build` → 0
- `npm run typecheck` → 0
- `npx vitest run tests/shared-session-lifecycle.test.ts` → 9 passed
- `node --import tsx examples/shared-session-lifecycle.ts` → prints
  `shared-session-lifecycle: all checks passed.` and exits naturally (no
  `process.exit`; `process.exitCode` is set on failure only).

Test evidence (9 tests):

- Positive disconnect: shared `assertDisconnected` over `runDisconnectScenario`.
- Negative A: report dispatch omitted → readonly verifier still `OPEN` while the walk
  is cancelled (independent of executor cancel).
- Negative B: empty lifecycle report + no cancel → walk stays pending.
- Late old body frame: cancelled result is not rewritten, the step is not
  reactivated, and `body.stop` targeted the old move execution exactly once.
- Normal save/close: `assertCleanSaveRun` over `runPrimaryLifecycle`.
- Capacity + cleanup failure: primary `kind === 'capacity'`/message preserved,
  `cleanupError` secondary, directory retained.
- Cleanup failure alone: `ok === false`, no primary, `cleanupError` reported.
- Close failure after primary: `completed === false`, directory retained, primary
  preserved.
- Injected assertion failure after reopen: both primary and reopened sessions are
  still closed by the boundary.

## Remaining limitations

- The `runPrimaryLifecycle` reopen is performed while the primary session is still
  open (the boundary closes all sessions afterwards); this is validated on the
  current Windows/Node via the CLI run and tests. A game-server integration run
  (real mineflayer/pathfinder perception and body) is out of scope for this change.
