/**
 * Versioned persisted form of one voxel section (design §4 / §9).
 *
 * v2 stores the palette + packed cells + history/risk bitmaps + compact per-cell
 * evidence metadata. The block state is **not** repeated per cell: it is
 * reconstructed from `palette[cells[index]]`. `explored`/`stale` are persisted
 * explicitly for a fast, self-contained decode; they must agree with the
 * evidence and are re-derived on restore.
 *
 * v1 payloads (the previous format, where each evidence record embedded a full
 * observation) are still decoded: their state is validated against the palette
 * and then dropped. This module is the integration point for persistence; the
 * SQLite worker must switch its encoder/decoder to these functions to persist
 * v2 (including the history bitmaps).
 */

import {
  SECTION_CELL_COUNT,
  VOXEL_SECTION_PAYLOAD_VERSION,
} from '../constants.js';
import type { EvidenceKind, Freshness, ObservationSource } from '../observation/types.js';
import { serializeBlockState } from './blockstate.js';
import { bitsRequired, readCell, setBit } from './palette.js';
import type { SectionKey } from './section.js';
import type {
  VoxelCellEvidenceSnapshot,
  VoxelCellSnapshot,
  VoxelSectionSnapshot,
} from './snapshot.js';

/** Persisted cell metadata; the state lives in the palette. */
export interface VoxelCellPayloadV2 {
  /** Local cell index. */
  i: number;
  /** `stateComplete`. */
  sc: boolean;
  /** Evidence kind. */
  e: EvidenceKind;
  /** observedAt. */
  at: number;
  /** observedWorldTick (present only when actually observed). */
  wt?: number;
  /** Observation source. */
  s: ObservationSource;
  /** Session id. */
  ses: string;
  /** originObservationId. */
  oid?: number;
  /** Boundary receive sequence. */
  seq: number;
  /** Confirmed action id, only for confirmed_effect evidence. */
  act?: string;
  /** Cell evidence revision. */
  r: number;
  /** Freshness. */
  f: Freshness;
  /** Stale reason. */
  sr?: VoxelCellEvidenceSnapshot['staleReason'];
  /** Evidence validity ceiling. */
  vu: number;
}

/** Persisted v2 section payload. */
export interface VoxelSectionPayloadV2 {
  v: typeof VOXEL_SECTION_PAYLOAD_VERSION;
  dim: string;
  cx: number;
  cz: number;
  sy: number;
  palette: string[];
  bits: number;
  /** base64 of the bit-packed cell stream. */
  cells: string;
  /** base64 4096-bit bitmaps. */
  explored: string;
  traversed: string;
  stale: string;
  risk: string;
  modified: string;
  evidence: VoxelCellPayloadV2[];
  revision: number;
}

const BITMAP_BYTES = SECTION_CELL_COUNT / 8;

/** Encode one snapshot section as its v2 persisted payload. */
export function encodeVoxelSectionPayload(section: VoxelSectionSnapshot): VoxelSectionPayloadV2 {
  const explored = new Uint8Array(BITMAP_BYTES);
  const stale = new Uint8Array(BITMAP_BYTES);
  for (const cell of section.evidence) {
    setBit(explored, cell.index, true);
    if (cell.evidence.freshness === 'STALE') setBit(stale, cell.index, true);
  }
  return {
    v: VOXEL_SECTION_PAYLOAD_VERSION,
    dim: section.dim,
    cx: section.cx,
    cz: section.cz,
    sy: section.sy,
    palette: [...section.palette],
    bits: section.bits,
    cells: encodeBase64(section.cells),
    explored: encodeBase64(explored),
    traversed: encodeBase64(section.traversed ?? new Uint8Array(BITMAP_BYTES)),
    stale: encodeBase64(stale),
    risk: encodeBase64(section.risk ?? new Uint8Array(BITMAP_BYTES)),
    modified: encodeBase64(section.modified ?? new Uint8Array(BITMAP_BYTES)),
    evidence: section.evidence.map((cell) => ({
      i: cell.index,
      sc: cell.evidence.stateComplete,
      e: cell.evidence.evidence,
      at: cell.evidence.observedAt,
      wt: cell.evidence.observedWorldTick,
      s: cell.evidence.source,
      ses: cell.evidence.sessionId,
      oid: cell.evidence.originObservationId,
      seq: cell.evidence.sequence,
      act: cell.evidence.actionId,
      r: cell.evidence.revision,
      f: cell.evidence.freshness,
      sr: cell.evidence.staleReason,
      vu: cell.evidence.validUntil,
    })),
    revision: section.revision,
  };
}

/**
 * Decode a persisted payload (v2) or migrate a previous v1 payload into the
 * current in-memory snapshot form. Structural validation happens here; semantic
 * validation (scope, canonical state, revision sums) happens once in
 * `restoreVoxelSection`.
 */
export function decodeVoxelSectionPayload(payload: unknown): VoxelSectionSnapshot {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('voxel section payload must be an object');
  }
  const raw = payload as Record<string, unknown>;
  if (raw.v === 1) return migrateV1Payload(raw);
  if (raw.v !== VOXEL_SECTION_PAYLOAD_VERSION) {
    throw new Error(`unsupported voxel section payload version: ${String(raw.v)}`);
  }
  // Older 0.8.x builds wrote a v2 payload without the explicit explored/stale
  // bitmaps and with `e.observation` nested under each cell. It is still a v2
  // row, so migrate it rather than rejecting a database the agent already has.
  if (raw.explored === undefined) return migrateLegacyV2Payload(raw);
  const dim = requireString(raw.dim, 'dim');
  const cx = requireInteger(raw.cx, 'cx');
  const cz = requireInteger(raw.cz, 'cz');
  const sy = requireInteger(raw.sy, 'sy');
  const palette = requireStringArray(raw.palette, 'palette');
  const bits = requireInteger(raw.bits, 'bits');
  const revision = requireInteger(raw.revision, 'revision');
  const cells = decodeBase64(requireString(raw.cells, 'cells'));
  const explored = decodeBase64(requireString(raw.explored, 'explored'));
  const traversed = decodeBase64(requireString(raw.traversed, 'traversed'));
  const stale = decodeBase64(requireString(raw.stale, 'stale'));
  const risk = decodeBase64(requireString(raw.risk, 'risk'));
  const modified = decodeBase64(requireString(raw.modified, 'modified'));
  assertBitmapLength(explored, 'explored');
  assertBitmapLength(traversed, 'traversed');
  assertBitmapLength(stale, 'stale');
  assertBitmapLength(risk, 'risk');
  assertBitmapLength(modified, 'modified');
  if (bits !== bitsRequired(palette.length)) {
    throw new Error(`voxel section payload bits ${bits} does not match palette length ${palette.length}`);
  }
  if (cells.length !== Math.ceil((SECTION_CELL_COUNT * bits) / 8)) {
    throw new Error(`voxel section payload cells length ${cells.length} does not match bits ${bits}`);
  }
  if (!Array.isArray(raw.evidence)) {
    throw new Error('voxel section payload evidence must be an array');
  }
  const evidence = raw.evidence.map((cell) => decodeV2Cell(cell));
  return {
    dim,
    cx,
    cz,
    sy,
    palette,
    bits,
    cells,
    evidence,
    revision,
    traversed,
    modified,
    risk,
  };
}

function decodeV2Cell(raw: unknown): VoxelCellSnapshot {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('voxel cell payload must be an object');
  }
  const c = raw as Record<string, unknown>;
  const evidence: VoxelCellEvidenceSnapshot = {
    stateComplete: requireBoolean(c.sc, 'sc'),
    evidence: requireString(c.e, 'e') as EvidenceKind,
    observedAt: requireNumber(c.at, 'at'),
    observedWorldTick: optionalNumber(c.wt, 'wt'),
    source: requireString(c.s, 's') as ObservationSource,
    sessionId: requireString(c.ses, 'ses'),
    originObservationId: optionalInteger(c.oid, 'oid'),
    sequence: requireNumber(c.seq, 'seq'),
    actionId: c.act === undefined ? undefined : requireString(c.act, 'act'),
    revision: requireInteger(c.r, 'r'),
    freshness: requireString(c.f, 'f') as Freshness,
    staleReason: c.sr === undefined ? undefined : requireString(c.sr, 'sr') as VoxelCellEvidenceSnapshot['staleReason'],
    validUntil: requireNumber(c.vu, 'vu'),
  };
  return { index: requireInteger(c.i, 'i'), evidence };
}

/**
 * Migrate the legacy 0.8.x v2 payload: no explicit bitmaps, and each cell's
 * evidence still nested as `e.observation`. The state is reconstructed from the
 * palette on restore (and validated here when the legacy payload still carried
 * it). History bitmaps did not exist in that format, so they start empty.
 */
function migrateLegacyV2Payload(raw: Record<string, unknown>): VoxelSectionSnapshot {
  const dim = requireString(raw.dim, 'dim');
  const cx = requireInteger(raw.cx, 'cx');
  const cz = requireInteger(raw.cz, 'cz');
  const sy = requireInteger(raw.sy, 'sy');
  const palette = requireStringArray(raw.palette, 'palette');
  const bits = requireInteger(raw.bits, 'bits');
  const revision = requireInteger(raw.revision, 'revision');
  if (bits !== bitsRequired(palette.length)) {
    throw new Error(`voxel section payload bits ${bits} does not match palette length ${palette.length}`);
  }
  const cells = decodeBase64(requireString(raw.cells, 'cells'));
  if (!Array.isArray(raw.evidence)) {
    throw new Error('voxel section payload evidence must be an array');
  }
  const evidence: VoxelCellSnapshot[] = raw.evidence.map((cell) => {
    if (cell === null || typeof cell !== 'object') {
      throw new Error('voxel cell payload must be an object');
    }
    const c = cell as { i?: unknown; e?: unknown };
    const index = requireInteger(c.i, 'i');
    const stored = c.e;
    if (stored === null || typeof stored !== 'object') {
      throw new Error('legacy voxel cell evidence must be an object');
    }
    const legacy = stored as {
      observation?: {
        state?: Parameters<typeof serializeBlockState>[0];
        stateComplete?: unknown;
        evidence?: unknown;
        observedAt?: unknown;
        observedWorldTick?: unknown;
        source?: unknown;
        sessionId?: unknown;
        originObservationId?: unknown;
        sequence?: unknown;
        actionId?: unknown;
      };
      revision?: unknown;
      freshness?: unknown;
      staleReason?: unknown;
      validUntil?: unknown;
    };
    const observation = legacy.observation;
    if (observation === undefined) {
      throw new Error('legacy voxel cell evidence is missing its observation');
    }
    if (observation.state !== undefined) {
      const paletteIndex = readCell(cells, bits, index);
      if (palette[paletteIndex] !== serializeBlockState(observation.state)) {
        throw new Error(`voxel cell ${index} palette/evidence disagree`);
      }
    }
    const compact: VoxelCellEvidenceSnapshot = {
      stateComplete: observation.stateComplete as boolean,
      evidence: observation.evidence as EvidenceKind,
      observedAt: observation.observedAt as number,
      observedWorldTick: observation.observedWorldTick as number | undefined,
      source: observation.source as ObservationSource,
      sessionId: observation.sessionId as string,
      originObservationId: observation.originObservationId as number | undefined,
      sequence: observation.sequence as number,
      actionId: observation.actionId as string | undefined,
      revision: requireInteger(legacy.revision, 'revision'),
      freshness: legacy.freshness as Freshness,
      staleReason: legacy.staleReason as VoxelCellEvidenceSnapshot['staleReason'],
      validUntil: legacy.validUntil as number,
    };
    return { index, evidence: compact };
  });
  if (cells.length !== Math.ceil((SECTION_CELL_COUNT * bits) / 8)) {
    throw new Error(`voxel section payload cells length ${cells.length} does not match bits ${bits}`);
  }
  return { dim, cx, cz, sy, palette, bits, cells, evidence, revision };
}

/**
 * Migrate a previous v1 payload. v1 embedded the full observation in each
 * evidence record; its state must agree with the palette (checked here, while
 * the state is still present), after which it is dropped.
 */
function migrateV1Payload(raw: Record<string, unknown>): VoxelSectionSnapshot {
  const dim = requireString(raw.dim, 'dim');
  const cx = requireInteger(raw.cx, 'cx');
  const cz = requireInteger(raw.cz, 'cz');
  const sy = requireInteger(raw.sy, 'sy');
  const palette = requireStringArray(raw.palette, 'palette');
  const bits = requireInteger(raw.bits, 'bits');
  const revision = requireInteger(raw.revision, 'revision');
  if (bits !== bitsRequired(palette.length)) {
    throw new Error(`voxel section payload bits ${bits} does not match palette length ${palette.length}`);
  }
  const cells = decodeBase64(requireString(raw.cells, 'cells'));
  if (!Array.isArray(raw.evidence)) {
    throw new Error('voxel section payload evidence must be an array');
  }
  const evidence: VoxelCellSnapshot[] = raw.evidence.map((cell) => {
    if (cell === null || typeof cell !== 'object') {
      throw new Error('voxel cell payload must be an object');
    }
    const c = cell as { i?: unknown; e?: unknown };
    const index = requireInteger(c.i, 'i');
    const e = c.e;
    if (e === null || typeof e !== 'object') {
      throw new Error('voxel cell payload evidence must be an object');
    }
    const legacy = e as {
      observation?: {
        state?: Parameters<typeof serializeBlockState>[0];
        stateComplete?: unknown;
        evidence?: unknown;
        observedAt?: unknown;
        observedWorldTick?: unknown;
        source?: unknown;
        sessionId?: unknown;
        originObservationId?: unknown;
        sequence?: unknown;
        actionId?: unknown;
      };
      revision?: unknown;
      freshness?: unknown;
      staleReason?: unknown;
      validUntil?: unknown;
    };
    const observation = legacy.observation;
    if (observation === undefined) {
      // Already-compact v1 record written by the new snapshot through the old
      // worker. It uses the in-memory field names, not the short v2 payload names.
      const compact = e as Partial<VoxelCellEvidenceSnapshot>;
      if ('stateComplete' in compact || 'observedAt' in compact) {
        return {
          index,
          evidence: decodeV2Cell({
            i: index,
            sc: compact.stateComplete,
            e: compact.evidence,
            at: compact.observedAt,
            wt: compact.observedWorldTick,
            s: compact.source,
            ses: compact.sessionId,
            oid: compact.originObservationId,
            seq: compact.sequence,
            act: compact.actionId,
            r: compact.revision,
            f: compact.freshness,
            sr: compact.staleReason,
            vu: compact.validUntil,
          }).evidence,
        };
      }
      return decodeV2Cell({ ...(e as Record<string, unknown>), i: index });
    }
    if (observation.state === undefined) {
      throw new Error('voxel v1 cell evidence is missing its observation state');
    }
    const paletteIndex = readCell(cells, bits, index);
    if (palette[paletteIndex] !== serializeBlockState(observation.state)) {
      throw new Error(`voxel cell ${index} palette/evidence disagree`);
    }
    const compact: VoxelCellEvidenceSnapshot = {
      stateComplete: observation.stateComplete as boolean,
      evidence: observation.evidence as EvidenceKind,
      observedAt: observation.observedAt as number,
      observedWorldTick: observation.observedWorldTick as number | undefined,
      source: observation.source as ObservationSource,
      sessionId: observation.sessionId as string,
      originObservationId: observation.originObservationId as number | undefined,
      sequence: observation.sequence as number,
      actionId: observation.actionId as string | undefined,
      revision: requireInteger(legacy.revision, 'revision'),
      freshness: legacy.freshness as Freshness,
      staleReason: legacy.staleReason as VoxelCellEvidenceSnapshot['staleReason'],
      validUntil: legacy.validUntil as number,
    };
    return { index, evidence: compact };
  });
  if (cells.length !== Math.ceil((SECTION_CELL_COUNT * bits) / 8)) {
    throw new Error(`voxel section payload cells length ${cells.length} does not match bits ${bits}`);
  }
  return { dim, cx, cz, sy, palette, bits, cells, evidence, revision };
}

// --- small structural helpers -------------------------------------------------

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`voxel section payload ${what} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`voxel section payload ${what} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, what: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`voxel section payload ${what} must be an integer`);
  }
  return value as number;
}

function optionalInteger(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : requireInteger(value, what);
}

function requireNumber(value: unknown, what: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`voxel section payload ${what} must be a finite number`);
  }
  return value as number;
}

function optionalNumber(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : requireNumber(value, what);
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`voxel section payload ${what} must be a non-empty array`);
  }
  return value.map((entry) => requireString(entry, `${what} entry`));
}

function assertBitmapLength(bytes: Uint8Array, what: string): void {
  if (bytes.length !== BITMAP_BYTES) {
    throw new Error(`voxel section payload ${what} bitmap must be ${BITMAP_BYTES} bytes`);
  }
}

/** Stable string id for one section within a world (used by the storage layer). */
export function voxelSectionPayloadId(key: SectionKey): string {
  return JSON.stringify([key.dim, key.cx, key.cz, key.sy]);
}

// --- base64 (pure JS; the core does not depend on Buffer) ----------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Map<string, number>(
  [...BASE64_ALPHABET].map((char, index) => [char, index]),
);

function encodeBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out.push(BASE64_ALPHABET[b0 >>> 2]!);
    out.push(BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4)]!);
    if (b1 === undefined) {
      out.push('==');
    } else {
      out.push(BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)]!);
      out.push(b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f]!);
    }
  }
  return out.join('');
}

function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) {
    throw new Error('voxel section payload base64 length is not a multiple of 4');
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const c0 = base64Value(text[i]!);
    const c1 = base64Value(text[i + 1]!);
    const c2 = text[i + 2] === '=' ? 0 : base64Value(text[i + 2]!);
    const c3 = text[i + 3] === '=' ? 0 : base64Value(text[i + 3]!);
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (offset < out.length) out[offset++] = (triple >>> 16) & 0xff;
    if (offset < out.length) out[offset++] = (triple >>> 8) & 0xff;
    if (offset < out.length) out[offset++] = triple & 0xff;
  }
  return out;
}

function base64Value(char: string): number {
  const value = BASE64_INDEX.get(char);
  if (value === undefined) {
    throw new Error(`voxel section payload has an invalid base64 character "${char}"`);
  }
  return value;
}
