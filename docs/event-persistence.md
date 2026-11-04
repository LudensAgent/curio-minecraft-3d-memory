# Event and action journal persistence

Status: implementation and local tests only. The Curio/mineflayer host is **not**
wired to these APIs in this increment, and no real-server acceptance was run.

## What is implemented

`openSpatialSession` now exposes a bounded, append-only journal alongside the
existing history/topology/voxel checkpoint:

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({ databasePath, worldId });
session.journal.recordAction(actionRecord);   // synchronous, bounded acceptance
session.journal.recordEvent(event);           // synchronous, bounded acceptance
await session.checkpoint();                   // one SQLite transaction + ACK
```

Public surface (from `storage/sqlite`):

- `session.journal.recordAction(record: ActionRecord): JournalAcceptResult`
- `session.journal.recordEvent(event: SpatialEvent): JournalAcceptResult`
- `session.journal.recordBatch({ actions?, events? }): JournalBatchAcceptResult`
- `session.journal.readPending(): PendingJournalSnapshot`
- `session.journal.withdraw(selector): JournalWithdrawalResult`
- `session.queryActions(query?): Promise<JournalPage<ActionRecord>>`
- `session.queryEvents(query?): Promise<JournalPage<SpatialEvent>>`
- `getPersistenceState()` adds `journalRevision`, `confirmedJournalRevision`,
  `journalBaselineCheckpointId`, `pendingJournalRecords`, `pendingJournalBytes`,
  `committedJournalRecords`, `committedJournalBytes`; `dirty` includes the local
  journal revision.
- `ActionRecord.result?: NavResult` — an optional, verbatim original navigation
  result for existing and new callers.

Acceptance is **not** a save. A record becomes durable only when a later
`checkpoint()` captures it, the single existing SQLite worker commits it in the
same transaction as history/topology/voxel, and the ACK arrives.

## Supported event variants

`SpatialEvent` is a closed, explicit union. It is not an arbitrary JSON blob and
there is no automatic event bus.

1. `kind: 'observed_cell_change'`
   - `id`, `observedAt`, `worldId`, `dim`, `sessionId`, `pos`
   - `current: Observation` — required, validated against the event scope/cell
   - `previous?: Observation` — only the actual retained previous observation.
     Absence means the prior state is **unknown**, never known air.
   - `actionId?` — only an explicitly confirmed own-action attribution.
2. `kind: 'observation_gap'`
   - `id`, `observedAt`, `worldId`, `dim`, `sessionId`
   - `reason`: an `ObservationGap` reason or `disconnected | paused |
     scope_changed | not_ready`
   - `pos?` — only when the gap concerns one specific cell.

Raw `blockUpdate`, logs, plans, proximity, and timestamp coincidence cannot be
turned into an event by this API. Recording an event does not write observations
into the voxel map, and no event is inferred from map contents.

## Idempotency, conflicts and scoping

- Scope identity is `(worldId, sessionId, id)`. `worldId` must equal the session
  world; `sessionId` and `id` remain exactly as supplied. No world, dimension,
  time, action attribution or observation is invented.
- The same scoped id with the same canonical content is an idempotent duplicate,
  including differences in object-key insertion order. It consumes no quota.
- The same scoped id with different canonical content is an explicit conflict.
  Pending conflicts reject synchronously with `PersistenceError.kind = 'conflict'`.
  A conflict against already committed content rejects the whole checkpoint with
  `kind = 'conflict'`, rolling back history, topology, voxel and journal together.
  The old row is never overwritten.
- Different sessions may use the same id. Action ids and event ids occupy
  separate tables and therefore separate id namespaces.
- A later snapshot of the same logical action must use a distinct caller-provided
  id (and explicit delegation correlation). An accepted/persisted record is never
  mutated in place.
- Canonicalization sorts object keys recursively, preserves array order, rejects
  cycles, non-plain objects, non-finite numbers and non-JSON values, and treats
  `undefined` object properties as absent.

## Checkpoint, ACK and dirty state

- `checkpoint()` captures the current pending batch (bounded by
  `maxBatchRecords`/`maxBatchBytes`) and its local journal revision. With
  `openHistorySession`, the checkpoint sends `journalMode: 'none'` and never
  touches journal rows or the journal baseline.
- The worker appends the captured batch and writes the checkpoint metadata in the
  same transaction as the other domains. Journal tables are append-only: an empty
  batch never deletes or replaces committed rows.
- A successful ACK clears only the captured entries whose revision is covered;
  records accepted while the checkpoint was in flight stay pending and dirty.
- `flush()` keeps its existing meaning: wait for an already-accepted checkpoint,
  never capture new dirty facts. `close()` awaits an accepted in-flight
  checkpoint, does **not** create one, and reports journal dirtiness accurately.
- A timeout/lost ACK is unconfirmed, never reported as saved. Pending records stay
  readable in memory for explicit replay under the same stable ids into a
  reopened session. There is no automatic retry and no timer.

## Explicit recovery and withdrawal

- `readPending()` returns isolated copies of all accepted-but-uncommitted
  records, bounded by the pending queue limits. It works after a failed or closed
  session; it never reads committed rows.
- `withdraw({ actions?, events? })` removes only exact pending
  `(sessionId, id)` pairs, returns what was withdrawn and which ids were missing,
  and rejects with `busy` while any checkpoint is in flight. It never deletes
  committed rows.
- An actual withdrawal advances the local journal revision, so a subsequent
  empty journal checkpoint can confirm that revision without deleting disk rows.
  This prevents one rejected/conflicting item from poisoning every later
  checkpoint.

## Committed queries

- `queryActions` / `queryEvents` are asynchronous, read-only and use the same
  single worker/operation gate as checkpoint/load (rejecting with `busy` when
  another operation is in flight).
- Results are pages of committed rows only. Pending records are separate.
- Ordering is storage insertion order (`seq`), not inferred chronology.
  `nextCursor` is an opaque keyset cursor over that sequence; there is no OFFSET.
- Optional exact filters: `dim`, `sessionId`, `actionId` / `eventId`, and event
  `kind`. Page row and byte bounds are bounded by the configured maxima; payload
  byte metadata is checked before any decode. A record whose own payload exceeds
  the page byte bound rejects explicitly with `capacity` rather than being
  skipped.
- Reopening loads journal baseline/count metadata only — never the journal
  payloads. Queries therefore recover original facts without refreshing their
  timestamps or turning them into current observations.

## Limits

`OpenSpatialSessionOptions.journalLimits` and
`OpenHistorySessionOptions.journalLimits` accept finite positive integers;
defaults live in `DEFAULT_JOURNAL_LIMITS`:

| Limit | Default | Meaning |
|---|---:|---|
| `maxPendingRecords` | 10,000 | accepted-but-uncommitted actions + events |
| `maxPendingBytes` | 16 MiB | pending canonical JSON bytes |
| `maxRecordBytes` | 1 MiB | one record's canonical JSON bytes |
| `maxRecordArrayLength` | 100,000 | any nested array / object key count |
| `maxRecordDepth` | 32 | nesting depth |
| `maxBatchRecords` | 1,000 | journal records per checkpoint |
| `maxBatchBytes` | 8 MiB | journal bytes per checkpoint |
| `maxCommittedRecords` | 1,000,000 | committed rows per world |
| `maxCommittedBytes` | 512 MiB | committed canonical payload bytes per world |
| `maxPageRecords` | 200 | rows per query page |
| `maxPageBytes` | 1 MiB | decoded payload bytes per query page |

`maxRecordBytes` must not exceed `maxPendingBytes` or `maxBatchBytes`.
Capacity rejection is atomic: previous pending records and committed facts are
preserved, and old facts are never evicted. Duplicate replay at committed
capacity does not consume extra quota.

Journal byte limits are separate from the full in-memory voxel snapshot limits;
journal history is not added to `SnapshotLimits.maxBytes`.

## Schema and migration

- Schema version is **4**. Additive v4 changes: `checkpoints.journal_revision`,
  `checkpoints.has_journal`, and the append-only `action_records` /
  `spatial_events` tables (each with a stable insertion `seq`, scoped uniqueness,
  and payload bytes).
- Validated v1/v2/v3 databases upgrade through the existing migration chain plus
  v3→v4. Each upgrade writes a `VACUUM INTO` backup first
  (`<database>.pre-v4-<uuid>` for v3→v4), and the schema change runs in one
  transaction so a failure leaves the previous version intact. Existing worlds,
  history and voxel rows are preserved exactly; an upgraded database starts with
  an empty journal, not synthesized history. Version downgrade is unsupported.
- `has_journal` is an independent baseline discriminator: a later history-only
  checkpoint (`has_journal = 0`) does not change the journal baseline or rows.
- The worker re-checks durable idempotency/conflict and committed capacity inside
  the transaction, so a same-id/different-payload replay rolls back every domain
  in that checkpoint.

## Caller responsibilities (not implemented here)

- Call `recordAction` / `recordEvent` when evidence actually exists. The library
  does not observe, derive or backfill events, and does not add host
  `EffectEvidence` or host imports.
- Call the normal periodic checkpoint and an explicit final checkpoint before
  close when pending journal data must be saved. `close()` alone does not capture
  new facts.
- Replay `readPending()` records under the same ids into a reopened session after
  an unconfirmed/failed save, or explicitly withdraw rejected items.
- Wire the host runtime (perception loop, navigation execution, action registry)
  to these APIs. This increment does **not** claim existing host logs/actions are
  already captured.

## Tests actually run

New focused suite `tests/event-persistence.test.ts` (22 tests, real
`better-sqlite3` + real worker threads + temp databases) passes:

- cancelled/partial `NavResult` with original timestamps, trace, consumption,
  partial effects, sub-action origin/role and `memoryWrite` round-trips through
  pending → checkpoint ACK → reopen → paged query;
- observed-cell change (with and without a previous observation) and
  observation-gap evidence round-trip without map installation/inference;
- duplicate/key-order replay idempotency, same-id conflict, same id in different
  sessions, atomic mixed-world batch rejection;
- durable conflict rollback preserves prior journal rows and every other
  checkpoint domain, then targeted withdrawal lets progress continue;
- pending and committed capacity preserve records/dirty, duplicate replay at the
  cap consumes no quota, and an empty journal checkpoint confirms a withdrawal
  revision without deleting committed rows;
- records accepted during an in-flight checkpoint survive the older ACK;
- insertion-order paging with cursors, filters, byte-budget paging and explicit
  unpageable-record failure; input/output mutation isolation;
- reopen reads metadata only (a corrupted payload is not decoded at open), and
  history-only/empty/repeated combined checkpoints preserve prior journal rows;
- close with a dirty unsaved journal and replay under stable ids; close awaiting
  an accepted checkpoint; withdrawal/query busy rejection during an in-flight
  checkpoint;
- v3→v4 upgrade preserves history/voxel facts, writes a backup and starts with an
  empty journal; a failed v4 migration rolls back to v3 with a backup.

Relevant existing regressions run with `npx vitest run --no-cache`:

- `tests/spatial-checkpoint-incremental.test.ts` — 23 passed
- `tests/storage-checkpoint.test.ts` — 50 passed
- `tests/working-set.test.ts` — 44 passed (v2→latest migration fixtures now
  expect schema version 4)
- `tests/spatial-voxel-residency.test.ts` — 31 passed
- `tests/migration-batch.test.ts`, `tests/shared-session-lifecycle.test.ts`,
  `tests/smoke.test.ts` — 21 passed
- `tests/spatial-checkpoint.test.ts` — 33 passed. Its early-stop assertion now
  mocks the built `dist/bytes.js` helper instead of `vi.spyOn`-ing the ESM
  namespace (namespace exports are non-configurable on this Node/Vitest
  combination). The assertion — that the escaped-byte scan is never reached — is
  unchanged.

A forced worker timeout/lost-ACK was **not** exercised: there is no production
test hook, and the task explicitly forbids adding one just for tests. The code
path retains the pending snapshot and reports `timeout_unconfirmed`; explicit
replay under stable ids is covered via the close/dirty-unsaved test above.

The full `tests/` Vitest suite passes (`npm run build` then
`npx vitest run --no-cache`). The three `acceptance/*.test.mjs` files in this
repository are standalone acceptance scripts invoked outside Vitest; they were
not part of this run and no game/server acceptance was performed.

`npm run build` and `npm run typecheck` pass. No game/real-server/mineflayer
acceptance was run, and no host runtime is wired.
