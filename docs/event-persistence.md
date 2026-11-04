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
- `checkpoint(): Promise<SpatialCheckpointResult>` now also reports the exact
  captured/ACK-confirmed `journalRevision`.
- `getPersistenceState()` adds `journalRevision`, `confirmedJournalRevision`,
  `journalBaselineCheckpointId`, `pendingJournalRecords`, `pendingJournalBytes`,
  `committedJournalRecords`, `committedJournalBytes`; `dirty` includes the local
  journal revision.
- `ActionRecord.result?: NavResult` — an optional, verbatim original navigation
  result for existing and new callers.

Acceptance is **not** a save. A save is confirmed only after a later
`checkpoint()` captures the record, the single existing SQLite worker commits it in
the same transaction as history/topology/voxel, and the ACK arrives; if that ACK is
lost, the transaction may nevertheless have committed.

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

`SpatialEvent` currently supports **only these two raw observation variants**.
It deliberately does **not** provide a full derived event vocabulary: there is no
`blocked` / `cleared` / `revalidated` / traversability-transition event kind, no
inferred blockage event, and no event synthesized from map diffs, pathfinding
failures, proximity or elapsed time. Hosts that need such facts must derive them
elsewhere and pass the underlying raw observation or gap; this library does not
invent them.

Raw `blockUpdate`, logs, plans, proximity, and timestamp coincidence cannot be
turned into an event by this API. Recording an event does not write observations
into the voxel map, and no event is inferred from map contents.

## Idempotency, conflicts and scoping

- Scoped identity is `(kind, worldId, sessionId, id)`, where `kind` is `action`
  or `event`. `worldId` must equal the session world; `sessionId` and `id` remain
  exactly as supplied. No world, dimension, time, action attribution or
  observation is invented. This matches the separate pending maps and the
  separate SQL tables.
- Actions and events are therefore separate id namespaces: the same
  `worldId`/`sessionId`/`id` may exist once as an action and once as an event,
  whether submitted in one `recordBatch` or in separate calls. They are stored in
  different tables and are both returned by their own queries.
- The same scoped `(kind, worldId, sessionId, id)` with the same canonical content
  is an idempotent duplicate, including differences in object-key insertion order.
  It consumes no quota.
- The same scoped identity with different canonical content is an explicit
  conflict. Pending conflicts reject synchronously with
  `PersistenceError.kind = 'conflict'` (`JournalConflictError` is a
  `PersistenceError`). A conflict against already committed content rejects the
  whole checkpoint with `kind = 'conflict'`, rolling back history, topology,
  voxel and journal together. The old row is never overwritten.
- Different sessions may use the same id.
- A later snapshot of the same logical action must use a distinct caller-provided
  id (and explicit delegation correlation). An accepted/persisted record is never
  mutated in place.
- A batch is validated, deduplicated and capacity-checked one candidate at a time.
  Cumulative fresh record count/bytes are checked immediately before each fresh
  record is retained, so an over-capacity batch is rejected without first
  retaining every canonical candidate. A rejected batch leaves the pending
  contents, bytes and revision unchanged; pending duplicates do not retain a
  second canonical copy.
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
- `SpatialCheckpointResult.journalRevision` reports the exact journal revision
  captured for that checkpoint and confirmed by its own ACK. When
  `maxBatchRecords`/`maxBatchBytes` truncate the pending queue, each result
  reports only its captured prefix — never the latest local queue revision — so
  the caller can tell that more journal facts remain pending.
- `flush()` keeps its existing meaning: wait for an already-accepted checkpoint,
  never capture new dirty facts. `close()` awaits an accepted in-flight
  checkpoint, does **not** create one, and reports journal dirtiness accurately.
  Neither `flush()` nor `close()` implicitly captures newly dirty state.
- A timeout/lost ACK is unconfirmed, never reported as saved. The transaction may
  nevertheless have committed before the confirmation was lost; pending records
  stay readable in memory for explicit replay under the same stable ids into a
  reopened session, where the worker's committed-scope idempotency resolves the
  ambiguity to exactly one row. There is no automatic retry and no timer.
- Accepted is not saved, and saved queries only read committed rows; pending
  records are never included in `queryActions`/`queryEvents`.
- Persisting a record never rewrites `ActionRecord.result.memoryWrite`. That field
  remains the original caller-supplied navigation outcome, not a persistence
  receipt or a retroactive save confirmation.

## Explicit recovery and withdrawal

- `readPending()` returns isolated copies of all accepted but not yet ACK-confirmed
  records, bounded by the pending queue limits. It works after a failed or closed
  session; it never reads committed rows.
- `withdraw({ actions?, events? })` removes only exact pending
  `(kind, sessionId, id)` pairs, returns what was withdrawn and which ids were
  missing, and rejects with `busy` while any checkpoint is in flight. The entire
  selector is validated, bounded and deduplicated before any entry is removed, so
  a malformed later selector cannot silently lose an earlier valid withdrawal
  without returning it or advancing the revision. It never deletes committed
  rows.
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
| `maxPendingRecords` | 10,000 | accepted but not yet ACK-confirmed actions + events |
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

## Host wiring and caller responsibilities (not implemented here)

The host runtime is **not wired in this repository increment**. There is no
perception-loop, navigation-executor, action-registry or periodic-timer hookup,
and existing host logs/actions are not captured automatically. The host must:

- call `recordAction` / `recordEvent` / `recordBatch` itself when evidence
  actually exists, passing the original fact identity (`id`, `sessionId`,
  `worldId`, `dim`), observation/action time and confirmed effect fields
  verbatim. The library does not observe, derive or backfill events, and does not
  add host `EffectEvidence` or host imports;
- then call its existing periodic checkpoint and an explicit final checkpoint
  before close when pending journal data must be saved. `flush()` and `close()`
  never implicitly capture new dirty state;
- replay `readPending()` records under the same stable ids into a reopened session
  after an unconfirmed/failed save (the timed-out transaction may have committed
  already), or explicitly withdraw rejected items;
- remember that an accepted record is not saved merely because
  `recordAction`/`recordEvent` returned; only a checkpoint ACK is a save
  confirmation, and queries only show committed rows.

## Tests actually run

New focused suite `tests/event-persistence.test.ts` (**28 tests**, real
`better-sqlite3` + real worker threads + temp databases) passes:

- cancelled/partial `NavResult` with original timestamps, trace, consumption,
  partial effects, sub-action origin/role and `memoryWrite` round-trips through
  pending → checkpoint ACK → reopen → paged query; `memoryWrite` is never rewritten;
- observed-cell change (with and without a previous observation) and
  observation-gap evidence round-trip without map installation/inference;
- duplicate/key-order replay idempotency, same-id conflict, same id in different
  sessions, atomic mixed-world batch rejection;
- kind-scoped identity: the same id as both an action and an event is accepted in
  one batch and in separate calls, survives checkpoint/reopen in both tables, and
  same-kind different content still conflicts;
- incremental batch capacity: a small budget rejects the crossing fresh record
  before a later input record is inspected (its throwing getter is never read),
  and the rejected batch leaves pending contents/bytes/revision unchanged;
- whole-selector withdrawal validation: a valid-then-malformed selector leaves
  pending contents/bytes/revision unchanged, while a valid selector returns the
  exact withdrawn facts and advances the revision;
- durable conflict rollback preserves prior journal rows and every other
  checkpoint domain, then targeted withdrawal lets progress continue;
- a real SQLite `RAISE(ABORT)` trigger on `action_records` rolls back history,
  topology, voxel and journal together, keeps pending/dirty, and a retry commits
  the same batch once;
- a real worker checkpoint timeout reports `timeout_unconfirmed` (never saved),
  keeps all 500 pending recovery facts, and reopen + stable-ID replay commits each
  id exactly once; the test shortens only its own session ACK deadline after
  open (a test-local timer adjustment, not a production hook) because this
  worker's deferred read→write transaction surfaces a held SQLite write lock as
  an immediate `sql` busy error rather than a wait;
- pending and committed capacity preserve records/dirty, duplicate replay at the
  cap consumes no quota, and an empty journal checkpoint confirms a withdrawal
  revision without deleting committed rows;
- records accepted during an in-flight checkpoint survive the older ACK;
- multi-batch truncated checkpoints: each `SpatialCheckpointResult.journalRevision`
  reports only its captured/ACK-confirmed prefix and leaves later records dirty
  until the final checkpoint confirms them;
- insertion-order paging with cursors, filters, byte-budget paging and explicit
  unpageable-record failure; input/output mutation isolation;
- reopen reads metadata only (a corrupted payload is not decoded at open), and
  history-only/empty/repeated combined checkpoints preserve prior journal rows;
- close with a dirty unsaved journal and replay under stable ids; close awaiting
  an accepted checkpoint; withdrawal/query busy rejection during an in-flight
  checkpoint;
- v3→v4 upgrade preserves history/voxel facts, writes a backup and starts with an
  empty journal; a failed v4 migration rolls back to v3 with a backup.

The combined case of a disk commit that succeeded while its ACK was lost was not
separately exercised; the timeout test establishes retention and stable-ID replay,
not that SQLite had committed before the ACK was lost.

Directly affected existing suites were run together with the new suite
(`--no-cache`, 178 passed total):

- `tests/event-persistence.test.ts` — 28 passed
- `tests/spatial-checkpoint-incremental.test.ts` — 23 passed
- `tests/spatial-checkpoint.test.ts` — 33 passed
- `tests/storage-checkpoint.test.ts` — 50 passed
- `tests/working-set.test.ts` — 44 passed (v2→latest migration fixtures now
  expect schema version 4)

### Test-environment adjustment (approved, outside the repository)

This worktree is nested under `node_modules/.cache`. Vitest externalizes its
built `dist` modules there, so the original `vi.spyOn(distBytes,
'jsonEscapedByteLength')` in `tests/spatial-checkpoint.test.ts` fails with
"Cannot redefine property" on native ESM namespace exports. The original
assertion from commit `b09527b` and its `mockRestore()` are restored verbatim;
there is no `vi.mock` workaround in the test file.

The approved adjustment is a temporary config **outside** the repository that
only inlines this worktree's `dist` path. No project config or production file
was changed for it.

Path (outside the worktree, not checked in):

`D:/Repos/curio-minecraft-3d-memory/node_modules/.cache/vitest-inline-dist.config.mts`

Content:

```ts
export default {
  root: 'D:/Repos/curio-minecraft-3d-memory/node_modules/.cache/codex-event-persistence-20261104',
  test: {
    server: {
      deps: {
        inline: [/codex-event-persistence-20261104[\\/]dist[\\/]/],
      },
    },
  },
};
```

Exact command (from the worktree root):

```sh
npx vitest run --no-cache \
  -c D:/Repos/curio-minecraft-3d-memory/node_modules/.cache/vitest-inline-dist.config.mts \
  tests/event-persistence.test.ts tests/spatial-checkpoint.test.ts \
  tests/storage-checkpoint.test.ts tests/spatial-checkpoint-incremental.test.ts \
  tests/working-set.test.ts
```

The `acceptance/*.test.mjs` files are standalone acceptance scripts invoked
outside Vitest; they were not part of this run, and no game/server acceptance was
performed. `npm run build` and `npm run typecheck` pass. No game/real-server/
mineflayer acceptance was run, and no host runtime is wired.
