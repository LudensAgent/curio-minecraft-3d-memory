import { describe, expect, it } from 'vitest';

import { selectMigrationBatch } from '../src/storage/sqlite/migration.js';
import type { MigrationRowMeta } from '../src/storage/sqlite/migration.js';
import { evaluateMigrationGate } from '../src/compat/migration-dry-run.js';
import type { LegacyMigrationGateInput } from '../src/compat/migration-dry-run.js';

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

// =============================================================================
// M6.3 authority gate: decidable conditions, never an automatic switch
// =============================================================================

function gateInput(): LegacyMigrationGateInput {
  return {
    stages: {
      a: { status: 'passed' },
      b: { status: 'passed', problems: [] },
      c: {
        status: 'passed',
        deletedNotResurrected: true,
        deletedIdsChecked: ['psg_deleted'],
        verification: { problems: [] },
      },
      d: { status: 'passed', sessionsClosed: true, sourceSnapshotUnchanged: true },
    },
    verificationCounts: {
      allVerified: true,
      unattributedRecords: 0,
      crossWorldRecords: 0,
      invalidRecords: 0,
    },
    batchPlans: [
      { batch: 'passages', status: 'imported', ok: true },
      { batch: 'landmarks', status: 'imported', ok: true },
    ],
  };
}

describe('evaluateMigrationGate', () => {
  it('reports satisfied_but_disabled only when every named condition holds', () => {
    const gate = evaluateMigrationGate(gateInput(), { operatorOptIn: true });

    // The decision is a condition list with observed facts, not one boolean.
    expect(gate.conditions).toHaveLength(8);
    expect(gate.conditions.every((condition) => condition.ok)).toBe(true);
    expect(gate.conditions.every((condition) => Object.keys(condition.observed).length > 0)).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.satisfied).toBe(true);
    // Satisfied is still disabled: nothing in the gate switches authority.
    expect(gate.status).toBe('satisfied_but_disabled');
    expect(gate.autoSwitchImplemented).toBe(false);
    expect(gate.requiresManualEnable).toBe(true);
    expect(gate.operatorOptIn).toBe(true);
    expect(gate.guarantees).toEqual({
      realAuthoritySwitch: false,
      legacyWritePathRemoved: false,
      dualWrite: false,
      jsonReadFallbackForMissingRecords: false,
    });
    expect(gate.rollback).toBe('drop_temp_database_and_reopen_legacy');
  });

  it('reports not_satisfied by default and emits one coded reason per failed condition', () => {
    const input = gateInput();
    const gate = evaluateMigrationGate({
      ...input,
      verificationCounts: {
        ...input.verificationCounts,
        allVerified: false,
        unattributedRecords: 2,
      },
      batchPlans: [{ batch: 'landmarks', status: 'planned', ok: true }],
    });

    expect(gate.status).toBe('not_satisfied');
    expect(gate.satisfied).toBe(false);
    expect(gate.reasons.map((reason) => reason.code)).toEqual([
      'batch_not_verified',
      'unattributed_records',
      'batch_planned_only',
    ]);
    for (const reason of gate.reasons) {
      expect(reason.detail).toContain(reason.code);
      expect(reason.observed).toBeDefined();
    }
    expect(gate.reasons.find((reason) => reason.code === 'unattributed_records')!.observed).toEqual({
      unattributedRecords: 2,
    });
    const plannedReason = gate.reasons.find((reason) => reason.code === 'batch_planned_only')!;
    expect(plannedReason.observed.plannedBatches).toContain('landmarks');
  });

  it('gate: fabricated resurrected_deleted_passage reason is not_satisfied', () => {
    // Synthetic input (no importer): the real importer path is covered end to
    // end at tests/legacy-migration-dry-run.test.ts:971-1006.
    const input = gateInput();
    const gate = evaluateMigrationGate({
      ...input,
      stages: {
        ...input.stages,
        c: {
          ...input.stages.c,
          deletedNotResurrected: false,
          verification: {
            problems: [{ code: 'resurrected_deleted_passage', id: 'psg_deleted' }],
          },
        },
      } as LegacyMigrationGateInput['stages'],
    });

    expect(gate.status).toBe('not_satisfied');
    const reason = gate.reasons.find((entry) => entry.code === 'deleted_resurrected')!;
    expect(reason).toBeDefined();
    expect(reason.observed).toMatchObject({ resurrectedIds: ['psg_deleted'] });
    const condition = gate.conditions.find((entry) => entry.condition === 'deleted_not_resurrected')!;
    expect(condition.ok).toBe(false);
    expect(condition.observed.resurrectedIds).toEqual(['psg_deleted']);
  });

  it('records operator opt-in without changing any guarantee', () => {
    const gate = evaluateMigrationGate(gateInput(), { operatorOptIn: true });
    expect(gate.operatorOptIn).toBe(true);
    expect(gate.guarantees.dualWrite).toBe(false);
    expect(gate.guarantees.jsonReadFallbackForMissingRecords).toBe(false);
    expect(gate.autoSwitchImplemented).toBe(false);
  });
});
