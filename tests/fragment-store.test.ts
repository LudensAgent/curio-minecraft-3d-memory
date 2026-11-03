import { describe, expect, it } from 'vitest';

import { FragmentStore } from '../src/index.js';
import type { FragmentChanges, PathFragment, TraversalEvidence, Vec3Like } from '../src/index.js';

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

/** A `Vec3Like` whose coordinates live behind prototype getters, not own fields. */
class GetterPoint implements Vec3Like {
  private readonly _x: number;
  private readonly _y: number;
  private readonly _z: number;
  constructor(x: number, y: number, z: number) {
    this._x = x;
    this._y = y;
    this._z = z;
  }
  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }
  get z(): number {
    return this._z;
  }
}

/** A `TraversalEvidence` whose fields are prototype getters, not own fields. */
class GetterTraversalEvidence implements TraversalEvidence {
  private readonly _executionId: string;
  constructor(executionId = 'exec-1') {
    this._executionId = executionId;
  }
  get id(): string {
    return 'ev-get';
  }
  get fragmentId(): string {
    return 'frag-1';
  }
  get from(): Vec3Like {
    return new GetterPoint(0.5, 64, 0.5);
  }
  get to(): Vec3Like {
    return new GetterPoint(1.5, 64, 0.5);
  }
  get worldId(): string {
    return 'world';
  }
  get dim(): string {
    return 'overworld';
  }
  get sessionId(): string | null {
    return 's1';
  }
  get observedAt(): number | null {
    return 1000;
  }
  get source(): string {
    return 'confirmed_walk';
  }
  get executionId(): string {
    return this._executionId;
  }
  get actionId(): string {
    return 'act-1';
  }
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

  it('update failure leaves the original record intact', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ deepestY: 12 }));
    expect(() => store.updateFragment('frag-1', { polyline: [pt(0, 0, NaN)] })).toThrow();
    expect(() => store.updateFragment('frag-1', { uses: -1 })).toThrow();
    const got = store.getFragment('frag-1')!;
    expect(got.deepestY).toBe(12);
    expect(got.uses).toBe(1);
    expect(got.polyline).toEqual([pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)]);
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

  it('preserves execution/action association and re-delivery is idempotent', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    expect(store.addTraversal(evidence({ executionId: 'exec-1', actionId: 'act-1' })).status).toBe('inserted');
    expect(store.addTraversal(evidence({ executionId: 'exec-1', actionId: 'act-1' })).status).toBe('unchanged');
    const got = store.traversals().items[0]!;
    expect(got.executionId).toBe('exec-1');
    expect(got.actionId).toBe('act-1');
  });

  it('treats a changed executionId alone as a conflict', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence({ executionId: 'exec-1', actionId: 'act-1' }));
    expect(() => store.addTraversal(evidence({ executionId: 'exec-2', actionId: 'act-1' }))).toThrow(/different content/);
  });

  it('treats a changed actionId alone as a conflict', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence({ executionId: 'exec-1', actionId: 'act-1' }));
    expect(() => store.addTraversal(evidence({ executionId: 'exec-1', actionId: 'act-2' }))).toThrow(/different content/);
  });

  it('keeps association absent when the caller does not provide it', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(evidence());
    const got = store.traversals().items[0]!;
    expect(got.executionId).toBeUndefined();
    expect(got.actionId).toBeUndefined();
  });

  it('isolates evidence from mutation of the input and of returned snapshots', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    const e = evidence();
    store.addTraversal(e);
    e.from.x = 999;
    e.to.z = 999;
    const got = store.traversals().items[0]!;
    expect(got.from).toEqual(pt(0.5, 64, 0.5));
    expect(got.to).toEqual(pt(1.5, 64, 0.5));
    got.from.x = -1;
    got.to.z = -1;
    expect(store.traversals().items[0]!.from).toEqual(pt(0.5, 64, 0.5));
    expect(store.traversals().items[0]!.to).toEqual(pt(1.5, 64, 0.5));
  });

  it('paginates traversal evidence by id with filters, count, and cursor', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ id: 'f1' }));
    store.saveFragment(fragment({ id: 'f2', dim: 'nether' }));
    store.addTraversal(evidence({ id: 'e-a', fragmentId: 'f1' }));
    store.addTraversal(
      evidence({ id: 'e-b', fragmentId: 'f1', from: pt(1.5, 64, 0.5), to: pt(2.5, 64, 0.5) }),
    );
    store.addTraversal(evidence({ id: 'e-c', fragmentId: 'f2', dim: 'nether' }));

    expect(store.traversals().items.map((e) => e.id)).toEqual(['e-a', 'e-b', 'e-c']);
    expect(store.traversals().total).toBe(3);
    expect(store.traversals({ fragmentId: 'f1' }).items.map((e) => e.id)).toEqual(['e-a', 'e-b']);
    expect(store.traversals({ dim: 'nether' }).items.map((e) => e.id)).toEqual(['e-c']);

    const page1 = store.traversals({ limit: 2 });
    expect(page1.items.map((e) => e.id)).toEqual(['e-a', 'e-b']);
    expect(page1.nextAfter).toBe('e-b');
    const page2 = store.traversals({ limit: 2, after: page1.nextAfter });
    expect(page2.items.map((e) => e.id)).toEqual(['e-c']);
    expect(page2.nextAfter).toBeUndefined();
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

  it('re-delivering existing evidence at capacity stays idempotent, not a capacity error', () => {
    const store = new FragmentStore('world', { maxTraversals: 1 });
    store.saveFragment(fragment());
    store.addTraversal(evidence({ id: 'e1' }));
    expect(store.addTraversal(evidence({ id: 'e1' })).status).toBe('unchanged');
    expect(store.traversals().total).toBe(1);
  });

  it('frees capacity when a fragment and its evidence are deleted', () => {
    const store = new FragmentStore('world', { maxTraversals: 1 });
    store.saveFragment(fragment({ id: 'f1' }));
    store.saveFragment(fragment({ id: 'f2' }));
    store.addTraversal(evidence({ id: 'e1', fragmentId: 'f1' }));
    expect(() =>
      store.addTraversal(evidence({ id: 'e2', fragmentId: 'f2', from: pt(1.5, 64, 0.5), to: pt(2.5, 64, 0.5) })),
    ).toThrow(/capacity/);

    store.forgetFragment('f1');
    expect(store.traversals().total).toBe(0);
    expect(
      store.addTraversal(evidence({ id: 'e2', fragmentId: 'f2', from: pt(1.5, 64, 0.5), to: pt(2.5, 64, 0.5) }))
        .status,
    ).toBe('inserted');
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

describe('FragmentStore — getter-provided inputs', () => {
  it('round-trips getter-provided evidence fields and coordinates', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    expect(store.addTraversal(new GetterTraversalEvidence()).status).toBe('inserted');
    const got = store.traversals().items[0]!;
    expect(got.id).toBe('ev-get');
    expect(got.executionId).toBe('exec-1');
    expect(got.actionId).toBe('act-1');
    expect(got.from).toEqual(pt(0.5, 64, 0.5));
    expect(got.to).toEqual(pt(1.5, 64, 0.5));
  });

  it('detects a conflict when a getter-provided executionId changes', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment());
    store.addTraversal(new GetterTraversalEvidence('exec-1'));
    expect(() => store.addTraversal(new GetterTraversalEvidence('exec-2'))).toThrow(/different content/);
  });

  it('round-trips getter-provided fragment coordinates and links endpoints', () => {
    const store = new FragmentStore('world');
    store.saveFragment(
      fragment({
        polyline: [new GetterPoint(0.5, 64, 0.5), new GetterPoint(1.5, 64, 0.5)],
        entrances: [new GetterPoint(0, 64, 0)],
        links: [{ a: new GetterPoint(0.5, 64, 0.5), b: new GetterPoint(1.5, 64, 0.5) }],
      }),
    );
    const got = store.getFragment('frag-1')!;
    expect(got.polyline).toEqual([pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)]);
    expect(got.entrances).toEqual([pt(0, 64, 0)]);
    expect(got.links).toEqual([{ a: pt(0.5, 64, 0.5), b: pt(1.5, 64, 0.5) }]);
  });
});

describe('FragmentStore — update with getter-provided changes', () => {
  it('applies getter-provided scalar and geometry changes', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ uses: 1, polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)] }));
    class Changes implements FragmentChanges {
      get uses(): number {
        return 7;
      }
      get polyline(): Vec3Like[] {
        return [pt(0, 64, 0), pt(1, 64, 0)];
      }
    }
    expect(store.updateFragment('frag-1', new Changes()).status).toBe('updated');
    const got = store.getFragment('frag-1')!;
    expect(got.uses).toBe(7);
    expect(got.polyline).toEqual([pt(0, 64, 0), pt(1, 64, 0)]);
  });

  it('keeps untouched fields and lets explicit links: undefined clear the links', () => {
    const store = new FragmentStore('world');
    store.saveFragment(
      fragment({ uses: 3, links: [{ a: pt(0.5, 64, 0.5), b: pt(1.5, 64, 0.5) }] }),
    );
    class UsesChange implements FragmentChanges {
      get uses(): number {
        return 9;
      }
    }
    store.updateFragment('frag-1', new UsesChange());
    expect(store.getFragment('frag-1')!.uses).toBe(9);
    expect(store.getFragment('frag-1')!.links).toHaveLength(1);
    // Explicit undefined clears links rather than falling back to the old value.
    expect(store.updateFragment('frag-1', { links: undefined }).status).toBe('updated');
    expect(store.getFragment('frag-1')!.links).toBeUndefined();
  });

  it('rejects invalid coordinates on update and leaves the record intact', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)] }));
    expect(() => store.updateFragment('frag-1', { polyline: [pt(0, 0, NaN)] })).toThrow();
    expect(store.getFragment('frag-1')!.polyline).toEqual([pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)]);
  });

  it('returns unchanged when an update reproduces the current content', () => {
    const store = new FragmentStore('world');
    store.saveFragment(fragment({ uses: 5 }));
    expect(store.updateFragment('frag-1', { uses: 5 }).status).toBe('unchanged');
  });
});
