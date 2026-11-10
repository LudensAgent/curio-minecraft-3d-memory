/**
 * Manual on-demand Section residency (design §9.2, phase 5D1).
 *
 * In the default ("eager") loading mode a `VoxelMap` keeps every persisted
 * section resident in memory. The manual mode splits "what is committed on disk"
 * from "what is currently resident in memory" so a large committed fact set does
 * not have to be fully decoded at open time. These are the public types and
 * bounded defaults for that split — the residency state itself lives on
 * `VoxelMap`, which owns the resident section set and the write path that must
 * refuse writes to saved-but-not-resident sections.
 */

import type { SectionKey } from './section.js';

/** Lifecycle state of one section relative to the current working set. */
export type SectionResidency = 'no_record' | 'not_resident' | 'loading' | 'resident' | 'load_failed';

/** The committed (on-disk) record for one section, when one exists. */
export interface CommittedSectionInfo {
  /** Section revision at the last confirmed checkpoint. */
  revision: number;
  /** Committed payload size in bytes (`octet_length` of the stored JSON). */
  bytes: number;
  /** Observed cells in the committed payload. */
  observedCells: number;
  /** Palette entries in the committed payload. */
  paletteEntries: number;
}

/** Residency of one section plus its committed record, when one exists. */
export interface SectionResidencyInfo {
  residency: SectionResidency;
  /** Present when the section has a committed record (resident or not). */
  committed?: CommittedSectionInfo;
}

/** One entry of the committed section directory read at open (no payload decode). */
export interface VoxelDirectoryEntry {
  key: SectionKey;
  /** Stable insertion order within the world. */
  seq: number;
  /** Committed payload size in bytes. */
  bytes: number;
  observedCells: number;
  paletteEntries: number;
  revision: number;
}

/** The bounded committed section directory returned at manual-mode open. */
export interface VoxelDirectory {
  worldId: string;
  sections: VoxelDirectoryEntry[];
}

/** One stable page over the committed directory; `nextAfter` is an opaque seq cursor. */
export interface VoxelDirectoryPage {
  items: VoxelDirectoryEntry[];
  nextAfter?: number;
}

/**
 * Aggregate metadata of the committed directory. Manual startup installs this
 * plus the exact committed key set, never every per-section metadata entry.
 */
export interface VoxelDirectorySummary {
  sections: number;
  observedCells: number;
  paletteEntries: number;
  bytes: number;
  /** Highest stable seq, or -1 when the directory is empty. */
  maxSeq: number;
}

/** Why an unload was refused for a resident section. */
export type UnloadRejectionReason = 'pinned' | 'dirty' | 'not_committed';

/** Result of `unloadSections`: which sections were released and why the rest were kept. */
export interface UnloadSectionsResult {
  unloaded: SectionKey[];
  rejected: { key: SectionKey; reason: UnloadRejectionReason }[];
}

/** A bounded, caller-managed protection lease over a set of sections. */
export interface PinLease {
  /** Unique lease token; pass to `releasePins` to drop exactly this lease. */
  token: string;
  keys: SectionKey[];
}

/** Bounded working-set limits for the manual residency mode. */
export interface ResidencyLimits {
  /** Maximum resident sections (in-memory working set). Default 1000. */
  maxResidentSections?: number;
  /** Maximum resident working set in estimated bytes. Default 32 MiB. */
  maxResidentBytes?: number;
  /** Maximum sections requested in one `loadSections` batch. Default 256. */
  maxLoadBatchSections?: number;
  /** Maximum concurrent pin leases. Default 1024. */
  maxPins?: number;
  /** Maximum distinct sections covered by all leases. Default 10000. */
  maxPinnedSections?: number;
}

/** `ResidencyLimits` with every default resolved and validated. */
export interface ResolvedResidencyLimits {
  maxResidentSections: number;
  maxResidentBytes: number;
  maxLoadBatchSections: number;
  maxPins: number;
  maxPinnedSections: number;
}

export const DEFAULT_RESIDENCY_LIMITS: ResolvedResidencyLimits = {
  maxResidentSections: 1000,
  maxResidentBytes: 32 * 1024 * 1024,
  maxLoadBatchSections: 256,
  maxPins: 1024,
  maxPinnedSections: 10_000,
};

/** Resolve the optional residency limits with every default filled and validated. */
export function resolveResidencyLimits(options: ResidencyLimits | undefined): ResolvedResidencyLimits {
  const limits: ResolvedResidencyLimits = { ...DEFAULT_RESIDENCY_LIMITS };
  if (options === undefined) return limits;
  const keys = [
    'maxResidentSections',
    'maxResidentBytes',
    'maxLoadBatchSections',
    'maxPins',
    'maxPinnedSections',
  ] as const;
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive safe integer: ${String(value)}`);
    }
    limits[key] = value;
  }
  return limits;
}

/**
 * A write was rejected because it targeted sections that are committed on disk
 * but not currently resident (or currently loading). The caller must load them
 * explicitly and re-submit with the original observation time.
 */
export class VoxelResidencyError extends Error {
  readonly code = 'requires_load' as const;
  readonly keys: SectionKey[];

  constructor(keys: SectionKey[]) {
    const list = keys
      .map((k) => `(${k.dim}, ${k.cx}, ${k.cz}, ${k.sy})`)
      .join(', ');
    super(`sections require an explicit load before observation: ${list}`);
    this.name = 'VoxelResidencyError';
    this.keys = keys.map((k) => ({ ...k }));
  }
}
