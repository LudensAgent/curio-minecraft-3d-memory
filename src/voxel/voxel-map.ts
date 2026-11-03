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
import {
  cloneCellEvidence,
  cloneObservation,
  estimateVoxelSectionBytes,
  restoreVoxelSection,
  snapshotVoxelSection,
  voxelSectionLowerBound,
} from './snapshot.js';
import type {
  VoxelCheckpointCounts,
  VoxelCheckpointMeasure,
  VoxelCheckpointSnapshot,
  VoxelDirtyMeasure,
  VoxelSectionSnapshot,
} from './snapshot.js';

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
  /**
   * Require an explicit `beginSession(sessionId)` before any observation is
   * accepted, instead of auto-activating the first observation's session. The
   * combined spatial session sets this so a restored map (whose saved evidence is
   * all STALE) can never have a late old-session observation silently become the
   * current session and re-mark cells FRESH. Defaults to false.
   */
  requireSession?: boolean;
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
  private readonly requireSession: boolean;
  private readonly staleBoundaries = new Map<string, number>();
  private currentSessionId: string | null = null;
  /**
   * Session-local persistence revision, bumped by every accepted update that
   * changes a fact the next checkpoint would persist — including refresh-only
   * updates that advance evidence time/validity without bumping `Section.revision`.
   * Not a time, observation number, or traversal count.
   */
  private saveRevisionCount = 0;
  /**
   * Sections changed since the last confirmed save, keyed by the live `Section`
   * object with the `saveRevision` at which it was last changed. A section is
   * pending whenever its recorded revision leads the last confirmed save. This is
   * independent of `Section.revision`: a refresh-only update advances the save
   * revision (and thus the pending entry) without advancing the section revision.
   */
  private readonly pendingSections = new Map<Section, number>();

  constructor(worldId: string, options: VoxelMapOptions = {}) {
    this.worldId = worldId;
    const validityWindowMs = options.validityWindowMs ?? DEFAULT_VALIDITY_WINDOW_MS;
    if (!Number.isFinite(validityWindowMs)) {
      throw new Error(`validityWindowMs must be a finite number: ${validityWindowMs}`);
    }
    this.validityWindowMs = validityWindowMs;
    this.now = options.now ?? Date.now;
    this.requireSession = options.requireSession ?? false;
  }

  /** Current persistence revision (see `saveRevisionCount`). */
  get saveRevision(): number {
    return this.saveRevisionCount;
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
    const boundary = this.now();
    if (!Number.isFinite(boundary)) {
      throw new Error(`now() must return a finite number: ${boundary}`);
    }
    // Record the boundary even when the dimension has no sections yet, so a
    // delayed pre-interruption observation of a still-unknown cell is rejected.
    this.staleBoundaries.set(dim, boundary);
    const dimMap = this.sections.get(dim);
    if (dimMap === undefined) return { sections: [] };

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
    this.recordSaveChange(applied.section);
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
      this.recordSaveChange(applied.section);
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
    return evidence === undefined ? { observed: false } : { observed: true, evidence: cloneCellEvidence(evidence) };
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

  // --- checkpoint support (phase 5B): bounded export + validated restore ---

  /**
   * Size of the map's full observed state, used by the checkpoint pre-flight to
   * reject over-capacity saves before any copy or message pass. `maxBytes` bounds
   * the work: a cheap lower bound (string `.length`) rejects obviously-over-limit
   * input first, then a full escaped-byte estimate runs with early termination.
   * Read-only; never refreshes evidence time or version.
   */
  checkpointMeasure(maxBytes = Number.POSITIVE_INFINITY): VoxelCheckpointMeasure {
    let sections = 0;
    let observedCells = 0;
    let paletteEntries = 0;
    const all: Section[] = [];
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        sections += 1;
        observedCells += section.evidence.size;
        paletteEntries += section.palette.length;
        all.push(section);
      }
    }

    let lowerBound = 0;
    for (const section of all) lowerBound += voxelSectionLowerBound(section);
    if (lowerBound > maxBytes) {
      return { sections, observedCells, paletteEntries, bytes: lowerBound };
    }

    let bytes = 0;
    for (const section of all) {
      bytes += estimateVoxelSectionBytes(section);
      if (bytes > maxBytes) break;
    }
    return { sections, observedCells, paletteEntries, bytes };
  }

  /**
   * Deep-copied snapshot of the map's full observed state for a checkpoint. The
   * caller owns the returned objects; mutating them never reaches the store.
   */
  checkpointSnapshot(): VoxelCheckpointSnapshot {
    const out: VoxelCheckpointSnapshot['sections'] = [];
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        out.push(snapshotVoxelSection(section));
      }
    }
    return { worldId: this.worldId, sections: out };
  }

  /** Cheap full-map counts (no serialization), for the full-set capacity check. */
  checkpointCounts(): VoxelCheckpointCounts {
    let sections = 0;
    let observedCells = 0;
    let paletteEntries = 0;
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        sections += 1;
        observedCells += section.evidence.size;
        paletteEntries += section.palette.length;
      }
    }
    return { sections, observedCells, paletteEntries };
  }

  /**
   * Conservative escaped-byte estimate of only the pending (dirty) sections — the
   * incremental batch — with a cheap lower-bound early stop. Never re-estimates or
   * re-serializes the unchanged sections, so measuring a small increment does not
   * scan the whole map.
   */
  checkpointDirtyMeasure(maxBytes = Number.POSITIVE_INFINITY): VoxelDirtyMeasure {
    const pending = [...this.pendingSections.keys()];
    let lowerBound = 0;
    for (const section of pending) lowerBound += voxelSectionLowerBound(section);
    if (lowerBound > maxBytes) return { count: pending.length, bytes: lowerBound };

    let bytes = 0;
    for (const section of pending) {
      bytes += estimateVoxelSectionBytes(section);
      if (bytes > maxBytes) break;
    }
    return { count: pending.length, bytes };
  }

  /**
   * Deep-copied snapshots of only the pending sections, in first-dirty order. The
   * caller owns the returned snapshots; mutating them never reaches the store.
   */
  captureDirtySections(): VoxelSectionSnapshot[] {
    return [...this.pendingSections.keys()].map(snapshotVoxelSection);
  }

  /**
   * Confirm that everything changed up to `capturedRevision` has been persisted.
   * A section is cleared only when its latest change is at or before the captured
   * revision; any section re-dirtied (or newly dirtied) after capture stays
   * pending, so a late ACK never clears newer unsaved changes.
   */
  confirmSections(capturedRevision: number): void {
    for (const [section, revision] of this.pendingSections) {
      if (revision <= capturedRevision) this.pendingSections.delete(section);
    }
  }

  /**
   * Narrow, validated restore entry (phase 5B). Rebuilds the map from a previously
   * captured snapshot, re-marking saved `FRESH` evidence as `STALE`. It only
   * accepts a map that has not yet observed anything, so it is the initialization
   * path — never a runtime full-overwrite of an active map. It never replays
   * `observe`, never refreshes observation time, and never fabricates a current
   * observation session.
   */
  restoreSnapshot(snapshot: VoxelCheckpointSnapshot): void {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new Error('voxel checkpoint snapshot must be an object');
    }
    if (snapshot.worldId !== this.worldId) {
      throw new Error(`snapshot worldId "${snapshot.worldId}" does not match map worldId "${this.worldId}"`);
    }
    // Restore is the initialization path only: reject a map that has already been
    // activated (a session started) or that recorded an interruption boundary, even
    // when it has no sections yet. "No sections" alone is not proof it is pristine.
    if (this.sections.size !== 0 || this.currentSessionId !== null || this.staleBoundaries.size !== 0) {
      throw new Error('restoreSnapshot requires a pristine VoxelMap (never activated or observed)');
    }
    if (!Array.isArray(snapshot.sections)) {
      throw new Error('voxel checkpoint snapshot sections must be an array');
    }

    const restored = new Map<string, Map<string, Section>>();
    for (const raw of snapshot.sections) {
      const section = restoreVoxelSection(this.worldId, raw);
      let dimMap = restored.get(raw.dim);
      if (dimMap === undefined) {
        dimMap = new Map();
        restored.set(raw.dim, dimMap);
      }
      const keyString = innerKey(raw.cx, raw.cz, raw.sy);
      if (dimMap.has(keyString)) {
        throw new Error(`duplicate voxel section (${raw.dim}, ${raw.cx}, ${raw.cz}, ${raw.sy}) in snapshot`);
      }
      dimMap.set(keyString, section);
    }

    this.sections.clear();
    for (const [dim, dimMap] of restored) this.sections.set(dim, dimMap);
    this.currentSessionId = null;
    this.staleBoundaries.clear();
    // Restore establishes a clean baseline: nothing is pending, and the confirmed
    // revision is the post-restore revision (set by the session initializer).
    this.pendingSections.clear();
    // Restore is a baseline-establishing mutation (mirrors FragmentStore): only a
    // session initializer, which then sets the confirmed baseline to the
    // post-restore revision, treats it as clean.
    this.saveRevisionCount += 1;
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
      this.recordSaveChange(section);
      addChange(bySection, section, { pos, kind: 'staled' });
    }
  }

  private applyValidated(observation: Observation): AppliedCell | null {
    if (this.currentSessionId === null) {
      if (this.requireSession) {
        // The host must name the current observation session explicitly before any
        // observation is accepted; a late old-session observation must not be able
        // to auto-activate the map and re-mark restored STALE cells FRESH.
        return null;
      }
      this.currentSessionId = observation.sessionId;
    } else if (observation.sessionId !== this.currentSessionId) {
      // A foreign or already-superseded session: rejected until `beginSession`.
      return null;
    }

    if (observation.observedAt <= this.boundaryFor(observation.dim)) {
      // Acquired at or before the latest interruption for this dimension: it
      // predates the interruption and cannot establish current (FRESH) state,
      // for known, stale, or still-unknown cells alike.
      return null;
    }

    const { x, y, z } = observation.pos;
    const { cx, cz, sy, lx, ly, lz } = blockToSection(x, y, z);
    const section = this.getOrCreateSection(observation.dim, cx, cz, sy);
    const index = cellIndex(lx, ly, lz);
    const existing = section.evidence.get(index);

    if (existing !== undefined && observation.observedAt < existing.observation.observedAt) {
      // Genuinely older acquisition (same-session out-of-order): never overwrite
      // newer evidence. `sequence` is receive order, not acquisition order.
      return null;
    }

    const validUntil = observation.observedAt + this.validityWindowMs;
    const serialized = serializeBlockState(observation.state);

    if (existing !== undefined && observation.observedAt === existing.observation.observedAt) {
      const sameContent =
        serializeBlockState(existing.observation.state) === serialized &&
        existing.observation.stateComplete === observation.stateComplete;
      if (sameContent || existing.freshness === 'STALE') {
        // Exact duplicate at the same timestamp, or the cell is already invalid —
        // nothing further to change. Avoids repeated revision bumps for a conflict
        // that has already been recorded.
        return null;
      }
      // Same timestamp, conflicting content: the timestamp carries no uniqueness
      // guarantee, so these cannot be ordered. Invalidate the old conclusion
      // instead of silently keeping it, and report the conflict explicitly.
      section.evidence.set(index, {
        ...existing,
        freshness: 'STALE',
        staleReason: 'conflict',
        revision: existing.revision + 1,
      });
      section.revision += 1;
      setBit(section.stale, index, true);
      return { section, kind: 'staled', x, y, z };
    }

    if (existing !== undefined) {
      const sameContent =
        serializeBlockState(existing.observation.state) === serialized &&
        existing.observation.stateComplete === observation.stateComplete;

      if (sameContent && existing.freshness === 'FRESH') {
        // Re-confirmation of the same content while still fresh: refresh only.
        section.evidence.set(index, {
          revision: existing.revision,
          observation: cloneObservation(observation),
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
        observation: cloneObservation(observation),
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
      observation: cloneObservation(observation),
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

  /**
   * Bump the global save revision and record `section` as pending at the new
   * revision. Called for every accepted update that changes a fact the next
   * checkpoint would persist (including refresh-only updates). Rejected/idempotent
   * input and read-only queries never reach here.
   */
  private recordSaveChange(section: Section): void {
    this.saveRevisionCount += 1;
    this.pendingSections.set(section, this.saveRevisionCount);
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
      [...section.evidence].map(([index, evidence]) => [index, cloneCellEvidence(evidence)]),
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
  if (!Number.isFinite(observation.observedAt)) {
    throw new Error(`observation observedAt must be a finite number: ${observation.observedAt}`);
  }
}

function assertIntegerCoords(x: number, y: number, z: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new Error(`coordinates must be integer grid coordinates: (${x}, ${y}, ${z})`);
  }
}
