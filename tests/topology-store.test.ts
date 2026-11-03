import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type {
  EdgeView,
  PathFragment,
  SpatialNode,
  TopologyEdge,
  TopologyHistorySource,
  TraversalEvidence,
  Vec3Like,
} from '../src/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const POS_A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
const POS_B: Vec3Like = { x: 1.5, y: 64, z: 0.5 };

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function node(overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id: 'n-a',
    kind: 'place',
    source: 'agent',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { ...POS_A } },
    ...overrides,
  };
}

function fragment(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'frag-1',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [pt(0.5, 64, 0.5)],
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
    from: { ...POS_A },
    to: { ...POS_B },
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    source: 'confirmed_walk',
    ...overrides,
  };
}

/** A history source with no fragments or evidence — enough for node-only tests. */
function stubHistory(): TopologyHistorySource {
  return { worldId: WORLD, getFragment: () => null, getTraversal: () => null };
}

/** A real history with one fragment and one A→B traversal, plus A/B nodes. */
function setup() {
  const history = new FragmentStore(WORLD);
  history.saveFragment(fragment());
  history.addTraversal(evidence());
  const store = new TopologyStore(history);
  store.saveNode(node({ id: 'a' }));
  store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
  return { history, store };
}

function traversedEdge(overrides: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    id: 'e-ab',
    from: 'a',
    to: 'b',
    type: 'HORIZONTAL',
    basis: 'traversed',
    evidenceIds: ['ev-1'],
    ...overrides,
  };
}

function candidateEdge(overrides: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    id: 'e-ab',
    from: 'a',
    to: 'b',
    type: 'HORIZONTAL',
    basis: 'candidate',
    source: 'manual',
    evidenceIds: [],
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

/** A `SpatialNode` whose fields are prototype getters. */
class GetterNode implements SpatialNode {
  get id(): string {
    return 'g';
  }
  get kind(): SpatialNode['kind'] {
    return 'place';
  }
  get source(): SpatialNode['source'] {
    return 'agent';
  }
  get worldId(): string {
    return WORLD;
  }
  get dim(): string {
    return DIM;
  }
  get location(): SpatialNode['location'] {
    return { kind: 'exact', pos: new GetterPoint(2.5, 64, 0.5) };
  }
}

describe('TopologyStore — nodes', () => {
  it('saves, reads, updates, is idempotent, conflicts, and deletes', () => {
    const store = new TopologyStore(stubHistory());
    expect(store.saveNode(node()).status).toBe('inserted');
    expect(store.saveNode(node()).status).toBe('unchanged');
    expect(() => store.saveNode(node({ kind: 'branch' }))).toThrow(/different content/);

    expect(store.updateNode('n-a', { kind: 'branch', label: 'mine' }).status).toBe('updated');
    const got = store.getNode('n-a')!;
    expect(got.kind).toBe('branch');
    expect(got.label).toBe('mine');
    expect(got.id).toBe('n-a');
    expect(got.worldId).toBe(WORLD);
    expect(got.dim).toBe(DIM);
    expect(got.source).toBe('agent');

    store.forgetNode('n-a');
    expect(store.getNode('n-a')).toBeNull();
    // deleting an unknown id is a stable no-op
    expect(() => store.forgetNode('n-a')).not.toThrow();
  });

  it('preserves negative, fractional and multi-height coordinates; region radius verbatim', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ id: 'exact', location: { kind: 'exact', pos: pt(-3.5, -20, 0.25) } }));
    store.saveNode(node({ id: 'region', location: { kind: 'region', center: pt(-1.25, 12.5, 0.5), radius: 7.5 } }));

    const e = store.getNode('exact')!;
    expect(e.location).toEqual({ kind: 'exact', pos: pt(-3.5, -20, 0.25) });
    const r = store.getNode('region')!;
    expect(r.location).toEqual({ kind: 'region', center: pt(-1.25, 12.5, 0.5), radius: 7.5 });
  });

  it('does not merge same-coordinate nodes and isolates worlds and dimensions', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ id: 'a', location: { kind: 'exact', pos: pt(1, 2, 3) } }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: pt(1, 2, 3) }, source: 'program' }));
    expect(store.nodes().total).toBe(2);

    expect(() => store.saveNode(node({ id: 'a', worldId: 'other' }))).toThrow(/worldId/);
    expect(() => store.saveNode(node({ id: 'a', dim: 'nether' }))).toThrow(/different content/);
    expect(store.nodes().total).toBe(2);
  });

  it('enforces separate agent/program quotas without evicting existing nodes', () => {
    const store = new TopologyStore(stubHistory(), { maxAgentNodes: 1, maxProgramNodes: 2 });
    store.saveNode(node({ id: 'a1' }));
    store.saveNode(node({ id: 'p1', source: 'program' }));
    store.saveNode(node({ id: 'p2', source: 'program' }));

    expect(() => store.saveNode(node({ id: 'a2' }))).toThrow(/agent/);
    expect(() => store.saveNode(node({ id: 'p3', source: 'program' }))).toThrow(/program/);
    expect(store.nodes({ source: 'agent' }).total).toBe(1);
    expect(store.nodes({ source: 'program' }).total).toBe(2);
    expect(store.getNode('a1')).not.toBeNull();
  });

  it('filters nodes by dim, source and tag and paginates by stable id', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ id: 'c', tag: 'base' }));
    store.saveNode(node({ id: 'a', source: 'program', tag: 'resource' }));
    store.saveNode(node({ id: 'b', dim: 'nether' }));

    expect(store.nodes({ dim: DIM }).items.map((n) => n.id)).toEqual(['a', 'c']);
    expect(store.nodes({ source: 'program' }).items.map((n) => n.id)).toEqual(['a']);
    expect(store.nodes({ tag: 'base' }).items.map((n) => n.id)).toEqual(['c']);

    const page1 = store.nodes({ dim: DIM, limit: 1 });
    expect(page1.items.map((n) => n.id)).toEqual(['a']);
    expect(page1.nextAfter).toBe('a');
    expect(page1.total).toBe(2);
    const page2 = store.nodes({ dim: DIM, limit: 1, after: page1.nextAfter });
    expect(page2.items.map((n) => n.id)).toEqual(['c']);
    expect(page2.nextAfter).toBeUndefined();
    expect(store.nodes({ dim: 'end' }).items).toEqual([]);
  });
});

describe('TopologyStore — candidate edges', () => {
  it('keeps a candidate edge as a candidate, not a traversed fact', () => {
    const { store } = setup();
    expect(store.saveEdge(candidateEdge()).status).toBe('inserted');
    const view = store.getEdge('e-ab')!;
    expect(view.basis).toBe('candidate');
    expect(view.evidenceIds).toEqual([]);
    expect(view.references).toEqual([]);
    expect(view.resolution).toBeNull();
  });

  it('rejects candidate edges that cite evidence', () => {
    const { store } = setup();
    expect(() => store.saveEdge(candidateEdge({ evidenceIds: ['ev-1'] }))).toThrow(/candidate/);
    expect(store.edges().total).toBe(0);
  });
});

describe('TopologyStore — traversed edges', () => {
  it('builds a directed A→B edge from matching evidence and rejects the reverse', () => {
    const { store } = setup();
    expect(store.saveEdge(traversedEdge()).status).toBe('inserted');
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');
    // Reversed use of the same A→B evidence must fail.
    expect(() =>
      store.saveEdge(traversedEdge({ id: 'e-ba', from: 'b', to: 'a' })),
    ).toThrow(/endpoints do not match/);
  });

  it('records a reverse B→A edge from a separate B→A evidence record', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    history.addTraversal(evidence({ id: 'ev-2', from: { ...POS_B }, to: { ...POS_A } }));
    expect(
      store.saveEdge(traversedEdge({ id: 'e-ba', from: 'b', to: 'a', evidenceIds: ['ev-2'] })).status,
    ).toBe('inserted');
    expect(store.getEdge('e-ba')!.resolution).toBe('resolved');
    expect(store.edges().total).toBe(2);
  });

  it('does not treat fragment existence, geometry proximity, or polyline continuity as evidence', () => {
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment({ polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)] }));
    const store = new TopologyStore(history);
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));

    // No traversal was ever recorded; a traversed edge has no evidence to cite.
    expect(() => store.saveEdge(traversedEdge())).toThrow(/unknown traversal evidence/);
    // An empty reference list is also rejected.
    expect(() => store.saveEdge(traversedEdge({ evidenceIds: [] }))).toThrow(/at least one/);
    expect(store.edges().total).toBe(0);
  });

  it('rejects missing nodes, region endpoints, cross-world, cross-dimension, and PORTAL', () => {
    const { store } = setup();
    expect(() => store.saveEdge(traversedEdge({ from: 'ghost' }))).toThrow(/unknown node/);

    const region = new TopologyStore(stubHistory());
    region.saveNode(node({ id: 'r', location: { kind: 'region', center: pt(0, 64, 0), radius: 2 } }));
    region.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
    expect(() => region.saveEdge(traversedEdge({ from: 'r', to: 'b' }))).toThrow(/exact/);

    expect(() => store.saveEdge(traversedEdge({ type: 'PORTAL' }))).toThrow(/PORTAL/);

    const nether = new TopologyStore(stubHistory());
    nether.saveNode(node({ id: 'a', dim: DIM }));
    nether.saveNode(node({ id: 'b', dim: 'nether', location: { kind: 'exact', pos: { ...POS_B } } }));
    expect(() => nether.saveEdge(traversedEdge())).toThrow(/dimensions/);
  });

  it('fails atomically on evidence endpoint, direction, fragment, and scope mismatch', () => {
    const { history, store } = setup();
    // Wrong direction in the evidence itself (from=B, to=A) vs the A→B edge.
    history.addTraversal(evidence({ id: 'ev-x', from: { ...POS_B }, to: { ...POS_A } }));
    expect(() => store.saveEdge(traversedEdge({ evidenceIds: ['ev-x'] }))).toThrow(/endpoints/);
    // Cross-dimension evidence (validly stored in its own nether fragment) vs an overworld edge.
    history.saveFragment(fragment({ id: 'frag-nether', dim: 'nether' }));
    history.addTraversal(evidence({ id: 'ev-nether', fragmentId: 'frag-nether', dim: 'nether' }));
    expect(() => store.saveEdge(traversedEdge({ evidenceIds: ['ev-nether'] }))).toThrow(/dim/);
    // Wrong fragment association on the edge.
    expect(() => store.saveEdge(traversedEdge({ fragmentId: 'other' }))).toThrow(/fragmentId/);
    expect(store.edges().total).toBe(0);
  });

  it('validates evidence references even when the fragmentId exists but differs', () => {
    const { history, store } = setup();
    history.saveFragment(fragment({ id: 'frag-2' }));
    expect(() => store.saveEdge(traversedEdge({ fragmentId: 'frag-2' }))).toThrow(/fragmentId/);
    expect(store.edges().total).toBe(0);
  });
});

describe('TopologyStore — mode handling', () => {
  it('keeps absent mode unknown and does not infer it from source or type', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    const ref = store.getEdge('e-ab')!.references[0]!;
    expect(ref.snapshot!.mode).toBeUndefined();
    expect(ref.current!.mode).toBeUndefined();
  });

  it('preserves a known mode and treats a changed mode as a conflict', () => {
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment());
    history.addTraversal(evidence({ mode: 'walk' }));
    expect(history.addTraversal(evidence({ mode: 'walk' })).status).toBe('unchanged');
    expect(() => history.addTraversal(evidence({ mode: 'swim' }))).toThrow(/different content/);

    const store = new TopologyStore(history);
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
    store.saveEdge(traversedEdge());
    expect(store.getEdge('e-ab')!.references[0]!.current!.mode).toBe('walk');
  });
});

describe('TopologyStore — reference resolution across deletion', () => {
  it('reports missing after the source fragment is deleted, but keeps the edge record', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');

    history.forgetFragment('frag-1');
    const view = store.getEdge('e-ab')!;
    expect(view.basis).toBe('traversed');
    expect(view.resolution).toBe('missing');
    expect(view.references[0]!.status).toBe('missing');
    expect(view.references[0]!.current).toBeNull();
    // The binding snapshot survives as a historical summary.
    expect(view.references[0]!.snapshot).not.toBeNull();
    expect(store.edges().total).toBe(1);
  });

  it('does not restore binding from same-id-different-content; identical re-import restores', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());

    history.forgetFragment('frag-1');
    expect(store.getEdge('e-ab')!.resolution).toBe('missing');

    // Re-import a same-id traversal with different content: mismatch, not resolved.
    history.saveFragment(fragment());
    history.addTraversal(evidence({ to: pt(9, 64, 9) }));
    expect(store.getEdge('e-ab')!.resolution).toBe('mismatch');
    expect(store.getEdge('e-ab')!.references[0]!.status).toBe('mismatch');

    // Identical re-import restores resolution.
    history.forgetFragment('frag-1');
    history.saveFragment(fragment());
    history.addTraversal(evidence());
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');
  });
});

describe('TopologyStore — node deletion/location guards', () => {
  it('refuses to change a referenced node location or delete a referenced node; allows after edge removal', () => {
    const { store } = setup();
    store.saveEdge(traversedEdge());

    expect(() => store.updateNode('a', { location: { kind: 'exact', pos: pt(5, 64, 5) } })).toThrow(
      /referenced by an edge/,
    );
    expect(() => store.forgetNode('a')).toThrow(/referenced by/);

    // A same-value location update stays idempotent, not a rejection.
    expect(store.updateNode('a', { location: { kind: 'exact', pos: { ...POS_A } } }).status).toBe(
      'unchanged',
    );

    store.forgetEdge('e-ab');
    expect(store.updateNode('a', { location: { kind: 'exact', pos: pt(5, 64, 5) } }).status).toBe(
      'updated',
    );
    store.forgetNode('a');
    expect(store.getNode('a')).toBeNull();
  });

  it('deleting an edge never deletes the fragment or traversal evidence', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    store.forgetEdge('e-ab');
    expect(store.edges().total).toBe(0);
    expect(history.getFragment('frag-1')).not.toBeNull();
    expect(history.getTraversal('ev-1')).not.toBeNull();
  });

  it('a failed reference change leaves the old edge and indices intact', () => {
    const { store } = setup();
    store.saveEdge(traversedEdge());
    expect(() => store.updateEdge('e-ab', { basis: 'traversed', evidenceIds: ['ghost'] })).toThrow(
      /unknown traversal evidence/,
    );
    const view = store.getEdge('e-ab')!;
    expect(view.evidenceIds).toEqual(['ev-1']);
    expect(view.resolution).toBe('resolved');
    // Node index still tracks the edge, so location change is still blocked.
    expect(() => store.updateNode('a', { location: { kind: 'exact', pos: pt(5, 64, 5) } })).toThrow(
      /referenced by an edge/,
    );
  });

  it('converts a candidate edge to a traversed edge by re-running validation', () => {
    const { store } = setup();
    store.saveEdge(candidateEdge());
    expect(store.getEdge('e-ab')!.basis).toBe('candidate');
    expect(store.updateEdge('e-ab', { basis: 'traversed', evidenceIds: ['ev-1'] }).status).toBe(
      'updated',
    );
    expect(store.getEdge('e-ab')!.basis).toBe('traversed');
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');
  });
});

describe('TopologyStore — snapshot isolation', () => {
  it('isolates node input and returned snapshots from mutation', () => {
    const store = new TopologyStore(stubHistory());
    const n = node({ location: { kind: 'exact', pos: pt(0.5, 64, 0.5) } });
    store.saveNode(n);
    n.location = { kind: 'exact', pos: pt(999, 999, 999) };
    expect(store.getNode('n-a')!.location).toEqual({ kind: 'exact', pos: pt(0.5, 64, 0.5) });

    const got = store.getNode('n-a')!;
    (got.location as { pos: Vec3Like }).pos.x = 999;
    expect(store.getNode('n-a')!.location).toEqual({ kind: 'exact', pos: pt(0.5, 64, 0.5) });
  });

  it('isolates edge evidence references from mutation of input and view', () => {
    const { store } = setup();
    const e = traversedEdge();
    store.saveEdge(e);
    e.evidenceIds.push('other');
    expect(store.getEdge('e-ab')!.evidenceIds).toEqual(['ev-1']);

    const view = store.getEdge('e-ab')!;
    view.references[0]!.snapshot!.from.x = 999;
    view.evidenceIds.push('other');
    expect(store.getEdge('e-ab')!.evidenceIds).toEqual(['ev-1']);
    expect(store.getEdge('e-ab')!.references[0]!.snapshot!.from.x).toBe(0.5);
  });
});

describe('TopologyStore — getter-provided inputs', () => {
  it('round-trips getter-provided node fields and coordinates', () => {
    const store = new TopologyStore(stubHistory());
    expect(store.saveNode(new GetterNode()).status).toBe('inserted');
    const got = store.getNode('g')!;
    expect(got.id).toBe('g');
    expect(got.location).toEqual({ kind: 'exact', pos: pt(2.5, 64, 0.5) });
  });

  it('rejects a getter-provided node with a non-finite coordinate atomically', () => {
    const store = new TopologyStore(stubHistory());
    class BadNode implements SpatialNode {
      get id(): string {
        return 'bad';
      }
      get kind(): SpatialNode['kind'] {
        return 'place';
      }
      get source(): SpatialNode['source'] {
        return 'agent';
      }
      get worldId(): string {
        return WORLD;
      }
      get dim(): string {
        return DIM;
      }
      get location(): SpatialNode['location'] {
        return { kind: 'exact', pos: { x: NaN, y: 64, z: 0.5 } };
      }
    }
    expect(() => store.saveNode(new BadNode())).toThrow(/finite/);
    expect(store.nodes().total).toBe(0);
  });

  it('applies getter-provided node changes by presence', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ label: 'old' }));
    class Changes {
      get label(): string {
        return 'new';
      }
    }
    expect(store.updateNode('n-a', new Changes()).status).toBe('updated');
    expect(store.getNode('n-a')!.label).toBe('new');
  });
});

describe('TopologyStore — capacity and pagination boundaries', () => {
  it('idempotent re-delivery at capacity is not a capacity error; deletion frees quota', () => {
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment());
    history.addTraversal(evidence());
    const bounded = new TopologyStore(history, { maxEdges: 1 });
    bounded.saveNode(node({ id: 'a' }));
    bounded.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
    expect(bounded.saveEdge(traversedEdge()).status).toBe('inserted');
    expect(bounded.saveEdge(traversedEdge()).status).toBe('unchanged');
    expect(() => bounded.saveEdge(traversedEdge({ id: 'e2' }))).toThrow(/capacity/);

    bounded.forgetEdge('e-ab');
    expect(bounded.saveEdge(traversedEdge({ id: 'e2' })).status).toBe('inserted');
  });

  it('clamps the query limit and returns empty/tail pages correctly', () => {
    const store = new TopologyStore(stubHistory(), { maxQueryBatch: 2 });
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: pt(2, 64, 0.5) } }));
    store.saveNode(node({ id: 'c', location: { kind: 'exact', pos: pt(3, 64, 0.5) } }));
    const page = store.nodes({ limit: 50 });
    expect(page.items.length).toBe(2);
    expect(page.nextAfter).toBe('b');
    const tail = store.nodes({ limit: 2, after: page.nextAfter });
    expect(tail.items.map((n) => n.id)).toEqual(['c']);
    expect(tail.nextAfter).toBeUndefined();
    // Cursor beyond the end yields an empty page.
    expect(store.nodes({ after: 'c' }).items).toEqual([]);
  });
});

describe('TopologyStore — history vs current state separation', () => {
  it('keeps nodes, edges and evidence intact and exposes no traversability state', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    // A current-world blockage or staleness elsewhere never reaches this store.
    history.forgetFragment('frag-1');
    // Even with the evidence dangling, the node and edge records remain queryable.
    expect(store.nodes().total).toBe(2);
    expect(store.getNode('a')).not.toBeNull();
    const view = store.getEdge('e-ab')!;
    expect(view.basis).toBe('traversed');
    expect(view.resolution).toBe('missing');
  });

  it('queries never mutate stored time, uses, or evidence content', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    const before = history.getTraversal('ev-1')!;
    store.getEdge('e-ab');
    store.edges({ from: 'a' });
    store.nodes({ dim: DIM });
    const after = history.getTraversal('ev-1')!;
    expect(after.observedAt).toBe(before.observedAt);
    expect(after.from).toEqual(before.from);
    expect(history.getFragment('frag-1')!.uses).toBe(1);
  });
});

describe('TopologyStore — regression: rebind, sparse refs, fragment scope', () => {
  it('preserves the evidence binding on empty or unrelated-field updates (no silent rebind)', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');

    // Delete the source fragment, then re-import the same evidence id with different content.
    history.forgetFragment('frag-1');
    history.saveFragment(fragment());
    history.addTraversal(evidence({ observedAt: 2000 }));
    expect(store.getEdge('e-ab')!.resolution).toBe('mismatch');

    // An empty update stays idempotent and does not re-bind the evidence.
    expect(store.updateEdge('e-ab', {}).status).toBe('unchanged');
    expect(store.getEdge('e-ab')!.resolution).toBe('mismatch');

    // An unrelated-field update also preserves the original binding.
    expect(store.updateEdge('e-ab', { source: 'renamed' }).status).toBe('updated');
    expect(store.getEdge('e-ab')!.source).toBe('renamed');
    expect(store.getEdge('e-ab')!.resolution).toBe('mismatch');

    // Only an explicit rebind re-resolves and re-snapshots.
    expect(store.updateEdge('e-ab', { evidenceIds: ['ev-1'] }).status).toBe('updated');
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');
  });

  it('rejects sparse evidence reference arrays instead of skipping their holes', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));

    const sparse = new Array<string>(1); // length 1, one hole
    expect(() =>
      store.saveEdge({
        id: 'e',
        from: 'a',
        to: 'b',
        type: 'HORIZONTAL',
        basis: 'traversed',
        evidenceIds: sparse,
      }),
    ).toThrow(/non-empty string/);
    expect(store.edges().total).toBe(0);

    // The same guard applies on the update/rebind path.
    store.saveEdge({ id: 'e', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    expect(() => store.updateEdge('e', { basis: 'traversed', evidenceIds: sparse })).toThrow(
      /non-empty string/,
    );
    expect(store.getEdge('e')!.basis).toBe('candidate');
  });

  it('reports missing when the owning fragment is gone but the traversal still resolves', () => {
    const fragments = new Map<string, PathFragment>([['frag-1', fragment()]]);
    const traversals = new Map<string, TraversalEvidence>([['ev-1', evidence()]]);
    const history: TopologyHistorySource = {
      worldId: WORLD,
      getFragment: (id) => fragments.get(id) ?? null,
      getTraversal: (id) => traversals.get(id) ?? null,
    };
    const store = new TopologyStore(history);
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
    store.saveEdge(traversedEdge());
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');

    // Delete only the fragment (a source that does not cascade).
    fragments.delete('frag-1');
    const view = store.getEdge('e-ab')!;
    expect(view.resolution).toBe('missing');
    expect(view.references[0]!.status).toBe('missing');
  });

  it('reports mismatch when the owning fragment scope drifts', () => {
    const fragments = new Map<string, PathFragment>([['frag-1', fragment()]]);
    const traversals = new Map<string, TraversalEvidence>([['ev-1', evidence()]]);
    const history: TopologyHistorySource = {
      worldId: WORLD,
      getFragment: (id) => fragments.get(id) ?? null,
      getTraversal: (id) => traversals.get(id) ?? null,
    };
    const store = new TopologyStore(history);
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));
    store.saveEdge(traversedEdge());
    expect(store.getEdge('e-ab')!.resolution).toBe('resolved');

    fragments.get('frag-1')!.dim = 'nether'; // scope drift, no cascade
    const view = store.getEdge('e-ab')!;
    expect(view.resolution).toBe('mismatch');
    expect(view.references[0]!.status).toBe('mismatch');
  });

  it('rejects a fragmentId update that disagrees with the bound evidence', () => {
    const { history, store } = setup();
    store.saveEdge(traversedEdge());
    history.saveFragment(fragment({ id: 'frag-nether', dim: 'nether' }));

    expect(() => store.updateEdge('e-ab', { fragmentId: 'ghost' })).toThrow(
      /does not match evidence fragment/,
    );
    expect(() => store.updateEdge('e-ab', { fragmentId: 'frag-nether' })).toThrow(
      /does not match evidence fragment/,
    );
    // The edge is unchanged and still resolved.
    const view = store.getEdge('e-ab')!;
    expect(view.fragmentId).toBeUndefined();
    expect(view.resolution).toBe('resolved');

    // A matching fragmentId update is accepted.
    expect(store.updateEdge('e-ab', { fragmentId: 'frag-1' }).status).toBe('updated');
    expect(store.getEdge('e-ab')!.fragmentId).toBe('frag-1');
  });

  it('rejects non-array evidence reference collections', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node({ id: 'a' }));
    store.saveNode(node({ id: 'b', location: { kind: 'exact', pos: { ...POS_B } } }));

    const bogus1 = {} as unknown as string[];
    const bogus2 = { length: -1 } as unknown as string[];
    for (const bogus of [bogus1, bogus2]) {
      expect(() =>
        store.saveEdge({
          id: 'e',
          from: 'a',
          to: 'b',
          type: 'HORIZONTAL',
          basis: 'traversed',
          evidenceIds: bogus,
        }),
      ).toThrow(/must be an array/);
    }
    expect(store.edges().total).toBe(0);

    // Candidate upgrade with a non-array collection is also rejected.
    store.saveEdge({ id: 'e', from: 'a', to: 'b', type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    expect(() => store.updateEdge('e', { basis: 'traversed', evidenceIds: bogus1 })).toThrow(
      /must be an array/,
    );
    expect(store.getEdge('e')!.basis).toBe('candidate');
  });
});
