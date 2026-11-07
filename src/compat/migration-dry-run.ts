/**
 * Offline legacy-migration dry-run (design §9.1 stages A–D).
 *
 * This module is a rehearsal harness, not a migration executor:
 * - it only reads a caller-supplied JSON-shaped snapshot;
 * - it imports the passage-geometry batch into a **temporary** SQLite database
 *   supplied by the caller (typically under `mkdtemp`);
 * - it never selects or switches a live persistence authority, never deletes a
 *   legacy write path, and never claims that real user data was migrated.
 *
 * The persistence session is injected (`openSession`) so this module does not
 * construct a Worker or touch the filesystem on its own.
 *
 * The report also carries an advisory JSON→SQLite authority gate
 * (`gate`). It is a structured, decidable condition list that can only report
 * `not_satisfied` or `satisfied_but_disabled`: no branch in this module opens a
 * real user database, writes both stores, falls back to JSON reads for missing
 * rows, or switches the persistence authority. See
 * `docs/legacy-migration-gate.md`.
 */

import type { FragmentChanges } from '../topology/fragment-store.js';
import type { PathFragment, TraversalEvidence } from '../topology/path-fragment.js';
import type { Vec3Like } from '../types.js';
import {
  classifyLegacyRecordKeys,
  createLegacyReadBackend,
  legacyChunkVisitKey,
  legacyRecordWorldId,
  normalizeLegacyPlaced,
  parseLegacyChunkVisitKey,
  passageRoute,
  queryLegacyPassages,
} from './legacy.js';
import type {
  LegacyDeletionSet,
  LegacyLedgerView,
  LegacyPassageQueryContext,
  LegacyPassageRecord,
  LegacyTravelCrossing,
  LegacyTravelEndpoint,
  LegacySpatialReadBackend,
  LegacySpatialSnapshot,
} from './legacy.js';
import { portalTraversalIdentity } from '../storage/sqlite/ledger.js';
import type { PortalTraversalInput } from '../storage/sqlite/ledger.js';
import type {
  ChunkVisitRecord,
  LedgerSnapshot,
  PlacedBlockRecord,
  PortalTraversalRecord,
} from '../storage/sqlite/types.js';

/**
 * The narrow passage-store surface a dry run needs. Declared structurally so a
 * Worker-backed session (built output) and a plain `FragmentStore` can both be
 * injected without nominal-class coupling.
 */
export interface DryRunPassageStore {
  readonly worldId: string;
  saveFragment(fragment: PathFragment): unknown;
  getFragment(id: string): PathFragment | null;
  forgetFragment(id: string): void;
  updateFragment(id: string, changes: FragmentChanges): unknown;
  checkpointSnapshot(): { fragments: PathFragment[]; traversals: TraversalEvidence[] };
  traversals(query?: { fragmentId?: string; dim?: string }): { total: number };
}

/**
 * The narrow ledger surface the dry run needs, declared structurally so a real
 * `LedgerStore` (or a fake with the same methods) can be injected.
 */
export interface DryRunLedgerStore {
  placedBlocks(): PlacedBlockRecord[];
  importPlaced(input: {
    dim: string;
    pos: Vec3Like;
    name: string;
    lruAt: number;
    source?: 'legacy' | 'live';
  }): PlacedBlockRecord;
  chunkVisits(): ChunkVisitRecord[];
  importVisit(
    dim: string,
    cx: number,
    cz: number,
    count: number,
    source?: 'legacy' | 'live',
  ): ChunkVisitRecord;
  portalTraversals(options?: {
    kind?: PortalTraversalRecord['kind'];
    direction?: PortalTraversalRecord['direction'];
  }): PortalTraversalRecord[];
  recordPortalTraversal(input: PortalTraversalInput): PortalTraversalRecord;
}

export interface DryRunSession {
  readonly history: DryRunPassageStore;
  readonly voxel: {
    checkpointSnapshot(): { sections: readonly unknown[] };
    sectionAt(dim: string, x: number, y: number, z: number): unknown | null;
  };
  /**
   * Placement / visit / portal ledger. Optional so older injected sessions keep
   * working; when absent those batches are reported as planned, never imported.
   */
  readonly ledger?: DryRunLedgerStore;
  checkpoint(): Promise<{ checkpointId: string }>;
  getPersistenceState(): { lifecycle: string; dirty: boolean };
  close(): Promise<{ completed: boolean }>;
}

export type DryRunSessionOpener = (options: {
  databasePath: string;
  worldId: string;
}) => Promise<DryRunSession>;

export interface LegacyMigrationQuery {
  dim: string;
  /** Query origin for the list/read projection. */
  pos: Vec3Like;
  /** Route endpoints for the `passageRoute` compatibility check. */
  from: Vec3Like;
  to: Vec3Like;
  route?: { near?: number; hop?: number; link?: number };
}

export interface LegacyMigrationDryRunOptions {
  /** Temporary database path owned by the caller (never a user database). */
  databasePath: string;
  snapshot: LegacySpatialSnapshot;
  query: LegacyMigrationQuery;
  openSession: DryRunSessionOpener;
  deletions?: LegacyDeletionSet;
  /**
   * Manual operator acknowledgement for a future authority switch. It is only
   * recorded in the gate report; this module never acts on it.
   */
  migrationGate?: LegacyMigrationGateRequest;
}

export interface LegacyMigrationGateRequest {
  /** Explicit acknowledgement required by the gate; never a switch trigger. */
  operatorOptIn?: boolean;
  /**
   * Plan-only batches (landmarks, portal endpoints) whose storage destination the
   * caller separately declares wired. Recorded as a gate condition; never acted on.
   */
  declaredMigratedBatches?: LegacyBatchName[];
}

export interface LegacyImportProblem {
  code:
    | 'missing_without_delete_marker'
    | 'unexpected_record'
    | 'resurrected_deleted_passage'
    | 'order_mismatch'
    | 'field_mismatch';
  id?: string;
  detail?: string;
}

export interface LegacyPassageImportResult {
  importedIds: string[];
  skippedDeletedIds: string[];
}

/**
 * Import the passage batch in source order. A record with no proven world scope
 * is rejected instead of being assigned to the store's world; a tombstoned id is
 * skipped (it may still be present in the JSON source).
 */
export function importLegacyPassages(
  history: Pick<DryRunPassageStore, 'worldId' | 'saveFragment'>,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacyPassageImportResult {
  const deleted = new Set(deletions.passageIds ?? []);
  const importedIds: string[] = [];
  const skippedDeletedIds: string[] = [];
  for (const rec of snapshot.passages ?? []) {
    if (deleted.has(rec.id)) {
      skippedDeletedIds.push(rec.id);
      continue;
    }
    if (rec.worldId !== history.worldId) {
      throw new Error(
        `legacy passage "${rec.id}" world scope "${rec.worldId ?? 'missing'}" cannot be imported into world "${history.worldId}"`,
      );
    }
    history.saveFragment({
      id: rec.id,
      worldId: rec.worldId,
      dim: rec.dim,
      kind: rec.kind ?? 'dug',
      entrances: clonePoints(rec.entrances),
      polyline: clonePoints(rec.path),
      // Legacy geometry is not traversal evidence: importing it never proves
      // the path was walked or that any segment is currently passable.
      geometrySource: 'legacy',
      links: rec.links?.map((link) => ({ a: { ...link.a }, b: { ...link.b } })),
      deepestY: rec.deepestY,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt,
      uses: rec.uses,
    });
    importedIds.push(rec.id);
  }
  return { importedIds, skippedDeletedIds };
}

function clonePoints(points: readonly Vec3Like[]): Vec3Like[] {
  return points.map((point) => ({ x: point.x, y: point.y, z: point.z }));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function passageMismatch(rec: LegacyPassageRecord, fragment: PathFragment): string | null {
  if (fragment.worldId !== rec.worldId) return `worldId ${fragment.worldId} != ${rec.worldId}`;
  if (fragment.dim !== rec.dim) return `dim ${fragment.dim} != ${rec.dim}`;
  if (fragment.kind !== (rec.kind ?? 'dug')) return `kind ${fragment.kind} != ${rec.kind ?? 'dug'}`;
  if (fragment.geometrySource !== 'legacy') return `geometrySource ${fragment.geometrySource} != legacy`;
  if (!sameJson(fragment.entrances, rec.entrances)) return 'entrances differ';
  if (!sameJson(fragment.polyline, rec.path)) return 'path point order/coordinates differ';
  if (!sameJson(fragment.links ?? null, rec.links ?? null)) return 'links differ';
  if (fragment.deepestY !== rec.deepestY) return `deepestY ${fragment.deepestY} != ${rec.deepestY}`;
  if (fragment.createdAt !== rec.createdAt) return `createdAt ${fragment.createdAt} != ${rec.createdAt}`;
  if (fragment.lastUsedAt !== rec.lastUsedAt) return `lastUsedAt ${fragment.lastUsedAt} != ${rec.lastUsedAt}`;
  if (fragment.uses !== rec.uses) return `uses ${fragment.uses} != ${rec.uses}`;
  return null;
}

/**
 * Check point-for-point that the store holds exactly the live legacy records:
 * stable ids, source order, path/links/coordinate order, scope, kind, uses and
 * original times. Explicit tombstones must stay absent; a mere absence without
 * a tombstone is reported as a problem and is not treated as a deletion.
 */
export function verifyLegacyPassageImport(
  history: Pick<DryRunPassageStore, 'checkpointSnapshot'>,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): {
  ok: boolean;
  problems: LegacyImportProblem[];
  sourceIds: string[];
  expectedIds: string[];
  importedIds: string[];
  restoredOrder: string[];
  retained: {
    id: string;
    createdAt: number;
    lastUsedAt: number;
    uses: number;
    deepestY: number;
    geometrySource: PathFragment['geometrySource'];
  }[];
} {
  const deleted = new Set(deletions.passageIds ?? []);
  const source = snapshot.passages ?? [];
  const fragments = history.checkpointSnapshot().fragments;
  const importedIds = fragments.map((fragment) => fragment.id);
  const classification = classifyLegacyRecordKeys(
    source.map((rec) => rec.id),
    importedIds,
    [...deleted],
  );
  const problems: LegacyImportProblem[] = [];
  for (const id of classification.missing) {
    problems.push({ code: 'missing_without_delete_marker', id });
  }
  for (const id of classification.unexpected) {
    problems.push({ code: 'unexpected_record', id });
  }
  for (const id of classification.resurrected) {
    problems.push({ code: 'resurrected_deleted_passage', id });
  }

  const expectedIds = source.filter((rec) => !deleted.has(rec.id)).map((rec) => rec.id);
  const expected = new Set(expectedIds);
  const restoredOrder = importedIds.filter((id) => expected.has(id));
  if (!sameJson(restoredOrder, expectedIds)) {
    problems.push({
      code: 'order_mismatch',
      detail: `restored ${restoredOrder.join(',')} != source ${expectedIds.join(',')}`,
    });
  }

  const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  for (const rec of source) {
    if (deleted.has(rec.id)) continue;
    const fragment = byId.get(rec.id);
    if (fragment === undefined) continue; // already reported via classification
    const mismatch = passageMismatch(rec, fragment);
    if (mismatch !== null) {
      problems.push({ code: 'field_mismatch', id: rec.id, detail: mismatch });
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sourceIds: source.map((rec) => rec.id),
    expectedIds,
    importedIds,
    restoredOrder,
    retained: fragments
      .filter((fragment) => expected.has(fragment.id))
      .map((fragment) => ({
        id: fragment.id,
        createdAt: fragment.createdAt,
        lastUsedAt: fragment.lastUsedAt,
        uses: fragment.uses,
        deepestY: fragment.deepestY,
        geometrySource: fragment.geometrySource,
      })),
  };
}

/**
 * Post-switch read view for the dry run. Record existence and passage geometry
 * come from the migrated store; legacy-only fields (`dug`, `ores`, absent
 * `kind`, landmark/ledger payloads) come from the retained compatibility
 * snapshot. A tombstoned id is filtered even when the JSON source still has it.
 */
export function createSwitchedLegacyView(
  history: Pick<DryRunPassageStore, 'getFragment'>,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacySpatialReadBackend {
  const deleted = new Set(deletions.passageIds ?? []);
  const retained = createLegacyReadBackend(snapshot, deletions);
  return {
    passages(dim) {
      return (snapshot.passages ?? [])
        .filter((rec) => legacyRecordWorldId(rec) === snapshot.worldId)
        .filter((rec) => !deleted.has(rec.id))
        .filter((rec) => dim === undefined || rec.dim === dim)
        .flatMap((rec) => {
          const fragment = history.getFragment(rec.id);
          // The migrated store is authoritative for existence: a record missing
          // from it is never restored from the still-present JSON snapshot.
          if (fragment === null) return [];
          const merged: LegacyPassageRecord = {
            ...structuredClone(rec),
            dim: fragment.dim,
            entrances: clonePoints(fragment.entrances),
            path: clonePoints(fragment.polyline),
            deepestY: fragment.deepestY,
            createdAt: fragment.createdAt,
            lastUsedAt: fragment.lastUsedAt,
            uses: fragment.uses,
          };
          if (fragment.links === undefined) delete merged.links;
          else merged.links = fragment.links.map((link) => ({ a: { ...link.a }, b: { ...link.b } }));
          return [merged];
        });
    },
    landmarks: retained.landmarks,
    ledger: retained.ledger,
  };
}

function collectPassagePages(
  backend: LegacySpatialReadBackend,
  id: string,
  context: LegacyPassageQueryContext,
): string[] {
  const pages: string[] = [];
  let offset = 0;
  for (;;) {
    const page = queryLegacyPassages(backend, { id, offset }, context);
    pages.push(page);
    const parsed = JSON.parse(page) as { error?: string; nextOffset?: number | null };
    if (parsed.error !== undefined) return pages;
    if (parsed.nextOffset === null || parsed.nextOffset === undefined) return pages;
    if (parsed.nextOffset <= offset) {
      throw new Error(`legacy passage pagination did not advance for "${id}" at offset ${offset}`);
    }
    offset = parsed.nextOffset;
  }
}

function collectReads(
  backend: LegacySpatialReadBackend,
  records: readonly LegacyPassageRecord[],
  context: LegacyPassageQueryContext,
): Record<string, string[]> {
  return Object.fromEntries(records.map((rec) => [rec.id, collectPassagePages(backend, rec.id, context)]));
}

function sameReads(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => b[key] !== undefined && sameJson(a[key], b[key]))
  );
}

// ==============================================================================
// Ledger batches: plans, rehearsal import and verification
// ==============================================================================

export type LegacyBatchName =
  | 'passages'
  | 'landmarks'
  | 'placed'
  | 'chunkVisits'
  | 'travelEndpoints'
  | 'travelTraversals'
  | 'travelGateways';

/**
 * One per-collection migration plan and its verification. `planned` batches have
 * no storage destination in this work package yet (landmarks and portal endpoints
 * belong to the topology/spatial-node store); their ids, counts and times are
 * preserved and verified in the plan, never silently dropped.
 */
export interface LegacyBatchPlan {
  batch: LegacyBatchName;
  destination: string;
  status: 'imported' | 'planned' | 'failed';
  sourceRecords: number;
  deletedRecords: number;
  importedRecords: number;
  unattributedRecords: number;
  crossWorldRecords: number;
  invalidRecords: number;
  expectedIds: string[];
  importedIds: string[];
  /** Timestamp / LRU serial / visit count keyed by record id. */
  expectedValues: Record<string, number>;
  restoredValues: Record<string, number> | null;
  idsMatch: boolean;
  countsMatch: boolean;
  timesMatch: boolean;
  /** Sessions, observation ids, endpoint evidence and raw crossing fields intact. */
  evidenceIntact: boolean;
  unattributedIds: string[];
  crossWorldIds: string[];
  invalidIds: string[];
  detail?: string;
  ok: boolean;
}

function newBatchPlan(
  batch: LegacyBatchName,
  destination: string,
  sourceRecords: number,
): LegacyBatchPlan {
  return {
    batch,
    destination,
    status: 'planned',
    sourceRecords,
    deletedRecords: 0,
    importedRecords: 0,
    unattributedRecords: 0,
    crossWorldRecords: 0,
    invalidRecords: 0,
    expectedIds: [],
    importedIds: [],
    expectedValues: {},
    restoredValues: null,
    idsMatch: true,
    countsMatch: true,
    timesMatch: true,
    evidenceIntact: true,
    unattributedIds: [],
    crossWorldIds: [],
    invalidIds: [],
    ok: true,
  };
}

function finalizePlan(plan: LegacyBatchPlan): LegacyBatchPlan {
  plan.idsMatch = plan.expectedIds.length === plan.importedIds.length &&
    plan.expectedIds.every((id) => plan.importedIds.includes(id));
  plan.countsMatch =
    plan.importedRecords === plan.expectedIds.length &&
    plan.sourceRecords ===
      plan.deletedRecords +
        plan.importedRecords +
        plan.unattributedRecords +
        plan.crossWorldRecords +
        plan.invalidRecords;
  plan.ok = plan.idsMatch && plan.countsMatch && plan.timesMatch && plan.evidenceIntact;
  if (!plan.ok && plan.status !== 'failed') plan.status = 'failed';
  return plan;
}

interface CollectedPlaced {
  total: number;
  deleted: number;
  accepted: { id: string; dim: string; pos: Vec3Like; name: string; lruAt: number }[];
  unattributed: string[];
  crossWorld: string[];
  invalid: string[];
}

function collectPlaced(snapshot: LegacySpatialSnapshot, deletions: LegacyDeletionSet): CollectedPlaced {
  const entries = Object.entries(snapshot.placed ?? {});
  const deleted = new Set(deletions.placedKeys ?? []);
  const out: CollectedPlaced = { total: entries.length, deleted: 0, accepted: [], unattributed: [], crossWorld: [], invalid: [] };
  for (const [sourceKey, record] of entries) {
    if (deleted.has(sourceKey)) {
      out.deleted += 1;
      continue;
    }
    const normalized = normalizeLegacyPlaced(sourceKey, record);
    if (normalized === null) {
      out.invalid.push(sourceKey);
      continue;
    }
    if (!normalized.attributed) {
      out.unattributed.push(sourceKey);
      continue;
    }
    if (normalized.worldId !== snapshot.worldId) {
      out.crossWorld.push(sourceKey);
      continue;
    }
    out.accepted.push({
      id: normalized.key!,
      dim: normalized.dim!,
      pos: normalized.pos,
      name: normalized.name,
      lruAt: normalized.lruAt,
    });
  }
  return out;
}

function placedPlanValues(ledger: DryRunLedgerStore, collected: CollectedPlaced): {
  expected: Record<string, number>;
  restored: Record<string, number>;
} {
  const restoredByKey = new Map(ledger.placedBlocks().map((record) => [record.key, record.lruAt]));
  const expected: Record<string, number> = {};
  const restored: Record<string, number> = {};
  for (const entry of collected.accepted) {
    expected[entry.id] = entry.lruAt;
    restored[entry.id] = restoredByKey.get(entry.id) ?? Number.NaN;
  }
  return { expected, restored };
}

/** Rehearse importing the unattributed-capable placement batch into a temp store. */
export function importLegacyPlaced(
  ledger: DryRunLedgerStore,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacyBatchPlan {
  const collected = collectPlaced(snapshot, deletions);
  const plan = newBatchPlan('placed', 'placed_blocks', collected.total);
  plan.deletedRecords = collected.deleted;
  plan.unattributedRecords = collected.unattributed.length;
  plan.unattributedIds = [...collected.unattributed];
  plan.crossWorldRecords = collected.crossWorld.length;
  plan.crossWorldIds = [...collected.crossWorld];
  plan.invalidRecords = collected.invalid.length;
  plan.invalidIds = [...collected.invalid];
  for (const entry of collected.accepted) {
    ledger.importPlaced({
      dim: entry.dim,
      pos: entry.pos,
      name: entry.name,
      lruAt: entry.lruAt,
      source: 'legacy',
    });
  }
  plan.status = 'imported';
  plan.importedRecords = collected.accepted.length;
  plan.expectedIds = collected.accepted.map((entry) => entry.id);
  plan.importedIds = collected.accepted.map((entry) => entry.id);
  const values = placedPlanValues(ledger, collected);
  plan.expectedValues = values.expected;
  plan.restoredValues = values.restored;
  plan.timesMatch = collected.accepted.every((entry) => values.restored[entry.id] === entry.lruAt);
  plan.detail = collected.unattributed.length > 0
    ? '无来源证明 world/dim 的放置记录只在本报告中列为未归属，当前库没有未归属存储，因此不会写入任何世界账本'
    : undefined;
  return finalizePlan(plan);
}

interface CollectedVisits {
  total: number;
  deleted: number;
  accepted: { id: string; dim: string; cx: number; cz: number; count: number }[];
  crossWorld: string[];
  invalid: string[];
}

function collectVisits(snapshot: LegacySpatialSnapshot, deletions: LegacyDeletionSet): CollectedVisits {
  const entries = Object.entries(snapshot.visitedChunks ?? {});
  const deleted = new Set(deletions.chunkVisitKeys ?? []);
  const out: CollectedVisits = { total: entries.length, deleted: 0, accepted: [], crossWorld: [], invalid: [] };
  for (const [key, count] of entries) {
    if (deleted.has(key)) {
      out.deleted += 1;
      continue;
    }
    if (!key.startsWith(`${snapshot.worldId}:`)) {
      out.crossWorld.push(key);
      continue;
    }
    const parsed = parseLegacyChunkVisitKey(key, snapshot.worldId);
    if (parsed === null || !Number.isSafeInteger(count) || count < 0) {
      out.invalid.push(key);
      continue;
    }
    out.accepted.push({
      id: legacyChunkVisitKey(snapshot.worldId, parsed.dim, parsed.cx, parsed.cz),
      dim: parsed.dim,
      cx: parsed.cx,
      cz: parsed.cz,
      count,
    });
  }
  return out;
}

function visitPlanValues(ledger: DryRunLedgerStore, collected: CollectedVisits): {
  expected: Record<string, number>;
  restored: Record<string, number>;
} {
  const restoredByKey = new Map(ledger.chunkVisits().map((record) => [record.key, record.count]));
  const expected: Record<string, number> = {};
  const restored: Record<string, number> = {};
  for (const entry of collected.accepted) {
    expected[entry.id] = entry.count;
    restored[entry.id] = restoredByKey.get(entry.id) ?? Number.NaN;
  }
  return { expected, restored };
}

/** Rehearse importing exact chunk-visit counts, including zero/negative coordinates. */
export function importLegacyChunkVisits(
  ledger: DryRunLedgerStore,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacyBatchPlan {
  const collected = collectVisits(snapshot, deletions);
  const plan = newBatchPlan('chunkVisits', 'chunk_visits', collected.total);
  plan.deletedRecords = collected.deleted;
  plan.crossWorldRecords = collected.crossWorld.length;
  plan.crossWorldIds = [...collected.crossWorld];
  plan.invalidRecords = collected.invalid.length;
  plan.invalidIds = [...collected.invalid];
  for (const entry of collected.accepted) {
    ledger.importVisit(entry.dim, entry.cx, entry.cz, entry.count, 'legacy');
  }
  plan.status = 'imported';
  plan.importedRecords = collected.accepted.length;
  plan.expectedIds = collected.accepted.map((entry) => entry.id);
  plan.importedIds = collected.accepted.map((entry) => entry.id);
  const values = visitPlanValues(ledger, collected);
  plan.expectedValues = values.expected;
  plan.restoredValues = values.restored;
  plan.timesMatch = collected.accepted.every((entry) => values.restored[entry.id] === entry.count);
  return finalizePlan(plan);
}

interface CollectedCrossings {
  total: number;
  deleted: number;
  accepted: {
    id: string;
    crossing: LegacyTravelCrossing;
    fromEndpoint: LegacyTravelEndpoint;
    toEndpoint: LegacyTravelEndpoint;
  }[];
  unattributed: string[];
  crossWorld: string[];
  invalid: string[];
}

function isFiniteCrossing(crossing: LegacyTravelCrossing): boolean {
  return (
    typeof crossing?.fromId === 'string' &&
    crossing.fromId.length > 0 &&
    typeof crossing.toId === 'string' &&
    crossing.toId.length > 0 &&
    typeof crossing.fromSession === 'string' &&
    crossing.fromSession.length > 0 &&
    typeof crossing.toSession === 'string' &&
    crossing.toSession.length > 0 &&
    Number.isFinite(crossing.ts) &&
    Number.isSafeInteger(crossing.fromObservation) &&
    Number.isSafeInteger(crossing.toObservation)
  );
}

function collectCrossings(
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet,
  kind: 'traversal' | 'gateway',
): CollectedCrossings {
  const source = kind === 'traversal' ? snapshot.travel?.traversals ?? [] : snapshot.travel?.gateways ?? [];
  const deleted = new Set(deletions.traversalKeys ?? []);
  const endpoints = new Map((snapshot.travel?.endpoints ?? []).map((endpoint) => [endpoint.id, endpoint]));
  const out: CollectedCrossings = { total: source.length, deleted: 0, accepted: [], unattributed: [], crossWorld: [], invalid: [] };
  for (const crossing of source) {
    const id = portalTraversalIdentity({ kind, ...crossing });
    if (deleted.has(id)) {
      out.deleted += 1;
      continue;
    }
    if (!isFiniteCrossing(crossing)) {
      out.invalid.push(id);
      continue;
    }
    const fromEndpoint = endpoints.get(crossing.fromId);
    const toEndpoint = endpoints.get(crossing.toId);
    if (fromEndpoint === undefined || toEndpoint === undefined) {
      // The legacy file recorded a crossing but its endpoint evidence is absent:
      // its world scope cannot be proven, so it must not be attributed.
      out.unattributed.push(id);
      continue;
    }
    if (fromEndpoint.worldId !== snapshot.worldId || toEndpoint.worldId !== snapshot.worldId) {
      out.crossWorld.push(id);
      continue;
    }
    out.accepted.push({ id, crossing, fromEndpoint, toEndpoint });
  }
  return out;
}

function crossingPayloadMatches(
  restored: PortalTraversalRecord,
  crossing: LegacyTravelCrossing,
  fromEndpoint: LegacyTravelEndpoint,
  toEndpoint: LegacyTravelEndpoint,
  kind: 'traversal' | 'gateway',
): boolean {
  return (
    restored.kind === kind &&
    restored.direction === 'unclassified' &&
    restored.fromId === crossing.fromId &&
    restored.toId === crossing.toId &&
    restored.ts === crossing.ts &&
    restored.fromSession === crossing.fromSession &&
    restored.toSession === crossing.toSession &&
    restored.fromObservation === crossing.fromObservation &&
    restored.toObservation === crossing.toObservation &&
    endpointEvidenceEqual(restored.fromEndpoint, fromEndpoint) &&
    endpointEvidenceEqual(restored.toEndpoint, toEndpoint)
  );
}

/** Field-by-field endpoint comparison; JSON key order is not semantic. */
function endpointEvidenceEqual(
  restored: PortalTraversalRecord['fromEndpoint'],
  expected: LegacyTravelEndpoint,
): boolean {
  if (restored === null || restored === undefined) return false;
  return (
    restored.id === expected.id &&
    restored.worldId === expected.worldId &&
    restored.dim === expected.dim &&
    restored.kind === expected.kind &&
    restored.portalObserved === expected.portalObserved &&
    restored.observedAt === expected.observedAt &&
    restored.pos.x === expected.pos.x &&
    restored.pos.y === expected.pos.y &&
    restored.pos.z === expected.pos.z
  );
}

function crossingPlanValues(
  ledger: DryRunLedgerStore,
  collected: CollectedCrossings,
  kind: 'traversal' | 'gateway',
): {
  expected: Record<string, number>;
  restored: Record<string, number>;
  evidenceIntact: boolean;
} {
  const restoredById = new Map(ledger.portalTraversals({ kind }).map((record) => [record.id, record]));
  const expected: Record<string, number> = {};
  const restored: Record<string, number> = {};
  let evidenceIntact = true;
  for (const entry of collected.accepted) {
    expected[entry.id] = entry.crossing.ts;
    const actual = restoredById.get(entry.id);
    restored[entry.id] = actual?.ts ?? Number.NaN;
    if (
      actual === undefined ||
      !crossingPayloadMatches(actual, entry.crossing, entry.fromEndpoint, entry.toEndpoint, kind)
    ) {
      evidenceIntact = false;
    }
  }
  return { expected, restored, evidenceIntact };
}

/** Rehearse importing raw portal (or gateway) crossings with their endpoint evidence. */
export function importLegacyCrossings(
  ledger: DryRunLedgerStore,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
  kind: 'traversal' | 'gateway' = 'traversal',
): LegacyBatchPlan {
  const collected = collectCrossings(snapshot, deletions, kind);
  const plan = newBatchPlan(kind === 'traversal' ? 'travelTraversals' : 'travelGateways', 'portal_traversals', collected.total);
  plan.deletedRecords = collected.deleted;
  plan.unattributedRecords = collected.unattributed.length;
  plan.unattributedIds = [...collected.unattributed];
  plan.crossWorldRecords = collected.crossWorld.length;
  plan.crossWorldIds = [...collected.crossWorld];
  plan.invalidRecords = collected.invalid.length;
  plan.invalidIds = [...collected.invalid];
  for (const entry of collected.accepted) {
    ledger.recordPortalTraversal({
      ...entry.crossing,
      kind,
      // The legacy travel file does not label outbound vs return; keep the raw
      // orientation unclassified rather than inventing one.
      direction: 'unclassified',
      worldId: snapshot.worldId,
      fromEndpoint: structuredClone(entry.fromEndpoint),
      toEndpoint: structuredClone(entry.toEndpoint),
      source: 'legacy',
    });
  }
  plan.status = 'imported';
  plan.importedRecords = collected.accepted.length;
  plan.expectedIds = collected.accepted.map((entry) => entry.id);
  plan.importedIds = collected.accepted.map((entry) => entry.id);
  const values = crossingPlanValues(ledger, collected, kind);
  plan.expectedValues = values.expected;
  plan.restoredValues = values.restored;
  plan.timesMatch = collected.accepted.every((entry) => values.restored[entry.id] === entry.crossing.ts);
  plan.evidenceIntact = values.evidenceIntact;
  return finalizePlan(plan);
}

/**
 * Plan-only batches (landmarks and portal endpoints). They have no dedicated
 * storage destination in this work package — endpoints map to spatial nodes owned
 * by the topology store — so the plan preserves and verifies the exact ids, times
 * and fields that the eventual import must carry, without writing a competing copy.
 */
function planOnlyBatch(
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet,
  batch: 'landmarks' | 'travelEndpoints',
): LegacyBatchPlan {
  const rows: { id: string; worldId?: string; value: number }[] =
    batch === 'landmarks'
      ? (snapshot.landmarks ?? []).map((landmark) => ({ id: landmark.id, worldId: landmark.worldId, value: landmark.ts }))
      : (snapshot.travel?.endpoints ?? []).map((endpoint) => ({
          id: endpoint.id,
          worldId: endpoint.worldId,
          value: endpoint.observedAt,
        }));
  const deleted = new Set(batch === 'landmarks' ? deletions.landmarkIds ?? [] : deletions.endpointIds ?? []);
  const plan = newBatchPlan(batch, 'planned:spatial_nodes', rows.length);
  const expectedIds: string[] = [];
  const expectedValues: Record<string, number> = {};
  for (const row of rows) {
    if (deleted.has(row.id)) {
      plan.deletedRecords += 1;
      continue;
    }
    if (row.worldId === undefined) {
      plan.unattributedRecords += 1;
      plan.unattributedIds.push(row.id);
      continue;
    }
    if (row.worldId !== snapshot.worldId) {
      plan.crossWorldRecords += 1;
      plan.crossWorldIds.push(row.id);
      continue;
    }
    expectedIds.push(row.id);
    expectedValues[row.id] = row.value;
  }
  plan.expectedIds = expectedIds;
  plan.expectedValues = expectedValues;
  // Planned batches were never written or read back; do not fabricate a
  // "restored" value map from the expected one.
  plan.restoredValues = null;
  plan.importedIds = [...expectedIds];
  plan.importedRecords = expectedIds.length;
  plan.detail = '存储目的地由拓扑 spatial_nodes 承担；本轮仅核对 ID/时间/字段保留，未写入竞争副本';
  return finalizePlan(plan);
}

/** Run every ledger batch plan/import into a caller-provided temp ledger. */
export function importLegacyLedger(
  ledger: DryRunLedgerStore | null,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacyBatchPlan[] {
  if (ledger === null) {
    return [
      planOnlyBatch(snapshot, deletions, 'landmarks'),
      newBatchPlan('placed', 'placed_blocks', Object.keys(snapshot.placed ?? {}).length),
      newBatchPlan('chunkVisits', 'chunk_visits', Object.keys(snapshot.visitedChunks ?? {}).length),
      planOnlyBatch(snapshot, deletions, 'travelEndpoints'),
      newBatchPlan('travelTraversals', 'portal_traversals', snapshot.travel?.traversals?.length ?? 0),
      newBatchPlan('travelGateways', 'portal_traversals', snapshot.travel?.gateways?.length ?? 0),
    ].map((plan) => ({ ...plan, detail: 'injected session exposes no ledger surface' }));
  }
  return [
    planOnlyBatch(snapshot, deletions, 'landmarks'),
    importLegacyPlaced(ledger, snapshot, deletions),
    importLegacyChunkVisits(ledger, snapshot, deletions),
    planOnlyBatch(snapshot, deletions, 'travelEndpoints'),
    importLegacyCrossings(ledger, snapshot, deletions, 'traversal'),
    importLegacyCrossings(ledger, snapshot, deletions, 'gateway'),
  ];
}

/** Re-verify imported ledger batches against a reopened store (no writes). */
export function verifyLegacyLedgerImport(
  ledger: DryRunLedgerStore | null,
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
): LegacyBatchPlan[] {
  if (ledger === null) return importLegacyLedger(null, snapshot, deletions);
  const placed = collectPlaced(snapshot, deletions);
  const visits = collectVisits(snapshot, deletions);
  return [
    planOnlyBatch(snapshot, deletions, 'landmarks'),
    (() => {
      const plan = newBatchPlan('placed', 'placed_blocks', placed.total);
      plan.status = 'imported';
      plan.deletedRecords = placed.deleted;
      plan.unattributedRecords = placed.unattributed.length;
      plan.unattributedIds = [...placed.unattributed];
      plan.crossWorldRecords = placed.crossWorld.length;
      plan.crossWorldIds = [...placed.crossWorld];
      plan.invalidRecords = placed.invalid.length;
      plan.invalidIds = [...placed.invalid];
      plan.importedRecords = placed.accepted.length;
      plan.expectedIds = placed.accepted.map((entry) => entry.id);
      plan.importedIds = placed.accepted.map((entry) => entry.id);
      const values = placedPlanValues(ledger, placed);
      plan.expectedValues = values.expected;
      plan.restoredValues = values.restored;
      plan.timesMatch = placed.accepted.every((entry) => values.restored[entry.id] === entry.lruAt);
      // Verify the restored key set, not only the ids we expected to find:
      // unexpected/resurrected rows must fail the batch.
      const restoredKeys = new Set(ledger.placedBlocks().map((record) => record.key));
      const expectedKeys = new Set(plan.expectedIds);
      const unexpected = [...restoredKeys].filter((key) => !expectedKeys.has(key));
      const resurrected = (deletions.placedKeys ?? []).filter((key) => restoredKeys.has(key));
      plan.importedRecords = restoredKeys.size;
      plan.countsMatch =
        unexpected.length === 0 && resurrected.length === 0 && restoredKeys.size === plan.expectedIds.length;
      return finalizePlan(plan);
    })(),
    (() => {
      const plan = newBatchPlan('chunkVisits', 'chunk_visits', visits.total);
      plan.status = 'imported';
      plan.deletedRecords = visits.deleted;
      plan.crossWorldRecords = visits.crossWorld.length;
      plan.crossWorldIds = [...visits.crossWorld];
      plan.invalidRecords = visits.invalid.length;
      plan.invalidIds = [...visits.invalid];
      plan.importedRecords = visits.accepted.length;
      plan.expectedIds = visits.accepted.map((entry) => entry.id);
      plan.importedIds = visits.accepted.map((entry) => entry.id);
      const values = visitPlanValues(ledger, visits);
      plan.expectedValues = values.expected;
      plan.restoredValues = values.restored;
      plan.timesMatch = visits.accepted.every((entry) => values.restored[entry.id] === entry.count);
      const restoredKeys = new Set(ledger.chunkVisits().map((record) => record.key));
      const expectedKeys = new Set(plan.expectedIds);
      const unexpected = [...restoredKeys].filter((key) => !expectedKeys.has(key));
      const resurrected = (deletions.chunkVisitKeys ?? []).filter((key) => restoredKeys.has(key));
      plan.importedRecords = restoredKeys.size;
      plan.countsMatch =
        unexpected.length === 0 && resurrected.length === 0 && restoredKeys.size === plan.expectedIds.length;
      return finalizePlan(plan);
    })(),
    planOnlyBatch(snapshot, deletions, 'travelEndpoints'),
    ...(['traversal', 'gateway'] as const).map((kind) => {
      const collected = collectCrossings(snapshot, deletions, kind);
      const plan = newBatchPlan(kind === 'traversal' ? 'travelTraversals' : 'travelGateways', 'portal_traversals', collected.total);
      plan.status = 'imported';
      plan.deletedRecords = collected.deleted;
      plan.unattributedRecords = collected.unattributed.length;
      plan.unattributedIds = [...collected.unattributed];
      plan.crossWorldRecords = collected.crossWorld.length;
      plan.crossWorldIds = [...collected.crossWorld];
      plan.invalidRecords = collected.invalid.length;
      plan.invalidIds = [...collected.invalid];
      plan.importedRecords = collected.accepted.length;
      plan.expectedIds = collected.accepted.map((entry) => entry.id);
      plan.importedIds = collected.accepted.map((entry) => entry.id);
      const values = crossingPlanValues(ledger, collected, kind);
      plan.expectedValues = values.expected;
      plan.restoredValues = values.restored;
      plan.timesMatch = collected.accepted.every((entry) => values.restored[entry.id] === entry.crossing.ts);
      plan.evidenceIntact = values.evidenceIntact;
      const restoredIds = ledger
        .portalTraversals({ kind })
        .map((record) => portalTraversalIdentity({ ...record, kind }));
      const expectedIds = new Set(plan.expectedIds);
      const unexpected = restoredIds.filter((id) => !expectedIds.has(id));
      const deletedIds = new Set(deletions.traversalKeys ?? []);
      const resurrected = restoredIds.filter((id) => deletedIds.has(id));
      plan.importedRecords = restoredIds.length;
      plan.countsMatch =
        unexpected.length === 0 && resurrected.length === 0 && restoredIds.length === plan.expectedIds.length;
      return finalizePlan(plan);
    }),
  ];
}

function passageBatchPlan(
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet,
  imported: LegacyPassageImportResult,
  verified: ReturnType<typeof verifyLegacyPassageImport>,
): LegacyBatchPlan {
  const source = snapshot.passages ?? [];
  const deleted = new Set(deletions.passageIds ?? []);
  const plan = newBatchPlan('passages', 'path_fragments', source.length);
  plan.status = 'imported';
  plan.deletedRecords = source.filter((record) => deleted.has(record.id)).length;
  plan.importedRecords = imported.importedIds.length;
  plan.importedIds = [...imported.importedIds];
  plan.expectedIds = [...verified.expectedIds];
  plan.expectedValues = Object.fromEntries(
    source.filter((record) => !deleted.has(record.id)).map((record) => [record.id, record.createdAt]),
  );
  plan.restoredValues = Object.fromEntries(
    verified.retained.map((record) => [record.id, record.createdAt]),
  );
  plan.timesMatch = verified.retained.every((record) => {
    const original = source.find((entry) => entry.id === record.id);
    return (
      original !== undefined &&
      original.createdAt === record.createdAt &&
      original.lastUsedAt === record.lastUsedAt &&
      original.uses === record.uses
    );
  });
  plan.evidenceIntact = verified.ok;
  return finalizePlan(plan);
}

// ==============================================================================
// Authority gate: structured, decidable conditions over the dry-run report
// ==============================================================================

/**
 * Every condition the gate checks, evaluated from the dry-run facts. A condition
 * with `ok: false` contributes a structured reason; nothing here writes, reads a
 * user database, or changes an authority.
 */
export type LegacyMigrationGateConditionName =
  | 'stages_all_passed'
  | 'verification_all_verified'
  | 'no_unattributed_records'
  | 'no_cross_world_records'
  | 'no_invalid_records'
  | 'deleted_not_resurrected'
  | 'planned_destinations_declared'
  | 'stage_d_trusted';

export interface LegacyMigrationGateCondition {
  condition: LegacyMigrationGateConditionName;
  ok: boolean;
  /** Facts the decision was made from (counts, statuses, ids). */
  observed: Record<string, unknown>;
}

/** Stable, machine-checkable reason codes for a failed condition. */
export type LegacyMigrationGateReasonCode =
  | 'stage_failed'
  | 'batch_not_verified'
  | 'unattributed_records'
  | 'cross_world_records'
  | 'invalid_records'
  | 'deleted_resurrected'
  | 'batch_planned_only'
  | 'stage_d_not_passed';

export interface LegacyMigrationGateReason {
  code: LegacyMigrationGateReasonCode;
  detail: string;
  /** The failed condition's observed facts, for direct callers of the evaluator. */
  observed: Record<string, unknown>;
}

export interface LegacyMigrationGate {
  /** Advisory only. `satisfied_but_disabled` never means "switched". */
  status: 'not_satisfied' | 'satisfied_but_disabled';
  /** True only when every condition holds. */
  satisfied: boolean;
  conditions: LegacyMigrationGateCondition[];
  /** Non-empty exactly when `satisfied` is false. */
  reasons: LegacyMigrationGateReason[];
  /** An automatic authority switch is intentionally absent from this module. */
  autoSwitchImplemented: false;
  /** Callers must enable a future switch explicitly; this module ignores the request. */
  requiresManualEnable: true;
  operatorOptIn: boolean;
  rollback: 'drop_temp_database_and_reopen_legacy';
  /** Facts that must stay true even when the conditions hold. */
  guarantees: {
    realAuthoritySwitch: false;
    legacyWritePathRemoved: false;
    dualWrite: false;
    jsonReadFallbackForMissingRecords: false;
  };
}

/**
 * The report facts the gate decides from. Declared explicitly (not derived from
 * the dry-run return type) so the decision is a pure function of the report and
 * has no circular type dependency with `runLegacyMigrationDryRun`.
 */
export interface LegacyMigrationGateInput {
  stages: {
    a: { status: 'passed' | 'failed' };
    b: { status: 'passed' | 'failed'; problems: readonly LegacyImportProblem[] };
    c:
      | {
          status: 'passed' | 'failed';
          deletedNotResurrected: boolean;
          deletedIdsChecked: string[];
          verification: { problems: readonly LegacyImportProblem[] };
        }
      | { status: 'not_run'; reason: string };
    d: { status: 'passed' | 'failed'; sessionsClosed: boolean; sourceSnapshotUnchanged: boolean };
  };
  verificationCounts: {
    allVerified: boolean;
    unattributedRecords: number;
    crossWorldRecords: number;
    invalidRecords: number;
  };
  batchPlans: readonly Pick<LegacyBatchPlan, 'batch' | 'status' | 'ok'>[];
}

/**
 * Evaluate the gate from an already-computed dry-run report. Pure function: it
 * only derives a decision, never performs one.
 */
export function evaluateMigrationGate(
  report: LegacyMigrationGateInput,
  request: LegacyMigrationGateRequest = {},
): LegacyMigrationGate {
  const { stages, verificationCounts, batchPlans } = report;
  const stageStatus = { a: stages.a.status, b: stages.b.status, c: stages.c.status, d: stages.d.status };
  const resurrectedProblems = [
    ...stages.b.problems,
    ...(stages.c.status === 'not_run' ? [] : stages.c.verification.problems),
  ].filter((problem) => problem.code === 'resurrected_deleted_passage');
  const deletedNotResurrected =
    stages.c.status !== 'not_run' &&
    stages.c.deletedNotResurrected &&
    resurrectedProblems.length === 0;
  const failedPlans = batchPlans.filter((plan) => !plan.ok);
  const plannedIds = batchPlans.filter((plan) => plan.status === 'planned').map((plan) => plan.batch);
  const declared = new Set(request.declaredMigratedBatches ?? []);
  const undeclaredPlannedIds = plannedIds.filter((batch) => !declared.has(batch));
  // Base `allVerified` vetoes every planned batch. The gate evaluates the rows
  // that actually have a storage destination; plan-only batches are a separate,
  // explicit condition so callers can see what remains unwired.
  const verifiedPlans = batchPlans.filter((plan) => plan.status !== 'planned');

  const checks: (LegacyMigrationGateCondition & { code: LegacyMigrationGateReasonCode })[] = [
    {
      condition: 'stages_all_passed',
      code: 'stage_failed',
      ok: Object.values(stageStatus).every((status) => status === 'passed'),
      observed: stageStatus,
    },
    {
      condition: 'verification_all_verified',
      code: 'batch_not_verified',
      ok:
        stages.b.status === 'passed' &&
        stages.c.status === 'passed' &&
        failedPlans.length === 0 &&
        verifiedPlans.length > 0,
      observed: {
        allVerified: verificationCounts.allVerified,
        failedBatches: failedPlans.map((plan) => plan.batch),
        verifiedBatches: verifiedPlans.map((plan) => plan.batch),
      },
    },
    // Three same-shaped count conditions share one row shape.
    ...(
      [
        ['no_unattributed_records', 'unattributed_records', 'unattributedRecords'],
        ['no_cross_world_records', 'cross_world_records', 'crossWorldRecords'],
        ['no_invalid_records', 'invalid_records', 'invalidRecords'],
      ] as const
    ).map(([condition, code, field]) => ({
      condition,
      code,
      ok: verificationCounts[field] === 0,
      observed: { [field]: verificationCounts[field] },
    })),
    {
      condition: 'deleted_not_resurrected',
      code: 'deleted_resurrected',
      ok: deletedNotResurrected,
      observed: {
        stageC: stages.c.status,
        deletedIdsChecked: stages.c.status === 'not_run' ? [] : stages.c.deletedIdsChecked,
        resurrectedIds: resurrectedProblems.flatMap((problem) => (problem.id === undefined ? [] : [problem.id])),
      },
    },
    {
      condition: 'planned_destinations_declared',
      code: 'batch_planned_only',
      ok: undeclaredPlannedIds.length === 0,
      observed: { plannedBatches: plannedIds, declaredMigratedBatches: [...declared] },
    },
    {
      // Stage D can fail because a session did not close or the JSON source
      // changed; both mean the rehearsal cannot be trusted.
      condition: 'stage_d_trusted',
      code: 'stage_d_not_passed',
      ok:
        stages.d.status === 'passed' &&
        stages.d.sessionsClosed === true &&
        stages.d.sourceSnapshotUnchanged === true,
      observed: {
        stageD: stages.d.status,
        sessionsClosed: stages.d.sessionsClosed,
        sourceSnapshotUnchanged: stages.d.sourceSnapshotUnchanged,
      },
    },
  ];

  const conditions: LegacyMigrationGateCondition[] = checks.map(
    ({ code: _code, ...condition }) => condition,
  );
  const reasons: LegacyMigrationGateReason[] = checks
    .filter((check) => !check.ok)
    .map((check) => ({
      code: check.code,
      detail: `${check.code}: ${JSON.stringify(check.observed)}`,
      observed: check.observed,
    }));

  const satisfied = reasons.length === 0;
  return {
    status: satisfied ? 'satisfied_but_disabled' : 'not_satisfied',
    satisfied,
    conditions,
    reasons,
    autoSwitchImplemented: false,
    requiresManualEnable: true,
    operatorOptIn: request.operatorOptIn === true,
    rollback: 'drop_temp_database_and_reopen_legacy',
    guarantees: {
      realAuthoritySwitch: false,
      legacyWritePathRemoved: false,
      dualWrite: false,
      jsonReadFallbackForMissingRecords: false,
    },
  };
}

/**
 * Run the A → B → C → D rehearsal against a temporary database.
 *
 * The returned report distinguishes stage outcomes and always carries
 * `realMigrationPerformed: false`, `realAuthoritySwitch: false` and
 * `legacyWritePathRemoved: false`: this dry run cannot be read as a completed
 * migration.
 */
export async function runLegacyMigrationDryRun(options: LegacyMigrationDryRunOptions) {
  const { snapshot, query, deletions = {} } = options;
  const before = structuredClone(snapshot);

  // --- Stage A: compatibility layer over the JSON-shaped legacy snapshot ---
  const backendBefore = createLegacyReadBackend(snapshot, deletions);
  const routeRecordsBefore = backendBefore.passages(query.dim);
  const context: LegacyPassageQueryContext = {
    worldId: snapshot.worldId,
    dim: query.dim,
    pos: query.pos,
  };
  const listBefore = queryLegacyPassages(backendBefore, {}, context);
  const readsBefore = collectReads(backendBefore, routeRecordsBefore, context);
  const routeBefore = passageRoute(routeRecordsBefore, query.from, query.to, query.route);
  const ledgerBefore: LegacyLedgerView = backendBefore.ledger();

  // --- Stage B: import into the temporary SQLite store, then checkpoint once ---
  let stageB:
    | {
        status: 'passed' | 'failed';
        importedIds: string[];
        skippedDeletedIds: string[];
        problems: LegacyImportProblem[];
        batchPlans: LegacyBatchPlan[];
        ledgerOk: boolean;
        checkpointId: string | null;
        dirtyAfterCheckpoint: boolean | null;
        lifecycleAfterCheckpoint: string | null;
      }
    | undefined;
  let closeFirstCompleted = false;

  const first = await options.openSession({ databasePath: options.databasePath, worldId: snapshot.worldId });
  try {
    const imported = importLegacyPassages(first.history, snapshot, deletions);
    const verified = verifyLegacyPassageImport(first.history, snapshot, deletions);
    const ledgerPlans = importLegacyLedger(first.ledger ?? null, snapshot, deletions);
    const batchPlans = [passageBatchPlan(snapshot, deletions, imported, verified), ...ledgerPlans];
    const ledgerOk = ledgerPlans.every((plan) => plan.ok);
    if (!verified.ok || !ledgerOk) {
      stageB = {
        status: 'failed',
        ...imported,
        problems: verified.problems,
        batchPlans,
        ledgerOk,
        checkpointId: null,
        dirtyAfterCheckpoint: null,
        lifecycleAfterCheckpoint: null,
      };
    } else {
      const checkpoint = await first.checkpoint();
      const state = first.getPersistenceState();
      const savedClean = state.dirty === false && state.lifecycle === 'open';
      stageB = {
        status: savedClean ? 'passed' : 'failed',
        ...imported,
        problems: savedClean
          ? []
          : [
              {
                code: 'field_mismatch' as const,
                detail: state.dirty
                  ? 'checkpoint left the session dirty; accepted data is not confirmed saved'
                  : `session lifecycle is "${state.lifecycle}", not open`,
              },
            ],
        batchPlans,
        ledgerOk,
        checkpointId: checkpoint.checkpointId,
        dirtyAfterCheckpoint: state.dirty,
        lifecycleAfterCheckpoint: state.lifecycle,
      };
    }
  } finally {
    closeFirstCompleted = (await first.close()).completed;
  }

  if (stageB === undefined) throw new Error('dry-run stage B did not produce a result');

  // --- Stage C: reopen the same temp database and compare A vs restored facts ---
  let stageC:
    | {
        status: 'passed' | 'failed';
        reopened: true;
        verification: ReturnType<typeof verifyLegacyPassageImport>;
        listMatchesBefore: boolean;
        readsMatchBefore: boolean;
        routeMatchesBefore: boolean;
        deletedIdsChecked: string[];
        deletedNotResurrected: boolean;
        ledgerVerification: LegacyBatchPlan[];
        ledgerOk: boolean;
        historical: {
          traversalEvidence: number;
          voxelSections: number;
          voxelSectionAtQueryPos: boolean;
          geometrySources: string[];
        };
      }
    | { status: 'not_run'; reason: string }
    | undefined;
  let closeSecondCompleted: boolean | null = null;

  if (stageB.status === 'passed') {
    const second = await options.openSession({ databasePath: options.databasePath, worldId: snapshot.worldId });
    try {
      const verification = verifyLegacyPassageImport(second.history, snapshot, deletions);
      const ledgerVerification = verifyLegacyLedgerImport(second.ledger ?? null, snapshot, deletions);
      const ledgerOk = ledgerVerification.every((plan) => plan.ok);
      const view = createSwitchedLegacyView(second.history, snapshot, deletions);
      const listAfter = queryLegacyPassages(view, {}, context);
      const readsAfter = collectReads(view, view.passages(query.dim), context);
      const routeAfter = passageRoute(view.passages(query.dim), query.from, query.to, query.route);
      const restoredFragments = second.history.checkpointSnapshot().fragments;

      const deletedIdsChecked = (snapshot.passages ?? [])
        .filter((rec) => (deletions.passageIds ?? []).includes(rec.id) && rec.dim === query.dim)
        .map((rec) => rec.id);
      // A naive JSON fallback (no tombstones) still contains these records; the
      // switched view must not return them.
      const jsonFallback = createLegacyReadBackend(snapshot);
      const deletedNotResurrected = deletedIdsChecked.every(
        (id) =>
          jsonFallback.passages(query.dim).some((rec) => rec.id === id) &&
          !view.passages(query.dim).some((rec) => rec.id === id) &&
          view.passages().every((rec) => rec.id !== id),
      );

      const traversalEvidence = second.history.traversals().total;
      const voxelSections = second.voxel.checkpointSnapshot().sections.length;
      const section = second.voxel.sectionAt(
        query.dim,
        Math.floor(query.pos.x),
        Math.floor(query.pos.y),
        Math.floor(query.pos.z),
      );
      const historical = {
        traversalEvidence,
        voxelSections,
        voxelSectionAtQueryPos: section !== null,
        geometrySources: [...new Set(restoredFragments.map((fragment) => fragment.geometrySource))],
      };
      const passed =
        verification.ok &&
        sameJson(listAfter, listBefore) &&
        sameReads(readsAfter, readsBefore) &&
        sameJson(routeAfter, routeBefore) &&
        deletedNotResurrected &&
        ledgerOk &&
        traversalEvidence === 0 &&
        voxelSections === 0;

      stageC = {
        status: passed ? 'passed' : 'failed',
        reopened: true,
        verification,
        listMatchesBefore: sameJson(listAfter, listBefore),
        readsMatchBefore: sameReads(readsAfter, readsBefore),
        routeMatchesBefore: sameJson(routeAfter, routeBefore),
        deletedIdsChecked,
        deletedNotResurrected,
        ledgerVerification,
        ledgerOk,
        historical,
      };
    } finally {
      closeSecondCompleted = (await second.close()).completed;
    }
  } else {
    stageC = { status: 'not_run', reason: 'stage B verification failed; nothing was checkpointed' };
  }

  if (stageC === undefined) throw new Error('dry-run stage C did not produce a result');

  // --- Stage D: rehearsal cleanup only; the real legacy path is untouched ---
  const sourceUnchanged = sameJson(snapshot, before);
  const sessionsClosed = closeFirstCompleted && (closeSecondCompleted ?? true);
  const stageD = {
    status: (sessionsClosed && sourceUnchanged ? 'passed' : 'failed') as 'passed' | 'failed',
    sessionsClosed,
    sourceSnapshotUnchanged: sourceUnchanged,
    tempDatabasePath: options.databasePath,
    cleanup: 'caller_owns_temp_directory' as const,
    realCleanupPerformed: false,
  };

  const passagePlan = stageB.batchPlans.find((plan) => plan.batch === 'passages')!;
  const ledgerPlansAfter =
    stageC.status === 'not_run' ? stageB.batchPlans.filter((plan) => plan.batch !== 'passages') : stageC.ledgerVerification;
  const batchPlans = [passagePlan, ...ledgerPlansAfter];
  const verificationCounts = {
    batches: batchPlans.length,
    expectedRecords: batchPlans.reduce((sum, plan) => sum + plan.expectedIds.length, 0),
    importedRecords: batchPlans
      .filter((plan) => plan.status === 'imported')
      .reduce((sum, plan) => sum + plan.importedIds.length, 0),
    plannedRecords: batchPlans
      .filter((plan) => plan.status === 'planned')
      .reduce((sum, plan) => sum + plan.expectedIds.length, 0),
    unattributedRecords: batchPlans.reduce((sum, plan) => sum + plan.unattributedRecords, 0),
    crossWorldRecords: batchPlans.reduce((sum, plan) => sum + plan.crossWorldRecords, 0),
    invalidRecords: batchPlans.reduce((sum, plan) => sum + plan.invalidRecords, 0),
    deletedRecords: batchPlans.reduce((sum, plan) => sum + plan.deletedRecords, 0),
    // `planned` batches were never written or read back; they cannot count as
    // verified. A failed stage also invalidates the aggregate claim.
    allVerified:
      stageB.status === 'passed' &&
      stageC.status === 'passed' &&
      stageD.status === 'passed' &&
      batchPlans.every((plan) => plan.ok && plan.status !== 'planned'),
  };

  const report = {
    kind: 'legacy-migration-dry-run' as const,
    realMigrationPerformed: false as const,
    realAuthoritySwitch: false as const,
    legacyWritePathRemoved: false as const,
    migratedBatch: 'passages' as const,
    /** Collections rehearsed into the temporary database. */
    rehearsedBatches: batchPlans
      .filter((plan) => plan.status === 'imported')
      .map((plan) => plan.batch) as LegacyBatchName[],
    /** Collections whose ids/times are verified in the plan but not yet stored here. */
    plannedBatches: batchPlans.filter((plan) => plan.status === 'planned').map((plan) => plan.batch) as LegacyBatchName[],
    batchPlans,
    verificationCounts,
    unmigratedCollections: ['chests', 'furnaces', 'farms'] as const,
    note: '离线演练：仅使用调用方提供的临时 SQLite；未读取或写入真实用户数据，未切换权威源，未删除旧写入路径。',
    stages: {
      a: {
        status: 'passed' as const,
        list: listBefore,
        reads: readsBefore,
        route: routeBefore,
        ledger: ledgerBefore,
      },
      b: stageB,
      c: stageC,
      d: stageD,
    },
  };
  // Advisory gate: reports whether the conditions for a future switch hold, but
  // this module never acts on the answer (no switch, no dual write, no JSON
  // read fallback). `satisfied_but_disabled` still leaves every guarantee false.
  return { ...report, gate: evaluateMigrationGate(report, options.migrationGate) };
}
