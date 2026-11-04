# Shared-session lifecycle — B1 evidence (final review fix, pass 2)

Scope: `examples/shared-session-lifecycle.ts`, `tests/shared-session-lifecycle.test.ts`,
and this document. No `src`, package manifest, acceptance, existing design doc, or
unrelated worktree file was changed by this task.

## What changed

1. **Shared persistent map (L1+L2).** `main` no longer runs the disconnect wiring on a
   separate in-memory `VoxelMap`. `runPrimaryLifecycle` opens a real primary session
   (with a bounded fixture clock via `voxelOptions.now`), runs the real `runDisconnect`
   on `primary.voxel` plus the shared `assertDisconnected`, then checkpoints, closes the
   primary, and reopens. The conn-2 re-observation is asserted to survive the
   save/restore with its original `sessionId` (`conn-2`) and `observedAt`
   (`NOW + 1000`) and comes back `STALE` — scope and time are preserved, not re-freshened.
2. **Close-before-reopen (L2).** `runPrimaryLifecycle` follows primary open → disconnect
   → checkpoint → awaited real `close()` (checked clean) → reopen → restore.
   `OwnedSessions.open` refuses a second session while one is open, so a shared path
   never has two Workers at once. A non-clean or thrown primary close propagates as
   primary and prevents reopen. The boundary still closes the *current* session after
   any body/assertion failure.
3. **No fabricated close results (L2).** `OwnedSessions.close` records only real
   `CloseResult` values into `closes`; a thrown `close()` is kept separately in
   `closeErrors` (secondary) and never turned into an invented
   `{completed:false, dirty:true, …}` record. The original primary error
   object/kind/message is preserved. A close that throws, reports `completed:false`,
   an `error`, or an `unconfirmedRequest` is not clean and retains the directory; the
   capacity scenario's `dirty:true` is unsaved data, not a shutdown failure.
4. **Structured CLI reporting (L2).** `writeRunReport` is the single reporting path
   shared by `main` and the tests; it prints the primary `kind`/message, every real
   close result, secondary close/cleanup errors, and the retained directory.
   `assertCleanSaveRun` re-throws the original primary error. The CLI exits naturally
   (exit code 0) — no `process.exit`.
5. **Cleanup helper removed.** The exported `removeTaskDir` was deleted. Cleanup is an
   internal `cleanupOwnedDir` that removes only the exact `mkdtempSync`-created
   directory owned by the run, guarded by a simple direct-child-of-temp-root check.
6. **Isolated cancel channel (L1).** The cancel is extracted into the shared
   `cancelActiveDelegation` (the exact wiring `runDisconnect` uses). `runCancelChannel`
   establishes one in-flight step, dispatches a truly empty report (an unobserved
   dimension), and applies the real cancel — no further body sample/advance/physics
   tick. `assertCancelled` (terminal `CANCELLED`, `activeStepIndex === null`, exactly
   one stop of the old move) passes with the cancel and fails without it, proving the
   cancel — not the report — ends the old step. The verifier-report-omission negative
   control (`skipVerifierReport`) is retained; the full scenario keeps the late
   conn-1 observation/body checks.

## Validation

Commands (cwd = worktree root):

- `npm exec vitest run tests/shared-session-lifecycle.test.ts` → 15 passed (exit 0)
- `npm run typecheck` → 0 (runs `npm run build` then `tsc --noEmit`)
- `node --import tsx examples/shared-session-lifecycle.ts` → prints the structured
  reports below and exits naturally 0

CLI output (excerpt):

```
[L2 normal save] ok=true retained=false
[L2 normal save] close[0] completed=true dirty=false unconfirmedRequest=false lastConfirmedCheckpointId=… error=null
[L2 normal save] close[1] completed=true dirty=false unconfirmedRequest=false lastConfirmedCheckpointId=null error=null
[L2 capacity] ok=false retained=false
[L2 capacity] primary PersistenceError(kind=capacity) maxVoxelSections exceeds limit 1 (2)
[L2 capacity] close[0] completed=true dirty=true unconfirmedRequest=false lastConfirmedCheckpointId=null error=null
shared-session-lifecycle: all checks passed.
```

Test evidence (15 tests):

- Positive disconnect: shared `assertDisconnected` over `runDisconnectScenario`.
- Negative A: `skipVerifierReport` → `assertDisconnected` throws
  `old verifier must no longer be OPEN`.
- Cancel channel positive: `assertCancelled` over `runCancelChannel` (in-flight step +
  empty report + real cancel) passes.
- Cancel channel negative: `runCancelChannel(…, skipCancel=true)` → `assertCancelled`
  throws `cancel must end the old step immediately` (the empty report cannot end it).
- Late old body frame: cancelled result not rewritten, step not reactivated, `body.stop`
  targeted the old move exactly once.
- Normal save/close: `assertCleanSaveRun` over `runPrimaryLifecycle`; temp dir removed
  after known clean closure.
- Reopen only after primary close: close → reopen → close order asserted via hooks.
- Conn-2 re-observation survives save/restore: `sessionId === 'conn-2'`,
  `observedAt === NOW + 1000`, `freshness === 'STALE'`.
- Non-clean primary close prevents reopen: `afterReopen` never runs, `closes.length === 1`.
- Capacity + cleanup failure: primary `kind === 'capacity'`/message preserved,
  `cleanupError` secondary, directory retained and present on disk, `dirty:true`.
- Cleanup failure alone: `ok === false`, no primary, `cleanupError`, directory retained.
- Non-clean close after primary: `completed === false`, primary preserved, directory
  retained and present on disk.
- Thrown close after primary: `closes` empty (no fabricated record), `closeErrors`
  length 1, primary preserved, directory retained.
- Shared report: `writeRunReport` output contains `capacity`, `maxVoxelSections`, and
  `retainedDir=<dir>`.
- Injected assertion failure after reopen: both sessions still closed by the boundary,
  `retained === false`.

## Remaining limitations

- Close/cleanup failures are injected at the boundary via `closeSession`/`cleanupDir`
  hooks *after* the real worker `close()` already ran — they do not simulate a real
  Worker crash or a physically failing disk.
- No real game-server integration (mineflayer/pathfinder perception and body) is run;
  the example uses Fake perception and a Fake body, as documented.
- The example uses default `eager` voxel loading, appropriate only when the world fits
  the session's working-set budget (see `examples/working-set.ts`).
