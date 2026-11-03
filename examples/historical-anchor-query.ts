/**
 * Runnable Fake example for the bounded historical reachable-anchor query (phase 4D).
 *
 * Shows how to ask "from a known node, which recorded, evidence-resolved,
 * mode-matching anchors can I reach, and which is highest / deepest?" — never a
 * current-traversability or executable-route claim, and never a target selection.
 *
 *  1. filter candidates by tag/source/kind;
 *  2. highest and deepest candidates (by node pos.y, not fragment deepestY);
 *  3. a deeper node in a disconnected region is excluded;
 *  4. a small budget returns partial candidates with BUDGET_EXHAUSTED;
 *  5. shared proof segments (a union of predecessor paths);
 *  6. deleting evidence changes the next query's answer.
 *
 * This example imports the built package by its public name (not the source path),
 * so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/historical-anchor-query.ts
 */

import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import type { SpatialNode, Vec3Like } from 'curio-minecraft-3d-memory';

const WORLD = 'world';
const DIM = 'overworld';

const A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
const B: Vec3Like = { x: 1.5, y: 70, z: 0.5 };
const C: Vec3Like = { x: 2.5, y: 60, z: 0.5 };
const D: Vec3Like = { x: 3.5, y: 66, z: 0.5 };

function node(id: string, pos: Vec3Like, extra: Partial<SpatialNode> = {}): SpatialNode {
  return { id, kind: 'place', source: 'agent', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos }, ...extra };
}

function main(): void {
  const history = new FragmentStore(WORLD);
  const topology = new TopologyStore(history);

  topology.saveNode(node('a', A));
  topology.saveNode(node('b', B, { tag: 'base' }));
  topology.saveNode(node('c', C, { tag: 'resource' }));
  topology.saveNode(node('d', D, { tag: 'resource' }));

  const edge = (id: string, from: string, to: string, fromPos: Vec3Like, toPos: Vec3Like): void => {
    history.saveFragment({ id: `frag-${id}`, worldId: WORLD, dim: DIM, kind: 'walked', entrances: [fromPos], polyline: [fromPos, toPos], geometrySource: 'traversal', deepestY: 63, createdAt: 1, lastUsedAt: 1, uses: 1 });
    history.addTraversal({ id: `ev-${id}`, fragmentId: `frag-${id}`, from: fromPos, to: toPos, worldId: WORLD, dim: DIM, sessionId: 's1', observedAt: 1, source: 'confirmed_walk', mode: 'walk' });
    topology.saveEdge({ id, from, to, type: 'HORIZONTAL', basis: 'traversed', evidenceIds: [`ev-${id}`] });
  };
  edge('e-ab', 'a', 'b', A, B);
  edge('e-bc', 'b', 'c', B, C);
  edge('e-bd', 'b', 'd', B, D);

  // A disconnected region with a very deep node — must not be selected.
  topology.saveNode(node('x', { x: 100, y: 200, z: 100 }));
  topology.saveNode(node('y', { x: 101, y: -60, z: 100 }));
  edge('e-xy', 'x', 'y', { x: 100, y: 200, z: 100 }, { x: 101, y: -60, z: 100 });

  console.log('=== filter: tag=resource ===');
  const resources = topology.historicalAnchorCandidates('a', { tag: 'resource' });
  console.log('  items:', resources.items.map((i) => `${i.node.id}(hops=${i.hops})`).join(', '));
  console.log('  proofSegments:', resources.proofSegments.map((s) => s.edgeId).join(', '));

  console.log('=== highest candidate ===');
  const highest = topology.historicalAnchorCandidates('a', { order: 'highest', includeStart: false, limit: 1 });
  console.log('  ', highest.items.map((i) => `${i.node.id}@y=${(i.node.location as { pos: Vec3Like }).pos.y}`).join(', '));

  console.log('=== deepest candidate ===');
  const deepest = topology.historicalAnchorCandidates('a', { order: 'deepest', includeStart: false, limit: 1 });
  console.log('  ', deepest.items.map((i) => `${i.node.id}@y=${(i.node.location as { pos: Vec3Like }).pos.y}`).join(', '));
  console.log('  (disconnected deep node y=-60 excluded)');

  console.log('=== small budget ===');
  const tight = topology.historicalAnchorCandidates('a', { maxEdges: 1 });
  console.log('  items:', tight.items.map((i) => i.node.id).join(', '), 'disposition:', tight.disposition, 'exhausted:', tight.exhausted);

  console.log('=== delete evidence → next query reflects the gap ===');
  history.forgetFragment('frag-e-ab');
  const afterDelete = topology.historicalAnchorCandidates('a', { tag: 'resource' });
  console.log('  items:', afterDelete.items.map((i) => i.node.id).join(', ') || '(none)', 'gaps:', afterDelete.gaps);

  console.log('  note: no move, world scan, or current OPEN/BLOCKED was produced above.');
}

void main();
