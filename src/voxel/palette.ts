/**
 * Palette + bit-packing for a Section (design §4).
 *
 * Cell values are palette indices packed into a byte stream of width `bits`.
 * Palette index 0 is reserved for air; a cell whose `explored` bit is clear is
 * *not* known air even though its packed value defaults to 0.
 */

import { SECTION_CELL_COUNT } from '../constants.js';
import { AIR_BLOCK_NAME } from './blockstate.js';
import type { Section, SectionKey } from './section.js';

/** Width in bits required to address `paletteLength` distinct states. */
export function bitsRequired(paletteLength: number): number {
  if (paletteLength <= 2) return 1;
  return Math.ceil(Math.log2(paletteLength));
}

// bits stays far below 31 for any realistic palette (2^31 distinct block states
// is unreachable); JS shift semantics only matter at that pathological bound.
function maskFor(bits: number): number {
  return (1 << bits) - 1;
}

/** Read a packed palette index at a local cell index. */
export function readCell(cells: Uint8Array, bits: number, index: number): number {
  const bitOffset = index * bits;
  const byteOffset = bitOffset >>> 3;
  const shift = bitOffset & 7;
  const bytesNeeded = Math.ceil((shift + bits) / 8);
  let combined = 0;
  for (let b = 0; b < bytesNeeded; b++) {
    combined |= (cells[byteOffset + b] ?? 0) << (b * 8);
  }
  return (combined >>> shift) & maskFor(bits);
}

/** Write a packed palette index at a local cell index. */
export function writeCell(cells: Uint8Array, bits: number, index: number, value: number): void {
  const bitOffset = index * bits;
  const byteOffset = bitOffset >>> 3;
  const shift = bitOffset & 7;
  const bytesNeeded = Math.ceil((shift + bits) / 8);
  const mask = maskFor(bits);
  let combined = 0;
  for (let b = 0; b < bytesNeeded; b++) {
    combined |= (cells[byteOffset + b] ?? 0) << (b * 8);
  }
  combined = (combined & ~(mask << shift)) | ((value & mask) << shift);
  for (let b = 0; b < bytesNeeded; b++) {
    cells[byteOffset + b] = (combined >>> (b * 8)) & 0xff;
  }
}

/** Re-pack a cell stream from `oldBits` to `newBits`, preserving every value. */
export function repack(cells: Uint8Array, oldBits: number, newBits: number): Uint8Array {
  const next = new Uint8Array(Math.ceil((SECTION_CELL_COUNT * newBits) / 8));
  for (let i = 0; i < SECTION_CELL_COUNT; i++) {
    writeCell(next, newBits, i, readCell(cells, oldBits, i));
  }
  return next;
}

/** Read a single bit from a 4096-bit (512-byte) bitmap. */
export function getBit(bytes: Uint8Array, index: number): boolean {
  return ((bytes[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

/** Set a single bit in a 4096-bit (512-byte) bitmap. */
export function setBit(bytes: Uint8Array, index: number, value: boolean): void {
  const byteIndex = index >>> 3;
  const mask = 1 << (index & 7);
  if (value) {
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | mask;
  } else {
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) & ~mask;
  }
}

/** Allocate a fresh, empty Section with air reserved at palette index 0. */
export function createSection(key: SectionKey): Section {
  const bitmapBytes = SECTION_CELL_COUNT / 8; // 512
  return {
    key,
    palette: [AIR_BLOCK_NAME],
    cells: new Uint8Array(bitmapBytes), // 1 bit × 4096 = 512 bytes
    bits: 1,
    explored: new Uint8Array(bitmapBytes),
    traversed: new Uint8Array(bitmapBytes),
    stale: new Uint8Array(bitmapBytes),
    risk: new Uint8Array(bitmapBytes),
    modified: new Uint8Array(bitmapBytes),
    evidence: new Map(),
    revision: 0,
  };
}
