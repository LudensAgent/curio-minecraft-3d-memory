# Consumer acceptance — B2 evidence (provisional)

Scope: `acceptance/consumer.mjs`, `docs/consumer-acceptance-b2.md`, and the new
`acceptance/consumer-close.test.mjs` (plus the pre-existing
`acceptance/consumer-types.ts`, which is unchanged). No `src`, `run.mjs`, package
manifest, existing design doc, or 5E record was changed in this stage.

This stage (B2a) strengthens the independent runtime consumer to prove two
things that the earlier consumer left open, and records **provisional** evidence
from a worktree run (package self-resolves to `dist` in plain Node). Final
installed-artifact acceptance (`run.mjs` packing and installing the real `.tgz`)
is the separate B2b gate that runs after this and the concurrent B1 stage both
commit.

## What changed

1. **Pin protection independent of dirty (L3).** The route facts are observed and
   then checkpointed *before* pinning, so the dependencies are committed and clean
   (`dirty === false`, every dependency has a committed record) at pin time. A
   controllable `HangingExecutor` (deferred `move` resolve) starts a walk and holds
   one step in flight (`activeStepIndex !== null`, `result === null`); `free()` is
   then called while the walk is active and every dependency is asserted to be
   rejected with reason exactly `'pinned'` — not merely "no eviction", and not the
   `'dirty'` rejection that the old dirty-while-pinned consumer would have shown.
   The walk then finishes to `ARRIVED`, the caller's pin token is released, and
   `free()` reclaims every dependency (no pin, no new dirty). The whole case is
   repeated with `cancel('user', …)` instead of arrival.
2. **Overlapping leases (L3).** Two `prepare(deps)` leases overlap the same
   dependencies. Releasing the old token leaves the new lease still protecting them
   (`'pinned'`); releasing the new token allows real reclamation (`free()` evicts
   them).
3. **Final persistence with a unique fact (L4).** A never-before-observed cell gets
   a unique state with nonempty properties (`minecraft:oak_log` with
   `properties: { axis: 'y' }`), live `sessionId`, `observedAt: 2000`, and full
   exact state. The final `checkpointId` equals
   `getPersistenceState().lastConfirmedCheckpointId`, `cp.voxelRevision` equals
   `confirmedVoxelRevision`, and `dirty === false` after no later writes. The full
   close fields (`completed`/`dirty`/`unconfirmedRequest`/`error`) are asserted.
   Reopen verifies the full unique fact, the original live session/time, and that it
   is `STALE`; reads never refresh evidence time or dirty the session. `flush()` and
   `close()` are shown not to auto-save.
4. **Runtime mutation options.** Two named CLI flags turn specific positive
   assertions into failures so the orchestrator sees a non-zero exit (never treated
   as success by this consumer):
   - `--early-release-pin` releases the pin lease before the in-flight `free()`, so
     the `'pinned'` assertions fail (the dependency is evicted instead).
   - `--skip-final-checkpoint` skips the final checkpoint, so the reopened unique
     fact is absent and the final-fact assertions fail against the old baseline.
5. **Owning close + final resource verdict.** Every real `close()` goes through one
   owning closure (`closeSession`) that records each session's *actual* outcome — the
   returned `CloseResult` or the original thrown error (never a fabricated result,
   never discarding the original error). The final `finalizeResources` pass closes any
   session not yet recorded, classifies each outcome, and runs cleanup only when every
   close is clean. A clean close is `completed === true`, `unconfirmedRequest ===
   false`, and `error === null`; `dirty` is intentionally **not** a shutdown failure
   (an uncheckpointed phase may legitimately close dirty). A thrown close, a
   `completed !== true` result, an `unconfirmedRequest`, or a returned `error` is an
   unclean/unknown close: it prevents directory removal, is diagnosed, and makes the
   exit non-zero even without a primary error. A cleanup failure alone is non-zero; a
   cleanup failure alongside a primary stays secondary. `PASS` is printed only after
   every close outcome and cleanup are known clean. No `process.exit`; the run returns
   via `process.exitCode` and exits naturally. Cleanup runs only after closure, only
   over the temp directory this consumer created (verified as an absolute descendant
   of `tmpdir()`).
6. **Fault mutation modes (for targeted verification).** Three additional flags
   exercise the close/cleanup fault paths against the real shared close path (the
   SQLite worker is still really shut down before the fault is reported):
   - `--close-fault-incomplete` — a session's `close()` reports `completed: false`.
   - `--close-fault-throw` — a session's `close()` throws after really closing.
   - `--cleanup-fault` — the directory cleanup throws.

## Validation (provisional — worktree `node`, self-resolved `dist`)

Commands (cwd = worktree root):

- `node acceptance/consumer.mjs` → exit 0, prints
  `consumer acceptance: PASS (all assertions held)`.
- `node acceptance/consumer.mjs --early-release-pin` → exit 1, primary
  `AssertionError: dependency (overworld, 0, 0, 0) stays pinned during the active walk`.
- `node acceptance/consumer.mjs --skip-final-checkpoint` → exit 1, primary
  `AssertionError: reopen has the unique final fact` (`false !== true`).
- `node acceptance/consumer.mjs --close-fault-incomplete` → exit 1, no PASS,
  `close() returned completed=false`, directory retained.
- `node acceptance/consumer.mjs --close-fault-throw` → exit 1, no PASS, `close()
  threw` + the injected error, directory retained.
- `node acceptance/consumer.mjs --cleanup-fault` → exit 1, no PASS, `cleanup
  failure` + the injected error, directory retained.
- `node --check acceptance/consumer.mjs` → exit 0.
- `node --test acceptance/consumer-close.test.mjs` → 5 passed (clean-but-dirty close
  is not a failure; returned incomplete close, thrown close, cleanup-only failure,
  and primary-plus-secondary close failure each yield non-zero and no PASS, with the
  primary retained).

Each mutation fails at its intended assertion (pin independence, final-fact
persistence, close/cleanup resource handling respectively), not at startup, and the
positive run exercises the full L3 + L4 path (pin/cancel/overlap + unique-fact
save/confirm/reopen).

## Remaining limitations

- These runs are **provisional**: they resolve the package through the worktree
  `dist`, not a freshly packed and installed `.tgz`. The final installed-package
  acceptance (independent `run.mjs` pack → install → runtime + `tsc --noEmit`)
  runs in B2b after both concurrent stages commit.
- A real mineflayer/pathfinder perception and body integration run is out of scope;
  the walk uses a controllable Fake/Hanging executor, matching the library's own
  fixtures.
