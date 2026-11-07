/**
 * M8.1 — SQLite checkpoint cost (plan M8.1 "checkpoint 分域/全量").
 *
 * Per-round shape: open a fresh `mkdtemp` database, open the session,
 * **populate it in the prepare step**, then time only `checkpoint()` (a real
 * first-baseline commit), and close/remove. `benchmarkStaged` keeps the
 * population of BOTH domains outside the measured window.
 *
 * Rows:
 * - history + topology: `openHistorySession` — 20 000 nodes / 20 000 edges /
 *   1000 fragments / the traversals backing the edges.
 * - voxel: `openSpatialSession` — 10 000 Sections (one observed cell each),
 *   replayed with `beginSession` + `observeBatch` in prepare.
 *
 * Capability probe (not a timed row): there is no voxel-only checkpoint entry
 * point in `src/storage/sqlite` (`openHistorySession` is history+topology;
 * `openSpatialSession.checkpoint()` captures voxel+history+topology together),
 * and the combined requested scale exceeds the default snapshot `maxBytes`.
 * The probe prints the verified outcome; `baseline.md` records it.
 *
 * Run: `npx tsx benchmarks/checkpoint.bench.ts`
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHistorySession, openSpatialSession, PersistenceError } from '../dist/storage/sqlite/index.js';
import type { HistorySession, SpatialSession } from '../dist/storage/sqlite/index.js';
import {
  benchmarkStaged,
  build,
  buildSparseSections,
  buildTopologyFixture,
  Report,
  SESSION,
  topologyPlan,
  WORLD,
} from './fixtures.js';

const NODES = 20_000;
const EDGES = 20_000;
const FRAGMENTS = 1000;
const SPINE = 1024;
const SECTIONS = 10_000;

const report = new Report(
  'checkpoint benchmark',
  'Real SQLite persistence worker over `mkdtemp` databases (removed after each round); history/topology and voxel are separate sessions; populate runs in prepare, only checkpoint() is timed.',
);

interface Round {
  dir: string;
  databasePath: string;
  session: HistorySession | SpatialSession;
}

function newDatabase(): { dir: string; databasePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'm81-checkpoint-'));
  return { dir, databasePath: join(dir, 'bench.db') };
}

/** A database's size including its WAL/SHM siblings (0 when absent). */
function dbBytes(path: string): number {
  const size = (p: string): number => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  return size(path) + size(`${path}-wal`) + size(`${path}-shm`);
}

function removeRound(round: Round): void {
  rmSync(round.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// ---------------------------------------------------------------------------
// history + topology domain
// ---------------------------------------------------------------------------

const historyFixture = await build('populate 20k nodes / 20k edges / 1000 fragments', {
  nodes: NODES,
  edges: EDGES,
  fragments: FRAGMENTS,
}, () => buildTopologyFixture(topologyPlan(NODES, EDGES, SPINE, FRAGMENTS)));
report.add(historyFixture.setup);
const history = historyFixture.value;

const historyBench = await benchmarkStaged(
  'history+topology checkpoint (domain-separated)',
  {
    nodes: history.written.nodes,
    edges: history.written.edges,
    fragments: history.fragments.length,
    traversals: history.traversals.length,
    measuredJsonBytes: history.measureBytes,
  },
  async (): Promise<Round> => {
    const { dir, databasePath } = newDatabase();
    const session = await openHistorySession({
      databasePath,
      worldId: WORLD,
      fragmentOptions: { maxTraversals: EDGES },
    });
    session.history.restoreSnapshot({ worldId: WORLD, fragments: history.fragments, traversals: history.traversals });
    session.topology.restoreSnapshot(history.topologySnapshot);
    return { dir, databasePath, session };
  },
  async (round) => {
    const session = round.session as HistorySession;
    await session.checkpoint();
    if (dbBytes(round.databasePath) <= 0) throw new Error('history checkpoint left no database file');
  },
  async (round) => {
    await round.session.close();
    removeRound(round);
  },
);
report.add(historyBench);

// ---------------------------------------------------------------------------
// voxel domain
// ---------------------------------------------------------------------------

const voxelFixture = await build('populate 10k Sections (one cell each)', { sections: SECTIONS }, () => {
  const { map, observations, plan } = buildSparseSections(SECTIONS);
  return { map, observations, sections: plan.sections, measure: map.checkpointMeasure() };
});
report.add(voxelFixture.setup);
const voxel = voxelFixture.value;

const voxelBench = await benchmarkStaged(
  'voxel checkpoint (domain-separated)',
  {
    sections: voxel.sections,
    observedCells: voxel.measure.observedCells,
    measuredJsonBytes: voxel.measure.bytes,
  },
  async (): Promise<Round> => {
    const { dir, databasePath } = newDatabase();
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    // Population is prepare work: only checkpoint() is measured.
    session.voxel.beginSession(SESSION);
    session.voxel.observeBatch({ observations: voxel.observations, unobserved: [] });
    return { dir, databasePath, session };
  },
  async (round) => {
    const session = round.session as SpatialSession;
    await session.checkpoint();
    if (dbBytes(round.databasePath) <= 0) throw new Error('voxel checkpoint left no database file');
  },
  async (round) => {
    await round.session.close();
    removeRound(round);
  },
);
report.add(voxelBench);

// ---------------------------------------------------------------------------
// capability probe: combined all-domain checkpoint at the requested scale
// ---------------------------------------------------------------------------

async function probeCombinedCheckpoint(): Promise<string> {
  const { dir, databasePath } = newDatabase();
  const session = await openSpatialSession({
    databasePath,
    worldId: WORLD,
    fragmentOptions: { maxTraversals: EDGES },
  });
  try {
    session.history.restoreSnapshot({ worldId: WORLD, fragments: history.fragments, traversals: history.traversals });
    session.topology.restoreSnapshot(history.topologySnapshot);
    session.voxel.beginSession(SESSION);
    session.voxel.observeBatch({ observations: voxel.observations, unobserved: [] });
    try {
      await session.checkpoint();
      return `committed (db ${dbBytes(databasePath)} bytes)`;
    } catch (error) {
      if (error instanceof PersistenceError && error.kind === 'capacity') return `rejected capacity: ${error.message}`;
      return `rejected ${error instanceof PersistenceError ? error.kind : 'error'}: ${(error as Error).message}`;
    }
  } finally {
    await session.close();
    removeRound({ dir, databasePath, session });
  }
}

const combined = await probeCombinedCheckpoint();
process.stdout.write(
  `capability note: voxel-only checkpoint entry point: none (history-only = openHistorySession; all-domain = openSpatialSession). ` +
  `combined requested scale (${SECTIONS} Sections + ${NODES} nodes / ${EDGES} edges): ${combined}\n\n`,
);

report.flush();
