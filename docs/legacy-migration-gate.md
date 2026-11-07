# Legacy migration authority gate (M6.3)

This document describes the **advisory** JSON → SQLite authority gate that the
offline legacy-migration dry run reports. It does not restate the frozen
interface contract or implementation plan; where they say something about
migration, they remain the authority.

## What the gate is

`runLegacyMigrationDryRun` (`src/compat/migration-dry-run.ts`) returns a `gate`
field next to the A–D stage report. The gate is a **structured, decidable
condition list**, not a single boolean or a free-form string:

```text
gate {
  status: 'not_satisfied' | 'satisfied_but_disabled'
  satisfied: boolean                     // true only when every condition holds
  conditions: { condition, ok, observed }[]
  reasons: { code, detail, observed }[]   // one per failed condition
  autoSwitchImplemented: false
  requiresManualEnable: true
  operatorOptIn: boolean
  rollback: 'drop_temp_database_and_reopen_legacy'
  guarantees: {
    realAuthoritySwitch: false
    legacyWritePathRemoved: false
    dualWrite: false
    jsonReadFallbackForMissingRecords: false
  }
}
```

`evaluateMigrationGate(reportInput, request)` is a pure function over the
already-computed report facts. It never reads or writes a database.

## Conditions

| Condition | Holds when | Reason code when it fails |
|---|---|---|
| `stages_all_passed` | stages A, B, C and D all reported `passed` | `stage_failed` |
| `verification_all_verified` | stages B and C passed, no batch plan failed, and at least one batch with a storage destination was verified (the base `allVerified` flag is not used here) | `batch_not_verified` |
| `no_unattributed_records` | `verificationCounts.unattributedRecords === 0` | `unattributed_records` |
| `no_cross_world_records` | `verificationCounts.crossWorldRecords === 0` | `cross_world_records` |
| `no_invalid_records` | `verificationCounts.invalidRecords === 0` | `invalid_records` |
| `deleted_not_resurrected` | stage C checked deletions, `deletedNotResurrected` is true, and no `resurrected_deleted_passage` problem was reported | `deleted_resurrected` |
| `planned_destinations_declared` | no `planned` batch remains undeclared; the caller lists them in `migrationGate.declaredMigratedBatches` | `batch_planned_only` |
| `stage_d_trusted` | stage D reported `passed`, its `sessionsClosed` is true, and its `sourceSnapshotUnchanged` is true | `stage_d_not_passed` |

`verification_all_verified` deliberately does not contain the base
`verificationCounts.allVerified` flag, because that flag vetoes every `planned`
batch. `observed.allVerified` is still reported for transparency. The gate
checks the batches that have a real storage destination (stages B and C passed,
no failed plan, at least one verified batch) and reports the plan-only batches
through `planned_destinations_declared` instead.

### Plan-only batches today

`landmarks` and `travelEndpoints` have no storage destination in this work
package, so with a real snapshot `planned_destinations_declared` is always
`false` and the gate reports `not_satisfied`. `declaredMigratedBatches` only
records a caller's claim that those destinations are wired; it is never acted
on. The end-to-end `satisfied_but_disabled` wiring test uses that declaration to
make the branch reachable and checks that nothing is switched.

Each condition carries the facts it was decided from (`observed`), e.g. stage
statuses, record counts, failed batch names, checked and resurrected ids.

### Deletion semantics are part of the gate

The gate includes `deleted_not_resurrected` on purpose. A migration that brings a
tombstoned record back is not safe to switch to, even if IDs and counts match.
The check reuses the same `resurrected_deleted_passage` problem the importer
verifier produces, so the gate and the stage-C deletion checks agree.

## Default: never enabled

- With no facts, or any failed condition, the gate reports `not_satisfied`.
- When every condition holds, it reports `satisfied_but_disabled`. That status
  means exactly that: the conditions were met in the temporary rehearsal, and
  nothing was switched.
- `LegacyMigrationDryRunOptions.migrationGate.operatorOptIn` is a request that
  is only recorded (`gate.operatorOptIn`). It cannot flip `status`, and no code
  in this module reads it to branch.
- A future switch is a separate, explicit, manual step. It is not implemented in
  this work package.

In practice `planned_destinations_declared` cannot currently hold without a
caller declaration: landmarks and portal endpoints are plan-only, so the gate
reports `not_satisfied` for real snapshots.

## How the invariants are evidenced

- Behaviour: `does not resurrect a tombstoned passage from the still-present
  JSON after the switch` and the gate's `does not fall back to JSON for a record
  missing from the migrated store` test exercise `createSwitchedLegacyView` with
  a record removed from the store and show it is neither revived from JSON nor
  returned. The wiring test runs `runLegacyMigrationDryRun` to
  `satisfied_but_disabled` and checks every report guarantee stays false.
- Report facts: `gate.guarantees` is literal `false` data, and the report keeps
  `realMigrationPerformed` / `realAuthoritySwitch` / `legacyWritePathRemoved`
  false.
- Regression guard: the source-scan test in
  `tests/legacy-migration-dry-run.test.ts` is a coarse guard against a future
  dual-write or switch branch. It is not proof of "no JSON fallback"; the
  behavioural test above is.

## Rollback

`gate.rollback: 'drop_temp_database_and_reopen_legacy'` describes how a future
switch would be undone: discard the migrated database, reopen the legacy JSON
compatibility layer, and do not trust either store's unverified history. This is
a fact recorded in the report only. No automatic rollback is implemented, and the
gate never touches the caller's real database or JSON snapshot.
