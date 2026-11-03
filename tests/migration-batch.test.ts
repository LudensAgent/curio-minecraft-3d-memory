import { describe, expect, it } from 'vitest';

import { selectMigrationBatch } from '../src/storage/sqlite/migration.js';
import type { MigrationRowMeta } from '../src/storage/sqlite/migration.js';

function row(rowid: number, bytes: number): MigrationRowMeta {
  return { rowid, world_id: 'world', id: `s${rowid}`, bytes };
}

describe('selectMigrationBatch', () => {
  it('shrinks a batch to fit the byte budget instead of rejecting', () => {
    // 55 sections of ~1.25 MB each total ~65 MiB — over a 64 MiB batch — but must be
    // processed in multiple passes, not rejected (the reported repro was 55 sections,
    // 68,493,065 bytes total).
    const sectionBytes = 1_250_000;
    const rows = Array.from({ length: 55 }, (_, i) => row(i + 1, sectionBytes));
    const batchBytes = 64 * 1024 * 1024;

    const first = selectMigrationBatch(rows, 16 * 1024 * 1024, batchBytes);
    expect(first.length).toBeLessThan(55); // shrunk, not all 55 at once
    expect(first[0]!.rowid).toBe(1);
    const firstBytes = first.reduce((sum, r) => sum + r.bytes, 0);
    expect(firstBytes).toBeLessThanOrEqual(batchBytes);

    // Adding the next row would exceed the budget.
    const next = rows[first.length]!;
    expect(firstBytes + next.bytes).toBeGreaterThan(batchBytes);

    // The remainder is selected in a later pass.
    const rest = selectMigrationBatch(rows.slice(first.length), 16 * 1024 * 1024, batchBytes);
    expect(rest.length).toBe(55 - first.length);
    expect(rest[0]!.rowid).toBe(first.length + 1);
  });

  it('rejects a single section over the per-section limit', () => {
    expect(() => selectMigrationBatch([row(1, 200)], 100, 64)).toThrow(/migration byte limit/);
  });

  it('selects the whole window when it fits the byte budget', () => {
    const rows = [row(1, 10), row(2, 20), row(3, 30)];
    expect(selectMigrationBatch(rows, 100, 100)).toEqual(rows);
  });
});
