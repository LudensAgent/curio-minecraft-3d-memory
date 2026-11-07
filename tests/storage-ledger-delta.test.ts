import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import type { PathFragment } from '../src/index.js';
import type { TopologyPortalEdgeSnapshot } from '../src/topology/topology-store.js';
import type { ChunkVisitRecord, PlacedBlockRecord, PortalTraversalRecord } from '../src/storage/sqlite/types.js';
import { DEFAULT_LEDGER_LIMITS, resolveJournalLimits, resolveSnapshotLimits } from '../src/storage/sqlite/types.js';
import type { WorkerRequest } from '../src/storage/sqlite/types.js';
import { LedgerStore, portalTraversalIdentity } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const tempDirs: string[] = [];
const workers: Worker[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-ledger-delta-'));
  tempDirs.push(dir);
  return join(dir, 'ledger.db');
}

function placed(x: number, name = 'minecraft:torch'): PlacedBlockRecord {
  return {
    key: `${WORLD}:${DIM}:${x},64,0`,
    worldId: WORLD,
    dim: DIM,
    pos: { x, y: 64, z: 0 },
    name,
    lruAt: x + 1,
    source: 'live',
  };
}

function visit(cx: number, count = 1): ChunkVisitRecord {
  return {
    key: `${WORLD}:${DIM}:${cx}:0`,
    worldId: WORLD,
    dim: DIM,
    cx,
    cz: 0,
    count,
    source: 'live',
  };
}

function traversal(): PortalTraversalRecord {
  return {
    id: portalTraversalIdentity({
      fromId: 'ep_a',
      toId: 'ep_b',
      ts: 1200,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 7,
      toObservation: 8,
    }),
    worldId: WORLD,
    kind: 'traversal',
    direction: 'unclassified',
    fromId: 'ep_a',
    toId: 'ep_b',
    ts: 1200,
    fromSession: 's1',
    toSession: 's2',
    fromObservation: 7,
    toObservation: 8,
    fromEndpoint: null,
    toEndpoint: null,
    source: 'live',
  };
}

type WorkerReply = { type: string; requestId: number } & Record<string, unknown>;

function startWorker(dbPath: string): {
  send: (message: WorkerRequest) => Promise<WorkerReply>;
  close: (requestId: number) => Promise<void>;
} {
  const worker = new Worker(new URL('../dist/storage/sqlite/worker.js', import.meta.url));
  workers.push(worker);
  const send = (message: WorkerRequest): Promise<WorkerReply> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker reply timeout (${message.type})`)), 30_000);
      const onMessage = (reply: WorkerReply): void => {
        if (reply.requestId !== message.requestId) return;
        worker.off('message', onMessage);
        clearTimeout(timer);
        if (reply.type === 'error') reject(Object.assign(new Error(String(reply.message)), { kind: reply.kind }));
        else resolve(reply);
      };
      worker.on('message', onMessage);
      worker.postMessage(message);
    });
  return {
    send,
    close: async (requestId) => {
      await send({ type: 'close', requestId });
    },
  };
}

function openMessage(dbPath: string, requestId: number, maxPlacedBlocks = DEFAULT_LEDGER_LIMITS.maxPlacedBlocks): WorkerRequest {
  return {
    type: 'open',
    requestId,
    databasePath: dbPath,
    worldId: WORLD,
    limits: resolveSnapshotLimits(undefined),
    journalLimits: resolveJournalLimits(undefined),
    kind: 'spatial',
    voxelLoading: 'eager',
    ledgerLimits: { ...DEFAULT_LEDGER_LIMITS, maxPlacedBlocks },
  };
}

interface CheckpointOverrides {
  checkpointId: string;
  placed?: PlacedBlockRecord[];
  visits?: ChunkVisitRecord[];
  ledgerMode?: 'none' | 'full' | 'delta';
  ledgerUpserts?: PlacedBlockRecord[];
  ledgerRemovals?: string[];
  ledgerTraversals?: PortalTraversalRecord[];
  historyMode?: 'full' | 'none';
  topologyMode?: 'full' | 'none';
  fragments?: PathFragment[];
  portalEdges?: TopologyPortalEdgeSnapshot[];
}

function checkpointMessage(requestId: number, overrides: CheckpointOverrides): WorkerRequest {
  const mode = overrides.ledgerMode ?? 'none';
  const snapshot = {
    worldId: WORLD,
    fragments: overrides.fragments ?? [],
    traversals: [],
    nodes: [],
    edges: [],
    portalEdges: overrides.portalEdges ?? [],
    fragmentMerges: [],
  };
  return {
    type: 'checkpoint',
    requestId,
    checkpointId: overrides.checkpointId,
    worldId: WORLD,
    fragmentRevision: 1,
    topologyRevision: 1,
    snapshot,
    historyMode: overrides.historyMode,
    topologyMode: overrides.topologyMode,
    voxelMode: 'none',
    voxelRevision: 0,
    voxelSnapshot: { worldId: WORLD, sections: [] },
    journalMode: 'none',
    journalRevision: 0,
    journalBatch: { actions: [], events: [] },
    ledgerMode: mode,
    ledgerRevision: 1,
    ...(mode === 'full'
      ? { ledgerSnapshot: { worldId: WORLD, placed: overrides.placed ?? [], visits: overrides.visits ?? [], traversals: [] } }
      : {}),
    ...(mode === 'delta'
      ? {
          ledgerDelta: {
            worldId: WORLD,
            placedUpserts: overrides.ledgerUpserts ?? [],
            placedRemovals: overrides.ledgerRemovals ?? [],
            visitUpserts: [],
            visitRemovals: [],
            traversals: overrides.ledgerTraversals ?? [],
          },
        }
      : {}),
  } as WorkerRequest;
}

async function readCommittedLedger(
  dbPath: string,
): Promise<{ placed: string[]; visits: number; traversals: number; checkpoints: number }> {
  const db = new Database(dbPath, { readonly: true });
  const placed = (db.prepare('SELECT key FROM placed_blocks WHERE world_id = ? ORDER BY key').all(WORLD) as { key: string }[]).map(
    (row) => row.key,
  );
  const visits = (db.prepare('SELECT COUNT(*) AS n FROM chunk_visits WHERE world_id = ?').get(WORLD) as { n: number }).n;
  const traversals = (db.prepare('SELECT COUNT(*) AS n FROM portal_traversals WHERE world_id = ?').get(WORLD) as { n: number }).n;
  const checkpoints = (db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE world_id = ?').get(WORLD) as { n: number }).n;
  db.close();
  return { placed, visits, traversals, checkpoints };
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('LedgerStore delta capture', () => {
  it('captures only changed rows and a confirmed capture re-captures empty', () => {
    const store = new LedgerStore(WORLD);
    store.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    store.visitChunk(DIM, 0, 0);

    const capture = store.captureDelta();
    expect(capture.placedUpserts.map((record) => record.key)).toEqual([placed(0).key]);
    expect(capture.visitUpserts.map((record) => record.key)).toEqual([visit(0).key]);
    expect(capture.placedRemovals).toEqual([]);
    expect(capture.visitRemovals).toEqual([]);
    expect(capture.revision).toBe(store.revision);

    store.confirmDelta(capture);
    const again = store.captureDelta();
    expect(again.placedUpserts).toEqual([]);
    expect(again.visitUpserts).toEqual([]);
    expect(again.placedRemovals).toEqual([]);
    expect(again.visitRemovals).toEqual([]);
    expect(again.traversals).toEqual([]);
  });

  it('keeps a key re-dirtied after capture pending when the older capture is confirmed', () => {
    const store = new LedgerStore(WORLD);
    store.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    const first = store.captureDelta();

    // Re-dirty the same key after the capture (new token). Confirming the older
    // capture must not erase the newer pending entry.
    store.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:glowstone');
    store.confirmDelta(first);

    const second = store.captureDelta();
    expect(second.placedUpserts.map((record) => record.name)).toEqual(['minecraft:glowstone']);

    // Confirming the stale capture again is still a no-op.
    store.confirmDelta(first);
    expect(store.captureDelta().placedUpserts.map((record) => record.name)).toEqual(['minecraft:glowstone']);
  });

  it('captures a new portal crossing and never emits a traversal removal', () => {
    const store = new LedgerStore(WORLD);
    store.recordPortalTraversal({
      fromId: 'ep_a',
      toId: 'ep_b',
      ts: 1200,
      fromSession: 's1',
      toSession: 's2',
      fromObservation: 7,
      toObservation: 8,
    });

    const capture = store.captureDelta();
    expect(capture.traversals).toEqual([traversal()]);

    store.confirmDelta(capture);
    expect(store.captureDelta().traversals).toEqual([]);
  });

  it('turns a removed key into a removal when nothing newer re-added it', () => {
    const store = new LedgerStore(WORLD);
    store.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    store.confirmDelta(store.captureDelta());

    store.removePlaced(DIM, { x: 0, y: 64, z: 0 });
    const capture = store.captureDelta();
    expect(capture.placedUpserts).toEqual([]);
    expect(capture.placedRemovals).toEqual([placed(0).key]);
  });
});

describe('worker ledger delta persistence', () => {
  it('keeps the first save full and never reads an omission as a deletion', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1));

    const first = await worker.send(
      checkpointMessage(2, { checkpointId: 'cp-1', ledgerMode: 'full', placed: [placed(0)], visits: [visit(0)] }),
    );
    expect(first.type).toBe('checkpoint_ok');
    // Byte/count statistics come back from the worker, not from a caller-side
    // serialization of the full set.
    expect(first.ledgerRecordCount).toBe(2);
    expect(first.ledgerRecordBytes).toBeGreaterThan(0);

    // Delta carries only the new row; the existing placed/visit rows are omitted.
    const second = await worker.send(
      checkpointMessage(3, { checkpointId: 'cp-2', ledgerMode: 'delta', ledgerUpserts: [placed(5)] }),
    );
    expect(second.type).toBe('checkpoint_ok');
    expect(second.ledgerRecordCount).toBe(3);
    await worker.close(4);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.placed).toEqual([placed(0).key, placed(5).key]);
    expect(committed.visits).toBe(1);
  });

  it('appends portal crossings carried by a delta', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1));
    await worker.send(checkpointMessage(2, { checkpointId: 'cp-1', ledgerMode: 'full', placed: [placed(0)] }));

    const reply = await worker.send(
      checkpointMessage(3, { checkpointId: 'cp-2', ledgerMode: 'delta', ledgerTraversals: [traversal()] }),
    );
    expect(reply.type).toBe('checkpoint_ok');
    await worker.close(4);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.traversals).toBe(1);
    expect(committed.placed).toEqual([placed(0).key]);
  });

  it('applies a delta removal without touching other committed rows', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1));
    await worker.send(
      checkpointMessage(2, { checkpointId: 'cp-1', ledgerMode: 'full', placed: [placed(0), placed(1)] }),
    );
    await worker.send(
      checkpointMessage(3, { checkpointId: 'cp-2', ledgerMode: 'delta', ledgerRemovals: [placed(1).key] }),
    );
    await worker.close(4);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.placed).toEqual([placed(0).key]);
    expect(committed.checkpoints).toBe(2);
  });

  it('rejects a key that is both upserted and removed and leaves the committed set untouched', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1));
    await worker.send(checkpointMessage(2, { checkpointId: 'cp-1', ledgerMode: 'full', placed: [placed(0)] }));

    await expect(
      worker.send(
        checkpointMessage(3, {
          checkpointId: 'cp-2',
          ledgerMode: 'delta',
          ledgerUpserts: [placed(5)],
          ledgerRemovals: [placed(5).key],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'data' });
    await worker.close(4);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.placed).toEqual([placed(0).key]);
    expect(committed.checkpoints).toBe(1);
  });

  it('enforces the post-merge full-set capacity from committed rows and rolls back', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1, 2));
    await worker.send(
      checkpointMessage(2, { checkpointId: 'cp-1', ledgerMode: 'full', placed: [placed(0), placed(1)] }),
    );

    // The delta itself is one row, but the merged full set is three.
    await expect(
      worker.send(checkpointMessage(3, { checkpointId: 'cp-2', ledgerMode: 'delta', ledgerUpserts: [placed(2)] })),
    ).rejects.toMatchObject({ kind: 'capacity' });
    await worker.close(4);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.placed).toEqual([placed(0).key, placed(1).key]);
    expect(committed.checkpoints).toBe(1);
  });
});

describe('worker domain modes', () => {
  const fragment: PathFragment = {
    id: 'f-1',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [{ x: 0.5, y: 64, z: 0.5 }],
    polyline: [
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
    ],
    geometrySource: 'traversal',
    deepestY: 64,
    createdAt: 1,
    lastUsedAt: 2,
    uses: 1,
  };
  const portalEdge: TopologyPortalEdgeSnapshot = { id: 'pe-1', from: 'n-o', to: 'n-n', directed: true, traversals: [] };

  it('keeps committed history/topology rows and topology extras when that domain is `none`', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    const opened = await worker.send(openMessage(dbPath, 1));
    expect(opened.type).toBe('open_ok');

    await worker.send(
      checkpointMessage(2, {
        checkpointId: 'cp-history',
        fragments: [fragment],
        portalEdges: [portalEdge],
        historyMode: 'full',
        topologyMode: 'full',
      }),
    );
    // A later checkpoint that writes no history/topology rows at all must leave
    // both the rows and the previous checkpoint's extras in place.
    await worker.send(
      checkpointMessage(3, { checkpointId: 'cp-none', historyMode: 'none', topologyMode: 'none' }),
    );
    await worker.close(4);

    const reopened = startWorker(dbPath);
    const reply = await reopened.send(openMessage(dbPath, 1));
    expect(reply.type).toBe('open_ok');
    const snapshot = reply.snapshot as {
      fragments: { id: string }[];
      portalEdges: { id: string }[];
    };
    expect(snapshot.fragments.map((entry) => entry.id)).toEqual(['f-1']);
    expect(snapshot.portalEdges.map((entry) => entry.id)).toEqual(['pe-1']);
    await reopened.close(2);
  });

  it('rejects a `none` domain that still carries rows instead of silently dropping them', async () => {
    const dbPath = makeDbPath();
    const worker = startWorker(dbPath);
    await worker.send(openMessage(dbPath, 1));

    await expect(
      worker.send(
        checkpointMessage(2, { checkpointId: 'cp-bad', fragments: [fragment], historyMode: 'none' }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_argument' });
    await worker.close(3);

    const committed = await readCommittedLedger(dbPath);
    expect(committed.checkpoints).toBe(0);
  });
});
