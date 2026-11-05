import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { FragmentStore, TopologyStore, VoxelMap } from '../src/index.js';
import type { CellView, Observation, PathFragment, VoxelCheckpointSnapshot } from '../src/index.js';
import { openHistorySession, openSpatialSession, PersistenceError } from '../dist/storage/sqlite/index.js';
import { SNAPSHOT_FRAME_BYTES, VOXEL_FRAME_BYTES } from '../src/storage/sqlite/types.js';
import * as distBytes from '../dist/bytes.js';

const WORLD = 'world';
const DIM = 'overworld';

const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };
const air = { name: 'minecraft:air', properties: {} };
const doorClosed = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'false' } };
const doorOpen = { name: 'minecraft:oak_door', properties: { half: 'lower', open: 'true' } };

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: stone,
    pos: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function frag(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'f1',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [{ x: 0.5, y: 64, z: 0.5 }],
    polyline: [
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
    ],
    geometrySource: 'traversal',
    deepestY: 12,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

function evidence(
  map: { cellAt(dim: string, x: number, y: number, z: number): CellView },
  x: number,
  y: number,
  z: number,
  dim = DIM,
) {
  const view = map.cellAt(dim, x, y, z);
  if (!view.observed) throw new Error(`expected observed cell at ${x},${y},${z}`);
  return view.evidence;
}

/** Exact serialized bytes of one voxel section, mirroring the worker's encoder. */
function exactVoxelSectionBytes(section: VoxelCheckpointSnapshot['sections'][number]): number {
  const payload = {
    v: 1,
    dim: section.dim,
    cx: section.cx,
    cz: section.cz,
    sy: section.sy,
    palette: section.palette,
    bits: section.bits,
    cells: Buffer.from(section.cells).toString('base64'),
    evidence: section.evidence.map((c) => ({ i: c.index, e: c.evidence })),
    revision: section.revision,
  };
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

// --- temp db helpers ----------------------------------------------------------

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-5b-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

/** Create a v1 database with optional history data, for the upgrade-path tests. */
function writeV1Schema(dbPath: string, options: { extraCheckpointColumn?: string } = {}): void {
  const db = new Database(dbPath);
  const extra = options.extraCheckpointColumn ?? '';
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
    CREATE TABLE checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      fragment_revision INTEGER NOT NULL,
      topology_revision INTEGER NOT NULL,
      seq INTEGER NOT NULL${extra}
    );
    CREATE TABLE path_fragments (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE traversal_evidence (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE spatial_nodes (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
    CREATE TABLE spatial_edges (world_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (world_id, id));
  `);
  db.close();
}

/**
 * Simulate a real v2 database from the current fixture: remove every later
 * schema object (v5 ledger tables/section columns, v4 journal objects, v3 section
 * metadata), then set the version back to 2. This keeps the migration test honest
 * — it does not leave later-schema objects behind for the v2 validation to
 * accidentally accept.
 */
function downgradeToV2(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS placed_blocks');
  db.exec('DROP TABLE IF EXISTS chunk_visits');
  db.exec('DROP TABLE IF EXISTS portal_traversals');
  db.exec('DROP INDEX IF EXISTS spatial_sections_world_coords');
  db.exec('ALTER TABLE checkpoints DROP COLUMN ledger_revision');
  db.exec('ALTER TABLE checkpoints DROP COLUMN has_ledger');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN dimension');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cx');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN cz');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN sy');
  db.exec('DROP TABLE IF EXISTS action_records');
  db.exec('DROP TABLE IF EXISTS spatial_events');
  db.exec('ALTER TABLE checkpoints DROP COLUMN journal_revision');
  db.exec('ALTER TABLE checkpoints DROP COLUMN has_journal');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN observed_cells');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN palette_entries');
  db.exec('ALTER TABLE spatial_sections DROP COLUMN revision');
  db.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Pure VoxelMap snapshot / restore / save-revision tests (no SQLite)
// ==============================================================================

describe('VoxelMap saveRevision', () => {
  it('advances on insert, change, restore, stale and refresh-only updates', () => {
    const map = new VoxelMap(WORLD);
    expect(map.saveRevision).toBe(0);

    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(map.saveRevision).toBe(1);

    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    expect(map.saveRevision).toBe(2);

    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 3000, sequence: 3 }));
    expect(map.saveRevision).toBe(3); // refresh-only still advances

    map.markStale(DIM, 'unloaded');
    expect(map.saveRevision).toBe(4);
  });

  it('does not advance on rejected, idempotent, or read-only operations', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(map.saveRevision).toBe(1);

    // Idempotent duplicate at the same timestamp.
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(map.saveRevision).toBe(1);

    // Older acquisition (rejected).
    map.observe(obs({ state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 500, sequence: 2 }));
    expect(map.saveRevision).toBe(1);

    // Foreign session (rejected).
    map.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 }, sessionId: 'other', observedAt: 2000 }));
    expect(map.saveRevision).toBe(1);

    // Read-only.
    map.cellAt(DIM, 0, 0, 0);
    map.sectionAt(DIM, 0, 0, 0);
    expect(map.saveRevision).toBe(1);
  });
});

describe('VoxelMap checkpoint snapshot', () => {
  it('is deeply isolated from the store', () => {
    const map = new VoxelMap(WORLD);
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const snap = map.checkpointSnapshot();

    snap.sections[0]!.palette.length = 0;
    snap.sections[0]!.cells[0] = 255;
    snap.sections[0]!.evidence[0]!.evidence.observation.state.name = 'minecraft:air';

    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    expect(evidence(map, 0, 0, 0).observation.state).toEqual(stone);
    expect(map.sectionAt(DIM, 0, 0, 0)!.palette.length).toBe(2);
  });

  it('measures sections, observed cells, palette entries and bytes', () => {
    const map = new VoxelMap(WORLD);
    expect(map.checkpointMeasure()).toMatchObject({ sections: 0, observedCells: 0, paletteEntries: 0, bytes: 0 });

    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    map.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 } }));
    map.observe(obs({ state: stone, pos: { x: 20, y: 0, z: 0 } })); // second section

    const measure = map.checkpointMeasure();
    expect(measure.sections).toBe(2);
    expect(measure.observedCells).toBe(3);
    expect(measure.paletteEntries).toBe(5); // 3 (air+stone+dirt) + 2 (air+stone)
    expect(measure.bytes).toBeGreaterThan(0);
  });
});

describe('VoxelMap restoreSnapshot', () => {
  it('round-trips facts and re-marks FRESH as STALE', () => {
    const source = new VoxelMap(WORLD);
    source.observe(obs({ state: stone, pos: { x: -1, y: 5, z: -2 }, observedAt: 1111, sequence: 7 }));
    source.observe(obs({ state: air, pos: { x: 0, y: 5, z: 0 }, observedAt: 2222 }));
    source.observe(obs({ state: doorClosed, pos: { x: 16, y: 0, z: 0 }, observedAt: 3333 }));

    const target = new VoxelMap(WORLD);
    target.restoreSnapshot(source.checkpointSnapshot());

    const e = evidence(target, -1, 5, -2);
    expect(e.freshness).toBe('STALE');
    expect(e.staleReason).toBe('observation_gap');
    expect(e.observation.observedAt).toBe(1111);
    expect(e.observation.sequence).toBe(7);
    expect(e.observation.pos).toEqual({ x: -1, y: 5, z: -2 });

    // Confirmed air is restored as air (not unknown).
    const airEv = evidence(target, 0, 5, 0);
    expect(airEv.observation.state.name).toBe('minecraft:air');
    expect(airEv.freshness).toBe('STALE');

    // State properties preserved (not string-split).
    expect(evidence(target, 16, 0, 0).observation.state).toEqual(doorClosed);

    // Never-observed cells stay unknown.
    expect(target.cellAt(DIM, 1, 5, 0)).toEqual({ observed: false });
  });

  it('preserves original sessionId and attribution, never treating it as current', () => {
    const source = new VoxelMap(WORLD);
    source.observe(
      obs({
        sessionId: 'old-session',
        originObservationId: 42,
        actionId: 'act-1',
        observedWorldTick: 99,
        source: 'agent_action',
        evidence: 'confirmed_effect',
        state: stone,
        pos: { x: 0, y: 0, z: 0 },
      }),
    );

    const target = new VoxelMap(WORLD);
    target.restoreSnapshot(source.checkpointSnapshot());
    const e = evidence(target, 0, 0, 0);
    expect(e.observation.sessionId).toBe('old-session');
    expect(e.observation.originObservationId).toBe(42);
    expect(e.observation.actionId).toBe('act-1');
    expect(e.observation.observedWorldTick).toBe(99);
    expect(e.observation.source).toBe('agent_action');
  });

  it('rejects restore into a non-empty map', () => {
    const source = new VoxelMap(WORLD);
    source.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const snapshot = source.checkpointSnapshot();

    const target = new VoxelMap(WORLD);
    target.observe(obs({ state: dirt, pos: { x: 5, y: 0, z: 0 } }));
    expect(() => target.restoreSnapshot(snapshot)).toThrow(/pristine/);
  });

  it('rejects corrupt snapshots without a half-restored map', () => {
    const source = new VoxelMap(WORLD);
    source.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    const badWorld = new VoxelMap(WORLD);
    const badWorldSnap: VoxelCheckpointSnapshot = { worldId: 'other', sections: source.checkpointSnapshot().sections };
    expect(() => badWorld.restoreSnapshot(badWorldSnap)).toThrow(/worldId/);

    // Palette index 0 not air.
    const badPalette = source.checkpointSnapshot();
    badPalette.sections[0]!.palette[0] = 'minecraft:stone';
    expect(() => new VoxelMap(WORLD).restoreSnapshot(badPalette)).toThrow(/air/);

    // Bits do not match palette length.
    const badBits = source.checkpointSnapshot();
    badBits.sections[0]!.bits = 3;
    expect(() => new VoxelMap(WORLD).restoreSnapshot(badBits)).toThrow(/bits/);

    // Wrong cells length.
    const badCells = source.checkpointSnapshot();
    badCells.sections[0]!.cells = new Uint8Array(10);
    expect(() => new VoxelMap(WORLD).restoreSnapshot(badCells)).toThrow(/length/);

    // Duplicate cell index.
    const dup = source.checkpointSnapshot();
    const cell = dup.sections[0]!.evidence[0]!;
    dup.sections[0]!.evidence = [cell, { ...cell, evidence: { ...cell.evidence, revision: 2 } }];
    expect(() => new VoxelMap(WORLD).restoreSnapshot(dup)).toThrow(/duplicate/);

    // revision disagrees with evidence revisions.
    const rev = source.checkpointSnapshot();
    rev.sections[0]!.revision = 99;
    expect(() => new VoxelMap(WORLD).restoreSnapshot(rev)).toThrow(/revision/);

    // palette/evidence disagree.
    const mismatch = source.checkpointSnapshot();
    mismatch.sections[0]!.evidence[0]!.evidence.observation.state = dirt;
    expect(() => new VoxelMap(WORLD).restoreSnapshot(mismatch)).toThrow(/disagree/);
  });

  it('rejects an observation whose position belongs to another section or dimension', () => {
    const source = new VoxelMap(WORLD);
    source.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));

    // Position moved to a different section (cx=1) — must be rejected.
    const wrongSection = source.checkpointSnapshot();
    wrongSection.sections[0]!.evidence[0]!.evidence.observation.pos = { x: 16, y: 0, z: 0 };
    expect(() => new VoxelMap(WORLD).restoreSnapshot(wrongSection)).toThrow(/section/);

    // Position moved within the section but to a different local cell.
    const wrongCell = source.checkpointSnapshot();
    wrongCell.sections[0]!.evidence[0]!.evidence.observation.pos = { x: 1, y: 0, z: 0 };
    expect(() => new VoxelMap(WORLD).restoreSnapshot(wrongCell)).toThrow(/cell index/);

    // Observation from a different dimension.
    const wrongDim = source.checkpointSnapshot();
    wrongDim.sections[0]!.evidence[0]!.evidence.observation.dim = 'the_nether';
    expect(() => new VoxelMap(WORLD).restoreSnapshot(wrongDim)).toThrow(/dim/);
  });

  it('rejects restore into a map that was already activated, even with no sections', () => {
    const source = new VoxelMap(WORLD);
    source.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    const snapshot = source.checkpointSnapshot();

    const activated = new VoxelMap(WORLD);
    activated.beginSession('current');
    expect(() => activated.restoreSnapshot(snapshot)).toThrow(/pristine/);

    const interrupted = new VoxelMap(WORLD);
    interrupted.markStale(DIM, 'unloaded');
    expect(() => interrupted.restoreSnapshot(snapshot)).toThrow(/pristine/);
  });

  it('requireSession rejects observation before an explicit beginSession', () => {
    const map = new VoxelMap(WORLD, { requireSession: true });
    const report = map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(report.sections).toEqual([]);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });

    map.beginSession('s1');
    map.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
  });

  it('voxel byte estimate is conservative against the real serialized size (many properties)', () => {
    const map = new VoxelMap(WORLD);
    const props: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) props[`p${i}`] = `v${i}`;
    map.observe(obs({ state: { name: 'minecraft:stone', properties: props }, pos: { x: 0, y: 0, z: 0 } }));

    const snapshot = map.checkpointSnapshot();
    const exact = snapshot.sections.reduce((sum, s) => sum + exactVoxelSectionBytes(s), 0);
    const estimate = map.checkpointMeasure().bytes;
    expect(estimate).toBeGreaterThanOrEqual(exact);
  });
});

// ==============================================================================
// SQLite combined spatial session tests (real worker + real SQLite + temp files)
// ==============================================================================

describe('SQLite combined spatial persistence', () => {
  it('round-trips voxel facts through close and reopen, restored as STALE', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    session.voxel.observe(obs({ state: air, pos: { x: 1, y: 0, z: 0 }, observedAt: 1000 }));
    session.history.saveFragment(frag());
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const e = evidence(reopened.voxel, 0, 0, 0);
    expect(e.freshness).toBe('STALE');
    expect(e.observation.state).toEqual(stone);
    expect(e.observation.observedAt).toBe(1000);
    expect(evidence(reopened.voxel, 1, 0, 0).observation.state.name).toBe('minecraft:air');
    expect(reopened.history.getFragment('f1')).not.toBeNull();
    const state = reopened.getPersistenceState();
    expect(state.dirty).toBe(false);
    expect(state.voxelBaselineCheckpointId).not.toBeNull();
    await reopened.close();
  });

  it('new-session re-observation only refreshes the actually-observed cell', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 100 }));
    session.voxel.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 }, observedAt: 100 }));
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    reopened.voxel.beginSession('s2');
    reopened.voxel.observe(obs({ sessionId: 's2', state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 500, sequence: 1 }));

    expect(evidence(reopened.voxel, 0, 0, 0).freshness).toBe('FRESH');
    expect(evidence(reopened.voxel, 0, 0, 0).observation.observedAt).toBe(500);
    expect(evidence(reopened.voxel, 1, 0, 0).freshness).toBe('STALE'); // neighbour untouched
    expect(evidence(reopened.voxel, 1, 0, 0).observation.observedAt).toBe(100);
    await reopened.close();
  });

  it('rejects late observations from the old session id', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ sessionId: 's1', state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await session.checkpoint();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    reopened.voxel.beginSession('s2');
    // A late-arriving observation that reuses the old session id must be rejected.
    const report = reopened.voxel.observe(obs({ sessionId: 's1', state: dirt, pos: { x: 0, y: 0, z: 0 }, observedAt: 9999 }));
    expect(report.sections).toEqual([]);
    expect(evidence(reopened.voxel, 0, 0, 0).observation.sessionId).toBe('s1');
    expect(evidence(reopened.voxel, 0, 0, 0).freshness).toBe('STALE');
    await reopened.close();
  });

  it('reports dirty on a refresh-only update, and clears after checkpoint', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);

    // Refresh-only: same state, newer time.
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));
    expect(session.getPersistenceState().dirty).toBe(true);

    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    await session.close();
  });

  it('does not clear later refresh dirty when an older checkpoint is confirmed', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));

    const p = session.checkpoint();
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 2000, sequence: 2 }));

    await p;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.close();
  });

  it('isolates voxel by world in one database file', async () => {
    const dbPath = makeDbPath();
    const a = await openSpatialSession({ databasePath: dbPath, worldId: 'world-a' });
    a.voxel.beginSession('s1');
    a.voxel.observe({ ...obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }), worldId: 'world-a' });
    await a.checkpoint();
    await a.close();

    const b = await openSpatialSession({ databasePath: dbPath, worldId: 'world-b' });
    expect(b.voxel.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    await b.close();
  });

  it('distinguishes never-saved voxel from an empty voxel set', async () => {
    const dbPath = makeDbPath();
    // Save an empty combined checkpoint (voxel empty but present).
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    await s1.checkpoint();
    expect(s1.getPersistenceState().voxelBaselineCheckpointId).toBeNull();
    await s1.close();

    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(s2.getPersistenceState().voxelBaselineCheckpointId).not.toBeNull();
    expect(s2.voxel.checkpointMeasure().sections).toBe(0);
    await s2.close();
  });

  it('history-only checkpoint replaces history but not the voxel baseline', async () => {
    const dbPath = makeDbPath();
    // Combined save with voxel + history.
    const s1 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    s1.voxel.beginSession('s1');
    s1.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    s1.history.saveFragment(frag());
    await s1.checkpoint();
    await s1.close();

    // History-only save adds a new history fact.
    const h = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    h.history.saveFragment(frag({ id: 'f2', kind: 'dug' }));
    await h.checkpoint();
    await h.close();

    // Combined restore still sees the voxel baseline, and the newer history fact.
    const s2 = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(evidence(s2.voxel, 0, 0, 0).freshness).toBe('STALE');
    expect(s2.history.getFragment('f2')).not.toBeNull();
    await s2.close();
  });

  it('rejects an over-capacity combined checkpoint without changing memory or disk', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      snapshotLimits: { maxVoxelSections: 1 },
    });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    session.voxel.observe(obs({ state: dirt, pos: { x: 20, y: 0, z: 0 } })); // second section

    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    expect(session.voxel.checkpointMeasure().sections).toBe(2); // memory intact
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.voxel.checkpointMeasure().sections).toBe(0);
    await reopened.close();
  });

  it('rejects an over-capacity restore without a half-restored session', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    save.voxel.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 } }));
    await save.checkpoint();
    await save.close();

    await expect(
      openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxObservedCells: 1 } }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it('requires an explicit beginSession before observing after reopen', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ sessionId: 's1', state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    await save.checkpoint();
    await save.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    // A late old-session observation before beginSession must not auto-activate.
    const late = reopened.voxel.observe(obs({ sessionId: 's1', state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 9999 }));
    expect(late.sections).toEqual([]);
    expect(evidence(reopened.voxel, 0, 0, 0).freshness).toBe('STALE');
    expect(evidence(reopened.voxel, 0, 0, 0).observation.observedAt).toBe(1000);
    await reopened.close();
  });

  it('rejects a 1 MiB worldId against a tiny combined budget before scanning', async () => {
    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: 'w'.repeat(1024 * 1024),
      snapshotLimits: { maxBytes: 1024 },
    });
    // The cheap worldId `.length` bound must reject *before* the escaped UTF-8
    // string scan and before any store is measured or snapshotted. The escaped-byte
    // scan (`jsonEscapedByteLength`) is the full per-character pass; observing that
    // it never runs pins the early stop to the cheap length check rather than to the
    // later envelope check or the store measures.
    const escapedSpy = vi.spyOn(distBytes, 'jsonEscapedByteLength');
    const measureSpies = [
      vi.spyOn(session.voxel, 'checkpointMeasure'),
      vi.spyOn(session.voxel, 'checkpointDirtyMeasure'),
      vi.spyOn(session.history, 'checkpointMeasure'),
      vi.spyOn(session.topology, 'checkpointMeasure'),
    ];
    const snapshotSpies = [
      vi.spyOn(session.voxel, 'checkpointSnapshot'),
      vi.spyOn(session.voxel, 'captureDirtySections'),
      vi.spyOn(session.history, 'checkpointSnapshot'),
      vi.spyOn(session.topology, 'checkpointSnapshot'),
    ];

    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });

    expect(escapedSpy).not.toHaveBeenCalled();
    for (const spy of [...measureSpies, ...snapshotSpies]) expect(spy).not.toHaveBeenCalled();
    escapedSpy.mockRestore();
    await session.close();
  });

  it('preserves class-prototype getters on voxel options', async () => {
    class Config {
      get validityWindowMs(): number {
        return 100;
      }
      get now(): () => number {
        return () => 1500;
      }
    }
    const session = await openSpatialSession({ databasePath: makeDbPath(), worldId: WORLD, voxelOptions: new Config() });

    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 }, observedAt: 1000 }));
    expect(evidence(session.voxel, 0, 0, 0).validUntil).toBe(1100); // 1000 + 100, not 1000 + 60000

    // now() honored: after an interruption at 1500, a 1600 observation is accepted
    // (it would be wrongly rejected if `now` had fallen back to Date.now()).
    session.voxel.markStale(DIM, 'unloaded');
    expect(session.voxel.observe(obs({ state: stone, pos: { x: 1, y: 0, z: 0 }, observedAt: 1600 })).sections.length).toBe(1);
    expect(session.voxel.cellAt(DIM, 1, 0, 0).observed).toBe(true);

    await session.close();
  });

  it('rejects the combined over-budget before decoding voxel payloads', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.history.saveFragment(frag());
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await save.checkpoint();
    await save.close();

    const db = new Database(dbPath);
    const sumOctet = (table: string): number =>
      (db.prepare(`SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM ${table} WHERE world_id = ?`).get(WORLD) as { n: number }).n;
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE world_id = ?`).get(WORLD) as { n: number }).n;

    const fragments = count('path_fragments');
    const traversals = count('traversal_evidence');
    const nodes = count('spatial_nodes');
    const edges = count('spatial_edges');
    const commas = Math.max(0, fragments - 1) + Math.max(0, traversals - 1) + Math.max(0, nodes - 1) + Math.max(0, edges - 1);
    const escapedWorldId = Buffer.byteLength(JSON.stringify(WORLD), 'utf8');
    const historyBytes =
      sumOctet('path_fragments') + sumOctet('traversal_evidence') + sumOctet('spatial_nodes') + sumOctet('spatial_edges') +
      SNAPSHOT_FRAME_BYTES + commas + escapedWorldId;
    const sections = count('spatial_sections');
    const voxelBytes = sumOctet('spatial_sections') + VOXEL_FRAME_BYTES + escapedWorldId + Math.max(0, sections - 1);

    // Corrupt the voxel payload (same length, invalid JSON) so a decode would fail.
    db.prepare("UPDATE spatial_sections SET payload = 'X' || substr(payload, 2)").run();
    db.close();

    const exactTotal = historyBytes + voxelBytes;
    // Over the combined budget by one byte → the worker must reject on the byte
    // check before ever JSON-parsing the corrupted voxel payload ('capacity', not 'data').
    await expect(
      openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes: exactTotal - 1 } }),
    ).rejects.toMatchObject({ kind: 'capacity' });
  });
});

// ==============================================================================
// Schema upgrade + corruption tests
// ==============================================================================

describe('v1 → latest schema upgrade', () => {
  it('upgrades a v1 database and preserves existing history data', async () => {
    const dbPath = makeDbPath();
    writeV1Schema(dbPath);
    // Insert a history fact directly into the v1 database.
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO checkpoints (checkpoint_id, world_id, fragment_revision, topology_revision, seq) VALUES ('cp1', ?, 1, 0, 1)",
    ).run(WORLD);
    db.prepare('INSERT INTO path_fragments (world_id, seq, id, payload) VALUES (?, 0, ?, ?)').run(
      WORLD,
      'f1',
      JSON.stringify(frag()),
    );
    db.close();

    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(session.history.getFragment('f1')).not.toBeNull();
    await session.close();

    const check = new Database(dbPath);
    const version = (check.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string })
      .value;
    expect(version).toBe('5');
    const sectionTable = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spatial_sections'")
      .get();
    expect(sectionTable).not.toBeUndefined();
    check.close();
  });

  it('rolls back a failed upgrade, leaving a still-v1 database', async () => {
    const dbPath = makeDbPath();
    // A v1 DB whose checkpoints already has a `voxel_revision` column makes the
    // upgrade's second ALTER fail after the first has applied.
    writeV1Schema(dbPath, { extraCheckpointColumn: ', voxel_revision TEXT' });

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );

    const db = new Database(dbPath);
    const version = (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string })
      .value;
    expect(version).toBe('1');
    const cols = db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'has_voxel')).toBe(false); // rollback removed it
    db.close();
  });

  it('rejects a database with voxel rows but no voxel checkpoint', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare('DELETE FROM checkpoints WHERE world_id = ?').run(WORLD);
    db.close();

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });

  it('restores exactly at the combined byte budget and rejects one byte less', async () => {
    const dbPath = makeDbPath();
    const save = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    save.voxel.beginSession('s1');
    save.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    save.voxel.observe(obs({ state: dirt, pos: { x: 1, y: 0, z: 0 } }));
    await save.checkpoint();
    await save.close();

    // Recompute the exact combined total the worker enforces (empty history + voxel).
    const db = new Database(dbPath);
    const voxelPayloadBytes = (
      db.prepare('SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM spatial_sections WHERE world_id = ?').get(WORLD) as { n: number }
    ).n;
    const sections = (
      db.prepare('SELECT COUNT(*) AS n FROM spatial_sections WHERE world_id = ?').get(WORLD) as { n: number }
    ).n;
    db.close();

    const escapedWorldId = Buffer.byteLength(JSON.stringify(WORLD), 'utf8');
    const historyBytes = SNAPSHOT_FRAME_BYTES + escapedWorldId;
    const voxelBytes = voxelPayloadBytes + VOXEL_FRAME_BYTES + escapedWorldId + (sections - 1);
    const exactTotal = historyBytes + voxelBytes;

    const ok = await openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes: exactTotal } });
    await ok.close();

    await expect(
      openSpatialSession({ databasePath: dbPath, worldId: WORLD, snapshotLimits: { maxBytes: exactTotal - 1 } }),
    ).rejects.toMatchObject({ kind: 'capacity' });
  });

  it('rejects corrupt voxel data without a half-restored session', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.voxel.beginSession('s1');
    session.voxel.observe(obs({ state: stone, pos: { x: 0, y: 0, z: 0 } }));
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE spatial_sections SET payload = '{not json'").run();
    db.close();

    await expect(openSpatialSession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });
});

describe('v2 → v3 migration scope', () => {
  it('does not apply single-world limits across the whole database', async () => {
    const dbPath = makeDbPath();
    // Two worlds, each with one committed section, in a v3 database.
    const a = await openSpatialSession({ databasePath: dbPath, worldId: 'worldA' });
    a.voxel.beginSession('s1');
    a.voxel.observe(obs({ worldId: 'worldA', pos: { x: 0, y: 0, z: 0 } }));
    await a.checkpoint();
    await a.close();

    const b = await openSpatialSession({ databasePath: dbPath, worldId: 'worldB' });
    b.voxel.beginSession('s1');
    b.voxel.observe(obs({ worldId: 'worldB', pos: { x: 0, y: 0, z: 0 } }));
    await b.checkpoint();
    await b.close();

    // Downgrade to v2 (drop the per-section metadata columns) so a reopen must
    // migrate again.
    const db = new Database(dbPath);
    downgradeToV2(db);
    db.close();

    // The whole database holds two sections; worldA alone holds one. A per-world
    // maxVoxelSections=1 must not be applied to the whole-DB total during migration.
    const reopened = await openSpatialSession({
      databasePath: dbPath,
      worldId: 'worldA',
      snapshotLimits: { maxVoxelSections: 1 },
    });
    expect(reopened.voxel.checkpointCounts().sections).toBe(1);
    await reopened.close();
  });

  it('migration is not constrained by a small per-world maxBytes', async () => {
    const dbPath = makeDbPath();
    const a = await openSpatialSession({ databasePath: dbPath, worldId: 'worldA' });
    a.voxel.beginSession('s1');
    a.voxel.observe(obs({ worldId: 'worldA', pos: { x: 0, y: 0, z: 0 } }));
    await a.checkpoint();
    await a.close();
    const b = await openSpatialSession({ databasePath: dbPath, worldId: 'worldB' });
    b.voxel.beginSession('s1');
    b.voxel.observe(obs({ worldId: 'worldB', pos: { x: 0, y: 0, z: 0 } }));
    await b.checkpoint();
    await b.close();

    const db = new Database(dbPath);
    downgradeToV2(db);
    db.close();

    const probe = new Database(dbPath, { readonly: true });
    const worldABytes = (
      probe.prepare('SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM spatial_sections WHERE world_id = ?').get('worldA') as { n: number }
    ).n;
    const totalBytes = (
      probe.prepare('SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM spatial_sections').get() as { n: number }
    ).n;
    probe.close();
    expect(totalBytes).toBeGreaterThan(worldABytes); // whole DB spans both worlds

    // Exactly enough to reopen worldA (empty history + its one voxel section), but
    // less than the whole-database payload total — so the migration must not treat
    // the per-world maxBytes as a database-wide cap.
    const worldIdBytes = Buffer.byteLength(JSON.stringify('worldA'), 'utf8');
    const maxBytes = SNAPSHOT_FRAME_BYTES + VOXEL_FRAME_BYTES + 2 * worldIdBytes + worldABytes;
    expect(totalBytes).toBeGreaterThan(maxBytes);

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: 'worldA', snapshotLimits: { maxBytes } });
    expect(reopened.voxel.checkpointCounts().sections).toBe(1);
    await reopened.close();
  });
});
