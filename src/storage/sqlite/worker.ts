/**
 * SQLite persistence worker thread (phase 5A).
 *
 * One worker owns one `better-sqlite3` connection and serializes load, checkpoint
 * transactions and JSON encode/decode. Its synchronous SQL API runs here, never on
 * the control thread. The worker never reads mineflayer, never judges what the
 * agent saw, and never controls the body — it only persists and restores the four
 * historical facts handed to it, with their original binding snapshots.
 */

import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type {
  HistorySnapshot,
  ResolvedSnapshotLimits,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

const SCHEMA_VERSION = 1;

const KNOWN_TABLES = new Set([
  'schema_meta',
  'checkpoints',
  'path_fragments',
  'traversal_evidence',
  'spatial_nodes',
  'spatial_edges',
]);

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

let db: Database.Database | null = null;
let worldId: string | null = null;
let limits: ResolvedSnapshotLimits | null = null;

function respond(msg: WorkerResponse): void {
  parentPort!.postMessage(msg);
}

/** Open (or validate) the database, returning a connection ready for the session's world. */
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
  if (!Number.isInteger(version) || version !== SCHEMA_VERSION) {
    connection.close();
    throw new Error(`unsupported schema version "${versionRow.value}"`);
  }
  for (const name of names) {
    if (!KNOWN_TABLES.has(name)) {
      connection.close();
      throw new Error(`unknown table "${name}" in database`);
    }
  }
  return connection;
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
    prepared.bytes += payload.length;
    prepared.polylinePoints += f.polyline.length;
    prepared.entrancePoints += f.entrances.length;
    prepared.linkPairs += f.links?.length ?? 0;
  }
  for (const t of snapshot.traversals) {
    const payload = stringifyRecord(t);
    prepared.traversals.push({ id: t.id, payload });
    prepared.bytes += payload.length;
  }
  for (const n of snapshot.nodes) {
    const payload = stringifyRecord(n);
    prepared.nodes.push({ id: n.id, payload });
    prepared.bytes += payload.length;
  }
  for (const e of snapshot.edges) {
    const payload = stringifyRecord(e);
    prepared.edges.push({ id: e.id, payload });
    prepared.bytes += payload.length;
    prepared.edgeEvidenceRefs += e.refs.length;
  }
  return prepared;
}

function assertWithinLimits(prepared: PreparedSnapshot, resolved: ResolvedSnapshotLimits): void {
  const over = (name: string): Error =>
    new Error(`snapshot exceeds ${name} (${resolved[name as keyof ResolvedSnapshotLimits]})`);
  if (prepared.fragments.length > resolved.maxFragments) throw over('maxFragments');
  if (prepared.traversals.length > resolved.maxTraversals) throw over('maxTraversals');
  if (prepared.nodes.length > resolved.maxNodes) throw over('maxNodes');
  if (prepared.edges.length > resolved.maxEdges) throw over('maxEdges');
  if (prepared.polylinePoints > resolved.maxPolylinePoints) throw over('maxPolylinePoints');
  if (prepared.entrancePoints > resolved.maxEntrancePoints) throw over('maxEntrancePoints');
  if (prepared.linkPairs > resolved.maxLinks) throw over('maxLinks');
  if (prepared.edgeEvidenceRefs > resolved.maxEdgeEvidenceRefs) throw over('maxEdgeEvidenceRefs');
  if (prepared.bytes > resolved.maxBytes) throw over('maxBytes');
}

function writeCheckpoint(
  connection: Database.Database,
  checkpointId: string,
  wId: string,
  fragmentRevision: number,
  topologyRevision: number,
  prepared: PreparedSnapshot,
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

    connection
      .prepare(
        'INSERT INTO checkpoints (checkpoint_id, world_id, fragment_revision, topology_revision, seq) VALUES (?, ?, ?, ?, ?)',
      )
      .run(checkpointId, wId, fragmentRevision, topologyRevision, nextSeq);
  });
  tx();
}

function readAll(connection: Database.Database, table: string, wId: string): unknown[] {
  const rows = connection
    .prepare(`SELECT payload FROM ${table} WHERE world_id = ? ORDER BY seq`)
    .all(wId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as unknown);
}

function loadWorld(
  connection: Database.Database,
  wId: string,
  resolved: ResolvedSnapshotLimits,
): { baselineCheckpointId: string | null; snapshot: HistorySnapshot | null } {
  const cp = connection
    .prepare('SELECT checkpoint_id FROM checkpoints WHERE world_id = ? ORDER BY seq DESC LIMIT 1')
    .get(wId) as { checkpoint_id: string } | undefined;
  if (cp === undefined) {
    return { baselineCheckpointId: null, snapshot: null };
  }
  const snapshot: HistorySnapshot = {
    worldId: wId,
    fragments: readAll(connection, 'path_fragments', wId) as HistorySnapshot['fragments'],
    traversals: readAll(connection, 'traversal_evidence', wId) as HistorySnapshot['traversals'],
    nodes: readAll(connection, 'spatial_nodes', wId) as HistorySnapshot['nodes'],
    edges: readAll(connection, 'spatial_edges', wId) as HistorySnapshot['edges'],
  };
  // Bound the load before returning it to the main thread.
  const prepared = prepareSnapshot(snapshot);
  assertWithinLimits(prepared, resolved);
  return { baselineCheckpointId: cp.checkpoint_id, snapshot };
}

function handleOpen(msg: WorkerRequest & { type: 'open' }): void {
  const connection = openDatabase(msg.databasePath);
  db = connection;
  worldId = msg.worldId;
  limits = msg.limits;
  try {
    const { baselineCheckpointId, snapshot } = loadWorld(connection, msg.worldId, msg.limits);
    respond({ type: 'open_ok', requestId: msg.requestId, baselineCheckpointId, snapshot });
  } catch (err) {
    respond({ type: 'error', requestId: msg.requestId, kind: 'data', message: (err as Error).message });
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
  try {
    prepared = prepareSnapshot(msg.snapshot);
    assertWithinLimits(prepared, limits);
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
    writeCheckpoint(db, msg.checkpointId, msg.worldId, msg.fragmentRevision, msg.topologyRevision, prepared);
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
