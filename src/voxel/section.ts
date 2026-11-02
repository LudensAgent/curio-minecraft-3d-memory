/**
 * Sparse 3D storage (design §4).
 *
 * World → Dimension → Chunk (cx,cz) → Section (sy) → Cell. Only sections that
 * have actually been observed (or otherwise need remembering) are allocated.
 */

import type { CellEvidence } from '../observation/types.js';

/** Stable identity of one 16×16×16 section. */
export interface SectionKey {
  worldId: string;
  dim: string;
  cx: number;
  cz: number;
  sy: number;
}

/**
 * One sparse 16×16×16 section.
 *
 * - `cells` is a bit-packed byte stream, width `bits`, index 0 reserved for air.
 * - A cell with its `explored` bit cleared is *not* known air: palette index 0
 *   only means air when the explored bit (and valid evidence) is present.
 */
export interface Section {
  key: SectionKey;
  /** Full block-state strings (name + serialized properties) → index; 0 fixed to air. */
  palette: string[];
  /** Bit-packed cell values; length `ceil(4096 * bits / 8)`. */
  cells: Uint8Array;
  /** `max(1, ceil(log2(palette.length)))`. */
  bits: number;
  /** Has historical precise observation (per-cell bit, 4096-bit). */
  explored: Uint8Array;
  /** Cells the agent walked/stood on. */
  traversed: Uint8Array;
  /** Previously observed but now needing re-verification. */
  stale: Uint8Array;
  /** Derived current risk candidates; must be read together with evidence + dependencies. */
  risk: Uint8Array;
  /** Cells the agent dug/placed (historical modification, never cleared). */
  modified: Uint8Array;
  /** Per-cell evidence keyed by local cell index. */
  evidence: Map<number, CellEvidence>;
  /** Advances on cell content / completeness / validity change; used for section-level dependency invalidation. */
  revision: number;
  /** Statistics only — never proof that the whole section is fresh. */
  lastObservedAt?: number;
}
