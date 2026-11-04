# Shared-session lifecycle — B1 evidence (final review fix)

Scope: `examples/shared-session-lifecycle.ts`, `tests/shared-session-lifecycle.test.ts`,
and this document. No `src`, package manifest, acceptance, existing design doc, or
unrelated worktree file was changed by this task.

## What changed

1. **Close-before-reopen (L2).** `runPrimaryLifecycle` now follows primary open →
   checkpoint/assert → awaited real `close()` (checked clean via `assertCleanClose`) →
   only then reopen → restore. `OwnedSessions.open` refuses a second session while one
   is still open (`a session is already open`), so a shared path never has two Workers
   at once. A non-clean or thrown primary close propagates as primary and prevents
   reopen. The boundary still closes the *current* session after any body/assertion
   failure.
2. **No fabricated close results (L2).** `OwnedSessions.close` records only real
   `CloseResult` values into `closes`; a thrown `close()` is kept separately in
   `closeErrors` (secondary) and never turned into an invented
   `{completed:false, dirty:true, …}` record. The original primary error
   object/kind/message is preserved. A close that throws, reports `completed:false`,
   an `error`, or an `unconfirmedRequest` is not clean and retains the directory; the
   capacity scenario's `dirty:true` is unsaved data, not a shutdown failure, so it does
   not force retention.
3. **Structured CLI reporting (L2).** `writeRunReport` is the single reporting path
   shared by `main` and the tests. It prints the primary `kind`/message, every real
   close result, secondary close/cleanup errors, and the retained directory. `main`
   runs the same `runPrimaryLifecycle`/`runCapacityLifecycle` entries and the shared
   `assertCleanSaveRun`, which re-throws the original primary error instead of a
   generic `'normal lifecycle must succeed'`. The CLI exits naturally (exit code 0) —
   no `process.exit`.
4. **Cleanup helper removed.** The exported `removeTaskDir` was deleted. Cleanup is an
   internal `cleanupOwnedDir` that removes only the exact `mkdtempSync`-created
   directory owned by the run, guarded by a simple direct-child-of-temp-root check. No
   general path-safety framework was added.
5. **Real negative controls (L1).** The two negative controls now run the shared
   `assertDisconnected` invariant against `runDisconnectScenario` with a single channel
   omitted (`skipVerifierReport` / `skipCancel`) and assert it *throws*. This proves the
   shared success invariant actually depends on each channel, instead of asserting a
   hand-rewritten broken setup. The `skipCancel` control keeps real reports and body
   frames flowing, so report-driven invalidation cannot hide the missing cancel — the
   shared `walkOutcome === 'CANCELLED'` check still fails.

## Validation

Commands (cwd = worktree root):

- `npx vitest run tests/shared-session-lifecycle.test.ts` → 13 passed (exit 0)
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

Test evidence (13 tests):

- Positive disconnect: shared `assertDisconnected` over `runDisconnectScenario`.
- Negative A: `skipVerifierReport` → `assertDisconnected` throws
  `old verifier must no longer be OPEN`.
- Negative B: `skipCancel` → `assertDisconnected` throws `old walk must be cancelled`
  (report invalidation cannot hide the missing cancel).
- Late old body frame: cancelled result not rewritten, step not reactivated, `body.stop`
  targeted the old move exactly once.
- Normal save/close: `assertCleanSaveRun` over `runPrimaryLifecycle`; temp dir removed
  after known clean closure.
- Reopen only after primary close: close → reopen → close order asserted via hooks.
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

- No real game-server integration (mineflayer/pathfinder perception and body) is run;
  the example uses Fake perception and a Fake body, as documented.
- The example uses default `eager` voxel loading, appropriate only when the world fits
  the session's working-set budget (see `examples/working-set.ts`).
