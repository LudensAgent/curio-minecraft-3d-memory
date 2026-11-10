/**
 * Bounded paging and read-only queries over semantic facts + voxel cells.
 *
 * Measures the current `createVoxelFactsQueryPort` surface: places/resources/
 * containers and the merged `nodes` stream at bounded limits, plus a bounded
 * cell query. No retired topology, fragment or route query is involved.
 *
 * Run: `npx tsx benchmarks/paging-query.bench.ts`
 */

import { InMemoryFactStore, VoxelMap, createVoxelFactsQueryPort } from '../src/index.js';
import { benchmark, build, Report, RUNS, WORLD } from './fixtures.js';

const FACTS = 20_000;
const CELLS = 1_000;

const report = new Report(
  'paging / read-only query benchmark',
  'In-memory facts store and voxel map projected through `createVoxelFactsQueryPort` (no server, no mineflayer).',
);

const fixture = await build('populate 20k places + 20k resources + 20k containers', { facts: FACTS * 3 }, async () => {
  const facts = new InMemoryFactStore();
  for (let i = 0; i < FACTS; i++) {
    const id = String(i).padStart(6, '0');
    facts.upsertPlace({
      id: `bench:place:${id}`,
      kind: 'place',
      label: `place ${id}`,
      worldId: WORLD,
      dim: 'overworld',
      location: { kind: 'exact', pos: { x: i, y: 64, z: 0 } },
      observedAt: 100_000,
      source: { source: 'agent' },
      gone: false,
    });
    facts.upsertResource({
      id: `bench:resource:${id}`,
      worldId: WORLD,
      dim: 'overworld',
      label: 'bench:stone',
      sourceCell: { x: i, y: 0, z: 64 },
      observedAt: 100_000,
      source: { source: 'vision' },
      revoked: false,
    });
    facts.upsertContainer({
      id: `bench:container:${id}`,
      worldId: WORLD,
      dim: 'overworld',
      pos: { x: i, y: 64, z: 64 },
      externalRef: `bench:chest:${id}`,
      observedAt: 100_000,
      source: { source: 'vision' },
      gone: false,
    });
  }
  const voxel = new VoxelMap(WORLD);
  const port = createVoxelFactsQueryPort({ worldId: WORLD, voxel, facts });
  return { facts, voxel, port };
});
report.add(fixture.setup);
const { port } = fixture.value;

const scale = {
  places: FACTS,
  resources: FACTS,
  containers: FACTS,
};

function drainPages<T extends { id: string }>(
  fetch: (after: string | undefined, limit: number) => { items: T[]; nextAfter?: string },
): number {
  let after: string | undefined;
  let seen = 0;
  for (;;) {
    const page = fetch(after, 100);
    seen += page.items.length;
    if (page.nextAfter === undefined) return seen;
    after = page.nextAfter;
  }
}

const results = [
  await benchmark('places first page limit=100', { ...scale, limit: 100 }, () => {
    const result = port.query({ kind: 'places', dim: 'overworld', limit: 100 });
    if (result.data?.kind !== 'places' || result.data.items.length !== 100) {
      throw new Error('places page did not return the requested window');
    }
    return result;
  }, RUNS),
  await benchmark('places drain all pages limit=100', { ...scale, limit: 100 }, () => {
    const seen = drainPages((after, limit) => {
      const data = port.query({ kind: 'places', dim: 'overworld', after, limit }).data;
      if (data?.kind !== 'places') throw new Error('expected places data');
      return data;
    });
    if (seen !== FACTS) throw new Error(`drained ${seen} places, expected ${FACTS}`);
    return seen;
  }, RUNS),
  await benchmark('nodes merged page limit=1000', { ...scale, limit: 1000 }, () => {
    const result = port.query({ kind: 'nodes', dim: 'overworld', limit: 1000 });
    if (result.data?.kind !== 'nodes' || result.data.items.length !== 1000) {
      throw new Error('nodes merge did not return the requested window');
    }
    return result;
  }, RUNS),
  await benchmark('resourceAnchors page limit=1000', { ...scale, limit: 1000 }, () => {
    const result = port.query({ kind: 'resourceAnchors', dim: 'overworld', limit: 1000 });
    if (result.data?.kind !== 'resourceAnchors' || result.data.items.length !== 1000) {
      throw new Error('resource page did not return the requested window');
    }
    return result;
  }, RUNS),
  await benchmark('containerAnchors page limit=1000', { ...scale, limit: 1000 }, () => {
    const result = port.query({ kind: 'containerAnchors', dim: 'overworld', limit: 1000 });
    if (result.data?.kind !== 'containerAnchors' || result.data.items.length !== 1000) {
      throw new Error('container page did not return the requested window');
    }
    return result;
  }, RUNS),
  await benchmark('cells unobserved window', { ...scale, cells: CELLS }, () => {
    const positions = Array.from({ length: CELLS }, (_, i) => ({ x: i, y: 64, z: -64 }));
    const result = port.query({ kind: 'cells', dim: 'overworld', positions });
    if (result.data?.kind !== 'cells' || result.data.cells.length !== CELLS) {
      throw new Error('cell query did not return every requested position');
    }
    return result;
  }, RUNS),
];

for (const result of results) report.add(result);
report.flush();
