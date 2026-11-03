/**
 * Runnable Fake example for the bounded historical topology queries (phase 4C).
 *
 * Shows how to query recorded history — never current traversability:
 *   1. a bounded adjacency read (in/out edges, no reference resolution);
 *   2. a directed reachability query over confirmed traversed edges;
 *   3. an ordered A→B→C historical candidate route with per-segment witnesses;
 *   4. a reverse query that finds no recorded route (directionality);
 *   5. the difference between a mode filter and unknown-mode evidence;
 *   6. a small budget that reports BUDGET_EXHAUSTED instead of a false "no route";
 *   7. deleting evidence changes the next query's answer immediately.
 *
 * No move, world scan, or current-traversability check is ever triggered here.
 *
 * This example imports the built package by its public name (not the source path),
 * so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/historical-topology-query.ts
 */

import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import type { SpatialNode, Vec3Like } from 'curio-minecraft-3d-memory';

const WORLD = 'world';
const DIM = 'overworld';

const A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
const B: Vec3Like = { x: 1.5, y: 64, z: 0.5 };
const C: Vec3Like = { x: 2.5, y: 64, z: 0.5 };

function node(id: string, pos: Vec3Like): SpatialNode {
  return { id, kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos } };
}

function main(): void {
  const history = new FragmentStore(WORLD);
  const topology = new TopologyStore(history);

  for (const [id, pos] of [['a', A], ['b', B], ['c', C]] as [string, Vec3Like][]) {
    topology.saveNode(node(id, pos));
  }

  // 1. A→B and B→C traversed, evidence-backed edges.
  history.saveFragment({ id: 'frag-ab', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [A], polyline: [A, B], geometrySource: 'traversal', deepestY: 63, createdAt: 1000, lastUsedAt: 1000, uses: 1 });
  history.addTraversal({ id: 'ev-ab', fragmentId: 'frag-ab', from: A, to: B, worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 1000, source: 'confirmed_walk', mode: 'walk' });
  topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev-ab'] });

  history.saveFragment({ id: 'frag-bc', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [B], polyline: [B, C], geometrySource: 'traversal', deepestY: 63, createdAt: 1000, lastUsedAt: 1000, uses: 1 });
  history.addTraversal({ id: 'ev-bc', fragmentId: 'frag-bc', from: B, to: C, worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 1000, source: 'confirmed_walk', mode: 'walk' });
  topology.saveEdge({ id: 'e-bc', from: 'b', to: 'c', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev-bc'] });

  console.log('=== adjacency (a) ===');
  const adj = topology.adjacency('a');
  console.log('  out:', adj.outEdges.map((e) => e.id), 'in:', adj.inEdges.map((e) => e.id), 'complete:', adj.complete);

  console.log('=== reachable (a) ===');
  const reach = topology.reachable('a');
  console.log('  nodes:', reach.nodes, 'disposition:', reach.disposition);

  console.log('=== route a→c ===');
  const route = topology.route('a', 'c', { mode: 'walk' });
  console.log('  status:', route.status);
  console.log('  nodes:', route.nodeIds, 'edges:', route.edgeIds);
  console.log('  segments:', route.segments.map((s) => `${s.evidenceId}(${s.evidence.mode ?? 'unknown'})`).join(' → '));

  console.log('=== reverse route c→a ===');
  console.log('  status:', topology.route('c', 'a').status, '(directionality — no reverse evidence)');

  console.log('=== unknown-mode evidence vs a walk filter ===');
  const b2: Vec3Like = { x: 1.5, y: 64, z: 0.5 };
  topology.saveNode(node('u', { x: 3.5, y: 64, z: 0.5 }));
  history.saveFragment({ id: 'frag-bu', worldId: WORLD, dim: DIM, kind: 'walked', entrances: [b2], polyline: [b2, { x: 3.5, y: 64, z: 0.5 }], geometrySource: 'traversal', deepestY: 63, createdAt: 1000, lastUsedAt: 1000, uses: 1 });
  history.addTraversal({ id: 'ev-bu', fragmentId: 'frag-bu', from: b2, to: { x: 3.5, y: 64, z: 0.5 }, worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 1000, source: 'confirmed_walk' }); // mode unknown
  topology.saveEdge({ id: 'e-bu', from: 'b', to: 'u', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev-bu'] });
  console.log('  b→u with mode=walk:', topology.route('b', 'u', { mode: 'walk' }).status, '(mode_unknown gap)');
  console.log('  b→u without mode:', topology.route('b', 'u').status, '(unknown mode preserved)');

  console.log('=== small budget ===');
  const tight = topology.route('a', 'c', { maxHistoryReads: 1 });
  console.log('  status:', tight.status, 'exhausted:', tight.exhausted);

  console.log('=== delete evidence → next query reflects the gap ===');
  history.forgetFragment('frag-ab');
  const afterDelete = topology.route('a', 'c');
  console.log('  status:', afterDelete.status, 'gaps:', afterDelete.gaps);

  console.log('  note: no move, world scan, or current OPEN/BLOCKED was produced above.');
}

void main();
