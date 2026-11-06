import type { Observation } from '../src/observation/types.js';
import { serializeBlockState } from '../src/index.js';
import type { PathFragment, TraversalEvidence } from '../src/topology/index.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import type { CollisionShape, CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import type { BodyContext, StepQuery } from '../src/traversability/step.js';

/** Fake collision rules for tests — NOT Minecraft 1.20.1 collision rules. */
export const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
export const EMPTY: CollisionShape = { boxes: [], supportFaces: [] };
export const BOTTOM_SLAB: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }],
  supportFaces: [{ top: 0.5, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
/** A full-height column occupying only the [0,0.2]×[0,0.2] corner of its cell. */
export const THIN_COLUMN: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 0.2, maxY: 1, maxZ: 0.2 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 0.2, maxZ: 0.2 }],
};

export const AIR: BlockState = { name: 'minecraft:air', properties: {} };
export const STONE: BlockState = { name: 'minecraft:stone', properties: {} };
export const SLAB: BlockState = { name: 'minecraft:smooth_stone_slab', properties: {} };
export const THIN: BlockState = { name: 'minecraft:thin', properties: {} };

export const fakeProvider: CollisionShapeProvider = {
  version: 'fake-1',
  resolve(state) {
    if (state.name === 'minecraft:air' || state.name === 'air') {
      return { kind: 'shape', shape: EMPTY };
    }
    if (state.name === 'minecraft:stone' || state.name === 'minecraft:dirt') {
      return { kind: 'shape', shape: FULL_CUBE };
    }
    if (state.name === 'minecraft:smooth_stone_slab') {
      return { kind: 'shape', shape: BOTTOM_SLAB };
    }
    if (state.name === 'minecraft:thin') {
      return { kind: 'shape', shape: THIN_COLUMN };
    }
    return { kind: 'unsupported_shape', block: serializeBlockState(state), detail: `no fake rule for ${state.name}` };
  },
};

export function obs(state: BlockState, pos: Vec3Like, overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state,
    pos: { ...pos },
    ...overrides,
  };
}

export function bodyAt(x: number, y: number, z: number, width = 0.6, height = 1.8): BodyContext {
  return { feet: { x, y, z }, width, height, pose: 'standing' };
}

export function stepQuery(overrides: Partial<StepQuery> = {}): StepQuery {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    direction: { axis: 'x', sign: 1 },
    ...overrides,
  };
}

/** Minimal valid `PathFragment` bound to the default fake world/dimension. */
export function pathFragment(id: string, overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id,
    worldId: 'world',
    dim: 'overworld',
    kind: 'walked',
    entrances: [{ x: 0.5, y: 64, z: 0.5 }],
    polyline: [
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
    ],
    geometrySource: 'traversal',
    deepestY: 64,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

/** Minimal valid `TraversalEvidence` bound to the default fake world/dimension. */
export function traversalEvidence(
  id: string,
  fragmentId: string,
  from: Vec3Like,
  to: Vec3Like,
  overrides: Partial<TraversalEvidence> = {},
): TraversalEvidence {
  return {
    id,
    fragmentId,
    from: { ...from },
    to: { ...to },
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    source: 'confirmed_walk',
    ...overrides,
  };
}
