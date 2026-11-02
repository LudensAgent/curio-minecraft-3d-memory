/**
 * Versioned collision-shape rules (design §3.3).
 *
 * A block state resolves to a collision shape in the cell's unit-local `[0,1]^3`
 * frame. The provider is pure apart from reading neighbours through the injected
 * `NeighborRead` entry: `resolve` maps one complete block state — plus any
 * neighbours it needs — to a shape, and returns a structured gap when a required
 * neighbour is missing, stale, expired, from another session, or incomplete.
 *
 * The core keeps no walk/no-walk name list and never treats every non-air cell
 * as a full cube; the shape is whatever the versioned provider says it is.
 */

import type { BlockState, Vec3Like } from '../types.js';

/** Axis-aligned box in a cell's unit-local `[0,1]^3` frame. */
export interface UnitBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * One standable top face, with its own horizontal span. A body is supported when
 * its bottom (at height `cellY + top`) horizontally overlaps at least one face —
 * a partial face never widens into the whole cell.
 */
export interface SupportFace {
  /** Y of the top face in unit coords (0..1). */
  top: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Collision shape a block state presents; coordinates are unit-local `[0,1]^3`. */
export interface CollisionShape {
  /** Solid sub-volumes; empty means no collision (e.g. air). */
  boxes: readonly UnitBox[];
  /** Standable top faces; empty means the block provides no standing surface. */
  supportFaces: readonly SupportFace[];
}

/** What a controlled neighbour read returns. `observed` states are always complete. */
export type NeighborCellView = { pos: Vec3Like } & (
  | { kind: 'observed'; state: BlockState }
  | { kind: 'unobserved' }
  | { kind: 'incomplete' }
  | { kind: 'stale'; reason: 'stale' | 'expired' | 'session' }
);

/**
 * Controlled evidence read for shape rules. The provider can only inspect cells
 * in the current query's world/dim through this entry — never the raw `VoxelMap`
 * or any host/client chunk. Every read is recorded as a dependency and checked
 * for session, freshness, validity and completeness by the evaluator.
 */
export interface NeighborRead {
  cell(x: number, y: number, z: number): NeighborCellView;
}

/** Resolution of a complete block state by a rule set. */
export type ShapeResolution =
  | { kind: 'shape'; shape: CollisionShape }
  | { kind: 'unsupported_shape'; block: string; detail: string }
  | { kind: 'neighbor_gap'; view: NeighborCellView };

/** Versioned collision-shape rule set. `version` participates in the traversability cache key. */
export interface CollisionShapeProvider {
  version: string;
  resolve(state: BlockState, cell: Vec3Like, read: NeighborRead): ShapeResolution;
}
