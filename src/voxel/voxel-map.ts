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
import { sectionKeyString } from './section.js';
import type { Section, SectionKey } from './section.js';
import {
  cloneCellEvidence,
  cloneObservation,
  estimateObservationResidentGrowth,
  estimateVoxelSectionBytes,
  estimateVoxelSectionResidentBytes,
  estimateVoxelSectionSnapshotBytes,
  restoreVoxelSection,
  snapshotVoxelSection,
  voxelSectionLowerBound,
} from './snapshot.js';
import { resolveResidencyLimits, VoxelResidencyError } from './residency.js';
import type {
  CommittedSectionInfo,
  PinLease,
  ResidencyLimits,
  ResolvedResidencyLimits,
  SectionResidencyInfo,
  UnloadSectionsResult,
  VoxelDirectoryEntry,
} from './residency.js';
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
  /**
   * Enable manual on-demand Section residency (design §9.2). When true the map
   * distinguishes committed-on-disk sections from resident-in-memory sections and
   * requires an explicit load before a write to a saved section. `installDirectory`
   * must be called once after construction. Defaults to false (every section is
   * eager-resident).
   */
  manualResidency?: boolean;
  /** Working-set bounds used when `manualResidency` is true. */
  residencyLimits?: ResidencyLimits;
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
  private readonly manualResidency: boolean;
  private readonly residentLimits: ResolvedResidencyLimits;
  /**
   * Committed section directory (manual mode only), keyed by a dim|coords key.
   * Read once at open from the worker without decoding any payload.
   */
  private readonly directory = new Map<string, VoxelDirectoryEntry>();
  /** Transient residency flags for non-resident sections: loading / load_failed. */
  private readonly extraResidency = new Map<string, 'loading' | 'load_failed'>();
  private readonly pins = new Map<string, PinLease>();
  /** Distinct pinned section key → number of active leases protecting it. */
  private readonly pinCounts = new Map<string, number>();
  /**
   * Conservative resident working-set size: the sum of `estimateVoxelSectionBytes`
   * over resident sections, maintained by before/after estimates on observe, load
   * and unload. A conservative estimate, not exact heap usage. `markStale` /
   * `beginSession` only flip freshness (a small `staleReason` string per cell) and
   * do not change the dominant palette/cells/evidence terms.
   */
  private residentBytes = 0;
  private residentSectionCount = 0;
  private directoryInstalled = false;
  private nextPinToken = 1;
  /**
   * Per-section residency generation, bumped on every unload/install. A residency
   * change does not advance `Section.revision`, so consumers (traversability cache,
   * route verifier) snapshot this generation per dependency and re-evaluate when it
   * moves, so an unload never keeps an old OPEN and a reload never keeps a pre-load
   * UNKNOWN.
   */
  private readonly residencyGenerations = new Map<string, number>();
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
  /**
   * True once the owning session has finished initialization and handed the map to
   * the caller. `restoreSnapshot` is the initialization path only: after this flag
   * is set it is rejected, so a delivered (even still-empty) map can never have its
   * facts silently replaced by a second restore.
   */
  private initialized = false;

  constructor(worldId: string, options: VoxelMapOptions = {}) {
    this.worldId = worldId;
    const validityWindowMs = options.validityWindowMs ?? DEFAULT_VALIDITY_WINDOW_MS;
    if (!Number.isFinite(validityWindowMs)) {
      throw new Error(`validityWindowMs must be a finite number: ${validityWindowMs}`);
    }
    this.validityWindowMs = validityWindowMs;
    this.now = options.now ?? Date.now;
    this.requireSession = options.requireSession ?? false;
    this.manualResidency = options.manualResidency ?? false;
    this.residentLimits = resolveResidencyLimits(options.residencyLimits);
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
    this.assertWritable([observation]);
    return this.applyObservations([observation]);
  }

  /**
   * Accept a batch; only the confirmed observations are written, gaps are not
   * cells. The whole batch is validated up front — both for malformed input and
   * for the manual-residency write guard — so an invalid observation or a
   * not-resident section does not leave behind a half-applied batch.
   */
  observeBatch(batch: ObservationBatch): ChangeReport {
    for (const observation of batch.observations) {
      validateObservation(this.worldId, observation);
    }
    this.assertWritable(batch.observations);
    return this.applyObservations(batch.observations);
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
    if (this.manualResidency && this.hasNonResidentDirectory()) {
      throw new Error(
        'checkpointSnapshot requires a fully resident map; unloaded sections would be silently dropped',
      );
    }
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
   * Cheap count of the *full* committed fact set — resident sections (counted
   * from their live state) plus directory sections that are not currently
   * resident (counted from their committed metadata). In manual mode this is
   * larger than `checkpointCounts()`; in eager mode the directory is empty and
   * the two are equal. Used by the session so a partial-resident map does not
   * under-count the full set against `maxVoxelSections`/`maxObservedCells`/
   * `maxPaletteEntries`.
   */
  checkpointFullCounts(): VoxelCheckpointCounts {
    const residentKeys = new Set<string>();
    let sections = 0;
    let observedCells = 0;
    let paletteEntries = 0;
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        residentKeys.add(dirKey(section.key.dim, section.key.cx, section.key.cz, section.key.sy));
        sections += 1;
        observedCells += section.evidence.size;
        paletteEntries += section.palette.length;
      }
    }
    for (const entry of this.directory.values()) {
      const key = dirKey(entry.key.dim, entry.key.cx, entry.key.cz, entry.key.sy);
      if (residentKeys.has(key)) continue;
      sections += 1;
      observedCells += entry.observedCells;
      paletteEntries += entry.paletteEntries;
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
   * Mark the map as delivered: called by the owning session once initialization is
   * complete. After this, `restoreSnapshot` is rejected — the initialize-then-
   * clean-baseline rule is confined to that controlled phase, and a still-empty
   * delivered map can no longer have its facts silently replaced.
   */
  sealInitialization(): void {
    this.initialized = true;
  }

  /**
   * Narrow, validated restore entry (phase 5B). Rebuilds the map from a previously
   * captured snapshot, re-marking saved `FRESH` evidence as `STALE`. It only
   * accepts a map that has not yet been delivered (initialization is still open) and
   * has not yet observed anything, so it is the initialization path — never a runtime
   * full-overwrite of an active map. It never replays `observe`, never refreshes
   * observation time, and never fabricates a current observation session.
   */
  restoreSnapshot(snapshot: VoxelCheckpointSnapshot): void {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new Error('voxel checkpoint snapshot must be an object');
    }
    if (snapshot.worldId !== this.worldId) {
      throw new Error(`snapshot worldId "${snapshot.worldId}" does not match map worldId "${this.worldId}"`);
    }
    // Restore is the initialization path only: reject a map that has already been
    // delivered (even if still empty), activated (a session started), or that
    // recorded an interruption boundary. "No sections" alone is not proof it is
    // pristine, and "empty" alone is not proof it is still initializing.
    if (this.initialized) {
      throw new Error('restoreSnapshot is only available during initialization');
    }
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

  // --- manual residency (phase 5D1) ---

  /**
   * Install the committed section directory read at open. Called exactly once,
   * before the map is sealed for delivery. Each entry is keyed by `worldId` +
   * dim/cx/cz/sy; the directory is the authoritative "what is committed on disk"
   * set, never a second authority over section facts (its fields mirror the
   * committed payload).
   */
  installDirectory(entries: readonly VoxelDirectoryEntry[]): void {
    if (!this.manualResidency) {
      throw new Error('installDirectory is only available in manual residency mode');
    }
    if (this.directoryInstalled) {
      throw new Error('the section directory is already installed');
    }
    for (const entry of entries) {
      if (entry.key.worldId !== this.worldId) {
        throw new Error(
          `directory entry worldId "${entry.key.worldId}" does not match map worldId "${this.worldId}"`,
        );
      }
      const key = dirKey(entry.key.dim, entry.key.cx, entry.key.cz, entry.key.sy);
      if (this.directory.has(key)) {
        throw new Error(`duplicate directory entry (${entry.key.dim}, ${entry.key.cx}, ${entry.key.cz}, ${entry.key.sy})`);
      }
      this.directory.set(key, entry);
    }
    this.directoryInstalled = true;
  }

  /** Residency of one section plus its committed record, when one exists. */
  sectionResidency(key: SectionKey): SectionResidencyInfo {
    assertSectionKey(this.worldId, key);
    const committed = this.committedInfo(key);
    if (this.hasSectionKey(key.dim, key.cx, key.cz, key.sy)) {
      return { residency: 'resident', committed };
    }
    const extra = this.extraResidency.get(dirKey(key.dim, key.cx, key.cz, key.sy));
    if (extra === 'loading') return { residency: 'loading', committed };
    if (extra === 'load_failed') return { residency: 'load_failed', committed };
    if (committed !== undefined) return { residency: 'not_resident', committed };
    return { residency: 'no_record' };
  }

  /**
   * Monotonic residency generation for one section. Advances on every unload and
   * every install, never on an observation, so consumers can detect a residency
   * change independently of `Section.revision`.
   */
  residencyGeneration(dim: string, cx: number, cz: number, sy: number): number {
    return this.residencyGenerations.get(dirKey(dim, cx, cz, sy)) ?? 0;
  }

  /** Conservative resident working-set size (section count + estimated bytes), for observability. */
  residentSize(): { sections: number; bytes: number } {
    return { sections: this.residentSectionCount, bytes: this.residentBytes };
  }

  /**
   * The currently resident section keys, in a deterministic (sorted) order. A
   * read-only enumeration of the in-memory section set — never a world scan, load,
   * eviction, save, or evidence refresh. Used by the working-set manager to keep its
   * LRU index consistent with the real resident set after direct `loadSections` /
   * `unloadSections` / `observe` calls. Bounded by `maxResidentSections`.
   */
  residentSectionKeys(): SectionKey[] {
    const keys: SectionKey[] = [];
    for (const dimMap of this.sections.values()) {
      for (const section of dimMap.values()) {
        keys.push({ ...section.key });
      }
    }
    keys.sort((a, b) => {
      const sa = sectionKeyString(a);
      const sb = sectionKeyString(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return keys;
  }

  /**
   * Exact resident working-set cost of the given resident sections (0 for any key
   * that is not currently resident). Read-only; never loads, evicts, saves, or
   * refreshes evidence. Used by the working-set manager to soundly pre-check that a
   * request's own footprint fits the byte budget before evicting anything.
   */
  residentBytesOf(keys: readonly SectionKey[]): number {
    let total = 0;
    for (const key of keys) {
      const section = this.residentSection(key);
      if (section !== undefined) total += estimateVoxelSectionResidentBytes(section);
    }
    return total;
  }

  /** Read-only pin accounting: how many leases and distinct pinned sections exist now. */
  pinState(): { leases: number; pinnedSections: number } {
    return { leases: this.pins.size, pinnedSections: this.pinCounts.size };
  }

  /** Mark sections as having a load in flight (the session drives this around the worker round-trip). */
  markLoading(keys: readonly SectionKey[]): void {
    for (const key of keys) {
      assertSectionKey(this.worldId, key);
      this.extraResidency.set(dirKey(key.dim, key.cx, key.cz, key.sy), 'loading');
    }
  }

  /** Mark a failed load so the sections read as saved-but-not-resident, never as no-record. */
  markLoadFailed(keys: readonly SectionKey[]): void {
    for (const key of keys) {
      assertSectionKey(this.worldId, key);
      this.extraResidency.set(dirKey(key.dim, key.cx, key.cz, key.sy), 'load_failed');
    }
  }

  /** Clear transient loading/failed markers (used for keys the worker reported have no record). */
  clearTransientResidency(keys: readonly SectionKey[]): void {
    for (const key of keys) {
      this.extraResidency.delete(dirKey(key.dim, key.cx, key.cz, key.sy));
    }
  }

  /**
   * Narrow runtime section-install path: validate every snapshot, check the
   * working-set capacity, then install atomically. Never replays `observe`, never
   * refreshes evidence time, never advances the save revision or dirties a
   * section, and never resets the current session or interruption boundaries.
   * Returns the installed section keys for the caller to feed cache invalidation.
   */
  installLoadedSections(snapshots: readonly VoxelSectionSnapshot[]): SectionKey[] {
    if (!this.manualResidency) {
      throw new Error('installLoadedSections is only available in manual residency mode');
    }
    // Validate + build every section first, so a corrupt section in the middle
    // never publishes a half-valid, half-corrupt batch.
    const built: Section[] = [];
    const seen = new Set<string>();
    for (const raw of snapshots) {
      const section = restoreVoxelSection(this.worldId, raw);
      const key = dirKey(section.key.dim, section.key.cx, section.key.cz, section.key.sy);
      if (seen.has(key)) {
        throw new Error(`duplicate loaded section (${section.key.dim}, ${section.key.cx}, ${section.key.cz}, ${section.key.sy})`);
      }
      seen.add(key);
      built.push(section);
    }

    // Whole-batch pre-check: never overwrite a section that is already resident.
    // Loading is the "install a non-resident section" path only; overwriting a
    // resident section would silently replace its (possibly unsaved) facts and
    // leave `pendingSections` pointing at the replaced object.
    for (const section of built) {
      if (this.hasSectionKey(section.key.dim, section.key.cx, section.key.cz, section.key.sy)) {
        throw new Error(
          `section (${section.key.dim}, ${section.key.cx}, ${section.key.cz}, ${section.key.sy}) is already resident; load must not overwrite runtime facts`,
        );
      }
    }

    const fresh = built;
    const addedBytes = fresh.reduce((sum, s) => sum + estimateVoxelSectionResidentBytes(s), 0);
    if (this.residentSectionCount + fresh.length > this.residentLimits.maxResidentSections) {
      throw new Error(
        `resident sections would exceed maxResidentSections (${this.residentSectionCount + fresh.length} > ${this.residentLimits.maxResidentSections})`,
      );
    }
    if (this.residentBytes + addedBytes > this.residentLimits.maxResidentBytes) {
      throw new Error(
        `resident working set would exceed maxResidentBytes (${this.residentBytes + addedBytes} > ${this.residentLimits.maxResidentBytes})`,
      );
    }

    for (const section of built) {
      this.setSection(section);
      this.bumpResidencyGeneration(section.key.dim, section.key.cx, section.key.cz, section.key.sy);
    }
    this.residentSectionCount += fresh.length;
    this.residentBytes += addedBytes;
    for (const section of built) {
      this.extraResidency.delete(dirKey(section.key.dim, section.key.cx, section.key.cz, section.key.sy));
    }
    return built.map((s) => ({ ...s.key }));
  }

  /**
   * Controlled, safe unload of resident sections. Only sections with a committed
   * record, no pending (unsaved) change, and no active pin are released; anything
   * else is reported with a structured reason. Unloading releases only the runtime
   * payload — it never deletes the directory record, never clears history, never
   * auto-saves, and never marks the section as never-observed.
   */
  unloadSections(keys: readonly SectionKey[]): UnloadSectionsResult {
    const result: UnloadSectionsResult = { unloaded: [], rejected: [] };
    for (const key of keys) {
      assertSectionKey(this.worldId, key);
      const dk = dirKey(key.dim, key.cx, key.cz, key.sy);
      if (!this.hasSectionKey(key.dim, key.cx, key.cz, key.sy)) continue; // already non-resident
      if ((this.pinCounts.get(dk) ?? 0) > 0) {
        result.rejected.push({ key: { ...key }, reason: 'pinned' });
        continue;
      }
      if (!this.directory.has(dk)) {
        result.rejected.push({ key: { ...key }, reason: 'not_committed' });
        continue;
      }
      const section = this.residentSection(key)!;
      if (this.pendingSections.has(section)) {
        result.rejected.push({ key: { ...key }, reason: 'dirty' });
        continue;
      }

      const dimMap = this.sections.get(key.dim)!;
      dimMap.delete(innerKey(key.cx, key.cz, key.sy));
      if (dimMap.size === 0) this.sections.delete(key.dim);
      this.residentBytes -= estimateVoxelSectionResidentBytes(section);
      this.residentSectionCount -= 1;
      this.bumpResidencyGeneration(key.dim, key.cx, key.cz, key.sy);
      result.unloaded.push({ ...key });
    }
    return result;
  }

  /**
   * Acquire a bounded protection lease over a set of sections. Pinning does not
   * load or refresh evidence; it only prevents `unloadSections` from releasing
   * the section. Multiple callers may pin the same section; each lease is dropped
   * independently.
   */
  pinSections(keys: readonly SectionKey[]): PinLease {
    if (!this.manualResidency) {
      throw new Error('pinSections requires manual residency mode');
    }
    // Validate every key (scope, dim, integer coords) before any state change, so
    // a foreign-world key can never build a protection under this map's coords.
    for (const key of keys) assertSectionKey(this.worldId, key);
    const deduped = dedupeKeys(keys);
    if (deduped.length > this.residentLimits.maxLoadBatchSections) {
      throw new Error(`pin request has ${deduped.length} sections, exceeding maxLoadBatchSections (${this.residentLimits.maxLoadBatchSections})`);
    }
    if (this.pins.size >= this.residentLimits.maxPins) {
      throw new Error(`pin leases exceed maxPins (${this.pins.size} >= ${this.residentLimits.maxPins})`);
    }
    // Apply the increments, then check the distinct-pinned-sections cap; on over
    // cap, roll back this lease's increments and leave the pin set unchanged.
    for (const key of deduped) {
      const dk = dirKey(key.dim, key.cx, key.cz, key.sy);
      this.pinCounts.set(dk, (this.pinCounts.get(dk) ?? 0) + 1);
    }
    if (this.pinCounts.size > this.residentLimits.maxPinnedSections) {
      for (const key of deduped) {
        const dk = dirKey(key.dim, key.cx, key.cz, key.sy);
        const count = this.pinCounts.get(dk)! - 1;
        if (count <= 0) this.pinCounts.delete(dk);
        else this.pinCounts.set(dk, count);
      }
      throw new Error(`pinned sections exceed maxPinnedSections (${this.residentLimits.maxPinnedSections})`);
    }
    const token = `pin-${this.nextPinToken++}`;
    const lease: PinLease = { token, keys: deduped.map((k) => ({ ...k })) };
    this.pins.set(token, lease);
    return { token, keys: lease.keys.map((k) => ({ ...k })) };
  }

  /**
   * Release one or more pin leases. Releasing only ever drops the caller's own
   * lease; an unknown or already-released token is a no-op, so a late cleanup of
   * an old task can never undo a newer task's protection.
   */
  releasePins(tokens: readonly string[]): void {
    for (const token of tokens) {
      const lease = this.pins.get(token);
      if (lease === undefined) continue;
      this.pins.delete(token);
      for (const key of lease.keys) {
        const dk = dirKey(key.dim, key.cx, key.cz, key.sy);
        const count = this.pinCounts.get(dk);
        if (count === undefined) continue;
        if (count <= 1) this.pinCounts.delete(dk);
        else this.pinCounts.set(dk, count - 1);
      }
    }
  }

  /**
   * Update the committed directory from a *captured* checkpoint snapshot, so the
   * on-disk metadata (cell/palette/revision/byte counts) reflects exactly what the
   * worker committed — never the ACK-time in-memory state, which may have advanced
   * past the captured revision. `full` replaces the directory; `incremental`
   * upserts only the captured (dirty) sections and leaves other directory entries
   * untouched.
   */
  commitDirectory(
    mode: 'full' | 'incremental',
    sections: readonly VoxelSectionSnapshot[],
    committedBytes: readonly { dim: string; cx: number; cz: number; sy: number; bytes: number }[],
  ): void {
    if (!this.manualResidency) return;
    if (mode === 'full') this.directory.clear();
    const byteMap = new Map(committedBytes.map((b) => [dirKey(b.dim, b.cx, b.cz, b.sy), b.bytes]));
    let nextSeq = this.directory.size === 0 ? 0 : Math.max(...[...this.directory.values()].map((e) => e.seq)) + 1;
    for (const raw of sections) {
      const key = dirKey(raw.dim, raw.cx, raw.cz, raw.sy);
      const existing = this.directory.get(key);
      this.directory.set(key, {
        key: { worldId: this.worldId, dim: raw.dim, cx: raw.cx, cz: raw.cz, sy: raw.sy },
        seq: existing?.seq ?? nextSeq++,
        // The worker returns the actual committed octet_length; the estimate is only
        // a fallback if the ACK did not carry bytes (never the normal path).
        bytes: byteMap.get(key) ?? estimateVoxelSectionSnapshotBytes(raw),
        observedCells: raw.evidence.length,
        paletteEntries: raw.palette.length,
        revision: raw.revision,
      });
    }
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

  private committedInfo(key: SectionKey): CommittedSectionInfo | undefined {
    const entry = this.directory.get(dirKey(key.dim, key.cx, key.cz, key.sy));
    if (entry === undefined) return undefined;
    return {
      revision: entry.revision,
      bytes: entry.bytes,
      observedCells: entry.observedCells,
      paletteEntries: entry.paletteEntries,
    };
  }

  private hasNonResidentDirectory(): boolean {
    for (const entry of this.directory.values()) {
      if (!this.hasSectionKey(entry.key.dim, entry.key.cx, entry.key.cz, entry.key.sy)) return true;
    }
    return false;
  }

  private hasSectionKey(dim: string, cx: number, cz: number, sy: number): boolean {
    return this.sections.get(dim)?.has(innerKey(cx, cz, sy)) ?? false;
  }

  private residentSection(key: SectionKey): Section | undefined {
    return this.sections.get(key.dim)?.get(innerKey(key.cx, key.cz, key.sy));
  }

  private setSection(section: Section): void {
    let dimMap = this.sections.get(section.key.dim);
    if (dimMap === undefined) {
      dimMap = new Map();
      this.sections.set(section.key.dim, dimMap);
    }
    dimMap.set(innerKey(section.key.cx, section.key.cz, section.key.sy), section);
  }

  private bumpResidencyGeneration(dim: string, cx: number, cz: number, sy: number): void {
    const key = dirKey(dim, cx, cz, sy);
    this.residencyGenerations.set(key, (this.residencyGenerations.get(key) ?? 0) + 1);
  }

  /**
   * Manual-mode write guard: reject (before any mutation) a batch that would
   * write a committed-but-not-resident (or loading/failed) section, or that
   * would push the resident working set over its bounds. A no-op in eager mode.
   */
  private assertWritable(observations: readonly Observation[]): void {
    if (!this.manualResidency) return;
    const missing: SectionKey[] = [];
    const missingSeen = new Set<string>();
    const newSections = new Set<string>();
    for (const observation of observations) {
      const { cx, cz, sy } = blockToSection(observation.pos.x, observation.pos.y, observation.pos.z);
      const key = dirKey(observation.dim, cx, cz, sy);
      if (this.hasSectionKey(observation.dim, cx, cz, sy)) continue;
      const known = this.directory.has(key) || this.extraResidency.has(key);
      if (known) {
        if (!missingSeen.has(key)) {
          missingSeen.add(key);
          missing.push({ worldId: this.worldId, dim: observation.dim, cx, cz, sy });
        }
      } else {
        newSections.add(key);
      }
    }
    if (missing.length > 0) throw new VoxelResidencyError(missing);

    if (this.residentSectionCount + newSections.size > this.residentLimits.maxResidentSections) {
      throw new Error(
        `resident sections would exceed maxResidentSections (${this.residentSectionCount + newSections.size} > ${this.residentLimits.maxResidentSections})`,
      );
    }
    let growth = 0;
    for (const observation of observations) growth += estimateObservationResidentGrowth(observation);
    if (this.residentBytes + growth > this.residentLimits.maxResidentBytes) {
      throw new Error(
        `resident working set would exceed maxResidentBytes (${this.residentBytes + growth} > ${this.residentLimits.maxResidentBytes})`,
      );
    }
  }

  /**
   * Apply validated observations and keep the conservative resident working-set
   * size exact. In manual mode the accounting is aggregated per touched section
   * (one before/after estimate each), not per observation, so a full-section batch
   * stays O(section) rather than O(section²).
   */
  private applyObservations(observations: readonly Observation[]): ChangeReport {
    if (!this.manualResidency) {
      const bySection = new Map<Section, SectionChange>();
      for (const observation of observations) {
        const applied = this.applyValidated(observation);
        if (applied === null) continue;
        this.recordSaveChange(applied.section);
        addChange(bySection, applied.section, { pos: { x: applied.x, y: applied.y, z: applied.z }, kind: applied.kind });
      }
      return { sections: [...bySection.values()] };
    }

    const bySection = new Map<Section, SectionChange>();
    const touched = new Map<Section, number>(); // section → pre-mutation resident bytes (0 = brand new)
    for (const observation of observations) {
      const existing = this.lookupSection(observation.dim, observation.pos.x, observation.pos.y, observation.pos.z);
      if (existing !== undefined && !touched.has(existing)) {
        touched.set(existing, estimateVoxelSectionResidentBytes(existing));
      }
      const applied = this.applyValidated(observation);
      if (applied === null) continue;
      if (existing === undefined && !touched.has(applied.section)) {
        touched.set(applied.section, 0);
      }
      this.recordSaveChange(applied.section);
      addChange(bySection, applied.section, { pos: { x: applied.x, y: applied.y, z: applied.z }, kind: applied.kind });
    }
    for (const [section, before] of touched) {
      this.residentBytes += estimateVoxelSectionResidentBytes(section) - before;
      if (before === 0) this.residentSectionCount += 1;
    }
    return { sections: [...bySection.values()] };
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

/** Internal residency-map key for one section within this map's worldId. */
function dirKey(dim: string, cx: number, cz: number, sy: number): string {
  return `${dim}|${cx},${cz},${sy}`;
}

function assertSectionKey(worldId: string, key: SectionKey): void {
  if (key.worldId !== worldId) {
    throw new Error(`section key worldId "${key.worldId}" does not match map worldId "${worldId}"`);
  }
  if (typeof key.dim !== 'string' || key.dim.length === 0) {
    throw new Error('section key dim must be a non-empty string');
  }
  if (!Number.isInteger(key.cx) || !Number.isInteger(key.cz) || !Number.isInteger(key.sy)) {
    throw new Error(`section key coordinates must be integers: (${key.cx}, ${key.cz}, ${key.sy})`);
  }
}

function dedupeKeys(keys: readonly SectionKey[]): SectionKey[] {
  const seen = new Set<string>();
  const out: SectionKey[] = [];
  for (const key of keys) {
    const dk = dirKey(key.dim, key.cx, key.cz, key.sy);
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({ ...key });
  }
  return out;
}
