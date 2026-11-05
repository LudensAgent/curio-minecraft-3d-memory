/**
 * Read-only compatibility view of Curio's legacy JSON spatial memory (design
 * §9.1 stage A).
 *
 * This module owns no storage and never rewrites the source snapshot. It reads
 * a caller-validated, JSON-shaped snapshot and reproduces the legacy query
 * projections (passage pagination / route geometry, landmark and ledger fields)
 * so a migration dry-run can compare "before" and "after" without inventing
 * fields, scope, observation times or deletion events.
 *
 * Deletion is explicit. A record absent from a migrated store is **not** a
 * deletion; only an id/key listed in `LegacyDeletionSet` is treated as deleted,
 * and such records are never resurrected from the still-present JSON snapshot.
 */

import { PASSAGE_LINK } from '../constants.js';
import type { Vec3Like } from '../types.js';

/** Re-exported for legacy callers; the value is single-sourced in `constants.ts`. */
export { PASSAGE_LINK };

export interface LegacyLink {
  a: Vec3Like;
  b: Vec3Like;
}

export interface LegacyPassageRecord {
  id: string;
  worldId?: string;
  dim: string;
  /** Missing kind keeps the legacy query default (`dug`). */
  kind?: 'dug' | 'walked' | 'bridge';
  entrances: Vec3Like[];
  path: Vec3Like[];
  links?: LegacyLink[];
  deepestY: number;
  /** Legacy-only fields retained for compatibility; not part of the new model. */
  dug: number;
  ores: Record<string, number>;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
}

export type LegacyLandmarkKind =
  | 'base'
  | 'resource'
  | 'danger'
  | 'discovery'
  | 'death'
  | 'waypoint'
  | 'herd';

export interface LegacyLandmark {
  id: string;
  worldId?: string;
  kind: LegacyLandmarkKind;
  label: string;
  dim: string;
  pos: Vec3Like;
  /** Creation/update time; not an observation time. */
  ts: number;
  /** Last actual observation time when the legacy record carried one. */
  observedAt?: number;
  primary?: boolean;
  count?: number;
  detail?: string;
  radius?: number;
  precise?: boolean;
}

export interface LegacyItemLine {
  name: string;
  count: number;
}

export interface LegacyChestContents {
  items: LegacyItemLine[];
  observedAt: number;
  day?: number;
  possiblyStale?: boolean;
  capacity?: number;
  freeSlots?: number;
  [extra: string]: unknown;
}

export interface LegacyChestRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  block: string;
  uses: number;
  ts: number;
  day?: number;
  note?: string;
  contents?: LegacyChestContents;
  /** Older imprecise shape; retained as-is, never expanded into item counts. */
  items?: LegacyItemLine[];
  traces?: LegacyItemLine[];
}

export interface LegacyFurnaceRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  block: string;
  input: LegacyItemLine | null;
  output: LegacyItemLine | null;
  fuel: LegacyItemLine | null;
  burning: boolean;
  why?: string;
  ts: number;
}

export interface LegacyFarmRecord {
  worldId?: string;
  id: string;
  dim: string;
  crop: string;
  cells: Vec3Like[];
  plantedAt: number;
  harvests: number;
}

export interface LegacyPlacedRecord {
  name: string;
  /** Legacy LRU serial, not a placement or observation time. */
  at: number;
}

export interface LegacyTravelEndpoint {
  id: string;
  worldId: string;
  dim: string;
  pos: Vec3Like;
  kind: 'nether_portal' | 'end_portal' | 'end_gateway';
  portalObserved: boolean;
  observedAt: number;
}

export interface LegacyTravelCrossing {
  fromId: string;
  toId: string;
  ts: number;
  fromSession: string;
  toSession: string;
  fromObservation: number;
  toObservation: number;
}

export interface LegacySpatialSnapshot {
  worldId: string;
  passages?: readonly LegacyPassageRecord[];
  landmarks?: readonly LegacyLandmark[];
  /** Keyed by the original `worldId:dim:x,y,z` key. */
  chests?: Readonly<Record<string, LegacyChestRecord>>;
  furnaces?: readonly LegacyFurnaceRecord[];
  farms?: readonly LegacyFarmRecord[];
  /** Keyed by the original `x,y,z` key. */
  placed?: Readonly<Record<string, LegacyPlacedRecord>>;
  travel?: {
    endpoints?: readonly LegacyTravelEndpoint[];
    traversals?: readonly LegacyTravelCrossing[];
    gateways?: readonly LegacyTravelCrossing[];
  };
}

/**
 * Explicit deletions for the dry-run. These are tombstones supplied by the
 * caller, not something inferred from a missing record.
 */
export interface LegacyDeletionSet {
  passageIds?: readonly string[];
  landmarkIds?: readonly string[];
  chestKeys?: readonly string[];
  furnaceKeys?: readonly string[];
  farmIds?: readonly string[];
  placedKeys?: readonly string[];
  endpointIds?: readonly string[];
}

export interface LegacyLedgerView {
  chests: Record<string, LegacyChestRecord>;
  furnaces: LegacyFurnaceRecord[];
  farms: LegacyFarmRecord[];
  placed: Record<string, LegacyPlacedRecord>;
  travel: {
    endpoints: LegacyTravelEndpoint[];
    traversals: LegacyTravelCrossing[];
    gateways: LegacyTravelCrossing[];
  };
}

export interface LegacySpatialReadBackend {
  passages(dim?: string): LegacyPassageRecord[];
  landmarks(): LegacyLandmark[];
  ledger(): LegacyLedgerView;
}

interface DeletionSets {
  passages: Set<string>;
  landmarks: Set<string>;
  chests: Set<string>;
  furnaces: Set<string>;
  farms: Set<string>;
  placed: Set<string>;
  endpoints: Set<string>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Old membership convention: a missing `worldId` belongs to the literal `default` scope. */
export function legacyRecordWorldId(record: { worldId?: string }): string {
  return record.worldId ?? 'default';
}

/** Identity used by the legacy ledger for position-keyed containers. */
export function legacyBlockKey(record: { worldId?: string; dim: string; pos: Vec3Like }): string {
  return `${legacyRecordWorldId(record)}:${record.dim}:${record.pos.x},${record.pos.y},${record.pos.z}`;
}

function deletionSets(deletions: LegacyDeletionSet | undefined): DeletionSets {
  return {
    passages: new Set(deletions?.passageIds ?? []),
    landmarks: new Set(deletions?.landmarkIds ?? []),
    chests: new Set(deletions?.chestKeys ?? []),
    furnaces: new Set(deletions?.furnaceKeys ?? []),
    farms: new Set(deletions?.farmIds ?? []),
    placed: new Set(deletions?.placedKeys ?? []),
    endpoints: new Set(deletions?.endpointIds ?? []),
  };
}

/**
 * Classify ids that exist in the source against the ids actually present in a
 * migrated store. `missing` and `deleted` are deliberately separate: absence
 * without a tombstone is a review problem, never an implicit deletion.
 */
export function classifyLegacyRecordKeys(
  sourceKeys: readonly string[],
  migratedKeys: readonly string[],
  deletedKeys: readonly string[],
): { present: string[]; deleted: string[]; missing: string[]; unexpected: string[]; resurrected: string[] } {
  const source = new Set(sourceKeys);
  const migrated = new Set(migratedKeys);
  const deleted = new Set(deletedKeys);
  return {
    present: sourceKeys.filter((key) => migrated.has(key) && !deleted.has(key)),
    deleted: sourceKeys.filter((key) => deleted.has(key)),
    missing: sourceKeys.filter((key) => !migrated.has(key) && !deleted.has(key)),
    unexpected: migratedKeys.filter((key) => !source.has(key) && !deleted.has(key)),
    resurrected: migratedKeys.filter((key) => deleted.has(key)),
  };
}

/**
 * Read the legacy snapshot through the old query surface. Every read returns a
 * deep copy, tombstoned records are omitted, and records outside the snapshot's
 * own world are never mixed in.
 */
export function createLegacyReadBackend(
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacySpatialReadBackend {
  const deleted = deletionSets(deletions);
  const worldId = snapshot.worldId;
  return {
    passages(dim) {
      return (snapshot.passages ?? [])
        .filter((rec) => legacyRecordWorldId(rec) === worldId)
        .filter((rec) => !deleted.passages.has(rec.id))
        .filter((rec) => dim === undefined || rec.dim === dim)
        .map(clone);
    },
    landmarks() {
      return (snapshot.landmarks ?? [])
        .filter((landmark) => legacyRecordWorldId(landmark) === worldId)
        .filter((landmark) => !deleted.landmarks.has(landmark.id))
        .map(clone);
    },
    ledger() {
      return {
        chests: Object.fromEntries(
          Object.entries(snapshot.chests ?? {})
            .filter(([key]) => !deleted.chests.has(key))
            .map(([key, value]) => [key, clone(value)]),
        ),
        furnaces: (snapshot.furnaces ?? [])
          .filter((furnace) => !deleted.furnaces.has(legacyBlockKey(furnace)))
          .map(clone),
        farms: (snapshot.farms ?? []).filter((farm) => !deleted.farms.has(farm.id)).map(clone),
        placed: Object.fromEntries(
          Object.entries(snapshot.placed ?? {})
            .filter(([key]) => !deleted.placed.has(key))
            .map(([key, value]) => [key, clone(value)]),
        ),
        travel: {
          endpoints: (snapshot.travel?.endpoints ?? [])
            .filter((endpoint) => !deleted.endpoints.has(endpoint.id))
            .map(clone),
          traversals: (snapshot.travel?.traversals ?? []).map(clone),
          gateways: (snapshot.travel?.gateways ?? []).map(clone),
        },
      };
    },
  };
}

const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Historical foot-point graph: real `links` first, legacy time-adjacency otherwise. */
export function passageGraph(
  recs: readonly Pick<LegacyPassageRecord, 'path' | 'links'>[],
  opts: { hop?: number; link?: number } = {},
): { nodes: Vec3Like[]; owner: number[]; edges: Map<number, Set<number>> } {
  const hop = opts.hop ?? 7;
  const link = opts.link ?? PASSAGE_LINK;
  const nodes: Vec3Like[] = [];
  const owner: number[] = [];
  const edges = new Map<number, Set<number>>();
  const add = (a: number, b: number): void => {
    if (a === b) return;
    let from = edges.get(a);
    if (from === undefined) {
      from = new Set();
      edges.set(a, from);
    }
    from.add(b);
    let to = edges.get(b);
    if (to === undefined) {
      to = new Set();
      edges.set(b, to);
    }
    to.add(a);
  };
  const indexOf = (p: Vec3Like, recIdx: number): number => {
    const found = nodes.findIndex((q) => q.x === p.x && q.y === p.y && q.z === p.z);
    if (found >= 0) return found;
    nodes.push(p);
    owner.push(recIdx);
    return nodes.length - 1;
  };

  recs.forEach((rec, recIdx) => {
    if (rec.links !== undefined && rec.links.length > 0) {
      for (const { a, b } of rec.links) add(indexOf(a, recIdx), indexOf(b, recIdx));
    } else {
      let prev = -1;
      for (const point of rec.path) {
        const index = indexOf(point, recIdx);
        if (prev >= 0 && d3(nodes[prev]!, point) <= hop) add(prev, index);
        prev = index;
      }
    }
  });

  // Fragment self-healing only spans records; one record never gets a
  // geometric shortcut through its own point order.
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (owner[i] !== owner[j] && d3(nodes[i]!, nodes[j]!) <= link) add(i, j);
    }
  }
  return { nodes, owner, edges };
}

/**
 * Legacy `passageRoute` semantics: nearest points within `near`, fewest-distance
 * path over the historical graph, point order preserved. Historical geometry
 * only; it never proves current traversability.
 */
export function passageRoute(
  recs: readonly Pick<LegacyPassageRecord, 'path' | 'links'>[],
  from: Vec3Like,
  to: Vec3Like,
  opts: { near?: number; hop?: number; link?: number } = {},
): Vec3Like[] | null {
  const near = opts.near ?? 5;
  const { nodes, edges } = passageGraph(recs, opts);
  const closest = (point: Vec3Like): number => {
    let best = -1;
    let bestDistance = Infinity;
    nodes.forEach((node, index) => {
      const distance = d3(node, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return bestDistance <= near ? best : -1;
  };
  const a = closest(from);
  const b = closest(to);
  if (a < 0 || b < 0) return null;
  if (a === b) return [nodes[a]!];

  const dist = new Array<number>(nodes.length).fill(Infinity);
  const prevOf = new Array<number>(nodes.length).fill(-1);
  const done = new Set<number>();
  dist[a] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i += 1) {
      if (!done.has(i) && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    }
    if (u < 0 || u === b) break;
    done.add(u);
    for (const v of edges.get(u) ?? []) {
      const next = dist[u]! + d3(nodes[u]!, nodes[v]!);
      if (next < dist[v]!) {
        dist[v] = next;
        prevOf[v] = u;
      }
    }
  }
  if (dist[b]! === Infinity) return null;
  const route: Vec3Like[] = [];
  for (let v = b; v >= 0; v = prevOf[v]!) route.unshift(nodes[v]!);
  return route;
}

export interface LegacyPassageQueryContext {
  worldId: string;
  dim: string;
  pos: Vec3Like;
}

const PASSAGE_QUERY_NOTE =
  '历史脚点已稀疏采样、去重或合并，不代表连续顺序或双向可走；地表参考点也不保证现在是入口。';

/**
 * Reproduce the old `{"kind":"passages"}` projection: list returns summaries,
 * read appends a 32-point page. Field names, ordering and pagination are frozen
 * against the legacy thinker branch.
 */
export function queryLegacyPassages(
  backend: LegacySpatialReadBackend,
  raw: Record<string, unknown>,
  context: LegacyPassageQueryContext,
): string {
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) {
    return 'id 需要非空的矿道记录 ID 字符串；不指定 id 可列出记录';
  }
  if (
    raw.offset !== undefined &&
    (typeof raw.offset !== 'number' || !Number.isSafeInteger(raw.offset) || raw.offset < 0)
  ) {
    return 'offset 需要非负整数，表示历史脚点的起始索引';
  }
  const id = raw.id as string | undefined;
  const offset = (raw.offset ?? 0) as number;
  if (id === undefined && raw.offset !== undefined) {
    return 'offset 需要与 id 一起使用；不指定 id 时列出矿道记录';
  }
  const scope = {
    worldId: context.worldId,
    dim: context.dim,
    historical: true,
    connectivity: 'unknown',
    note: PASSAGE_QUERY_NOTE,
  };
  const records = backend
    .passages(context.dim)
    .filter((rec) => legacyRecordWorldId(rec) === context.worldId)
    .map((rec) => {
      const nearest = rec.path.reduce<{ index: number; distance: number } | null>((best, point, index) => {
        const distance = Math.hypot(
          point.x - context.pos.x,
          point.y - context.pos.y,
          point.z - context.pos.z,
        );
        return best === null || distance < best.distance ? { index, distance } : best;
      }, null);
      return {
        rec,
        summary: {
          id: rec.id,
          kind: rec.kind ?? 'dug',
          surfaceReferences: rec.entrances,
          deepestY: rec.deepestY,
          createdAt: rec.createdAt,
          lastUsedAt: rec.lastUsedAt,
          dug: rec.dug,
          ores: rec.ores,
          pointCount: rec.path.length,
          nearestPointIndex: nearest?.index ?? null,
          distance: nearest?.distance ?? null,
        },
      };
    })
    .sort((a, b) => (a.summary.distance ?? Infinity) - (b.summary.distance ?? Infinity));
  if (id === undefined) {
    return JSON.stringify({ ...scope, action: 'list', records: records.map(({ summary }) => summary) });
  }
  const record = records.find(({ rec }) => rec.id === id.trim());
  if (record === undefined) {
    return JSON.stringify({
      ...scope,
      error: '当前世界和维度没有这个矿道记录',
      id: id.trim(),
    });
  }
  const points = record.rec.path.slice(offset, offset + 32);
  return JSON.stringify({
    ...scope,
    action: 'read',
    ...record.summary,
    path: points,
    offset,
    total: record.rec.path.length,
    nextOffset: offset + points.length < record.rec.path.length ? offset + points.length : null,
  });
}
