import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/topology/index.js';
import type {
  EdgeVerificationInput,
  PathFragment,
  SpatialNode,
  TraversalEvidence,
} from '../src/topology/index.js';
import type { Vec3Like } from '../src/types.js';

const WORLD = 'world';
const DIM = 'overworld';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

const A = pt(0, 64, 0);
const B = pt(1, 64, 0);
const C = pt(2, 64, 0);
const D = pt(3, 64, 0);
const E = pt(4, 64, 0);
const F = pt(5, 64, 0);

function node(id: string, pos: Vec3Like, overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'agent',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { ...pos } },
    ...overrides,
  };
}

function fragment(
  id: string,
  polyline: Vec3Like[],
  overrides: Partial<PathFragment> = {},
): PathFragment {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [],
    polyline: polyline.map((p) => ({ ...p })),
    geometrySource: 'traversal',
    deepestY: 64,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

function traversal(
  id: string,
  fragmentId: string,
  from: Vec3Like,
  to: Vec3Like,
): TraversalEvidence {
  return {
    id,
    fragmentId,
    from: { ...from },
    to: { ...to },
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    source: 'confirmed_walk',
  };
}

function open(mode: 'walk' = 'walk'): EdgeVerificationInput {
  return {
    direction: 'forward',
    mode,
    status: 'OPEN',
    computedAt: 900,
    validUntil: 2000,
    sessionId: 's1',
    contextKey: 'body:0.6x1.8',
    dependencies: [{ key: { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 }, revision: 1 }],
  };
}

describe('TopologyStore — fragmentation and merging', () => {
  function setup() {
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment('f1', [A, B], { links: [{ a: A, b: B }] }));
    history.saveFragment(fragment('f2', [C, D], { links: [{ a: C, b: D }] }));
    history.saveFragment(fragment('f3', [E, F])); // no links: two isolated points
    const store = new TopologyStore(history);
    return { history, store };
  }

  it('uses union-find over actual links only, not proximity', () => {
    const { store } = setup();
    const before = store.fragmentation(DIM);
    expect(before.records).toBe(3);
    expect(before.points).toBe(6);
    // f1, f2, and f3's two unlinked points.
    expect(before.components).toBe(4);
    expect(before.pieces.filter((p) => p.records === 1)).toHaveLength(4);
  });

  it('adds traversal evidence as an actual link between fragments', () => {
    const { history, store } = setup();
    history.addTraversal(traversal('ev-link', 'f1', B, C));
    const after = store.fragmentation(DIM);
    expect(after.components).toBe(3);
    const joined = after.pieces.find((piece) => piece.fragmentIds.length === 2)!;
    expect(joined.points).toBe(4);
    expect(joined.fragmentIds).toEqual(['f1', 'f2']);
  });

  it('merges only with evidence that actually connects the two fragments', () => {
    const { history, store } = setup();
    history.addTraversal(traversal('ev-link', 'f1', B, C));
    expect(store.mergeFragments('f1', 'f2', 'ev-link').status).toBe('inserted');
    expect(store.mergeFragments('f1', 'f2', 'ev-link').status).toBe('unchanged');
    // No actual connection to f3: proximity/other links are refused.
    expect(() => store.mergeFragments('f1', 'f3', 'ev-link')).toThrow(/does not connect/);
    expect(() => store.mergeFragments('f1', 'f2', 'ghost')).toThrow(/unknown traversal/);
    expect(() => store.mergeFragments('f1', 'f1', 'ev-link')).toThrow(/itself/);
    // History is untouched by merging.
    expect(history.getFragment('f1')).not.toBeNull();
    expect(history.getFragment('f2')).not.toBeNull();
    expect(history.getFragment('f3')).not.toBeNull();
  });

  it('counts a point-less legacy record as one record in its own piece', () => {
    const { history, store } = setup();
    history.saveFragment(fragment('empty', []));
    const result = store.fragmentation(DIM);
    expect(result.records).toBe(4);
    expect(result.pieces.some((p) => p.fragmentIds.includes('empty'))).toBe(true);
  });
});

describe('TopologyStore — fragment segments and edge verification', () => {
  const P0 = pt(0.5, 64, 0.5);
  const P1 = pt(1.5, 64, 0.5);
  const P2 = pt(2.5, 64, 0.5);
  const P3 = pt(3.5, 64, 0.5);

  function setup() {
    let now = 1000;
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment('path', [P0, P1, P2, P3]));
    history.addTraversal(traversal('ev-p1', 'path', P1, P2));
    const store = new TopologyStore(history, { now: () => now });
    store.saveNode(node('n1', P1));
    store.saveNode(node('n2', P2));
    store.saveEdge({
      id: 'e-12',
      from: 'n1',
      to: 'n2',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-p1'],
      fragmentId: 'path',
    });
    return { history, store, setNow: (value: number) => (now = value) };
  }

  it('keeps the fragment whole while unverified', () => {
    const { store } = setup();
    const view = store.segments('path');
    expect(view.totalPoints).toBe(4);
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]!.points).toEqual([P0, P1, P2, P3]);
    expect(view.blockedEdgeIds).toEqual([]);
  });

  it('splits the current passable pieces on blockage without deleting history', () => {
    const { history, store } = setup();
    store.blockEdge('e-12', {
      mode: 'walk',
      blockedAt: { kind: 'contact', pos: { ...P1 }, observedAt: 950, sessionId: 's1' },
      computedAt: 950,
      validUntil: 3000,
    });
    const view = store.segments('path');
    expect(view.blockedEdgeIds).toEqual(['e-12']);
    expect(view.segments.map((s) => s.points)).toEqual([[P0], [P3]]);
    // The historical fragment and its traversal are intact.
    expect(history.getFragment('path')!.polyline).toEqual([P0, P1, P2, P3]);
    expect(history.getTraversal('ev-p1')).not.toBeNull();

    // Clearing a block is only UNKNOWN: still split.
    store.clearEdgeBlock('e-12', 'forward', 'walk');
    expect(store.segments('path').segments).toHaveLength(2);

    // Fresh OPEN restores one passable piece.
    store.verifyEdge('e-12', open());
    expect(store.segments('path').segments).toHaveLength(1);
  });
});

describe('TopologyStore — node components and affected-subgraph recompute', () => {
  function setup() {
    const history = new FragmentStore(WORLD);
    const store = new TopologyStore(history);
    for (const [id, pos] of [
      ['a', A],
      ['b', B],
      ['c', C],
      ['d', D],
    ] as const) {
      store.saveNode(node(id, pos));
    }
    history.saveFragment(fragment('fab', [A, B]));
    history.addTraversal(traversal('ev-ab', 'fab', A, B));
    store.saveEdge({
      id: 'e-ab',
      from: 'a',
      to: 'b',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-ab'],
    });
    history.saveFragment(fragment('fcd', [C, D]));
    history.addTraversal(traversal('ev-cd', 'fcd', C, D));
    store.saveEdge({
      id: 'e-cd',
      from: 'c',
      to: 'd',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-cd'],
    });
    return { history, store };
  }

  it('computes node components from evidence-backed edges and reuses the cache', () => {
    const { store } = setup();
    const first = store.components(DIM);
    expect(first.components).toBe(2);
    expect(first.groups).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(first.recomputedNodes).toBe(4);

    const second = store.components(DIM);
    expect(second.recomputedNodes).toBe(0);
    expect(second.components).toBe(2);

    // A new isolated node recomputes only itself; untouched components are reused.
    store.saveNode(node('iso', pt(50, 64, 50)));
    const third = store.components(DIM);
    expect(third.components).toBe(3);
    expect(third.recomputedNodes).toBe(1);
    expect(third.byNode.get('iso')).not.toBe(third.byNode.get('a'));
  });

  it('recomputes the affected subgraph when an edge joins components', () => {
    const { history, store } = setup();
    expect(store.components(DIM).components).toBe(2);
    history.saveFragment(fragment('fbc', [B, C]));
    history.addTraversal(traversal('ev-bc', 'fbc', B, C));
    store.saveEdge({
      id: 'e-bc',
      from: 'b',
      to: 'c',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-bc'],
    });
    const merged = store.components(DIM);
    expect(merged.components).toBe(1);
    expect(merged.groups).toEqual([['a', 'b', 'c', 'd']]);
    expect(merged.recomputedNodes).toBe(4);
  });

  it('does not treat candidate edges as connectivity', () => {
    const { store } = setup();
    store.saveEdge({
      id: 'e-cand',
      from: 'a',
      to: 'c',
      type: 'HORIZONTAL',
      basis: 'candidate',
      evidenceIds: [],
    });
    expect(store.components(DIM).components).toBe(2);
  });
});

describe('TopologyStore — anchors within the reachable component', () => {
  const S = pt(0.5, 64, 0.5);
  const HIGH = pt(1.5, 70, 0.5);
  const DEEP = pt(2.5, 50, 0.5);
  const GLOBAL_HIGH = pt(100, 200, 100);
  const GLOBAL_DEEP = pt(100, -50, 100);

  function setup() {
    let now = 1000;
    const history = new FragmentStore(WORLD);
    const store = new TopologyStore(history, { now: () => now });
    store.saveNode(node('s', S, { observedAt: 1000 }));
    store.saveNode(node('high', HIGH));
    store.saveNode(node('deep', DEEP));
    store.saveNode(node('global-high', GLOBAL_HIGH));
    store.saveNode(node('global-deep', GLOBAL_DEEP));
    for (const [id, fragId, evId, from, to, fromId, toId] of [
      ['e-sh', 'fsh', 'ev-sh', S, HIGH, 's', 'high'],
      ['e-sd', 'fsd', 'ev-sd', S, DEEP, 's', 'deep'],
    ] as const) {
      history.saveFragment(fragment(fragId, [from, to]));
      history.addTraversal(traversal(evId, fragId, from, to));
      store.saveEdge({
        id,
        from: fromId,
        to: toId,
        type: 'HORIZONTAL',
        basis: 'traversed',
        evidenceIds: [evId],
      });
    }
    return { store, setNow: (value: number) => (now = value) };
  }

  it('returns the highest/lowest anchor reachable from here, not the global extreme', () => {
    const { store } = setup();
    const surface = store.surfaceAnchor(DIM, S)!;
    expect(surface.nodeId).toBe('high');
    expect(surface.y).toBe(70);
    expect(surface.precision).toBe('exact');
    expect(surface.startNodeId).toBe('s');
    expect(surface.hops).toBe(1);
    expect(surface.componentSize).toBe(3);
    expect(surface.source).toBe('agent');

    const deep = store.deepestAnchor(DIM, S)!;
    expect(deep.nodeId).toBe('deep');
    expect(deep.y).toBe(50);
    expect(store.surfaceAnchor(DIM, S)!.nodeId).not.toBe('global-high');
    expect(store.deepestAnchor(DIM, S)!.nodeId).not.toBe('global-deep');
  });

  it('restricts to the currently reachable component and excludes gone anchors', () => {
    const { store } = setup();
    store.blockEdge('e-sh', {
      mode: 'walk',
      blockedAt: { kind: 'contact', pos: { ...S }, observedAt: 950, sessionId: 's1' },
      computedAt: 950,
      validUntil: 3000,
    });
    // high is no longer reachable; s (y=64) wins over deep (y=50).
    expect(store.surfaceAnchor(DIM, S)!.nodeId).toBe('s');

    store.clearEdgeBlock('e-sh', 'forward', 'walk');
    store.verifyEdge('e-sh', open());
    store.markGone('high', { sessionId: 's1', observedAt: 2000, source: 'vision' });
    expect(store.surfaceAnchor(DIM, S)!.nodeId).toBe('s');
  });

  it('does not treat a region node as an exact anchor', () => {
    const history = new FragmentStore(WORLD);
    const store = new TopologyStore(history);
    store.saveNode({
      id: 'region-only',
      kind: 'place',
      source: 'agent',
      tag: 'resource',
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'region', center: { ...S }, radius: 5 },
    });
    expect(store.surfaceAnchor(DIM, S)).toBeNull();
    expect(store.deepestAnchor(DIM, S)).toBeNull();
  });

  it('returns null when no exact node is near here', () => {
    const { store } = setup();
    expect(store.surfaceAnchor(DIM, pt(500, 64, 500))).toBeNull();
  });
});
