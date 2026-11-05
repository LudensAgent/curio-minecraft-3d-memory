# Phase L5: storage tables, ledger APIs and migration rehearsal — acceptance

Scope: design §9 (persistence and caching), §9.1 (forward migration), §9.2
(worker and save confirmation). This note records what was implemented,
what was only rehearsed, and what remains open. It is not a claim that a real
user-data migration or persistence-authority switch has happened.

## Schema v5

The single worker owns one `better-sqlite3` connection (WAL, one writer). Schema
version moves 4 → 5. Older databases are upgraded forward one version at a time
(v1 → v2 → v3 → v4 → v5); each upgrade writes a consistent `VACUUM INTO` backup
before its transaction (`.pre-v2-*` … `.pre-v5-*`) and rolls back to the prior
version on failure.

New tables (world-scoped, no cross-world mixing):

| table | key | contents |
|---|---|---|
| `placed_blocks` | `key` = `worldId:dim:x,y,z` (nullable scope for unattributed legacy history) | name, integer position, `lru_at`, `source` (`legacy`/`live`) |
| `chunk_visits` | `key` = `worldId:dim:cx:cz` | exact `count`, `source` |
| `portal_traversals` | deterministic canonical id over `(kind, from, to, ts, sessions, observation ids)` | endpoint ids and raw endpoint evidence (JSON), direction, kind, ts, sessions, observation ids, source |

`checkpoints` gains `ledger_revision` / `has_ledger`; a world with ledger rows but
no ledger baseline is rejected as corrupt instead of being read as an empty
ledger (no JSON fallback, no resurrection of deleted rows).

`spatial_sections` gains explicit `dimension`, `cx`, `cz`, `sy` columns plus an
index `(world_id, dimension, cx, cz, sy)`. The v4 → v5 migration backfills them
from the existing `id` JSON in bounded `rowid` windows and verifies both copies
agree on every read; a mismatch is corruption, never a silent preference.

### Section payload v2

New section payloads use `v: 2` and omit the per-cell observation `state`, because
the palette + packed cells already carry the canonical state. Decoding
reconstructs `state` from the cell's palette index. Existing `v: 1` payloads
(full observation inline) still decode unchanged. The `id`, palette, bits, cells,
evidence metadata and revision remain in the payload for self-containment and
backward compatibility.

## Ledger runtime API (for the store/host adapter)

`openSpatialSession()` exposes `session.ledger: LedgerStore`. All methods are
synchronous in-memory acceptances; nothing is saved until `session.checkpoint()`
commits. The revision advances only on a real fact change (including an LRU
refresh), and `getPersistenceState()` reports `ledgerRevision`,
`confirmedLedgerRevision` and `ledgerBaselineCheckpointId`.

- Placement: `putPlaced(dim, pos, name)`, `importPlaced({dim, pos, name, lruAt,
  source})`, `getPlaced`, `removePlaced`, `placedBlocks(dim?)`,
  `queryPlacedNear(dim, pos, radius)`.
  - `lruAt` is the legacy LRU serial. It is **not** a placement or observation
    time and is preserved verbatim across save/restore.
  - `queryPlacedNear` refreshes the LRU serial of returned cells, mirroring the
    legacy query semantics; this marks the ledger dirty.
  - `placedBlocks()` is ordered by ascending `lruAt` (then key).
- Visits: `visitChunk(dim, cx, cz)` (consecutive repeats of the same chunk do not
  increment, matching the legacy counter), `visit(dim, blockPos)`,
  `importVisit(dim, cx, cz, count, source)`, `chunkVisits(dim?)`,
  `chunkVisitCount(dim, cx, cz)`, `novelty(dim, cx, cz)`.
- Portal crossings: `recordPortalTraversal(input)`, `portalTraversals({kind,
  direction}?)`, `portalReturnVerified(traversal)`.
  - The raw `from`/`to` endpoint evidence, sessions, observation ids and `ts`
    are stored verbatim. `direction` is only what the caller asserted
    (`unclassified` by default); a return is proven by a reverse crossing and is
    derived, never rewritten as current truth.
  - `fromEndpoint.id`/`toEndpoint.id` must match the crossing ids, and endpoint
    worlds must match the session world.
- Snapshots: `snapshot()`, `measure()`, `restoreSnapshot()`.

`checkpoint()` always captures the complete world-scoped ledger and writes it as
`ledgerMode: 'full'` in the same transaction as history, voxel and the append-only
journal batch. The capture revision is reported in `SpatialCheckpointResult.ledgerRevision`;
only that captured snapshot is marked confirmed on ACK, so later ledger changes
stay dirty. History-only sessions never touch ledger rows.

## Spatial event kinds

`spatial_events` now accepts `cell_blocked`, `cell_cleared` and
`cell_revalidated` alongside `observed_cell_change` and `observation_gap`. Each
cell event carries coordinates, `sessionId`, `observedAt`, a required `evidence`
observation (same world/dim/pos/session/time as the event), an optional
`previous` observation (absence means unknown, never air) and an optional
confirmed `actionId`. The journal's existing record/depth/array/byte bounds apply
to these payloads; `queryEvents({kind})` filters all five kinds.

## Offline migration rehearsal (§9.1)

`runLegacyMigrationDryRun()` still never executes a real migration, switches
authority or removes a legacy write path. It still returns
`realMigrationPerformed: false`, `realAuthoritySwitch: false` and
`legacyWritePathRemoved: false`.

It now rehearses, in the caller's temporary SQLite database:

- passages (unchanged),
- attributed placed blocks (LRU serials preserved),
- exact chunk-visit counts,
- raw portal traversals and End-gateway crossings with endpoint evidence.

Landmarks and portal endpoints are plan-only in this work package because their
storage destination is the topology `spatial_nodes` table; the plan verifies their
ids, counts, times and fields without writing a competing copy.

`batchPlans` contains one entry per collection with source/deleted/imported/
unattributed/cross-world/invalid counts, expected and restored ids and values,
and `idsMatch`/`countsMatch`/`timesMatch`/`evidenceIntact`. `verificationCounts`
aggregates them. Explicit tombstones are honored; missing records without a
tombstone are still reported instead of being treated as deletions. Unattributed
placed records (legacy `x,y,z` only) and other-world records are listed and
counted, never assigned to the rehearsal world.

## Verification performed

- `tsc -p tsconfig.build.json` and `tsc --noEmit` are clean.
- Targeted suites: 160 tests passing (`storage-checkpoint`, `spatial-checkpoint`,
  `spatial-checkpoint-incremental`, `event-persistence`,
  `legacy-migration-dry-run`, `migration-batch`, `storage-ledger`).
- Full Vitest suite: 848 tests passing. The three `acceptance/*.test.mjs` files
  are standalone acceptance harness files, not Vitest suites, and report "no
  test suite found" under a plain `vitest run`.
- New coverage includes: ledger round-trip, LRU-vs-time preservation, deletion
  and full-replacement semantics, world isolation, ledger-without-baseline
  corruption, v4 → v5 migration (backup + explicit section columns + preserved
  facts), v2 payload dedupe with v1 decode, all three new event kinds and their
  scope/time validation, ledger/journal capacity bounds, and per-collection
  dry-run id/count/time/unattributed verification.

## Residual / not done

- No real migration, authority switch or removal of the JSON write path. The
  rehearsal only uses a caller-provided temporary database.
- Landmarks and portal endpoints have no dedicated storage table in this work
  package (they belong to topology `spatial_nodes`); the dry run plans and
  verifies them but does not persist them.
- Unattributed legacy placements are reported in the dry-run plan but there is no
  public API that writes them as `world_id IS NULL` rows. The v5 table accepts
  such rows; persisting them needs a global migration authority rather than a
  world-bound session method.
- The ledger is rewritten in full on every checkpoint. Incremental ledger deltas
  are not implemented; measured volume did not yet require them.
- No cross-store transaction is claimed between JSON and SQLite; the dry run
  makes no such claim either.
