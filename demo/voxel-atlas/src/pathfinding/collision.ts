import collisionJson from './collision-data.json?raw';
import type { CollisionShape, CollisionShapeProvider } from '../../../../src/traversability/collision-shape.ts';
import { serializeBlockState } from '../../../../src/voxel/blockstate.ts';

type CollisionData = {
  blocks: Record<string, { states: { name: string; values: string[] }[]; shapes: number | number[] }>;
  shapes: Record<string, number[][]>;
};
const data = JSON.parse(collisionJson) as CollisionData;
const cache = new Map<number, CollisionShape>();
const PORTALS = new Set(['nether_portal', 'end_portal', 'end_gateway']);

/** Data-backed 1.20.1 blockstate geometry; incomplete and unknown properties never default. */
export const collisionProvider: CollisionShapeProvider = {
  version: 'voxel-atlas-java-1.20.1-minecraft-data-3.117.0',
  resolve(state) {
    const name = state.name.replace(/^minecraft:/, '');
    const block = data.blocks[name];
    const unsupported = (detail: string) => ({ kind: 'unsupported_shape' as const, block: serializeBlockState(state), detail });
    if (!block || PORTALS.has(name)) return unsupported(`No ordinary land collision rule for ${name}`);
    if (Object.keys(state.properties).length !== block.states.length) return unsupported(`Incomplete or unknown properties for ${name}`);
    let offset = 0;
    for (const property of block.states) {
      const index = property.values.indexOf(state.properties[property.name] ?? '');
      if (index < 0) return unsupported(`Missing or invalid ${name}.${property.name}`);
      offset = offset * property.values.length + index;
    }
    const shapeId = typeof block.shapes === 'number' ? block.shapes : block.shapes?.[offset];
    if (shapeId === undefined) return unsupported(`Missing collision data for ${name}`);
    const cached = cache.get(shapeId);
    if (cached) return { kind: 'shape', shape: cached };
    const raw = data.shapes[shapeId];
    if (!raw) return unsupported(`Missing collision shape ${shapeId}`);
    // Shapes exceeding the cell (e.g. fences) cannot fit the core's unit-local contract.
    if (raw.some((box) => box.length !== 6 || box.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) {
      return unsupported(`Collision shape for ${name} extends beyond its cell`);
    }
    const boxes = raw.map(([minX, minY, minZ, maxX, maxY, maxZ]) => ({
      minX: minX!, minY: minY!, minZ: minZ!, maxX: maxX!, maxY: maxY!, maxZ: maxZ!,
    }));
    const shape: CollisionShape = {
      boxes,
      supportFaces: boxes.map((box) => ({ top: box.maxY, minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ })),
    };
    cache.set(shapeId, shape);
    return { kind: 'shape', shape };
  },
};
