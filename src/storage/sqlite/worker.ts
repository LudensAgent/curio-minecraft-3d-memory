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
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';

const SCHEMA_VERSION = 2;

const KNOWN_TABLES_V1 = new Set([
  'schema_meta',
  'checkpoints',
  'path_fragments',
  'traversal_evidence',
  'spatial_nodes',
  'spatial_edges',
]);

const KNOWN_TABLES_V2 = new Set([...KNOWN_TABLES_V1, 'spatial_sections']);

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
  sections: { id: string; payload: string }[];
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
    return connection;
  }

  // version === SCHEMA_VERSION (2)
  validateKnownTables(connection, names, KNOWN_TABLES_V2);
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V2)) {
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

function prepareVoxelSnapshot(snapshot: VoxelCheckpointSnapshot): PreparedVoxelSnapshot {
  const sections = snapshot.sections.map((section) => {
    const payload = encodeVoxelSection(section);
    return { id: voxelSectionId(section), payload };
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
  voxel: { hasVoxel: boolean; voxelRevision: number; sections: { id: string; payload: string }[] },
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

    // A history-only checkpoint never touches spatial_sections, so an existing
    // voxel baseline survives; a combined checkpoint replaces it entirely.
    if (voxel.hasVoxel) {
      connection.prepare('DELETE FROM spatial_sections WHERE world_id = ?').run(wId);
      const insertSection = connection.prepare(
        'INSERT INTO spatial_sections (world_id, seq, id, payload) VALUES (?, ?, ?, ?)',
      );
      voxel.sections.forEach((s, i) => insertSection.run(wId, i, s.id, s.payload));
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
        voxel.hasVoxel ? voxel.voxelRevision : 0,
        voxel.hasVoxel ? 1 : 0,
        nextSeq,
      );
  });
  tx();
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
  if (bytes > resolved.maxBytes) {
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

function handleOpen(msg: WorkerRequest & { type: 'open' }): void {
  const connection = openDatabase(msg.databasePath);
  db = connection;
  worldId = msg.worldId;
  limits = msg.limits;
  try {
    const world = loadWorld(connection, msg.worldId, msg.limits);
    let voxelBaselineCheckpointId: string | null = null;
    let voxelSnapshot: VoxelCheckpointSnapshot | null = null;
    if (msg.kind === 'spatial') {
      const voxel = loadVoxel(connection, msg.worldId, msg.limits);
      voxelBaselineCheckpointId = voxel.voxelBaselineCheckpointId;
      voxelSnapshot = voxel.voxelSnapshot;
      // Combined byte budget: each domain already checked individually, but the
      // two must also fit a single shared budget — never "sum of two full quotas".
      const totalBytes = world.bytes + voxel.bytes;
      if (totalBytes > msg.limits.maxBytes) {
        throw new Error(`snapshot exceeds maxBytes (${totalBytes})`);
      }
    }
    respond({
      type: 'open_ok',
      requestId: msg.requestId,
      baselineCheckpointId: world.baselineCheckpointId,
      snapshot: world.snapshot,
      voxelBaselineCheckpointId,
      voxelSnapshot,
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
    if (msg.hasVoxel) {
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
      hasVoxel: msg.hasVoxel,
      voxelRevision: msg.voxelRevision,
      sections: preparedVoxel?.sections ?? [],
    });
  } catch (err) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'sql', message: (err as Error).message });
    return;
  }
  respond({ type: 'checkpoint_ok', requestId: msg.requestId, checkpointId: msg.checkpointId });
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
    case 'close':
      handleClose(msg);
      break;
  }
});
