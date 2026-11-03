/**
 * Runnable Fake example for the explicit topology facts store (design §5, phase 4B).
 *
 * Demonstrates the separation between explicit topology records, their historical
 * evidence references, and current traversability — entirely in-memory and through
 * the public API:
 *   1. save two exact nodes;
 *   2. save an explicit candidate edge and confirm it is not a traversed fact;
 *   3. submit matching traversal evidence and update the edge to a traversed
 *      directed connection (A→B, no auto reverse);
 *   4. block the current map — the topology history stays;
 *   5. delete the source fragment — the edge stays but reports its reference missing.
 *
 * This example imports the built package by its public name (not the source path),
 * so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/topology-facts.ts
 */

import { FragmentStore, TopologyStore, VoxelMap, evaluateWalkStep } from 'curio-minecraft-3d-memory';
import type {
  CollisionShapeProvider,
  Observation,
  PathFragment,
  TraversalEvidence,
  Vec3Like,
} from 'curio-minecraft-3d-memory';

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };

// --- Minimal Fake collision rules (not Minecraft 1.20.1). ---
const EMPTY = { boxes: [], supportFaces: [] };
const FULL = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const provider: CollisionShapeProvider = {
  version: 'example-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: EMPTY };
    if (state.name === 'minecraft:stone') return { kind: 'shape', shape: FULL };
    return { kind: 'unsupported_shape', block: state.name, detail: `no example rule for ${state.name}` };
  },
};

const AIR = { name: 'minecraft:air', properties: {} };
const STONE = { name: 'minecraft:stone', properties: {} };

function obs(state: { name: string; properties: Record<string, string> }, pos: Vec3Like, observedAt: number): Observation {
  return {
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    observedAt,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state,
    pos: { ...pos },
  };
}

async function main(): Promise<void> {
  let now = 2000;
  const map = new VoxelMap(SCOPE.worldId, { now: () => now });

  // A short corridor: stone floor with two blocks of air above, along x = 0..2.
  for (let x = 0; x <= 2; x++) map.observe(obs(STONE, { x, y: -1, z: 0 }, 1000));
  for (let x = 0; x <= 2; x++) {
    map.observe(obs(AIR, { x, y: 0, z: 0 }, 1000));
    map.observe(obs(AIR, { x, y: 1, z: 0 }, 1000));
  }

  const history = new FragmentStore(SCOPE.worldId);
  const topology = new TopologyStore(history);

  // 1. Two exact nodes.
  const aPos: Vec3Like = { x: 0.5, y: 0, z: 0.5 };
  const bPos: Vec3Like = { x: 1.5, y: 0, z: 0.5 };
  topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: SCOPE.worldId, dim: SCOPE.dim, location: { kind: 'exact', pos: aPos } });
  topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: SCOPE.worldId, dim: SCOPE.dim, location: { kind: 'exact', pos: bPos } });
  console.log('=== nodes ===');
  console.log('  saved a, b;', topology.nodes({ dim: SCOPE.dim }).total, 'node(s)');

  // 2. A candidate edge is an explicit "to-verify" relation, not a traversed fact.
  topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'candidate', source: 'manual', evidenceIds: [] });
  let view = topology.getEdge('e-ab')!;
  console.log('=== candidate edge ===');
  console.log(`  basis=${view.basis} resolution=${view.resolution} evidenceIds=[${view.evidenceIds.join(',')}]`);

  // 3. Submit matching traversal evidence and update the edge to a traversed connection.
  const fragment: PathFragment = {
    id: 'frag-corridor',
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    kind: 'walked',
    entrances: [{ ...aPos }],
    polyline: [{ ...aPos }, { ...bPos }],
    geometrySource: 'traversal',
    deepestY: -1,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
  };
  history.saveFragment(fragment);
  const evidence: TraversalEvidence = {
    id: 'ev-1',
    fragmentId: 'frag-corridor',
    from: { ...aPos },
    to: { ...bPos },
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    observedAt: 1000,
    source: 'confirmed_walk',
    mode: 'walk',
  };
  history.addTraversal(evidence);
  topology.updateEdge('e-ab', { basis: 'traversed', evidenceIds: ['ev-1'] });
  view = topology.getEdge('e-ab')!;
  console.log('=== traversed edge ===');
  console.log(`  basis=${view.basis} resolution=${view.resolution} mode=${view.references[0]!.current!.mode}`);

  // 4. Reverse is not auto-proven: there is still exactly one edge, A→B.
  console.log('=== directionality ===');
  console.log('  edges:', topology.edges().items.map((e) => `${e.from}→${e.to}`).join(', '));

  // 5. Block the current map: a wall appears in the destination cell.
  now = 3000;
  map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, 3000));
  const step = evaluateWalkStep(
    map,
    {
      worldId: SCOPE.worldId,
      dim: SCOPE.dim,
      sessionId: SCOPE.sessionId,
      mode: 'walk',
      body: { feet: { ...aPos }, width: 0.6, height: 1.8, pose: 'standing' },
      direction: { axis: 'x', sign: 1 },
    },
    provider,
    now,
  );
  console.log('=== current traversability ===');
  console.log(`  blocked: ${step.status} (${step.reason})`);
  console.log('  topology still holds:', topology.edges().total, 'edge,', topology.nodes().total, 'node(s)');

  // 6. Delete the source fragment; the edge survives but reports its reference missing.
  history.forgetFragment('frag-corridor');
  view = topology.getEdge('e-ab')!;
  console.log('=== after fragment deletion ===');
  console.log(`  edge basis=${view.basis} resolution=${view.resolution} references=[${view.references.map((r) => r.status).join(',')}]`);
  console.log('  edge still stored:', topology.edges().total === 1, '(history edge is never auto-deleted)');
}

void main();
