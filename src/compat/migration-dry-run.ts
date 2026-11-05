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
 */

import type { FragmentChanges } from '../topology/fragment-store.js';
import type { PathFragment, TraversalEvidence } from '../topology/path-fragment.js';
import type { Vec3Like } from '../types.js';
import {
  classifyLegacyRecordKeys,
  createLegacyReadBackend,
  legacyRecordWorldId,
  passageRoute,
  queryLegacyPassages,
} from './legacy.js';
import type {
  LegacyDeletionSet,
  LegacyLedgerView,
  LegacyPassageQueryContext,
  LegacyPassageRecord,
  LegacySpatialReadBackend,
  LegacySpatialSnapshot,
} from './legacy.js';

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

export interface DryRunSession {
  readonly history: DryRunPassageStore;
  readonly voxel: {
    checkpointSnapshot(): { sections: readonly unknown[] };
    sectionAt(dim: string, x: number, y: number, z: number): unknown | null;
  };
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
    if (!verified.ok) {
      stageB = {
        status: 'failed',
        ...imported,
        problems: verified.problems,
        checkpointId: null,
        dirtyAfterCheckpoint: null,
        lifecycleAfterCheckpoint: null,
      };
    } else {
      const checkpoint = await first.checkpoint();
      const state = first.getPersistenceState();
      stageB = {
        status: 'passed',
        ...imported,
        problems: [],
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

  return {
    kind: 'legacy-migration-dry-run' as const,
    realMigrationPerformed: false as const,
    realAuthoritySwitch: false as const,
    legacyWritePathRemoved: false as const,
    migratedBatch: 'passages' as const,
    unmigratedCollections: [
      'landmarks',
      'chests',
      'furnaces',
      'farms',
      'placed',
      'travel',
    ] as const,
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
}
