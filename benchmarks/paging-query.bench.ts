/**
 * M8.1 — bounded paging and read-only queries over 20 000 nodes / 20 000 edges
 * and 1000 fragments / 20 000 traversals.
 *
 * Two surfaces are measured over the same in-memory stores:
 * - raw store pages (`TopologyStore.nodes`/`edges`, `FragmentStore.fragments`/
 *   `traversals`) with the default 100-item page clamp — the host must walk the
 *   cursor;
 * - the query port (`SpatialMemoryStoreImpl.query`) at limit 1000, which joins
 *   store pages internally and must not silently truncate.
 *
 * Also measured: `components` (a full paged recompute over the dimension) and
 * `adjacency` on the highest-degree node.
 *
 * Run: `npx tsx benchmarks/paging-query.bench.ts`
 */

import { SpatialMemoryStoreImpl } from '../src/index.js';
import { buildTopologyFixture, topologyPlan, WORLD, DIM, benchmark, build, Report, RUNS } from './fixtures.js';

const NODES = 20_000;
const EDGES = 20_000;
const FRAGMENTS = 1000;
const SPINE = 1024;

const report = new Report(
  'paging / read-only query benchmark',
  'Real `TopologyStore` / `FragmentStore` pages and `SpatialMemoryStoreImpl.query` over in-memory stores (no server, no mineflayer).',
);

const fixture = await build('populate 20k nodes / 20k edges / 1000 fragments', {
  nodes: NODES,
  edges: EDGES,
  fragments: FRAGMENTS,
}, () => {
  const { history, topology, written, topologySnapshot } = buildTopologyFixture(topologyPlan(NODES, EDGES, SPINE, FRAGMENTS));
  const store = new SpatialMemoryStoreImpl({ worldId: WORLD, fragments: history, topology });

  // Highest-degree node, measured from the recorded edge endpoints.
  const degree = new Map<string, number>();
  for (const edge of topologySnapshot.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const hottest = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  // Cross-check the query-side recompute against the store's dim listing.
  const nodes = topology.nodes({ dim: DIM, limit: 1 }).total;
  return { history, topology, store, written, nodes, hottestNode: hottest[0], hottestDegree: hottest[1] };
});
report.add(fixture.setup);
const { history, topology, store, written, nodes, hottestNode, hottestDegree } = fixture.value;

/** Walk every exclusive-cursor page at the store's clamped page size. */
function drainPages<T extends { id: string }>(fetch: (after: string | undefined, limit: number) => { items: T[]; nextAfter?: string }): number {
  let after: string | undefined;
  let seen = 0;
  for (;;) {
    const page = fetch(after, 100);
    seen += page.items.length;
    if (page.nextAfter === undefined) return seen;
    after = page.nextAfter;
  }
}

const scale = {
  nodes: written.nodes,
  edges: written.edges,
  fragments: FRAGMENTS,
  traversals: written.traversals,
};

const results = [
  await benchmark('store page: first page nodes limit=100', { ...scale, limit: 100 }, () => topology.nodes({ limit: 100 }), RUNS),
  await benchmark('store pages: drain all nodes limit=100', { ...scale, limit: 100 }, () => drainPages((after, limit) => topology.nodes({ after, limit })), RUNS),
  await benchmark('store pages: drain all edges limit=100', { ...scale, limit: 100 }, () => drainPages((after, limit) => topology.edges({ after, limit })), RUNS),
  await benchmark('store pages: drain all fragments limit=100', { ...scale, limit: 100 }, () => drainPages((after, limit) => history.fragments({ after, limit })), RUNS),
  await benchmark('store pages: drain all traversals limit=100', { ...scale, limit: 100 }, () => drainPages((after, limit) => history.traversals({ after, limit })), RUNS),
  await benchmark('query nodes limit=1000 (joined pages)', { ...scale, limit: 1000 }, () => store.query({ kind: 'nodes', limit: 1000 }), RUNS),
  await benchmark('query edges limit=1000 (joined pages)', { ...scale, limit: 1000 }, () => store.query({ kind: 'edges', limit: 1000 }), RUNS),
  await benchmark('query fragments limit=1000 (joined pages)', { ...scale, limit: 1000 }, () => store.query({ kind: 'fragments', limit: 1000 }), RUNS),
  await benchmark('query components (paged full recompute)', scale, () => {
    const result = store.query({ kind: 'components', dim: DIM });
    if (result.data?.kind !== 'components' || result.data.report.recomputedNodes !== nodes) {
      throw new Error('components query did not recompute every dim node');
    }
    return result;
  }, RUNS),
  await benchmark('adjacency highest-degree node', { ...scale, degree: hottestDegree }, () => {
    const adjacency = topology.adjacency(hottestNode);
    if (adjacency.outEdges.length + adjacency.inEdges.length !== hottestDegree) {
      throw new Error(`adjacency read ${adjacency.outEdges.length + adjacency.inEdges.length} edges, expected ${hottestDegree}`);
    }
    return adjacency;
  }, RUNS),
  await benchmark('nodes listing (dim filter) limit=100', { ...scale, limit: 100 }, () => {
    const page = topology.nodes({ dim: DIM, limit: 100 });
    if (page.total !== nodes) throw new Error(`dim node total ${page.total}, expected ${nodes}`);
    return page;
  }, RUNS),
];

for (const result of results) report.add(result);
report.flush();
