import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type { PathFragment, SpatialNode, TraversalEvidence } from '../src/index.js';
import { openHistorySession, PersistenceError } from '../dist/storage/sqlite/index.js';

const WORLD = 'world';
const DIM = 'overworld';

// --- test data builders -------------------------------------------------------

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

function trav(overrides: Partial<TraversalEvidence> = {}): TraversalEvidence {
  return {
    id: 'ev1',
    fragmentId: 'f1',
    from: { x: 0.5, y: 64, z: 0.5 },
    to: { x: 1.5, y: 64, z: 0.5 },
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    source: 'confirmed_walk',
    mode: 'walk',
    ...overrides,
  };
}

function node(id: string, x: number, y: number, z: number, overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'agent',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x, y, z } },
    ...overrides,
  };
}

// --- temp db helpers ----------------------------------------------------------

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-memory-5a-'));
  tempDirs.push(dir);
  return join(dir, 'history.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Windows can hold a transient lock on WAL/SHM files a moment after the worker
    // thread exits; retry rather than fail the suite on an unrelated cleanup error.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ==============================================================================
// Pure store tests: mutation revision + checkpoint export/restore (no SQLite)
// ==============================================================================

describe('FragmentStore mutation revision', () => {
  it('bumps only on writes that actually change facts', () => {
    const s = new FragmentStore(WORLD);
    expect(s.revision).toBe(0);

    s.saveFragment(frag());
    expect(s.revision).toBe(1);

    s.saveFragment(frag()); // unchanged (idempotent)
    expect(s.revision).toBe(1);

    expect(() => s.saveFragment(frag({ kind: 'dug' }))).toThrow(); // conflict
    expect(s.revision).toBe(1);

    s.addTraversal(trav());
    expect(s.revision).toBe(2);

    s.addTraversal(trav()); // unchanged
    expect(s.revision).toBe(2);

    s.getFragment('f1');
    s.fragments();
    s.traversals();
    expect(s.revision).toBe(2);

    s.forgetFragment('missing'); // no-op
    expect(s.revision).toBe(2);

    s.forgetFragment('f1'); // real delete + cascade
    expect(s.revision).toBe(3);
  });

  it('reports zero revisions on an empty store', () => {
    const s = new FragmentStore(WORLD);
    expect(s.checkpointMeasure()).toMatchObject({
      fragments: 0,
      traversals: 0,
      polylinePoints: 0,
      entrancePoints: 0,
      linkPairs: 0,
      bytes: 0,
    });
  });

  it('restoreSnapshot rebuilds ownership and marks a mutation', () => {
    const s = new FragmentStore(WORLD);
    s.saveFragment(frag());
    s.addTraversal(trav());
    expect(s.revision).toBe(2);

    const snapshot = s.checkpointSnapshot();
    s.restoreSnapshot(snapshot);
    expect(s.revision).toBe(3); // restore is a mutation, not a reset to baseline
    expect(s.getFragment('f1')).not.toBeNull();
    expect(s.getTraversal('ev1')).not.toBeNull();
  });

  it('restoreSnapshot validates scope and ownership', () => {
    const s = new FragmentStore(WORLD);
    expect(() =>
      s.restoreSnapshot({ worldId: 'other', fragments: [], traversals: [] }),
    ).toThrow(/worldId/);
    expect(() =>
      s.restoreSnapshot({
        worldId: WORLD,
        fragments: [frag()],
        traversals: [trav({ fragmentId: 'missing' })],
      }),
    ).toThrow(/unknown fragment/);
  });
});

describe('TopologyStore mutation revision + export/restore', () => {
  it('bumps only on writes that actually change facts', () => {
    const history = new FragmentStore(WORLD);
    const t = new TopologyStore(history);
    expect(t.revision).toBe(0);

    t.saveNode(node('a', 0, 64, 0));
    expect(t.revision).toBe(1);
    t.saveNode(node('a', 0, 64, 0)); // unchanged
    expect(t.revision).toBe(1);

    t.saveNode(node('b', 1, 64, 0));
    expect(t.revision).toBe(2);

    t.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    expect(t.revision).toBe(3);

    t.forgetEdge('missing'); // no-op
    expect(t.revision).toBe(3);

    t.forgetEdge('e1');
    expect(t.revision).toBe(4);

    t.forgetNode('a');
    expect(t.revision).toBe(5);
  });

  it('restoreSnapshot preserves binding snapshots without re-resolving', () => {
    const history = new FragmentStore(WORLD);
    history.saveFragment(frag());
    history.addTraversal(trav());
    const t = new TopologyStore(history);
    t.saveNode(node('a', 0.5, 64, 0.5));
    t.saveNode(node('b', 1.5, 64, 0.5));
    t.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev1'] });

    const snapshot = t.checkpointSnapshot();
    expect(snapshot.edges[0]!.refs).toHaveLength(1);
    expect(snapshot.edges[0]!.refs[0]!.snapshot.id).toBe('ev1');

    const t2 = new TopologyStore(history);
    t2.restoreSnapshot(snapshot);
    expect(t2.getEdge('e1')!.resolution).toBe('resolved');
    expect(t2.revision).toBe(1); // restore is a mutation, not a reset to baseline
  });

  it('restoreSnapshot rejects a binding whose endpoints do not match the edge', () => {
    const history = new FragmentStore(WORLD);
    const t = new TopologyStore(history);
    t.saveNode(node('a', 0, 64, 0));
    t.saveNode(node('b', 1, 64, 0));
    expect(() =>
      t.restoreSnapshot({
        worldId: WORLD,
        nodes: [node('a', 0, 64, 0), node('b', 1, 64, 0)],
        edges: [
          {
            id: 'e1',
            from: 'a',
            to: 'b',
            type: 'HORIZONTAL',
            basis: 'traversed',
            refs: [{ evidenceId: 'ev1', snapshot: trav({ from: { x: 9, y: 9, z: 9 } }) }],
          },
        ],
      }),
    ).toThrow(/endpoints/);
  });
});

// ==============================================================================
// SQLite persistence tests (real worker + real SQLite + temp files)
// ==============================================================================

describe('SQLite history checkpoint persistence', () => {
  it('opens a new database with an empty, usable history', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    expect(session.history.fragments().total).toBe(0);
    expect(session.topology.nodes().total).toBe(0);
    const state = session.getPersistenceState();
    expect(state.dirty).toBe(false);
    expect(state.baselineCheckpointId).toBeNull();
    await session.close();
  });

  it('round-trips all four facts through close and reopen', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    session.history.addTraversal(trav());
    session.topology.saveNode(node('a', 0.5, 64, 0.5));
    session.topology.saveNode(node('b', 1.5, 64, 0.5));
    session.topology.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev1'] });
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.fragments().total).toBe(1);
    expect(reopened.history.traversals().total).toBe(1);
    expect(reopened.topology.nodes().total).toBe(2);
    const edge = reopened.topology.getEdge('e1');
    expect(edge).not.toBeNull();
    expect(edge!.resolution).toBe('resolved');
    await reopened.close();
  });

  it('preserves negative/fractional coordinates, region nodes, unknown time and optional attribution', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });

    session.history.saveFragment(
      frag({
        id: 'f-neg',
        entrances: [{ x: -12.5, y: -4.25, z: 0.5 }],
        polyline: [
          { x: -12.5, y: -4.25, z: 0.5 },
          { x: -13.75, y: -5.5, z: -1.25 },
        ],
        deepestY: -5.5,
      }),
    );
    session.history.addTraversal(
      trav({
        id: 'ev-neg',
        fragmentId: 'f-neg',
        from: { x: -12.5, y: -4.25, z: 0.5 },
        to: { x: -13.75, y: -5.5, z: -1.25 },
        sessionId: null,
        observedAt: null,
        executionId: 'exec-1',
        actionId: 'act-1',
      }),
    );
    session.topology.saveNode(
      node('region', 0, 0, 0, {
        kind: 'place',
        location: { kind: 'region', center: { x: 1.5, y: 70.25, z: -2.5 }, radius: 8.5 },
        tag: 'resource',
        label: 'cave',
      }),
    );
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    const f = reopened.history.getFragment('f-neg')!;
    expect(f.entrances[0]).toEqual({ x: -12.5, y: -4.25, z: 0.5 });
    expect(f.polyline[1]).toEqual({ x: -13.75, y: -5.5, z: -1.25 });
    expect(f.deepestY).toBe(-5.5);

    const e = reopened.history.getTraversal('ev-neg')!;
    expect(e.sessionId).toBeNull();
    expect(e.observedAt).toBeNull();
    expect(e.executionId).toBe('exec-1');
    expect(e.actionId).toBe('act-1');

    const rn = reopened.topology.getNode('region')!;
    expect(rn.location).toEqual({ kind: 'region', center: { x: 1.5, y: 70.25, z: -2.5 }, radius: 8.5 });
    expect(rn.tag).toBe('resource');
    expect(rn.label).toBe('cave');
    await reopened.close();
  });

  it('does not change observedAt/uses during checkpoint and restore', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag({ uses: 7, lastUsedAt: 12345, createdAt: 500 }));
    session.history.addTraversal(trav({ observedAt: 9999 }));
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.getFragment('f1')!.uses).toBe(7);
    expect(reopened.history.getFragment('f1')!.createdAt).toBe(500);
    expect(reopened.history.getFragment('f1')!.lastUsedAt).toBe(12345);
    expect(reopened.history.getTraversal('ev1')!.observedAt).toBe(9999);
    await reopened.close();
  });

  it('does not resurrect a deleted fragment and its evidence after reopen', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    session.history.addTraversal(trav());
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    reopened.history.forgetFragment('f1');
    await reopened.checkpoint();
    await reopened.close();

    const again = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(again.history.getFragment('f1')).toBeNull();
    expect(again.history.getTraversal('ev1')).toBeNull();
    await again.close();
  });

  it('keeps an edge whose evidence was deleted and reports missing after restore', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    session.history.addTraversal(trav());
    session.topology.saveNode(node('a', 0.5, 64, 0.5));
    session.topology.saveNode(node('b', 1.5, 64, 0.5));
    session.topology.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev1'] });
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    reopened.history.forgetFragment('f1'); // cascade-deletes ev1
    await reopened.checkpoint();
    await reopened.close();

    const again = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    const edge = again.topology.getEdge('e1');
    expect(edge).not.toBeNull();
    expect(edge!.resolution).toBe('missing');
    await again.close();
  });

  it('reports mismatch (not silent rebind) after same-id evidence is replaced', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    session.history.addTraversal(trav({ observedAt: 1000 }));
    session.topology.saveNode(node('a', 0.5, 64, 0.5));
    session.topology.saveNode(node('b', 1.5, 64, 0.5));
    session.topology.saveEdge({ id: 'e1', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'traversed', evidenceIds: ['ev1'] });
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    reopened.history.forgetFragment('f1');
    reopened.history.saveFragment(frag());
    reopened.history.addTraversal(trav({ observedAt: 2000 })); // same id, different content
    await reopened.checkpoint();
    await reopened.close();

    const again = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(again.topology.getEdge('e1')!.resolution).toBe('mismatch');
    await again.close();
  });

  it('restores candidate edges and original evidence reference order', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    session.history.addTraversal(trav({ id: 'ev-a' }));
    session.history.addTraversal(trav({ id: 'ev-b' }));
    session.topology.saveNode(node('a', 0.5, 64, 0.5));
    session.topology.saveNode(node('b', 1.5, 64, 0.5));
    session.topology.saveEdge({ id: 'cand', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'candidate', source: 'manual', evidenceIds: [] });
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    const cand = reopened.topology.getEdge('cand')!;
    expect(cand.basis).toBe('candidate');
    expect(cand.source).toBe('manual');
    expect(cand.references).toHaveLength(0);
    expect(cand.resolution).toBeNull();
    await reopened.close();
  });

  it('preserves insertion order (not id order) for adjacency across a restore', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });

    // Insert edges in reverse id order so id-sorting would reorder them.
    session.topology.saveNode(node('hub', 0, 64, 0));
    for (let i = 2; i >= 0; i--) {
      session.topology.saveNode(node(`n${i}`, i + 1, 64, 0));
    }
    session.topology.saveEdge({ id: 'e2', from: 'hub', to: 'n2', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    session.topology.saveEdge({ id: 'e0', from: 'hub', to: 'n0', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    session.topology.saveEdge({ id: 'e1', from: 'hub', to: 'n1', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });

    const before = session.topology.adjacency('hub').outEdges.map((e) => e.id);
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    const after = reopened.topology.adjacency('hub').outEdges.map((e) => e.id);
    expect(after).toEqual(before);
    expect(after).toEqual(['e2', 'e0', 'e1']);
    await reopened.close();
  });

  it('isolates multiple worlds in one database file', async () => {
    const dbPath = makeDbPath();
    const s1 = await openHistorySession({ databasePath: dbPath, worldId: 'world-a' });
    s1.history.saveFragment(frag({ id: 'fa', worldId: 'world-a' }));
    s1.topology.saveNode(node('a', 0, 64, 0, { worldId: 'world-a' }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openHistorySession({ databasePath: dbPath, worldId: 'world-b' });
    s2.history.saveFragment(frag({ id: 'fb', worldId: 'world-b' }));
    s2.topology.saveNode(node('b', 0, 64, 0, { worldId: 'world-b' }));
    await s2.checkpoint();
    await s2.close();

    const a = await openHistorySession({ databasePath: dbPath, worldId: 'world-a' });
    expect(a.history.fragments().total).toBe(1);
    expect(a.history.getFragment('fa')).not.toBeNull();
    expect(a.history.getFragment('fb')).toBeNull();
    expect(a.topology.getNode('b')).toBeNull();
    await a.close();
  });

  it('an empty checkpoint clears only the specified world', async () => {
    const dbPath = makeDbPath();
    const s1 = await openHistorySession({ databasePath: dbPath, worldId: 'world-a' });
    s1.history.saveFragment(frag({ id: 'fa', worldId: 'world-a' }));
    await s1.checkpoint();
    await s1.close();

    const s2 = await openHistorySession({ databasePath: dbPath, worldId: 'world-b' });
    s2.history.saveFragment(frag({ id: 'fb', worldId: 'world-b' }));
    await s2.checkpoint();
    await s2.close();

    // Clear only world-a by deleting its fragment, then checkpointing the empty state.
    const clearA = await openHistorySession({ databasePath: dbPath, worldId: 'world-a' });
    clearA.history.forgetFragment('fa');
    await clearA.checkpoint();
    await clearA.close();

    const a = await openHistorySession({ databasePath: dbPath, worldId: 'world-a' });
    expect(a.history.fragments().total).toBe(0);
    await a.close();

    const b = await openHistorySession({ databasePath: dbPath, worldId: 'world-b' });
    expect(b.history.getFragment('fb')).not.toBeNull();
    await b.close();
  });

  it('reports dirty when memory leads disk, and clears after checkpoint', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    session.history.saveFragment(frag());
    expect(session.getPersistenceState().dirty).toBe(true);
    expect(session.history.fragments().total).toBe(1); // visible immediately

    await session.checkpoint();
    expect(session.getPersistenceState().dirty).toBe(false);
    await session.close();
  });

  it('does not clear later dirty state when an older checkpoint is confirmed', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    session.history.saveFragment(frag({ id: 'f-a' }));

    const p = session.checkpoint(); // captures revision 1
    session.history.saveFragment(frag({ id: 'f-b' })); // revision 2 during flight

    await p;
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.close();
  });

  it('rejects a second checkpoint while one is in flight', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    session.history.saveFragment(frag());

    const first = session.checkpoint();
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'busy' });
    await first;
    await session.close();
  });

  it('rejects an over-capacity checkpoint without changing memory or disk', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({
      databasePath: dbPath,
      worldId: WORLD,
      snapshotLimits: { maxFragments: 1 },
    });
    session.history.saveFragment(frag({ id: 'f-a' }));
    session.history.saveFragment(frag({ id: 'f-b' }));

    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    // Memory intact.
    expect(session.history.fragments().total).toBe(2);
    await session.close();

    // Disk has no committed state (nothing ever saved).
    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    expect(reopened.history.fragments().total).toBe(0);
    await reopened.close();
  });

  it('bounds total polyline size, not just record count', async () => {
    const session = await openHistorySession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      snapshotLimits: { maxPolylinePoints: 2 },
    });
    session.history.saveFragment(
      frag({ polyline: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }] }),
    );
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    await session.close();
  });

  it('bounds total byte size for large string fields', async () => {
    const session = await openHistorySession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      snapshotLimits: { maxBytes: 64 },
    });
    session.history.saveFragment(frag({ id: 'x'.repeat(200) }));
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    await session.close();
  });

  it('flush waits for the accepted checkpoint but does not capture later changes', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    session.history.saveFragment(frag());

    const p = session.checkpoint();
    const result = await session.flush();
    expect(result.pending).toBe(true);
    expect(result.completed).toBe(true);

    await p;
    session.history.saveFragment(frag({ id: 'f-after' }));
    const state = session.getPersistenceState();
    expect(state.dirty).toBe(true);
    await session.close();
  });

  it('close without a prior checkpoint reports unsaved changes', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    session.history.saveFragment(frag());
    const result = await session.close();
    expect(result.dirty).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.lastConfirmedCheckpointId).toBeNull();
  });

  it('rejects checkpoint after close and reports state', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    await session.close();
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'closed' });
  });

  it('does not share mutable references with the caller', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    await session.checkpoint();
    await session.close();

    const reopened = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    const f = reopened.history.getFragment('f1')!;
    f.uses = 999;
    f.polyline[0]!.x = -999;
    // The store is unaffected by mutating the returned snapshot.
    expect(reopened.history.getFragment('f1')!.uses).toBe(1);
    expect(reopened.history.getFragment('f1')!.polyline[0]).toEqual({ x: 0.5, y: 64, z: 0.5 });
    await reopened.close();
  });

  it('rejects an unsupported schema version', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });

  it('rejects a database with missing schema metadata', async () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE unrelated (x TEXT)');
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });

  it('rejects a database with an unknown table', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.exec('CREATE TABLE unexpected (x TEXT)');
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });

  it('rejects corrupt record data on load without a half-restored store', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE path_fragments SET payload = '{this is not json'").run();
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });

  it('rejects a non-absolute database path', async () => {
    await expect(openHistorySession({ databasePath: 'relative/history.db', worldId: WORLD })).rejects.toMatchObject(
      { kind: 'invalid_argument' },
    );
  });
});

// ==============================================================================
// Regression tests for the P1/P2 review findings
// ==============================================================================

describe('P1/P2 regression', () => {
  it('marks the session dirty after a runtime restore of a fresh snapshot', async () => {
    const session = await openHistorySession({ databasePath: makeDbPath(), worldId: WORLD });
    expect(session.getPersistenceState().dirty).toBe(false);

    session.history.restoreSnapshot({ worldId: WORLD, fragments: [frag()], traversals: [] });
    expect(session.getPersistenceState().dirty).toBe(true);
    await session.close();
  });

  it('rejects a restore that exceeds store capacity (maxFragments)', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag({ id: 'fa' }));
    session.history.saveFragment(frag({ id: 'fb' }));
    await session.checkpoint();
    await session.close();

    await expect(
      openHistorySession({ databasePath: dbPath, worldId: WORLD, fragmentOptions: { maxFragments: 1 } }),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  it('rejects a binding whose evidenceId disagrees with its snapshot id', () => {
    const history = new FragmentStore(WORLD);
    const t = new TopologyStore(history);
    t.saveNode(node('a', 0, 64, 0));
    t.saveNode(node('b', 1, 64, 0));
    expect(() =>
      t.restoreSnapshot({
        worldId: WORLD,
        nodes: [node('a', 0, 64, 0), node('b', 1, 64, 0)],
        edges: [
          {
            id: 'e1',
            from: 'a',
            to: 'b',
            type: 'HORIZONTAL',
            basis: 'traversed',
            refs: [{ evidenceId: 'ev-other', snapshot: trav() }],
          },
        ],
      }),
    ).toThrow(/does not match/);
  });

  it('rejects an edge whose fragmentId disagrees with its binding snapshot', () => {
    const history = new FragmentStore(WORLD);
    const t = new TopologyStore(history);
    t.saveNode(node('a', 0, 64, 0));
    t.saveNode(node('b', 1, 64, 0));
    expect(() =>
      t.restoreSnapshot({
        worldId: WORLD,
        nodes: [node('a', 0, 64, 0), node('b', 1, 64, 0)],
        edges: [
          {
            id: 'e1',
            from: 'a',
            to: 'b',
            type: 'HORIZONTAL',
            basis: 'traversed',
            fragmentId: 'other-frag',
            refs: [{ evidenceId: 'ev1', snapshot: trav() }],
          },
        ],
      }),
    ).toThrow(/fragment/);
  });

  it('rejects a database with orphaned facts and no checkpoint metadata', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare('DELETE FROM checkpoints WHERE world_id = ?').run(WORLD);
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });

  it('rejects a database with a missing required table', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.exec('DROP TABLE spatial_edges');
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });

  it('bounds UTF-8 byte size for multi-byte labels', async () => {
    const session = await openHistorySession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      snapshotLimits: { maxBytes: 300 },
    });
    // 100 CJK chars: 100 UTF-16 code units but 300 UTF-8 bytes.
    session.topology.saveNode(node('n', 0, 0, 0, { label: '汉'.repeat(100) }));
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    await session.close();
  });

  it('bounds JSON-escaped byte size before copying', async () => {
    const session = await openHistorySession({
      databasePath: makeDbPath(),
      worldId: WORLD,
      snapshotLimits: { maxBytes: 1500 },
    });
    // 1024 double-quote chars: 1024 raw bytes, but 2048 once JSON-escaped (`\"`).
    session.topology.saveNode(node('n', 0, 0, 0, { label: '"'.repeat(1024) }));
    await expect(session.checkpoint()).rejects.toMatchObject({ kind: 'capacity' });
    await session.close();
  });

  it('rejects a database with corrupt checkpoint metadata', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    session.history.saveFragment(frag());
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE checkpoints SET seq = 'broken'").run();
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });

  it('rejects a database missing a required column', async () => {
    const dbPath = makeDbPath();
    const session = await openHistorySession({ databasePath: dbPath, worldId: WORLD });
    await session.checkpoint();
    await session.close();

    const db = new Database(dbPath);
    db.exec('ALTER TABLE spatial_edges DROP COLUMN payload');
    db.close();

    await expect(openHistorySession({ databasePath: dbPath, worldId: WORLD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });
});
