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

/**
 * Re-pack a cell stream through a palette-slot mapping. Every local cell is
 * read at `oldBits` and written at `newBits`; slots the mapping does not cover
 * (including values outside the old palette) become palette index 0. The
 * `explored` bits are untouched, so an unmapped unknown cell stays unknown.
 */
export function remapCells(
  cells: Uint8Array,
  oldBits: number,
  newBits: number,
  mapping: readonly number[],
): Uint8Array {
  const next = new Uint8Array(Math.ceil((SECTION_CELL_COUNT * newBits) / 8));
  for (let i = 0; i < SECTION_CELL_COUNT; i++) {
    writeCell(next, newBits, i, mapping[readCell(cells, oldBits, i)] ?? 0);
  }
  return next;
}

/** Resident-byte costs the allocator uses to report its incremental deltas. */
export interface PaletteByteCosts {
  entryBytes: (state: string) => number;
  packedCellsBytes: (bits: number) => number;
}

export interface PaletteRetainResult {
  slot: number;
  /** Bit width after this change (grows when the palette crosses a width boundary). */
  bits: number;
  /** Byte delta from palette entry and packing changes only. */
  growth: number;
}

/** A bounded palette compaction of one Section, computed but not yet applied. */
export interface PaletteCompactionPlan {
  /** Old slot → new slot; unreferenced slots map to 0. */
  mapping: number[];
  palette: string[];
  bits: number;
}

/**
 * Amortization thresholds for a compaction that would not shrink the packing
 * width. One full 4096-cell remap is only paid once enough unreferenced slots
 * or dead-entry bytes have accumulated to justify it. This keeps the dead
 * palette footprint per Section below the byte threshold (or below the slot
 * threshold when entries are tiny) instead of retaining a single huge string
 * forever at minimum width.
 */
const COMPACTION_DEAD_SLOT_THRESHOLD = 32;
const COMPACTION_DEAD_BYTE_THRESHOLD = 4_096;

/**
 * Per-Section palette reference accounting: which slots observed cells point
 * at, which entries are unreferenced, and which can be reused.
 *
 * Slot 0 is permanently reserved for air. A live state change releases its old
 * slot and reuses an unreferenced one when possible, so fixed-space churn does
 * not append a new string per observed state. Completely unreferenced entries
 * are dropped by `compactionPlan`/`commitCompaction`, which always shrink the
 * packing width when possible and otherwise run once the dead-slot or dead-byte
 * thresholds amortize the remap. That path scans one Section's cell stream and
 * is therefore called at most once per accepted batch, never per refresh.
 *
 * The live map caches one instance per resident Section. `fromSection` aliases
 * `section.palette` so in-place allocation is immediately visible; callers that
 * only simulate (capacity pre-flight) must use `clone()`.
 */
export class PaletteRetention {
  /** Slot 0 is air; this is the live array backing `Section.palette` in the write path. */
  palette: string[];
  private indices: Map<string, number>;
  private refs: number[];
  private readonly freeSlots = new Set<number>();
  /** Running sum of referenced-by-nothing entry costs, used for amortization. */
  private deadBytes = 0;

  private constructor(
    palette: string[],
    indices: Map<string, number>,
    refs: number[],
    freeSlots: Iterable<number>,
    deadBytes: number,
  ) {
    this.palette = palette;
    this.indices = indices;
    this.refs = refs;
    this.deadBytes = deadBytes;
    for (const slot of freeSlots) this.freeSlots.add(slot);
  }

  /** A fresh Section's palette state: air at slot 0, nothing referenced. */
  static empty(): PaletteRetention {
    return new PaletteRetention([AIR_BLOCK_NAME], new Map([[AIR_BLOCK_NAME, 0]]), [0], [], 0);
  }

  /**
   * Count references from the cells that actually carry evidence. Unexplored
   * cells are unknown, not observed air, so their packed values never keep a
   * string alive. Aliases `section.palette` for the live write path.
   */
  static fromSection(section: Section, costs: PaletteByteCosts): PaletteRetention {
    const refs = new Array<number>(section.palette.length).fill(0);
    for (const index of section.evidence.keys()) {
      const slot = readCell(section.cells, section.bits, index);
      if (slot < refs.length) refs[slot] = (refs[slot] ?? 0) + 1;
    }
    const freeSlots: number[] = [];
    let deadBytes = 0;
    for (let slot = 1; slot < refs.length; slot++) {
      if (refs[slot] === 0) {
        freeSlots.push(slot);
        deadBytes += costs.entryBytes(section.palette[slot]!);
      }
    }
    return new PaletteRetention(
      section.palette,
      new Map(section.palette.map((state, index) => [state, index])),
      refs,
      freeSlots,
      deadBytes,
    );
  }

  /** Independent copy for capacity simulation; never shares the live arrays. */
  clone(): PaletteRetention {
    return new PaletteRetention(
      [...this.palette],
      new Map(this.indices),
      [...this.refs],
      this.freeSlots,
      this.deadBytes,
    );
  }

  /**
   * Release the slot an observed cell used to point at, then retain `state`.
   * Reuses an unreferenced slot when the state is not already present, so the
   * palette length is bounded by the peak number of simultaneously referenced
   * states rather than by the total number of states ever observed.
   */
  retainState(
    state: string,
    bits: number,
    releaseSlot: number | undefined,
    costs: PaletteByteCosts,
  ): PaletteRetainResult {
    if (releaseSlot !== undefined) {
      if (releaseSlot === 0) {
        this.refs[0] = Math.max(0, (this.refs[0] ?? 0) - 1);
      } else {
        const count = this.refs[releaseSlot];
        if (count !== undefined && count > 0) {
          this.refs[releaseSlot] = count - 1;
          if (count === 1) {
            this.freeSlots.add(releaseSlot);
            this.deadBytes += costs.entryBytes(this.palette[releaseSlot]!);
          }
        }
      }
    }

    let growth = 0;
    const existing = this.indices.get(state);
    let slot: number;
    if (existing !== undefined) {
      // A state that was released earlier in this batch can still be indexed;
      // it must leave the free set before its reference count rises again.
      if (this.freeSlots.delete(existing)) {
        this.deadBytes -= costs.entryBytes(this.palette[existing]!);
      }
      this.refs[existing] = (this.refs[existing] ?? 0) + 1;
      slot = existing;
    } else if (this.freeSlots.size > 0) {
      const reusable = this.freeSlots.values().next().value!;
      this.freeSlots.delete(reusable);
      const evicted = this.palette[reusable]!;
      this.deadBytes -= costs.entryBytes(evicted);
      this.indices.delete(evicted);
      this.palette[reusable] = state;
      this.indices.set(state, reusable);
      this.refs[reusable] = 1;
      slot = reusable;
      growth = costs.entryBytes(state) - costs.entryBytes(evicted);
    } else {
      slot = this.palette.length;
      this.palette.push(state);
      this.refs.push(1);
      this.indices.set(state, slot);
      growth = costs.entryBytes(state) + 1;
    }

    const nextBits = bitsRequired(this.palette.length);
    if (nextBits !== bits) {
      growth += costs.packedCellsBytes(nextBits) - costs.packedCellsBytes(bits);
    }
    return { slot, bits: nextBits, growth };
  }

  /**
   * Plan dropping every unreferenced slot. A packing-width reduction is always
   * taken; at minimum width a compaction requires either enough dead slots or
   * enough dead-entry bytes to amortize one 4096-cell remap. After a checked
   * write the retained dead footprint is therefore bounded by those thresholds.
   */
  compactionPlan(bits: number): PaletteCompactionPlan | null {
    if (this.freeSlots.size === 0) return null;
    // Every unreferenced non-zero slot is in `freeSlots`, so this is live+1.
    const paletteLength = this.palette.length - this.freeSlots.size;
    const nextBits = bitsRequired(paletteLength);
    const shrinksPacking = nextBits < bits;
    if (
      !shrinksPacking &&
      this.freeSlots.size < COMPACTION_DEAD_SLOT_THRESHOLD &&
      this.deadBytes < COMPACTION_DEAD_BYTE_THRESHOLD
    ) {
      return null;
    }

    const mapping = new Array<number>(this.palette.length).fill(0);
    const palette: string[] = [this.palette[0]!];
    for (let slot = 1; slot < this.refs.length; slot++) {
      if ((this.refs[slot] ?? 0) <= 0) continue;
      mapping[slot] = palette.length;
      palette.push(this.palette[slot]!);
    }
    return { mapping, palette, bits: nextBits };
  }

  /** Publish a compaction plan. The caller must remap its cell stream with `mapping`. */
  commitCompaction(plan: PaletteCompactionPlan): void {
    const refs = new Array<number>(plan.palette.length).fill(0);
    refs[0] = this.refs[0] ?? 0;
    for (let slot = 1; slot < this.refs.length; slot++) {
      const target = plan.mapping[slot]!;
      if (target !== 0) refs[target] = this.refs[slot]!;
    }
    this.palette = plan.palette;
    this.indices = new Map(plan.palette.map((state, index) => [state, index]));
    this.refs = refs;
    this.freeSlots.clear();
    this.deadBytes = 0;
  }
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
