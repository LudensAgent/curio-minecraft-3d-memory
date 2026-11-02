/**
 * In-memory observation map (design §4, §6.2).
 *
 * `VoxelMap` is the sparse in-memory voxel store: it ingests confirmed
 * `Observation`s, keeps per-cell evidence with session/sequence ordering, and
 * returns a localized change report so a future traversability cache can
 * invalidate only the affected sections. It is bound to one immutable `worldId`;
 * coordinate queries take an explicit `dim`.
 *
 * This is deliberately *not* the full `SpatialMemoryStore`: routing, topology,
 * frontiers and persistence are composed beside it later, so none of their
 * methods appear here as fake-success stubs.
 */

import type { CellEvidence, Observation, ObservationBatch } from '../observation/types.js';
import type { Vec3Like } from '../types.js';
import { serializeBlockState } from './blockstate.js';
import { blockToSection, cellIndex } from './coordinates.js';
import { bitsRequired, createSection, repack, setBit, writeCell } from './palette.js';
import type { Section, SectionKey } from './section.js';

/** What one accepted observation did to its cell. */
export type CellChangeKind = 'inserted' | 'changed' | 'refreshed';

export interface CellChange {
  pos: Vec3Like;
  kind: CellChangeKind;
}

export interface SectionChange {
  key: SectionKey;
  /** Section revision after this change. */
  revision: number;
  /** True when at least one cell was inserted or changed (revision advanced). */
  contentChanged: boolean;
  cells: CellChange[];
}

export interface ChangeReport {
  /** Affected sections, in first-touch order. Empty when nothing changed (e.g. stale re-delivery). */
  sections: SectionChange[];
}

export interface VoxelMapOptions {
  /**
   * Ceiling on evidence reuse (ms): `validUntil = observedAt + validityWindowMs`.
   * This is a freshness ceiling, not a danger threshold, and this round does not
   * auto-flip cells to STALE (there is no scheduler). Defaults to 60s; override to
   * fit the host's perception cadence.
   */
  validityWindowMs?: number;
}

/** Read-only view of one cell. `observed: false` means never observed (UNKNOWN). */
export type CellView =
  | { observed: false }
  | { observed: true; evidence: CellEvidence };

const DEFAULT_VALIDITY_WINDOW_MS = 60_000;

type AppliedCell = { section: Section; pos: Vec3Like; kind: CellChangeKind };

export class VoxelMap {
  readonly worldId: string;
  private readonly sections = new Map<string, Map<string, Section>>();
  private readonly validityWindowMs: number;

  constructor(worldId: string, options: VoxelMapOptions = {}) {
    this.worldId = worldId;
    this.validityWindowMs = options.validityWindowMs ?? DEFAULT_VALIDITY_WINDOW_MS;
  }

  /** Accept one confirmed observation and return its localized change (or empty). */
  observe(observation: Observation): ChangeReport {
    const applied = this.apply(observation);
    if (applied === null) return { sections: [] };
    return {
      sections: [
        {
          key: applied.section.key,
          revision: applied.section.revision,
          contentChanged: applied.kind !== 'refreshed',
          cells: [{ pos: applied.pos, kind: applied.kind }],
        },
      ],
    };
  }

  /** Accept a batch; only the confirmed observations are written, gaps are not cells. */
  observeBatch(batch: ObservationBatch): ChangeReport {
    const bySection = new Map<Section, SectionChange>();
    for (const observation of batch.observations) {
      const applied = this.apply(observation);
      if (applied === null) continue;
      const entry = bySection.get(applied.section);
      if (entry === undefined) {
        bySection.set(applied.section, {
          key: applied.section.key,
          revision: applied.section.revision,
          contentChanged: applied.kind !== 'refreshed',
          cells: [{ pos: applied.pos, kind: applied.kind }],
        });
      } else {
        entry.revision = applied.section.revision;
        entry.contentChanged = entry.contentChanged || applied.kind !== 'refreshed';
        entry.cells.push({ pos: applied.pos, kind: applied.kind });
      }
    }
    return { sections: [...bySection.values()] };
  }

  /** Read the current cell state; never mutates, scans, or refreshes evidence time/version. */
  cellAt(dim: string, x: number, y: number, z: number): CellView {
    const section = this.lookupSection(dim, x, y, z);
    if (section === undefined) return { observed: false };
    const { lx, ly, lz } = blockToSection(x, y, z);
    const evidence = section.evidence.get(cellIndex(lx, ly, lz));
    return evidence === undefined ? { observed: false } : { observed: true, evidence };
  }

  /** Return the section containing (x,y,z) in `dim`, or null when never allocated. */
  sectionAt(dim: string, x: number, y: number, z: number): Section | null {
    return this.lookupSection(dim, x, y, z) ?? null;
  }

  // --- internals ---

  private lookupSection(dim: string, x: number, y: number, z: number): Section | undefined {
    const { cx, cz, sy } = blockToSection(x, y, z);
    return this.sections.get(dim)?.get(innerKey(cx, cz, sy));
  }

  private apply(observation: Observation): AppliedCell | null {
    validateObservation(this.worldId, observation);

    const { x, y, z } = observation.pos;
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const section = this.getOrCreateSection(observation.dim, cx, cz, sy);
    const index = cellIndex(lx, ly, lz);
    const existing = section.evidence.get(index);

    if (existing !== undefined && !isNewer(observation, existing.observation)) {
      // Stale re-delivery or an older session: never let old evidence overwrite new.
      return null;
    }

    const validUntil = observation.observedAt + this.validityWindowMs;
    const serialized = serializeBlockState(observation.state);

    if (existing !== undefined) {
      const sameContent =
        serializeBlockState(existing.observation.state) === serialized &&
        existing.observation.stateComplete === observation.stateComplete;

      if (sameContent) {
        // Re-confirmation of the same content: refresh evidence time, keep revision.
        section.evidence.set(index, {
          revision: existing.revision,
          observation,
          freshness: 'FRESH',
          staleReason: undefined,
          validUntil,
        });
        this.touch(section, observation.observedAt);
        return { section, pos: observation.pos, kind: 'refreshed' };
      }

      // Content or completeness changed.
      section.evidence.set(index, {
        revision: existing.revision + 1,
        observation,
        freshness: 'FRESH',
        staleReason: undefined,
        validUntil,
      });
      section.revision += 1;
      this.writePalette(section, index, serialized);
      this.touch(section, observation.observedAt);
      return { section, pos: observation.pos, kind: 'changed' };
    }

    // First observation of this cell.
    section.evidence.set(index, {
      revision: 1,
      observation,
      freshness: 'FRESH',
      staleReason: undefined,
      validUntil,
    });
    section.revision += 1;
    setBit(section.explored, index, true);
    this.writePalette(section, index, serialized);
    this.touch(section, observation.observedAt);
    return { section, pos: observation.pos, kind: 'inserted' };
  }

  private getOrCreateSection(dim: string, cx: number, cz: number, sy: number): Section {
    const key: SectionKey = { worldId: this.worldId, dim, cx, cz, sy };
    let dimMap = this.sections.get(dim);
    if (dimMap === undefined) {
      dimMap = new Map();
      this.sections.set(dim, dimMap);
    }
    const keyString = innerKey(cx, cz, sy);
    const existing = dimMap.get(keyString);
    if (existing !== undefined) return existing;
    const section = createSection(key);
    dimMap.set(keyString, section);
    return section;
  }

  /** Store a palette index for the cell, growing the palette and re-packing as needed. */
  private writePalette(section: Section, index: number, serialized: string): void {
    let paletteIndex = section.palette.indexOf(serialized);
    if (paletteIndex === -1) {
      paletteIndex = section.palette.length;
      section.palette.push(serialized);
      const newBits = bitsRequired(section.palette.length);
      if (newBits !== section.bits) {
        section.cells = repack(section.cells, section.bits, newBits);
        section.bits = newBits;
      }
    }
    writeCell(section.cells, section.bits, index, paletteIndex);
  }

  /** Statistics-only last-observation time; never proof the whole section is fresh. */
  private touch(section: Section, observedAt: number): void {
    section.lastObservedAt = Math.max(section.lastObservedAt ?? Number.NEGATIVE_INFINITY, observedAt);
  }
}

/** Key for a section inside one dimension; integers make commas an unambiguous separator. */
function innerKey(cx: number, cz: number, sy: number): string {
  return `${cx},${cz},${sy}`;
}

/** True when `next` supersedes `current` for the same cell. */
function isNewer(next: Observation, current: Observation): boolean {
  if (next.sessionId === current.sessionId) {
    // Same session: the boundary's receive sequence is authoritative.
    return next.sequence > current.sequence;
  }
  // Different session: real acquisition time orders them (real time is monotonic
  // across sessions; a clock going backwards would be a host bug).
  return next.observedAt >= current.observedAt;
}

function validateObservation(worldId: string, observation: Observation): void {
  if (observation.worldId !== worldId) {
    throw new Error(
      `observation worldId "${observation.worldId}" does not match map worldId "${worldId}"`,
    );
  }
  const { x, y, z } = observation.pos;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new Error(`observation position must be integer grid coordinates: (${x}, ${y}, ${z})`);
  }
}
