/**
 * Runnable Fake example for the historical path store (design §3.1, phase 4A).
 *
 * Demonstrates the strict separation between historical fact and current
 * traversability, entirely in-memory and through the public API:
 *   1. save a historical path fragment;
 *   2. explicitly record one confirmed traversal relation (with a source);
 *   3. query the history;
 *   4. block the current map;
 *   5. history is still there while current traversability reports BLOCKED.
 *
 * This example imports the built package by its public name (not the source
 * path), so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/fragment-store-history.ts
 */

import { FragmentStore, VoxelMap, evaluateWalkStep } from 'curio-minecraft-3d-memory';
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

  const store = new FragmentStore(SCOPE.worldId);

  // 1. Save a historical fragment (geometry only — does not claim it is passable).
  const fragment: PathFragment = {
    id: 'frag-corridor',
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    kind: 'walked',
    entrances: [{ x: 0.5, y: 0, z: 0.5 }],
    polyline: [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ],
    geometrySource: 'traversal',
    deepestY: -1,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
  };
  console.log('=== save fragment ===');
  console.log(`  saveFragment → ${store.saveFragment(fragment).status}`);

  // 2. Explicitly record one confirmed traversal relation with a source.
  const evidence: TraversalEvidence = {
    id: 'ev-1',
    fragmentId: 'frag-corridor',
    from: { x: 0.5, y: 0, z: 0.5 },
    to: { x: 1.5, y: 0, z: 0.5 },
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    observedAt: 1000,
    source: 'confirmed_walk',
  };
  console.log('  addTraversal →', store.addTraversal(evidence).status);

  // 3. Query history (read-only; never changes time/uses or current state).
  console.log('=== query history ===');
  console.log('  fragments:', store.fragments({ dim: SCOPE.dim }).items.map((f) => f.id));
  console.log('  traversals:', store.traversals({ fragmentId: 'frag-corridor' }).total, 'record(s)');

  // 4. Current traversability before the blockage.
  const query = {
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    mode: 'walk' as const,
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' as const },
    direction: { axis: 'x' as const, sign: 1 as const },
  };
  const open = evaluateWalkStep(map, query, provider, now);
  console.log('=== current traversability ===');
  console.log(`  before blockage: ${open.status}`);

  // 5. Block the current map: a wall appears in the destination cell.
  now = 3000;
  map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, 3000));
  const blocked = evaluateWalkStep(map, query, provider, now);
  console.log(`  after blockage:  ${blocked.status} (${blocked.reason})`);

  console.log('=== history still intact ===');
  console.log('  fragment still present:', store.getFragment('frag-corridor') !== null);
  console.log('  traversal records:', store.traversals({ fragmentId: 'frag-corridor' }).total);
  console.log('  fragment uses unchanged:', store.getFragment('frag-corridor')!.uses);
}

void main();
