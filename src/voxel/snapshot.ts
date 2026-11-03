/**
 * Voxel map checkpoint snapshot, byte measurement, and restore format (phase 5B).
 *
 * `VoxelMap` persists only its authoritative facts — the sections that actually
 * exist and the cells that were actually observed — through a deep-copied,
 * versioned, structured-clone-safe snapshot. On restore, previously-`FRESH`
 * evidence is uniformly re-marked `STALE` (it was fresh in a *past* session, not
 * now), `explored`/`stale` bitmaps are reconstructed from evidence, and the
 * derived `traversed`/`modified`/`risk` bitmaps are rebuilt empty (the current
 * `VoxelMap` never writes them, and nothing here infers them).
 *
 * Authoritative (persisted verbatim): the section key (dim/cx/cz/sy), `palette`,
 * `bits`, `cells`, `evidence`, and `revision`. Reconstructable (not persisted):
 * `explored` (evidence presence), `stale` (freshness), `lastObservedAt` (max
 * observedAt), `traversed`/`modified`/`risk` (empty).
 */

import { jsonEscapedByteLength } from '../bytes.js';
import { SECTION_CELL_COUNT } from '../constants.js';
import type { CellEvidence, Freshness, Observation } from '../observation/types.js';
import { AIR_BLOCK_NAME, serializeBlockState } from './blockstate.js';
import { blockToSection, cellIndex } from './coordinates.js';
import { bitsRequired, readCell, setBit } from './palette.js';
import type { Section } from './section.js';

/** Measured size of the voxel map, used for the bounded checkpoint pre-flight. */
export interface VoxelCheckpointMeasure {
  sections: number;
  observedCells: number;
  paletteEntries: number;
  /** Conservative estimate of the serialized snapshot size (never a copy or full stringify). */
  bytes: number;
}

/** Cheap full-map counts (no serialization), for the full-set capacity check. */
export interface VoxelCheckpointCounts {
  sections: number;
  observedCells: number;
  paletteEntries: number;
}

/** Measured size of the pending (dirty) incremental batch. */
export interface VoxelDirtyMeasure {
  /** Number of pending sections. */
  count: number;
  /** Conservative escaped-byte estimate of the pending-section payloads. */
  bytes: number;
}

/** Deep-copied evidence at one local cell index. */
export interface VoxelCellSnapshot {
  index: number;
  evidence: CellEvidence;
}

/** Deep-copied, verifiable form of one section's authoritative facts. */
export interface VoxelSectionSnapshot {
  dim: string;
  cx: number;
  cz: number;
  sy: number;
  palette: string[];
  bits: number;
  /** Bit-packed cell values; length `ceil(4096 * bits / 8)`. */
  cells: Uint8Array;
  /** Per-cell evidence, keyed by local cell index. */
  evidence: VoxelCellSnapshot[];
  revision: number;
}

/** Deep-copied, world-scoped snapshot of the voxel map's full observed state. */
export interface VoxelCheckpointSnapshot {
  worldId: string;
  sections: VoxelSectionSnapshot[];
}

// --- deep copy ---------------------------------------------------------------

/** Deep-copy an observation so a snapshot never aliases caller/store objects. */
export function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { x: observation.pos.x, y: observation.pos.y, z: observation.pos.z },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

/** Deep-copy cell evidence. */
export function cloneCellEvidence(evidence: CellEvidence): CellEvidence {
  return { ...evidence, observation: cloneObservation(evidence.observation) };
}

/** Deep-copy one live section into its persisted snapshot form. */
export function snapshotVoxelSection(section: Section): VoxelSectionSnapshot {
  return {
    dim: section.key.dim,
    cx: section.key.cx,
    cz: section.key.cz,
    sy: section.key.sy,
    palette: [...section.palette],
    bits: section.bits,
    cells: section.cells.slice(),
    evidence: [...section.evidence].map(([index, evidence]) => ({
      index,
      evidence: cloneCellEvidence(evidence),
    })),
    revision: section.revision,
  };
}

// --- restore: validation + reconstruction --------------------------------------

const STALE_REASONS = ['unloaded', 'observation_gap', 'expired', 'pending_effect', 'conflict'] as const;
/** Longest known stale reason, used to bill the worst-case resident footprint. */
const WORST_CASE_STALE_REASON = 'observation_gap';
const EVIDENCE_KINDS = ['seen', 'contact', 'confirmed_effect'] as const;
const OBSERVATION_SOURCES = ['vision', 'agent_action', 'local_rescan'] as const;

/**
 * Rebuild one live section from its snapshot form, validating structure, scope,
 * coordinate ownership and palette/cells/evidence consistency, and re-marking any
 * previously-`FRESH` evidence as `STALE` (`observation_gap`). Derived bitmaps are
 * reconstructed; `traversed`/`modified`/`risk` come back empty.
 */
export function restoreVoxelSection(worldId: string, raw: VoxelSectionSnapshot): Section {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('voxel section snapshot must be an object');
  }
  if (typeof raw.dim !== 'string' || raw.dim.length === 0) {
    throw new Error('voxel section dim must be a non-empty string');
  }
  if (!Number.isInteger(raw.cx) || !Number.isInteger(raw.cz) || !Number.isInteger(raw.sy)) {
    throw new Error(`voxel section coordinates must be integers: (${raw.cx}, ${raw.cz}, ${raw.sy})`);
  }
  if (!Array.isArray(raw.palette) || raw.palette.length === 0) {
    throw new Error('voxel section palette must be a non-empty array');
  }
  if (raw.palette[0] !== AIR_BLOCK_NAME) {
    throw new Error('voxel section palette index 0 must be reserved for air');
  }
  const paletteSeen = new Set<string>();
  for (const entry of raw.palette) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error('voxel section palette entries must be non-empty strings');
    }
    if (paletteSeen.has(entry)) {
      throw new Error(`voxel section palette has a duplicate entry "${entry}"`);
    }
    paletteSeen.add(entry);
  }
  if (!Number.isInteger(raw.bits) || raw.bits < 1 || raw.bits > 30) {
    throw new Error(`voxel section bits must be an integer in [1, 30]: ${String(raw.bits)}`);
  }
  if (raw.bits !== bitsRequired(raw.palette.length)) {
    throw new Error(`voxel section bits ${raw.bits} does not match palette length ${raw.palette.length}`);
  }
  const cells = raw.cells instanceof Uint8Array ? raw.cells : null;
  const expectedCellsLength = Math.ceil((SECTION_CELL_COUNT * raw.bits) / 8);
  if (cells === null || cells.length !== expectedCellsLength) {
    throw new Error(`voxel section cells length ${cells?.length ?? 'n/a'} does not match expected ${expectedCellsLength}`);
  }
  if (!Array.isArray(raw.evidence)) {
    throw new Error('voxel section evidence must be an array');
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 0) {
    throw new Error(`voxel section revision must be a non-negative integer: ${String(raw.revision)}`);
  }

  const evidenceMap = new Map<number, CellEvidence>();
  let revisionSum = 0;
  let lastObservedAt: number | undefined;
  for (const cell of raw.evidence) {
    const index = (cell as VoxelCellSnapshot | null)?.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= SECTION_CELL_COUNT) {
      throw new Error(`voxel cell index out of range: ${String(index)}`);
    }
    if (evidenceMap.has(index as number)) {
      throw new Error(`duplicate voxel cell index ${String(index)} in section`);
    }
    const evidence = validateCellEvidence(
      worldId,
      raw.dim,
      raw.cx,
      raw.cz,
      raw.sy,
      index as number,
      cells,
      raw.bits,
      raw.palette,
      (cell as VoxelCellSnapshot).evidence,
    );
    evidenceMap.set(index as number, evidence);
    revisionSum += evidence.revision;
    const at = evidence.observation.observedAt;
    lastObservedAt = lastObservedAt === undefined ? at : Math.max(lastObservedAt, at);
  }
  // section.revision counts every insert/changed/restored/staled event, which is
  // exactly the sum of the per-cell evidence revisions.
  if (raw.revision !== revisionSum) {
    throw new Error(`voxel section revision ${raw.revision} disagrees with evidence revisions (${revisionSum})`);
  }

  const bitmapBytes = SECTION_CELL_COUNT / 8;
  const explored = new Uint8Array(bitmapBytes);
  const stale = new Uint8Array(bitmapBytes);
  for (const [index, evidence] of evidenceMap) {
    setBit(explored, index, true);
    if (evidence.freshness === 'STALE') setBit(stale, index, true);
  }

  const section: Section = {
    key: { worldId, dim: raw.dim, cx: raw.cx, cz: raw.cz, sy: raw.sy },
    palette: [...raw.palette],
    cells: cells.slice(),
    bits: raw.bits,
    explored,
    traversed: new Uint8Array(bitmapBytes),
    stale,
    risk: new Uint8Array(bitmapBytes),
    modified: new Uint8Array(bitmapBytes),
    evidence: evidenceMap,
    revision: raw.revision,
  };
  if (lastObservedAt !== undefined) section.lastObservedAt = lastObservedAt;
  return section;
}

/** Validate one restored cell's evidence and apply the FRESH → STALE initialization rule. */
function validateCellEvidence(
  worldId: string,
  dim: string,
  cx: number,
  cz: number,
  sy: number,
  index: number,
  cells: Uint8Array,
  bits: number,
  palette: string[],
  raw: CellEvidence,
): CellEvidence {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('voxel cell evidence must be an object');
  }
  const observation = validateObservation(worldId, raw.observation);
  // The evidence must belong to exactly this section and this local cell: its dim
  // and its position-decomposed section/cell index must all agree, or a snapshot
  // could smuggle an out-of-section / out-of-dimension observation into a cell.
  if (observation.dim !== dim) {
    throw new Error(`voxel cell ${index} observation dim "${observation.dim}" does not match section dim "${dim}"`);
  }
  const coords = blockToSection(observation.pos.x, observation.pos.y, observation.pos.z);
  if (coords.cx !== cx || coords.cz !== cz || coords.sy !== sy) {
    throw new Error(`voxel cell ${index} observation position does not belong to section (${cx}, ${cz}, ${sy})`);
  }
  if (cellIndex(coords.lx, coords.ly, coords.lz) !== index) {
    throw new Error(`voxel cell ${index} observation position does not match its cell index`);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1) {
    throw new Error(`voxel cell evidence revision must be a positive integer: ${String(raw.revision)}`);
  }
  if (raw.freshness !== 'FRESH' && raw.freshness !== 'STALE') {
    throw new Error(`voxel cell evidence freshness is not known: ${String(raw.freshness)}`);
  }
  if (raw.staleReason !== undefined && !(STALE_REASONS as readonly string[]).includes(raw.staleReason)) {
    throw new Error(`voxel cell evidence staleReason is not known: ${String(raw.staleReason)}`);
  }
  if (!Number.isFinite(raw.validUntil)) {
    throw new Error('voxel cell evidence validUntil must be a finite number');
  }

  // palette/cells/evidence must agree: the packed palette index for this cell is
  // the canonical serialization of the evidence's own state.
  const serialized = serializeBlockState(observation.state);
  const paletteIndex = readCell(cells, bits, index);
  if (palette[paletteIndex] !== serialized) {
    throw new Error(`voxel cell ${index} palette/evidence disagree`);
  }

  // A saved FRESH cell was fresh only in the old session; it is STALE now.
  const wasFresh = raw.freshness === 'FRESH';
  const freshness: Freshness = 'STALE';
  return {
    observation,
    revision: raw.revision,
    freshness,
    staleReason: wasFresh ? 'observation_gap' : raw.staleReason,
    validUntil: raw.validUntil,
  };
}

/** Validate the structure and scope of one restored observation. */
function validateObservation(worldId: string, obs: Observation): Observation {
  if (obs === null || typeof obs !== 'object') {
    throw new Error('voxel observation must be an object');
  }
  if (obs.worldId !== worldId) {
    throw new Error(`voxel observation worldId "${obs.worldId}" does not match "${worldId}"`);
  }
  if (typeof obs.dim !== 'string' || obs.dim.length === 0) {
    throw new Error('voxel observation dim must be a non-empty string');
  }
  if (!Number.isInteger(obs.pos?.x) || !Number.isInteger(obs.pos?.y) || !Number.isInteger(obs.pos?.z)) {
    throw new Error('voxel observation position must be integer grid coordinates');
  }
  if (!Number.isFinite(obs.observedAt)) {
    throw new Error('voxel observation observedAt must be a finite number');
  }
  if (obs.state === null || typeof obs.state !== 'object' || typeof obs.state.name !== 'string' || obs.state.name.length === 0) {
    throw new Error('voxel observation state name must be a non-empty string');
  }
  const properties = obs.state.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('voxel observation state properties must be a string record');
  }
  for (const value of Object.values(properties)) {
    if (typeof value !== 'string') {
      throw new Error('voxel observation state property values must be strings');
    }
  }
  if (typeof obs.stateComplete !== 'boolean') {
    throw new Error('voxel observation stateComplete must be a boolean');
  }
  if (!(EVIDENCE_KINDS as readonly string[]).includes(obs.evidence)) {
    throw new Error(`voxel observation evidence kind is not known: ${String(obs.evidence)}`);
  }
  if (obs.observedWorldTick !== undefined && !Number.isFinite(obs.observedWorldTick)) {
    throw new Error('voxel observation observedWorldTick must be a finite number');
  }
  if (!(OBSERVATION_SOURCES as readonly string[]).includes(obs.source)) {
    throw new Error(`voxel observation source is not known: ${String(obs.source)}`);
  }
  if (typeof obs.sessionId !== 'string' || obs.sessionId.length === 0) {
    throw new Error('voxel observation sessionId must be a non-empty string');
  }
  if (obs.originObservationId !== undefined && !Number.isInteger(obs.originObservationId)) {
    throw new Error('voxel observation originObservationId must be an integer');
  }
  if (!Number.isFinite(obs.sequence)) {
    throw new Error('voxel observation sequence must be a finite number');
  }
  if (obs.actionId !== undefined && (typeof obs.actionId !== 'string' || obs.actionId.length === 0)) {
    throw new Error('voxel observation actionId must be a non-empty string when present');
  }
  return cloneObservation(obs);
}

// --- byte estimation (conservative upper bound; no copy or full stringify) -----

// Worst-case JSON decimal for a JS double; surrounding quotes for each string.
const BYTES_PER_NUMBER = 24;
const STRING_QUOTES = 2;
// Fixed structural overhead for each object: field names, braces, colons.
const SECTION_FIXED_BYTES = 200;
const CELL_FIXED_BYTES = 120;
const OBSERVATION_FIXED_BYTES = 220;

type StringCost = (s: string) => number;

/** `ceil(n/3) * 4` — the length of a base64 encoding of `n` bytes. */
function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function observationBytes(observation: Observation, cost: StringCost): number {
  let bytes = OBSERVATION_FIXED_BYTES;
  bytes += 3 * BYTES_PER_NUMBER; // pos x/y/z
  bytes += cost(observation.state.name) + STRING_QUOTES;
  const propEntries = Object.entries(observation.state.properties);
  bytes += 2; // properties object braces
  bytes += Math.max(0, propEntries.length - 1); // inter-property commas
  for (const [key, value] of propEntries) {
    bytes += cost(key) + STRING_QUOTES + cost(value) + STRING_QUOTES + 1; // key ":" value
  }
  bytes += observation.stateComplete ? 4 : 5;
  bytes += cost(observation.evidence) + STRING_QUOTES;
  bytes += BYTES_PER_NUMBER; // observedAt
  if (observation.observedWorldTick !== undefined) bytes += BYTES_PER_NUMBER;
  bytes += cost(observation.source) + STRING_QUOTES;
  bytes += cost(observation.sessionId) + STRING_QUOTES;
  if (observation.originObservationId !== undefined) bytes += BYTES_PER_NUMBER;
  bytes += BYTES_PER_NUMBER; // sequence
  if (observation.actionId !== undefined) bytes += cost(observation.actionId) + STRING_QUOTES;
  bytes += cost(observation.dim) + STRING_QUOTES;
  bytes += cost(observation.worldId) + STRING_QUOTES;
  return bytes;
}

function cellEvidenceBytes(evidence: CellEvidence, cost: StringCost, forceStaleReason = false): number {
  let bytes = CELL_FIXED_BYTES;
  bytes += BYTES_PER_NUMBER; // index
  bytes += observationBytes(evidence.observation, cost);
  bytes += BYTES_PER_NUMBER; // revision
  bytes += cost(evidence.freshness) + STRING_QUOTES;
  if (forceStaleReason) {
    // Resident billing always reserves the longest stale reason, regardless of the
    // cell's actual (shorter) reason, so a freshness transition can never leave a
    // billing residue on unload.
    bytes += cost(WORST_CASE_STALE_REASON) + STRING_QUOTES;
  } else if (evidence.staleReason !== undefined) {
    bytes += cost(evidence.staleReason) + STRING_QUOTES;
  }
  bytes += BYTES_PER_NUMBER; // validUntil
  return bytes;
}

function voxelSectionBytes(section: Section, cost: StringCost, forceStaleReason = false): number {
  let bytes = SECTION_FIXED_BYTES;
  bytes += cost(section.key.dim) + STRING_QUOTES;
  bytes += 3 * BYTES_PER_NUMBER; // cx, cz, sy
  bytes += BYTES_PER_NUMBER; // bits
  bytes += BYTES_PER_NUMBER; // revision
  let paletteBytes = Math.max(0, section.palette.length - 1);
  for (const entry of section.palette) paletteBytes += cost(entry) + STRING_QUOTES;
  bytes += paletteBytes;
  bytes += STRING_QUOTES + base64Length(section.cells.length);
  let evidenceBytes = Math.max(0, section.evidence.size - 1);
  for (const evidence of section.evidence.values()) evidenceBytes += cellEvidenceBytes(evidence, cost, forceStaleReason);
  bytes += evidenceBytes;
  return bytes;
}

/** Conservative escaped-byte estimate (full per-character scan). */
export function estimateVoxelSectionBytes(section: Section): number {
  return voxelSectionBytes(section, jsonEscapedByteLength);
}

/** Cheap lower bound: UTF-16 `.length` (≤ UTF-8 bytes ≤ escaped bytes). */
export function voxelSectionLowerBound(section: Section): number {
  return voxelSectionBytes(section, (s) => s.length);
}

/**
 * Conservative resident working-set estimate: like `estimateVoxelSectionBytes`
 * but bills every cell for its worst-case `staleReason` field regardless of current
 * freshness. A FRESH cell can later become STALE (markStale / beginSession) without
 * growing past its reservation, so the resident byte cap is a hard upper bound that
 * freshness transitions can never exceed.
 */
export function estimateVoxelSectionResidentBytes(section: Section): number {
  return voxelSectionBytes(section, jsonEscapedByteLength, true);
}

/**
 * Conservative upper bound on the resident-byte growth one observation can add to
 * a section — whether the section is brand-new or already resident. It is the full
 * `estimateVoxelSectionBytes` of a synthetic single-cell section containing that
 * observation (fixed overhead + one palette entry + one packed cell + one evidence
 * entry), which is always ≥ the true marginal growth: a brand-new section costs
 * exactly this, and adding a cell to an existing section costs at most the same
 * marginal evidence/palette/cells terms. Using the same estimator guarantees the
 * pre-flight never under-estimates the exact `residentBytes` maintained before/after.
 */
export function estimateObservationResidentGrowth(observation: Observation): number {
  const section: Section = {
    key: { worldId: observation.worldId, dim: observation.dim, cx: 0, cz: 0, sy: 0 },
    palette: [AIR_BLOCK_NAME, serializeBlockState(observation.state)],
    cells: new Uint8Array(Math.ceil((SECTION_CELL_COUNT * 1) / 8)),
    bits: 1,
    explored: new Uint8Array(0),
    traversed: new Uint8Array(0),
    stale: new Uint8Array(0),
    risk: new Uint8Array(0),
    modified: new Uint8Array(0),
    evidence: new Map([
      [
        0,
        {
          observation: cloneObservation(observation),
          revision: 1,
          freshness: 'FRESH',
          staleReason: undefined,
          validUntil: observation.observedAt + 1,
        },
      ],
    ]),
    revision: 1,
  };
  // Bill the worst-case (stale) footprint, so the pre-flight reserves the space a
  // later markStale/beginSession would need.
  return estimateVoxelSectionResidentBytes(section);
}

/**
 * Conservative escaped-byte estimate of one persisted section snapshot (the form
 * the worker decodes/encodes). Used to update the committed directory's byte count
 * on save confirmation without re-serializing on the main thread.
 */
export function estimateVoxelSectionSnapshotBytes(raw: VoxelSectionSnapshot): number {
  const cost = jsonEscapedByteLength;
  let bytes = SECTION_FIXED_BYTES;
  bytes += cost(raw.dim) + STRING_QUOTES;
  bytes += 3 * BYTES_PER_NUMBER; // cx cz sy
  bytes += BYTES_PER_NUMBER; // bits
  bytes += BYTES_PER_NUMBER; // revision
  let paletteBytes = Math.max(0, raw.palette.length - 1);
  for (const entry of raw.palette) paletteBytes += cost(entry) + STRING_QUOTES;
  bytes += paletteBytes;
  bytes += STRING_QUOTES + base64Length(raw.cells.length);
  let evidenceBytes = Math.max(0, raw.evidence.length - 1);
  for (const cell of raw.evidence) evidenceBytes += BYTES_PER_NUMBER + cellEvidenceBytes(cell.evidence, cost);
  bytes += evidenceBytes;
  return bytes;
}

/**
 * Conservative upper bound on the resident working-set cost of a *not-yet-loaded*
 * committed section, used only for eviction planning (phase 5D2) — never for the
 * authoritative resident accounting, which stays in `VoxelMap.installLoadedSections`.
 *
 * `committed.bytes` is the on-disk `octet_length` of the stored JSON payload, which
 * already covers the section's actual palette/cells/observation JSON. The resident
 * billing (`estimateVoxelSectionResidentBytes`) additionally reserves, per section
 * and per cell, the fixed overheads this file uses (`SECTION_FIXED_BYTES`,
 * `CELL_FIXED_BYTES`, `OBSERVATION_FIXED_BYTES`, `BYTES_PER_NUMBER`, and the
 * worst-case `staleReason`), which the compact committed form does not carry. So
 * `committed.bytes + sectionOverhead + observedCells × cellOverhead` is a safe
 * over-estimate: it may over-evict slightly, never under-plan a load that then
 * fails the exact resident-byte check.
 *
 * `committed.bytes` and `residentSize().bytes` are different units (persisted
 * payload vs resident billing); this function is the planning bridge, and the two
 * are never compared directly.
 */
export function estimateVoxelSectionResidentBytesFromCommitted(committed: {
  bytes: number;
  observedCells: number;
}): number {
  return (
    committed.bytes +
    RESIDENT_COMMITTED_SECTION_OVERHEAD +
    committed.observedCells * RESIDENT_COMMITTED_CELL_OVERHEAD
  );
}

/** Fixed per-section delta the resident billing adds over the committed payload. */
const RESIDENT_COMMITTED_SECTION_OVERHEAD = SECTION_FIXED_BYTES + 2 * BYTES_PER_NUMBER;
/** Fixed per-cell delta the resident billing adds over the committed payload (a generous upper bound). */
const RESIDENT_COMMITTED_CELL_OVERHEAD =
  CELL_FIXED_BYTES +
  OBSERVATION_FIXED_BYTES +
  5 * BYTES_PER_NUMBER +
  2 * STRING_QUOTES +
  WORST_CASE_STALE_REASON.length +
  'STALE'.length;
