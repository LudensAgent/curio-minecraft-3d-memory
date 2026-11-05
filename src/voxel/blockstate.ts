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

/**
 * Parse a palette entry back into a block state (design §4).
 *
 * Persisted evidence stores only the palette + packable metadata; the state is
 * reconstructed here. The parser accepts exactly the canonical form produced by
 * `serializeBlockState`; malformed entries throw so a corrupt snapshot is
 * rejected instead of silently becoming a guessed block.
 */
export function deserializeBlockState(serialized: string): BlockState {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error('serialized block state must be a non-empty string');
  }
  const open = serialized.indexOf('[');
  if (open === -1) return { name: serialized, properties: {} };
  if (serialized[serialized.length - 1] !== ']') {
    throw new Error(`malformed block state (unterminated properties): "${serialized}"`);
  }
  const name = serialized.slice(0, open);
  if (name.length === 0) {
    throw new Error(`malformed block state (empty name): "${serialized}"`);
  }
  const properties: Record<string, string> = {};
  const body = serialized.slice(open + 1, -1);
  if (body.length > 0) {
    for (const pair of body.split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        throw new Error(`malformed block state property "${pair}" in "${serialized}"`);
      }
      properties[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return { name, properties };
}
