/**
 * Runnable reference for the *host* lifecycle of one shared spatial session.
 *
 * The library owns the facts and the execution orchestration; the host (Curio)
 * owns the connection, the real perception, and the body. This example pins down
 * the wiring order that Curio must follow, using Fake perception and a Fake body
 * so it runs without a game server:
 *
 *   1. host startup        — host supplies databasePath + worldId, awaits the map
 *   2. shared map          — every perception update and walk delegation reuses `session.voxel`
 *   3. connect / reconnect — sessionId comes from the connection lifecycle; late old-session evidence is rejected
 *   4. perception update   — host writes observations first, forwards the ChangeReport to the active route
 *   5. route lifecycle     — verify → execute → release; cancelling one delegation never closes the shared session
 *   6. save & close        — checkpoint (capture+commit) → flush (wait) → close (bounded shutdown)
 *   7. restore             — history + original times come back STALE; passability is re-established, not reused
 *
 * Disconnect order is fixed and matters: cancel the old delegation *first* (no
 * further physics frame), then produce and dispatch the lifecycle reports
 * (`markStale` / `beginSession`) to the active verifier and executor. A readonly
 * verifier never refreshes itself when the map session changes — it must receive
 * the report explicitly. A late old-session body frame is likewise ignored: it
 * cannot reactivate control or rewrite the cancellation.
 *
 * The save/close path is owned by a small resource boundary (`runOwned`) that
 * guarantees a bounded `close()` for every opened session — on success, on a
 * thrown primary error, and on a later assertion failure — before the temp
 * directory is removed. Only one session (Worker) is open for a shared path at a
 * time: `runPrimaryLifecycle` closes the primary session (awaited, and checked
 * clean) before it reopens the same path, so there are never two open Workers on
 * one database. The boundary preserves the original (primary) error while
 * recording close/cleanup failures as secondary diagnostics; a close that throws
 * or is not clearly clean retains the directory.
 *
 * It uses the default `eager` voxel loading, which restores every committed
 * section at open and is only appropriate when the world fits the session's
 * working-set budget. For on-demand residency and route pin protection, see
 * `examples/working-set.ts` and the "manual on-demand section residency" README
 * section — this example does not imply eager loading suits every world.
 *
 * Run with (the package self-resolves its own name through `exports`):
 *
 *   npm run build
 *   npx tsx examples/shared-session-lifecycle.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RouteVerifier, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type {
  BodySample,
  ChangeReport,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Observation,
  Vec3Like,
  WalkRouteRequest,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  CloseResult,
  OpenSpatialSessionOptions,
  SpatialSession,
} from 'curio-minecraft-3d-memory/storage/sqlite';

export const WORLD = 'world';
export const DIM = 'overworld';
export const STONE = { name: 'minecraft:stone', properties: {} };
export const AIR = { name: 'minecraft:air', properties: {} };
export const NOW = 2000;

export const shapeProvider: CollisionShapeProvider = {
  version: 'host-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
  },
};

/**
 * A Fake body that never advances on its own: `move` leaves the returned promise
 * pending until the host stops the delegation. This keeps a started step in flight
 * (`activeStepIndex !== null`, empty `result`) so the disconnect wiring can be
 * observed. `stop` belongs to the delegation and only releases the pending promise
 * with a cancellation — it never fabricates a body sample.
 */
export class HangingExecutor implements MoveExecutor {
  readonly stopCalls: string[] = [];
  lastRequest: ExecutableMove | null = null;
  private resolve: ((result: ExecutableMoveResult) => void) | null = null;

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.lastRequest = request;
    return new Promise<ExecutableMoveResult>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(executionId: string): void {
    this.stopCalls.push(executionId);
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve !== null) resolve({ failure: { kind: 'cancelled' } });
  }
}

/** Host perception: write one real observation and hand back its `ChangeReport`. */
export function observe(
  map: { observe: (o: Observation) => ChangeReport },
  sessionId: string,
  state: { name: string; properties: Record<string, string> },
  pos: Vec3Like,
  sequence: number,
  observedAt: number,
): ChangeReport {
  return map.observe({
    worldId: WORLD, dim: DIM, sessionId, observedAt, sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state, pos,
  });
}

/** A measured body sample keyed to one execution. Host pushes use the delegation id. */
export function sampleAt(
  executionId: string,
  sessionId: string,
  pos: Vec3Like,
  sequence = 1,
  observedAt = NOW,
): BodySample {
  return {
    worldId: WORLD, dim: DIM, sessionId, executionId, sequence,
    pos: { ...pos }, observedAt, alive: true, connected: true,
    observationReady: true, onGround: true, inWater: false,
  };
}

export const POINTS: Vec3Like[] = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

export const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' } as const;

/** A walk delegation request for the shared route, bound to one connection session. */
export function walkRequest(sessionId: string): WalkRouteRequest {
  return {
    worldId: WORLD, dim: DIM, sessionId, mode: 'walk', body: BODY,
    points: POINTS, arrival: { kind: 'exact' }, shapeProvider,
    deadlineMs: 100_000, timeoutMs: 10_000,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Seed the shared map with the grounded corridor used by every scenario. */
export function seedCorridor(map: VoxelMap): void {
  map.beginSession('conn-1');
  let seq = 0;
  for (let x = 0; x <= 3; x++) {
    observe(map, 'conn-1', STONE, { x, y: -1, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 0, z: 0 }, ++seq, NOW);
    observe(map, 'conn-1', AIR, { x, y: 1, z: 0 }, ++seq, NOW);
  }
}

/** Register a readonly verifier for the conn-1 route and fully verify it. */
export function registerConn1Verifier(map: VoxelMap, clock: () => number): RouteVerifier {
  const verifier = new RouteVerifier(map, { now: clock });
  verifier.register({
    worldId: WORLD, dim: DIM, sessionId: 'conn-1', mode: 'walk',
    body: BODY, shapeProvider, points: POINTS,
  });
  verifier.advance(10);
  return verifier;
}

/** Start a conn-1 walk delegation and leave it in flight (hanging body). */
export function startConn1Walk(map: VoxelMap, clock: () => number): { walk: WalkRouteExecutor; body: HangingExecutor } {
  const body = new HangingExecutor();
  const walk = new WalkRouteExecutor(map, body, { now: clock });
  const started = walk.start(walkRequest('conn-1'));
  walk.onSample(sampleAt(started.delegationId, 'conn-1', POINTS[0]!));
  walk.advance(10);
  return { walk, body };
}

/** Evidence collected by the real disconnect wiring, for the shared assertions. */
export interface DisconnectResult {
  verdict: string;
  walkOutcome: string | null;
  activeStepIndex: number | null;
  lateObservationRejected: boolean;
  reobservedCellFresh: boolean;
  neighborCellStale: boolean;
  stopCalls: string[];
  lastMoveExecutionId: string | null;
}

/** Negative-control channel omission; only the tests use this to prove the shared invariant depends on the verifier report. */
export interface DisconnectOptions {
  skipVerifierReport?: boolean;
}

/**
 * The real disconnect channel: cancel the old delegation first, then dispatch the
 * lifecycle reports, then show that old evidence (observation and body frame) can
 * no longer refresh or reactivate anything. `main` and the positive test both call
 * this exact wiring; the negative controls omit a single channel to show the shared
 * invariant fails without it.
 */
export function runDisconnect(map: VoxelMap, clock: () => number, options: DisconnectOptions = {}): DisconnectResult {
  const verifier = registerConn1Verifier(map, clock);
  const { walk, body } = startConn1Walk(map, clock);

  cancelActiveDelegation(walk);
  const stale = map.markStale(DIM, 'observation_gap');
  const switched = map.beginSession('conn-2');
  if (!options.skipVerifierReport) {
    verifier.apply(stale, 10);
    verifier.apply(switched, 10);
  }
  walk.observe(stale, 10);
  walk.observe(switched, 10);

  // Late old observation: rejected.
  const late = observe(map, 'conn-1', STONE, { x: 0, y: -1, z: 0 }, 99, clock());
  // Late old body frame: must not reactivate control or rewrite the cancellation.
  walk.onSample(sampleAt(walk.status()!.delegationId, 'conn-1', POINTS[1]!, 2, clock() + 1000));

  // Re-observe one cell under the new connection; its neighbour stays stale.
  observe(map, 'conn-2', AIR, { x: 0, y: 0, z: 0 }, 100, clock() + 1000);
  const fresh = map.cellAt(DIM, 0, 0, 0);
  const neighbor = map.cellAt(DIM, 1, 0, 0);
  const status = walk.status()!;

  return {
    verdict: verifier.status()!.verdict,
    walkOutcome: status.result?.outcome ?? null,
    activeStepIndex: status.activeStepIndex,
    lateObservationRejected: late.sections.length === 0,
    reobservedCellFresh: fresh.observed && fresh.evidence.freshness === 'FRESH',
    neighborCellStale: neighbor.observed && neighbor.evidence.freshness === 'STALE',
    stopCalls: [...body.stopCalls],
    lastMoveExecutionId: body.lastRequest?.executionId ?? null,
  };
}

/** The shared post-disconnect invariants; fails if the cancel or dispatch is deleted. */
export function assertDisconnected(r: DisconnectResult): void {
  assert(r.verdict !== 'OPEN', 'old verifier must no longer be OPEN');
  assert(r.activeStepIndex === null, 'old walk must have ended');
  assert(r.walkOutcome === 'CANCELLED', 'old walk must be cancelled');
  assert(r.lateObservationRejected, 'late conn-1 observation must be rejected');
  assert(r.reobservedCellFresh, 're-observed cell must be FRESH');
  assert(r.neighborCellStale, 'neighbour must stay STALE');
  assert(r.stopCalls.length === 1, 'the old active move must be stopped exactly once');
  assert(r.stopCalls[0] !== undefined && r.stopCalls[0].endsWith('-step-0'), 'body.stop must target the old move execution');
  assert(r.lastMoveExecutionId !== null && r.lastMoveExecutionId.endsWith('-step-0'), 'no new move may start after cancel');
}

/** Run the disconnect scenario end-to-end on a fresh in-memory map. */
export function runDisconnectScenario(
  clock: () => number = () => NOW,
  options: DisconnectOptions = {},
): DisconnectResult {
  const map = new VoxelMap(WORLD, { now: clock, requireSession: true });
  seedCorridor(map);
  return runDisconnect(map, clock, options);
}

// ---------------------------------------------------------------------------
// Isolated cancel channel: proves the cancel, not the report, ends the old step.
// ---------------------------------------------------------------------------

/** The real cancel wiring shared by `runDisconnect` and the cancel-channel controls. */
export function cancelActiveDelegation(walk: WalkRouteExecutor): void {
  walk.cancel('lifecycle', 'connection lost');
}

export interface CancelChannelResult {
  outcome: string | null;
  activeStepIndex: number | null;
  stopCalls: string[];
}

/**
 * The cancel channel in isolation: one in-flight step, then a truly empty report
 * (an unobserved dimension) and the real cancel — no further body sample, advance,
 * or physics tick, so only the cancel can end the old step.
 */
export function runCancelChannel(map: VoxelMap, clock: () => number, skipCancel = false): CancelChannelResult {
  seedCorridor(map);
  const { walk, body } = startConn1Walk(map, clock);

  const inFlight = walk.status()!;
  assert(inFlight.activeStepIndex !== null, 'old step must be in flight');
  assert(inFlight.result === null, 'old step must have no result yet');

  const empty = map.markStale('nether', 'observation_gap'); // unobserved dimension
  assert(empty.sections.length === 0, 'the cancel-channel report must be empty');
  walk.observe(empty, clock());

  if (!skipCancel) cancelActiveDelegation(walk);

  const after = walk.status()!;
  return {
    outcome: after.result?.outcome ?? null,
    activeStepIndex: after.activeStepIndex,
    stopCalls: [...body.stopCalls],
  };
}

/** Shared success invariant for the isolated cancel channel. */
export function assertCancelled(r: CancelChannelResult): void {
  assert(r.activeStepIndex === null, 'cancel must end the old step immediately');
  assert(r.outcome === 'CANCELLED', 'cancel must terminate the delegation as cancelled');
  assert(r.stopCalls.length === 1, 'cancel must stop the old move exactly once');
  assert(r.stopCalls[0] !== undefined && r.stopCalls[0].endsWith('-step-0'), 'cancel must stop the old move execution');
}

// ---------------------------------------------------------------------------
// Resource boundary: owns one temp directory and the single current session.
// ---------------------------------------------------------------------------

export interface OwnedRunHooks {
  /** Override temp-dir removal (injectable for cleanup-failure tests). */
  cleanupDir?: (dir: string) => void;
  /** Override a session's bounded close (injectable for close-failure tests). */
  closeSession?: (session: SpatialSession) => Promise<CloseResult>;
}

export interface OwnedRun<T> {
  ok: boolean;
  value: T | null;
  /** First failure thrown by the body; its identity/kind/message are preserved. */
  primary: unknown;
  /** Real close result for every session that actually closed (reverse order). */
  closes: CloseResult[];
  /** Secondary: close exceptions (never fabricated into a CloseResult). */
  closeErrors: unknown[];
  /** Secondary: temp-dir cleanup failure (never replaces `primary`). */
  cleanupError: unknown;
  /** True when the temp dir was retained because a close/cleanup was not clean. */
  retained: boolean;
  dir: string;
}

/** A close outcome is clearly clean only when it completed, reported no error, and no request was left unconfirmed. */
function isCleanClose(c: CloseResult): boolean {
  return c.completed && c.error === null && !c.unconfirmedRequest;
}

/** Remove only the exact temp directory this run created; it is always a direct child of the temp root. */
function cleanupOwnedDir(dir: string): void {
  const root = resolve(dir);
  const tmp = resolve(tmpdir());
  if (root === tmp || dirname(root) !== tmp) {
    throw new Error(`refusing to remove a directory that is not a direct child of the temp root: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Tracks the single current session (one Worker per shared path) and the real close outcomes. */
export class OwnedSessions {
  readonly dir: string;
  private current: SpatialSession | null = null;
  readonly closes: CloseResult[] = [];
  readonly closeErrors: unknown[] = [];

  constructor(dir: string) {
    this.dir = dir;
  }

  databasePath(name = 'spatial.db'): string {
    return join(this.dir, name);
  }

  async open(options: OpenSpatialSessionOptions): Promise<SpatialSession> {
    if (this.current !== null) {
      throw new Error('a session is already open; close it before opening another');
    }
    const session = await openSpatialSession(options);
    this.current = session;
    return session;
  }

  /** Close the current session. A thrown close is recorded as a secondary error and re-thrown. */
  async close(hooks: OwnedRunHooks = {}): Promise<CloseResult> {
    const session = this.current;
    if (session === null) throw new Error('no session is open');
    this.current = null;
    const close = hooks.closeSession ?? ((s) => s.close());
    try {
      const result = await close(session);
      this.closes.push(result);
      return result;
    } catch (err) {
      this.closeErrors.push(err);
      throw err;
    }
  }

  /** Close whatever session is still open (boundary cleanup); a thrown close stays secondary. */
  async closeIfOpen(hooks: OwnedRunHooks = {}): Promise<void> {
    if (this.current === null) return;
    await this.close(hooks).catch(() => {});
  }
}

export async function runOwned<T>(
  tag: string,
  body: (sessions: OwnedSessions) => Promise<T>,
  hooks: OwnedRunHooks = {},
): Promise<OwnedRun<T>> {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  const sessions = new OwnedSessions(dir);
  let value: T | null = null;
  let primary: unknown = null;
  try {
    value = await body(sessions);
  } catch (err) {
    primary = err;
  }

  await sessions.closeIfOpen(hooks);
  const closeFailed = sessions.closeErrors.length > 0 || sessions.closes.some((c) => !isCleanClose(c));

  let cleanupError: unknown = null;
  let retained = false;
  if (closeFailed) {
    retained = true; // shutdown not clean: retain the directory and diagnostics
  } else {
    try {
      (hooks.cleanupDir ?? cleanupOwnedDir)(dir);
    } catch (err) {
      cleanupError = err;
      retained = true;
    }
  }

  return {
    ok: primary === null && !closeFailed && cleanupError === null,
    value,
    primary,
    closes: sessions.closes,
    closeErrors: sessions.closeErrors,
    cleanupError,
    retained,
    dir,
  };
}

// ---------------------------------------------------------------------------
// Save/close/reopen and capacity scenarios (used by `main` and the tests).
// ---------------------------------------------------------------------------

export interface LifecycleHooks extends OwnedRunHooks {
  /** Injected assertion failure after reopen (proves the reopened session still closes). */
  afterReopen?: (reopened: SpatialSession) => void;
}

function assertCleanClose(c: CloseResult, label: string): void {
  if (!c.completed) throw new Error(`${label} did not complete`);
  if (c.error !== null) throw c.error;
  if (c.unconfirmedRequest) throw new Error(`${label} reports an unconfirmed request`);
}

/** Normal disconnect → save → close primary → reopen → restore, with the save fields asserted. */
export async function runPrimaryLifecycle(hooks: LifecycleHooks = {}): Promise<OwnedRun<void>> {
  const clock = () => NOW;
  return runOwned<void>('shared-session', async (sessions) => {
    const primary = await sessions.open({
      databasePath: sessions.databasePath('spatial.db'),
      worldId: WORLD,
      voxelOptions: { now: clock },
    });
    seedCorridor(primary.voxel);

    // The real disconnect wiring runs on the real primary session voxel (not a
    // separate in-memory map), so the conn-2 re-observation is saved and restored.
    assertDisconnected(runDisconnect(primary.voxel, clock));

    const cp = await primary.checkpoint();
    const state = primary.getPersistenceState();
    assert(cp.checkpointId === state.lastConfirmedCheckpointId, 'checkpoint id must equal last confirmed');
    assert(cp.voxelRevision === state.confirmedVoxelRevision, 'voxel revision must equal confirmed');
    assert(state.dirty === false, 'save must not be dirty');

    // Close the primary session (awaited, and checked clean) before reopening:
    // one Worker at a time for the shared path; a non-clean close prevents reopen.
    assertCleanClose(await sessions.close(hooks), 'primary session close');

    const reopened = await sessions.open({ databasePath: sessions.databasePath('spatial.db'), worldId: WORLD });
    if (hooks.afterReopen) hooks.afterReopen(reopened);
    const cell = reopened.voxel.cellAt(DIM, 0, 0, 0);
    assert(cell.observed && cell.evidence.freshness === 'STALE', 'restored evidence must be STALE');
    assert(cell.observed && cell.evidence.observation.sessionId === 'conn-2', 'restored conn-2 scope must be preserved');
    assert(cell.observed && cell.evidence.observation.observedAt === NOW + 1000, 'restored conn-2 time must be preserved');
  }, hooks);
}

/** The shared post-conditions of a clean normal save run; the original error is re-thrown, never replaced. */
export function assertCleanSaveRun(run: OwnedRun<unknown>): void {
  if (run.primary !== null) throw run.primary;
  if (run.closeErrors.length > 0) throw run.closeErrors[0];
  if (run.cleanupError !== null) throw run.cleanupError;
  assert(run.closes.length === 2, 'primary and reopened sessions must both close');
  for (const c of run.closes) {
    assert(c.completed, 'every session close must complete');
    assert(!c.dirty, 'close must not report dirty after a confirmed save');
    assert(!c.unconfirmedRequest, 'close must report no unconfirmed request');
    assert(c.error === null, 'close must report no error');
  }
  assert(!run.retained, 'temp dir must be cleaned up');
}

/** Real public snapshotLimits capacity rejection; the error propagates as primary. */
export async function runCapacityLifecycle(hooks: OwnedRunHooks = {}): Promise<OwnedRun<void>> {
  return runOwned<void>('shared-session-cap', async (sessions) => {
    const session = await sessions.open({
      databasePath: sessions.databasePath('capacity.db'),
      worldId: WORLD,
      snapshotLimits: { maxVoxelSections: 1 },
    });
    session.voxel.beginSession('cap-1');
    observe(session.voxel, 'cap-1', STONE, { x: 0, y: -1, z: 0 }, 1, NOW); // section sy = -1
    observe(session.voxel, 'cap-1', AIR, { x: 0, y: 0, z: 0 }, 2, NOW); // section sy = 0
    await session.checkpoint(); // throws PersistenceError('capacity', …)
  }, hooks);
}

function describeError(err: unknown): string {
  if (err instanceof PersistenceError) return `PersistenceError(kind=${err.kind}) ${err.message}`;
  if (err instanceof Error) return `${err.constructor.name}: ${err.message}`;
  return String(err);
}

/**
 * The single structured reporting path shared by `main` and the tests: prints the
 * primary kind/message, every real close result, secondary close/cleanup errors, and
 * the retained directory. Tests inject a capturing writer so they assert exactly what
 * the CLI prints.
 */
export function writeRunReport(write: (line: string) => void, name: string, run: OwnedRun<unknown>): void {
  write(`[${name}] ok=${run.ok} retained=${run.retained}`);
  if (run.primary !== null) {
    write(`[${name}] primary ${describeError(run.primary)}`);
  }
  run.closes.forEach((c, i) => {
    const err = c.error === null ? 'null' : describeError(c.error);
    write(`[${name}] close[${i}] completed=${c.completed} dirty=${c.dirty} unconfirmedRequest=${c.unconfirmedRequest} lastConfirmedCheckpointId=${c.lastConfirmedCheckpointId} error=${err}`);
  });
  run.closeErrors.forEach((e, i) => {
    write(`[${name}] closeError[${i}] ${describeError(e)}`);
  });
  if (run.cleanupError !== null) {
    write(`[${name}] cleanupError ${describeError(run.cleanupError)}`);
  }
  if (run.retained) {
    write(`[${name}] retainedDir=${run.dir}`);
  }
}

async function main(): Promise<void> {
  const normal = await runPrimaryLifecycle();
  writeRunReport((line) => console.log(line), 'L2 normal save', normal);
  assertCleanSaveRun(normal);

  const cap = await runCapacityLifecycle();
  writeRunReport((line) => console.log(line), 'L2 capacity', cap);
  assert(cap.primary instanceof PersistenceError && cap.primary.kind === 'capacity', 'capacity rejection expected');
  assert(cap.cleanupError === null && !cap.retained, 'capacity cleanup should be clean');

  console.log('shared-session-lifecycle: all checks passed.');
}

const isMain =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error('shared-session-lifecycle failed:', err);
    process.exitCode = 1;
  });
}
