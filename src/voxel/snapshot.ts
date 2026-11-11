/**
 * Voxel map checkpoint snapshot, byte measurement, and restore format (phase 5B).
 *
 * `VoxelMap` persists only its authoritative facts — the sections that actually
 * exist and the cells that were actually observed — through a deep-copied,
 * versioned, structured-clone-safe snapshot.
 *
 * Persisted evidence does **not** embed a full blockstate per cell (design §4):
 * the palette + packed cell stream already identify the state, so each cell
 * carries only completion/evidence metadata and the state is reconstructed from
 * the palette on restore. History bitmaps (`traversed` / `modified` / `risk`) and
 * the derived `explored` / `stale` bitmaps are part of the snapshot; a v1
 * snapshot (no history bitmaps, full state in evidence) is still accepted and
 * migrates to empty history.
 *
 * On restore, previously-`FRESH` evidence is uniformly re-marked `STALE` (it was
 * fresh in a *past* session, not now). Restored observations keep their original
 * timestamps, session, source and action attribution.
 */

import { jsonEscapedByteLength } from '../bytes.js';
import { SECTION_CELL_COUNT, SECTION_SIZE } from '../constants.js';
import { cloneCellEvidence, cloneObservation } from '../observation/clone.js';
import type {
  CellEvidence,
  EvidenceKind,
  Freshness,
  Observation,
  ObservationSource,
} from '../observation/types.js';
import { validateObservation } from '../observation/validate.js';
import { AIR_BLOCK_NAME, deserializeBlockState, serializeBlockState } from './blockstate.js';
import { blockToSection, cellIndex } from './coordinates.js';
import { bitsRequired, readCell, setBit } from './palette.js';
import type { Section } from './section.js';

export { cloneCellEvidence, cloneObservation };

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

/**
 * Compact per-cell evidence metadata (design §4). The block state itself is not
 * duplicated here: `palette[cells[index]]` identifies it.
 */
export interface VoxelCellEvidenceSnapshot {
  stateComplete: boolean;
  evidence: EvidenceKind;
  observedAt: number;
  observedWorldTick?: number;
  source: ObservationSource;
  sessionId: string;
  originObservationId?: number;
  sequence: number;
  actionId?: string;
  revision: number;
  freshness: Freshness;
  staleReason?: CellEvidence['staleReason'];
  validUntil: number;
}

/** Deep-copied evidence metadata at one local cell index. */
export interface VoxelCellSnapshot {
  index: number;
  evidence: VoxelCellEvidenceSnapshot;
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
  /** Per-cell evidence metadata, keyed by local cell index. */
  evidence: VoxelCellSnapshot[];
  revision: number;
  /** Cells the agent walked/stood on (optional: absent in v1 snapshots). */
  traversed?: Uint8Array;
  /** Cells the agent dug/placed (optional: absent in v1 snapshots). */
  modified?: Uint8Array;
  /** Derived current risk candidates (optional: absent in v1 snapshots). */
  risk?: Uint8Array;
  /** Legacy retired revision (optional; absent means 0). Preserved when reading old snapshots. */
  retiredRevision?: number;
}

/** Deep-copied, world-scoped snapshot of the voxel map's full observed state. */
export interface VoxelCheckpointSnapshot {
  worldId: string;
  /** Snapshot schema version; absent means v1 (full state in evidence, no history). */
  schemaVersion?: number;
  sections: VoxelSectionSnapshot[];
}

// --- deep copy ---------------------------------------------------------------

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
    ...(section.retiredRevision ? { retiredRevision: section.retiredRevision } : {}),
    evidence: [...section.evidence].map(([index, evidence]) => ({
      index,
      evidence: {
        stateComplete: evidence.observation.stateComplete,
        evidence: evidence.observation.evidence,
        observedAt: evidence.observation.observedAt,
        observedWorldTick: evidence.observation.observedWorldTick,
        source: evidence.observation.source,
        sessionId: evidence.observation.sessionId,
        originObservationId: evidence.observation.originObservationId,
        sequence: evidence.observation.sequence,
        actionId: evidence.observation.actionId,
        revision: evidence.revision,
        freshness: evidence.freshness,
        staleReason: evidence.staleReason,
        validUntil: evidence.validUntil,
      },
    })),
    revision: section.revision,
    traversed: section.traversed.slice(),
    modified: section.modified.slice(),
    risk: section.risk.slice(),
  };
}

// --- restore: validation + reconstruction --------------------------------------

type StaleReason = NonNullable<CellEvidence['staleReason']>;

/** The single runtime list of known stale reasons, shared with `VoxelMap.markStale`. */
export const STALE_REASONS = [
  'unloaded',
  'observation_gap',
  'expired',
  'pending_effect',
  'conflict',
] as const satisfies readonly StaleReason[];

// Compile-time exhaustiveness: adding a `StaleReason` without listing it above
// makes `MissingStaleReason` non-`never` and fails the constraint.
type MissingStaleReason = Exclude<StaleReason, (typeof STALE_REASONS)[number]>;
type AssertNever<T extends never> = T;
type _AllStaleReasonsListed = AssertNever<MissingStaleReason>;
/** Longest known stale reason, used to bill the worst-case resident footprint. */
const WORST_CASE_STALE_REASON = 'observation_gap';

/**
 * Rebuild one live section from its snapshot form, validating structure, scope,
 * coordinate ownership and palette/cells/evidence consistency, and re-marking any
 * previously-`FRESH` evidence as `STALE` (`observation_gap`). `explored`/`stale`
 * are reconstructed from evidence; `traversed`/`modified`/`risk` are restored from
 * the snapshot (empty when absent, i.e. a v1 snapshot).
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

  const bitmapBytes = SECTION_CELL_COUNT / 8;
  const traversed = restoreBitmap(raw.traversed, 'traversed', bitmapBytes);
  const modified = restoreBitmap(raw.modified, 'modified', bitmapBytes);
  const risk = restoreBitmap(raw.risk, 'risk', bitmapBytes);

  // Storage may still hand back a v1 payload whose per-cell evidence embeds the
  // full observation. Normalize both forms here, at the data boundary.
  const rawCells = raw.evidence as unknown as readonly (VoxelCellSnapshot | LegacyVoxelCellSnapshot)[];

  const evidenceMap = new Map<number, CellEvidence>();
  let revisionSum = 0;
  let lastObservedAt: number | undefined;
  for (const cell of rawCells) {
    const index = (cell as { index?: unknown } | null)?.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= SECTION_CELL_COUNT) {
      throw new Error(`voxel cell index out of range: ${String(index)}`);
    }
    if (evidenceMap.has(index as number)) {
      throw new Error(`duplicate voxel cell index ${String(index)} in section`);
    }
    const legacy = legacyCellEvidence(cell);
    const evidence = legacy === null
      ? restoreCompactCell(worldId, raw, index as number, cells, raw.bits, raw.palette, (cell as VoxelCellSnapshot).evidence)
      : restoreLegacyCell(worldId, raw, index as number, cells, raw.bits, raw.palette, legacy);
    evidenceMap.set(index as number, evidence);
    revisionSum += evidence.revision;
    const at = evidence.observation.observedAt;
    lastObservedAt = lastObservedAt === undefined ? at : Math.max(lastObservedAt, at);
  }
  // section.revision counts every insert/changed/restored/staled event, which is
  // exactly the sum of the per-cell evidence revisions plus what observation
  // retention retired together with the forgotten cells.
  const retired = raw.retiredRevision ?? 0;
  if (!Number.isInteger(retired) || retired < 0) {
    throw new Error(`voxel section retiredRevision must be a non-negative integer: ${String(raw.retiredRevision)}`);
  }
  if (raw.revision !== revisionSum + retired) {
    throw new Error(`voxel section revision ${raw.revision} disagrees with evidence revisions (${revisionSum}) plus retired (${retired})`);
  }

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
    traversed,
    stale,
    risk,
    modified,
    evidence: evidenceMap,
    revision: raw.revision,
  };
  if (lastObservedAt !== undefined) section.lastObservedAt = lastObservedAt;
  if (retired > 0) section.retiredRevision = retired;
  return section;
}

/** Reconstruct a v2 compact cell: state comes from the palette, position from the index. */
function restoreCompactCell(
  worldId: string,
  section: Pick<VoxelSectionSnapshot, 'dim' | 'cx' | 'cz' | 'sy'>,
  index: number,
  cells: Uint8Array,
  bits: number,
  palette: string[],
  raw: VoxelCellEvidenceSnapshot,
): CellEvidence {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('voxel cell evidence must be an object');
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

  const paletteIndex = readCell(cells, bits, index);
  const serialized = palette[paletteIndex];
  if (serialized === undefined) {
    throw new Error(`voxel cell ${index} palette index ${paletteIndex} is out of range`);
  }
  const state = deserializeBlockState(serialized);
  if (serializeBlockState(state) !== serialized) {
    throw new Error(`voxel cell ${index} palette entry is not canonical: "${serialized}"`);
  }
  const lx = index % SECTION_SIZE;
  const lz = Math.floor(index / SECTION_SIZE) % SECTION_SIZE;
  const ly = Math.floor(index / (SECTION_SIZE * SECTION_SIZE));
  const observation: Observation = {
    pos: {
      x: section.cx * SECTION_SIZE + lx,
      y: section.sy * SECTION_SIZE + ly,
      z: section.cz * SECTION_SIZE + lz,
    },
    state,
    stateComplete: raw.stateComplete,
    evidence: raw.evidence,
    observedAt: raw.observedAt,
    observedWorldTick: raw.observedWorldTick,
    source: raw.source,
    sessionId: raw.sessionId,
    originObservationId: raw.originObservationId,
    sequence: raw.sequence,
    actionId: raw.actionId,
    dim: section.dim,
    worldId,
  };
  validateObservation(worldId, observation);

  // Spatial evidence does not age across restores: keep the saved freshness.
  return {
    observation: cloneObservation(observation),
    revision: raw.revision,
    freshness: raw.freshness,
    ...(raw.staleReason === undefined ? {} : { staleReason: raw.staleReason }),
    validUntil: raw.validUntil,
  };
}

/** v1 cell evidence embedded the whole observation; keep that migration path. */
interface LegacyVoxelCellSnapshot {
  index: number;
  evidence: CellEvidence;
}

function legacyCellEvidence(cell: unknown): CellEvidence | null {
  if (cell === null || typeof cell !== 'object') return null;
  const evidence = (cell as { evidence?: unknown }).evidence;
  if (evidence === null || typeof evidence !== 'object' || !('observation' in evidence)) return null;
  return evidence as CellEvidence;
}

/** Validate one v1 cell's evidence and apply the FRESH → STALE initialization rule. */
function restoreLegacyCell(
  worldId: string,
  section: Pick<VoxelSectionSnapshot, 'dim' | 'cx' | 'cz' | 'sy'>,
  index: number,
  cells: Uint8Array,
  bits: number,
  palette: string[],
  raw: CellEvidence,
): CellEvidence {
  const observation = validateLegacyObservation(worldId, section.dim, raw.observation);
  // The evidence must belong to exactly this section and this local cell: its dim
  // and its position-decomposed section/cell index must all agree, or a snapshot
  // could smuggle an out-of-section / out-of-dimension observation into a cell.
  const coords = blockToSection(observation.pos.x, observation.pos.y, observation.pos.z);
  if (coords.cx !== section.cx || coords.cz !== section.cz || coords.sy !== section.sy) {
    throw new Error(`voxel cell ${index} observation position does not belong to section (${section.cx}, ${section.cz}, ${section.sy})`);
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

  return {
    observation,
    revision: raw.revision,
    freshness: raw.freshness,
    ...(raw.staleReason === undefined ? {} : { staleReason: raw.staleReason }),
    validUntil: raw.validUntil,
  };
}

/** Validate the structure and scope of one v1 restored observation. */
function validateLegacyObservation(worldId: string, dim: string, obs: Observation): Observation {
  validateObservation(worldId, obs);
  if (obs.dim !== dim) {
    throw new Error(`voxel observation dim "${obs.dim}" does not match section dim "${dim}"`);
  }
  return cloneObservation(obs);
}

function restoreBitmap(raw: unknown, name: string, expectedLength: number): Uint8Array {
  if (raw === undefined) return new Uint8Array(expectedLength);
  if (!(raw instanceof Uint8Array) || raw.length !== expectedLength) {
    throw new Error(`voxel section ${name} bitmap must be a ${expectedLength}-byte Uint8Array`);
  }
  return raw.slice();
}

// --- byte estimation (conservative upper bound; no copy or full stringify) -----

// Worst-case JSON decimal for a JS double; surrounding quotes for each string.
const BYTES_PER_NUMBER = 24;
const STRING_QUOTES = 2;
// Fixed structural overhead for each object: field names, braces, colons.
const SECTION_FIXED_BYTES = 320;
const CELL_FIXED_BYTES = 120;
const OBSERVATION_FIXED_BYTES = 220;
const BITMAP_FIELDS = 5; // explored, traversed, stale, risk, modified
/**
 * Fixed per-observation allowance for `dim` + `worldId`. Both the live-section
 * resident billing and the committed-snapshot resident billing use this same
 * constant, so the two estimators stay byte-for-byte comparable even though a
 * persisted section snapshot does not repeat the world id. It is conservative
 * for realistic scopes.
 */
const SCOPE_BYTES = 256;

type StringCost = (s: string) => number;

/** `ceil(n/3) * 4` — the length of a base64 encoding of `n` bytes. */
function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

const BITMAP_BASE64_BYTES = BITMAP_FIELDS * (STRING_QUOTES + base64Length(SECTION_CELL_COUNT / 8));

/** Fixed byte cost of the five persisted/resident 4096-bit bitmaps. */
function bitmapBytes(): number {
  return BITMAP_BASE64_BYTES;
}

/** Conservative bytes for one persisted v2 cell (metadata only; state is in the palette). */
function compactCellBytes(cell: VoxelCellEvidenceSnapshot, cost: StringCost): number {
  let bytes = CELL_FIXED_BYTES + 5 * BYTES_PER_NUMBER; // index, observedAt, sequence, revision, validUntil
  bytes += cost(cell.evidence) + STRING_QUOTES;
  bytes += cost(cell.source) + STRING_QUOTES;
  bytes += cost(cell.sessionId) + STRING_QUOTES;
  bytes += cost(cell.freshness) + STRING_QUOTES;
  bytes += cell.stateComplete ? 4 : 5;
  if (cell.observedWorldTick !== undefined) bytes += BYTES_PER_NUMBER;
  if (cell.originObservationId !== undefined) bytes += BYTES_PER_NUMBER;
  if (cell.actionId !== undefined) bytes += cost(cell.actionId) + STRING_QUOTES;
  if (cell.staleReason !== undefined) bytes += cost(cell.staleReason) + STRING_QUOTES;
  return bytes;
}

function paletteBytes(palette: readonly string[], cost: StringCost): number {
  let bytes = Math.max(0, palette.length - 1);
  for (const entry of palette) bytes += cost(entry) + STRING_QUOTES;
  return bytes;
}

/** Conservative persisted (v2) size of a live section. */
function compactSectionBytes(section: Section, cost: StringCost): number {
  let bytes = SECTION_FIXED_BYTES;
  bytes += cost(section.key.dim) + STRING_QUOTES;
  bytes += 3 * BYTES_PER_NUMBER; // cx, cz, sy
  bytes += BYTES_PER_NUMBER; // bits
  bytes += BYTES_PER_NUMBER; // revision
  bytes += paletteBytes(section.palette, cost);
  bytes += STRING_QUOTES + base64Length(section.cells.length);
  bytes += bitmapBytes();
  let evidenceBytes = Math.max(0, section.evidence.size - 1);
  for (const evidence of section.evidence.values()) {
    evidenceBytes += BYTES_PER_NUMBER + compactCellBytes(compactCellEvidence(evidence), cost);
  }
  bytes += evidenceBytes;
  return bytes;
}

function compactCellEvidence(evidence: CellEvidence): VoxelCellEvidenceSnapshot {
  return {
    stateComplete: evidence.observation.stateComplete,
    evidence: evidence.observation.evidence,
    observedAt: evidence.observation.observedAt,
    observedWorldTick: evidence.observation.observedWorldTick,
    source: evidence.observation.source,
    sessionId: evidence.observation.sessionId,
    originObservationId: evidence.observation.originObservationId,
    sequence: evidence.observation.sequence,
    actionId: evidence.observation.actionId,
    revision: evidence.revision,
    freshness: evidence.freshness,
    staleReason: evidence.staleReason,
    validUntil: evidence.validUntil,
  };
}

/** Conservative escaped-byte estimate of one persisted section payload. */
export function estimateVoxelSectionBytes(section: Section): number {
  return compactSectionBytes(section, jsonEscapedByteLength);
}

/** Cheap lower bound: UTF-16 `.length` (≤ UTF-8 bytes ≤ escaped bytes). */
export function voxelSectionLowerBound(section: Section): number {
  return compactSectionBytes(section, (s) => s.length);
}

/**
 * Conservative resident working-set estimate: full per-cell observation shape
 * (the live `Section` still keeps the state on every evidence record) plus the
 * history/risk bitmaps. A FRESH cell can later become STALE (markStale /
 * beginSession) without growing past its reservation.
 */
export function estimateVoxelSectionResidentBytes(section: Section): number {
  let bytes = SECTION_FIXED_BYTES;
  bytes += jsonEscapedByteLength(section.key.dim) + STRING_QUOTES;
  bytes += 3 * BYTES_PER_NUMBER;
  bytes += BYTES_PER_NUMBER; // bits
  bytes += BYTES_PER_NUMBER; // revision
  bytes += estimatePaletteResidentBytes(section.palette);
  bytes += STRING_QUOTES + base64Length(section.cells.length);
  bytes += bitmapBytes();
  let evidenceBytes = Math.max(0, section.evidence.size - 1);
  for (const evidence of section.evidence.values()) {
    evidenceBytes += cellEvidenceBytes(evidence, jsonEscapedByteLength, true);
  }
  bytes += evidenceBytes;
  return bytes;
}

/** Resident cost of one evidence entry, including its reserved stale metadata. */
export function estimateCellEvidenceResidentBytes(evidence: CellEvidence): number {
  return cellEvidenceBytes(evidence, jsonEscapedByteLength, true);
}

/** Resident palette-entry cost, excluding the separator between entries. */
export function estimatePaletteEntryResidentBytes(serialized: string): number {
  return jsonEscapedByteLength(serialized) + STRING_QUOTES;
}

/**
 * Resident cost of a whole palette array (entries plus the one separator per
 * extra entry). Shared by incremental accounting and compaction deltas so both
 * use exactly the same formula as `estimateVoxelSectionResidentBytes`.
 */
export function estimatePaletteResidentBytes(palette: readonly string[]): number {
  return paletteBytes(palette, jsonEscapedByteLength);
}

/** Resident cost of the packed cell stream at one palette width. */
export function estimatePackedCellsResidentBytes(bits: number): number {
  return STRING_QUOTES + base64Length(Math.ceil((SECTION_CELL_COUNT * bits) / 8));
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
  bytes += SCOPE_BYTES; // dim + worldId
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
  bytes += paletteBytes(raw.palette, cost);
  bytes += STRING_QUOTES + base64Length(raw.cells.length);
  bytes += bitmapBytes();
  let evidenceBytes = Math.max(0, raw.evidence.length - 1);
  for (const cell of raw.evidence) evidenceBytes += BYTES_PER_NUMBER + compactCellBytes(cell.evidence, cost);
  bytes += evidenceBytes;
  return bytes;
}

/**
 * Conservative upper bound on the resident working-set cost of a *not-yet-loaded*
 * committed section, used only for eviction planning (phase 5D2) — never for the
 * authoritative resident accounting, which stays in `VoxelMap.installLoadedSections`.
 *
 * `committed.bytes` is the on-disk `octet_length` of the stored payload. The
 * resident billing (`estimateVoxelSectionResidentBytes`) additionally reserves,
 * per section and per cell, the fixed overheads this file uses, which the compact
 * committed form does not carry. So `committed.bytes + fixed overhead` is a safe
 * over-estimate: it may over-evict slightly, never under-plan a load that then
 * fails the exact resident-byte check.
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

/**
 * Fixed per-section delta the resident billing adds over the committed payload,
 * including the five in-memory bitmaps (the compact committed payload stores them
 * base64, but they are billed here at their fixed field cost).
 */
const RESIDENT_COMMITTED_SECTION_OVERHEAD =
  SECTION_FIXED_BYTES + 2 * BYTES_PER_NUMBER + BITMAP_BASE64_BYTES;
/** Fixed per-cell delta the resident billing adds over the committed payload (a generous upper bound). */
const RESIDENT_COMMITTED_CELL_OVERHEAD =
  CELL_FIXED_BYTES +
  OBSERVATION_FIXED_BYTES +
  5 * BYTES_PER_NUMBER +
  SCOPE_BYTES +
  2 * STRING_QUOTES +
  WORST_CASE_STALE_REASON.length +
  'STALE'.length;

/**
 * Resident working-set cost of a *decoded* section snapshot, computed directly
 * from the persisted compact form (no full `restoreVoxelSection`). It rebuilds
 * the same per-cell evidence shape the live `Section` keeps (state from the
 * palette, position from the index) and uses the same `cellEvidenceBytes`
 * helper, so it matches `estimateVoxelSectionResidentBytes` byte-for-byte.
 */
export function estimateVoxelSectionResidentBytesFromSnapshot(raw: VoxelSectionSnapshot): number {
  const cost = jsonEscapedByteLength;
  let bytes = SECTION_FIXED_BYTES;
  bytes += cost(raw.dim) + STRING_QUOTES;
  bytes += 3 * BYTES_PER_NUMBER; // cx cz sy
  bytes += BYTES_PER_NUMBER; // bits
  bytes += BYTES_PER_NUMBER; // revision
  bytes += paletteBytes(raw.palette, cost);
  bytes += STRING_QUOTES + base64Length(raw.cells.length);
  bytes += bitmapBytes();
  let evidenceBytes = Math.max(0, raw.evidence.length - 1);
  for (const cell of raw.evidence) {
    const paletteIndex = readCell(raw.cells, raw.bits, cell.index);
    const serialized = raw.palette[paletteIndex];
    if (serialized === undefined) {
      throw new Error(`voxel cell ${cell.index} palette index ${paletteIndex} is out of range`);
    }
    const lx = cell.index % SECTION_SIZE;
    const lz = Math.floor(cell.index / SECTION_SIZE) % SECTION_SIZE;
    const ly = Math.floor(cell.index / (SECTION_SIZE * SECTION_SIZE));
    evidenceBytes += cellEvidenceBytes(
      {
        observation: {
          pos: {
            x: raw.cx * SECTION_SIZE + lx,
            y: raw.sy * SECTION_SIZE + ly,
            z: raw.cz * SECTION_SIZE + lz,
          },
          state: deserializeBlockState(serialized),
          stateComplete: cell.evidence.stateComplete,
          evidence: cell.evidence.evidence,
          observedAt: cell.evidence.observedAt,
          observedWorldTick: cell.evidence.observedWorldTick,
          source: cell.evidence.source,
          sessionId: cell.evidence.sessionId,
          originObservationId: cell.evidence.originObservationId,
          sequence: cell.evidence.sequence,
          actionId: cell.evidence.actionId,
          // Scope is billed at a fixed allowance; the persisted section snapshot
          // deliberately does not repeat the world id on every cell.
          dim: '',
          worldId: '',
        },
        revision: cell.evidence.revision,
        freshness: cell.evidence.freshness,
        staleReason: cell.evidence.staleReason,
        validUntil: cell.evidence.validUntil,
      },
      cost,
      true,
    );
  }
  bytes += evidenceBytes;
  return bytes;
}
