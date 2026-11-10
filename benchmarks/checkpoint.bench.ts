/**
 * SQLite checkpoint cost for the current voxel + facts runtime.
 *
 * Each round opens a fresh `mkdtemp` database, populates the domain in the
 * unmeasured prepare step, times only `checkpoint()`, then closes and removes
 * the directory. No history/topology domain is involved.
 *
 * Run: `npx tsx benchmarks/checkpoint.bench.ts` (build `dist` first)
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';
import type { SpatialSession } from '../dist/storage/sqlite/index.js';
import {
  benchmarkStaged,
  build,
  buildFacts,
  buildSparseSections,
  Report,
  SESSION,
  WORLD,
} from './fixtures.js';

const SECTIONS = 10_000;
const FACTS = 20_000;

const report = new Report(
  'checkpoint benchmark',
  'Real SQLite persistence worker over `mkdtemp` databases (removed after each round); populate runs in prepare, only checkpoint() is timed.',
);

interface Round {
  dir: string;
  databasePath: string;
  session: SpatialSession;
}

function newDatabase(): { dir: string; databasePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'v011-checkpoint-'));
  return { dir, databasePath: join(dir, 'bench.db') };
}

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
// voxel domain
// ---------------------------------------------------------------------------

const voxelFixture = await build('populate 10k Sections (one cell each)', { sections: SECTIONS }, () => {
  const { map, observations, plan } = buildSparseSections(SECTIONS);
  return { map, observations, sections: plan.sections, measure: map.checkpointMeasure() };
});
report.add(voxelFixture.setup);
const voxel = voxelFixture.value;

const voxelBench = await benchmarkStaged(
  'voxel checkpoint',
  {
    sections: voxel.sections,
    observedCells: voxel.measure.observedCells,
    measuredJsonBytes: voxel.measure.bytes,
  },
  async (): Promise<Round> => {
    const { dir, databasePath } = newDatabase();
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    session.voxel.beginSession(SESSION);
    session.voxel.observeBatch({ observations: voxel.observations, unobserved: [] });
    return { dir, databasePath, session };
  },
  async (round) => {
    await round.session.checkpoint();
    if (dbBytes(round.databasePath) <= 0) throw new Error('voxel checkpoint left no database file');
  },
  async (round) => {
    await round.session.close();
    removeRound(round);
  },
);
report.add(voxelBench);

// ---------------------------------------------------------------------------
// facts domain
// ---------------------------------------------------------------------------

const factsFixture = await build('populate 20k places + 20k resources + 20k containers', { facts: FACTS * 3 }, () => {
  const { store, plan } = buildFacts(FACTS);
  const captured = store.captureSnapshot();
  const snapshot = { worldId: WORLD, revision: store.revision, ...captured };
  return { snapshot, plan, count: snapshot.places.length + snapshot.resources.length + snapshot.containers.length };
});
report.add(factsFixture.setup);
const facts = factsFixture.value;

const factsBench = await benchmarkStaged(
  'facts checkpoint',
  {
    places: facts.plan.places,
    resources: facts.plan.resources,
    containers: facts.plan.containers,
  },
  async (): Promise<Round> => {
    const { dir, databasePath } = newDatabase();
    const session = await openSpatialSession({ databasePath, worldId: WORLD });
    session.facts.installSnapshot(facts.snapshot);
    return { dir, databasePath, session };
  },
  async (round) => {
    const result = await round.session.checkpoint();
    if (!result.factsCommitted) throw new Error('facts checkpoint did not commit the facts domain');
    if (dbBytes(round.databasePath) <= 0) throw new Error('facts checkpoint left no database file');
  },
  async (round) => {
    await round.session.close();
    removeRound(round);
  },
);
report.add(factsBench);

process.stdout.write(
  `note: checkpoint measures voxel and facts domains independently; the retired history/topology tables are neither created nor written.\n\n`,
);

report.flush();
