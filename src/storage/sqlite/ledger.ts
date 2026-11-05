/**
 * In-memory placement / chunk-visit / portal-crossing ledger (design §9, §9.1).
 *
 * The ledger is the runtime half of the three legacy ledgers that used to live in
 * `world-memory.json` (`.placed`, `visitedChunks`) and `travel-memory.json`
 * (`endpoints` / `traversals` / `gateways`). It is bound to exactly one world and
 * keeps no second persistence queue of its own: mutations are accepted in memory
 * immediately, and a `SpatialSession.checkpoint()` captures the complete ledger
 * snapshot into the same SQLite transaction as history, voxel and journal facts.
 *
 * Exact facts are never decayed. The legacy `at` counter is an LRU serial, not a
 * placement or observation time, and is preserved verbatim across save/restore.
 * Portal crossings keep the raw session, observation-id, endpoint and timestamp
 * evidence; `returnVerified` is derived from a reverse crossing, never stored as
 * current truth.
 */

import type { Vec3Like } from '../../types.js';
import {
  PersistenceError,
  resolveLedgerLimits,
} from './types.js';
import type {
  ChunkVisitRecord,
  LedgerLimits,
  LedgerSnapshot,
  PlacedBlockRecord,
  PortalEndpointEvidence,
  PortalTraversalDirection,
  PortalTraversalKind,
  PortalTraversalRecord,
  ResolvedLedgerLimits,
} from './types.js';

/** Canonical placement identity: `worldId:dim:x,y,z`. */
export function placedBlockKey(worldId: string, dim: string, x: number, y: number, z: number): string {
  return `${worldId}:${dim}:${x},${y},${z}`;
}

/** Canonical chunk-visit identity: `worldId:dim:cx:cz`. */
export function chunkVisitKey(worldId: string, dim: string, cx: number, cz: number): string {
  return `${worldId}:${dim}:${cx}:${cz}`;
}

export interface PortalTraversalInput {
  fromId: string;
  toId: string;
  ts: number;
  fromSession: string;
  toSession: string;
  fromObservation: number;
  toObservation: number;
  kind?: PortalTraversalKind;
  /** Raw orientation label; absence means the source did not distinguish it. */
  direction?: PortalTraversalDirection;
  /** Proven endpoint world. Derived from matching endpoint evidence when omitted. */
  worldId?: string;
  fromEndpoint?: PortalEndpointEvidence | null;
  toEndpoint?: PortalEndpointEvidence | null;
  source?: 'legacy' | 'live';
}

/**
 * Deterministic canonical identity for one crossing. The legacy travel file has no
 * crossing id, so this derives a stable one from the raw evidence instead of
 * inventing a synthetic time or random id.
 */
export function portalTraversalIdentity(input: {
  kind?: PortalTraversalKind;
  fromId: string;
  toId: string;
  ts: number;
  fromSession: string;
  toSession: string;
  fromObservation: number;
  toObservation: number;
}): string {
  return JSON.stringify([
    input.kind ?? 'traversal',
    input.fromId,
    input.toId,
    input.ts,
    input.fromSession,
    input.toSession,
    input.fromObservation,
    input.toObservation,
  ]);
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function invalid(message: string): PersistenceError {
  return new PersistenceError('invalid_argument', message);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${what} must be a non-empty string`);
  return value;
}

function requireTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${what} must be a finite number`);
  return value;
}

function requireInteger(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value)) throw invalid(`${what} must be a safe integer`);
  return value as number;
}

function requireName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${what} must be a non-empty string`);
  return value;
}

function floorPos(pos: Vec3Like, what: string): Vec3Like {
  if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) {
    throw invalid(`${what} must have finite coordinates`);
  }
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

const PORTAL_KINDS = ['nether_portal', 'end_portal', 'end_gateway'] as const;
const DIRECTIONS = ['outbound', 'return', 'unclassified'] as const;
const TRAVERSAL_KINDS = ['traversal', 'gateway'] as const;

function validateEndpoint(raw: unknown, what: string, maxBytes: number): PortalEndpointEvidence {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(`${what} must be an endpoint evidence object`);
  }
  const endpoint = raw as PortalEndpointEvidence;
  requireString(endpoint.id, `${what}.id`);
  requireString(endpoint.worldId, `${what}.worldId`);
  requireString(endpoint.dim, `${what}.dim`);
  if (!(PORTAL_KINDS as readonly string[]).includes(endpoint.kind)) {
    throw invalid(`${what}.kind is not a known portal kind: ${String(endpoint.kind)}`);
  }
  if (typeof endpoint.portalObserved !== 'boolean') throw invalid(`${what}.portalObserved must be a boolean`);
  requireTime(endpoint.observedAt, `${what}.observedAt`);
  const pos = endpoint.pos;
  if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.z)) {
    throw invalid(`${what}.pos must have finite coordinates`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(endpoint), 'utf8');
  if (bytes > maxBytes) {
    throw new PersistenceError('capacity', `${what} exceeds maxEndpointBytes (${bytes} > ${maxBytes})`);
  }
  // Endpoint positions are observed player positions; preserve them verbatim rather
  // than snapping them to the block grid.
  return {
    id: endpoint.id,
    worldId: endpoint.worldId,
    dim: endpoint.dim,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    kind: endpoint.kind,
    portalObserved: endpoint.portalObserved,
    observedAt: endpoint.observedAt,
  };
}

function endpointWorld(from: PortalEndpointEvidence | null, to: PortalEndpointEvidence | null): string | null {
  if (from !== null && to !== null) return from.worldId === to.worldId ? from.worldId : null;
  if (from !== null) return from.worldId;
  if (to !== null) return to.worldId;
  return null;
}

/**
 * World-bound in-memory ledger. Every mutation is a local acceptance, not a save;
 * the revision only advances when a fact (including an LRU refresh) actually
 * changes. Reads return isolated copies.
 */
export class LedgerStore {
  readonly worldId: string;
  private readonly limits: ResolvedLedgerLimits;
  private readonly placed = new Map<string, PlacedBlockRecord>();
  private readonly visits = new Map<string, ChunkVisitRecord>();
  private readonly traversals = new Map<string, PortalTraversalRecord>();
  private lruClock = 0;
  private revisionField = 0;
  /** Same-chunk repeat visits do not increment, matching the legacy counter. */
  private lastChunkKey: string | null = null;

  constructor(worldId: string, limits?: LedgerLimits) {
    this.worldId = requireString(worldId, 'ledger worldId');
    this.limits = resolveLedgerLimits(limits);
  }

  get revision(): number {
    return this.revisionField;
  }

  // --- placement ledger -------------------------------------------------------

  /** Record a confirmed own placement. Same-cell placement updates the name and LRU. */
  putPlaced(dim: string, pos: Vec3Like, name: string): PlacedBlockRecord {
    return this.place({
      dim: requireString(dim, 'placed dim'),
      pos,
      name: requireName(name, 'placed name'),
      lruAt: undefined,
      source: 'live',
    });
  }

  /**
   * Import one attributed legacy placement, preserving its original LRU serial and
   * its `legacy` provenance. The serial is never reinterpreted as a time.
   */
  importPlaced(input: {
    dim: string;
    pos: Vec3Like;
    name: string;
    lruAt: number;
    source?: 'legacy' | 'live';
  }): PlacedBlockRecord {
    return this.place({
      dim: requireString(input.dim, 'placed dim'),
      pos: input.pos,
      name: requireName(input.name, 'placed name'),
      lruAt: requireInteger(input.lruAt, 'placed lruAt'),
      source: input.source ?? 'legacy',
    });
  }

  private place(input: {
    dim: string;
    pos: Vec3Like;
    name: string;
    lruAt: number | undefined;
    source: 'legacy' | 'live';
  }): PlacedBlockRecord {
    const pos = floorPos(input.pos, 'placed pos');
    const key = placedBlockKey(this.worldId, input.dim, pos.x, pos.y, pos.z);
    const lruAt = input.lruAt ?? this.lruClock + 1;
    if (lruAt < 0) {
      throw new PersistenceError('data', `placed lruAt must be a non-negative integer: ${lruAt}`);
    }
    const existing = this.placed.get(key);
    if (existing === undefined && this.placed.size >= this.limits.maxPlacedBlocks) {
      throw new PersistenceError('capacity', `placed ledger exceeds maxPlacedBlocks (${this.placed.size})`);
    }
    // Only advance the order clock for a write that will actually be kept.
    this.lruClock = Math.max(this.lruClock, lruAt);
    const record: PlacedBlockRecord = {
      key,
      worldId: this.worldId,
      dim: input.dim,
      pos,
      name: input.name,
      lruAt,
      source: input.source,
    };
    if (
      existing !== undefined &&
      existing.name === record.name &&
      existing.lruAt === record.lruAt &&
      existing.source === record.source
    ) {
      return cloneRecord(existing);
    }
    this.placed.set(key, record);
    this.revisionField += 1;
    return cloneRecord(record);
  }

  getPlaced(dim: string, pos: Vec3Like): PlacedBlockRecord | null {
    const grid = floorPos(pos, 'placed pos');
    const key = placedBlockKey(this.worldId, requireString(dim, 'placed dim'), grid.x, grid.y, grid.z);
    const record = this.placed.get(key);
    return record === undefined ? null : cloneRecord(record);
  }

  /** Remove one own placement. A missing cell is a no-op. */
  removePlaced(dim: string, pos: Vec3Like): boolean {
    const grid = floorPos(pos, 'placed pos');
    const key = placedBlockKey(this.worldId, requireString(dim, 'placed dim'), grid.x, grid.y, grid.z);
    if (!this.placed.delete(key)) return false;
    this.revisionField += 1;
    return true;
  }

  /** All placements for this world, oldest LRU serial first. */
  placedBlocks(dim?: string): PlacedBlockRecord[] {
    return [...this.placed.values()]
      .filter((record) => dim === undefined || record.dim === dim)
      .sort((a, b) => a.lruAt - b.lruAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(cloneRecord);
  }

  /**
   * Placements within `radius` of `pos`, nearest first. Like the legacy query this
   * refreshes the LRU serial of returned cells (a lookup is a use); it never
   * changes names or positions.
   */
  queryPlacedNear(dim: string, pos: Vec3Like, radius: number): { record: PlacedBlockRecord; dist: number }[] {
    const grid = floorPos(pos, 'placed query pos');
    if (!Number.isFinite(radius) || radius < 0) throw invalid('placed query radius must be a non-negative number');
    const dimName = requireString(dim, 'placed dim');
    const hits: { record: PlacedBlockRecord; dist: number }[] = [];
    for (const record of this.placed.values()) {
      if (record.dim !== dimName) continue;
      const dist = Math.hypot(record.pos.x - grid.x, record.pos.y - grid.y, record.pos.z - grid.z);
      if (dist <= radius) hits.push({ record, dist });
    }
    hits.sort((a, b) => a.dist - b.dist || b.record.lruAt - a.record.lruAt);
    return hits.map((hit) => {
      const refreshed: PlacedBlockRecord = { ...hit.record, lruAt: this.lruClock + 1 };
      this.lruClock += 1;
      this.placed.set(refreshed.key, refreshed);
      this.revisionField += 1;
      return { record: cloneRecord(refreshed), dist: hit.dist };
    });
  }

  // --- chunk visits -----------------------------------------------------------

  /**
   * Enter one chunk. Consecutive calls for the same chunk do not increment, matching
   * the legacy counter; `first` is true only when the chunk had never been visited.
   */
  visitChunk(dim: string, cx: number, cz: number): { first: boolean; record: ChunkVisitRecord } {
    const dimName = requireString(dim, 'visit dim');
    const x = requireInteger(cx, 'visit cx');
    const z = requireInteger(cz, 'visit cz');
    const key = chunkVisitKey(this.worldId, dimName, x, z);
    const existing = this.visits.get(key);
    if (this.lastChunkKey === key) {
      if (existing === undefined) {
        throw new PersistenceError('data', `visit dedupe state references a missing chunk "${key}"`);
      }
      return { first: false, record: cloneRecord(existing) };
    }
    if (existing === undefined && this.visits.size >= this.limits.maxChunkVisits) {
      throw new PersistenceError('capacity', `visit ledger exceeds maxChunkVisits (${this.visits.size})`);
    }
    this.lastChunkKey = key;
    const record: ChunkVisitRecord = existing === undefined
      ? { key, worldId: this.worldId, dim: dimName, cx: x, cz: z, count: 1, source: 'live' }
      : { ...existing, count: existing.count + 1 };
    this.visits.set(key, record);
    this.revisionField += 1;
    return { first: existing === undefined, record: cloneRecord(record) };
  }

  /**
   * Import one exact historical visit count. Used by the migration rehearsal: the
   * value is preserved verbatim instead of being rebuilt from repeated visits, and
   * the same-chunk dedupe does not apply.
   */
  importVisit(
    dim: string,
    cx: number,
    cz: number,
    count: number,
    source: 'legacy' | 'live' = 'legacy',
  ): ChunkVisitRecord {
    const dimName = requireString(dim, 'visit dim');
    const x = requireInteger(cx, 'visit cx');
    const z = requireInteger(cz, 'visit cz');
    const value = requireInteger(count, 'visit count');
    if (value < 0) throw invalid('visit count must be non-negative');
    const key = chunkVisitKey(this.worldId, dimName, x, z);
    const existing = this.visits.get(key);
    if (existing === undefined && this.visits.size >= this.limits.maxChunkVisits) {
      throw new PersistenceError('capacity', `visit ledger exceeds maxChunkVisits (${this.visits.size})`);
    }
    const record: ChunkVisitRecord = { key, worldId: this.worldId, dim: dimName, cx: x, cz: z, count: value, source };
    if (existing !== undefined && existing.count === record.count && existing.source === record.source) {
      return cloneRecord(existing);
    }
    this.visits.set(key, record);
    this.revisionField += 1;
    return cloneRecord(record);
  }

  /** Enter the chunk containing a block position; consecutive repeats do not count. */
  visit(dim: string, pos: Vec3Like): { first: boolean; record: ChunkVisitRecord } {
    const grid = floorPos(pos, 'visit pos');
    return this.visitChunk(dim, Math.floor(grid.x / 16), Math.floor(grid.z / 16));
  }

  /** All visit counters for this world, deterministic key order. */
  chunkVisits(dim?: string): ChunkVisitRecord[] {
    return [...this.visits.values()]
      .filter((record) => dim === undefined || record.dim === dim)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(cloneRecord);
  }

  /** Count for one chunk (chunk coordinates). */
  chunkVisitCount(dim: string, cx: number, cz: number): number {
    return this.visits.get(chunkVisitKey(this.worldId, dim, cx, cz))?.count ?? 0;
  }

  /** Count-based novelty: mean of `1/sqrt(count+1)` over the 3×3 chunk neighbourhood. */
  novelty(dim: string, cx: number, cz: number): number {
    let sum = 0;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        sum += 1 / Math.sqrt(this.chunkVisitCount(dim, cx + dx, cz + dz) + 1);
      }
    }
    return sum / 9;
  }

  // --- portal crossings -------------------------------------------------------

  /**
   * Record one raw portal/gateway crossing. Both endpoints and every session /
   * observation-id / timestamp field are preserved verbatim; the direction is only
   * what the caller asserted (default `unclassified`).
   */
  recordPortalTraversal(input: PortalTraversalInput): PortalTraversalRecord {
    requireString(input.fromId, 'traversal fromId');
    requireString(input.toId, 'traversal toId');
    requireTime(input.ts, 'traversal ts');
    requireString(input.fromSession, 'traversal fromSession');
    requireString(input.toSession, 'traversal toSession');
    requireInteger(input.fromObservation, 'traversal fromObservation');
    requireInteger(input.toObservation, 'traversal toObservation');
    const kind = input.kind ?? 'traversal';
    if (!(TRAVERSAL_KINDS as readonly string[]).includes(kind)) {
      throw invalid(`traversal kind is not known: ${String(kind)}`);
    }
    const direction = input.direction ?? 'unclassified';
    if (!(DIRECTIONS as readonly string[]).includes(direction)) {
      throw invalid(`traversal direction is not known: ${String(direction)}`);
    }
    const fromEndpoint = input.fromEndpoint === undefined || input.fromEndpoint === null
      ? null
      : validateEndpoint(input.fromEndpoint, 'traversal fromEndpoint', this.limits.maxEndpointBytes);
    const toEndpoint = input.toEndpoint === undefined || input.toEndpoint === null
      ? null
      : validateEndpoint(input.toEndpoint, 'traversal toEndpoint', this.limits.maxEndpointBytes);
    if (fromEndpoint !== null && fromEndpoint.id !== input.fromId) {
      throw invalid('traversal fromEndpoint.id does not match fromId');
    }
    if (toEndpoint !== null && toEndpoint.id !== input.toId) {
      throw invalid('traversal toEndpoint.id does not match toId');
    }
    const derivedWorld = endpointWorld(fromEndpoint, toEndpoint);
    const world = input.worldId ?? derivedWorld ?? this.worldId;
    if (world !== this.worldId) {
      throw invalid(`traversal world "${world}" cannot be stored in ledger world "${this.worldId}"`);
    }
    if (fromEndpoint !== null && fromEndpoint.worldId !== this.worldId) {
      throw invalid('traversal fromEndpoint belongs to another world');
    }
    if (toEndpoint !== null && toEndpoint.worldId !== this.worldId) {
      throw invalid('traversal toEndpoint belongs to another world');
    }

    const id = portalTraversalIdentity({ ...input, kind });
    const record: PortalTraversalRecord = {
      id,
      worldId: this.worldId,
      kind,
      direction,
      fromId: input.fromId,
      toId: input.toId,
      ts: input.ts,
      fromSession: input.fromSession,
      toSession: input.toSession,
      fromObservation: input.fromObservation,
      toObservation: input.toObservation,
      fromEndpoint,
      toEndpoint,
      source: input.source ?? 'live',
    };
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (bytes > this.limits.maxBytes) {
      throw new PersistenceError('capacity', `portal traversal exceeds ledger maxBytes (${bytes})`);
    }
    const existing = this.traversals.get(id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new PersistenceError('conflict', `portal traversal "${id}" already exists with different evidence`);
      }
      return cloneRecord(existing);
    }
    if (this.traversals.size >= this.limits.maxPortalTraversals) {
      throw new PersistenceError('capacity', `portal ledger exceeds maxPortalTraversals (${this.traversals.size})`);
    }
    this.traversals.set(id, record);
    this.revisionField += 1;
    return cloneRecord(record);
  }

  /** Raw crossings, ascending timestamp then canonical id. */
  portalTraversals(options: { kind?: PortalTraversalKind; direction?: PortalTraversalDirection } = {}): PortalTraversalRecord[] {
    return [...this.traversals.values()]
      .filter((record) => options.kind === undefined || record.kind === options.kind)
      .filter((record) => options.direction === undefined || record.direction === options.direction)
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(cloneRecord);
  }

  /**
   * Whether a reverse crossing exists. This is derived from the raw records and is
   * never stored as a current connection fact.
   */
  portalReturnVerified(traversal: Pick<PortalTraversalRecord, 'kind' | 'fromId' | 'toId'>): boolean {
    for (const other of this.traversals.values()) {
      if (other.kind === traversal.kind && other.fromId === traversal.toId && other.toId === traversal.fromId) {
        return true;
      }
    }
    return false;
  }

  // --- snapshot / restore -----------------------------------------------------

  /** Complete world-scoped snapshot; arrays are isolated copies in a stable order. */
  snapshot(): LedgerSnapshot {
    return {
      worldId: this.worldId,
      placed: this.placedBlocks(),
      visits: this.chunkVisits(),
      traversals: this.portalTraversals(),
    };
  }

  /** Cheap, bounded pre-flight of what a checkpoint would send. */
  measure(): { placed: number; visits: number; traversals: number; bytes: number } {
    const snapshot = this.snapshot();
    return {
      placed: snapshot.placed.length,
      visits: snapshot.visits.length,
      traversals: snapshot.traversals.length,
      bytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    };
  }

  /**
   * Replace the in-memory ledger with a committed snapshot. Restore is a mutation
   * (it never resets the revision to a baseline), and every LRU serial, count and
   * timestamp is preserved verbatim.
   */
  restoreSnapshot(snapshot: LedgerSnapshot): void {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw invalid('ledger snapshot must be an object');
    }
    if (snapshot.worldId !== this.worldId) {
      throw invalid(`ledger snapshot worldId "${String(snapshot.worldId)}" does not match "${this.worldId}"`);
    }
    if (!Array.isArray(snapshot.placed) || !Array.isArray(snapshot.visits) || !Array.isArray(snapshot.traversals)) {
      throw invalid('ledger snapshot arrays are malformed');
    }
    if (snapshot.placed.length > this.limits.maxPlacedBlocks) {
      throw new PersistenceError('capacity', `ledger snapshot exceeds maxPlacedBlocks (${snapshot.placed.length})`);
    }
    if (snapshot.visits.length > this.limits.maxChunkVisits) {
      throw new PersistenceError('capacity', `ledger snapshot exceeds maxChunkVisits (${snapshot.visits.length})`);
    }
    if (snapshot.traversals.length > this.limits.maxPortalTraversals) {
      throw new PersistenceError('capacity', `ledger snapshot exceeds maxPortalTraversals (${snapshot.traversals.length})`);
    }

    const placed = new Map<string, PlacedBlockRecord>();
    let maxLru = 0;
    for (const raw of snapshot.placed) {
      if (raw === null || typeof raw !== 'object') throw invalid('ledger placed record must be an object');
      const dim = requireString(raw.dim, 'placed dim');
      const pos = floorPos(raw.pos, 'placed pos');
      const lruAt = requireInteger(raw.lruAt, 'placed lruAt');
      if (lruAt < 0) throw invalid('placed lruAt must be non-negative');
      if (raw.worldId !== this.worldId) throw invalid('ledger placed record belongs to another world');
      const key = placedBlockKey(this.worldId, dim, pos.x, pos.y, pos.z);
      if (raw.key !== key) throw invalid(`ledger placed key "${String(raw.key)}" does not match its coordinates`);
      if (placed.has(key)) throw invalid(`duplicate ledger placed key "${key}"`);
      placed.set(key, {
        key,
        worldId: this.worldId,
        dim,
        pos,
        name: requireName(raw.name, 'placed name'),
        lruAt,
        source: raw.source === 'legacy' ? 'legacy' : 'live',
      });
      maxLru = Math.max(maxLru, lruAt);
    }

    const visits = new Map<string, ChunkVisitRecord>();
    for (const raw of snapshot.visits) {
      if (raw === null || typeof raw !== 'object') throw invalid('ledger visit record must be an object');
      const dim = requireString(raw.dim, 'visit dim');
      const cx = requireInteger(raw.cx, 'visit cx');
      const cz = requireInteger(raw.cz, 'visit cz');
      const count = requireInteger(raw.count, 'visit count');
      if (count < 0) throw invalid('visit count must be non-negative');
      if (raw.worldId !== this.worldId) throw invalid('ledger visit record belongs to another world');
      const key = chunkVisitKey(this.worldId, dim, cx, cz);
      if (raw.key !== key) throw invalid(`ledger visit key "${String(raw.key)}" does not match its coordinates`);
      if (visits.has(key)) throw invalid(`duplicate ledger visit key "${key}"`);
      visits.set(key, { key, worldId: this.worldId, dim, cx, cz, count, source: raw.source === 'legacy' ? 'legacy' : 'live' });
    }

    const traversals = new Map<string, PortalTraversalRecord>();
    for (const raw of snapshot.traversals) {
      if (raw === null || typeof raw !== 'object') throw invalid('ledger traversal record must be an object');
      if (raw.worldId !== this.worldId) throw invalid('ledger traversal record belongs to another world');
      const validated = this.validateStoredTraversal(raw);
      if (traversals.has(validated.id)) throw invalid(`duplicate ledger traversal id "${validated.id}"`);
      traversals.set(validated.id, validated);
    }

    this.placed.clear();
    this.visits.clear();
    this.traversals.clear();
    for (const [key, record] of placed) this.placed.set(key, record);
    for (const [key, record] of visits) this.visits.set(key, record);
    for (const [key, record] of traversals) this.traversals.set(key, record);
    this.lruClock = maxLru;
    this.lastChunkKey = null;
    this.revisionField += 1;
  }

  private validateStoredTraversal(raw: PortalTraversalRecord): PortalTraversalRecord {
    requireString(raw.id, 'traversal id');
    requireString(raw.fromId, 'traversal fromId');
    requireString(raw.toId, 'traversal toId');
    requireTime(raw.ts, 'traversal ts');
    requireString(raw.fromSession, 'traversal fromSession');
    requireString(raw.toSession, 'traversal toSession');
    requireInteger(raw.fromObservation, 'traversal fromObservation');
    requireInteger(raw.toObservation, 'traversal toObservation');
    if (!(TRAVERSAL_KINDS as readonly string[]).includes(raw.kind)) {
      throw invalid(`traversal kind is not known: ${String(raw.kind)}`);
    }
    if (!(DIRECTIONS as readonly string[]).includes(raw.direction)) {
      throw invalid(`traversal direction is not known: ${String(raw.direction)}`);
    }
    const fromEndpoint = raw.fromEndpoint === null || raw.fromEndpoint === undefined
      ? null
      : validateEndpoint(raw.fromEndpoint, 'traversal fromEndpoint', this.limits.maxEndpointBytes);
    const toEndpoint = raw.toEndpoint === null || raw.toEndpoint === undefined
      ? null
      : validateEndpoint(raw.toEndpoint, 'traversal toEndpoint', this.limits.maxEndpointBytes);
    if (fromEndpoint !== null && fromEndpoint.id !== raw.fromId) throw invalid('stored traversal fromEndpoint.id mismatch');
    if (toEndpoint !== null && toEndpoint.id !== raw.toId) throw invalid('stored traversal toEndpoint.id mismatch');
    // Portal endpoints name a world too; a restore must not install another
    // world's endpoint evidence into this ledger.
    if (fromEndpoint !== null && fromEndpoint.worldId !== this.worldId) {
      throw invalid(`stored traversal fromEndpoint.worldId "${fromEndpoint.worldId}" does not match "${this.worldId}"`);
    }
    if (toEndpoint !== null && toEndpoint.worldId !== this.worldId) {
      throw invalid(`stored traversal toEndpoint.worldId "${toEndpoint.worldId}" does not match "${this.worldId}"`);
    }
    const id = portalTraversalIdentity({ ...raw, kind: raw.kind });
    if (id !== raw.id) throw invalid(`stored traversal id "${raw.id}" does not match its evidence`);
    return {
      id,
      worldId: this.worldId,
      kind: raw.kind,
      direction: raw.direction,
      fromId: raw.fromId,
      toId: raw.toId,
      ts: raw.ts,
      fromSession: raw.fromSession,
      toSession: raw.toSession,
      fromObservation: raw.fromObservation,
      toObservation: raw.toObservation,
      fromEndpoint,
      toEndpoint,
      source: raw.source === 'legacy' ? 'legacy' : 'live',
    };
  }
}
