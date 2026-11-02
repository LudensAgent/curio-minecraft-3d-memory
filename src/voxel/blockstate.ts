/**
 * Canonical block-state serialization (design §3.2 / §4).
 *
 * The palette stores a block state as a single canonical string so that two
 * states differing only in the order of their property keys serialize to the
 * same palette entry. Completeness is carried separately by `stateComplete` on
 * an `Observation` — an empty `properties` record never means "complete state".
 */

import type { BlockState } from '../types.js';

/** Canonical name used for air in the palette; index 0 is reserved for it. */
export const AIR_BLOCK_NAME = 'minecraft:air';

/** True when a block state is air (either namespaced or bare). */
export function isAirState(state: BlockState): boolean {
  return state.name === 'air' || state.name === AIR_BLOCK_NAME;
}

/**
 * Property-order-independent string for a block state.
 *
 * Property keys are sorted by UTF-16 code unit (locale-independent) so the same
 * state serializes identically regardless of how the host assembled `properties`.
 */
export function serializeBlockState(state: BlockState): string {
  const name = state.name === 'air' ? AIR_BLOCK_NAME : state.name;
  const entries = Object.entries(state.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return name;
  return `${name}[${entries.map(([key, value]) => `${key}=${value}`).join(',')}]`;
}
