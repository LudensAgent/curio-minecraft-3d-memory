import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-checkpoint-domains-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('spatial checkpoint domain modes', () => {
  it('saves the ledger in full first, then only the delta (removal + upsert) on later checkpoints', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    session.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    session.ledger.visitChunk(DIM, 0, 0);

    const snapshotSpy = vi.spyOn(session.ledger, 'snapshot');
    const captureSpy = vi.spyOn(session.ledger, 'captureDelta');
    const first = await session.checkpoint();
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledTimes(1);

    snapshotSpy.mockClear();
    captureSpy.mockClear();
    session.ledger.removePlaced(DIM, { x: 0, y: 64, z: 0 });
    session.ledger.putPlaced(DIM, { x: 5, y: 64, z: 0 }, 'minecraft:glowstone');
    const second = await session.checkpoint();
    // No full snapshot copy/serialization on the delta path.
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(session.getPersistenceState()).toMatchObject({
      dirty: false,
      confirmedLedgerRevision: session.ledger.revision,
      ledgerBaselineCheckpointId: second.checkpointId,
    });
    await session.close();

    // The untouched visit row survives the delta, the removed key is gone.
    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.ledger.placedBlocks().map((record) => record.pos)).toEqual([{ x: 5, y: 64, z: 0 }]);
    expect(reopened.ledger.chunkVisitCount(DIM, 0, 0)).toBe(1);
    expect(reopened.getPersistenceState().ledgerBaselineCheckpointId).toBe(second.checkpointId);
    expect(first.checkpointId).not.toBe(second.checkpointId);
    await reopened.close();
  });

  it('skips clean history/topology domains without clearing committed rows or topology extras', async () => {
    const dbPath = makeDbPath();
    const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    const a = { x: 0.5, y: 64, z: 0.5 };
    const b = { x: 1.5, y: 64, z: 0.5 };
    const c = { x: 2.5, y: 64, z: 0.5 };
    const fragment = (id: string, from: typeof a, to: typeof c) => ({
      id,
      worldId: WORLD,
      dim: DIM,
      kind: 'walked' as const,
      entrances: [{ ...from }],
      polyline: [{ ...from }, { ...to }],
      geometrySource: 'traversal' as const,
      deepestY: 12,
      createdAt: 1000,
      lastUsedAt: 1000,
      uses: 1,
    });
    session.history.saveFragment(fragment('f1', a, b));
    session.history.saveFragment(fragment('f2', b, c));
    session.history.addTraversal({
      id: 't-merge',
      worldId: WORLD,
      dim: DIM,
      fragmentId: 'f1',
      from: { ...a },
      to: { ...b },
      observedAt: 1000,
      sessionId: 's1',
      source: 'confirmed_walk',
    });
    session.topology.mergeFragments('f1', 'f2', 't-merge');
    session.topology.saveNode({
      id: 'portal-o',
      kind: 'place',
      source: 'agent',
      tag: 'portal',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: 10, y: 64, z: 10 } },
    });
    session.topology.saveNode({
      id: 'portal-n',
      kind: 'place',
      source: 'agent',
      tag: 'portal',
      worldId: WORLD,
      dim: 'the_nether',
      location: { kind: 'exact', pos: { x: 77, y: 40, z: -33 } },
    });
    session.topology.savePortalEdge({ id: 'portal-1', from: 'portal-o', to: 'portal-n' }, [
      {
        id: 'pt-out',
        edgeId: 'portal-1',
        direction: 'forward',
        sessionId: 's1',
        observedAt: 1000,
        observationIds: ['obs-1'],
        source: 'portal_use',
      },
    ]);
    // Establish a ledger baseline with this first (full) checkpoint.
    session.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    await session.checkpoint();

    // Only the ledger changes now; history/topology revisions stay confirmed.
    session.ledger.putPlaced(DIM, { x: 1, y: 64, z: 0 }, 'minecraft:cobblestone');
    const historySnapshot = vi.spyOn(session.history, 'checkpointSnapshot');
    const topologySnapshot = vi.spyOn(session.topology, 'checkpointSnapshot');
    const historyMeasure = vi.spyOn(session.history, 'checkpointMeasure');
    const topologyMeasure = vi.spyOn(session.topology, 'checkpointMeasure');
    await session.checkpoint();
    expect(historySnapshot).not.toHaveBeenCalled();
    expect(topologySnapshot).not.toHaveBeenCalled();
    expect(historyMeasure).not.toHaveBeenCalled();
    expect(topologyMeasure).not.toHaveBeenCalled();
    await session.close();

    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.fragments().items.map((entry) => entry.id).sort()).toEqual(['f1', 'f2']);
    expect(reopened.history.traversals().items.map((entry) => entry.id)).toEqual(['t-merge']);
    expect(reopened.topology.nodes().items.map((entry) => entry.id).sort()).toEqual(['portal-n', 'portal-o']);
    // The omitted topology domain keeps both its rows and its checkpoint extras.
    expect(reopened.topology.portalEdges()).toHaveLength(1);
    expect(reopened.topology.mergeFragments('f1', 'f2', 't-merge')).toEqual({ status: 'unchanged' });
    expect(reopened.ledger.placedBlocks().map((record) => record.pos)).toEqual([
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 64, z: 0 },
    ]);
    await reopened.close();
  });

  it('keeps body effects and pending ledger rows when a save fails', async () => {
    const dbPath = makeDbPath();
    // The first save of one row fits; the later delta's full set does not.
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      ledgerLimits: { maxBytes: 600, maxEndpointBytes: 64 },
    });
    session.ledger.putPlaced(DIM, { x: 0, y: 64, z: 0 }, 'minecraft:torch');
    const first = await session.checkpoint();
    const confirmedRevision = session.getPersistenceState().confirmedLedgerRevision;

    for (let x = 1; x <= 10; x += 1) {
      session.ledger.putPlaced(DIM, { x, y: 64, z: 0 }, 'minecraft:cobblestone');
    }
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });

    // The body (in-memory ledger) is not rolled back and the pending rows are not
    // reported as saved.
    expect(session.ledger.placedBlocks()).toHaveLength(11);
    const state = session.getPersistenceState();
    expect(state.dirty).toBe(true);
    expect(state.confirmedLedgerRevision).toBe(confirmedRevision);
    expect(state.ledgerBaselineCheckpointId).toBe(first.checkpointId);
    expect(state.lastConfirmedCheckpointId).toBe(first.checkpointId);
    // The failed rows are still pending for the next attempt, not confirmed.
    expect(session.ledger.captureDelta().placedUpserts).toHaveLength(10);
    await session.close();

    // Nothing from the failed delta reached disk.
    const reopened = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.ledger.placedBlocks().map((record) => record.pos)).toEqual([{ x: 0, y: 64, z: 0 }]);
    await reopened.close();
  });
});
