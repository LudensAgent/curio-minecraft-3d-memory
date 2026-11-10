/**
 * Independent consumer acceptance for the packed `curio-minecraft-3d-memory`
 * package. Run from a throwaway directory that installs the real `.tgz` (never a
 * source path, `../dist`, `npm link`, or a dev-machine alias) so every import
 * below resolves through the installed package's public `exports`.
 *
 * This file is copied into the consumer directory by `run.mjs`; it imports only
 * by package name and public subpath:
 *
 *   curio-minecraft-3d-memory                 (root entry)
 *   curio-minecraft-3d-memory/memory          (pure memory core)
 *   curio-minecraft-3d-memory/storage/sqlite  (SQLite persistence entry)
 *
 * Every check is a hard `node:assert` — a failure throws and exits non-zero, so
 * "success" is never a printed summary. It exercises the combined lifecycle that
 * the existing unit tests do not cover in isolation: install → worker startup →
 * bounded 3D land search → facts query + revocation → save/restore → restored
 * STALE evidence is not a current route → fresh re-observation isolation → pin
 * protection independent of dirty → final persistence with a unique fact.
 *
 * CLI mutation modes (each is a separate process run against a fresh temp dir;
 * a mutation makes a specific *positive* assertion fail so the orchestrator sees
 * a non-zero exit — it is never treated as success by this consumer itself):
 *
 *   --early-release-pin      release the pin lease before free(), so the
 *                            "dependency is pinned" assertions fail.
 *   --skip-final-checkpoint  skip the final checkpoint, so the reopened unique
 *                            fact is absent and the final-fact assertions fail.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTRACT_VERSION,
  InMemoryFactStore,
  VoxelMap,
  createVoxelFactsQueryPort,
  searchLandRoute,
  searchLandRouteAsync,
} from 'curio-minecraft-3d-memory';
import * as memoryCore from 'curio-minecraft-3d-memory/memory';
import {
  openSpatialSession,
  PersistenceError,
  WorkingSetManager,
} from 'curio-minecraft-3d-memory/storage/sqlite';

const MUTATIONS = {
  earlyReleasePin: process.argv.includes('--early-release-pin'),
  skipFinalCheckpoint: process.argv.includes('--skip-final-checkpoint'),
  closeFaultIncomplete: process.argv.includes('--close-fault-incomplete'),
  closeFaultThrow: process.argv.includes('--close-fault-throw'),
  cleanupFault: process.argv.includes('--cleanup-fault'),
};

const WORLD = 'world';
const DIM = 'overworld';
const STONE = { name: 'minecraft:stone', properties: {} };
const AIR = { name: 'minecraft:air', properties: {} };
// A unique final fact: a never-before-observed cell with a nonempty-property state.
const UNIQUE_STATE = { name: 'minecraft:oak_log', properties: { axis: 'y' } };

// A deliberately tiny shape provider: air is empty, everything else is a full
// cube with a walkable top face. This matches the Fake fixtures already used by
// the library's own walk-route tests.
const shapeProvider = {
  version: 'consumer-1',
  resolve(state) {
    if (state.name === 'minecraft:air') {
      return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    }
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
  },
};

function keyAt(cx, sy) {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

function sameKey(a, b) {
  return a.worldId === b.worldId && a.dim === b.dim && a.cx === b.cx && a.cz === b.cz && a.sy === b.sy;
}

function fmtKey(key) {
  return `(${key.dim}, ${key.cx}, ${key.cz}, ${key.sy})`;
}

/** Emit one small structured fact record (actual values only, never fabricated). */
function evidence(tag, facts) {
  console.log(JSON.stringify({ ev: tag, ...facts }));
}

/** Compact structured form of a free() result for evidence (facts, not prose). */
function freeFacts(free) {
  return {
    evicted: free.evicted.map(fmtKey),
    rejected: free.evictionRejected.map((r) => ({ key: fmtKey(r.key), reason: r.reason })),
    capacity: free.capacity ? free.capacity.kind : null,
  };
}

/** Observe support (y=-1) + air (y=0,1) along x = 0..3 for a flat walkable line. */
function observeRoute(session, sessionId, observedAt) {
  session.voxel.beginSession(sessionId);
  let sequence = 0;
  for (let x = 0; x <= 3; x++) {
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: STONE,
      pos: { x, y: -1, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: AIR,
      pos: { x, y: 0, z: 0 },
    });
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: AIR,
      pos: { x, y: 1, z: 0 },
    });
  }
}

const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' };

function searchRequest(sessionId = 'live') {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId,
    body: BODY,
    to: { x: 2.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    rules: { shapeProvider },
    allowed: ['walk', 'step', 'drop'],
    maxNodes: 256,
    maxEdges: 1024,
  };
}

function factPlace(id, overrides = {}) {
  return {
    id,
    kind: 'place',
    label: `place ${id}`,
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
    observedAt: 100,
    source: { source: 'agent' },
    gone: false,
    ...overrides,
  };
}

function factResource(id, overrides = {}) {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    label: 'bench:stone',
    sourceCell: { x: 5, y: 60, z: 0 },
    sourceCellVersion: 3,
    observedAt: 200,
    source: { source: 'vision' },
    revoked: false,
    ...overrides,
  };
}

// ===== Journal fixtures =====
// Explicitly Fake library-only fixtures. They exercise the public journal API;
// they are not evidence that a game action happened or that a host now emits
// journal records. The original NavResult keeps outcome, partial effects and its
// `memoryWrite` marker verbatim.
const JOURNAL_SESSION = 'journal-session';
const JOURNAL_EARLIER_SESSION = 'journal-earlier-session';

function journalObservation(overrides = {}) {
  return {
    pos: { x: -1, y: 0, z: 2 },
    state: { name: 'minecraft:dirt', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    observedAt: 2000,
    source: 'vision',
    sessionId: JOURNAL_SESSION,
    sequence: 7,
    worldId: WORLD,
    dim: DIM,
    ...overrides,
  };
}

/** A full ActionRecord carrying its original cancelled NavResult and partial effects. */
function journalActionRecord() {
  return {
    id: 'journal-action-1',
    ts: 2000,
    worldId: WORLD,
    dim: DIM,
    sessionId: JOURNAL_SESSION,
    delegationId: 'journal-delegation-1',
    delegation: {
      requestedTarget: 'the journal fixture target',
      target: { x: 1, y: 0, z: 2 },
      allowedModes: ['walk'],
      arrival: { kind: 'near', radius: 1 },
      allowDigging: false,
      allowPlacing: true,
      allowTower: false,
      materials: [{ name: 'minecraft:dirt', maxCount: 2 }],
      exploration: 'known_only',
    },
    subActions: [
      {
        kind: 'place',
        at: { x: 1, y: 0, z: 2 },
        block: 'minecraft:dirt',
        origin: 'execution_helper',
        targetRole: 'support',
        outcome: 'cancelled',
        effects: [],
      },
    ],
    from: { x: 0.5, y: 0, z: 0.5 },
    to: { x: 1.5, y: 0, z: 0.5 },
    trace: [
      { pos: { x: 0.5, y: 0, z: 0.5 }, ts: 2000 },
      { pos: { x: 1.5, y: 0, z: 0.5 }, ts: 2100 },
    ],
    consumption: { placed: [{ pos: { x: 1, y: 0, z: 2 }, name: 'minecraft:dirt' }], durabilityLost: 2, digMs: 8 },
    observedChanges: [journalObservation({ observedAt: 2100, sequence: 8 })],
    failureAt: { x: 1.5, y: 0, z: 0.5 },
    failureReason: 'fake fixture cancellation',
    confirmed: false,
    result: {
      outcome: 'CANCELLED',
      message: 'fake library-only cancelled result with a partial effect',
      trace: [
        { pos: { x: 0.5, y: 0, z: 0.5 }, ts: 2000 },
        { pos: { x: 1.5, y: 0, z: 0.5 }, ts: 2100 },
      ],
      consumption: { placed: [{ pos: { x: 1, y: 0, z: 2 }, name: 'minecraft:dirt' }], durabilityLost: 2, digMs: 8 },
      memoryWrite: 'pending',
      lastPosition: { x: 1.5, y: 0, z: 0.5 },
      lastObservation: {
        worldId: WORLD,
        dim: DIM,
        sessionId: JOURNAL_SESSION,
        observedAt: 2100,
        onGround: true,
        inWater: false,
      },
      confirmed: false,
      problem: { kind: 'cancelled', by: 'agent', reason: 'fake fixture; no host action was performed' },
    },
  };
}

/** A legal observed change; only `current` must share the event session/time. */
function journalChangeEvent(currentOverrides = {}) {
  return {
    kind: 'observed_cell_change',
    id: 'journal-event-change-1',
    observedAt: 2000,
    worldId: WORLD,
    dim: DIM,
    sessionId: JOURNAL_SESSION,
    pos: { x: -1, y: 0, z: 2 },
    previous: journalObservation({
      sessionId: JOURNAL_EARLIER_SESSION,
      observedAt: 500,
      sequence: 3,
      state: { name: 'minecraft:stone', properties: {} },
    }),
    current: journalObservation(currentOverrides),
  };
}

function journalGapEvent() {
  return {
    kind: 'observation_gap',
    id: 'journal-event-gap-1',
    observedAt: 2500,
    worldId: WORLD,
    dim: DIM,
    sessionId: JOURNAL_SESSION,
    reason: 'paused',
  };
}

/** Assert a synchronous public persistence error with an exact kind. */
function assertPersistenceKind(fn, kind, message) {
  assert.throws(fn, (err) => err instanceof PersistenceError && err.kind === kind, message);
}

/** True when `child` is a strict descendant of `parent` (both absolute paths). */
function isDescendant(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Owning close: record each session's ACTUAL close outcome exactly once — the
 * returned `CloseResult`, or the original thrown error (never both, never a
 * fabricated result). A re-entrant close of an already-recorded session reuses the
 * recorded outcome and never re-invokes `close()`. Exported so the close-fault
 * test can exercise the real shared path.
 */
export async function closeSession(closeRecords, session) {
  if (closeRecords.has(session)) {
    const rec = closeRecords.get(session);
    if (rec.error) throw rec.error;
    return rec.result;
  }
  let result;
  try {
    result = await session.close();
  } catch (err) {
    closeRecords.set(session, { result: null, error: err });
    throw err;
  }
  closeRecords.set(session, { result, error: null });
  return result;
}

/**
 * Final resource verdict: close every session not yet recorded through the owner,
 * classify each recorded outcome as clean or unclean, run cleanup only when every
 * close is clean, print the primary + secondary diagnostics, and return the process
 * exit code. `dirty` is intentionally NOT a shutdown failure (a cleanly-closed
 * session may legitimately still be dirty after an uncheckpointed phase); only a
 * thrown close, a `completed !== true` result, an `unconfirmedRequest`, or a
 * returned `error` marks a close unclean. `cleanup(dir)` is injectable so fault
 * stubs can fail without touching the disk.
 */
export async function finalizeResources({ sessions, closeRecords, primaryError, dir, cleanup }) {
  for (const session of sessions) {
    if (closeRecords.has(session)) continue;
    try {
      await closeSession(closeRecords, session);
    } catch {
      // Recorded by closeSession; keep closing the remaining sessions.
    }
  }

  const unclean = [];
  for (const session of sessions) {
    const rec = closeRecords.get(session);
    if (!rec) {
      unclean.push({ detail: 'session was never closed through the owning closure' });
      continue;
    }
    if (rec.error) {
      unclean.push({ detail: 'close() threw', error: rec.error });
      continue;
    }
    const r = rec.result;
    if (r.completed !== true) {
      unclean.push({ detail: `close() returned completed=${String(r.completed)}`, error: r.error ?? null });
    } else if (r.unconfirmedRequest === true) {
      unclean.push({ detail: 'close() returned unconfirmedRequest=true', error: r.error ?? null });
    } else if (r.error) {
      unclean.push({ detail: 'close() returned a persistence error', error: r.error });
    }
  }

  let cleanupError = null;
  if (unclean.length === 0) {
    try {
      cleanup(dir);
    } catch (err) {
      cleanupError = err;
    }
  }

  if (primaryError) {
    console.error('consumer acceptance: FAIL (primary)');
    console.error(primaryError);
  }
  if (unclean.length > 0) {
    console.error(`consumer acceptance: unclean/unknown close; preserving directory ${dir}`);
    for (const u of unclean) {
      console.error(`  ${u.detail}`);
      if (u.error) console.error(u.error);
    }
  }
  if (cleanupError) {
    console.error(`consumer acceptance: cleanup failure; preserving directory ${dir}`);
    console.error(cleanupError);
  }

  const exitCode = primaryError || unclean.length > 0 || cleanupError ? 1 : 0;

  evidence('final.resource', {
    primaryError: primaryError ? { name: primaryError.name, message: primaryError.message } : null,
    closes: sessions.map((session) => {
      const rec = closeRecords.get(session);
      if (!rec) return { closeAttempted: false, reason: 'no-record' };
      if (rec.error) return { closeAttempted: true, threw: true, error: rec.error.message };
      const r = rec.result;
      return {
        closeAttempted: true,
        completed: r.completed,
        dirty: r.dirty,
        unconfirmedRequest: r.unconfirmedRequest,
        error: r.error ? { kind: r.error.kind, message: r.error.message } : null,
      };
    }),
    cleanupError: cleanupError ? { name: cleanupError.name, message: cleanupError.message } : null,
    exitCode,
  });

  if (exitCode === 0) {
    console.log('consumer acceptance: PASS (all assertions held)');
  }
  return exitCode;
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-acceptance-'));
  const databasePath = join(dir, 'spatial.db');
  const closeRecords = new Map();
  const opened = [];

  const open = async (options = {}) => {
    const s = await openSpatialSession({ databasePath, worldId: WORLD, ...options });
    opened.push(s);
    return s;
  };

  // The owning close closure: every real close in the scenarios goes through here.
  const close = (s) => closeSession(closeRecords, s);

  let primaryError = null;
  try {
    // ===== 1. Entry points =====
    assert.equal(typeof searchLandRoute, 'function', 'root entry exports searchLandRoute');
    assert.equal(typeof searchLandRouteAsync, 'function', 'root entry exports searchLandRouteAsync');
    assert.equal(typeof VoxelMap, 'function', 'root entry exports VoxelMap');
    assert.equal(typeof createVoxelFactsQueryPort, 'function', 'root entry exports createVoxelFactsQueryPort');
    assert.equal(typeof InMemoryFactStore, 'function', 'root entry exports InMemoryFactStore');
    assert.equal(CONTRACT_VERSION, 'memory-host-contract/2', 'root entry publishes contract version 2');
    assert.equal(typeof openSpatialSession, 'function', 'storage/sqlite exports openSpatialSession');
    assert.equal(typeof WorkingSetManager, 'function', 'storage/sqlite exports WorkingSetManager');
    for (const retired of ['FragmentStore', 'TopologyStore', 'WalkRouteExecutor', 'WalkRouteSearch', 'RouteVerifier', 'planRoute', 'navigateTo']) {
      assert.equal(retired in memoryCore, false, `memory entry must not export retired ${retired}`);
    }
    assert.equal(typeof memoryCore.VoxelMap, 'function', 'memory entry exports VoxelMap');
    assert.equal('searchLandRoute' in memoryCore, false, 'memory entry has no navigation runtime');

    // ===== 1b. Observation + bounded 3D search + facts query =====
    {
      const map = new VoxelMap(WORLD);
      observeRoute({ voxel: map }, 'live', 2000);
      const mapBefore = {
        revision: map.saveRevision,
        support: map.cellAt(DIM, 1, -1, 0),
        feet: map.cellAt(DIM, 1, 0, 0),
      };

      const searchResult = searchLandRoute(map, searchRequest(), 2000);
      assert.equal(searchResult.status, 'FOUND', 'bounded search finds the observed corridor');
      assert.equal(searchResult.assurance, 'geometry_only', 'current search assurance is geometry_only');
      assert.equal(searchResult.evidenceMode, 'current', 'current search uses current evidence');
      assert.equal(searchResult.executable, false, 'a search candidate is never executable authorization');
      assert.equal(searchResult.needsRevalidation, true, 'a candidate always needs current revalidation');
      assert.ok(searchResult.points.length > 1, 'FOUND carries ordered points');
      assert.deepEqual(searchResult.points.at(-1), { x: 2.5, y: 0, z: 0.5 }, 'candidate ends at the exact target');
      assert.ok(searchResult.transitions.length > 0, 'FOUND carries evaluated transitions');
      assert.equal('outcome' in searchResult, false, 'search result has no navigation arrival outcome');

      assert.equal(map.saveRevision, mapBefore.revision, 'read-only search did not advance saveRevision');
      assert.deepEqual(map.cellAt(DIM, 1, -1, 0), mapBefore.support, 'read-only search left support evidence unchanged');
      assert.deepEqual(map.cellAt(DIM, 1, 0, 0), mapBefore.feet, 'read-only search left feet evidence unchanged');

      const empty = searchLandRoute(new VoxelMap(WORLD), searchRequest(), 2000);
      assert.notEqual(empty.status, 'FOUND', 'an empty map is not a found route');
      assert.equal(empty.executable, false, 'an empty search is not executable authorization');
      assert.deepEqual(empty.points, [], 'an empty map yields no candidate points');

      const facts = new InMemoryFactStore();
      facts.upsertPlace(factPlace('base', { kind: 'base', label: 'home' }));
      facts.upsertResource(factResource('ore'));
      const port = createVoxelFactsQueryPort({ worldId: WORLD, voxel: map, facts });

      const places = port.query({ kind: 'places', dim: DIM });
      assert.equal(places.status, 'ok', 'facts places query succeeds');
      assert.deepEqual(places.data.items.map((item) => item.id), ['base'], 'places projection is facts-backed');
      assert.equal(places.data.pageSource, 'memory', 'places page source states the in-memory authority');
      const resources = port.query({ kind: 'resourceAnchors', dim: DIM });
      assert.deepEqual(resources.data.items.map((item) => item.id), ['ore'], 'resource anchors query succeeds');
      facts.revokeResource('ore', { observedAt: 300, source: { source: 'vision' } });
      assert.equal(port.query({ kind: 'resourceAnchors', dim: DIM }).total, 0, 'revocation is visible before persistence');
      assert.equal(port.query({ kind: 'resourceAnchors', dim: DIM, includeGone: true }).total, 1, 'revoked fact remains queryable');

      const capabilities = port.query({ kind: 'capabilities' });
      assert.equal(capabilities.data.capabilities.contract, CONTRACT_VERSION, 'query capability report uses contract v2');
      assert.equal('plan' in capabilities.data.capabilities, false, 'capability report has no plan block');
      assert.equal('execute' in capabilities.data.capabilities, false, 'capability report has no execute block');
      assert.equal(capabilities.data.capabilities.query.containerContents, false, 'container contents stay host-led');

      evidence('v011.followups', {
        search: {
          status: searchResult.status,
          executable: searchResult.executable,
          points: searchResult.points.length,
          transitions: searchResult.transitions.length,
        },
        emptySearch: { status: empty.status, points: empty.points.length },
        places: places.data.items.length,
        resources: resources.data.items.length,
        contract: capabilities.data.capabilities.contract,
      });
    }

    // ===== 1c. Journal: Fake library-only fixtures through the public API =====
    {
      // A separate DB inside the same mkdtemp directory. Every session below is
      // opened and closed sequentially through the existing `open`/`close`
      // owners, so no two workers ever write one database file at the same time.
      const journalDbPath = join(dir, 'journal.db');

      const actionFixture = journalActionRecord();
      const changeFixture = journalChangeEvent();
      const gapFixture = journalGapEvent();
      const expectedAction = structuredClone(actionFixture);
      const expectedChange = structuredClone(changeFixture);
      const expectedGap = structuredClone(gapFixture);

      const s = await open({
        databasePath: journalDbPath,
        journalLimits: { maxBatchRecords: 1, maxPageRecords: 1 },
      });

      // Acceptance is synchronous and local: it is pending+dirty, never saved.
      const acceptedAction = s.journal.recordAction(actionFixture);
      const acceptedChange = s.journal.recordEvent(changeFixture);
      const acceptedGap = s.journal.recordEvent(gapFixture);
      assert.equal(acceptedAction.accepted, true, 'journal action accepted');
      assert.equal(acceptedAction.duplicate, false, 'journal action is not a duplicate');
      assert.equal(acceptedAction.pendingRecords, 1, 'accepted action is pending, not saved');
      assert.equal(acceptedChange.accepted, true, 'journal change event accepted');
      assert.equal(acceptedGap.accepted, true, 'journal gap event accepted');
      assert.equal(acceptedGap.pendingRecords, 3, 'all three known records are pending');

      let state = s.getPersistenceState();
      const currentRevision = state.journalRevision;
      evidence('journal.accept', {
        fixture: 'fake-library-only',
        hostEnabled: false,
        accepted: [acceptedAction.accepted, acceptedChange.accepted, acceptedGap.accepted],
        revision: currentRevision,
        confirmedRevision: state.confirmedJournalRevision,
        pendingRecords: state.pendingJournalRecords,
        pendingBytes: state.pendingJournalBytes,
        committedRecords: state.committedJournalRecords,
        dirty: state.dirty,
      });
      assert.equal(state.pendingJournalRecords, 3, 'acceptance only fills the pending queue');
      assert.equal(state.confirmedJournalRevision, 0, 'acceptance confirms no save');
      assert.equal(state.committedJournalRecords, 0, 'acceptance commits no rows');
      assert.equal(state.dirty, true, 'pending journal records make the session dirty');

      // Public negatives: a mismatched current session, a mismatched current
      // observation time, and a batch whose valid first event is followed by a
      // bad one. Every rejection is atomic and leaves the queue byte-for-byte and
      // revision-for-revision unchanged.
      const pendingBeforeReject = s.journal.readPending();
      const stateBeforeReject = s.getPersistenceState();
      assertPersistenceKind(
        () => s.journal.recordEvent(journalChangeEvent({ sessionId: 'stale-journal-session' })),
        'invalid_argument',
        'current observation from another session is rejected',
      );
      assertPersistenceKind(
        () => s.journal.recordEvent(journalChangeEvent({ observedAt: 1999 })),
        'invalid_argument',
        'current observation with a different time is rejected',
      );
      assertPersistenceKind(
        () =>
          s.journal.recordBatch({
            events: [
              {
                kind: 'observation_gap',
                id: 'journal-event-rejected-normal',
                observedAt: 2600,
                worldId: WORLD,
                dim: DIM,
                sessionId: JOURNAL_SESSION,
                reason: 'paused',
              },
              journalChangeEvent({ sessionId: 'stale-journal-session' }),
            ],
          }),
        'invalid_argument',
        'a valid leading event then a mismatched current rejects the whole batch',
      );
      const pendingAfterReject = s.journal.readPending();
      const stateAfterReject = s.getPersistenceState();
      assert.deepEqual(pendingAfterReject, pendingBeforeReject, 'rejections preserve pending actions, events, bytes and revision');
      assert.equal(stateAfterReject.journalRevision, stateBeforeReject.journalRevision, 'rejections do not advance the journal revision');
      assert.equal(stateAfterReject.pendingJournalBytes, stateBeforeReject.pendingJournalBytes, 'rejections preserve pending bytes');
      assert.equal(stateAfterReject.dirty, true, 'rejections do not clean the session');
      assert.deepEqual(pendingAfterReject.actions, [expectedAction], 'the original action is not rewritten');
      assert.deepEqual(pendingAfterReject.events, [expectedChange, expectedGap], 'the original events are not rewritten');
      evidence('journal.reject', {
        kinds: ['invalid_argument', 'invalid_argument', 'invalid_argument'],
        revision: stateAfterReject.journalRevision,
        pendingRecords: stateAfterReject.pendingJournalRecords,
        pendingBytes: stateAfterReject.pendingJournalBytes,
        dirty: stateAfterReject.dirty,
      });

      // maxBatchRecords=1 forces three separate prefix confirmations.
      const first = await s.checkpoint();
      state = s.getPersistenceState();
      evidence('journal.checkpoint', {
        step: 1,
        capturedRevision: first.journalRevision,
        confirmedRevision: state.confirmedJournalRevision,
        currentRevision: state.journalRevision,
        pendingRecords: state.pendingJournalRecords,
        pendingBytes: state.pendingJournalBytes,
        committedRecords: state.committedJournalRecords,
        dirty: state.dirty,
      });
      assert.equal(first.journalRevision, acceptedAction.revision, 'first checkpoint captures only the action revision');
      assert.ok(first.journalRevision < currentRevision, 'a truncated checkpoint never claims the whole queue');
      assert.equal(state.confirmedJournalRevision, first.journalRevision, 'first ACK confirms exactly its captured prefix');
      assert.equal(state.journalRevision, currentRevision, 'later records keep their current revision');
      assert.equal(state.pendingJournalRecords, 2, 'the two later events remain pending');
      assert.equal(state.committedJournalRecords, 1, 'only the captured prefix is committed');
      assert.equal(state.dirty, true, 'a later pending record keeps the session dirty');

      const savedActionPage = await s.queryActions();
      assert.equal(savedActionPage.records.length, 1, 'the first checkpoint committed one action');
      assert.equal(savedActionPage.records[0].result.memoryWrite, 'pending', 'save does not rewrite the original memoryWrite marker');

      const second = await s.checkpoint();
      state = s.getPersistenceState();
      evidence('journal.checkpoint', {
        step: 2,
        capturedRevision: second.journalRevision,
        confirmedRevision: state.confirmedJournalRevision,
        currentRevision: state.journalRevision,
        pendingRecords: state.pendingJournalRecords,
        pendingBytes: state.pendingJournalBytes,
        committedRecords: state.committedJournalRecords,
        dirty: state.dirty,
      });
      assert.equal(second.journalRevision, acceptedChange.revision, 'second checkpoint captures the change event revision');
      assert.equal(state.confirmedJournalRevision, second.journalRevision, 'second ACK confirms exactly its captured prefix');
      assert.equal(state.journalRevision, currentRevision, 'the final record still owns the current revision');
      assert.equal(state.pendingJournalRecords, 1, 'the gap event remains pending');
      assert.equal(state.dirty, true, 'still dirty with one pending record');

      const third = await s.checkpoint();
      state = s.getPersistenceState();
      evidence('journal.saved', {
        step: 3,
        capturedRevision: third.journalRevision,
        confirmedRevision: state.confirmedJournalRevision,
        currentRevision: state.journalRevision,
        pendingRecords: state.pendingJournalRecords,
        pendingBytes: state.pendingJournalBytes,
        committedRecords: state.committedJournalRecords,
        dirty: state.dirty,
        memoryWrite: savedActionPage.records[0].result.memoryWrite,
      });
      assert.equal(third.journalRevision, acceptedGap.revision, 'third checkpoint captures the final revision');
      assert.equal(third.journalRevision, currentRevision, 'the final checkpoint covers the queue at capture time');
      assert.equal(state.confirmedJournalRevision, currentRevision, 'all known records are confirmed');
      assert.equal(state.pendingJournalRecords, 0, 'no records remain pending');
      assert.equal(state.pendingJournalBytes, 0, 'no pending bytes remain');
      assert.equal(state.dirty, false, 'the finite known journal queue is fully saved');
      assert.equal(state.committedJournalRecords, 3, 'all three records are committed');
      assert.deepEqual(s.journal.readPending(), { revision: currentRevision, actions: [], events: [], bytes: 0 }, 'pending queue is empty');
      assert.deepEqual(actionFixture, expectedAction, 'the accepted action fixture was never rewritten');
      assert.deepEqual(changeFixture, expectedChange, 'the accepted change fixture was never rewritten');
      assert.deepEqual(gapFixture, expectedGap, 'the accepted gap fixture was never rewritten');
      assert.equal(expectedAction.result.memoryWrite, 'pending', 'the original result keeps its memoryWrite marker');

      const closed = await close(s);
      assert.equal(closed.completed, true, 'journal session closes cleanly');
      assert.equal(closed.dirty, false, 'nothing is dirty at journal close');
      assert.equal(closed.unconfirmedRequest, false, 'no unconfirmed journal request at close');
      assert.equal(closed.error, null, 'no journal close error');

      // Reopen and read the committed journal back through bounded pages.
      const s2 = await open({ databasePath: journalDbPath });
      const stateBeforeRead = s2.getPersistenceState();
      assert.equal(stateBeforeRead.pendingJournalRecords, 0, 'reopen has no pending journal records');
      assert.equal(stateBeforeRead.committedJournalRecords, 3, 'reopen restores the committed journal count');
      assert.equal(stateBeforeRead.journalRevision, currentRevision, 'reopen restores the committed journal revision');
      assert.equal(stateBeforeRead.confirmedJournalRevision, currentRevision, 'reopen baseline is confirmed');
      assert.equal(stateBeforeRead.journalBaselineCheckpointId, third.checkpointId, 'journal baseline names the final checkpoint');
      assert.equal(stateBeforeRead.dirty, false, 'reopen starts clean');

      const actionPage = await s2.queryActions();
      assert.equal(actionPage.records.length, 1, 'one committed action is read back');
      assert.equal(actionPage.hasMore, false, 'the single action page has no more records');
      assert.equal(actionPage.nextCursor, null, 'the single action page has no cursor');
      assert.deepEqual(actionPage.records[0], expectedAction, 'action scope, time, trace, partial effects and NavResult round-trip');

      const eventPage1 = await s2.queryEvents({ maxRecords: 1 });
      assert.equal(eventPage1.records.length, 1, 'first event page respects maxRecords=1');
      assert.equal(eventPage1.hasMore, true, 'first event page reports more records');
      assert.notEqual(eventPage1.nextCursor, null, 'first event page carries a cursor');
      const eventPage2 = await s2.queryEvents({ maxRecords: 1, cursor: eventPage1.nextCursor });
      assert.equal(eventPage2.records.length, 1, 'second event page respects maxRecords=1');
      assert.equal(eventPage2.hasMore, false, 'second event page is the last');
      assert.equal(eventPage2.nextCursor, null, 'last event page has no cursor');
      const events = [...eventPage1.records, ...eventPage2.records];
      assert.deepEqual(events, [expectedChange, expectedGap], 'events round-trip in insertion order');
      const [change, gap] = events;
      assert.equal(change.kind, 'observed_cell_change', 'observed change kind preserved');
      assert.equal(change.current.sessionId, JOURNAL_SESSION, 'current observation session preserved');
      assert.equal(change.current.observedAt, 2000, 'current observation time preserved');
      assert.equal(change.current.source, 'vision', 'current observation source preserved');
      assert.equal(change.previous.sessionId, JOURNAL_EARLIER_SESSION, 'previous observation keeps its older session');
      assert.equal(change.previous.observedAt, 500, 'previous observation keeps its older real time');
      assert.equal(gap.kind, 'observation_gap', 'gap event kind preserved');
      assert.equal(gap.reason, 'paused', 'gap reason preserved');

      // Reads do not refresh times, dirty the session, move revisions or add facts.
      const stateAfterRead = s2.getPersistenceState();
      assert.deepEqual(
        {
          journalRevision: stateAfterRead.journalRevision,
          confirmedJournalRevision: stateAfterRead.confirmedJournalRevision,
          pendingJournalRecords: stateAfterRead.pendingJournalRecords,
          pendingJournalBytes: stateAfterRead.pendingJournalBytes,
          committedJournalRecords: stateAfterRead.committedJournalRecords,
          committedJournalBytes: stateAfterRead.committedJournalBytes,
          dirty: stateAfterRead.dirty,
        },
        {
          journalRevision: stateBeforeRead.journalRevision,
          confirmedJournalRevision: stateBeforeRead.confirmedJournalRevision,
          pendingJournalRecords: stateBeforeRead.pendingJournalRecords,
          pendingJournalBytes: stateBeforeRead.pendingJournalBytes,
          committedJournalRecords: stateBeforeRead.committedJournalRecords,
          committedJournalBytes: stateBeforeRead.committedJournalBytes,
          dirty: stateBeforeRead.dirty,
        },
        'journal queries change no revision, pending count or dirty flag',
      );
      assert.deepEqual(s2.voxel.cellAt(DIM, -1, 0, 2), { observed: false }, 'journal reads add no voxel fact');

      evidence('journal.reopen', {
        fixture: 'fake-library-only',
        hostEnabled: false,
        journalRevision: stateBeforeRead.journalRevision,
        confirmedRevision: stateBeforeRead.confirmedJournalRevision,
        pendingRecords: stateBeforeRead.pendingJournalRecords,
        pendingBytes: stateBeforeRead.pendingJournalBytes,
        committedRecords: stateBeforeRead.committedJournalRecords,
        dirty: stateBeforeRead.dirty,
        actionPage: {
          records: actionPage.records.length,
          hasMore: actionPage.hasMore,
          nextCursor: actionPage.nextCursor,
        },
        eventPages: [
          { records: eventPage1.records.length, hasMore: eventPage1.hasMore, nextCursor: eventPage1.nextCursor },
          { records: eventPage2.records.length, hasMore: eventPage2.hasMore, nextCursor: eventPage2.nextCursor },
        ],
        current: { sessionId: change.current.sessionId, observedAt: change.current.observedAt, source: change.current.source },
        previous: { sessionId: change.previous.sessionId, observedAt: change.previous.observedAt, source: change.previous.source },
        memoryWrite: actionPage.records[0].result.memoryWrite,
        voxelCellObserved: s2.voxel.cellAt(DIM, -1, 0, 2).observed,
      });

      const closed2 = await close(s2);
      assert.equal(closed2.completed, true, 'reopened journal session closes cleanly');
      assert.equal(closed2.dirty, false, 'reopened journal session stays clean');
    }

    // ===== 2. Save & restore (baseline at observedAt=1000) =====
    {
      const s = await open();
      assert.equal(s.lifecycle, 'open', 'worker starts and session is open');
      observeRoute(s, 'setup', 1000);
      assert.equal(s.getPersistenceState().dirty, true, 'dirty before first checkpoint');

      const cp = await s.checkpoint();
      assert.ok(cp.checkpointId, 'checkpoint returns a confirmation id');
      assert.equal(s.getPersistenceState().dirty, false, 'clean after checkpoint');

      const closed = await close(s);
      assert.equal(closed.completed, true, 'close completes cleanly');
      assert.equal(closed.dirty, false, 'nothing dirty at close');
    }

    // ===== 3. Restore: original facts, STALE, passability boundary =====
    {
      const s = await open();
      const stone = s.voxel.cellAt(DIM, 0, -1, 0);
      assert.equal(stone.observed, true, 'restored stone cell observed');
      assert.equal(stone.evidence.freshness, 'STALE', 'restored evidence is STALE');
      assert.equal(stone.evidence.observation.state.name, 'minecraft:stone', 'restored state preserved');
      assert.equal(stone.evidence.observation.observedAt, 1000, 'original observedAt preserved');

      // Restored STALE evidence must never be read as a current route proof.
      const restoredSearch = searchLandRoute(s.voxel, searchRequest('live'), 2000);
      assert.notEqual(restoredSearch.status, 'FOUND', 'restored STALE evidence is not a current route');
      assert.equal(restoredSearch.executable, false, 'restored evidence grants no execution authorization');

      // A new observation session re-observes exactly one cell; only that cell
      // becomes FRESH — an untouched neighbour must not ride along.
      s.voxel.beginSession('live');
      s.voxel.observe({
        worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1,
        source: 'vision', evidence: 'seen', stateComplete: true, state: STONE,
        pos: { x: 0, y: -1, z: 0 },
      });
      assert.equal(s.voxel.cellAt(DIM, 0, -1, 0).evidence.freshness, 'FRESH', 're-observed cell is FRESH');
      assert.equal(s.voxel.cellAt(DIM, 1, -1, 0).evidence.freshness, 'STALE', 'neighbour stays STALE');

      await close(s);
    }

    // ===== 4. Pin protection independent of dirty (manual residency) =====
    {
      const s = await open({
        voxelLoading: 'manual',
        residencyLimits: { maxResidentSections: 6 },
      });
      const manager = new WorkingSetManager(s);
      const deps = [keyAt(0, -1), keyAt(0, 0)];

      // (Re)establish clean, committed route Sections at `t`. A newer `t` makes the
      // re-observation genuinely FRESH after a previous case reclaimed the Sections.
      async function establishFreshCleanDeps(t) {
        const load = await manager.prepare(deps);
        assert.equal(load.status, 'ready', 'route sections load');
        s.releasePins([load.lease.token]);

        observeRoute(s, 'live', t);
        const cp = await s.checkpoint();
        const ps = s.getPersistenceState();
        evidence('l3.checkpoint', {
          t,
          checkpointId: cp.checkpointId,
          voxelRevision: cp.voxelRevision,
          confirmedVoxelRevision: ps.confirmedVoxelRevision,
          dirty: ps.dirty,
        });
        assert.ok(cp.checkpointId, 'route facts checkpointed');
        assert.equal(ps.dirty, false, 'clean after route checkpoint');

        for (const key of deps) {
          const residency = s.sectionResidency(key);
          assert.equal(residency.residency, 'resident', `dependency ${fmtKey(key)} resident`);
          assert.ok(residency.committed !== undefined, `dependency ${fmtKey(key)} committed`);
        }
      }

      // One pin case: protect the caller-selected Sections, free while pinned,
      // then release and prove reclamation. `earlyRelease` is the negative mode.
      async function pinCase(earlyRelease) {
        const lease = await manager.prepare(deps);
        assert.equal(lease.status, 'ready', 'route dependencies prepared');
        assert.ok(lease.lease.token, 'prepare hands out a valid lease token');

        if (earlyRelease) s.releasePins([lease.lease.token]);

        const freeActive = manager.free();
        evidence('l3.freeActive', freeFacts(freeActive));
        for (const key of deps) {
          const rejected = freeActive.evictionRejected.find((r) => sameKey(r.key, key));
          assert.ok(rejected, `dependency ${fmtKey(key)} stays pinned while its lease is held`);
          assert.equal(rejected.reason, 'pinned', `dependency ${fmtKey(key)} rejection reason is exactly 'pinned'`);
        }
        assert.equal(freeActive.evicted.length, 0, 'nothing evicted while dependencies are pinned');

        if (!earlyRelease) s.releasePins([lease.lease.token]);
        const freeAfter = manager.free();
        evidence('l3.reclaim', freeFacts(freeAfter));
        for (const key of deps) {
          const rejected = freeAfter.evictionRejected.find((r) => sameKey(r.key, key));
          assert.equal(rejected, undefined, `dependency ${fmtKey(key)} recycled after release`);
          assert.ok(freeAfter.evicted.some((k) => sameKey(k, key)), `dependency ${fmtKey(key)} actually reclaimed`);
        }
      }

      await establishFreshCleanDeps(2000);
      await pinCase(MUTATIONS.earlyReleasePin);

      await establishFreshCleanDeps(3000);
      await pinCase(false);

      // Two overlapping leases: releasing the old token must leave the new lease
      // protecting the deps; releasing the new token must allow real reclamation.
      {
        const lease1 = await manager.prepare(deps);
        assert.equal(lease1.status, 'ready', 'first overlapping lease ready');
        const lease2 = await manager.prepare(deps);
        assert.equal(lease2.status, 'ready', 'second overlapping lease ready');

        s.releasePins([lease1.lease.token]);
        const freeOverlap1 = manager.free();
        evidence('l3.overlapOldReleased', freeFacts(freeOverlap1));
        for (const key of deps) {
          const rejected = freeOverlap1.evictionRejected.find((r) => sameKey(r.key, key));
          assert.ok(rejected, `old token released but ${fmtKey(key)} still protected by new lease`);
          assert.equal(rejected.reason, 'pinned', 'remaining protection reason is exactly pinned');
        }

        s.releasePins([lease2.lease.token]);
        const freeOverlap2 = manager.free();
        evidence('l3.overlapNewReleased', freeFacts(freeOverlap2));
        for (const key of deps) {
          const rejected = freeOverlap2.evictionRejected.find((r) => sameKey(r.key, key));
          assert.equal(rejected, undefined, `new token released so ${fmtKey(key)} reclaimed`);
          assert.ok(freeOverlap2.evicted.some((k) => sameKey(k, key)), `dependency ${fmtKey(key)} actually reclaimed`);
        }
      }

      const closed = await close(s);
      assert.equal(closed.completed, true, 'manual session closes cleanly');
    }

    // ===== 5. Final persistence: unique fact + exact confirmation + reopen =====
    {
      const s = await open();

      // A unique new cell with a nonempty-property state, live session, observedAt 2000.
      s.voxel.beginSession('live');
      s.voxel.observe({
        worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1,
        source: 'vision', evidence: 'seen', stateComplete: true, state: UNIQUE_STATE,
        pos: { x: 4, y: 0, z: 0 },
      });

      if (!MUTATIONS.skipFinalCheckpoint) {
        const cp = await s.checkpoint();
        const ps = s.getPersistenceState();
        evidence('l4.checkpoint', {
          checkpointId: cp.checkpointId,
          voxelRevision: cp.voxelRevision,
          confirmedVoxelRevision: ps.confirmedVoxelRevision,
          lastConfirmedCheckpointId: ps.lastConfirmedCheckpointId,
          dirty: ps.dirty,
        });
        assert.ok(cp.checkpointId, 'final checkpoint returns a confirmation id');
        assert.equal(ps.lastConfirmedCheckpointId, cp.checkpointId, 'final checkpointId confirmed');
        assert.equal(ps.confirmedVoxelRevision, cp.voxelRevision, 'voxel revision confirmed');
        assert.equal(ps.dirty, false, 'clean after final checkpoint (no later writes)');
      }

      // Neither flush nor close auto-saves an uncheckpointed fact.
      const flush = await s.flush();
      assert.equal(flush.pending, false, 'flush never captures new memory changes');

      const closed = await close(s);
      evidence('l4.close', {
        completed: closed.completed,
        dirty: closed.dirty,
        unconfirmedRequest: closed.unconfirmedRequest,
        error: closed.error ? { kind: closed.error.kind, message: closed.error.message } : null,
        lastConfirmedCheckpointId: closed.lastConfirmedCheckpointId,
      });
      assert.equal(closed.completed, true, 'final session closes cleanly');
      assert.equal(closed.unconfirmedRequest, false, 'no unconfirmed request at close');
      assert.equal(closed.error, null, 'no error at close');
      if (MUTATIONS.skipFinalCheckpoint) {
        // The uncheckpointed fact is still dirty: close did not silently save it.
        assert.equal(closed.dirty, true, 'close does not auto-save the uncheckpointed fact');
      } else {
        assert.equal(closed.dirty, false, 'nothing dirty at final close');
      }

      // Reopen and verify the full unique fact; a skipped checkpoint reads the old
      // baseline where this cell was never observed (so the next assertion fails).
      const s2 = await open();
      const cell = s2.voxel.cellAt(DIM, 4, 0, 0);
      evidence('l4.reopenFact', {
        observed: cell.observed,
        freshness: cell.observed ? cell.evidence.freshness : null,
        stateName: cell.observed ? cell.evidence.observation.state.name : null,
        properties: cell.observed ? cell.evidence.observation.state.properties : null,
        observedAt: cell.observed ? cell.evidence.observation.observedAt : null,
        sessionId: cell.observed ? cell.evidence.observation.sessionId : null,
        stateComplete: cell.observed ? cell.evidence.observation.stateComplete : null,
      });
      assert.equal(cell.observed, true, 'reopen has the unique final fact');
      assert.equal(cell.evidence.freshness, 'STALE', 'restored unique fact is STALE');
      assert.equal(cell.evidence.observation.state.name, 'minecraft:oak_log', 'unique state name preserved');
      assert.deepEqual(cell.evidence.observation.state.properties, { axis: 'y' }, 'full exact properties preserved');
      assert.equal(cell.evidence.observation.observedAt, 2000, 'original observedAt preserved');
      assert.equal(cell.evidence.observation.sessionId, 'live', 'original live session preserved');
      assert.equal(cell.evidence.observation.stateComplete, true, 'state completeness preserved');

      // Reads never refresh evidence time or dirty the session.
      const again = s2.voxel.cellAt(DIM, 4, 0, 0);
      assert.equal(again.evidence.freshness, 'STALE', 'read keeps the fact STALE');
      assert.equal(again.evidence.observation.observedAt, 2000, 'read never refreshes observation time');
      assert.equal(s2.getPersistenceState().dirty, false, 'read never dirties the session');

      const closed2 = await close(s2);
      assert.equal(closed2.completed, true, 'reopen session closes cleanly');
    }

    // No PASS is printed here: the final verdict below reports PASS only after
    // every close outcome and cleanup are known to be clean.
  } catch (err) {
    primaryError = err;
  }

  // Fault injection for the close-fault modes: leave a real session for the final
  // phase, wrapped so its close() still really shuts down the SQLite worker but
  // reports a failed shutdown or throws. This exercises the actual shared close
  // path, not a stub.
  if (MUTATIONS.closeFaultIncomplete || MUTATIONS.closeFaultThrow) {
    try {
      const real = await openSpatialSession({ databasePath, worldId: WORLD });
      opened.push({
        async close() {
          const r = await real.close();
          if (MUTATIONS.closeFaultIncomplete) return { ...r, completed: false };
          throw new Error('injected close fault (worker was really closed)');
        },
      });
    } catch (err) {
      primaryError = primaryError ?? err;
    }
  }

  const cleanup = MUTATIONS.cleanupFault
    ? () => {
        throw new Error('injected cleanup fault');
      }
    : (d) => {
        if (isDescendant(tmpdir(), d)) {
          rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
      };

  return finalizeResources({ sessions: opened, closeRecords, primaryError, dir, cleanup });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => {
    process.exitCode = code;
  });
}
