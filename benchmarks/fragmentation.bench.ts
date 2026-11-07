/**
 * M8.1 — historical fragment fragmentation (`TopologyStore.fragmentation`).
 *
 * Scale: 1000 fragments (`FragmentStore` default capacity) plus 20 000 actual
 * traversal records that supply the connectivity links. Union-find over the
 * recorded history only: proximity is never a connection.
 *
 * Run: `npx tsx benchmarks/fragmentation.bench.ts`
 */

import { FragmentStore, TopologyStore } from '../src/index.js';
import { buildFragments, buildTraversalLinks, DIM, WORLD, benchmark, build, Report, RUNS } from './fixtures.js';

const FRAGMENTS = 1000;
const TRAVERSALS = 20_000;

const report = new Report(
  'fragmentation benchmark',
  'Real `FragmentStore` + `TopologyStore.fragmentation` over in-memory history (no server, no mineflayer).',
);

const fixture = await build('populate 1000 fragments + 20k traversal links', { fragments: FRAGMENTS, traversals: TRAVERSALS }, () => {
  // Default traversal capacity is 10 000; the link scale needs 20 000 records.
  const history = new FragmentStore(WORLD, { maxTraversals: TRAVERSALS });
  const topology = new TopologyStore(history, { now: () => 100_000 });
  const fragments = buildFragments(history, FRAGMENTS);
  const links = buildTraversalLinks(history, TRAVERSALS, FRAGMENTS);
  return { history, topology, fragments, links };
});
report.add(fixture.setup);
const { topology, fragments, links } = fixture.value;

// Scale sanity: the fixture must actually contain the requested records.
const measure = topology.fragmentation(DIM);
if (measure.records !== fragments.fragments) {
  throw new Error(`fragmentation fixture has ${measure.records} recorded fragments, expected ${fragments.fragments}`);
}

const fragmentation = await benchmark('fragmentation over 1000 fragments / 20k links', {
  fragments: fragments.fragments,
  traversalLinks: links.traversals,
  points: measure.points,
  components: measure.components,
}, () => topology.fragmentation(DIM), RUNS);

report.add(fragmentation);
report.flush();
