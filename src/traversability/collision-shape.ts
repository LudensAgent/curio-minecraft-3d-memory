/**
 * Versioned collision-shape rules (design §3.3).
 *
 * A block state resolves to a collision shape in the cell's unit-local `[0,1]^3`
 * frame. The provider is pure: `resolve` maps one complete block state to a
 * shape and never reads neighbour cells. Neighbour-dependent shapes (fences,
 * walls, redstone) are out of scope this round and must return an
 * `unsupported_shape` resolution rather than guess.
 *
 * The core keeps no walk/no-walk name list and never treats every non-air cell
 * as a full cube; the shape is whatever the versioned provider says it is.
 */

import type { BlockState } from '../types.js';

/** Axis-aligned box in a cell's unit-local `[0,1]^3` frame. */
export interface UnitBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Collision shape a block state presents; coordinates are unit-local `[0,1]^3`. */
export interface CollisionShape {
  /** Solid sub-volumes; empty means no collision (e.g. air). */
  boxes: readonly UnitBox[];
  /**
   * Height (unit coords) of the topmost standable surface, or null when the
   * shape has none. A body stands on a cell when `cellY + supportTop` equals the
   * body's feet height.
   */
  supportTop: number | null;
}

/** Resolution of a complete block state by a rule set. */
export type ShapeResolution =
  | { kind: 'shape'; shape: CollisionShape }
  | { kind: 'unsupported_shape'; block: string; detail: string };

/** Versioned collision-shape rule set. `version` participates in the traversability cache key. */
export interface CollisionShapeProvider {
  version: string;
  resolve(state: BlockState): ShapeResolution;
}
