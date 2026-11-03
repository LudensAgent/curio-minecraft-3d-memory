/**
 * Pure batch-selection for the v2→v3 metadata backfill. Kept separate from the
 * worker thread entry so the byte-budget shrinking can be unit-tested without a
 * running worker.
 */

/**
 * Migration-only processing bounds, independent of the per-world `SnapshotLimits`
 * (which are enforced later, per world, when a specific world is opened). These
 * bound the *peak* decode work of the backfill — one section at a time and one
 * batch at a time — so a single pathologically large payload cannot be decoded
 * unboundedly, without ever treating the whole-database total as a per-world limit.
 */
export const MIGRATION_BATCH_ROWS = 100;
export const MIGRATION_MAX_SECTION_BYTES = 16 * 1024 * 1024; // 16 MiB per section payload
export const MIGRATION_BATCH_BYTES = 64 * 1024 * 1024; // 64 MiB decoded per batch

/** One row of the migration metadata window (identity + committed payload byte size). */
export interface MigrationRowMeta {
  rowid: number;
  world_id: string;
  id: string;
  bytes: number;
}

/**
 * Select the largest leading sub-batch of `rows` whose payload bytes fit within
 * `batchBytes`, with each row individually bounded by `maxSectionBytes`. A batch
 * that would exceed the byte budget is *shrunk*, never rejected — a large but
 * valid database is backfilled in multiple passes. Only a single section over
 * `maxSectionBytes` is rejected (a corrupt/pathological payload).
 */
export function selectMigrationBatch(
  rows: readonly MigrationRowMeta[],
  maxSectionBytes: number,
  batchBytes: number,
): MigrationRowMeta[] {
  const selected: MigrationRowMeta[] = [];
  let total = 0;
  for (const row of rows) {
    if (row.bytes > maxSectionBytes) {
      throw new Error(`section payload exceeds the migration byte limit (${row.bytes})`);
    }
    if (selected.length > 0 && total + row.bytes > batchBytes) break;
    selected.push(row);
    total += row.bytes;
  }
  return selected;
}
