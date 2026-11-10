import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PathFragment, SpatialNode } from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-store-summary-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function fragment(worldId: string, id: string): PathFragment {
  return {
    id,
    worldId,
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
  };
}

function node(worldId: string, id: string, observedAt?: number): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'program',
    worldId,
    dim: DIM,
    location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } },
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

describe('legacyStoreSummary', () => {
  it('reports zeros and no marker for an empty world opened without history loading', async () => {
    const session = await openSpatialSession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      historyLoading: 'none',
    });
    try {
      expect(session.legacyStoreSummary).toEqual({
        fragments: 0,
        traversals: 0,
        nodes: 0,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await session.close();
    }
  });

  it('recognizes a fragment-only legacy world without decoding it', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    first.history.saveFragment(fragment(WORLD, 'f1'));
    await first.checkpoint();
    await first.close();

    const reopened = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      historyLoading: 'none',
    });
    try {
      // The old fragment is counted from committed metadata, but not loaded.
      expect(reopened.legacyStoreSummary).toEqual({
        fragments: 1,
        traversals: 0,
        nodes: 0,
        edges: 0,
        migrationMarker: false,
      });
      expect(reopened.history.fragments({ limit: 1 }).total).toBe(0);
      expect(reopened.getPersistenceState().baselineCheckpointId).not.toBeNull();
    } finally {
      await reopened.close();
    }
  });

  it('scopes counts to the opened world', async () => {
    const dbPath = makeDbPath();

    const worldA = await openSpatialSession({ databasePath: dbPath, worldId: 'world-a' });
    worldA.history.saveFragment(fragment('world-a', 'a1'));
    worldA.history.saveFragment(fragment('world-a', 'a2'));
    worldA.topology.saveNode(node('world-a', 'a-node'));
    await worldA.checkpoint();
    await worldA.close();

    const worldB = await openSpatialSession({ databasePath: dbPath, worldId: 'world-b' });
    worldB.history.saveFragment(fragment('world-b', 'b1'));
    worldB.topology.saveNode(node('world-b', 'b-node'));
    await worldB.checkpoint();
    await worldB.close();

    const reopenedA = await openSpatialSession({
      databasePath: dbPath,
      worldId: 'world-a',
      historyLoading: 'none',
    });
    try {
      expect(reopenedA.legacyStoreSummary).toEqual({
        fragments: 2,
        traversals: 0,
        nodes: 1,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await reopenedA.close();
    }

    const reopenedB = await openSpatialSession({
      databasePath: dbPath,
      worldId: 'world-b',
      historyLoading: 'none',
    });
    try {
      expect(reopenedB.legacyStoreSummary).toEqual({
        fragments: 1,
        traversals: 0,
        nodes: 1,
        edges: 0,
        migrationMarker: false,
      });
    } finally {
      await reopenedB.close();
    }
  });

  it('reports the old curio:migration marker without treating it as a facts receipt', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    first.topology.saveNode(node(WORLD, 'curio:migration'));
    await first.checkpoint();
    await first.close();

    const reopened = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      historyLoading: 'none',
    });
    try {
      expect(reopened.legacyStoreSummary).toMatchObject({ nodes: 1, migrationMarker: true });
      // The old marker is not the `curio_semantic_migration_v1:<worldId>` receipt.
      expect(reopened.legacyFactsMigrationVersion).toBe(0);
      expect(reopened.factsMigration.committed).toBe(false);
    } finally {
      await reopened.close();
    }
  });

  it('keeps old rows, counts and original times intact across a facts-only save', async () => {
    const dbPath = makeDbPath();
    const first = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    first.history.saveFragment(fragment(WORLD, 'f1'));
    first.topology.saveNode(node(WORLD, 'n1', 1234));
    await first.checkpoint();
    await first.close();

    const none = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      historyLoading: 'none',
    });
    const before = none.legacyStoreSummary;
    expect(none.history.fragments().total).toBe(0);
    none.facts.upsertPlace({
      id: 'base',
      kind: 'base',
      label: 'home',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } },
      observedAt: 5000,
      source: { source: 'agent' },
      gone: false,
    });
    // The preserved history/topology baseline is not replaced by the unloaded
    // (empty) stores; a facts-only checkpoint is still allowed.
    await none.checkpoint();
    await none.close();

    const reopenedNone = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      historyLoading: 'none',
    });
    try {
      expect(reopenedNone.legacyStoreSummary).toEqual(before);
      expect(reopenedNone.facts.places().items.map((fact) => fact.id)).toEqual(['base']);
    } finally {
      await reopenedNone.close();
    }

    const eager = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
    try {
      expect(eager.legacyStoreSummary).toEqual(before);
      expect(eager.history.getFragment('f1')).not.toBeNull();
      expect(eager.topology.getNode('n1')?.observedAt).toBe(1234);
    } finally {
      await eager.close();
    }
  });
});
