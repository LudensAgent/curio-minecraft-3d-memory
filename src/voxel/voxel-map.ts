/**
 * In-memory observation map (design §4, §6.2).
 *
 * `VoxelMap` is the sparse in-memory voxel store: it ingests confirmed
 * `Observation`s, keeps per-cell evidence with session/sequence ordering, and
 * returns a localized change report so a future traversability cache can
 * invalidate only the affected sections. It is bound to one immutable `worldId`;
 * coordinate queries take an explicit `dim`.
 *
 * Facts can only change through the controlled update path. Observations are
 * snapshotted on write, `cellAt` and `sectionAt` return snapshots, and change
 * reports never alias the store's internal objects (including the section key).
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

/** What one accepted update did to its cell. */
export type CellChangeKind = 'inserted' | 'changed' | 'refreshed' | 'staled' | 'restored';

export interface CellChange {
  pos: Vec3Like;
  kind: CellChangeKind;
}

export interface SectionChange {
  key: SectionKey;
  /** Section revision after this change. */
  revision: number;
  /** True when revision advanced (inserted/changed/staled/restored); false for refresh-only. */
  invalidated: boolean;
  cells: CellChange[];
}

export interface ChangeReport {
  /** Affected sections, in first-touch order. Empty when nothing changed. */
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
  /**
   * Clock used to stamp interruption boundaries. Must return values comparable to
   * an observation's `observedAt`. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** Read-only view of one cell. `observed: false` means never observed (UNKNOWN). */
export type CellView =
  | { observed: false }
  | { observed: true; evidence: CellEvidence };

/** Reason a cell's evidence was marked stale (lifecycle / interruption). */
export type StaleReason = NonNullable<CellEvidence['staleReason']>;

const DEFAULT_VALIDITY_WINDOW_MS = 60_000;

type AppliedCell = { section: Section; kind: CellChangeKind; x: number; y: number; z: number };

export class VoxelMap {
  readonly worldId: string;
  private readonly sections = new Map<string, Map<string, Section>>();
  private readonly validityWindowMs: number;
  private readonly now: () => number;
  private readonly staleBoundaries = new Map<string, number>();
  private currentSessionId: string | null = null;

  constructor(worldId: string, options: VoxelMapOptions = {}) {
    this.worldId = worldId;
    this.validityWindowMs = options.validityWindowMs ?? DEFAULT_VALIDITY_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Begin (or switch to) an observation session. Cells last confirmed by a
   * different session become STALE (validity change → revision bump + stale bit)
   * and are reported. Idempotent for the already-active session.
   */
  beginSession(sessionId: string): ChangeReport {
    if (sessionId === this.currentSessionId) return { sections: [] };
    const previous = this.currentSessionId;
    this.currentSessionId = sessionId;
    if (previous === null) return { sections: [] };

    const bySection = new Map<Section, SectionChange>();
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        this.markSectionCellsStale(
          section,
          (evidence) => evidence.observation.sessionId !== sessionId,
          'observation_gap',
          bySection,
        );
      }
    }
    return { sections: [...bySection.values()] };
  }

  /**
   * Mark all FRESH cells in a dimension STALE after an interruption (disconnect,
   * pause, or unload). Records an interruption boundary so that only evidence
   * acquired after it can restore the cells. Per-chunk unload granularity is
   * deferred; this round invalidates at dimension scope.
   */
  markStale(dim: string, reason: StaleReason): ChangeReport {
    const dimMap = this.sections.get(dim);
    if (dimMap === undefined) return { sections: [] };
    this.staleBoundaries.set(dim, this.now());

    const bySection = new Map<Section, SectionChange>();
    for (const section of dimMap.values()) {
      this.markSectionCellsStale(section, () => true, reason, bySection);
    }
    return { sections: [...bySection.values()] };
  }

  /** Accept one confirmed observation and return its localized change (or empty). */
  observe(observation: Observation): ChangeReport {
    validateObservation(this.worldId, observation);
    const applied = this.applyValidated(observation);
    if (applied === null) return { sections: [] };
    return {
      sections: [
        {
          key: { ...applied.section.key },
          revision: applied.section.revision,
          invalidated: applied.kind !== 'refreshed',
          cells: [{ pos: { x: applied.x, y: applied.y, z: applied.z }, kind: applied.kind }],
        },
      ],
    };
  }

  /**
   * Accept a batch; only the confirmed observations are written, gaps are not
   * cells. The whole batch is validated up front so an invalid observation does
   * not leave behind a half-applied batch.
   */
  observeBatch(batch: ObservationBatch): ChangeReport {
    for (const observation of batch.observations) {
      validateObservation(this.worldId, observation);
    }
    const bySection = new Map<Section, SectionChange>();
    for (const observation of batch.observations) {
      const applied = this.applyValidated(observation);
      if (applied === null) continue;
      addChange(bySection, applied.section, {
        pos: { x: applied.x, y: applied.y, z: applied.z },
        kind: applied.kind,
      });
    }
    return { sections: [...bySection.values()] };
  }

  /** Read the current cell state; never mutates, scans, or refreshes evidence time/version. */
  cellAt(dim: string, x: number, y: number, z: number): CellView {
    assertIntegerCoords(x, y, z);
    const section = this.lookupSection(dim, x, y, z);
    if (section === undefined) return { observed: false };
    const { lx, ly, lz } = blockToSection(x, y, z);
    const evidence = section.evidence.get(cellIndex(lx, ly, lz));
    return evidence === undefined ? { observed: false } : { observed: true, evidence: snapshotEvidence(evidence) };
  }

  /**
   * Snapshot of the section containing (x,y,z) in `dim`, or null when never
   * allocated. The returned section is a copy; mutating it never changes the
   * store. (The future traversability/topology layers read the live sections
   * through internal, non-public access when they land.)
   */
  sectionAt(dim: string, x: number, y: number, z: number): Section | null {
    assertIntegerCoords(x, y, z);
    const section = this.lookupSection(dim, x, y, z);
    return section === undefined ? null : snapshotSection(section);
  }

  // --- internals ---

  private lookupSection(dim: string, x: number, y: number, z: number): Section | undefined {
    const { cx, cz, sy } = blockToSection(x, y, z);
    return this.sections.get(dim)?.get(innerKey(cx, cz, sy));
  }

  private markSectionCellsStale(
    section: Section,
    shouldStale: (evidence: CellEvidence) => boolean,
    reason: StaleReason,
    bySection: Map<Section, SectionChange>,
  ): void {
    for (const [index, evidence] of section.evidence) {
      if (evidence.freshness === 'STALE') continue;
      if (!shouldStale(evidence)) continue;
      const pos = { ...evidence.observation.pos };
      section.evidence.set(index, {
        ...evidence,
        freshness: 'STALE',
        staleReason: reason,
        revision: evidence.revision + 1,
      });
      section.revision += 1;
      setBit(section.stale, index, true);
      addChange(bySection, section, { pos, kind: 'staled' });
    }
  }

  private applyValidated(observation: Observation): AppliedCell | null {
    if (this.currentSessionId === null) {
      this.currentSessionId = observation.sessionId;
    } else if (observation.sessionId !== this.currentSessionId) {
      // A foreign or already-superseded session: rejected until `beginSession`.
      return null;
    }

    const { x, y, z } = observation.pos;
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const section = this.getOrCreateSection(observation.dim, cx, cz, sy);
    const index = cellIndex(lx, ly, lz);
    const existing = section.evidence.get(index);

    if (existing !== undefined) {
      if (observation.observedAt <= existing.observation.observedAt) {
        // Not strictly newer by acquisition time (same-session out-of-order or
        // duplicate): never overwrite newer evidence. `sequence` is receive
        // order, not acquisition order, so it must not decide this.
        return null;
      }
      if (existing.freshness === 'STALE' && observation.observedAt <= this.boundaryFor(observation.dim)) {
        // Acquired before the interruption that made this cell stale: it cannot
        // restore staleness; only post-interruption evidence can.
        return null;
      }
    }

    const validUntil = observation.observedAt + this.validityWindowMs;
    const serialized = serializeBlockState(observation.state);

    if (existing !== undefined) {
      const sameContent =
        serializeBlockState(existing.observation.state) === serialized &&
        existing.observation.stateComplete === observation.stateComplete;

      if (sameContent && existing.freshness === 'FRESH') {
        // Re-confirmation of the same content while still fresh: refresh only.
        section.evidence.set(index, {
          revision: existing.revision,
          observation: snapshotObservation(observation),
          freshness: 'FRESH',
          staleReason: undefined,
          validUntil,
        });
        this.touch(section, observation.observedAt);
        return { section, kind: 'refreshed', x, y, z };
      }

      // Content changed, or recovering from STALE — both advance validity.
      const kind = sameContent ? 'restored' : 'changed';
      section.evidence.set(index, {
        revision: existing.revision + 1,
        observation: snapshotObservation(observation),
        freshness: 'FRESH',
        staleReason: undefined,
        validUntil,
      });
      section.revision += 1;
      setBit(section.stale, index, false);
      if (!sameContent) {
        this.writePalette(section, index, serialized);
      }
      this.touch(section, observation.observedAt);
      return { section, kind, x, y, z };
    }

    // First observation of this cell.
    section.evidence.set(index, {
      revision: 1,
      observation: snapshotObservation(observation),
      freshness: 'FRESH',
      staleReason: undefined,
      validUntil,
    });
    section.revision += 1;
    setBit(section.explored, index, true);
    this.writePalette(section, index, serialized);
    this.touch(section, observation.observedAt);
    return { section, kind: 'inserted', x, y, z };
  }

  private boundaryFor(dim: string): number {
    return this.staleBoundaries.get(dim) ?? Number.NEGATIVE_INFINITY;
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

function addChange(
  bySection: Map<Section, SectionChange>,
  section: Section,
  cell: CellChange,
): void {
  const invalidated = cell.kind !== 'refreshed';
  const entry = bySection.get(section);
  if (entry === undefined) {
    bySection.set(section, {
      key: { ...section.key },
      revision: section.revision,
      invalidated,
      cells: [cell],
    });
  } else {
    entry.revision = section.revision;
    entry.invalidated = entry.invalidated || invalidated;
    entry.cells.push(cell);
  }
}

/** Key for a section inside one dimension; integers make commas an unambiguous separator. */
function innerKey(cx: number, cz: number, sy: number): string {
  return `${cx},${cz},${sy}`;
}

/** Deep-copy an observation so the store never aliases caller-owned objects. */
function snapshotObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { x: observation.pos.x, y: observation.pos.y, z: observation.pos.z },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

/** Deep-copy evidence so a read view cannot mutate the store. */
function snapshotEvidence(evidence: CellEvidence): CellEvidence {
  return { ...evidence, observation: snapshotObservation(evidence.observation) };
}

/** Deep-copy a section so a public read cannot mutate the store. */
function snapshotSection(section: Section): Section {
  return {
    key: { ...section.key },
    palette: [...section.palette],
    cells: section.cells.slice(),
    bits: section.bits,
    explored: section.explored.slice(),
    traversed: section.traversed.slice(),
    stale: section.stale.slice(),
    risk: section.risk.slice(),
    modified: section.modified.slice(),
    evidence: new Map(
      [...section.evidence].map(([index, evidence]) => [index, snapshotEvidence(evidence)]),
    ),
    revision: section.revision,
    lastObservedAt: section.lastObservedAt,
  };
}

function validateObservation(worldId: string, observation: Observation): void {
  if (observation.worldId !== worldId) {
    throw new Error(
      `observation worldId "${observation.worldId}" does not match map worldId "${worldId}"`,
    );
  }
  assertIntegerCoords(observation.pos.x, observation.pos.y, observation.pos.z);
}

function assertIntegerCoords(x: number, y: number, z: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new Error(`coordinates must be integer grid coordinates: (${x}, ${y}, ${z})`);
  }
}
