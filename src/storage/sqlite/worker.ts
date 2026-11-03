/**
 * SQLite persistence worker thread (phase 5A → 5B).
 *
 * One worker owns one `better-sqlite3` connection and serializes load, checkpoint
 * transactions and JSON encode/decode. Its synchronous SQL API runs here, never on
 * the control thread. The worker never reads mineflayer, never judges what the
 * agent saw, and never controls the body — it only persists and restores the
 * historical facts and voxel sections handed to it, with their original binding
 * snapshots and observation metadata.
 */

import { parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SNAPSHOT_FRAME_BYTES, VOXEL_FRAME_BYTES } from './types.js';
import type {
  HistorySnapshot,
  ResolvedSnapshotLimits,
  VoxelSaveMode,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';
import type { VoxelDirectoryEntry } from '../../voxel/residency.js';

const SCHEMA_VERSION = 3;

const KNOWN_TABLES_V1 = new Set([
  'schema_meta',
  'checkpoints',
  'path_fragments',
  'traversal_evidence',
  'spatial_nodes',
  'spatial_edges',
]);

const KNOWN_TABLES_V2 = new Set([...KNOWN_TABLES_V1, 'spatial_sections']);

const KNOWN_TABLES_V3 = new Set(KNOWN_TABLES_V2);

/** Required columns + the SQLite type affinity the read/write logic relies on (v1). */
const REQUIRED_COLUMNS_V1: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  schema_meta: { key: 'TEXT', value: 'TEXT' },
  checkpoints: {
    checkpoint_id: 'TEXT',
    world_id: 'TEXT',
    fragment_revision: 'INTEGER',
    topology_revision: 'INTEGER',
    seq: 'INTEGER',
  },
  path_fragments: { world_id: 'TEXT', seq: 'INTEGER', id: 'TEXT', payload: 'TEXT' },
  traversal_evidence: { world_id: 'TEXT', seq: 'INTEGER', id: 'TEXT', payload: 'TEXT' },
  spatial_nodes: { world_id: 'TEXT', seq: 'INTEGER', id: 'TEXT', payload: 'TEXT' },
  spatial_edges: { world_id: 'TEXT', seq: 'INTEGER', id: 'TEXT', payload: 'TEXT' },
};

/** Required columns for the v2 schema (adds voxel columns and the sections table). */
const REQUIRED_COLUMNS_V2: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  ...REQUIRED_COLUMNS_V1,
  checkpoints: {
    checkpoint_id: 'TEXT',
    world_id: 'TEXT',
    fragment_revision: 'INTEGER',
    topology_revision: 'INTEGER',
    voxel_revision: 'INTEGER',
    has_voxel: 'INTEGER',
    seq: 'INTEGER',
  },
  spatial_sections: { world_id: 'TEXT', seq: 'INTEGER', id: 'TEXT', payload: 'TEXT' },
};

/** Required columns for the v3 schema (adds per-section committed metadata columns). */
const REQUIRED_COLUMNS_V3: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  ...REQUIRED_COLUMNS_V2,
  spatial_sections: {
    world_id: 'TEXT',
    seq: 'INTEGER',
    id: 'TEXT',
    payload: 'TEXT',
    observed_cells: 'INTEGER',
    palette_entries: 'INTEGER',
    revision: 'INTEGER',
  },
};

const SCHEMA_SQL = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  fragment_revision INTEGER NOT NULL,
  topology_revision INTEGER NOT NULL,
  voxel_revision INTEGER NOT NULL DEFAULT 0,
  has_voxel INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX checkpoints_world_seq ON checkpoints (world_id, seq);

CREATE TABLE path_fragments (
  world_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);

CREATE TABLE traversal_evidence (
  world_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);

CREATE TABLE spatial_nodes (
  world_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);

CREATE TABLE spatial_edges (
  world_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);

CREATE TABLE spatial_sections (
  world_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  observed_cells INTEGER NOT NULL DEFAULT 0,
  palette_entries INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, id)
);
`;

interface PreparedSnapshot {
  fragments: { id: string; payload: string }[];
  traversals: { id: string; payload: string }[];
  nodes: { id: string; payload: string }[];
  edges: { id: string; payload: string }[];
  polylinePoints: number;
  entrancePoints: number;
  linkPairs: number;
  edgeEvidenceRefs: number;
  bytes: number;
}

interface PreparedVoxelSnapshot {
  sections: { id: string; payload: string; observedCells: number; paletteEntries: number; revision: number }[];
  bytes: number;
}

let db: Database.Database | null = null;
let worldId: string | null = null;
let limits: ResolvedSnapshotLimits | null = null;

function respond(msg: WorkerResponse): void {
  parentPort!.postMessage(msg);
}

/** Open (or validate / upgrade) the database, returning a connection ready for the session's world. */
function openDatabase(databasePath: string): Database.Database {
  const connection = new Database(databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('synchronous = NORMAL');

  const rows = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const names = new Set(rows.map((r) => r.name));

  if (names.size === 0) {
    connection.exec(SCHEMA_SQL);
    connection
      .prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    return connection;
  }

  const versionRow = connection
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (versionRow === undefined) {
    connection.close();
    throw new Error('database has existing tables but no schema metadata');
  }
  const version = Number(versionRow.value);
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    connection.close();
    throw new Error(`unsupported schema version "${versionRow.value}"`);
  }

  if (version === 1) {
    validateKnownTables(connection, names, KNOWN_TABLES_V1);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V1)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV1ToV2(connection, databasePath);
    upgradeV2ToV3(connection, databasePath);
    return connection;
  }

  if (version === 2) {
    validateKnownTables(connection, names, KNOWN_TABLES_V2);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V2)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV2ToV3(connection, databasePath);
    return connection;
  }

  // version === SCHEMA_VERSION (3)
  validateKnownTables(connection, names, KNOWN_TABLES_V3);
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V3)) {
    assertRequiredColumns(connection, table, columns);
  }
  return connection;
}

function validateKnownTables(
  connection: Database.Database,
  names: Set<string>,
  known: Set<string>,
): void {
  for (const name of names) {
    if (!known.has(name)) {
      connection.close();
      throw new Error(`unknown table "${name}" in database`);
    }
  }
  for (const required of known) {
    if (!names.has(required)) {
      connection.close();
      throw new Error(`missing required table "${required}"`);
    }
  }
}

/**
 * Upgrade a validated v1 database in place: write a consistent backup (including
 * WAL-committed data) first, then add the voxel columns and table and bump the
 * version inside one transaction so a failure rolls back to a still-v1 database.
 */
function upgradeV1ToV2(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v2-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    connection.exec('ALTER TABLE checkpoints ADD COLUMN has_voxel INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE checkpoints ADD COLUMN voxel_revision INTEGER NOT NULL DEFAULT 0');
    connection.exec(`
      CREATE TABLE spatial_sections (
        world_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (world_id, id)
      )
    `);
    connection.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'").run();
  });
  tx();
}

/**
 * Upgrade a validated v2 database in place: write a consistent backup first, then
 * add the per-section committed metadata columns and backfill them from each
 * existing payload (a bounded, one-time decode) inside one transaction, so a
 * failure rolls back to a still-v2 database without touching the payloads.
 */
function upgradeV2ToV3(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v3-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN observed_cells INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN palette_entries INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    const rows = connection.prepare('SELECT world_id, id, payload FROM spatial_sections').all() as {
      world_id: string;
      id: string;
      payload: string;
    }[];
    const update = connection.prepare(
      'UPDATE spatial_sections SET observed_cells = ?, palette_entries = ?, revision = ? WHERE world_id = ? AND id = ?',
    );
    for (const row of rows) {
      const section = decodeVoxelSection(row.payload);
      update.run(section.evidence.length, section.palette.length, section.revision, row.world_id, row.id);
    }
    connection.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
  });
  tx();
}

/** Reject a table missing a required column, or whose column has the wrong type affinity. */
function assertRequiredColumns(
  connection: Database.Database,
  table: string,
  required: Record<string, 'INTEGER' | 'TEXT'>,
): void {
  const cols = connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const [column, affinity] of Object.entries(required)) {
    const col = byName.get(column);
    if (col === undefined) {
      connection.close();
      throw new Error(`table "${table}" is missing required column "${column}"`);
    }
    if (affinityOf(col.type) !== affinity) {
      connection.close();
      throw new Error(
        `table "${table}" column "${column}" must have ${affinity} affinity, got "${col.type}"`,
      );
    }
  }
}

/** Map a declared SQLite column type to its storage affinity (see SQLite §3.1). */
function affinityOf(declaredType: string): 'INTEGER' | 'TEXT' | 'REAL' | 'BLOB' | 'NUMERIC' {
  const t = declaredType.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB') || t === '') return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

function stringifyRecord(record: unknown): string {
  return JSON.stringify(record);
}

function prepareSnapshot(snapshot: HistorySnapshot): PreparedSnapshot {
  const prepared: PreparedSnapshot = {
    fragments: [],
    traversals: [],
    nodes: [],
    edges: [],
    polylinePoints: 0,
    entrancePoints: 0,
    linkPairs: 0,
    edgeEvidenceRefs: 0,
    bytes: 0,
  };
  for (const f of snapshot.fragments) {
    const payload = stringifyRecord(f);
    prepared.fragments.push({ id: f.id, payload });
    prepared.bytes += Buffer.byteLength(payload, 'utf8');
    prepared.polylinePoints += f.polyline.length;
    prepared.entrancePoints += f.entrances.length;
    prepared.linkPairs += f.links?.length ?? 0;
  }
  for (const t of snapshot.traversals) {
    const payload = stringifyRecord(t);
    prepared.traversals.push({ id: t.id, payload });
    prepared.bytes += Buffer.byteLength(payload, 'utf8');
  }
  for (const n of snapshot.nodes) {
    const payload = stringifyRecord(n);
    prepared.nodes.push({ id: n.id, payload });
    prepared.bytes += Buffer.byteLength(payload, 'utf8');
  }
  for (const e of snapshot.edges) {
    const payload = stringifyRecord(e);
    prepared.edges.push({ id: e.id, payload });
    prepared.bytes += Buffer.byteLength(payload, 'utf8');
    prepared.edgeEvidenceRefs += e.refs.length;
  }
  prepared.bytes += snapshotEnvelopeBytes(snapshot);
  return prepared;
}

/** Encode a voxel section into its versioned JSON payload. */
function encodeVoxelSection(section: VoxelSectionSnapshot): string {
  return JSON.stringify({
    v: 1,
    dim: section.dim,
    cx: section.cx,
    cz: section.cz,
    sy: section.sy,
    palette: section.palette,
    bits: section.bits,
    cells: Buffer.from(section.cells).toString('base64'),
    evidence: section.evidence.map((cell) => ({ i: cell.index, e: cell.evidence })),
    revision: section.revision,
  });
}

/** Stable id for one voxel section row. */
function voxelSectionId(section: VoxelSectionSnapshot): string {
  return JSON.stringify([section.dim, section.cx, section.cz, section.sy]);
}

/** Stable id for a section key (for load requests). */
function voxelSectionIdFromKey(key: { dim: string; cx: number; cz: number; sy: number }): string {
  return JSON.stringify([key.dim, key.cx, key.cz, key.sy]);
}

function prepareVoxelSnapshot(snapshot: VoxelCheckpointSnapshot): PreparedVoxelSnapshot {
  const sections = snapshot.sections.map((section) => {
    const payload = encodeVoxelSection(section);
    return {
      id: voxelSectionId(section),
      payload,
      observedCells: section.evidence.length,
      paletteEntries: section.palette.length,
      revision: section.revision,
    };
  });
  let bytes = VOXEL_FRAME_BYTES + Buffer.byteLength(JSON.stringify(snapshot.worldId), 'utf8');
  bytes += Math.max(0, sections.length - 1);
  for (const section of sections) bytes += Buffer.byteLength(section.payload, 'utf8');
  return { sections, bytes };
}

/** Exact outer-envelope bytes: fixed frame + inter-record commas + JSON-escaped worldId. */
function snapshotEnvelopeBytes(snapshot: HistorySnapshot): number {
  return (
    SNAPSHOT_FRAME_BYTES +
    interRecordCommas(
      snapshot.fragments.length,
      snapshot.traversals.length,
      snapshot.nodes.length,
      snapshot.edges.length,
    ) +
    Buffer.byteLength(JSON.stringify(snapshot.worldId), 'utf8')
  );
}

/** Sum of `,` separators between adjacent records in the four arrays (0 for empty/single). */
function interRecordCommas(fragments: number, traversals: number, nodes: number, edges: number): number {
  return (
    Math.max(0, fragments - 1) +
    Math.max(0, traversals - 1) +
    Math.max(0, nodes - 1) +
    Math.max(0, edges - 1)
  );
}

function assertCountsWithinLimits(
  fragments: number,
  traversals: number,
  nodes: number,
  edges: number,
  bytes: number,
  resolved: ResolvedSnapshotLimits,
): void {
  if (fragments > resolved.maxFragments) throw new Error(`snapshot exceeds maxFragments (${fragments})`);
  if (traversals > resolved.maxTraversals) throw new Error(`snapshot exceeds maxTraversals (${traversals})`);
  if (nodes > resolved.maxNodes) throw new Error(`snapshot exceeds maxNodes (${nodes})`);
  if (edges > resolved.maxEdges) throw new Error(`snapshot exceeds maxEdges (${edges})`);
  if (bytes > resolved.maxBytes) throw new Error(`snapshot exceeds maxBytes (${bytes})`);
}

function assertDerivedWithinLimits(
  derived: { polylinePoints: number; entrancePoints: number; linkPairs: number; edgeEvidenceRefs: number },
  resolved: ResolvedSnapshotLimits,
): void {
  if (derived.polylinePoints > resolved.maxPolylinePoints) {
    throw new Error(`snapshot exceeds maxPolylinePoints (${derived.polylinePoints})`);
  }
  if (derived.entrancePoints > resolved.maxEntrancePoints) {
    throw new Error(`snapshot exceeds maxEntrancePoints (${derived.entrancePoints})`);
  }
  if (derived.linkPairs > resolved.maxLinks) throw new Error(`snapshot exceeds maxLinks (${derived.linkPairs})`);
  if (derived.edgeEvidenceRefs > resolved.maxEdgeEvidenceRefs) {
    throw new Error(`snapshot exceeds maxEdgeEvidenceRefs (${derived.edgeEvidenceRefs})`);
  }
}

function assertWithinLimits(prepared: PreparedSnapshot, resolved: ResolvedSnapshotLimits): void {
  assertCountsWithinLimits(
    prepared.fragments.length,
    prepared.traversals.length,
    prepared.nodes.length,
    prepared.edges.length,
    prepared.bytes,
    resolved,
  );
  assertDerivedWithinLimits(
    {
      polylinePoints: prepared.polylinePoints,
      entrancePoints: prepared.entrancePoints,
      linkPairs: prepared.linkPairs,
      edgeEvidenceRefs: prepared.edgeEvidenceRefs,
    },
    resolved,
  );
}

function writeCheckpoint(
  connection: Database.Database,
  checkpointId: string,
  wId: string,
  fragmentRevision: number,
  topologyRevision: number,
  prepared: PreparedSnapshot,
  voxel: { mode: VoxelSaveMode; voxelRevision: number; sections: PreparedVoxelSnapshot['sections'] },
  resolved: ResolvedSnapshotLimits,
): void {
  const tx = connection.transaction(() => {
    const nextSeqRow = connection
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM checkpoints WHERE world_id = ?')
      .get(wId) as { n: number };
    const nextSeq = nextSeqRow.n;

    connection.prepare('DELETE FROM path_fragments WHERE world_id = ?').run(wId);
    connection.prepare('DELETE FROM traversal_evidence WHERE world_id = ?').run(wId);
    connection.prepare('DELETE FROM spatial_nodes WHERE world_id = ?').run(wId);
    connection.prepare('DELETE FROM spatial_edges WHERE world_id = ?').run(wId);

    const insertFragment = connection.prepare(
      'INSERT INTO path_fragments (world_id, seq, id, payload) VALUES (?, ?, ?, ?)',
    );
    const insertTraversal = connection.prepare(
      'INSERT INTO traversal_evidence (world_id, seq, id, payload) VALUES (?, ?, ?, ?)',
    );
    const insertNode = connection.prepare(
      'INSERT INTO spatial_nodes (world_id, seq, id, payload) VALUES (?, ?, ?, ?)',
    );
    const insertEdge = connection.prepare(
      'INSERT INTO spatial_edges (world_id, seq, id, payload) VALUES (?, ?, ?, ?)',
    );

    prepared.fragments.forEach((f, i) => insertFragment.run(wId, i, f.id, f.payload));
    prepared.traversals.forEach((t, i) => insertTraversal.run(wId, i, t.id, t.payload));
    prepared.nodes.forEach((n, i) => insertNode.run(wId, i, n.id, n.payload));
    prepared.edges.forEach((e, i) => insertEdge.run(wId, i, e.id, e.payload));

    // `none` never touches spatial_sections, so an existing voxel baseline
    // survives. `full` replaces the whole set (first save baseline). `incremental`
    // upserts only the included sections — a missing key is never a deletion.
    if (voxel.mode === 'full') {
      connection.prepare('DELETE FROM spatial_sections WHERE world_id = ?').run(wId);
      const insertSection = connection.prepare(
        'INSERT INTO spatial_sections (world_id, seq, id, payload, observed_cells, palette_entries, revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      voxel.sections.forEach((s, i) =>
        insertSection.run(wId, i, s.id, s.payload, s.observedCells, s.paletteEntries, s.revision),
      );
    } else if (voxel.mode === 'incremental') {
      // Existing rows keep their `seq` (stable order); new rows are appended after
      // the current max seq, in batch order. Only an existing row's payload changes,
      // so the on-disk order never moves and seq never duplicates.
      const maxSeqRow = connection
        .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM spatial_sections WHERE world_id = ?')
        .get(wId) as { n: number };
      const baseSeq = maxSeqRow.n;
      const upsertSection = connection.prepare(
        'INSERT INTO spatial_sections (world_id, seq, id, payload, observed_cells, palette_entries, revision) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(world_id, id) DO UPDATE SET payload = excluded.payload, observed_cells = excluded.observed_cells, palette_entries = excluded.palette_entries, revision = excluded.revision',
      );
      voxel.sections.forEach((s, i) =>
        upsertSection.run(wId, baseSeq + i + 1, s.id, s.payload, s.observedCells, s.paletteEntries, s.revision),
      );
      // The resulting full set must still re-open under the same limits: reject
      // (and roll back) before commit if the increments accumulate past capacity.
      assertVoxelFullSetWithinLimits(connection, wId, prepared.bytes, resolved);
    }

    connection
      .prepare(
        'INSERT INTO checkpoints (checkpoint_id, world_id, fragment_revision, topology_revision, voxel_revision, has_voxel, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        checkpointId,
        wId,
        fragmentRevision,
        topologyRevision,
        voxel.mode === 'none' ? 0 : voxel.voxelRevision,
        voxel.mode === 'none' ? 0 : 1,
        nextSeq,
      );
  });
  tx();
}

/**
 * Verify the *post-increment* full voxel set still fits within the same limits a
 * fresh open would enforce, so a sequence of small increments can never build a
 * database that fails to re-open. Runs inside the checkpoint transaction; a throw
 * rolls back history + voxel + metadata together.
 */
function assertVoxelFullSetWithinLimits(
  connection: Database.Database,
  wId: string,
  historyBytes: number,
  resolved: ResolvedSnapshotLimits,
): void {
  const sections = countRows(connection, 'spatial_sections', wId);
  if (sections > resolved.maxVoxelSections) {
    throw new Error(`snapshot exceeds maxVoxelSections (${sections})`);
  }
  const observedCells = sumColumn(connection, 'spatial_sections', 'observed_cells', wId);
  if (observedCells > resolved.maxObservedCells) {
    throw new Error(`snapshot exceeds maxObservedCells (${observedCells})`);
  }
  const paletteEntries = sumColumn(connection, 'spatial_sections', 'palette_entries', wId);
  if (paletteEntries > resolved.maxPaletteEntries) {
    throw new Error(`snapshot exceeds maxPaletteEntries (${paletteEntries})`);
  }
  const voxelBytes =
    sumPayloadBytes(connection, 'spatial_sections', wId) +
    VOXEL_FRAME_BYTES +
    Buffer.byteLength(JSON.stringify(wId), 'utf8') +
    Math.max(0, sections - 1);
  const total = historyBytes + voxelBytes;
  if (total > resolved.maxBytes) {
    throw new Error(`snapshot exceeds maxBytes (${total})`);
  }
}

function sumColumn(connection: Database.Database, table: string, column: string, wId: string): number {
  const row = connection
    .prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM ${table} WHERE world_id = ?`)
    .get(wId) as { n: number };
  return row.n;
}

function countRows(connection: Database.Database, table: string, wId: string): number {
  const row = connection
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE world_id = ?`)
    .get(wId) as { n: number };
  return row.n;
}

function sumPayloadBytes(connection: Database.Database, table: string, wId: string): number {
  const row = connection
    .prepare(`SELECT COALESCE(SUM(octet_length(payload)), 0) AS n FROM ${table} WHERE world_id = ?`)
    .get(wId) as { n: number };
  return row.n;
}

function readAll(connection: Database.Database, table: string, wId: string): unknown[] {
  const rows = connection
    .prepare(`SELECT payload FROM ${table} WHERE world_id = ? ORDER BY seq`)
    .all(wId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as unknown);
}

function computeDerivedCounts(snapshot: HistorySnapshot): {
  polylinePoints: number;
  entrancePoints: number;
  linkPairs: number;
  edgeEvidenceRefs: number;
} {
  let polylinePoints = 0;
  let entrancePoints = 0;
  let linkPairs = 0;
  let edgeEvidenceRefs = 0;
  for (const f of snapshot.fragments) {
    polylinePoints += f.polyline.length;
    entrancePoints += f.entrances.length;
    linkPairs += f.links?.length ?? 0;
  }
  for (const e of snapshot.edges) edgeEvidenceRefs += e.refs.length;
  return { polylinePoints, entrancePoints, linkPairs, edgeEvidenceRefs };
}

/** Reject checkpoint rows whose ordering/identity/revision metadata is corrupt or out of range. */
function assertValidCheckpointMetadata(connection: Database.Database, wId: string): void {
  const bad = connection
    .prepare(
      `SELECT COUNT(*) AS n FROM checkpoints
       WHERE world_id = ?
         AND (typeof(seq) != 'integer' OR seq < 1
              OR typeof(fragment_revision) != 'integer' OR fragment_revision < 0
              OR typeof(topology_revision) != 'integer' OR topology_revision < 0
              OR typeof(checkpoint_id) != 'text'
              OR checkpoint_id = ''
              OR typeof(has_voxel) != 'integer' OR (has_voxel != 0 AND has_voxel != 1)
              OR typeof(voxel_revision) != 'integer' OR voxel_revision < 0)`,
    )
    .get(wId) as { n: number };
  if (bad.n > 0) {
    throw new Error('corrupt checkpoint metadata');
  }
}

function loadWorld(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedSnapshotLimits,
): { baselineCheckpointId: string | null; snapshot: HistorySnapshot | null; bytes: number } {
  assertValidCheckpointMetadata(connection, wId);

  const cp = connection
    .prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string } | undefined;
  if (cp === undefined) {
    const orphans =
      countRows(connection, 'path_fragments', wId) +
      countRows(connection, 'traversal_evidence', wId) +
      countRows(connection, 'spatial_nodes', wId) +
      countRows(connection, 'spatial_edges', wId);
    if (orphans > 0) {
      throw new Error('world has fact rows but no checkpoint metadata');
    }
    return { baselineCheckpointId: null, snapshot: null, bytes: 0 };
  }

  const fragments = countRows(connection, 'path_fragments', wId);
  const traversals = countRows(connection, 'traversal_evidence', wId);
  const nodes = countRows(connection, 'spatial_nodes', wId);
  const edges = countRows(connection, 'spatial_edges', wId);
  const bytes =
    sumPayloadBytes(connection, 'path_fragments', wId) +
    sumPayloadBytes(connection, 'traversal_evidence', wId) +
    sumPayloadBytes(connection, 'spatial_nodes', wId) +
    sumPayloadBytes(connection, 'spatial_edges', wId) +
    SNAPSHOT_FRAME_BYTES +
    interRecordCommas(fragments, traversals, nodes, edges) +
    Buffer.byteLength(JSON.stringify(wId), 'utf8');
  assertCountsWithinLimits(fragments, traversals, nodes, edges, bytes, resolved);

  const snapshot: HistorySnapshot = {
    worldId: wId,
    fragments: readAll(connection, 'path_fragments', wId) as HistorySnapshot['fragments'],
    traversals: readAll(connection, 'traversal_evidence', wId) as HistorySnapshot['traversals'],
    nodes: readAll(connection, 'spatial_nodes', wId) as HistorySnapshot['nodes'],
    edges: readAll(connection, 'spatial_edges', wId) as HistorySnapshot['edges'],
  };
  assertDerivedWithinLimits(computeDerivedCounts(snapshot), resolved);
  return { baselineCheckpointId: cp.checkpoint_id, snapshot, bytes };
}

/** Decode one voxel section payload, validating structure during decode. */
function decodeVoxelSection(payload: string): VoxelSectionSnapshot {
  const raw = JSON.parse(payload) as {
    v?: unknown;
    dim?: unknown;
    cx?: unknown;
    cz?: unknown;
    sy?: unknown;
    palette?: unknown;
    bits?: unknown;
    cells?: unknown;
    evidence?: unknown;
    revision?: unknown;
  };
  if (raw === null || typeof raw !== 'object' || raw.v !== 1) {
    throw new Error('corrupt voxel section payload');
  }
  if (typeof raw.dim !== 'string' || raw.dim.length === 0) {
    throw new Error('corrupt voxel section dim');
  }
  if (!Number.isInteger(raw.cx) || !Number.isInteger(raw.cz) || !Number.isInteger(raw.sy)) {
    throw new Error('corrupt voxel section coordinates');
  }
  if (!Array.isArray(raw.palette) || raw.palette.length === 0) {
    throw new Error('corrupt voxel section palette');
  }
  if (typeof raw.bits !== 'number') {
    throw new Error('corrupt voxel section bits');
  }
  if (typeof raw.cells !== 'string') {
    throw new Error('corrupt voxel section cells');
  }
  if (!Array.isArray(raw.evidence)) {
    throw new Error('corrupt voxel section evidence');
  }
  const cells = new Uint8Array(Buffer.from(raw.cells, 'base64'));
  const evidence = raw.evidence.map((cell) => {
    const c = cell as { i?: unknown; e?: unknown };
    if (!Number.isInteger(c.i) || c.e === undefined) {
      throw new Error('corrupt voxel section evidence record');
    }
    return { index: c.i as number, evidence: c.e as VoxelSectionSnapshot['evidence'][number]['evidence'] };
  });
  return {
    dim: raw.dim,
    cx: raw.cx as number,
    cz: raw.cz as number,
    sy: raw.sy as number,
    palette: raw.palette as string[],
    bits: raw.bits as number,
    cells,
    evidence,
    revision: raw.revision as number,
  };
}

function loadVoxel(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedSnapshotLimits,
  byteBudget: number,
): { voxelBaselineCheckpointId: string | null; voxelSnapshot: VoxelCheckpointSnapshot | null; bytes: number } {
  const cp = connection
    .prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? AND has_voxel = 1 ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string } | undefined;
  if (cp === undefined) {
    // Corruption guard: voxel rows without a voxel checkpoint must not read as
    // "never saved" (the next empty combined checkpoint would otherwise erase them).
    if (countRows(connection, 'spatial_sections', wId) > 0) {
      throw new Error('world has voxel rows but no voxel checkpoint metadata');
    }
    return { voxelBaselineCheckpointId: null, voxelSnapshot: null, bytes: 0 };
  }

  const sections = countRows(connection, 'spatial_sections', wId);
  const bytes =
    sumPayloadBytes(connection, 'spatial_sections', wId) +
    VOXEL_FRAME_BYTES +
    Buffer.byteLength(JSON.stringify(wId), 'utf8') +
    Math.max(0, sections - 1);
  if (sections > resolved.maxVoxelSections) {
    throw new Error(`snapshot exceeds maxVoxelSections (${sections})`);
  }
  // The remaining byte budget (history already consumed) is enforced here, before
  // any payload is read or decoded, so the shared combined budget is respected
  // without first materializing the voxel records.
  if (bytes > byteBudget) {
    throw new Error(`snapshot exceeds maxBytes (${bytes})`);
  }

  const rows = connection
    .prepare('SELECT payload FROM spatial_sections WHERE world_id = ? ORDER BY seq')
    .all(wId) as { payload: string }[];
  const decoded: VoxelSectionSnapshot[] = [];
  let observedCells = 0;
  let paletteEntries = 0;
  for (const row of rows) {
    const section = decodeVoxelSection(row.payload);
    observedCells += section.evidence.length;
    paletteEntries += section.palette.length;
    if (observedCells > resolved.maxObservedCells) {
      throw new Error(`snapshot exceeds maxObservedCells (${observedCells})`);
    }
    if (paletteEntries > resolved.maxPaletteEntries) {
      throw new Error(`snapshot exceeds maxPaletteEntries (${paletteEntries})`);
    }
    decoded.push(section);
  }
  return { voxelBaselineCheckpointId: cp.checkpoint_id, voxelSnapshot: { worldId: wId, sections: decoded }, bytes };
}

/**
 * Read only the committed section directory (manual loading): identity, stable
 * order, committed payload byte size, and the committed observed-cell/palette/
 * revision metadata — never the payloads. The byte/count budget is checked before
 * any row is materialized, so a manual open never decodes a single payload.
 */
function loadVoxelDirectory(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedSnapshotLimits,
  byteBudget: number,
): { voxelBaselineCheckpointId: string | null; voxelDirectory: VoxelDirectoryEntry[]; bytes: number } {
  const cp = connection
    .prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? AND has_voxel = 1 ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string } | undefined;
  if (cp === undefined) {
    if (countRows(connection, 'spatial_sections', wId) > 0) {
      throw new Error('world has voxel rows but no voxel checkpoint metadata');
    }
    return { voxelBaselineCheckpointId: null, voxelDirectory: [], bytes: 0 };
  }

  const sections = countRows(connection, 'spatial_sections', wId);
  const bytes =
    sumPayloadBytes(connection, 'spatial_sections', wId) +
    VOXEL_FRAME_BYTES +
    Buffer.byteLength(JSON.stringify(wId), 'utf8') +
    Math.max(0, sections - 1);
  if (sections > resolved.maxVoxelSections) {
    throw new Error(`snapshot exceeds maxVoxelSections (${sections})`);
  }
  if (bytes > byteBudget) {
    throw new Error(`snapshot exceeds maxBytes (${bytes})`);
  }

  const rows = connection
    .prepare(
      'SELECT id, seq, octet_length(payload) AS bytes, observed_cells, palette_entries, revision FROM spatial_sections WHERE world_id = ? ORDER BY seq',
    )
    .all(wId) as { id: string; seq: number; bytes: number; observed_cells: number; palette_entries: number; revision: number }[];

  const directory: VoxelDirectoryEntry[] = [];
  let observedCells = 0;
  let paletteEntries = 0;
  for (const row of rows) {
    const [dim, cx, cz, sy] = parseSectionId(row.id);
    observedCells += row.observed_cells;
    paletteEntries += row.palette_entries;
    directory.push({
      key: { worldId: wId, dim, cx, cz, sy },
      seq: row.seq,
      bytes: row.bytes,
      observedCells: row.observed_cells,
      paletteEntries: row.palette_entries,
      revision: row.revision,
    });
  }
  if (observedCells > resolved.maxObservedCells) {
    throw new Error(`snapshot exceeds maxObservedCells (${observedCells})`);
  }
  if (paletteEntries > resolved.maxPaletteEntries) {
    throw new Error(`snapshot exceeds maxPaletteEntries (${paletteEntries})`);
  }
  return { voxelBaselineCheckpointId: cp.checkpoint_id, voxelDirectory: directory, bytes };
}

/** Parse a stable section id (`JSON.stringify([dim, cx, cz, sy])`) back into its parts. */
function parseSectionId(id: string): [string, number, number, number] {
  const arr = JSON.parse(id) as unknown;
  if (
    !Array.isArray(arr) ||
    arr.length !== 4 ||
    typeof arr[0] !== 'string' ||
    !Number.isInteger(arr[1]) ||
    !Number.isInteger(arr[2]) ||
    !Number.isInteger(arr[3])
  ) {
    throw new Error('corrupt section id');
  }
  return [arr[0], arr[1] as number, arr[2] as number, arr[3] as number];
}

function handleOpen(msg: WorkerRequest & { type: 'open' }): void {
  const connection = openDatabase(msg.databasePath);
  db = connection;
  worldId = msg.worldId;
  limits = msg.limits;
  try {
    const world = loadWorld(connection, msg.worldId, msg.limits);
    let voxelBaselineCheckpointId: string | null = null;
    let voxelSnapshot: VoxelCheckpointSnapshot | null = null;
    let voxelDirectory: VoxelDirectoryEntry[] | null = null;
    if (msg.kind === 'spatial') {
      // Hand the voxel loader the budget left after history, so the shared combined
      // budget is checked against `octet_length` *before* any voxel payload is read
      // or decoded — never "sum of two full quotas, checked only after decoding".
      if (msg.voxelLoading === 'manual') {
        const voxel = loadVoxelDirectory(connection, msg.worldId, msg.limits, msg.limits.maxBytes - world.bytes);
        voxelBaselineCheckpointId = voxel.voxelBaselineCheckpointId;
        voxelDirectory = voxel.voxelDirectory;
      } else {
        const voxel = loadVoxel(connection, msg.worldId, msg.limits, msg.limits.maxBytes - world.bytes);
        voxelBaselineCheckpointId = voxel.voxelBaselineCheckpointId;
        voxelSnapshot = voxel.voxelSnapshot;
      }
    }
    respond({
      type: 'open_ok',
      requestId: msg.requestId,
      baselineCheckpointId: world.baselineCheckpointId,
      snapshot: world.snapshot,
      voxelBaselineCheckpointId,
      voxelSnapshot,
      voxelDirectory,
    });
  } catch (err) {
    db = null;
    worldId = null;
    limits = null;
    connection.close();
    const message = (err as Error).message;
    const kind = /exceeds/.test(message) ? 'capacity' : 'data';
    respond({ type: 'error', requestId: msg.requestId, kind, message });
  }
}

function handleCheckpoint(msg: WorkerRequest & { type: 'checkpoint' }): void {
  if (db === null || worldId === null || limits === null) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'worker is not open' });
    return;
  }
  if (msg.worldId !== worldId) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'checkpoint worldId does not match session worldId' });
    return;
  }
  if (msg.snapshot.worldId !== worldId) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'data', message: 'snapshot worldId does not match session worldId' });
    return;
  }
  let prepared: PreparedSnapshot;
  let preparedVoxel: PreparedVoxelSnapshot | null = null;
  try {
    prepared = prepareSnapshot(msg.snapshot);
    assertWithinLimits(prepared, limits);
    if (msg.voxelMode !== 'none') {
      if (msg.voxelSnapshot.worldId !== worldId) {
        throw new Error('voxel snapshot worldId does not match session worldId');
      }
      preparedVoxel = prepareVoxelSnapshot(msg.voxelSnapshot);
      if (preparedVoxel.sections.length > limits.maxVoxelSections) {
        throw new Error(`snapshot exceeds maxVoxelSections (${preparedVoxel.sections.length})`);
      }
      const totalBytes = prepared.bytes + preparedVoxel.bytes;
      if (totalBytes > limits.maxBytes) {
        throw new Error(`snapshot exceeds maxBytes (${totalBytes})`);
      }
    }
  } catch (err) {
    respond({
      type: 'error',
      requestId: msg.requestId,
      kind: err instanceof Error && /exceeds/.test(err.message) ? 'capacity' : 'data',
      message: (err as Error).message,
    });
    return;
  }
  try {
    writeCheckpoint(db, msg.checkpointId, msg.worldId, msg.fragmentRevision, msg.topologyRevision, prepared, {
      mode: msg.voxelMode,
      voxelRevision: msg.voxelRevision,
      sections: preparedVoxel?.sections ?? [],
    }, limits);
  } catch (err) {
    // Capacity rejections raised inside the transaction (the post-increment full-set
    // check) roll the whole batch back and must read as `capacity`, not a SQL fault.
    const message = (err as Error).message;
    respond({ type: 'error', requestId: msg.requestId, kind: /exceeds/.test(message) ? 'capacity' : 'sql', message });
    return;
  }
  respond({ type: 'checkpoint_ok', requestId: msg.requestId, checkpointId: msg.checkpointId });
}

function handleLoadSections(msg: WorkerRequest & { type: 'load_sections' }): void {
  if (db === null || worldId === null || limits === null) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'worker is not open' });
    return;
  }
  if (msg.worldId !== worldId) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'load worldId does not match session worldId' });
    return;
  }
  try {
    const metaStmt = db.prepare('SELECT octet_length(payload) AS bytes FROM spatial_sections WHERE world_id = ? AND id = ?');
    const loadStmt = db.prepare('SELECT payload FROM spatial_sections WHERE world_id = ? AND id = ?');
    const existing: { id: string; bytes: number }[] = [];
    const missing: { dim: string; cx: number; cz: number; sy: number }[] = [];
    let totalBytes = 0;
    for (const key of msg.keys) {
      const id = voxelSectionIdFromKey(key);
      const row = metaStmt.get(worldId, id) as { bytes: number } | undefined;
      if (row === undefined) {
        missing.push(key);
        continue;
      }
      totalBytes += row.bytes;
      existing.push({ id, bytes: row.bytes });
    }
    if (totalBytes > limits.maxBytes) {
      throw new Error(`snapshot exceeds maxBytes (${totalBytes})`);
    }
    const sections = existing.map((entry) => decodeVoxelSection((loadStmt.get(worldId, entry.id) as { payload: string }).payload));
    respond({ type: 'load_ok', requestId: msg.requestId, sections, missing });
  } catch (err) {
    const message = (err as Error).message;
    respond({ type: 'error', requestId: msg.requestId, kind: /exceeds/.test(message) ? 'capacity' : 'data', message });
  }
}

function handleClose(msg: WorkerRequest & { type: 'close' }): void {
  if (db !== null) {
    db.close();
    db = null;
  }
  respond({ type: 'closed', requestId: msg.requestId });
  parentPort!.close();
}

parentPort!.on('message', (msg: WorkerRequest) => {
  switch (msg.type) {
    case 'open':
      try {
        handleOpen(msg);
      } catch (err) {
        respond({
          type: 'error',
          requestId: msg.requestId,
          kind: 'schema',
          message: (err as Error).message,
        });
      }
      break;
    case 'checkpoint':
      handleCheckpoint(msg);
      break;
    case 'load_sections':
      handleLoadSections(msg);
      break;
    case 'close':
      handleClose(msg);
      break;
  }
});
