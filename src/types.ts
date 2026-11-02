/**
 * Base primitives shared across every module of the library.
 *
 * These are pure data/geometry types with no dependency on the host. They are
 * deliberately minimal so that the voxel / topology / traversability layers can
 * be exercised against an in-memory Fake without a game or database.
 */

/** A block position in integer grid coordinates. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * A block state: canonical name plus serialized `properties`.
 *
 * Empty `properties` only means "no state attributes were captured" — it must
 * never be read as "complete state" (design §3.2). Completeness is carried by
 * the separate `stateComplete` flag on an `Observation`.
 */
export interface BlockState {
  name: string;
  properties: Record<string, string>;
}

/** Identity of a world save plus a dimension. */
export interface WorldScope {
  worldId: string;
  dim: string;
}

/**
 * Movement modes for the walking body (design §3.3).
 *
 * Vehicles (boats) have a separate execution capability and are not part of this
 * enum; swim here means surface-water movement plus the necessary shore in/out,
 * not full 3D underwater navigation.
 */
export type MoveMode =
  | 'walk'
  | 'jump'
  | 'sneak'
  | 'swim'
  | 'climb'
  | 'ladder'
  | 'drop';
