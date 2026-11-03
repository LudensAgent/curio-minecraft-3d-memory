import { describe, expect, it } from 'vitest';

import { FragmentStore } from '../src/index.js';
import type { PathFragment, TraversalEvidence, Vec3Like } from '../src/index.js';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function fragment(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'frag-1',
    worldId: 'world',
    dim: 'overworld',
    kind: 'walked',
    entrances: [pt(0, 64, 0)],
    polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)],
    geometrySource: 'traversal',
    deepestY: 12,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

function evidence(overrides: Partial<TraversalEvidence> = {}): TraversalEvidence {
  return {
    id: 'ev-1',
    fragmentId: 'frag-1',
    from: pt(0.5, 64, 0.5),
    to: pt(1.5, 64, 0.5),
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    source: 'confirmed_walk',
    ...overrides,
  };
}

describe('FragmentStore — historical geometry', () => {
  it('preserves negative, fractional and multi-height coordinates verbatim', () => {
    const store = new FragmentStore('world');
    const f = fragment({
      id: 'frag-neg',
      entrances: [pt(-3.5, -20, 0)],
      polyline: [pt(-3.5, -20, 0.25), pt(-2.25, -21, 0.5), pt(-1.5, -20, 0.75)],
      deepestY: -30,
    });
    expect(store.saveFragment(f).status).toBe('inserted');
    const got = store.getFragment('frag-neg')!;
    expect(got.polyline).toEqual([
      pt(-3.5, -20, 0.25),
      pt(-2.25, -21, 0.5),
      pt(-1.5, -20, 0.75),
    ]);
    expect(got.entrances).toEqual([pt(-3.5, -20, 0)]);
    expect(got.deepestY).toBe(-30);
  });

  it('isolates worlds and dimensions', () => {
    const a = new FragmentStore('world-a');
    const b = new FragmentStore('world-b');
    a.saveFragment(fragment({ id: 'f1', worldId: 'world-a' }));
    // Same id in a different world scope is a separate record, not a merge.
    expect(b.saveFragment(fragment({ id: 'f1', worldId: 'world-b' })).status).toBe('inserted');
    expect(a.getFragment('f1')!.worldId).toBe('world-a');
    expect(b.getFragment('f1')!.worldId).toBe('world-b');
  });

  it('rejects a fragment whose worldId does not match the store scope', () => {
    const store = new FragmentStore('world');
    expect(() => store.saveFragment(fragment({ worldId: 'other' }))).toThrow(/worldId/);
    expect(store.fragments().total).toBe(0);
  });

  it('rejects the same id across different dimensions within one scope', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'f1', dim: 'overworld' }));
    expect(() => store.saveFragment(fragment({ id: 'f1', dim: 'nether' }))).toThrow(/different content/);
  });

  it('isolates the store from later mutation of the input', () => {
    const store = new FragmentStore('world');
    const f = fragment({
      polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)],
      links: [{ a: pt(0.5, 64, 0.5), b: pt(1.5, 64, 0.5) }],
    });
    store.saveFragment(f);
    f.polyline[0]!.x = 999;
    f.entrances.push(pt(50, 50, 50));
    f.links![0]!.a.x = 999;
    const got = store.getFragment('frag-1')!;
    expect(got.polyline[0]!.x).toBe(0.5);
    expect(got.entrances.length).toBe(1);
    expect(got.links![0]!.a.x).toBe(0.5);
  });

  it('isolates the input from later mutation of the store (read snapshot is a copy)', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)] }));
    const got = store.getFragment('frag-1')!;
    got.polyline[0]!.x = 999;
    got.polyline.push(pt(9, 9, 9));
    expect(store.getFragment('frag-1')!.polyline).toEqual([pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)]);
  });
});

describe('FragmentStore — write semantics', () => {
  it('distinguishes insert, idempotent re-delivery, explicit update, and conflict', () => {
    const store = new FragmentStore('world');
    expect(store.saveFragment(fragment()).status).toBe('inserted');
    // Re-delivery of identical content is a no-op and does not bump uses.
    expect(store.saveFragment(fragment()).status).toBe('unchanged');
    expect(store.getFragment('frag-1')!.uses).toBe(1);

    // Conflict: same id, different content.
    expect(() => store.saveFragment(fragment({ deepestY: 99 }))).toThrow(/different content/);

    // Explicit update changes only what is provided, preserving createdAt/uses.
    store.updateFragment('frag-1', { deepestY: 99, uses: 7 });
    const updated = store.getFragment('frag-1')!;
    expect(updated.deepestY).toBe(99);
    expect(updated.uses).toBe(7);
    expect(updated.createdAt).toBe(1000);
  });

  it('update preserves createdAt and identity', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ createdAt: 1234 }));
    store.updateFragment('frag-1', { polyline: [pt(0, 0, 0), pt(1, 0, 0)] });
    const got = store.getFragment('frag-1')!;
    expect(got.createdAt).toBe(1234);
    expect(got.id).toBe('frag-1');
    expect(got.worldId).toBe('world');
    expect(got.dim).toBe('overworld');
  });

  it('update of an unknown id throws and leaves state intact', () => {
    const store = new FragmentStore('world');
    expect(() => store.updateFragment('nope', { uses: 5 })).toThrow(/unknown fragment/);
    expect(store.fragments().total).toBe(0);
  });

  it('validation failure leaves no half-written state', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'ok' }));
    expect(() => store.saveFragment(fragment({ id: 'bad', polyline: [pt(0, 0, NaN)] }))).toThrow();
    expect(() => store.saveFragment(fragment({ id: 'bad', uses: -1 }))).toThrow();
    expect(store.fragments().total).toBe(1);
    expect(store.getFragment('bad')).toBeNull();
  });
});

describe('FragmentStore — traversal evidence', () => {
  it('records a directional relation; A→B does not imply B→A or A→C', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence());
    const got = store.traversals({ fragmentId: 'frag-1' });
    expect(got.total).toBe(1);
    expect(got.items[0]!.from).toEqual(pt(0.5, 64, 0.5));
    expect(got.items[0]!.to).toEqual(pt(1.5, 64, 0.5));
    // There is exactly one directional record; nothing was auto-generated.
    expect(store.traversals({ dim: 'overworld' }).items.map((e) => [e.from, e.to])).toEqual([
      [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)],
    ]);
  });

  it('is idempotent on re-delivery and keeps distinct real traversals separate', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    expect(store.addTraversal(evidence()).status).toBe('inserted');
    // Same id + content → no-op.
    expect(store.addTraversal(evidence()).status).toBe('unchanged');
    // Same coordinates, different id/session/time → a distinct traversal, not a dedup.
    expect(
      store.addTraversal(evidence({ id: 'ev-2', sessionId: 's2', observedAt: 2000 })).status,
    ).toBe('inserted');
    expect(store.traversals({ fragmentId: 'frag-1' }).total).toBe(2);
  });

  it('conflicts on same id with different content', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence());
    expect(() => store.addTraversal(evidence({ to: pt(9, 64, 9) }))).toThrow(/different content/);
    expect(store.traversals().total).toBe(1);
  });

  it('requires the referenced fragment to exist and match world/dim', () => {
    const store = new FragmentStore('world');
    expect(() => store.addTraversal(evidence())).toThrow(/unknown fragment/);
    store.saveFragment(fragment());
    expect(() => store.addTraversal(evidence({ dim: 'nether' }))).toThrow(/does not match/);
    expect(store.traversals().total).toBe(0);
  });

  it('does not auto-generate traversal from observed/bridge/built/legacy geometry', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'obs', kind: 'built', geometrySource: 'observed_structure' }));
    store.saveFragment(fragment({ id: 'bridge', kind: 'bridge', geometrySource: 'observed_structure' }));
    store.saveFragment(fragment({ id: 'legacy', kind: 'walked', geometrySource: 'legacy' }));
    expect(store.traversals().total).toBe(0);
  });

  it('does not auto-connect polyline points or gaps into traversal records', () => {
    const store = new FragmentStore('world');
    // A polyline with a large gap (simulating a disconnect / teleport) yields no evidence.
    store.saveFragment(fragment({ polyline: [pt(0, 64, 0), pt(1000, 64, 1000)] }));
    expect(store.traversals().total).toBe(0);
  });
});

describe('FragmentStore — read-only queries', () => {
  it('queries never change time, uses, or content', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence());
    const before = store.getFragment('frag-1')!;
    store.fragments({ dim: 'overworld' });
    store.getFragment('frag-1');
    store.traversals({ fragmentId: 'frag-1' });
    const after = store.getFragment('frag-1')!;
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
    expect(after.uses).toBe(before.uses);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.polyline).toEqual(before.polyline);
  });

  it('paginates with stable id order, filters, counts, and boundaries', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'c', dim: 'overworld' }));
    store.saveFragment(fragment({ id: 'a', dim: 'overworld' }));
    store.saveFragment(fragment({ id: 'b', dim: 'nether' }));
    store.saveFragment(fragment({ id: 'd', dim: 'overworld', geometrySource: 'legacy' }));

    // Stable id sort + dim filter.
    const overworld = store.fragments({ dim: 'overworld' });
    expect(overworld.items.map((f) => f.id)).toEqual(['a', 'c', 'd']);
    expect(overworld.total).toBe(3);
    expect(overworld.nextAfter).toBeUndefined();

    // source filter.
    expect(store.fragments({ source: 'legacy' }).items.map((f) => f.id)).toEqual(['d']);

    // limit + cursor paging.
    const page1 = store.fragments({ dim: 'overworld', limit: 2 });
    expect(page1.items.map((f) => f.id)).toEqual(['a', 'c']);
    expect(page1.nextAfter).toBe('c');
    const page2 = store.fragments({ dim: 'overworld', limit: 2, after: page1.nextAfter });
    expect(page2.items.map((f) => f.id)).toEqual(['d']);
    expect(page2.nextAfter).toBeUndefined();

    // Empty result.
    const empty = store.fragments({ dim: 'end' });
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.nextAfter).toBeUndefined();
  });

  it('clamps the query limit to maxQueryBatch', () => {
    const store = new FragmentStore('world', { maxQueryBatch: 2 });
    for (const id of ['a', 'b', 'c']) store.saveFragment(fragment({ id }));
    const page = store.fragments({ limit: 50 });
    expect(page.items.length).toBe(2);
    expect(page.nextAfter).toBe('b');
  });
});

describe('FragmentStore — deletion', () => {
  it('deletes a fragment and its own evidence, leaving others intact', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'keep' }));
    store.saveFragment(fragment({ id: 'drop' }));
    store.addTraversal(evidence({ id: 'ev-drop', fragmentId: 'drop' }));
    store.addTraversal(evidence({ id: 'ev-keep', fragmentId: 'keep' }));

    store.forgetFragment('drop');

    expect(store.getFragment('drop')).toBeNull();
    expect(store.getFragment('keep')).not.toBeNull();
    expect(store.traversals({ fragmentId: 'drop' }).total).toBe(0);
    expect(store.traversals({ fragmentId: 'keep' }).total).toBe(1);
  });

  it('deleting an unknown id is a stable no-op', () => {
    const store = new FragmentStore('world');
    expect(() => store.forgetFragment('nope')).not.toThrow();
    expect(() => store.forgetFragment('nope')).not.toThrow();
    expect(store.fragments().total).toBe(0);
  });
});

describe('FragmentStore — capacity', () => {
  it('rejects writes over capacity without dropping history or evicting', () => {
    const store = new FragmentStore('world', { maxFragments: 2 });
    store.saveFragment(fragment({ id: 'a' }));
    store.saveFragment(fragment({ id: 'b' }));
    expect(() => store.saveFragment(fragment({ id: 'c' }))).toThrow(/capacity/);
    // Existing records remain intact.
    expect(store.fragments().total).toBe(2);
    expect(store.getFragment('a')).not.toBeNull();
    expect(store.getFragment('b')).not.toBeNull();
    expect(store.getFragment('c')).toBeNull();
  });

  it('rejects oversized fragment geometry without partial writes', () => {
    const store = new FragmentStore('world', { maxPolylinePoints: 2 });
    store.saveFragment(fragment({ id: 'ok' }));
    expect(() =>
      store.saveFragment(fragment({ id: 'big', polyline: [pt(0, 0, 0), pt(1, 0, 0), pt(2, 0, 0)] })),
    ).toThrow(/polyline/);
    expect(store.getFragment('big')).toBeNull();
  });

  it('rejects traversal evidence over capacity', () => {
    const store = new FragmentStore('world', { maxTraversals: 1 });
    store.saveFragment(fragment());
    store.addTraversal(evidence({ id: 'e1' }));
    expect(() => store.addTraversal(evidence({ id: 'e2', from: pt(1.5, 64, 0.5), to: pt(2.5, 64, 0.5) }))).toThrow(
      /capacity/,
    );
    expect(store.traversals().total).toBe(1);
  });
});

describe('FragmentStore — history vs current state separation', () => {
  it('does not expose or mutate traversability state and keeps history under external blockage', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence());
    // No traversability method exists, and history stays queryable regardless of
    // anything a separate VoxelMap does (blockage, staleness, session switch).
    expect(store.getFragment('frag-1')).not.toBeNull();
    expect(store.traversals().total).toBe(1);
    expect(store.fragments({ dim: 'overworld' }).total).toBe(1);
  });

  it('preserves legacy fields and missing provenance without fabricating time or ownership', () => {
    const store = new FragmentStore('world');
    // A legacy fragment with zeroed time and no links: stored as-is, no session/execution added.
    const legacy = fragment({
      id: 'legacy',
      kind: 'walked',
      geometrySource: 'legacy',
      createdAt: 0,
      lastUsedAt: 0,
      uses: 0,
      links: undefined,
    });
    store.saveFragment(legacy);
    const got = store.getFragment('legacy')!;
    expect(got.createdAt).toBe(0);
    expect(got.lastUsedAt).toBe(0);
    expect(got.uses).toBe(0);
    expect(got.links).toBeUndefined();
    expect(got.geometrySource).toBe('legacy');
    // No auto traversal evidence was manufactured from the legacy geometry.
    expect(store.traversals().total).toBe(0);
  });

  it('preserves explicit usage metadata supplied by the caller', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ lastUsedAt: 4321, uses: 11 }));
    expect(store.getFragment('frag-1')!.lastUsedAt).toBe(4321);
    expect(store.getFragment('frag-1')!.uses).toBe(11);
  });
});
