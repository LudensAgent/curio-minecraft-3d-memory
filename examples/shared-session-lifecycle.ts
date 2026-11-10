/**
 * Runnable reference for the host lifecycle of one shared spatial session.
 *
 * The library owns evidence, facts, land-search candidates and persistence; the
 * host owns the connection, real perception and body execution. This example
 * pins down the wiring order using Fake perception so it runs without a game:
 *
 *   1. startup        — host supplies databasePath + worldId
 *   2. shared map     — perception, land search and host movement reuse `session.voxel`
 *   3. reconnect      — sessionId comes from the connection lifecycle
 *   4. perception     — host writes observations first, then forwards ChangeReports
 *   5. search         — `searchLandRoute` returns a bounded candidate; host executes it
 *   6. facts          — semantic places/resources are authoritative immediately
 *   7. save & close   — checkpoint → flush → close
 *   8. restore        — original evidence times and facts return; cells are STALE
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
import { searchLandRoute, VoxelMap } from 'curio-minecraft-3d-memory';
import type {
  ChangeReport,
  CollisionShapeProvider,
  Observation,
  Vec3Like,
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

export const BODY = { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' } as const;

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

/** Seed a flat, grounded corridor used by the search example. */
export function seedCorridor(map: VoxelMap, sessionId = 'conn-1'): void {
  map.beginSession(sessionId);
  let seq = 0;
  for (let x = 0; x <= 3; x++) {
    observe(map, sessionId, STONE, { x, y: -1, z: 0 }, ++seq, NOW);
    observe(map, sessionId, AIR, { x, y: 0, z: 0 }, ++seq, NOW);
    observe(map, sessionId, AIR, { x, y: 1, z: 0 }, ++seq, NOW);
  }
}

/** One bounded land-search delegation; the host validates and executes any result. */
export function searchCorridor(map: VoxelMap, now = NOW) {
  return searchLandRoute(map, {
    worldId: WORLD,
    dim: DIM,
    sessionId: 'conn-1',
    body: BODY,
    to: { x: 2.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    rules: { shapeProvider },
    allowed: ['walk', 'step', 'drop'],
    maxNodes: 256,
    maxEdges: 1024,
  }, now);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Resource boundary: owns one temp directory and the single current session.
// ---------------------------------------------------------------------------

export interface OwnedRunHooks {
  cleanupDir?: (dir: string) => void;
  closeSession?: (session: SpatialSession) => Promise<CloseResult>;
}

export interface OwnedRun<T> {
  ok: boolean;
  value: T | null;
  primary: unknown;
  closes: CloseResult[];
  closeErrors: unknown[];
  cleanupError: unknown;
  retained: boolean;
  dir: string;
}

function isCleanClose(c: CloseResult): boolean {
  return c.completed && c.error === null && !c.unconfirmedRequest;
}

function cleanupOwnedDir(dir: string): void {
  const root = resolve(dir);
  const tmp = resolve(tmpdir());
  if (root === tmp || dirname(root) !== tmp) {
    throw new Error(`refusing to remove a directory that is not a direct child of the temp root: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

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
    retained = true;
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
// Save/close/reopen and capacity scenarios.
// ---------------------------------------------------------------------------

function assertCleanClose(c: CloseResult, label: string): void {
  if (!c.completed) throw new Error(`${label} did not complete`);
  if (c.error !== null) throw c.error;
  if (c.unconfirmedRequest) throw new Error(`${label} reports an unconfirmed request`);
}

/** Search live evidence, save voxel + facts, close, reopen, and verify restore. */
export async function runPrimaryLifecycle(hooks: OwnedRunHooks = {}): Promise<OwnedRun<void>> {
  return runOwned<void>('shared-session', async (sessions) => {
    const primary = await sessions.open({
      databasePath: sessions.databasePath('spatial.db'),
      worldId: WORLD,
      voxelOptions: { now: () => NOW },
    });
    seedCorridor(primary.voxel);

    // The current-evidence search produces a bounded candidate only.
    const search = searchCorridor(primary.voxel);
    assert(search.status === 'FOUND', 'seeded corridor must produce a land-search candidate');
    assert(search.executable === false, 'a search candidate is never executable authorization');
    assert(search.points.length > 0, 'a FOUND result carries ordered points');

    primary.facts.upsertPlace({
      id: 'base',
      kind: 'base',
      label: 'home',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: 0, y: 0, z: 0 } },
      observedAt: NOW,
      source: { source: 'agent' },
      gone: false,
    });

    const cp = await primary.checkpoint();
    const state = primary.getPersistenceState();
    assert(cp.checkpointId === state.lastConfirmedCheckpointId, 'checkpoint id must equal last confirmed');
    assert(cp.voxelRevision === state.confirmedVoxelRevision, 'voxel revision must equal confirmed');
    assert(state.dirty === false, 'save must not be dirty');

    assertCleanClose(await sessions.close(hooks), 'primary session close');

    const reopened = await sessions.open({ databasePath: sessions.databasePath('spatial.db'), worldId: WORLD });
    const cell = reopened.voxel.cellAt(DIM, 0, 0, 0);
    assert(cell.observed && cell.evidence.freshness === 'STALE', 'restored evidence must be STALE');
    assert(cell.observed && cell.evidence.observation.sessionId === 'conn-1', 'restored session scope preserved');
    assert(reopened.facts.places().items.some((fact) => fact.id === 'base'), 'restored facts are queryable');
  }, hooks);
}

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
    await session.checkpoint(); // PersistenceError('capacity', …)
  }, hooks);
}

function describeError(err: unknown): string {
  if (err instanceof PersistenceError) return `PersistenceError(kind=${err.kind}) ${err.message}`;
  if (err instanceof Error) return `${err.constructor.name}: ${err.message}`;
  return String(err);
}

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
