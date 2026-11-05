/**
 * Transient entity occupancy (design §5 item 5, §6.3).
 *
 * A player, mob or dropped item standing somewhere is short-lived working
 * memory, not terrain. Records:
 *
 * - are non-persistent (never written to checkpoints or SQLite);
 * - expire on their own TTL;
 * - never become a permanent `BLOCKED` edge or a stored block;
 * - are bounded, evicting the nearest-to-expiry record first.
 *
 * Leaving, expiry or losing observation removes the occupation on the next
 * read. Callers may still ask "is this cell occupied right now", but the answer
 * is never a durable world fact.
 */

import type { Vec3Like } from '../types.js';

export interface OccupancyObservationInput {
  /** Occupant identity when known (e.g. entity id); a stable key replaces its record. */
  key?: string;
  dim: string;
  pos: Vec3Like;
  /** Collision/occupancy radius around `pos`. Defaults to 0.5. */
  radius?: number;
  /** Caller-supplied provenance (e.g. `"entity_scan"`); opaque to the library. */
  source: string;
  /** Real observation time; defaults to the tracker's current time for this transient layer. */
  observedAt?: number;
  /** Time-to-live from `observedAt`. Defaults to the tracker default. */
  ttlMs?: number;
}

export interface OccupancyRecord {
  key: string;
  dim: string;
  pos: Vec3Like;
  radius: number;
  source: string;
  observedAt: number;
  expiresAt: number;
}

export interface OccupancyOptions {
  /** Clock used for expiry. Defaults to `Date.now`. */
  now?: () => number;
  /** Default TTL. Defaults to 3000 ms. */
  defaultTtlMs?: number;
  /** Bound on live records. Defaults to 256. */
  maxEntries?: number;
}

export interface OccupancyQuery {
  /** Extra query radius added to the record's radius. Defaults to 0. */
  radius?: number;
  /** Clock override for this read. */
  now?: number;
}

const DEFAULT_TTL_MS = 3000;
const DEFAULT_MAX_ENTRIES = 256;

export class TransientOccupancy {
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly records = new Map<string, OccupancyRecord>();

  constructor(options: OccupancyOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = resolvePositive(options.defaultTtlMs, DEFAULT_TTL_MS, 'defaultTtlMs');
    this.maxEntries = resolvePositive(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
  }

  /**
   * Record or replace one occupant. This is runtime observation state: it does
   * not touch the edge/fragment history and is never persisted.
   */
  observe(input: OccupancyObservationInput): OccupancyRecord {
    if (typeof input.dim !== 'string' || input.dim.length === 0) {
      throw new Error(`occupancy dim must be a non-empty string`);
    }
    assertFinitePoint(input.pos);
    if (typeof input.source !== 'string' || input.source.length === 0) {
      throw new Error(`occupancy source must be a non-empty string`);
    }
    const radius = input.radius ?? 0.5;
    if (!Number.isFinite(radius) || radius < 0) {
      throw new Error(`occupancy radius must be a non-negative finite number`);
    }
    const now = this.now();
    const observedAt = input.observedAt ?? now;
    if (!Number.isFinite(observedAt)) {
      throw new Error(`occupancy observedAt must be a finite number`);
    }
    const ttlMs = input.ttlMs === undefined
      ? this.defaultTtlMs
      : resolvePositive(input.ttlMs, this.defaultTtlMs, 'ttlMs');
    const key = input.key ?? `${input.dim}:${input.source}:${input.pos.x},${input.pos.y},${input.pos.z}`;
    const record: OccupancyRecord = {
      key,
      dim: input.dim,
      pos: { x: input.pos.x, y: input.pos.y, z: input.pos.z },
      radius,
      source: input.source,
      observedAt,
      expiresAt: observedAt + ttlMs,
    };
    this.records.set(key, record);
    this.evictOverflow();
    return cloneRecord(record);
  }

  /** Live occupants whose radius (plus query radius) contains `pos`. Sweeps expired records first. */
  occupants(dim: string, pos: Vec3Like, query: OccupancyQuery = {}): OccupancyRecord[] {
    assertFinitePoint(pos);
    const extra = query.radius ?? 0;
    if (!Number.isFinite(extra) || extra < 0) {
      throw new Error(`occupancy query radius must be a non-negative finite number`);
    }
    const now = query.now ?? this.now();
    this.sweep(now);
    return [...this.records.values()]
      .filter((record) => record.dim === dim && distance(record.pos, pos) <= record.radius + extra)
      .map(cloneRecord);
  }

  /** Whether any live occupant covers `pos`. */
  isOccupied(dim: string, pos: Vec3Like, query: OccupancyQuery = {}): boolean {
    return this.occupants(dim, pos, query).length > 0;
  }

  /** Remove expired records; returns how many were removed. */
  sweep(now = this.now()): number {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of live records after sweeping. */
  size(now = this.now()): number {
    this.sweep(now);
    return this.records.size;
  }

  /** Drop every transient record (world/session teardown). */
  clear(): void {
    this.records.clear();
  }

  private evictOverflow(): void {
    if (this.records.size <= this.maxEntries) return;
    const ordered = [...this.records.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt || a.observedAt - b.observedAt,
    );
    for (const record of ordered) {
      if (this.records.size <= this.maxEntries) break;
      if (this.records.get(record.key) === record) this.records.delete(record.key);
    }
  }
}

function resolvePositive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number: ${value}`);
  }
  return value;
}

function assertFinitePoint(p: Vec3Like): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    throw new Error(`occupancy position must have finite coordinates`);
  }
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cloneRecord(r: OccupancyRecord): OccupancyRecord {
  return {
    key: r.key,
    dim: r.dim,
    pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z },
    radius: r.radius,
    source: r.source,
    observedAt: r.observedAt,
    expiresAt: r.expiresAt,
  };
}
