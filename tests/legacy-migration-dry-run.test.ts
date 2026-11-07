import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FragmentStore } from '../src/index.js';
import type { Vec3Like } from '../src/index.js';
import {
  classifyLegacyRecordKeys,
  createLegacyReadBackend,
  createSwitchedLegacyView,
  evaluateMigrationGate,
  importLegacyPassages,
  legacyBlockKey,
  passageRoute,
  queryLegacyPassages,
  runLegacyMigrationDryRun,
  verifyLegacyPassageImport,
} from '../src/compat/index.js';
import type {
  LegacyBatchName,
  LegacyDeletionSet,
  LegacyFurnaceRecord,
  LegacySpatialSnapshot,
} from '../src/compat/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';
import { portalTraversalIdentity } from '../src/storage/sqlite/ledger.js';

const WORLD = 'world-1';
const DIM = 'overworld';

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'curio-wp7-migration-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function point(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function mainPath(): Vec3Like[] {
  // Negative and fractional coordinates, descending Y: the projection must copy
  // them verbatim without rounding.
  return Array.from({ length: 40 }, (_, i) => point(-20 + i * 0.5, 12 - Math.floor(i / 10), -7 - i));
}

function mainLinks(path: readonly Vec3Like[]): { a: Vec3Like; b: Vec3Like }[] {
  return path.slice(0, -1).map((p, i) => ({ a: { ...p }, b: { ...path[i + 1]! } }));
}

const deletedFurnace: LegacyFurnaceRecord = {
  worldId: WORLD,
  dim: DIM,
  pos: point(-15, 64, 30),
  block: 'minecraft:furnace',
  input: null,
  output: null,
  fuel: null,
  burning: false,
  ts: 1_700_000_700_000,
};

function makeSnapshot(): LegacySpatialSnapshot {
  const path = mainPath();
  return {
    worldId: WORLD,
    passages: [
      {
        id: 'psg_main',
        worldId: WORLD,
        dim: DIM,
        kind: 'dug',
        entrances: [point(-20.5, 64.25, -3)],
        path,
        links: mainLinks(path),
        deepestY: 9,
        dug: 17,
        ores: { 'minecraft:diamond_ore': 2, ancient_debris: 1 },
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_100_000,
        uses: 4,
      },
      {
        id: 'psg_walk',
        worldId: WORLD,
        dim: DIM,
        kind: 'walked',
        entrances: [point(100.5, 64, 100.5)],
        path: [point(100.5, 30, 100.25), point(101, 31, 101), point(102, 32, 102)],
        deepestY: 30,
        dug: 0,
        ores: {},
        createdAt: 1_700_000_200_000,
        lastUsedAt: 1_700_000_300_000,
        uses: 1,
      },
      {
        id: 'psg_bridge',
        worldId: WORLD,
        dim: DIM,
        kind: 'bridge',
        entrances: [],
        path: [point(-100, 70, -100), point(-99, 70, -100), point(-98, 70, -100)],
        deepestY: 70,
        dug: 0,
        ores: {},
        createdAt: 1_700_000_400_000,
        lastUsedAt: 1_700_000_500_000,
        uses: 2,
      },
      {
        id: 'psg_default_kind',
        worldId: WORLD,
        dim: DIM,
        entrances: [],
        path: [point(200, 40, 200), point(201, 40, 200)],
        deepestY: 40,
        dug: 0,
        ores: {},
        createdAt: 1_700_000_600_000,
        lastUsedAt: 1_700_000_650_000,
        uses: 1,
      },
      {
        id: 'psg_deleted',
        worldId: WORLD,
        dim: DIM,
        kind: 'dug',
        entrances: [],
        path: [point(300, 20, 300), point(301, 20, 300)],
        deepestY: 20,
        dug: 1,
        ores: {},
        createdAt: 1_700_000_800_000,
        lastUsedAt: 1_700_000_900_000,
        uses: 1,
      },
    ],
    landmarks: [
      {
        id: 'lm_base',
        worldId: WORLD,
        kind: 'base',
        label: 'Home',
        dim: DIM,
        pos: point(-120.5, 64, -33.25),
        ts: 1_700_001_000_000,
        observedAt: 1_700_001_100_000,
        primary: true,
      },
      {
        id: 'lm_resource',
        worldId: WORLD,
        kind: 'resource',
        label: 'Iron outcrop',
        dim: DIM,
        pos: point(10, 20, -30),
        ts: 1_700_001_200_000,
        observedAt: 1_700_001_300_000,
      },
      {
        id: 'lm_deleted',
        worldId: WORLD,
        kind: 'waypoint',
        label: 'Old waypoint',
        dim: DIM,
        pos: point(1, 2, 3),
        ts: 1_700_001_400_000,
      },
    ],
    chests: {
      'world-1:overworld:-12,64,30': {
        worldId: WORLD,
        dim: DIM,
        pos: point(-12, 64, 30),
        block: 'minecraft:chest',
        uses: 3,
        ts: 1_700_002_000_000,
        day: 5,
        note: 'base storage',
        contents: {
          items: [
            { name: 'minecraft:torch', count: 5 },
            { name: 'minecraft:bread', count: 2 },
          ],
          observedAt: 1_700_002_100_000,
          day: 5,
          possiblyStale: false,
          capacity: 27,
          freeSlots: 21,
        },
      },
      'world-1:overworld:-11,64,30': {
        worldId: WORLD,
        dim: DIM,
        pos: point(-11, 64, 30),
        block: 'minecraft:chest',
        uses: 1,
        ts: 1_700_002_200_000,
        items: [{ name: 'minecraft:coal', count: 1 }],
        traces: [],
      },
      'world-1:overworld:-13,64,30': {
        worldId: WORLD,
        dim: DIM,
        pos: point(-13, 64, 30),
        block: 'minecraft:chest',
        uses: 9,
        ts: 1_700_002_300_000,
        contents: { items: [], observedAt: 1_700_002_400_000, capacity: 27, freeSlots: 27 },
      },
    },
    furnaces: [
      {
        worldId: WORLD,
        dim: DIM,
        pos: point(-14, 64, 30),
        block: 'minecraft:furnace',
        input: { name: 'minecraft:iron_ore', count: 3 },
        output: { name: 'minecraft:iron_ingot', count: 1 },
        fuel: { name: 'minecraft:coal', count: 2 },
        burning: true,
        why: 'fuel',
        ts: 1_700_003_000_000,
      },
      deletedFurnace,
    ],
    farms: [
      {
        worldId: WORLD,
        id: 'farm_wheat',
        dim: DIM,
        crop: 'wheat',
        cells: [point(-20, 64, 40), point(-19, 64, 41), point(-18, 64, 42)],
        plantedAt: 1_700_004_000_000,
        harvests: 2,
      },
      {
        worldId: WORLD,
        id: 'farm_deleted',
        dim: DIM,
        crop: 'carrot',
        cells: [point(50, 64, 50)],
        plantedAt: 1_700_004_100_000,
        harvests: 0,
      },
    ],
    placed: {
      // Unattributed legacy history: the old file has no world/dimension scope.
      '1,64,2': { name: 'minecraft:torch', at: 11 },
      '-5,63,-6': { name: 'minecraft:cobblestone', at: 12 },
      '9,64,9': { name: 'minecraft:torch', at: 13 },
      // Attributed by an external source, and a record from another world.
      '4,64,4': { name: 'minecraft:glass', at: 14, worldId: WORLD, dim: DIM },
      '5,64,5': { name: 'minecraft:stone', at: 15, worldId: 'other-world', dim: DIM },
    },
    visitedChunks: {
      'world-1:overworld:0:0': 3,
      'world-1:overworld:-1:-2': 1,
      'world-1:the_nether:0:0': 2,
      'other-world:overworld:5:5': 9,
    },
    travel: {
      endpoints: [
        {
          id: 'ep_overworld',
          worldId: WORLD,
          dim: DIM,
          pos: point(-12, 64, 30),
          kind: 'nether_portal',
          portalObserved: true,
          observedAt: 1_700_005_000_000,
        },
        {
          id: 'ep_nether',
          worldId: WORLD,
          dim: 'the_nether',
          pos: point(-2, 64, 4),
          kind: 'nether_portal',
          portalObserved: true,
          observedAt: 1_700_005_100_000,
        },
        {
          id: 'ep_deleted',
          worldId: WORLD,
          dim: DIM,
          pos: point(9, 9, 9),
          kind: 'end_portal',
          portalObserved: false,
          observedAt: 1_700_005_200_000,
        },
      ],
      traversals: [
        {
          fromId: 'ep_overworld',
          toId: 'ep_nether',
          ts: 1_700_005_300_000,
          fromSession: 's1',
          toSession: 's2',
          fromObservation: 7,
          toObservation: 8,
        },
      ],
      gateways: [],
    },
  };
}

function makeDeletions(): LegacyDeletionSet {
  return {
    passageIds: ['psg_deleted'],
    landmarkIds: ['lm_deleted'],
    chestKeys: ['world-1:overworld:-13,64,30'],
    furnaceKeys: [legacyBlockKey(deletedFurnace)],
    farmIds: ['farm_deleted'],
    placedKeys: ['9,64,9'],
    endpointIds: ['ep_deleted'],
    chunkVisitKeys: ['world-1:overworld:-1:-2'],
  };
}

function makeQuery() {
  const path = mainPath();
  return {
    dim: DIM,
    pos: path[5]!,
    from: path[0]!,
    to: path[39]!,
  };
}

interface LegacyPage {
  action?: string;
  error?: string;
  records?: { id: string }[];
  path?: Vec3Like[];
  offset?: number;
  total?: number;
  nextOffset?: number | null;
  pointCount?: number;
}

function parsePage(raw: string): LegacyPage {
  return JSON.parse(raw) as LegacyPage;
}

describe('legacy compatibility layer (stage A)', () => {
  it('keeps passage ids, point order, negative/fractional coordinates and 32-point pages', () => {
    const snapshot = makeSnapshot();
    const backend = createLegacyReadBackend(snapshot, makeDeletions());
    const source = makeSnapshot().passages![0]!;
    const context = { worldId: WORLD, dim: DIM, pos: makeQuery().pos };

    const passages = backend.passages(DIM);
    expect(passages.map((rec) => rec.id)).toEqual([
      'psg_main',
      'psg_walk',
      'psg_bridge',
      'psg_default_kind',
    ]);
    expect(passages.some((rec) => rec.id === 'psg_deleted')).toBe(false);
    // The raw JSON still has the tombstoned record; only the explicit deletion hides it.
    expect(createLegacyReadBackend(snapshot).passages(DIM).some((rec) => rec.id === 'psg_deleted')).toBe(true);

    const list = parsePage(queryLegacyPassages(backend, {}, context));
    expect(list.action).toBe('list');
    expect(list.records).toHaveLength(4);
    expect(list.records!.some((rec) => rec.id === 'psg_deleted')).toBe(false);

    const page0 = parsePage(queryLegacyPassages(backend, { id: 'psg_main' }, context));
    expect(page0.action).toBe('read');
    expect(page0.offset).toBe(0);
    expect(page0.total).toBe(40);
    expect(page0.nextOffset).toBe(32);
    expect(page0.path).toEqual(source.path.slice(0, 32));
    expect(page0.path![0]).toEqual({ x: -20, y: 12, z: -7 });
    expect(page0.path![1]).toEqual({ x: -19.5, y: 12, z: -8 });

    const page1 = parsePage(queryLegacyPassages(backend, { id: 'psg_main', offset: 32 }, context));
    expect(page1.offset).toBe(32);
    expect(page1.path).toEqual(source.path.slice(32));
    expect(page1.nextOffset).toBeNull();
    expect(parsePage(queryLegacyPassages(backend, { id: 'psg_missing' }, context)).error).toBe(
      '当前世界和维度没有这个矿道记录',
    );
  });

  it('returns the same passageRoute point sequence for the legacy geometry', () => {
    const snapshot = makeSnapshot();
    const backend = createLegacyReadBackend(snapshot, makeDeletions());
    const query = makeQuery();
    const route = passageRoute(backend.passages(DIM), query.from, query.to);

    expect(route).not.toBeNull();
    expect(route).toHaveLength(40);
    expect(route![0]).toEqual(mainPath()[0]);
    expect(route![10]).toEqual(mainPath()[10]);
    expect(route![39]).toEqual(mainPath()[39]);
    expect(passageRoute(backend.passages(DIM), query.from, query.to)).toEqual(route);
    // Out-of-range endpoints return null rather than fabricating a path.
    expect(passageRoute(backend.passages(DIM), point(999, 999, 999), point(-999, -999, -999))).toBeNull();
  });

  it('retains landmark, chest, furnace, farm, placed and travel fields with original times', () => {
    const snapshot = makeSnapshot();
    const backend = createLegacyReadBackend(snapshot, makeDeletions());
    const landmarks = backend.landmarks();

    expect(landmarks.map((landmark) => landmark.id)).toEqual(['lm_base', 'lm_resource']);
    expect(landmarks[0]).toEqual(snapshot.landmarks![0]);
    expect(landmarks[0]!.pos).toEqual({ x: -120.5, y: 64, z: -33.25 });
    expect(landmarks[0]!.ts).toBe(1_700_001_000_000);
    expect(landmarks[0]!.observedAt).toBe(1_700_001_100_000);

    const ledger = backend.ledger();
    expect(Object.keys(ledger.chests)).toEqual([
      'world-1:overworld:-12,64,30',
      'world-1:overworld:-11,64,30',
    ]);
    expect(ledger.chests['world-1:overworld:-12,64,30']!.contents!.observedAt).toBe(1_700_002_100_000);
    expect(ledger.chests['world-1:overworld:-12,64,30']!.contents!.freeSlots).toBe(21);
    // Imprecise legacy item lines stay imprecise; they are not expanded into a precise ledger.
    expect(ledger.chests['world-1:overworld:-11,64,30']!.contents).toBeUndefined();
    expect(ledger.chests['world-1:overworld:-11,64,30']!.items).toEqual([
      { name: 'minecraft:coal', count: 1 },
    ]);
    expect(ledger.chests['world-1:overworld:-13,64,30']).toBeUndefined();

    expect(ledger.furnaces).toHaveLength(1);
    expect(ledger.furnaces[0]).toEqual(snapshot.furnaces![0]);
    expect(ledger.farms.map((farm) => farm.id)).toEqual(['farm_wheat']);
    expect(ledger.farms[0]!.cells[0]).toEqual({ x: -20, y: 64, z: 40 });
    expect(ledger.placed['-5,63,-6']).toEqual({ name: 'minecraft:cobblestone', at: 12 });
    expect(ledger.placed['9,64,9']).toBeUndefined();
    // Exact visit counts survive; only this world's keys are projected.
    expect(ledger.visitedChunks).toEqual({
      'world-1:overworld:0:0': 3,
      'world-1:the_nether:0:0': 2,
    });
    expect(ledger.travel.endpoints.map((endpoint) => endpoint.id)).toEqual([
      'ep_overworld',
      'ep_nether',
    ]);
    expect(ledger.travel.traversals[0]!.fromObservation).toBe(7);
    // Removing an endpoint does not rewrite the historical crossing that names it.
    expect(ledger.travel.traversals).toHaveLength(1);
  });

  it('separates missing records from explicit deletions', () => {
    const classification = classifyLegacyRecordKeys(['a', 'b', 'c'], ['a', 'd'], ['c']);
    expect(classification).toEqual({
      present: ['a'],
      deleted: ['c'],
      missing: ['b'],
      unexpected: ['d'],
      resurrected: [],
    });
  });
});

describe('passage snapshot import, verification and temporary switch rehearsal', () => {
  it('imports into a temp SQLite database and reopens with identical ids, order, fields, times and route', async () => {
    const snapshot = makeSnapshot();
    const deletions = makeDeletions();
    const report = await runLegacyMigrationDryRun({
      databasePath: makeDbPath(),
      snapshot,
      query: makeQuery(),
      openSession: openSpatialSession,
      deletions,
    });

    expect(report.stages.a.status).toBe('passed');
    expect(report.stages.b.status).toBe('passed');
    expect(report.stages.c.status).toBe('passed');
    expect(report.stages.d.status).toBe('passed');
    expect(report.realMigrationPerformed).toBe(false);
    expect(report.realAuthoritySwitch).toBe(false);
    expect(report.legacyWritePathRemoved).toBe(false);
    expect(report.unmigratedCollections).toContain('chests');
    expect(report.unmigratedCollections).toContain('farms');

    if (report.stages.b.status !== 'passed') throw new Error('stage B did not pass');
    if (report.stages.c.status !== 'passed') throw new Error('stage C did not pass');

    expect(report.stages.b.importedIds).toEqual([
      'psg_main',
      'psg_walk',
      'psg_bridge',
      'psg_default_kind',
    ]);
    expect(report.stages.b.skippedDeletedIds).toEqual(['psg_deleted']);
    expect(report.stages.b.problems).toEqual([]);
    expect(report.stages.b.checkpointId).toEqual(expect.any(String));
    expect(report.stages.b.dirtyAfterCheckpoint).toBe(false);
    expect(report.stages.b.lifecycleAfterCheckpoint).toBe('open');

    expect(report.stages.c.verification.ok).toBe(true);
    expect(report.stages.c.verification.restoredOrder).toEqual(report.stages.b.importedIds);
    expect(report.stages.c.listMatchesBefore).toBe(true);
    expect(report.stages.c.readsMatchBefore).toBe(true);
    expect(report.stages.c.routeMatchesBefore).toBe(true);
    expect(report.stages.c.deletedIdsChecked).toEqual(['psg_deleted']);
    expect(report.stages.c.deletedNotResurrected).toBe(true);

    const main = report.stages.c.verification.retained.find((record) => record.id === 'psg_main');
    expect(main).toEqual({
      id: 'psg_main',
      createdAt: 1_700_000_000_000,
      lastUsedAt: 1_700_000_100_000,
      uses: 4,
      deepestY: 9,
      geometrySource: 'legacy',
    });
    // The route is still the same 40-point historical sequence after the switch.
    expect(report.stages.a.route).toHaveLength(40);
    expect(report.stages.a.route![0]).toEqual({ x: -20, y: 12, z: -7 });
    expect(report.stages.a.route![39]).toEqual({ x: -0.5, y: 9, z: -46 });

    // Imported legacy geometry is history, not a fresh observation or OPEN state.
    expect(report.stages.c.historical).toEqual({
      traversalEvidence: 0,
      voxelSections: 0,
      voxelSectionAtQueryPos: false,
      geometrySources: ['legacy'],
    });
    expect(report.stages.d.sessionsClosed).toBe(true);
    expect(report.stages.d.sourceSnapshotUnchanged).toBe(true);
    expect(report.stages.d.realCleanupPerformed).toBe(false);
  });

  it('rehearses placed, chunk-visit and portal batches with per-batch verification counts', async () => {
    const report = await runLegacyMigrationDryRun({
      databasePath: makeDbPath(),
      snapshot: makeSnapshot(),
      query: makeQuery(),
      openSession: openSpatialSession,
      deletions: makeDeletions(),
    });
    expect(report.stages.b.status).toBe('passed');
    expect(report.stages.c.status).toBe('passed');
    expect(report.realMigrationPerformed).toBe(false);
    expect(report.realAuthoritySwitch).toBe(false);
    expect(report.legacyWritePathRemoved).toBe(false);

    const plans = Object.fromEntries(report.batchPlans.map((plan) => [plan.batch, plan]));
    const landmarkPlan = plans.landmarks!;
    expect(landmarkPlan).toMatchObject({
      status: 'planned',
      destination: 'planned:spatial_nodes',
      expectedIds: ['lm_base', 'lm_resource'],
      deletedRecords: 1,
      idsMatch: true,
      timesMatch: true,
    });
    expect(landmarkPlan.expectedValues['lm_base']).toBe(1_700_001_000_000);

    const placedPlan = plans.placed!;
    expect(placedPlan).toMatchObject({
      status: 'imported',
      destination: 'placed_blocks',
      importedIds: ['world-1:overworld:4,64,4'],
      unattributedIds: ['1,64,2', '-5,63,-6'],
      crossWorldIds: ['5,64,5'],
      deletedRecords: 1,
      timesMatch: true,
    });
    // The LRU serial is preserved verbatim; it is not a timestamp.
    expect(placedPlan.expectedValues['world-1:overworld:4,64,4']).toBe(14);

    const visitPlan = plans.chunkVisits!;
    expect(visitPlan).toMatchObject({
      status: 'imported',
      destination: 'chunk_visits',
      deletedRecords: 1,
      crossWorldRecords: 1,
      crossWorldIds: ['other-world:overworld:5:5'],
      timesMatch: true,
    });
    expect(visitPlan.expectedValues).toEqual({
      'world-1:overworld:0:0': 3,
      'world-1:the_nether:0:0': 2,
    });

    const endpointPlan = plans.travelEndpoints!;
    expect(endpointPlan).toMatchObject({
      status: 'planned',
      expectedIds: ['ep_overworld', 'ep_nether'],
      deletedRecords: 1,
      timesMatch: true,
    });
    expect(endpointPlan.expectedValues).toEqual({
      ep_overworld: 1_700_005_000_000,
      ep_nether: 1_700_005_100_000,
    });

    const crossingId = portalTraversalIdentity({
      kind: 'traversal',
      fromId: 'ep_overworld',
      toId: 'ep_nether',
      ts: 1_700_005_300_000,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 7,
      toObservation: 8,
    });
    const traversalPlan = plans.travelTraversals!;
    expect(traversalPlan).toMatchObject({
      status: 'imported',
      destination: 'portal_traversals',
      importedIds: [crossingId],
      timesMatch: true,
      evidenceIntact: true,
    });
    expect(traversalPlan.expectedValues).toEqual({ [crossingId]: 1_700_005_300_000 });
    expect(plans.travelGateways).toMatchObject({ status: 'imported', importedRecords: 0 });

    expect(report.stages.c.status).not.toBe('not_run');
    if (report.stages.c.status === 'passed' || report.stages.c.status === 'failed') {
      expect(report.stages.c.ledgerOk).toBe(true);
      expect(report.stages.c.ledgerVerification.every((plan) => plan.ok)).toBe(true);
    }
    expect(report.verificationCounts).toMatchObject({
      unattributedRecords: 2,
      crossWorldRecords: 2,
      deletedRecords: 5,
      // Planned-only batches (landmarks/endpoints) were never written or read
      // back, so they cannot count as verified.
      allVerified: false,
    });
    expect(report.verificationCounts.plannedRecords).toBeGreaterThan(0);
    expect(report.rehearsedBatches).toEqual(
      expect.arrayContaining(['passages', 'placed', 'chunkVisits', 'travelTraversals', 'travelGateways']),
    );
    expect(report.plannedBatches).toEqual(expect.arrayContaining(['landmarks', 'travelEndpoints']));
    expect(report.unmigratedCollections).toEqual(['chests', 'furnaces', 'farms']);
  });

  it('does not resurrect a tombstoned passage from the still-present JSON after the switch', () => {
    const snapshot = makeSnapshot();
    const deletions = makeDeletions();
    const store = new FragmentStore(WORLD);
    importLegacyPassages(store, snapshot, deletions);
    const view = createSwitchedLegacyView(store, snapshot, deletions);
    const context = { worldId: WORLD, dim: DIM, pos: makeQuery().pos };

    expect(view.passages(DIM).map((rec) => rec.id)).not.toContain('psg_deleted');
    expect(parsePage(queryLegacyPassages(view, { id: 'psg_deleted' }, context)).error).toBe(
      '当前世界和维度没有这个矿道记录',
    );
    // The un-tombstoned JSON fallback would have returned it.
    expect(
      createLegacyReadBackend(snapshot)
        .passages(DIM)
        .some((rec) => rec.id === 'psg_deleted'),
    ).toBe(true);

    // A record that disappears from the migrated store is also not back-filled
    // from JSON; only an explicit tombstone changes the classification.
    store.forgetFragment('psg_walk');
    expect(view.passages(DIM).map((rec) => rec.id)).not.toContain('psg_walk');

    // Legacy-only fields survive the switch instead of being dropped by the
    // slimmer library model; an absent `kind` stays absent.
    const main = view.passages(DIM).find((rec) => rec.id === 'psg_main')!;
    const sourceMain = snapshot.passages![0]!;
    expect(main.path).toEqual(sourceMain.path);
    expect(main.links).toEqual(sourceMain.links);
    expect(main.dug).toBe(17);
    expect(main.ores).toEqual({ 'minecraft:diamond_ore': 2, ancient_debris: 1 });
    expect(main.kind).toBe('dug');
    const defaultKind = view.passages(DIM).find((rec) => rec.id === 'psg_default_kind')!;
    expect('kind' in defaultKind).toBe(false);

    // The unmigrated ledgers still apply their explicit tombstones and keep
    // original observation times after the switch rehearsal.
    const switchedLedger = view.ledger();
    expect(switchedLedger.chests['world-1:overworld:-13,64,30']).toBeUndefined();
    expect(switchedLedger.chests['world-1:overworld:-12,64,30']!.contents!.observedAt).toBe(
      1_700_002_100_000,
    );
    expect(switchedLedger.farms.map((farm) => farm.id)).toEqual(['farm_wheat']);
    expect(switchedLedger.furnaces.map((furnace) => furnace.ts)).toEqual([1_700_003_000_000]);
    expect(view.landmarks().map((landmark) => landmark.id)).toEqual(['lm_base', 'lm_resource']);
    expect(view.landmarks()[0]!.observedAt).toBe(1_700_001_100_000);
  });

  it('fails verification when a stored coordinate no longer matches the legacy point order', async () => {
    const snapshot = makeSnapshot();
    const deletions = makeDeletions();
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      importLegacyPassages(session.history, snapshot, deletions);
      session.history.updateFragment('psg_main', { polyline: [point(0, 0, 0)] });
      const result = verifyLegacyPassageImport(session.history, snapshot, deletions);
      expect(result.ok).toBe(false);
      expect(result.problems.some((problem) => problem.code === 'field_mismatch' && problem.id === 'psg_main')).toBe(true);
      expect(result.problems.find((problem) => problem.code === 'field_mismatch')!.detail).toMatch(
        /path point order\/coordinates differ/,
      );
    } finally {
      await session.close();
    }
  });

  it('reports an absent record as missing, not deleted, until an explicit tombstone exists', () => {
    const snapshot = makeSnapshot();
    const deletions = makeDeletions();
    const store = new FragmentStore(WORLD);
    importLegacyPassages(store, snapshot, deletions);
    store.forgetFragment('psg_walk');

    const missing = verifyLegacyPassageImport(store, snapshot, deletions);
    expect(missing.ok).toBe(false);
    expect(missing.problems).toContainEqual({
      code: 'missing_without_delete_marker',
      id: 'psg_walk',
    });

    const tombstoned = verifyLegacyPassageImport(store, snapshot, {
      ...deletions,
      passageIds: [...deletions.passageIds!, 'psg_walk'],
    });
    expect(tombstoned.ok).toBe(true);
    expect(tombstoned.problems).toEqual([]);
  });

  it('detects a deleted record that the importer resurrected from JSON', () => {
    const snapshot = makeSnapshot();
    const deletions = makeDeletions();
    const store = new FragmentStore(WORLD);
    importLegacyPassages(store, snapshot); // no tombstones on purpose

    const result = verifyLegacyPassageImport(store, snapshot, deletions);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      code: 'resurrected_deleted_passage',
      id: 'psg_deleted',
    });
  });

  it('rejects a passage without a proven world scope and leaves no committed rows', async () => {
    const snapshot = makeSnapshot();
    const bad = {
      ...snapshot.passages![1]!,
      id: 'psg_bad_scope',
      worldId: undefined,
    };
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(() =>
      importLegacyPassages(session.history, { ...snapshot, passages: [...snapshot.passages!, bad] }),
    ).toThrow(/world scope/);
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      // The failed batch was never checkpointed; the temp database stays empty.
      expect(reopened.history.checkpointSnapshot().fragments).toHaveLength(0);
    } finally {
      await reopened.close();
    }
  });
});

// =============================================================================
// Authority gate (M6.3): structured, decidable, never enabled
// =============================================================================

function gateSnapshot(): LegacySpatialSnapshot {
  // Only migrated collections with proven scope, so every gate condition can hold.
  const snapshot = makeSnapshot();
  return {
    worldId: WORLD,
    passages: [snapshot.passages![0]!, snapshot.passages![1]!],
    placed: {},
    visitedChunks: {},
    travel: { endpoints: [], traversals: [], gateways: [] },
  };
}

function gateQuery(snapshot: LegacySpatialSnapshot) {
  const path = snapshot.passages![0]!.path;
  return { dim: DIM, pos: path[5]!, from: path[0]!, to: path[path.length - 1]! };
}

function runGate(
  snapshot: LegacySpatialSnapshot,
  deletions: LegacyDeletionSet = {},
  migrationGate?: { operatorOptIn?: boolean; declaredMigratedBatches?: LegacyBatchName[] },
) {
  return runLegacyMigrationDryRun({
    databasePath: makeDbPath(),
    snapshot,
    query: gateQuery(snapshot),
    openSession: openSpatialSession,
    deletions,
    migrationGate,
  });
}

function gateConditions(report: Awaited<ReturnType<typeof runLegacyMigrationDryRun>>) {
  return Object.fromEntries(report.gate.conditions.map((condition) => [condition.condition, condition.ok]));
}

describe('JSON→SQLite authority gate (advisory, never auto-enabled)', () => {
  it('reports not_satisfied with structured reasons when the rehearsal is incomplete', async () => {
    const report = await runGate(makeSnapshot(), makeDeletions());

    // Conditions are named + observed facts, not a single boolean.
    expect(report.gate.conditions.map((condition) => condition.condition)).toEqual([
      'stages_all_passed',
      'verification_all_verified',
      'no_unattributed_records',
      'no_cross_world_records',
      'no_invalid_records',
      'deleted_not_resurrected',
      'planned_destinations_declared',
      'stage_d_trusted',
    ]);
    expect(gateConditions(report).stages_all_passed).toBe(true);
    expect(report.gate.status).toBe('not_satisfied');
    expect(report.gate.satisfied).toBe(false);

    // Reasons are typed codes carrying the offending records/batches.
    const codes = report.gate.reasons.map((reason) => reason.code);
    expect(report.gate.conditions.find((condition) => condition.condition === 'verification_all_verified')!.ok).toBe(true);
    expect(codes).toContain('unattributed_records');
    expect(codes).toContain('cross_world_records');
    expect(codes).toContain('batch_planned_only');
    expect(codes).not.toContain('deleted_resurrected');
    const unattributed = report.gate.conditions.find(
      (condition) => condition.condition === 'no_unattributed_records',
    )!;
    expect(unattributed.observed.unattributedRecords).toBeGreaterThan(0);
    const crossWorld = report.gate.conditions.find(
      (condition) => condition.condition === 'no_cross_world_records',
    )!;
    expect(crossWorld.observed.crossWorldRecords).toBeGreaterThan(0);
    // Deletion facts used by the gate are carried explicitly, not just implied.
    const deletedFacts = report.gate.conditions.find(
      (condition) => condition.condition === 'deleted_not_resurrected',
    )!;
    expect(deletedFacts.ok).toBe(true);
    expect(deletedFacts.observed.deletedIdsChecked).toEqual(['psg_deleted']);
    expect(deletedFacts.observed.resurrectedIds).toEqual([]);

    // The gate never changes the dry-run guarantees.
    expect(report.gate.guarantees).toEqual({
      realAuthoritySwitch: false,
      legacyWritePathRemoved: false,
      dualWrite: false,
      jsonReadFallbackForMissingRecords: false,
    });
    expect(report.gate.rollback).toBe('drop_temp_database_and_reopen_legacy');
  });

  it('stays not_satisfied while plan-only batches are undeclared, and never switches', async () => {
    const report = await runGate(gateSnapshot(), {}, { operatorOptIn: true });

    expect(report.stages.a.status).toBe('passed');
    expect(report.stages.b.status).toBe('passed');
    expect(report.stages.c.status).toBe('passed');
    expect(report.stages.d.status).toBe('passed');
    // Landmarks / portal endpoints are still plan-only, so the gate names that
    // fact explicitly instead of hiding it in the aggregate.
    expect(report.gate.reasons.map((reason) => reason.code)).toEqual(['batch_planned_only']);
    const declared = report.gate.conditions.find(
      (condition) => condition.condition === 'planned_destinations_declared',
    )!;
    expect(declared.ok).toBe(false);
    expect(declared.observed.plannedBatches).toEqual(
      expect.arrayContaining(['landmarks', 'travelEndpoints']),
    );
    expect(report.gate.status).toBe('not_satisfied');
    expect(report.gate.satisfied).toBe(false);
    // The opt-in is recorded, not acted on.
    expect(report.gate.operatorOptIn).toBe(true);
    expect(report.gate.requiresManualEnable).toBe(true);
    expect(report.gate.autoSwitchImplemented).toBe(false);
    expect(report.gate.guarantees).toEqual({
      realAuthoritySwitch: false,
      legacyWritePathRemoved: false,
      dualWrite: false,
      jsonReadFallbackForMissingRecords: false,
    });
    expect(report.realAuthoritySwitch).toBe(false);
    expect(report.realMigrationPerformed).toBe(false);
    expect(report.legacyWritePathRemoved).toBe(false);
  });

  it('reaches satisfied_but_disabled through runLegacyMigrationDryRun when plan-only batches are declared', async () => {
    const report = await runGate(gateSnapshot(), {}, {
      operatorOptIn: true,
      declaredMigratedBatches: ['landmarks', 'travelEndpoints'],
    });

    // Discriminative wiring: a gate hard-wired to not_satisfied fails here.
    expect(report.gate.status).toBe('satisfied_but_disabled');
    expect(report.gate.satisfied).toBe(true);
    expect(report.gate.reasons).toEqual([]);
    expect(report.gate.conditions.every((condition) => condition.ok)).toBe(true);
    // The declaration is recorded in the condition facts, not acted on.
    const declared = report.gate.conditions.find(
      (condition) => condition.condition === 'planned_destinations_declared',
    )!;
    expect(declared.observed.declaredMigratedBatches).toEqual(
      expect.arrayContaining(['landmarks', 'travelEndpoints']),
    );
    expect(report.gate.autoSwitchImplemented).toBe(false);
    expect(report.gate.requiresManualEnable).toBe(true);
    expect(report.gate.guarantees).toEqual({
      realAuthoritySwitch: false,
      legacyWritePathRemoved: false,
      dualWrite: false,
      jsonReadFallbackForMissingRecords: false,
    });
    // Satisfied still means disabled at the report level.
    expect(report.realMigrationPerformed).toBe(false);
    expect(report.realAuthoritySwitch).toBe(false);
    expect(report.legacyWritePathRemoved).toBe(false);
  });

  it('keeps a tombstoned passage absent and records it in the gate conditions', async () => {
    const snapshot = gateSnapshot();
    const deletions: LegacyDeletionSet = { passageIds: ['psg_walk'] };
    const report = await runGate(snapshot, deletions, { operatorOptIn: true });

    expect(report.gate.conditions.find((condition) => condition.condition === 'deleted_not_resurrected')!.ok).toBe(true);
    if (report.stages.c.status !== 'passed') throw new Error('stage C did not pass');
    expect(report.stages.c.deletedIdsChecked).toEqual(['psg_walk']);
    expect(report.stages.c.deletedNotResurrected).toBe(true);
    // The raw JSON still holds the tombstoned record; nothing reads it back.
    expect(
      createLegacyReadBackend(snapshot).passages(DIM).some((rec) => rec.id === 'psg_walk'),
    ).toBe(true);
    expect(report.realAuthoritySwitch).toBe(false);
  });

  it('does not fall back to JSON for a record missing from the migrated store', () => {
    // Behavioural M6.3 evidence: the gate's "no JSON read fallback" claim is
    // exercised on the switched read view itself, not inferred from source text.
    const snapshot = gateSnapshot();
    const store = new FragmentStore(WORLD);
    importLegacyPassages(store, snapshot);
    const view = createSwitchedLegacyView(store, snapshot);
    const context = { worldId: WORLD, dim: DIM, pos: gateQuery(snapshot).pos };

    store.forgetFragment('psg_walk');
    // The raw JSON still contains the record...
    expect(
      createLegacyReadBackend(snapshot).passages(DIM).some((rec) => rec.id === 'psg_walk'),
    ).toBe(true);
    // ...and the switched view neither returns it nor reads it back from JSON.
    expect(view.passages(DIM).map((rec) => rec.id)).not.toContain('psg_walk');
    expect(parsePage(queryLegacyPassages(view, { id: 'psg_walk' }, context)).error).toBe(
      '当前世界和维度没有这个矿道记录',
    );
    expect(view.passages().map((rec) => rec.id)).not.toContain('psg_walk');
  });

  it('withholds the gate when an importer resurrects a deleted record', () => {
    const snapshot = gateSnapshot();
    const deletions: LegacyDeletionSet = { passageIds: ['psg_walk'] };
    const store = new FragmentStore(WORLD);
    importLegacyPassages(store, snapshot); // no tombstones on purpose
    const verification = verifyLegacyPassageImport(store, snapshot, deletions);

    const gate = evaluateMigrationGate({
      stages: {
        a: { status: 'passed' },
        b: { status: 'failed', problems: verification.problems },
        c: {
          status: 'failed',
          deletedNotResurrected: false,
          deletedIdsChecked: ['psg_walk'],
          verification,
        },
        d: { status: 'passed', sessionsClosed: true, sourceSnapshotUnchanged: true },
      },
      verificationCounts: {
        allVerified: false,
        unattributedRecords: 0,
        crossWorldRecords: 0,
        invalidRecords: 0,
      },
      batchPlans: [{ batch: 'passages', status: 'failed', ok: false }],
    });

    expect(gate.status).toBe('not_satisfied');
    const resurrected = gate.reasons.find((reason) => reason.code === 'deleted_resurrected')!;
    expect(resurrected).toBeDefined();
    const deletedCondition = gate.conditions.find((condition) => condition.condition === 'deleted_not_resurrected')!;
    expect(deletedCondition.observed.resurrectedIds).toContain('psg_walk');
    expect(gate.guarantees.realAuthoritySwitch).toBe(false);
  });

  it('regression guard: no dual-write or authority-switch branch in the module source', () => {
    // Regression guard only. The behavioural evidence for "no JSON read
    // fallback" is the switched-view test above; this scan catches a future
    // edit that introduces an obvious dual-write/switch branch.
    const source = readFileSync(
      new URL('../src/compat/migration-dry-run.ts', import.meta.url),
      'utf8',
    );
    const forbidden = [
      /\bdualWrite\b(?!:\s*false)/,
      /\bwriteBothStores\b|\bwriteJsonAndSqlite\b|\bmirrorToJson\b/,
      /\bswitchAuthority\b\s*=\s*(?!false)/,
      /\bbuildOutputDatabasePath\b|\bresolveUserDatabasePath\b/,
    ];
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    // The gate's guarantees are literal false facts in the shipped code.
    expect(source).toMatch(/realAuthoritySwitch:\s*false\s+as\s+const/);
    expect(source).toMatch(/legacyWritePathRemoved:\s*false\s+as\s+const/);
    expect(source).toMatch(/jsonReadFallbackForMissingRecords:\s*false/);
  });
});
