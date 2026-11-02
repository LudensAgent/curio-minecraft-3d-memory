/**
 * Section coordinate math (design §4).
 *
 * A block position maps to a Section via `Math.floor(v / 16)` for the section
 * index and the Euclidean remainder `((v % 16) + 16) % 16` for the local cell
 * coordinate — so negative coordinates land in the correct section and cell.
 */

import { SECTION_SIZE } from '../constants.js';

/** Section index along one axis (the sign-aware floor). */
export function sectionCoord(v: number): number {
  return Math.floor(v / SECTION_SIZE);
}

/** Local cell coordinate along one axis, always in [0, 15]. */
export function localCoord(v: number): number {
  return ((v % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
}

/**
 * Local cell index inside a 16×16×16 section. X is fastest, then Z, then Y —
 * i.e. `(ly * 16 + lz) * 16 + lx`. This ordering is part of the on-disk contract,
 * so it must stay stable.
 */
export function cellIndex(lx: number, ly: number, lz: number): number {
  return (ly * SECTION_SIZE + lz) * SECTION_SIZE + lx;
}

/** Decomposed block position: which section it lives in and where inside it. */
export interface BlockSectionCoords {
  cx: number;
  cz: number;
  sy: number;
  lx: number;
  ly: number;
  lz: number;
}

/** Decompose a block position into its section and local coordinates. */
export function blockToSection(x: number, y: number, z: number): BlockSectionCoords {
  return {
    cx: sectionCoord(x),
    cz: sectionCoord(z),
    sy: sectionCoord(y),
    lx: localCoord(x),
    ly: localCoord(y),
    lz: localCoord(z),
  };
}
