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
import type { ActionRecord } from '../../navigation/types.js';
import { JournalConflictError, canonicalizeJournalRecord } from './journal.js';
import type {
  HistorySnapshot,
  ResolvedJournalLimits,
  ResolvedSnapshotLimits,
  SpatialEvent,
  VoxelSaveMode,
  WorkerRequest,
  WorkerResponse,
} from './types.js';
import type { VoxelCheckpointSnapshot, VoxelSectionSnapshot } from '../../voxel/snapshot.js';
import type { VoxelDirectoryEntry } from '../../voxel/residency.js';
import {
  decodeVoxelSectionPayload,
  encodeVoxelSectionPayload,
} from '../../voxel/serialization.js';
import { chunkVisitKey, placedBlockKey, portalTraversalIdentity } from './ledger.js';
import { DEFAULT_LEDGER_LIMITS } from './types.js';
import type {
  ChunkVisitRecord,
  LedgerSnapshot,
  PlacedBlockRecord,
  PortalEndpointEvidence,
  PortalTraversalRecord,
  ResolvedLedgerLimits,
} from './types.js';
import {
  MIGRATION_BATCH_BYTES,
  MIGRATION_BATCH_ROWS,
  MIGRATION_MAX_SECTION_BYTES,
  selectMigrationBatch,
} from './migration.js';
import type { MigrationRowMeta } from './migration.js';

const SCHEMA_VERSION = 6;

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

const KNOWN_TABLES_V4 = new Set([...KNOWN_TABLES_V3, 'action_records', 'spatial_events']);

const KNOWN_TABLES_V5 = new Set([
  ...KNOWN_TABLES_V4,
  'placed_blocks',
  'chunk_visits',
  'portal_traversals',
]);

const KNOWN_TABLES_V6 = new Set(KNOWN_TABLES_V5);

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

/** Required columns for the v4 schema (append-only action/event journal). */
const REQUIRED_COLUMNS_V4: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  ...REQUIRED_COLUMNS_V3,
  checkpoints: {
    checkpoint_id: 'TEXT',
    world_id: 'TEXT',
    fragment_revision: 'INTEGER',
    topology_revision: 'INTEGER',
    voxel_revision: 'INTEGER',
    has_voxel: 'INTEGER',
    journal_revision: 'INTEGER',
    has_journal: 'INTEGER',
    seq: 'INTEGER',
  },
  action_records: {
    world_id: 'TEXT',
    seq: 'INTEGER',
    id: 'TEXT',
    session_id: 'TEXT',
    dim: 'TEXT',
    ts: 'INTEGER',
    payload: 'TEXT',
  },
  spatial_events: {
    world_id: 'TEXT',
    seq: 'INTEGER',
    id: 'TEXT',
    session_id: 'TEXT',
    dim: 'TEXT',
    kind: 'TEXT',
    observed_at: 'INTEGER',
    payload: 'TEXT',
  },
};

/**
 * Required columns for the v5 schema: explicit section coordinates, the ledger
 * checkpoint discriminator, and the three legacy-ledger tables.
 */
const REQUIRED_COLUMNS_V5: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  ...REQUIRED_COLUMNS_V4,
  checkpoints: {
    checkpoint_id: 'TEXT',
    world_id: 'TEXT',
    fragment_revision: 'INTEGER',
    topology_revision: 'INTEGER',
    voxel_revision: 'INTEGER',
    has_voxel: 'INTEGER',
    journal_revision: 'INTEGER',
    has_journal: 'INTEGER',
    ledger_revision: 'INTEGER',
    has_ledger: 'INTEGER',
    seq: 'INTEGER',
  },
  spatial_sections: {
    world_id: 'TEXT',
    seq: 'INTEGER',
    id: 'TEXT',
    payload: 'TEXT',
    observed_cells: 'INTEGER',
    palette_entries: 'INTEGER',
    revision: 'INTEGER',
    dimension: 'TEXT',
    cx: 'INTEGER',
    cz: 'INTEGER',
    sy: 'INTEGER',
  },
  placed_blocks: {
    key: 'TEXT',
    world_id: 'TEXT',
    dim: 'TEXT',
    x: 'INTEGER',
    y: 'INTEGER',
    z: 'INTEGER',
    name: 'TEXT',
    lru_at: 'INTEGER',
    source: 'TEXT',
  },
  chunk_visits: {
    key: 'TEXT',
    world_id: 'TEXT',
    dim: 'TEXT',
    cx: 'INTEGER',
    cz: 'INTEGER',
    count: 'INTEGER',
    source: 'TEXT',
  },
  portal_traversals: {
    id: 'TEXT',
    world_id: 'TEXT',
    kind: 'TEXT',
    direction: 'TEXT',
    from_id: 'TEXT',
    to_id: 'TEXT',
    ts: 'INTEGER',
    from_session: 'TEXT',
    to_session: 'TEXT',
    from_observation: 'INTEGER',
    to_observation: 'INTEGER',
    from_endpoint: 'TEXT',
    to_endpoint: 'TEXT',
    source: 'TEXT',
  },
};

/**
 * Required columns for the v6 schema: the checkpoint row now also carries the
 * low-frequency portal-edge + fragment-merge topology extras.
 */
const REQUIRED_COLUMNS_V6: Record<string, Record<string, 'INTEGER' | 'TEXT'>> = {
  ...REQUIRED_COLUMNS_V5,
  checkpoints: {
    ...REQUIRED_COLUMNS_V5.checkpoints,
    topology_extras: 'TEXT',
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
  journal_revision INTEGER NOT NULL DEFAULT 0,
  has_journal INTEGER NOT NULL DEFAULT 0,
  ledger_revision INTEGER NOT NULL DEFAULT 0,
  has_ledger INTEGER NOT NULL DEFAULT 0,
  -- Portal edges + evidence-backed fragment merges: low-frequency, nested
  -- topology facts that do not fit the four walk-edge history arrays.
  topology_extras TEXT NOT NULL DEFAULT '{}',
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
  dimension TEXT NOT NULL DEFAULT '',
  cx INTEGER NOT NULL DEFAULT 0,
  cz INTEGER NOT NULL DEFAULT 0,
  sy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, id)
);
CREATE INDEX spatial_sections_world_coords ON spatial_sections (world_id, dimension, cx, cz, sy);

CREATE TABLE action_records (
  world_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (world_id, session_id, id)
);
CREATE INDEX action_records_world_seq ON action_records (world_id, seq);
CREATE INDEX action_records_scope_seq ON action_records (world_id, session_id, seq);

CREATE TABLE spatial_events (
  world_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  kind TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (world_id, session_id, id)
);
CREATE INDEX spatial_events_world_seq ON spatial_events (world_id, seq);
CREATE INDEX spatial_events_scope_seq ON spatial_events (world_id, session_id, seq);

CREATE TABLE placed_blocks (
  key TEXT PRIMARY KEY,
  world_id TEXT,
  dim TEXT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  name TEXT NOT NULL,
  lru_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  CHECK ((world_id IS NULL AND dim IS NULL) OR (world_id IS NOT NULL AND dim IS NOT NULL))
);
CREATE INDEX placed_blocks_world_lru ON placed_blocks (world_id, dim, lru_at);

CREATE TABLE chunk_visits (
  key TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  cx INTEGER NOT NULL,
  cz INTEGER NOT NULL,
  count INTEGER NOT NULL,
  source TEXT NOT NULL,
  CHECK (count >= 0)
);
CREATE INDEX chunk_visits_world ON chunk_visits (world_id, dim, cx, cz);

CREATE TABLE portal_traversals (
  id TEXT PRIMARY KEY,
  world_id TEXT,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  from_observation INTEGER NOT NULL,
  to_observation INTEGER NOT NULL,
  from_endpoint TEXT,
  to_endpoint TEXT,
  source TEXT NOT NULL,
  UNIQUE (kind, from_id, to_id, ts, from_session, to_session, from_observation, to_observation)
);
CREATE INDEX portal_traversals_world_ts ON portal_traversals (world_id, ts);
`;

interface PreparedSnapshot {
  fragments: { id: string; payload: string }[];
  traversals: { id: string; payload: string }[];
  nodes: { id: string; payload: string }[];
  edges: { id: string; payload: string }[];
  /** Serialized portal edges + fragment merges stored on the checkpoint row. */
  extras: string;
  portalEdges: number;
  fragmentMerges: number;
  polylinePoints: number;
  entrancePoints: number;
  linkPairs: number;
  edgeEvidenceRefs: number;
  bytes: number;
}

interface PreparedVoxelSnapshot {
  sections: {
    id: string;
    dim: string;
    cx: number;
    cz: number;
    sy: number;
    payload: string;
    observedCells: number;
    paletteEntries: number;
    revision: number;
  }[];
  bytes: number;
}

interface PreparedAction {
  id: string;
  sessionId: string;
  dim: string;
  ts: number;
  payload: string;
}

interface PreparedEvent {
  id: string;
  sessionId: string;
  dim: string;
  kind: string;
  observedAt: number;
  payload: string;
}

interface PreparedJournal {
  actions: PreparedAction[];
  events: PreparedEvent[];
  bytes: number;
}

let db: Database.Database | null = null;
let worldId: string | null = null;
let limits: ResolvedSnapshotLimits | null = null;
let journalLimits: ResolvedJournalLimits | null = null;
let ledgerLimits: ResolvedLedgerLimits = DEFAULT_LEDGER_LIMITS;

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
    upgradeV3ToV4(connection, databasePath);
    upgradeV4ToV5(connection, databasePath);
    upgradeV5ToV6(connection, databasePath);
    return connection;
  }

  if (version === 2) {
    validateKnownTables(connection, names, KNOWN_TABLES_V2);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V2)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV2ToV3(connection, databasePath);
    upgradeV3ToV4(connection, databasePath);
    upgradeV4ToV5(connection, databasePath);
    upgradeV5ToV6(connection, databasePath);
    return connection;
  }

  if (version === 3) {
    validateKnownTables(connection, names, KNOWN_TABLES_V3);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V3)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV3ToV4(connection, databasePath);
    upgradeV4ToV5(connection, databasePath);
    upgradeV5ToV6(connection, databasePath);
    return connection;
  }

  if (version === 4) {
    validateKnownTables(connection, names, KNOWN_TABLES_V4);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V4)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV4ToV5(connection, databasePath);
    upgradeV5ToV6(connection, databasePath);
    return connection;
  }

  if (version === 5) {
    validateKnownTables(connection, names, KNOWN_TABLES_V5);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V5)) {
      assertRequiredColumns(connection, table, columns);
    }
    upgradeV5ToV6(connection, databasePath);
    return connection;
  }

  // version === SCHEMA_VERSION (6)
  validateKnownTables(connection, names, KNOWN_TABLES_V6);
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS_V6)) {
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
 * add the per-section committed metadata columns and backfill them from existing
 * payloads inside one transaction, so a failure rolls back to a still-v2 database.
 *
 * The backfill is bounded by a fixed batch size over a stable `rowid` cursor —
 * never one unbounded `.all()` + decode of the whole table — but it is a *schema
 * migration*, not a per-world capacity check: single-world limits (`maxVoxelSections`,
 * `maxObservedCells`, `maxPaletteEntries`, `maxBytes`) are enforced later, per
 * world, when a specific world is opened. A database holding several worlds may
 * legitimately backfill more sections in total than any one world is allowed.
 */
function upgradeV2ToV3(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v3-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN observed_cells INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN palette_entries INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');

    const meta = connection.prepare(
      'SELECT rowid, world_id, id, octet_length(payload) AS bytes FROM spatial_sections WHERE rowid > ? ORDER BY rowid LIMIT ?',
    );
    const load = connection.prepare('SELECT payload FROM spatial_sections WHERE rowid = ?');
    const update = connection.prepare(
      'UPDATE spatial_sections SET observed_cells = ?, palette_entries = ?, revision = ? WHERE world_id = ? AND id = ?',
    );

    let cursor = 0;
    for (;;) {
      // Read only metadata (rowid + octet_length) first, so the byte budget is
      // checked before any payload is materialized or decoded.
      const window = meta.all(cursor, MIGRATION_BATCH_ROWS) as MigrationRowMeta[];
      if (window.length === 0) break;
      // A window that exceeds the byte budget is shrunk, not rejected, so a large
      // but valid database (many sections totalling over the batch budget) is
      // backfilled in multiple passes.
      let offset = 0;
      while (offset < window.length) {
        const batch = selectMigrationBatch(window.slice(offset), MIGRATION_MAX_SECTION_BYTES, MIGRATION_BATCH_BYTES);
        for (const row of batch) {
          const payload = (load.get(row.rowid) as { payload: string }).payload;
          const section = decodeVoxelSection(payload);
          update.run(section.evidence.length, section.palette.length, section.revision, row.world_id, row.id);
        }
        offset += batch.length;
      }
      cursor = window[window.length - 1]!.rowid;
    }

    connection.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
  });
  tx();
}

/**
 * Upgrade a validated v3 database in place: write a consistent backup first,
 * then add the append-only journal tables and the independent journal checkpoint
 * discriminator columns inside one transaction. No existing history/voxel rows
 * are read, rewritten or deleted; an upgraded database starts with an empty
 * journal rather than synthesized events.
 */
function upgradeV3ToV4(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v4-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    connection.exec('ALTER TABLE checkpoints ADD COLUMN journal_revision INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE checkpoints ADD COLUMN has_journal INTEGER NOT NULL DEFAULT 0');
    connection.exec(`
      CREATE TABLE action_records (
        world_id TEXT NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE (world_id, session_id, id)
      )
    `);
    connection.exec('CREATE INDEX action_records_world_seq ON action_records (world_id, seq)');
    connection.exec('CREATE INDEX action_records_scope_seq ON action_records (world_id, session_id, seq)');
    connection.exec(`
      CREATE TABLE spatial_events (
        world_id TEXT NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE (world_id, session_id, id)
      )
    `);
    connection.exec('CREATE INDEX spatial_events_world_seq ON spatial_events (world_id, seq)');
    connection.exec('CREATE INDEX spatial_events_scope_seq ON spatial_events (world_id, session_id, seq)');
    connection.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
  });
  tx();
}

/**
 * Upgrade a validated v4 database in place: write a consistent backup first, then
 * add the explicit section coordinate columns, the ledger checkpoint
 * discriminator and the three legacy-ledger tables inside one transaction.
 *
 * The section coordinates are backfilled from the existing `id` JSON in bounded
 * `rowid` windows; the versioned payload is left untouched. The payload's
 * dimension/coordinates remain self-contained for backward compatibility, but
 * these columns are now the indexed query identity. No history/voxel/journal row
 * is rewritten or deleted, and an upgraded database starts with an empty ledger
 * rather than synthesizing placements, visits or crossings.
 */
function upgradeV4ToV5(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v5-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    connection.exec('ALTER TABLE checkpoints ADD COLUMN ledger_revision INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE checkpoints ADD COLUMN has_ledger INTEGER NOT NULL DEFAULT 0');
    connection.exec("ALTER TABLE spatial_sections ADD COLUMN dimension TEXT NOT NULL DEFAULT ''");
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN cx INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN cz INTEGER NOT NULL DEFAULT 0');
    connection.exec('ALTER TABLE spatial_sections ADD COLUMN sy INTEGER NOT NULL DEFAULT 0');

    const meta = connection.prepare(
      'SELECT rowid, id FROM spatial_sections WHERE rowid > ? ORDER BY rowid LIMIT ?',
    );
    const update = connection.prepare(
      'UPDATE spatial_sections SET dimension = ?, cx = ?, cz = ?, sy = ? WHERE rowid = ?',
    );
    let cursor = 0;
    for (;;) {
      const window = meta.all(cursor, MIGRATION_BATCH_ROWS) as { rowid: number; id: string }[];
      if (window.length === 0) break;
      for (const row of window) {
        const [dim, cx, cz, sy] = parseSectionId(row.id);
        update.run(dim, cx, cz, sy, row.rowid);
      }
      cursor = window[window.length - 1]!.rowid;
    }
    connection.exec(
      'CREATE INDEX spatial_sections_world_coords ON spatial_sections (world_id, dimension, cx, cz, sy)',
    );

    connection.exec(`
      CREATE TABLE placed_blocks (
        key TEXT PRIMARY KEY,
        world_id TEXT,
        dim TEXT,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        name TEXT NOT NULL,
        lru_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        CHECK ((world_id IS NULL AND dim IS NULL) OR (world_id IS NOT NULL AND dim IS NOT NULL))
      )
    `);
    connection.exec('CREATE INDEX placed_blocks_world_lru ON placed_blocks (world_id, dim, lru_at)');
    connection.exec(`
      CREATE TABLE chunk_visits (
        key TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        dim TEXT NOT NULL,
        cx INTEGER NOT NULL,
        cz INTEGER NOT NULL,
        count INTEGER NOT NULL,
        source TEXT NOT NULL,
        CHECK (count >= 0)
      )
    `);
    connection.exec('CREATE INDEX chunk_visits_world ON chunk_visits (world_id, dim, cx, cz)');
    connection.exec(`
      CREATE TABLE portal_traversals (
        id TEXT PRIMARY KEY,
        world_id TEXT,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        from_session TEXT NOT NULL,
        to_session TEXT NOT NULL,
        from_observation INTEGER NOT NULL,
        to_observation INTEGER NOT NULL,
        from_endpoint TEXT,
        to_endpoint TEXT,
        source TEXT NOT NULL,
        UNIQUE (kind, from_id, to_id, ts, from_session, to_session, from_observation, to_observation)
      )
    `);
    connection.exec('CREATE INDEX portal_traversals_world_ts ON portal_traversals (world_id, ts)');

    connection.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'").run();
  });
  tx();
}

/**
 * Upgrade a validated v5 database in place: add the checkpoint column that
 * carries portal edges and evidence-backed fragment merges. Older checkpoints
 * default to `{}` (no extras); no existing row is rewritten or deleted.
 */
function upgradeV5ToV6(connection: Database.Database, databasePath: string): void {
  const backupPath = `${databasePath}.pre-v6-${randomUUID()}`;
  connection.prepare('VACUUM INTO ?').run(backupPath);
  const tx = connection.transaction(() => {
    const columns = connection.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[];
    // Idempotent: a downgraded but not column-stripped fixture may already have it.
    if (!columns.some((column) => column.name === 'topology_extras')) {
      connection.exec("ALTER TABLE checkpoints ADD COLUMN topology_extras TEXT NOT NULL DEFAULT '{}'");
    }
    connection.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'").run();
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
  const portalEdges = snapshot.portalEdges ?? [];
  const fragmentMerges = snapshot.fragmentMerges ?? [];
  const extras =
    portalEdges.length === 0 && fragmentMerges.length === 0
      ? '{}'
      : JSON.stringify({ portalEdges, fragmentMerges });
  const prepared: PreparedSnapshot = {
    fragments: [],
    traversals: [],
    nodes: [],
    edges: [],
    extras,
    portalEdges: snapshot.portalEdges?.length ?? 0,
    fragmentMerges: snapshot.fragmentMerges?.length ?? 0,
    polylinePoints: 0,
    entrancePoints: 0,
    linkPairs: 0,
    edgeEvidenceRefs: 0,
    bytes: Buffer.byteLength(extras, 'utf8'),
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

/**
 * Encode a voxel section into its versioned JSON payload.
 *
 * v2 removes the duplicated full block state from every cell's observation: the
 * palette already stores the canonical state string and the packed `cells` point
 * at it, so the evidence carries only the remaining observation fields. This
 * keeps the persisted evidence independent of a later block-state serialization
 * change and avoids storing the same state twice. The section key stays in the
 * payload for self-containment and backward compatibility.
 */
function encodeVoxelSection(section: VoxelSectionSnapshot): string {
  // Delegate to the versioned voxel serializer: palette + packed cells + the
  // history/risk bitmaps + compact per-cell evidence. Keeping one encoder avoids
  // silently diverging snapshot formats between the map and the worker.
  return JSON.stringify(encodeVoxelSectionPayload(section));
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
      dim: section.dim,
      cx: section.cx,
      cz: section.cz,
      sy: section.sy,
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

/**
 * Encode and bound one captured journal batch. The caller already validated and
 * canonicalized the records on the main thread; the worker re-canonicalizes at
 * this process/DB boundary so durable idempotency never depends on object-key
 * insertion order and every column value is re-derived from the record itself.
 */
function prepareJournalBatch(
  batch: { actions: ActionRecord[]; events: SpatialEvent[] },
  wId: string,
  resolved: ResolvedJournalLimits,
): PreparedJournal {
  const total = batch.actions.length + batch.events.length;
  if (total > resolved.maxBatchRecords) {
    throw new Error(`journal batch exceeds maxBatchRecords (${total})`);
  }
  const prepared: PreparedJournal = { actions: [], events: [], bytes: 0 };
  const addBytes = (bytes: number): void => {
    prepared.bytes += bytes;
    if (prepared.bytes > resolved.maxBatchBytes) {
      throw new Error(`journal batch exceeds maxBatchBytes (${prepared.bytes})`);
    }
  };
  const requireString = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`journal ${what} must be a non-empty string`);
    }
    return value;
  };
  for (const action of batch.actions) {
    if (action.worldId !== wId) throw new Error('journal action worldId does not match session worldId');
    if (typeof action.ts !== 'number' || !Number.isFinite(action.ts)) {
      throw new Error('journal action ts must be a finite number');
    }
    const canonical = canonicalizeJournalRecord(action, resolved);
    addBytes(canonical.bytes);
    prepared.actions.push({
      id: requireString(action.id, 'action id'),
      sessionId: requireString(action.sessionId, 'action sessionId'),
      dim: requireString(action.dim, 'action dim'),
      ts: action.ts,
      payload: canonical.json,
    });
  }
  for (const event of batch.events) {
    if (event.worldId !== wId) throw new Error('journal event worldId does not match session worldId');
    if (typeof event.observedAt !== 'number' || !Number.isFinite(event.observedAt)) {
      throw new Error('journal event observedAt must be a finite number');
    }
    const canonical = canonicalizeJournalRecord(event, resolved);
    addBytes(canonical.bytes);
    prepared.events.push({
      id: requireString(event.id, 'event id'),
      sessionId: requireString(event.sessionId, 'event sessionId'),
      dim: requireString(event.dim, 'event dim'),
      kind: requireString(event.kind, 'event kind'),
      observedAt: event.observedAt,
      payload: canonical.json,
    });
  }
  return prepared;
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
  // Portal edges and evidence-backed fragment merges are connections too; they
  // share the topology edge capacity with walk edges.
  assertCountsWithinLimits(
    prepared.fragments.length,
    prepared.traversals.length,
    prepared.nodes.length,
    prepared.edges.length + prepared.portalEdges + prepared.fragmentMerges,
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
  journal: { mode: 'none' | 'append'; revision: number; prepared: PreparedJournal },
  ledger: { mode: 'none' | 'full'; revision: number; prepared: PreparedLedger | null },
  resolved: ResolvedSnapshotLimits,
  resolvedJournal: ResolvedJournalLimits,
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
        'INSERT INTO spatial_sections (world_id, seq, id, payload, observed_cells, palette_entries, revision, dimension, cx, cz, sy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      voxel.sections.forEach((s, i) =>
        insertSection.run(
          wId,
          i,
          s.id,
          s.payload,
          s.observedCells,
          s.paletteEntries,
          s.revision,
          s.dim,
          s.cx,
          s.cz,
          s.sy,
        ),
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
        'INSERT INTO spatial_sections (world_id, seq, id, payload, observed_cells, palette_entries, revision, dimension, cx, cz, sy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(world_id, id) DO UPDATE SET payload = excluded.payload, observed_cells = excluded.observed_cells, palette_entries = excluded.palette_entries, revision = excluded.revision, dimension = excluded.dimension, cx = excluded.cx, cz = excluded.cz, sy = excluded.sy',
      );
      voxel.sections.forEach((s, i) =>
        upsertSection.run(
          wId,
          baseSeq + i + 1,
          s.id,
          s.payload,
          s.observedCells,
          s.paletteEntries,
          s.revision,
          s.dim,
          s.cx,
          s.cz,
          s.sy,
        ),
      );
      // The resulting full set must still re-open under the same limits: reject
      // (and roll back) before commit if the increments accumulate past capacity.
      assertVoxelFullSetWithinLimits(connection, wId, prepared.bytes, resolved);
    }

    // The journal is append-only. `none` never touches rows or the journal
    // baseline; `append` inserts the captured batch (possibly empty) and records
    // the captured local revision. An empty append never deletes committed rows.
    if (journal.mode === 'append') {
      appendJournal(connection, wId, journal.prepared, resolvedJournal);
    }

    // The ledger is a full replacement of this world's ledger rows; unattributed
    // legacy rows (world_id IS NULL) are not this world's facts and are untouched.
    if (ledger.mode === 'full') {
      writeLedger(connection, wId, ledger.prepared ?? { placed: [], visits: [], traversals: [], bytes: 0 });
    }

    connection
      .prepare(
        'INSERT INTO checkpoints (checkpoint_id, world_id, fragment_revision, topology_revision, voxel_revision, has_voxel, journal_revision, has_journal, ledger_revision, has_ledger, topology_extras, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        checkpointId,
        wId,
        fragmentRevision,
        topologyRevision,
        voxel.mode === 'none' ? 0 : voxel.voxelRevision,
        voxel.mode === 'none' ? 0 : 1,
        journal.mode === 'none' ? 0 : journal.revision,
        journal.mode === 'none' ? 0 : 1,
        ledger.mode === 'none' ? 0 : ledger.revision,
        ledger.mode === 'none' ? 0 : 1,
        prepared.extras,
        nextSeq,
      );
  });
  tx();
}

/**
 * Append one captured journal batch, detecting conflicts inside the transaction.
 * A replay of an identical scoped id is a no-op (no quota growth, no overwrite);
 * different content throws and rolls back every domain in the checkpoint.
 */
function appendJournal(
  connection: Database.Database,
  wId: string,
  prepared: PreparedJournal,
  resolved: ResolvedJournalLimits,
): void {
  const existingAction = connection.prepare(
    'SELECT payload FROM action_records WHERE world_id = ? AND session_id = ? AND id = ?',
  );
  const existingEvent = connection.prepare(
    'SELECT payload FROM spatial_events WHERE world_id = ? AND session_id = ? AND id = ?',
  );
  const insertAction = connection.prepare(
    'INSERT INTO action_records (world_id, id, session_id, dim, ts, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertEvent = connection.prepare(
    'INSERT INTO spatial_events (world_id, id, session_id, dim, kind, observed_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const batchSeen = new Map<string, string>();
  for (const action of prepared.actions) {
    const key = JSON.stringify([action.sessionId, action.id]);
    const prior = batchSeen.get(key);
    if (prior !== undefined) {
      if (prior !== action.payload) {
        throw new JournalConflictError(
          `journal action conflict for session "${action.sessionId}" id "${action.id}": batch content differs`,
        );
      }
      continue;
    }
    batchSeen.set(key, action.payload);
    const existing = existingAction.get(wId, action.sessionId, action.id) as { payload: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload !== action.payload) {
        throw new JournalConflictError(
          `journal action conflict for session "${action.sessionId}" id "${action.id}": committed content differs`,
        );
      }
      continue;
    }
    insertAction.run(wId, action.id, action.sessionId, action.dim, action.ts, action.payload);
  }

  const batchSeenEvents = new Map<string, string>();
  for (const event of prepared.events) {
    const key = JSON.stringify([event.sessionId, event.id]);
    const prior = batchSeenEvents.get(key);
    if (prior !== undefined) {
      if (prior !== event.payload) {
        throw new JournalConflictError(
          `journal event conflict for session "${event.sessionId}" id "${event.id}": batch content differs`,
        );
      }
      continue;
    }
    batchSeenEvents.set(key, event.payload);
    const existing = existingEvent.get(wId, event.sessionId, event.id) as { payload: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload !== event.payload) {
        throw new JournalConflictError(
          `journal event conflict for session "${event.sessionId}" id "${event.id}": committed content differs`,
        );
      }
      continue;
    }
    insertEvent.run(wId, event.id, event.sessionId, event.dim, event.kind, event.observedAt, event.payload);
  }

  // Duplicate replays do not grow these counts, so a full-capacity replay still
  // succeeds. A genuinely new row is rejected (and the whole checkpoint rolls
  // back) rather than evicting old facts.
  const records = countRows(connection, 'action_records', wId) + countRows(connection, 'spatial_events', wId);
  if (records > resolved.maxCommittedRecords) {
    throw new Error(`journal exceeds maxCommittedRecords (${records})`);
  }
  const bytes =
    sumPayloadBytes(connection, 'action_records', wId) + sumPayloadBytes(connection, 'spatial_events', wId);
  if (bytes > resolved.maxCommittedBytes) {
    throw new Error(`journal exceeds maxCommittedBytes (${bytes})`);
  }
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

// --- placement / chunk-visit / portal ledger --------------------------------

const PORTAL_ENDPOINT_KINDS = new Set(['nether_portal', 'end_portal', 'end_gateway']);
const PORTAL_TRAVERSAL_KINDS = new Set(['traversal', 'gateway']);
const PORTAL_DIRECTIONS = new Set(['outbound', 'return', 'unclassified']);

interface PreparedTraversal extends PortalTraversalRecord {
  fromEndpointJson: string | null;
  toEndpointJson: string | null;
}

interface PreparedLedger {
  placed: PlacedBlockRecord[];
  visits: ChunkVisitRecord[];
  traversals: PreparedTraversal[];
  bytes: number;
}

function ledgerInvalid(message: string): Error {
  return new Error(message);
}

function requireLedgerString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw ledgerInvalid(`ledger ${what} must be a non-empty string`);
  return value;
}

function validateLedgerEndpoint(
  raw: PortalEndpointEvidence | null,
  what: string,
  wId: string,
  maxBytes: number,
): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw ledgerInvalid(`ledger ${what} must be an object`);
  if (raw.worldId !== wId) throw ledgerInvalid(`ledger ${what}.worldId does not match "${wId}"`);
  requireLedgerString(raw.id, `${what}.id`);
  requireLedgerString(raw.dim, `${what}.dim`);
  if (!PORTAL_ENDPOINT_KINDS.has(raw.kind)) throw ledgerInvalid(`ledger ${what}.kind is not known`);
  if (typeof raw.portalObserved !== 'boolean') throw ledgerInvalid(`ledger ${what}.portalObserved must be a boolean`);
  if (!Number.isFinite(raw.observedAt)) throw ledgerInvalid(`ledger ${what}.observedAt must be finite`);
  if (!Number.isFinite(raw.pos?.x) || !Number.isFinite(raw.pos?.y) || !Number.isFinite(raw.pos?.z)) {
    throw ledgerInvalid(`ledger ${what}.pos must be finite`);
  }
  const json = JSON.stringify(raw);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) throw ledgerInvalid(`ledger ${what} exceeds maxEndpointBytes (${bytes})`);
  return json;
}

/**
 * Re-validate and bound a complete ledger snapshot at the process/DB boundary,
 * independently of the main-thread store. The worker never trusts the session's
 * ordering or capacity checks: a checkpoint either commits a fully valid,
 * world-scoped ledger or rolls back with the rest of the batch.
 */
function prepareLedger(snapshot: LedgerSnapshot, wId: string, resolved: ResolvedLedgerLimits): PreparedLedger {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw ledgerInvalid('ledger snapshot must be an object');
  }
  if (snapshot.worldId !== wId) throw ledgerInvalid('ledger snapshot worldId does not match session worldId');
  if (!Array.isArray(snapshot.placed) || !Array.isArray(snapshot.visits) || !Array.isArray(snapshot.traversals)) {
    throw ledgerInvalid('ledger snapshot arrays are malformed');
  }
  if (snapshot.placed.length > resolved.maxPlacedBlocks) {
    throw ledgerInvalid(`ledger exceeds maxPlacedBlocks (${snapshot.placed.length})`);
  }
  if (snapshot.visits.length > resolved.maxChunkVisits) {
    throw ledgerInvalid(`ledger exceeds maxChunkVisits (${snapshot.visits.length})`);
  }
  if (snapshot.traversals.length > resolved.maxPortalTraversals) {
    throw ledgerInvalid(`ledger exceeds maxPortalTraversals (${snapshot.traversals.length})`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > resolved.maxBytes) throw ledgerInvalid(`ledger exceeds maxBytes (${bytes})`);

  const placed: PlacedBlockRecord[] = [];
  const placedKeys = new Set<string>();
  for (const raw of snapshot.placed) {
    if (raw === null || typeof raw !== 'object') throw ledgerInvalid('ledger placed record must be an object');
    if (raw.worldId !== wId) throw ledgerInvalid('ledger placed record belongs to another world');
    const dim = requireLedgerString(raw.dim, 'placed dim');
    if (!Number.isSafeInteger(raw.pos?.x) || !Number.isSafeInteger(raw.pos?.y) || !Number.isSafeInteger(raw.pos?.z)) {
      throw ledgerInvalid('ledger placed position must be integer grid coordinates');
    }
    const key = placedBlockKey(wId, dim, raw.pos.x, raw.pos.y, raw.pos.z);
    if (raw.key !== key) throw ledgerInvalid(`ledger placed key "${String(raw.key)}" does not match its coordinates`);
    if (placedKeys.has(key)) throw ledgerInvalid(`duplicate ledger placed key "${key}"`);
    placedKeys.add(key);
    requireLedgerString(raw.name, 'placed name');
    if (!Number.isSafeInteger(raw.lruAt) || raw.lruAt < 0) throw ledgerInvalid('ledger placed lruAt must be non-negative');
    if (raw.source !== 'legacy' && raw.source !== 'live') throw ledgerInvalid('ledger placed source is not known');
    placed.push({ ...raw, key, worldId: wId, dim, pos: { x: raw.pos.x, y: raw.pos.y, z: raw.pos.z } });
  }

  const visits: ChunkVisitRecord[] = [];
  const visitKeys = new Set<string>();
  for (const raw of snapshot.visits) {
    if (raw === null || typeof raw !== 'object') throw ledgerInvalid('ledger visit record must be an object');
    if (raw.worldId !== wId) throw ledgerInvalid('ledger visit record belongs to another world');
    const dim = requireLedgerString(raw.dim, 'visit dim');
    if (!Number.isSafeInteger(raw.cx) || !Number.isSafeInteger(raw.cz)) {
      throw ledgerInvalid('ledger visit chunk coordinates must be integers');
    }
    if (!Number.isSafeInteger(raw.count) || raw.count < 0) throw ledgerInvalid('ledger visit count must be non-negative');
    const key = chunkVisitKey(wId, dim, raw.cx, raw.cz);
    if (raw.key !== key) throw ledgerInvalid(`ledger visit key "${String(raw.key)}" does not match its coordinates`);
    if (visitKeys.has(key)) throw ledgerInvalid(`duplicate ledger visit key "${key}"`);
    visitKeys.add(key);
    if (raw.source !== 'legacy' && raw.source !== 'live') throw ledgerInvalid('ledger visit source is not known');
    visits.push({ ...raw, key, worldId: wId, dim });
  }

  const traversals: PreparedTraversal[] = [];
  const traversalIds = new Set<string>();
  for (const raw of snapshot.traversals) {
    if (raw === null || typeof raw !== 'object') throw ledgerInvalid('ledger traversal record must be an object');
    if (raw.worldId !== wId) throw ledgerInvalid('ledger traversal record belongs to another world');
    requireLedgerString(raw.fromId, 'traversal fromId');
    requireLedgerString(raw.toId, 'traversal toId');
    if (!Number.isFinite(raw.ts)) throw ledgerInvalid('ledger traversal ts must be finite');
    requireLedgerString(raw.fromSession, 'traversal fromSession');
    requireLedgerString(raw.toSession, 'traversal toSession');
    if (!Number.isSafeInteger(raw.fromObservation) || !Number.isSafeInteger(raw.toObservation)) {
      throw ledgerInvalid('ledger traversal observation ids must be integers');
    }
    if (!PORTAL_TRAVERSAL_KINDS.has(raw.kind)) throw ledgerInvalid('ledger traversal kind is not known');
    if (!PORTAL_DIRECTIONS.has(raw.direction)) throw ledgerInvalid('ledger traversal direction is not known');
    if (raw.source !== 'legacy' && raw.source !== 'live') throw ledgerInvalid('ledger traversal source is not known');
    const fromEndpointJson = validateLedgerEndpoint(raw.fromEndpoint, 'traversal fromEndpoint', wId, resolved.maxEndpointBytes);
    const toEndpointJson = validateLedgerEndpoint(raw.toEndpoint, 'traversal toEndpoint', wId, resolved.maxEndpointBytes);
    if (raw.fromEndpoint !== null && raw.fromEndpoint.id !== raw.fromId) {
      throw ledgerInvalid('ledger traversal fromEndpoint.id does not match fromId');
    }
    if (raw.toEndpoint !== null && raw.toEndpoint.id !== raw.toId) {
      throw ledgerInvalid('ledger traversal toEndpoint.id does not match toId');
    }
    const id = portalTraversalIdentity({ ...raw, kind: raw.kind });
    if (raw.id !== id) throw ledgerInvalid(`ledger traversal id "${String(raw.id)}" does not match its evidence`);
    if (traversalIds.has(id)) throw ledgerInvalid(`duplicate ledger traversal id "${id}"`);
    traversalIds.add(id);
    traversals.push({ ...raw, id, worldId: wId, fromEndpointJson, toEndpointJson });
  }

  return { placed, visits, traversals, bytes };
}

/** Replace this world's ledger rows inside the checkpoint transaction. */
function writeLedger(connection: Database.Database, wId: string, prepared: PreparedLedger): void {
  connection.prepare('DELETE FROM placed_blocks WHERE world_id = ?').run(wId);
  connection.prepare('DELETE FROM chunk_visits WHERE world_id = ?').run(wId);
  connection.prepare('DELETE FROM portal_traversals WHERE world_id = ?').run(wId);

  const insertPlaced = connection.prepare(
    'INSERT INTO placed_blocks (key, world_id, dim, x, y, z, name, lru_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const record of prepared.placed) {
    insertPlaced.run(
      record.key,
      wId,
      record.dim,
      record.pos.x,
      record.pos.y,
      record.pos.z,
      record.name,
      record.lruAt,
      record.source,
    );
  }

  const insertVisit = connection.prepare(
    'INSERT INTO chunk_visits (key, world_id, dim, cx, cz, count, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const record of prepared.visits) {
    insertVisit.run(record.key, wId, record.dim, record.cx, record.cz, record.count, record.source);
  }

  const insertTraversal = connection.prepare(
    'INSERT INTO portal_traversals (id, world_id, kind, direction, from_id, to_id, ts, from_session, to_session, from_observation, to_observation, from_endpoint, to_endpoint, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const record of prepared.traversals) {
    insertTraversal.run(
      record.id,
      wId,
      record.kind,
      record.direction,
      record.fromId,
      record.toId,
      record.ts,
      record.fromSession,
      record.toSession,
      record.fromObservation,
      record.toObservation,
      record.fromEndpointJson,
      record.toEndpointJson,
      record.source,
    );
  }
}

function parseStoredEndpoint(raw: string | null, what: string): PortalEndpointEvidence | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ledgerInvalid(`corrupt ${what} payload`);
  }
  return parsed as PortalEndpointEvidence;
}

/**
 * Read this world's committed ledger. Payloads are bounded by count before decode;
 * a world with ledger rows but no ledger baseline is corruption, never an empty
 * ledger (a later full checkpoint would otherwise erase real rows).
 */
function loadLedger(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedLedgerLimits,
): { baselineCheckpointId: string | null; snapshot: LedgerSnapshot | null; bytes: number } {
  const cp = connection
    .prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? AND has_ledger = 1 ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string } | undefined;

  const placedRows = countRows(connection, 'placed_blocks', wId);
  const visitRows = countRows(connection, 'chunk_visits', wId);
  const traversalRows = countRows(connection, 'portal_traversals', wId);
  if (cp === undefined) {
    if (placedRows + visitRows + traversalRows > 0) {
      throw new Error('world has ledger rows but no ledger checkpoint metadata');
    }
    return { baselineCheckpointId: null, snapshot: null, bytes: 0 };
  }
  if (placedRows > resolved.maxPlacedBlocks) throw new Error(`ledger exceeds maxPlacedBlocks (${placedRows})`);
  if (visitRows > resolved.maxChunkVisits) throw new Error(`ledger exceeds maxChunkVisits (${visitRows})`);
  if (traversalRows > resolved.maxPortalTraversals) {
    throw new Error(`ledger exceeds maxPortalTraversals (${traversalRows})`);
  }

  const placed = (connection
    .prepare('SELECT key, world_id, dim, x, y, z, name, lru_at, source FROM placed_blocks WHERE world_id = ? ORDER BY lru_at, key')
    .all(wId) as {
      key: string;
      world_id: string;
      dim: string;
      x: number;
      y: number;
      z: number;
      name: string;
      lru_at: number;
      source: 'legacy' | 'live';
    }[]).map((row) => ({
      key: row.key,
      worldId: row.world_id,
      dim: row.dim,
      pos: { x: row.x, y: row.y, z: row.z },
      name: row.name,
      lruAt: row.lru_at,
      source: row.source,
    }));

  const visits = (connection
    .prepare('SELECT key, world_id, dim, cx, cz, count, source FROM chunk_visits WHERE world_id = ? ORDER BY key')
    .all(wId) as {
      key: string;
      world_id: string;
      dim: string;
      cx: number;
      cz: number;
      count: number;
      source: 'legacy' | 'live';
    }[]).map((row) => ({
      key: row.key,
      worldId: row.world_id,
      dim: row.dim,
      cx: row.cx,
      cz: row.cz,
      count: row.count,
      source: row.source,
    }));

  const traversals = (connection
    .prepare(
      'SELECT id, world_id, kind, direction, from_id, to_id, ts, from_session, to_session, from_observation, to_observation, from_endpoint, to_endpoint, source FROM portal_traversals WHERE world_id = ? ORDER BY ts, id',
    )
    .all(wId) as {
      id: string;
      world_id: string;
      kind: PortalTraversalRecord['kind'];
      direction: PortalTraversalRecord['direction'];
      from_id: string;
      to_id: string;
      ts: number;
      from_session: string;
      to_session: string;
      from_observation: number;
      to_observation: number;
      from_endpoint: string | null;
      to_endpoint: string | null;
      source: 'legacy' | 'live';
    }[]).map((row) => ({
      id: row.id,
      worldId: row.world_id,
      kind: row.kind,
      direction: row.direction,
      fromId: row.from_id,
      toId: row.to_id,
      ts: row.ts,
      fromSession: row.from_session,
      toSession: row.to_session,
      fromObservation: row.from_observation,
      toObservation: row.to_observation,
      fromEndpoint: parseStoredEndpoint(row.from_endpoint, 'traversal fromEndpoint'),
      toEndpoint: parseStoredEndpoint(row.to_endpoint, 'traversal toEndpoint'),
      source: row.source,
    }));

  const snapshot: LedgerSnapshot = { worldId: wId, placed, visits, traversals };
  // Re-validate everything read from disk through the same boundary as a write.
  const prepared = prepareLedger(snapshot, wId, resolved);
  return { baselineCheckpointId: cp.checkpoint_id, snapshot, bytes: prepared.bytes };
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
              OR typeof(voxel_revision) != 'integer' OR voxel_revision < 0
              OR typeof(has_journal) != 'integer' OR (has_journal != 0 AND has_journal != 1)
              OR typeof(journal_revision) != 'integer' OR journal_revision < 0
              OR typeof(has_ledger) != 'integer' OR (has_ledger != 0 AND has_ledger != 1)
              OR typeof(ledger_revision) != 'integer' OR ledger_revision < 0
              OR typeof(topology_extras) != 'text')`,
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
    .prepare('SELECT checkpoint_id, topology_extras FROM checkpoints WHERE world_id = ? ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string; topology_extras: string } | undefined;
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
  const extras = JSON.parse(cp.topology_extras) as {
    portalEdges?: HistorySnapshot['portalEdges'];
    fragmentMerges?: HistorySnapshot['fragmentMerges'];
  };
  const portalEdges = extras.portalEdges ?? [];
  const fragmentMerges = extras.fragmentMerges ?? [];
  const bytes =
    sumPayloadBytes(connection, 'path_fragments', wId) +
    sumPayloadBytes(connection, 'traversal_evidence', wId) +
    sumPayloadBytes(connection, 'spatial_nodes', wId) +
    sumPayloadBytes(connection, 'spatial_edges', wId) +
    SNAPSHOT_FRAME_BYTES +
    interRecordCommas(fragments, traversals, nodes, edges) +
    Buffer.byteLength(JSON.stringify(wId), 'utf8') +
    Buffer.byteLength(cp.topology_extras, 'utf8');
  assertCountsWithinLimits(
    fragments,
    traversals,
    nodes,
    edges + portalEdges.length + fragmentMerges.length,
    bytes,
    resolved,
  );

  const snapshot: HistorySnapshot = {
    worldId: wId,
    fragments: readAll(connection, 'path_fragments', wId) as HistorySnapshot['fragments'],
    traversals: readAll(connection, 'traversal_evidence', wId) as HistorySnapshot['traversals'],
    nodes: readAll(connection, 'spatial_nodes', wId) as HistorySnapshot['nodes'],
    edges: readAll(connection, 'spatial_edges', wId) as HistorySnapshot['edges'],
    portalEdges,
    fragmentMerges,
  };
  assertDerivedWithinLimits(computeDerivedCounts(snapshot), resolved);
  return { baselineCheckpointId: cp.checkpoint_id, snapshot, bytes };
}


/**
 * Decode one voxel section payload through the shared versioned decoder.
 *
 * v1 payloads (full state inline) and v2 payloads (palette-referenced state,
 * history bitmaps) both decode to the same `VoxelSectionSnapshot`. The worker
 * must not maintain a second, divergent decoder.
 */
function decodeVoxelSection(payload: string): VoxelSectionSnapshot {
  return decodeVoxelSectionPayload(JSON.parse(payload));
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
      'SELECT id, seq, octet_length(payload) AS bytes, observed_cells, palette_entries, revision, dimension, cx, cz, sy FROM spatial_sections WHERE world_id = ? ORDER BY seq',
    )
    .all(wId) as {
      id: string;
      seq: number;
      bytes: number;
      observed_cells: number;
      palette_entries: number;
      revision: number;
      dimension: string;
      cx: number;
      cz: number;
      sy: number;
    }[];

  const directory: VoxelDirectoryEntry[] = [];
  let observedCells = 0;
  let paletteEntries = 0;
  for (const row of rows) {
    const [dim, cx, cz, sy] = sectionIdentity(row);
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

/**
 * Read only the committed journal baseline/count metadata for this world —
 * payloads are never decoded or loaded. This still scans committed metadata for
 * this world (`COUNT(*)` plus `SUM(octet_length(payload))` over both tables), so
 * reopen work grows with the number of committed rows, not with payload size or
 * decode cost.
 */
function loadJournalMeta(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedJournalLimits,
): {
  baselineCheckpointId: string | null;
  revision: number;
  recordCount: number;
  recordBytes: number;
} {
  const cp = connection
    .prepare(
      'SELECT checkpoint_id, journal_revision FROM checkpoints WHERE world_id = ? AND has_journal = 1 ORDER BY seq DESC LIMIT 1',
    )
    .get(wId) as { checkpoint_id: string; journal_revision: number } | undefined;
  const recordCount = countRows(connection, 'action_records', wId) + countRows(connection, 'spatial_events', wId);
  const recordBytes =
    sumPayloadBytes(connection, 'action_records', wId) + sumPayloadBytes(connection, 'spatial_events', wId);
  if (cp === undefined) {
    // Corruption guard: rows must not read as an empty journal when their
    // checkpoint baseline is missing.
    if (recordCount > 0) throw new Error('world has journal rows but no journal checkpoint metadata');
    return { baselineCheckpointId: null, revision: 0, recordCount, recordBytes };
  }
  if (recordCount > resolved.maxCommittedRecords) {
    throw new Error(`journal exceeds maxCommittedRecords (${recordCount})`);
  }
  if (recordBytes > resolved.maxCommittedBytes) {
    throw new Error(`journal exceeds maxCommittedBytes (${recordBytes})`);
  }
  return { baselineCheckpointId: cp.checkpoint_id, revision: cp.journal_revision, recordCount, recordBytes };
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

/**
 * Resolve one section's identity from its explicit columns and verify it against
 * the legacy `id` JSON. A mismatch is corruption, never a silent preference for
 * one copy: mixing a column-sourced dimension with a payload from another cell
 * would otherwise smuggle facts across sections/dimensions.
 */
function sectionIdentity(row: {
  id: string;
  dimension: string;
  cx: number;
  cz: number;
  sy: number;
}): [string, number, number, number] {
  const [dim, cx, cz, sy] = parseSectionId(row.id);
  if (dim !== row.dimension || cx !== row.cx || cz !== row.cz || sy !== row.sy) {
    throw new Error('corrupt section identity: explicit coordinates disagree with id');
  }
  return [dim, cx, cz, sy];
}

function handleOpen(msg: WorkerRequest & { type: 'open' }): void {
  const connection = openDatabase(msg.databasePath);
  db = connection;
  worldId = msg.worldId;
  limits = msg.limits;
  journalLimits = msg.journalLimits;
  ledgerLimits = msg.ledgerLimits ?? DEFAULT_LEDGER_LIMITS;
  try {
    const world = loadWorld(connection, msg.worldId, msg.limits);
    const journal = loadJournalMeta(connection, msg.worldId, msg.journalLimits);
    let voxelBaselineCheckpointId: string | null = null;
    let voxelSnapshot: VoxelCheckpointSnapshot | null = null;
    let voxelDirectory: VoxelDirectoryEntry[] | null = null;
    let ledgerBaselineCheckpointId: string | null = null;
    let ledgerSnapshot: LedgerSnapshot | null = null;
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
      const ledger = loadLedger(connection, msg.worldId, ledgerLimits);
      ledgerBaselineCheckpointId = ledger.baselineCheckpointId;
      ledgerSnapshot = ledger.snapshot;
    }
    respond({
      type: 'open_ok',
      requestId: msg.requestId,
      baselineCheckpointId: world.baselineCheckpointId,
      snapshot: world.snapshot,
      voxelBaselineCheckpointId,
      voxelSnapshot,
      voxelDirectory,
      journalBaselineCheckpointId: journal.baselineCheckpointId,
      journalRevision: journal.revision,
      journalRecordCount: journal.recordCount,
      journalRecordBytes: journal.recordBytes,
      ledgerBaselineCheckpointId,
      ledgerSnapshot,
    });
  } catch (err) {
    db = null;
    worldId = null;
    limits = null;
    journalLimits = null;
    ledgerLimits = DEFAULT_LEDGER_LIMITS;
    connection.close();
    const message = (err as Error).message;
    const kind = /exceeds/.test(message) ? 'capacity' : 'data';
    respond({ type: 'error', requestId: msg.requestId, kind, message });
  }
}

function handleCheckpoint(msg: WorkerRequest & { type: 'checkpoint' }): void {
  if (db === null || worldId === null || limits === null || journalLimits === null) {
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
  if (msg.journalMode !== 'none' && msg.journalMode !== 'append') {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'invalid journal save mode' });
    return;
  }
  if (!Number.isSafeInteger(msg.journalRevision) || msg.journalRevision < 0) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'journal revision must be a non-negative safe integer' });
    return;
  }
  if (msg.journalMode === 'none' && (msg.journalBatch.actions.length > 0 || msg.journalBatch.events.length > 0)) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'journal mode none must not carry records' });
    return;
  }
  const ledgerMode = msg.ledgerMode ?? 'none';
  if (ledgerMode !== 'none' && ledgerMode !== 'full') {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'invalid ledger save mode' });
    return;
  }
  const ledgerRevision = msg.ledgerRevision ?? 0;
  if (!Number.isSafeInteger(ledgerRevision) || ledgerRevision < 0) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'ledger revision must be a non-negative safe integer' });
    return;
  }
  if (ledgerMode === 'none' && msg.ledgerSnapshot !== undefined) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'ledger mode none must not carry a snapshot' });
    return;
  }
  if (ledgerMode === 'full' && msg.ledgerSnapshot === undefined) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'ledger mode full requires a snapshot' });
    return;
  }
  let prepared: PreparedSnapshot;
  let preparedVoxel: PreparedVoxelSnapshot | null = null;
  let preparedJournal: PreparedJournal;
  let preparedLedger: PreparedLedger | null = null;
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
    preparedJournal =
      msg.journalMode === 'none'
        ? { actions: [], events: [], bytes: 0 }
        : prepareJournalBatch(msg.journalBatch, worldId, journalLimits);
    if (ledgerMode === 'full') {
      preparedLedger = prepareLedger(msg.ledgerSnapshot!, worldId, ledgerLimits);
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
    }, {
      mode: msg.journalMode,
      revision: msg.journalRevision,
      prepared: preparedJournal,
    }, {
      mode: ledgerMode,
      revision: ledgerRevision,
      prepared: preparedLedger,
    }, limits, journalLimits);
  } catch (err) {
    // Capacity/conflict rejections raised inside the transaction roll the whole
    // batch back; a conflict is never reported as a generic SQL fault.
    const message = (err as Error).message;
    const kind =
      err instanceof JournalConflictError ? 'conflict' : /exceeds/.test(message) ? 'capacity' : 'sql';
    respond({ type: 'error', requestId: msg.requestId, kind, message });
    return;
  }
  const voxelBytes = (preparedVoxel?.sections ?? []).map((s) => {
    const [dim, cx, cz, sy] = parseSectionId(s.id);
    return { dim, cx, cz, sy, bytes: Buffer.byteLength(s.payload, 'utf8') };
  });
  respond({
    type: 'checkpoint_ok',
    requestId: msg.requestId,
    checkpointId: msg.checkpointId,
    voxelBytes,
    journalRecordCount: countRows(db, 'action_records', worldId) + countRows(db, 'spatial_events', worldId),
    journalRecordBytes: sumPayloadBytes(db, 'action_records', worldId) + sumPayloadBytes(db, 'spatial_events', worldId),
  });
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

interface JournalMetaRow {
  seq: number;
  bytes: number;
}

/**
 * Shared committed-journal paging. Metadata (including `octet_length`) is read
 * before any payload, the page budget is enforced before decode, and a record
 * whose own payload exceeds the page budget is rejected explicitly instead of
 * being silently skipped. Ordering is storage insertion sequence.
 */
function readJournalPage<T>(
  connection: Database.Database,
  table: 'action_records' | 'spatial_events',
  wId: string,
  afterSeq: number,
  maxRecords: number,
  maxBytes: number,
  filters: { dim?: string; sessionId?: string; id?: string; kind?: string },
): { records: T[]; nextCursor: string | null; hasMore: boolean } {
  const conditions = ['world_id = ?', 'seq > ?'];
  const params: (string | number)[] = [wId, afterSeq];
  if (filters.dim !== undefined) {
    conditions.push('dim = ?');
    params.push(filters.dim);
  }
  if (filters.sessionId !== undefined) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.id !== undefined) {
    conditions.push('id = ?');
    params.push(filters.id);
  }
  if (filters.kind !== undefined) {
    conditions.push('kind = ?');
    params.push(filters.kind);
  }
  const rows = connection
    .prepare(
      `SELECT seq, octet_length(payload) AS bytes FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
    )
    .all(...params, maxRecords + 1) as JournalMetaRow[];

  const selected: JournalMetaRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (selected.length >= maxRecords) break;
    if (row.bytes > maxBytes) {
      if (selected.length === 0) {
        throw new Error(`journal record exceeds maxPageBytes (${row.bytes})`);
      }
      break;
    }
    if (bytes + row.bytes > maxBytes) {
      if (selected.length === 0) {
        throw new Error(`journal page exceeds maxPageBytes (${row.bytes})`);
      }
      break;
    }
    selected.push(row);
    bytes += row.bytes;
  }
  const hasMore = selected.length < rows.length;
  if (selected.length === 0) {
    return { records: [], nextCursor: null, hasMore: false };
  }

  const load = connection.prepare(`SELECT payload FROM ${table} WHERE seq = ?`);
  const records = selected.map((row) => {
    const payload = load.get(row.seq) as { payload: string } | undefined;
    if (payload === undefined) throw new Error(`journal row ${row.seq} disappeared while paging`);
    return JSON.parse(payload.payload) as T;
  });
  const last = selected[selected.length - 1]!;
  return { records, nextCursor: hasMore ? String(last.seq) : null, hasMore };
}

function assertQueryBounds(
  msg: WorkerRequest & { type: 'query_actions' | 'query_events' },
  resolved: ResolvedJournalLimits,
): void {
  if (msg.worldId !== worldId) {
    throw new Error('journal query worldId does not match session worldId');
  }
  if (!Number.isSafeInteger(msg.afterSeq) || msg.afterSeq < 0) {
    throw new Error('journal query cursor must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(msg.maxRecords) || msg.maxRecords < 1 || msg.maxRecords > resolved.maxPageRecords) {
    throw new Error(`journal query maxRecords must be within 1..${resolved.maxPageRecords}`);
  }
  if (!Number.isSafeInteger(msg.maxBytes) || msg.maxBytes < 1 || msg.maxBytes > resolved.maxPageBytes) {
    throw new Error(`journal query maxBytes must be within 1..${resolved.maxPageBytes}`);
  }
}

function handleQueryActions(msg: WorkerRequest & { type: 'query_actions' }): void {
  if (db === null || worldId === null || journalLimits === null) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'worker is not open' });
    return;
  }
  try {
    assertQueryBounds(msg, journalLimits);
    const page = readJournalPage<ActionRecord>(db, 'action_records', worldId, msg.afterSeq, msg.maxRecords, msg.maxBytes, {
      dim: msg.dim,
      sessionId: msg.sessionId,
      id: msg.actionId,
    });
    respond({ type: 'query_actions_ok', requestId: msg.requestId, ...page });
  } catch (err) {
    const message = (err as Error).message;
    const kind = /exceeds/.test(message) ? 'capacity' : /worldId|cursor|maxRecords|maxBytes/.test(message) ? 'invalid_argument' : 'data';
    respond({ type: 'error', requestId: msg.requestId, kind, message });
  }
}

function handleQueryEvents(msg: WorkerRequest & { type: 'query_events' }): void {
  if (db === null || worldId === null || journalLimits === null) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'invalid_argument', message: 'worker is not open' });
    return;
  }
  try {
    assertQueryBounds(msg, journalLimits);
    const page = readJournalPage<SpatialEvent>(db, 'spatial_events', worldId, msg.afterSeq, msg.maxRecords, msg.maxBytes, {
      dim: msg.dim,
      sessionId: msg.sessionId,
      id: msg.eventId,
      kind: msg.kind,
    });
    respond({ type: 'query_events_ok', requestId: msg.requestId, ...page });
  } catch (err) {
    const message = (err as Error).message;
    const kind = /exceeds/.test(message) ? 'capacity' : /worldId|cursor|maxRecords|maxBytes/.test(message) ? 'invalid_argument' : 'data';
    respond({ type: 'error', requestId: msg.requestId, kind, message });
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
    case 'query_actions':
      handleQueryActions(msg);
      break;
    case 'query_events':
      handleQueryEvents(msg);
      break;
    case 'close':
      handleClose(msg);
      break;
  }
});
