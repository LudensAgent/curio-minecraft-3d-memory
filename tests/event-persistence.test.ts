import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import type { ActionRecord, NavResult, Observation } from '../src/index.js';
import type { SpatialEvent } from '../src/storage/sqlite/types.js';
import { openSpatialSession, PersistenceError } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };
const air = { name: 'minecraft:air', properties: {} };

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: stone,
    pos: { x: 0, y: 64, z: 0 },
    ...overrides,
  };
}

const cancelledResult: NavResult = {
  outcome: 'CANCELLED',
  message: 'stopped by the agent after a partial crossing',
  trace: [
    { pos: { x: 0, y: 64, z: 0 }, ts: 1000 },
    { pos: { x: 1, y: 64, z: 0 }, ts: 1200 },
  ],
  consumption: { placed: [{ pos: { x: 1, y: 64, z: 0 }, name: 'minecraft:dirt' }], durabilityLost: 3, digMs: 12 },
  memoryWrite: 'pending',
  lastPosition: { x: 1, y: 64, z: 0 },
  lastObservation: {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1200,
    onGround: true,
    inWater: false,
  },
  confirmed: false,
  problem: { kind: 'cancelled', by: 'agent', reason: 'manual stop' },
};

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: 'a1',
    ts: 1000,
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    delegationId: 'deleg-1',
    delegation: {
      requestedTarget: 'the cave entrance',
      target: { x: 1, y: 64, z: 0 },
      allowedModes: ['walk'],
      arrival: { kind: 'near', radius: 1 },
      allowDigging: false,
      allowPlacing: true,
      allowTower: false,
      materials: [{ name: 'minecraft:dirt', maxCount: 4 }],
      exploration: 'known_only',
    },
    subActions: [
      {
        kind: 'place',
        at: { x: 1, y: 64, z: 0 },
        block: 'minecraft:dirt',
        origin: 'execution_helper',
        targetRole: 'support',
        outcome: 'ok',
        effects: [
          {
            kind: 'placed',
            at: { x: 1, y: 64, z: 0 },
            block: 'minecraft:dirt',
            observedAt: 1100,
            worldId: WORLD,
            dim: DIM,
            sessionId: 's1',
            actionId: 'a1',
            verified: true,
          },
        ],
      },
    ],
    from: { x: 0, y: 64, z: 0 },
    to: { x: 1, y: 64, z: 0 },
    trace: [
      { pos: { x: 0, y: 64, z: 0 }, ts: 1000 },
      { pos: { x: 1, y: 64, z: 0 }, ts: 1200 },
    ],
    consumption: { placed: [{ pos: { x: 1, y: 64, z: 0 }, name: 'minecraft:dirt' }], durabilityLost: 3, digMs: 12 },
    observedChanges: [obs({ observedAt: 1200, pos: { x: 1, y: 64, z: 0 }, actionId: 'a1', evidence: 'confirmed_effect', source: 'agent_action' })],
    failureAt: { x: 1, y: 64, z: 0 },
    failureReason: 'manual stop',
    confirmed: false,
    result: structuredClone(cancelledResult),
    ...overrides,
  };
}

function cellChangeEvent(
  id: string,
  options: {
    previous?: Observation;
    sessionId?: string;
    state?: { name: string; properties: Record<string, string> };
    currentSessionId?: string;
    currentObservedAt?: number;
  } = {},
): SpatialEvent {
  const sessionId = options.sessionId ?? 's1';
  return {
    kind: 'observed_cell_change',
    id,
    observedAt: 2000,
    worldId: WORLD,
    dim: DIM,
    sessionId,
    pos: { x: -1, y: 64, z: 2 },
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    current: obs({
      sessionId: options.currentSessionId ?? sessionId,
      observedAt: options.currentObservedAt ?? 2000,
      sequence: 9,
      pos: { x: -1, y: 64, z: 2 },
      state: options.state ?? dirt,
    }),
  };
}

function gapEvent(id: string, sessionId = 's1'): SpatialEvent {
  return {
    kind: 'observation_gap',
    id,
    observedAt: 2500,
    worldId: WORLD,
    dim: DIM,
    sessionId,
    reason: 'paused',
  };
}

// --- temp db helpers ----------------------------------------------------------

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-journal-'));
  tempDirs.push(dir);
  return join(dir, 'journal.db');
}

function tempDirOf(dbPath: string): string {
  return dirname(dbPath);
}

/** Assert a synchronous PersistenceError with an exact machine-readable kind. */
function expectKind(fn: () => unknown, kind: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PersistenceError);
    expect((err as PersistenceError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a PersistenceError of kind "${kind}"`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Synchronous pending acceptance
// ==============================================================================

describe('pending journal acceptance', () => {
  it('canonical duplicate replay is idempotent, including object-key order changes', async () => {
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    const original = action({ id: 'a-dup' });

    const first = session.journal.recordAction(original);
    expect(first).toMatchObject({ accepted: true, duplicate: false, pendingRecords: 1 });
    const revision = first.revision;

    // Same semantic content, object keys inserted in a different order.
    const reordered: ActionRecord = {
      confirmed: original.confirmed,
      result: original.result,
      observedChanges: original.observedChanges,
      consumption: original.consumption,
      trace: original.trace,
      to: original.to,
      from: original.from,
      subActions: original.subActions,
      delegation: original.delegation,
      sessionId: original.sessionId,
      delegationId: original.delegationId,
      dim: original.dim,
      worldId: original.worldId,
      ts: original.ts,
      id: original.id,
      failureAt: original.failureAt,
      failureReason: original.failureReason,
    };
    const replay = session.journal.recordAction(reordered);
    expect(replay).toMatchObject({ accepted: true, duplicate: true, pendingRecords: 1, revision });
    expect(session.journal.readPending().actions).toHaveLength(1);

    expectKind(() => session.journal.recordAction({ ...original, ts: 9999 }), 'conflict');
    expect(session.journal.readPending().actions).toHaveLength(1);
    await session.close();
  });

  it('isolates the same id across sessions and scopes by world', async () => {
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    session.journal.recordAction(action({ id: 'shared', sessionId: 's1' }));
    const second = session.journal.recordAction(action({ id: 'shared', sessionId: 's2' }));
    expect(second).toMatchObject({ duplicate: false, pendingRecords: 2 });

    expectKind(
      () => session.journal.recordAction(action({ id: 'other-world', worldId: 'elsewhere' })),
      'invalid_argument',
    );
    expect(session.journal.readPending().actions).toHaveLength(2);
    await session.close();
  });

  it('scopes identity by kind, so an action and an event may share world/session/id', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const sharedAction = action({ id: 'shared' });
    const sharedEvent = cellChangeEvent('shared');

    // One batch: the same id in the action and event namespaces is not a conflict.
    expect(session.journal.recordBatch({ actions: [sharedAction], events: [sharedEvent] })).toMatchObject({
      accepted: 2,
      duplicates: 0,
      pendingRecords: 2,
    });
    // Replays are idempotent per kind, still without cross-kind conflict.
    expect(session.journal.recordAction(sharedAction)).toMatchObject({ duplicate: true, pendingRecords: 2 });
    expect(session.journal.recordEvent(sharedEvent)).toMatchObject({ duplicate: true, pendingRecords: 2 });
    // Same-kind different content still conflicts in both namespaces.
    expectKind(() => session.journal.recordAction({ ...sharedAction, ts: 4242 }), 'conflict');
    expectKind(() => session.journal.recordEvent(cellChangeEvent('shared', { state: air })), 'conflict');

    // Separate calls on another pair also coexist without sharing a namespace.
    expect(session.journal.recordAction(action({ id: 'separate' }))).toMatchObject({ duplicate: false });
    expect(session.journal.recordEvent(gapEvent('separate'))).toMatchObject({ duplicate: false });

    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await reopened.queryActions({ actionId: 'shared' })).records.map((a) => a.id)).toEqual(['shared']);
    expect((await reopened.queryEvents({ eventId: 'shared' })).records.map((e) => e.id)).toEqual(['shared']);
    expect((await reopened.queryActions({ actionId: 'separate' })).records.map((a) => a.id)).toEqual(['separate']);
    expect((await reopened.queryEvents({ eventId: 'separate' })).records.map((e) => e.id)).toEqual(['separate']);
    await reopened.close();
  });

  it('accepts or rejects a batch atomically (mixed-world input changes nothing)', async () => {
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    const base = session.journal.recordAction(action({ id: 'kept' }));
    expect(base.pendingRecords).toBe(1);

    expectKind(
      () =>
        session.journal.recordBatch({
          actions: [action({ id: 'valid-new' }), action({ id: 'bad-world', worldId: 'other' })],
        }),
      'invalid_argument',
    );
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['kept']);

    const accepted = session.journal.recordBatch({
      actions: [action({ id: 'batch-a' }), action({ id: 'batch-b' })],
      events: [gapEvent('batch-gap')],
    });
    expect(accepted).toMatchObject({ accepted: 3, duplicates: 0, pendingRecords: 4 });
    await session.close();
  });

  it('records event evidence without touching the voxel map or inventing a previous state', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');

    session.journal.recordEvent(cellChangeEvent('never-known'));
    // Recording an event never feeds the observation map.
    expect(session.voxel.cellAt(DIM, -1, 64, 2)).toEqual({ observed: false });
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.cellAt(DIM, -1, 64, 2)).toEqual({ observed: false });
    expect((await reopened.queryEvents()).records[0]).toMatchObject({ id: 'never-known' });
    expect((await reopened.queryEvents()).records[0]!).not.toHaveProperty('previous');
    await reopened.close();
  });

  it('rejects a current observation from another session without changing pending state', async () => {
    // Deliberately outside tempDirs: this directory may only be removed after
    // the opened session has confirmed a clean close.
    const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-journal-'));
    const session = await openSpatialSession({ databasePath: join(dir, 'journal.db'), worldId: WORLD });
    try {
      const baseline = session.journal.recordEvent(gapEvent('baseline'));
      const before = session.journal.readPending();

      // The batch holds one valid normal event before the mismatched one; the whole
      // batch must be rejected, leaving content, bytes and revision untouched.
      expectKind(
        () =>
          session.journal.recordBatch({
            events: [
              gapEvent('normal-before'),
              cellChangeEvent('bad-current-session', { currentSessionId: 'stale-session' }),
            ],
          }),
        'invalid_argument',
      );

      const after = session.journal.readPending();
      expect(after).toEqual(before);
      expect(after.bytes).toBe(before.bytes);
      expect(after.revision).toBe(baseline.revision);
      expect(session.getPersistenceState()).toMatchObject({ pendingJournalRecords: 1, dirty: true });
    } finally {
      const closed = await session.close();
      expect(closed).toMatchObject({
        completed: true,
        error: null,
        unconfirmedRequest: false,
        dirty: true,
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('rejects a current observation whose acquisition time differs from the event without changing pending state', async () => {
    // Deliberately outside tempDirs: this directory may only be removed after
    // the opened session has confirmed a clean close.
    const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-journal-'));
    const session = await openSpatialSession({ databasePath: join(dir, 'journal.db'), worldId: WORLD });
    try {
      const baseline = session.journal.recordEvent(gapEvent('baseline'));
      const before = session.journal.readPending();

      expectKind(
        () => session.journal.recordEvent(cellChangeEvent('bad-current-time', { currentObservedAt: 1999 })),
        'invalid_argument',
      );

      const after = session.journal.readPending();
      expect(after).toEqual(before);
      expect(after.bytes).toBe(before.bytes);
      expect(after.revision).toBe(baseline.revision);
      expect(session.getPersistenceState()).toMatchObject({ pendingJournalRecords: 1, dirty: true });
    } finally {
      const closed = await session.close();
      expect(closed).toMatchObject({
        completed: true,
        error: null,
        unconfirmedRequest: false,
        dirty: true,
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});

// ==============================================================================
// Checkpoint ACK + reopen + paged roundtrip
// ==============================================================================

describe('journal checkpoint roundtrip', () => {
  it('round-trips a cancelled/partial action with its original result, timestamps and evidence', async () => {
    // Deliberately outside tempDirs: this directory is removed only after both
    // sequentially opened sessions have confirmed a clean close.
    const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-journal-'));
    const dbPath = join(dir, 'journal.db');
    const original = action({ id: 'a-cancelled' });
    const expected = structuredClone(original);
    let checkpointId: string | undefined;
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      session.journal.recordAction(original);

      // Acceptance is an immutable snapshot: later caller mutation must not leak.
      original.trace.push({ pos: { x: 99, y: 99, z: 99 }, ts: 9999 });
      original.result!.message = 'mutated after acceptance';
      original.consumption.durabilityLost = 999;

      const stateBefore = session.getPersistenceState();
      expect(stateBefore.dirty).toBe(true);
      expect(stateBefore.pendingJournalRecords).toBe(1);

      const checkpoint = await session.checkpoint();
      checkpointId = checkpoint.checkpointId;
      const stateAfter = session.getPersistenceState();
      expect(stateAfter.pendingJournalRecords).toBe(0);
      expect(stateAfter.dirty).toBe(false);
      expect(stateAfter.journalBaselineCheckpointId).toBe(checkpoint.checkpointId);
      expect(stateAfter.confirmedJournalRevision).toBe(stateAfter.journalRevision);
      expect(stateAfter.committedJournalRecords).toBe(1);
    } finally {
      const closed = await session.close();
      expect(closed).toMatchObject({
        completed: true,
        error: null,
        unconfirmedRequest: false,
        dirty: false,
      });
    }

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(reopened.getPersistenceState()).toMatchObject({
        journalBaselineCheckpointId: checkpointId,
        committedJournalRecords: 1,
        pendingJournalRecords: 0,
        dirty: false,
      });
      const page = await reopened.queryActions();
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(page.records).toEqual([expected]);
      expect(page.records[0]!.result).toMatchObject({
        outcome: 'CANCELLED',
        confirmed: false,
        memoryWrite: 'pending',
        problem: { kind: 'cancelled', by: 'agent' },
      });
      expect(page.records[0]!.result!.consumption).toEqual(expected.result!.consumption);
      expect(page.records[0]!.subActions[0]!.origin).toBe('execution_helper');
      expect(page.records[0]!.subActions[0]!.effects![0]!.verified).toBe(true);
    } finally {
      const closed = await reopened.close();
      expect(closed).toMatchObject({
        completed: true,
        error: null,
        unconfirmedRequest: false,
        dirty: false,
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('round-trips observed-change and gap evidence, preserving previous absence', async () => {
    const dbPath = makeDbPath();
    // The previous observation is a real earlier snapshot from a different session.
    // It must survive verbatim; only the current observation belongs to this event.
    const previous = obs({ sessionId: 's0-earlier', observedAt: 500, state: stone, pos: { x: -1, y: 64, z: 2 } });
    const withPrevious = cellChangeEvent('change-with-previous', { previous });
    const withoutPrevious = cellChangeEvent('change-without-previous');
    const gap = gapEvent('gap-1');
    const expected = structuredClone([withPrevious, withoutPrevious, gap]);

    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordBatch({ events: [withPrevious, withoutPrevious, gap] });
    await session.checkpoint();
    expect(session.getPersistenceState()).toMatchObject({ dirty: false, pendingJournalRecords: 0 });
    expect(session.getPersistenceState().confirmedJournalRevision).toBe(session.getPersistenceState().journalRevision);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.getPersistenceState()).toMatchObject({ dirty: false, committedJournalRecords: 3 });
    const page = await reopened.queryEvents();
    expect(page.records).toEqual(expected);
    const noPrevious = page.records.find((e) => e.id === 'change-without-previous')!;
    expect('previous' in noPrevious).toBe(false);
    const changed = page.records[0]! as Extract<SpatialEvent, { kind: 'observed_cell_change' }>;
    expect(changed.previous).toEqual(previous);
    expect(changed.previous!.sessionId).toBe('s0-earlier');
    expect(changed.previous!.observedAt).toBe(500);
    expect(changed.current).toMatchObject({ sessionId: 's1', observedAt: 2000 });

    const gapsOnly = await reopened.queryEvents({ kind: 'observation_gap' });
    expect(gapsOnly.records.map((e) => e.id)).toEqual(['gap-1']);
    const sessionFiltered = await reopened.queryEvents({ sessionId: 's1', dim: DIM });
    expect(sessionFiltered.records).toHaveLength(3);
    expect((await reopened.queryEvents({ sessionId: 'other' })).records).toEqual([]);

    // Event queries never install or refresh cells in the voxel map.
    expect(reopened.voxel.cellAt(DIM, -1, 64, 2)).toEqual({ observed: false });
    await reopened.close();
  });

  it('never manufactures ARRIVED or rewrites a legacy result', async () => {
    const dbPath = makeDbPath();
    const legacy = action({
      id: 'legacy',
      confirmed: true,
      result: undefined,
    });
    const partial = action({
      id: 'partial',
      confirmed: true,
      result: {
        outcome: 'PARTIAL',
        message: 'stopped halfway',
        trace: [{ pos: { x: 0, y: 64, z: 0 }, ts: 1000 }],
        memoryWrite: 'saved',
        confirmed: true,
        lastPosition: { x: 0, y: 64, z: 0 },
      },
    });
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordBatch({ actions: [legacy, partial] });
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const records = (await reopened.queryActions()).records;
    expect(records[0]).toMatchObject({ id: 'legacy', confirmed: true });
    expect(records[0]!.result).toBeUndefined();
    expect(records[1]!.result).toMatchObject({ outcome: 'PARTIAL', memoryWrite: 'saved' });
    await reopened.close();
  });
});

// ==============================================================================
// Conflict rollback and capacity
// ==============================================================================

describe('journal conflicts and capacity', () => {
  it('rolls back every checkpoint domain on a durable conflict, then progresses after withdrawal', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    first.voxel.beginSession('s1');
    first.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const committedAction = action({ id: 'a1', ts: 1111 });
    first.journal.recordAction(committedAction);
    const firstCheckpoint = await first.checkpoint();
    await first.close();

    const second = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    second.voxel.beginSession('s1');
    // New facts in every domain, including a conflicting action replay.
    second.voxel.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    second.journal.recordAction(action({ id: 'a1', ts: 9999 })); // different canonical content
    second.journal.recordEvent(gapEvent('gap-new'));

    await expect(second.checkpoint()).rejects.toMatchObject({ kind: 'conflict' });
    const pending = second.journal.readPending();
    expect(pending.actions.map((a) => a.id)).toEqual(['a1']);
    expect(pending.events.map((e) => e.id)).toEqual(['gap-new']);
    expect(second.getPersistenceState().dirty).toBe(true);

    // Previous journal fact and all prior checkpoint domains remain intact.
    const committed = await second.queryActions({ actionId: 'a1' });
    expect(committed.records[0]!.ts).toBe(1111);
    expect((await second.queryEvents()).records).toEqual([]);

    // Targeted withdrawal of only the conflicting item lets the rest progress.
    const withdrawal = second.journal.withdraw({ actions: [{ sessionId: 's1', id: 'a1' }] });
    expect(withdrawal.withdrawn.actions.map((a) => a.id)).toEqual(['a1']);
    expect(withdrawal.missing).toEqual([]);
    await second.checkpoint();
    expect(second.getPersistenceState().dirty).toBe(false);
    await second.close();

    const third = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await third.queryActions({ actionId: 'a1' })).records[0]!.ts).toBe(1111);
    expect((await third.queryEvents()).records.map((e) => e.id)).toEqual(['gap-new']);
    const cell = third.voxel.cellAt(DIM, 0, 0, 0);
    expect(cell.observed).toBe(true);
    if (!cell.observed) throw new Error('expected observed cell');
    expect(cell.evidence.observation.state).toEqual(dirt);
    await third.close();
    expect(firstCheckpoint.checkpointId).not.toBeNull();
  });

  it('rejects an over-capacity pending record atomically and preserves earlier entries', async () => {
    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      journalLimits: { maxPendingRecords: 1 },
    });
    session.journal.recordAction(action({ id: 'first' }));
    expectKind(() => session.journal.recordAction(action({ id: 'second' })), 'capacity');
    expectKind(
      () => session.journal.recordBatch({ actions: [action({ id: 'b1' }), action({ id: 'b2' })] }),
      'capacity',
    );
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['first']);
    await session.close();
  });

  it('enforces cumulative batch capacity before inspecting or retaining later records', async () => {
    // Measure one canonical record with a 6-character id; ids of equal length have
    // identical canonical sizes, so three records need exactly 3 × `unit` bytes.
    const probe = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    const unit = probe.journal.recordAction(action({ id: 'size-a' })).pendingBytes;
    await probe.close();

    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      journalLimits: { maxPendingBytes: unit * 3 - 1, maxRecordBytes: unit },
    });
    const baseline = session.journal.recordAction(action({ id: 'size-b' }));
    expect(baseline.pendingBytes).toBe(unit);

    // The third input is never inspected: reading `ts` would throw a plain Error,
    // so a capacity rejection proves the later record was not staged or retained.
    const later = action({ id: 'size-c' });
    Object.defineProperty(later, 'ts', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('a record after the capacity crossing was inspected');
      },
    });

    expectKind(
      () =>
        session.journal.recordBatch({
          actions: [action({ id: 'size-d' }), action({ id: 'size-e' }), later],
        }),
      'capacity',
    );

    // The whole rejected batch left the pre-existing pending state byte-for-byte
    // and revision-for-revision unchanged (the first fresh record was not retained).
    const pending = session.journal.readPending();
    expect(pending.actions.map((a) => a.id)).toEqual(['size-b']);
    expect(pending.bytes).toBe(unit);
    expect(pending.revision).toBe(baseline.revision);
    expect(session.getPersistenceState()).toMatchObject({ pendingJournalRecords: 1, dirty: true });
    await session.close();
  });

  it('validates the entire withdrawal selector before mutating any pending entry', async () => {
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD });
    session.journal.recordBatch({
      actions: [action({ id: 'keep-a' })],
      events: [gapEvent('keep-e')],
    });
    const before = session.journal.readPending();

    // The first selector is valid; the second is malformed. Nothing may be lost.
    expectKind(
      () =>
        session.journal.withdraw({
          actions: [{ sessionId: 's1', id: 'keep-a' }],
          events: [{ sessionId: 's1', id: '' }],
        }),
      'invalid_argument',
    );

    const after = session.journal.readPending();
    expect(after.actions.map((a) => a.id)).toEqual(['keep-a']);
    expect(after.events.map((e) => e.id)).toEqual(['keep-e']);
    expect(after.bytes).toBe(before.bytes);
    expect(after.revision).toBe(before.revision);
    expect(session.getPersistenceState()).toMatchObject({
      pendingJournalRecords: 2,
      pendingJournalBytes: before.bytes,
    });

    // A valid selector still withdraws and reports the exact returned facts.
    const withdrawn = session.journal.withdraw({
      actions: [{ sessionId: 's1', id: 'keep-a' }],
      events: [{ sessionId: 's1', id: 'keep-e' }],
    });
    expect(withdrawn.withdrawn.actions.map((a) => a.id)).toEqual(['keep-a']);
    expect(withdrawn.withdrawn.events.map((e) => e.id)).toEqual(['keep-e']);
    expect(withdrawn.missing).toEqual([]);
    expect(withdrawn.revision).toBe(before.revision + 1);
    expect(withdrawn.pendingRecords).toBe(0);
    await session.close();
  });

  it('durable capacity keeps pending records dirty and allows duplicate replay at the cap', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      journalLimits: { maxCommittedRecords: 1 },
    });
    const first = action({ id: 'a1' });
    session.journal.recordAction(first);
    await session.checkpoint();
    expect(session.getPersistenceState()).toMatchObject({ committedJournalRecords: 1, dirty: false });

    // Identical replay at the cap consumes no extra quota.
    session.journal.recordAction(structuredClone(first));
    await session.checkpoint();
    expect(session.getPersistenceState()).toMatchObject({ committedJournalRecords: 1, dirty: false });

    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 5, y: 64, z: 0 } }));
    session.journal.recordAction(action({ id: 'a2' }));
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['a2']);
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.close();

    // The rejected checkpoint rolled back the new voxel fact too.
    const reopened = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      journalLimits: { maxCommittedRecords: 1 },
    });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['a1']);
    expect(reopened.voxel.cellAt(DIM, 5, 64, 0).observed).toBe(false);
    await reopened.close();
  });

  it('an empty journal checkpoint confirms a withdrawal revision without deleting committed rows', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'committed' }));
    await session.checkpoint();
    const revisionBefore = session.getPersistenceState().journalRevision;

    session.journal.recordAction(action({ id: 'pending-a' }));
    session.journal.recordAction(action({ id: 'pending-b' }));
    const withdrawn = session.journal.withdraw({
      actions: [
        { sessionId: 's1', id: 'pending-a' },
        { sessionId: 's1', id: 'pending-b' },
      ],
    });
    expect(withdrawn.withdrawn.actions).toHaveLength(2);
    expect(withdrawn.revision).toBeGreaterThan(revisionBefore);
    expect(session.journal.readPending().actions).toEqual([]);
    expect(session.getPersistenceState().dirty).toBe(true);

    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    expect(session.getPersistenceState().confirmedJournalRevision).toBe(withdrawn.revision);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['committed']);
    await reopened.close();
  });
});

// ==============================================================================
// In-flight capture, paging and lifecycle
// ==============================================================================

describe('journal checkpoint capture and paging', () => {
  it('keeps records accepted while a checkpoint is in flight', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'a1', ts: 1000 }));

    const inFlight = session.checkpoint();
    const late = session.journal.recordAction(action({ id: 'a2', ts: 2000 }));
    expect(late.accepted).toBe(true);
    await inFlight;

    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['a2']);
    expect(session.getPersistenceState()).toMatchObject({ committedJournalRecords: 1, dirty: true });

    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['a1', 'a2']);
    await reopened.close();
  });

  it('reports the exact captured journal revision for each truncated checkpoint batch', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      journalLimits: { maxBatchRecords: 1 },
    });
    const r1 = session.journal.recordAction(action({ id: 'c1' })).revision;
    const r2 = session.journal.recordAction(action({ id: 'c2' })).revision;
    const r3 = session.journal.recordAction(action({ id: 'c3' })).revision;
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);

    // Each result reports only the prefix it actually captured and confirmed, not
    // the latest local queue revision (r3).
    const first = await session.checkpoint();
    expect(first.journalRevision).toBe(r1);
    expect(first.journalRevision).not.toBe(session.getPersistenceState().journalRevision);
    expect(session.getPersistenceState()).toMatchObject({
      confirmedJournalRevision: r1,
      pendingJournalRecords: 2,
      dirty: true,
    });
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['c2', 'c3']);

    const second = await session.checkpoint();
    expect(second.journalRevision).toBe(r2);
    expect(session.getPersistenceState()).toMatchObject({
      confirmedJournalRevision: r2,
      pendingJournalRecords: 1,
      dirty: true,
    });
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['c3']);

    const final = await session.checkpoint();
    expect(final.journalRevision).toBe(r3);
    expect(session.getPersistenceState()).toMatchObject({
      confirmedJournalRevision: r3,
      pendingJournalRecords: 0,
      dirty: false,
    });
    expect(session.journal.readPending().actions).toEqual([]);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.getPersistenceState()).toMatchObject({ journalRevision: r3, dirty: false });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['c1', 'c2', 'c3']);
    await reopened.close();
  });

  it('pages by insertion sequence with stable cursors and no loss or duplicates', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const actions = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) =>
      action({ id, ts: 1000 + i, sessionId: i < 3 ? 's1' : 's2', dim: i < 4 ? DIM : 'the_nether' }),
    );
    session.journal.recordBatch({ actions });
    await session.checkpoint();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await session.queryActions({ maxRecords: 2, cursor });
      expect(page.records.length).toBeLessThanOrEqual(2);
      seen.push(...page.records.map((r) => r.id));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor!;
    }
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

    expect((await session.queryActions({ sessionId: 's2' })).records.map((r) => r.id)).toEqual(['p4', 'p5']);
    expect((await session.queryActions({ dim: 'the_nether' })).records.map((r) => r.id)).toEqual(['p5']);
    expect((await session.queryActions({ actionId: 'p3' })).records.map((r) => r.id)).toEqual(['p3']);

    // Byte budget pages before decode can exceed the bound.
    const size = (record: ActionRecord): number => Buffer.byteLength(JSON.stringify(record), 'utf8');
    const budget = size(actions[0]!) + size(actions[1]!);
    const bytePage = await session.queryActions({ maxBytes: budget });
    expect(bytePage.records.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(bytePage.hasMore).toBe(true);
    expect(bytePage.nextCursor).not.toBeNull();
    const next = await session.queryActions({ maxBytes: budget, cursor: bytePage.nextCursor! });
    expect(next.records.map((r) => r.id)).toEqual(['p3', 'p4']);
    expect(next.hasMore).toBe(true);

    // Returned records are isolated copies.
    bytePage.records[0]!.result!.message = 'mutated on a returned page';
    bytePage.records[0]!.trace.push({ pos: { x: 7, y: 7, z: 7 }, ts: 7 });
    const again = await session.queryActions({ actionId: 'p1' });
    expect(again.records[0]!.result!.message).toBe('stopped by the agent after a partial crossing');
    expect(again.records[0]!.trace).toEqual(actions[0]!.trace);
    await session.close();
  });

  it('gates withdrawal and queries while a checkpoint is in flight', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'a1' }));

    const inFlight = session.checkpoint();
    expectKind(
      () => session.journal.withdraw({ actions: [{ sessionId: 's1', id: 'a1' }] }),
      'busy',
    );
    await expect(session.queryActions()).rejects.toMatchObject({ kind: 'busy' });
    await inFlight;
    // The in-flight checkpoint still committed the captured record.
    expect((await session.queryActions()).records.map((a) => a.id)).toEqual(['a1']);
    await session.close();
  });

  it('rejects an individually unpageable record explicitly instead of skipping it', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      journalLimits: { maxPageBytes: 200 },
    });
    session.journal.recordAction(action({ id: 'large' }));
    await session.checkpoint();

    await expect(session.queryActions()).rejects.toMatchObject({ kind: 'capacity' });
    await session.close();
  });
});

// ==============================================================================
// Restart metadata, history-only checkpoints and repeated checkpoints
// ==============================================================================

describe('journal restart and cross-domain checkpoint behavior', () => {
  it('opens from metadata only and only fails when a corrupt payload is actually read', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'a1' }));
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE action_records SET payload = '{not json'").run();
    db.close();

    // Open reads only baseline/count metadata; it must not decode the payload.
    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.getPersistenceState()).toMatchObject({
      committedJournalRecords: 1,
      journalBaselineCheckpointId: expect.any(String),
    });
    await expect(reopened.queryActions()).rejects.toMatchObject({ kind: 'data' });
    await reopened.close();
  });

  it('empty journal checkpoints never delete or duplicate prior journal facts', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'a1' }));
    session.journal.recordEvent(cellChangeEvent('e1'));
    const original = await session.checkpoint();
    const baseline = session.getPersistenceState().journalBaselineCheckpointId;
    await session.close();

    const empty = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    await empty.checkpoint();
    await empty.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    // A combined checkpoint always records its own journal baseline even with an
    // empty batch; the guarantee is that no committed row is deleted or duplicated.
    expect(reopened.getPersistenceState().journalBaselineCheckpointId).not.toBe(baseline);
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['a1']);
    expect((await reopened.queryEvents()).records.map((e) => e.id)).toEqual(['e1']);

    // Repeated combined checkpoints with an empty journal batch keep exactly one row each.
    await reopened.checkpoint();
    await reopened.checkpoint();
    expect(reopened.getPersistenceState().committedJournalRecords).toBe(2);
    expect((await reopened.queryActions()).records).toHaveLength(1);
    expect((await reopened.queryEvents()).records).toHaveLength(1);
    expect(reopened.getPersistenceState().journalBaselineCheckpointId).not.toBe(original.checkpointId);
    await reopened.close();
  });
});

// ==============================================================================
// Lifecycle / recovery
// ==============================================================================

describe('journal lifecycle and recovery', () => {
  it('close reports a dirty unsaved journal and the caller can replay it under the same ids', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const pending = action({ id: 'recover-me' });
    session.journal.recordAction(pending);
    const closed = await session.close();
    expect(closed).toMatchObject({ completed: true, dirty: true, unconfirmedRequest: false });
    expect(session.journal.readPending().actions).toEqual([pending]);
    expectKind(() => session.journal.recordAction(action({ id: 'after-close' })), 'closed');

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const replayed = reopened.journal.recordAction(pending);
    expect(replayed.duplicate).toBe(false);
    await reopened.checkpoint();
    await reopened.close();

    const verified = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await verified.queryActions()).records.map((a) => a.id)).toEqual(['recover-me']);
    await verified.close();
  });

  it('rolls back every checkpoint domain on a real SQL abort, then retries cleanly', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 3, y: 0, z: 0 } }));
    session.journal.recordBatch({
      actions: [action({ id: 'abort-me' })],
      events: [gapEvent('abort-gap')],
    });

    // Real SQLite trigger on a second connection: the worker's append aborts inside
    // the checkpoint transaction (no production fault-injection hook).
    const admin = new Database(dbPath);
    admin.exec(
      "CREATE TRIGGER abort_journal BEFORE INSERT ON action_records WHEN NEW.id = 'abort-me' " +
        "BEGIN SELECT RAISE(ABORT, 'forced journal abort'); END",
    );

    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'sql' });
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['abort-me']);
    expect(session.journal.readPending().events.map((e) => e.id)).toEqual(['abort-gap']);
    expect(session.getPersistenceState()).toMatchObject({ dirty: true, pendingJournalRecords: 2 });

    // Every domain rolled back together: nothing was committed on disk.
    const count = (table: string): number =>
      (admin.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect({
      sections: count('spatial_sections'),
      actions: count('action_records'),
      events: count('spatial_events'),
      checkpoints: count('checkpoints'),
    }).toEqual({ sections: 0, actions: 0, events: 0, checkpoints: 0 });

    admin.exec('DROP TRIGGER abort_journal');
    admin.close();

    // Successful retry commits the same pending batch exactly once.
    await session.checkpoint();
    expect(session.getPersistenceState()).toMatchObject({ dirty: false, pendingJournalRecords: 0 });
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.cellAt(DIM, 3, 0, 0)).toMatchObject({ observed: true });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['abort-me']);
    expect((await reopened.queryEvents()).records.map((e) => e.id)).toEqual(['abort-gap']);
    expect(reopened.getPersistenceState()).toMatchObject({ committedJournalRecords: 2, dirty: false });
    await reopened.close();
  });

  it('keeps recovery facts across a real worker checkpoint timeout and replays to one fact', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    // Enough journal work that the worker cannot finish before a 1 ms ACK deadline.
    const pendingActions = Array.from({ length: 500 }, (_, i) => action({ id: `timeout-${i}` }));
    const replayedFact = pendingActions[0]!;
    session.journal.recordBatch({ actions: pendingActions });

    // Opening needs the normal bound (worker spawn), so shorten only this test
    // session's checkpoint ACK deadline. This is a test-local timer adjustment, not
    // a production fault-injection hook: the worker still runs the real checkpoint.
    (session as unknown as { timeoutMs: number }).timeoutMs = 1;
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'timeout_unconfirmed' });

    // Every accepted fact is still pending, and the session never reports the
    // unconfirmed checkpoint as saved.
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(pendingActions.map((a) => a.id));
    const state = session.getPersistenceState();
    expect(state).toMatchObject({
      dirty: true,
      pendingJournalRecords: pendingActions.length,
      lastConfirmedCheckpointId: null,
      confirmedJournalRevision: 0,
      lastError: expect.objectContaining({ kind: 'timeout_unconfirmed' }),
      unconfirmedCheckpointId: expect.any(String),
    });
    expect(state.committedJournalRecords).toBe(0);
    await session.close();

    // Reopen and replay everything under the same stable ids. Whether the expired
    // checkpoint committed before the worker was terminated or not, each id ends
    // up committed exactly once. A bounded retry absorbs the old worker still
    // finishing (SQLITE_BUSY is surfaced as `kind: 'sql'`).
    const deadline = Date.now() + 10_000;
    for (;;) {
      let reopened: Awaited<ReturnType<typeof openSpatialSession>> | null = null;
      try {
        reopened = await openSpatialSession({
          databasePath: dbPath,
          worldId: WORLD,
          journalLimits: { maxPageRecords: 1000, maxPageBytes: 4 * 1024 * 1024 },
        });
        expect(reopened.journal.recordBatch({ actions: pendingActions })).toMatchObject({
          accepted: pendingActions.length,
          duplicates: 0,
        });
        await reopened.checkpoint();
        const records = (await reopened.queryActions()).records;
        expect(records).toHaveLength(pendingActions.length);
        expect(new Set(records.map((r) => r.id)).size).toBe(pendingActions.length);
        expect((await reopened.queryActions({ actionId: replayedFact.id })).records).toEqual([replayedFact]);
        expect(reopened.getPersistenceState()).toMatchObject({
          committedJournalRecords: pendingActions.length,
          pendingJournalRecords: 0,
          dirty: false,
        });
        await reopened.close();
        break;
      } catch (err) {
        if (reopened !== null) await reopened.close();
        if (Date.now() > deadline || !(err instanceof PersistenceError) || err.kind !== 'sql') throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  it('close waits for an already-accepted checkpoint and clears only its captured batch', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.journal.recordAction(action({ id: 'a1' }));
    const inFlight = session.checkpoint();
    const closed = await session.close();
    await inFlight;
    expect(closed).toMatchObject({ completed: true, dirty: false });
    expect(session.journal.readPending().actions).toEqual([]);

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect((await reopened.queryActions()).records.map((a) => a.id)).toEqual(['a1']);
    await reopened.close();
  });
});

// ==============================================================================
// Schema migration
// ==============================================================================

function schemaVersion(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
  db.close();
  return row.value;
}

function checkpointColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[];
  db.close();
  return cols.map((c) => c.name);
}

/** Turn a current fixture into a true v3 shape (all later schema objects removed). */
function downgradeToV3(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS placed_blocks');
  db.exec('DROP TABLE IF EXISTS chunk_visits');
  db.exec('DROP TABLE IF EXISTS portal_traversals');
  db.exec('DROP INDEX IF EXISTS spatial_sections_world_coords');
  db.exec('ALTER TABLE checkpoints DROP COLUMN ledger_revision');
  db.exec('ALTER TABLE checkpoints DROP COLUMN has_ledger');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN dimension');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cx');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cz');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN sy');
  db.exec('DROP TABLE IF EXISTS action_records');
  db.exec('DROP TABLE IF EXISTS spatial_events');
  db.exec('ALTER TABLE checkpoints DROP COLUMN journal_revision');
  db.exec('ALTER TABLE checkpoints DROP COLUMN has_journal');
  db.exec('DROP TABLE IF EXISTS fact_places');
  db.exec('DROP TABLE IF EXISTS fact_resources');
  db.exec('DROP TABLE IF EXISTS fact_containers');
  db.exec('DROP TABLE IF EXISTS fact_domain');
  db.exec("DELETE FROM schema_meta WHERE key IN ('fact_migration_version', 'fact_migration_target')");
  db.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
}

describe('v3 → v4 journal migration', () => {
  it('upgrades a v3 database, preserves history/voxel facts, backs up, and starts with an empty journal', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await save.checkpoint();
    await save.close();

    const db = new Database(dbPath);
    downgradeToV3(db);
    db.close();
    expect(schemaVersion(dbPath)).toBe('3');

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(schemaVersion(dbPath)).toBe('10');
    expect(checkpointColumns(dbPath)).toEqual(
      expect.arrayContaining(['journal_revision', 'has_journal', 'topology_extras']),
    );
    expect(reopened.voxel.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    expect(reopened.getPersistenceState()).toMatchObject({
      journalBaselineCheckpointId: null,
      committedJournalRecords: 0,
      journalRevision: 0,
    });
    expect((await reopened.queryActions()).records).toEqual([]);
    await reopened.close();

    const backups = readdirSync(tempDirOf(dbPath)).filter((name) => name.includes('.pre-v4-'));
    expect(backups).toHaveLength(1);
  });

  it('rolls back a failed v4 migration, leaving a still-v3 database and a backup', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    await save.checkpoint();
    await save.close();

    const db = new Database(dbPath);
    downgradeToV3(db);
    // A view with the target table name is invisible to the table-only schema
    // validation but makes CREATE TABLE fail inside the migration transaction.
    db.exec('CREATE VIEW action_records AS SELECT 1 AS x');
    db.close();

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });

    expect(schemaVersion(dbPath)).toBe('3');
    expect(checkpointColumns(dbPath)).not.toContain('journal_revision');
    const check = new Database(dbPath, { readonly: true });
    const journalTable = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spatial_events'")
      .get();
    expect(journalTable).toBeUndefined();
    check.close();
    const backups = readdirSync(tempDirOf(dbPath)).filter((name) => name.includes('.pre-v4-'));
    expect(backups).toHaveLength(1);
  });
});

// ==============================================================================
// Pure queue boundary checks
// ==============================================================================

describe('journal limits and input isolation', () => {
  it('uses PersistenceError for invalid acceptance and keeps pending state unchanged', async () => {
    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      journalLimits: { maxRecordBytes: 4096, maxPendingBytes: 8192, maxBatchBytes: 4096 },
    });
    session.journal.recordAction(action({ id: 'small', delegation: { ...action().delegation, requestedTarget: 'x' } }));
    expectKind(
      () =>
        session.journal.recordAction(
          action({ id: 'too-big', delegation: { ...action().delegation, requestedTarget: 'x'.repeat(4096) } }),
        ),
      'capacity',
    );
    expect(session.journal.readPending().actions.map((a) => a.id)).toEqual(['small']);

    expect(() => session.journal.recordEvent({ ...gapEvent('bad-world'), worldId: 'other' })).toThrow(
      PersistenceError,
    );
    expect(session.journal.readPending().events).toEqual([]);
    await session.close();
  });
});
