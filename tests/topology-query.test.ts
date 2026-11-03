import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type {
  FragmentScope,
  PathFragment,
  ReachabilityResult,
  RouteQueryResult,
  SpatialNode,
  TopologyEdge,
  TopologyHistorySource,
  TopologyQueryOptions,
  TraversalEvidence,
  Vec3Like,
} from '../src/index.js';

const WORLD = 'world';
const DIM = 'overworld';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

const A = pt(0.5, 64, 0.5);
const B = pt(1.5, 64, 0.5);
const C = pt(2.5, 64, 0.5);
const D = pt(3.5, 64, 0.5);

function makeNode(id: string, pos: Vec3Like, overrides: Partial<SpatialNode> = {}): SpatialNode {
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

function makeFragment(id: string, overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id,
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

function makeEvidence(
  id: string,
  fragmentId: string,
  from: Vec3Like,
  to: Vec3Like,
  overrides: Partial<TraversalEvidence> = {},
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
    ...overrides,
  };
}

function traversedEdge(id: string, from: string, to: string, evidenceIds: string[]): TopologyEdge {
  return { id, from, to, type: 'HORIZONTAL', basis: 'traversed', evidenceIds };
}

function candidateEdge(id: string, from: string, to: string): TopologyEdge {
  return { id, from, to, type: 'HORIZONTAL', basis: 'candidate', source: 'manual', evidenceIds: [] };
}

/** Fresh store with nodes a/b/c/d already saved (no edges). */
function setup() {
  const history = new FragmentStore(WORLD);
  const store = new TopologyStore(history);
  store.saveNode(makeNode('a', A));
  store.saveNode(makeNode('b', B));
  store.saveNode(makeNode('c', C));
  store.saveNode(makeNode('d', D));
  return { history, store };
}

/** Save a resolved traversed edge, creating its own fragment + traversal. */
function seedResolvedEdge(
  history: FragmentStore,
  store: TopologyStore,
  edgeId: string,
  from: string,
  to: string,
  evidenceId: string,
  fragmentId: string,
  fromPos: Vec3Like,
  toPos: Vec3Like,
  evidenceOverrides: Partial<TraversalEvidence> = {},
): void {
  history.saveFragment(makeFragment(fragmentId));
  history.addTraversal(makeEvidence(evidenceId, fragmentId, fromPos, toPos, evidenceOverrides));
  store.saveEdge(traversedEdge(edgeId, from, to, [evidenceId]));
}

/** A resolved A→B→C chain. */
function setupChain() {
  const { history, store } = setup();
  seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
  seedResolvedEdge(history, store, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);
  return { history, store };
}

describe('TopologyStore — bounded adjacency', () => {
  it('lists in-edges and out-edges without resolving references', () => {
    const { history, store } = setup();
    store.saveEdge(candidateEdge('e-cand', 'a', 'b'));
    seedResolvedEdge(history, store, 'e-ba', 'b', 'a', 'ev-ba', 'frag-ba', B, A);

    const adj = store.adjacency('a');
    expect(adj.outEdges.map((e) => e.id)).toEqual(['e-cand']);
    expect(adj.inEdges.map((e) => e.id)).toEqual(['e-ba']);
    expect(adj.complete).toBe(true);
    expect(adj.exhausted).toBeUndefined();
    // Snapshots are TopologyEdge, not reference-resolved views.
    expect(adj.outEdges[0]!.evidenceIds).toEqual([]);
  });

  it('reports a self-loop once and does not duplicate it into in-edges', () => {
    const { store } = setup();
    store.saveEdge(candidateEdge('e-self', 'a', 'a'));
    const adj = store.adjacency('a');
    expect(adj.outEdges.map((e) => e.id)).toEqual(['e-self']);
    expect(adj.inEdges).toEqual([]);
  });

  it('reports a missing node as an error, not an empty adjacency', () => {
    const { store } = setup();
    expect(() => store.adjacency('ghost')).toThrow(/unknown node/);
  });

  it('stops at the edge budget and reports incompleteness', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ac', 'a', 'c', 'ev-ac', 'frag-ac', A, C);
    seedResolvedEdge(history, store, 'e-ad', 'a', 'd', 'ev-ad', 'frag-ad', A, D);

    const adj = store.adjacency('a', { maxEdges: 2 });
    expect(adj.outEdges).toHaveLength(2);
    expect(adj.edgesChecked).toBe(2);
    expect(adj.complete).toBe(false);
    expect(adj.exhausted).toBe('maxEdges');
  });

  it('does not scan unrelated nodes/edges when reading one adjacency', () => {
    const { history, store } = setup();
    // Many unrelated nodes and edges, none incident to 'a'.
    for (let i = 0; i < 200; i++) {
      const n = `n${i}`;
      store.saveNode(makeNode(n, pt(100 + i, 64, 100)));
    }
    for (let i = 0; i < 200; i++) {
      seedResolvedEdge(history, store, `e-x${i}`, `n${i}`, `n${(i + 1) % 200}`, `ev-x${i}`, `frag-x${i}`, pt(100 + i, 64, 100), pt(100 + ((i + 1) % 200), 64, 100));
    }
    const adj = store.adjacency('a');
    expect(adj.outEdges).toEqual([]);
    expect(adj.inEdges).toEqual([]);
    expect(adj.edgesChecked).toBe(0);
    expect(adj.complete).toBe(true);
  });

  it('rejects an invalid edge budget', () => {
    const { store } = setup();
    expect(() => store.adjacency('a', { maxEdges: -1 })).toThrow(/non-negative safe integer/);
    expect(() => store.adjacency('a', { maxEdges: 1.5 })).toThrow(/non-negative safe integer/);
    expect(() => store.adjacency('a', { maxEdges: NaN })).toThrow(/non-negative safe integer/);
  });
});

describe('TopologyStore — route query', () => {
  it('returns an ordered A→B→C route with ordered edges and witness evidence', () => {
    const { store } = setupChain();
    const r = store.route('a', 'c');
    expect(r.status).toBe('FOUND');
    expect(r.nodeIds).toEqual(['a', 'b', 'c']);
    expect(r.edgeIds).toEqual(['e-ab', 'e-bc']);
    expect(r.segments.map((s) => s.edgeId)).toEqual(['e-ab', 'e-bc']);
    expect(r.segments.map((s) => s.evidenceId)).toEqual(['ev-ab', 'ev-bc']);
    expect(r.segments[0]!.evidence.from).toEqual(A);
    expect(r.segments[0]!.evidence.to).toEqual(B);
  });

  it('does not route in reverse without reverse evidence, and allows it once recorded', () => {
    const { store } = setupChain();
    expect(store.route('c', 'a').status).toBe('NO_RECORDED_ROUTE');

    const { history, store: s2 } = setupChain();
    seedResolvedEdge(history, s2, 'e-cb', 'c', 'b', 'ev-cb', 'frag-cb', C, B);
    seedResolvedEdge(history, s2, 'e-ba', 'b', 'a', 'ev-ba', 'frag-ba', B, A);
    const r = s2.route('c', 'a');
    expect(r.status).toBe('FOUND');
    expect(r.nodeIds).toEqual(['c', 'b', 'a']);
  });

  it('handles cycles, self-loops and parallel edges without looping', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ba', 'b', 'a', 'ev-ba', 'frag-ba', B, A);
    store.saveEdge(candidateEdge('e-self', 'a', 'a'));
    // Parallel edge, saved after e-ab, both a→b.
    seedResolvedEdge(history, store, 'e-ab2', 'a', 'b', 'ev-ab2', 'frag-ab2', A, B);

    const reach = store.reachable('a');
    expect(reach.nodes).toEqual(['a', 'b']);

    // The route uses the first parallel edge in insertion order.
    const r = store.route('a', 'b');
    expect(r.status).toBe('FOUND');
    expect(r.edgeIds).toEqual(['e-ab']);
  });

  it('excludes candidate, missing and mismatch edges from a confirmed route', () => {
    const candidate = setup();
    candidate.store.saveEdge(candidateEdge('e-cand', 'a', 'b'));
    expect(candidate.store.route('a', 'b').status).toBe('INSUFFICIENT_EVIDENCE');
    expect(candidate.store.route('a', 'b').gaps).toEqual(['candidate']);

    const missing = setup();
    missing.history.saveFragment(makeFragment('frag-miss'));
    missing.history.addTraversal(makeEvidence('ev-miss', 'frag-miss', A, B));
    missing.store.saveEdge(traversedEdge('e-miss', 'a', 'b', ['ev-miss']));
    missing.history.forgetFragment('frag-miss');
    expect(missing.store.route('a', 'b').status).toBe('INSUFFICIENT_EVIDENCE');
    expect(missing.store.route('a', 'b').gaps).toEqual(['missing']);

    const mismatch = setup();
    seedResolvedEdge(mismatch.history, mismatch.store, 'e-mm', 'a', 'b', 'ev-mm', 'frag-mm', A, B);
    // Re-import same evidence id with different content.
    mismatch.history.forgetFragment('frag-mm');
    mismatch.history.saveFragment(makeFragment('frag-mm'));
    mismatch.history.addTraversal(makeEvidence('ev-mm', 'frag-mm', A, B, { observedAt: 2000 }));
    expect(mismatch.store.route('a', 'b').status).toBe('INSUFFICIENT_EVIDENCE');
    expect(mismatch.store.route('a', 'b').gaps).toEqual(['mismatch']);
  });

  it('excludes an edge when one reference resolves but another is missing', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-1'));
    history.addTraversal(makeEvidence('ev-1', 'frag-1', A, B));
    history.saveFragment(makeFragment('frag-2'));
    history.addTraversal(makeEvidence('ev-2', 'frag-2', A, B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-1', 'ev-2']));

    history.forgetFragment('frag-2'); // ev-2 gone, ev-1 still resolves
    const r = store.route('a', 'b');
    expect(r.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.gaps).toEqual(['missing']);
  });

  it('keeps FOUND even when other explored branches hold gaps', () => {
    const { history, store } = setupChain();
    store.saveEdge(candidateEdge('e-bd', 'b', 'd'));
    const r = store.route('a', 'c');
    expect(r.status).toBe('FOUND');
    expect(r.nodeIds).toEqual(['a', 'b', 'c']);
    // The candidate branch was explored but does not negate the found route.
    expect(r.gaps).toContain('candidate');
  });

  it('does not let gaps in unvisited regions or in-edges affect the conclusion', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    store.saveNode(makeNode('x', pt(50, 64, 50)));
    store.saveNode(makeNode('y', pt(51, 64, 50)));
    store.saveEdge(candidateEdge('e-xy', 'x', 'y')); // unvisited region
    store.saveNode(makeNode('z', pt(60, 64, 60)));
    store.saveEdge(candidateEdge('e-za', 'z', 'a')); // in-edge to 'a', z unreachable

    const reach = store.reachable('a');
    expect(reach.disposition).toBe('complete');
    expect(reach.gaps).toEqual([]);
    expect(reach.nodes).toEqual(['a', 'b']);
  });

  it('specifies mode and selects matching evidence; unknown mode does not default to walk', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-walk', 'frag-ab', A, B, { mode: 'walk' }));
    history.addTraversal(makeEvidence('ev-swim', 'frag-ab', A, B, { mode: 'swim' }));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-walk', 'ev-swim']));

    const walk = store.route('a', 'b', { mode: 'walk' });
    expect(walk.status).toBe('FOUND');
    expect(walk.segments[0]!.evidenceId).toBe('ev-walk');
    expect(walk.segments[0]!.evidence.mode).toBe('walk');

    const swim = store.route('a', 'b', { mode: 'swim' });
    expect(swim.status).toBe('FOUND');
    expect(swim.segments[0]!.evidenceId).toBe('ev-swim');

    // No matching known mode → normal filter, not an evidence gap.
    const jump = store.route('a', 'b', { mode: 'jump' });
    expect(jump.status).toBe('NO_RECORDED_ROUTE');
    expect(jump.gaps).toEqual([]);
  });

  it('distinguishes mode_unknown from mode_mismatch', () => {
    const unknown = setup();
    unknown.history.saveFragment(makeFragment('frag-ab'));
    unknown.history.addTraversal(makeEvidence('ev-u', 'frag-ab', A, B)); // mode unknown
    unknown.store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-u']));
    const rUnknown = unknown.store.route('a', 'b', { mode: 'walk' });
    expect(rUnknown.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(rUnknown.gaps).toEqual(['mode_unknown']);

    const mismatch = setup();
    mismatch.history.saveFragment(makeFragment('frag-ab'));
    mismatch.history.addTraversal(makeEvidence('ev-swim', 'frag-ab', A, B, { mode: 'swim' }));
    mismatch.store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-swim']));
    const rMismatch = mismatch.store.route('a', 'b', { mode: 'walk' });
    expect(rMismatch.status).toBe('NO_RECORDED_ROUTE');
    expect(rMismatch.gaps).toEqual([]);
  });

  it('preserves unknown or mixed modes when no mode is specified', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-u', 'frag-ab', A, B)); // unknown mode
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-u']));
    const r = store.route('a', 'b');
    expect(r.status).toBe('FOUND');
    expect(r.segments[0]!.evidence.mode).toBeUndefined();

    const mixed = setup();
    mixed.history.saveFragment(makeFragment('frag-ab'));
    mixed.history.addTraversal(makeEvidence('ev-w', 'frag-ab', A, B, { mode: 'walk' }));
    mixed.store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-w']));
    seedResolvedEdge(mixed.history, mixed.store, 'e-bc', 'b', 'c', 'ev-swim', 'frag-bc', B, C, { mode: 'swim' });
    const r2 = mixed.store.route('a', 'c');
    expect(r2.status).toBe('FOUND');
    expect(r2.segments.map((s) => s.evidence.mode)).toEqual(['walk', 'swim']);
  });

  it('compares the same evidenceId against each edge binding independently', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-1', 'frag-ab', A, B, { observedAt: 1000 }));
    store.saveEdge(traversedEdge('e1', 'a', 'b', ['ev-1'])); // snapshot observedAt=1000

    // Re-import same evidence id with different content → e1 becomes mismatch.
    history.forgetFragment('frag-ab');
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-1', 'frag-ab', A, B, { observedAt: 2000 }));

    // A new edge bound now snapshots the new content and stays resolved.
    store.saveEdge(traversedEdge('e2', 'a', 'b', ['ev-1']));

    const r = store.route('a', 'b');
    expect(r.status).toBe('FOUND');
    expect(r.edgeIds).toEqual(['e2']);
    expect(r.gaps).toContain('mismatch'); // e1's independent mismatch is still observed
  });

  it('fails explicitly on missing nodes, region endpoints, cross-dimension, and illegal mode', () => {
    const { store } = setup();
    expect(() => store.route('ghost', 'b')).toThrow(/unknown node/);

    const region = setup();
    region.store.saveNode(makeNode('r', pt(0, 64, 0), { location: { kind: 'region', center: pt(0, 64, 0), radius: 2 } }));
    expect(() => region.store.route('r', 'a')).toThrow(/not an exact location/);

    const cross = setup();
    cross.store.saveNode(makeNode('n', pt(0, 64, 0), { dim: 'nether' }));
    expect(() => cross.store.route('a', 'n')).toThrow(/dimensions/);

    expect(() => store.route('a', 'b', { mode: 'fly' as never })).toThrow(/not a known movement mode/);
  });

  it('handles a zero-hop route: one node, zero edges, zero evidence, no ARRIVED', () => {
    const { store } = setup();
    const r = store.route('a', 'a');
    expect(r.status).toBe('FOUND');
    expect(r.nodeIds).toEqual(['a']);
    expect(r.edgeIds).toEqual([]);
    expect(r.segments).toEqual([]);
    expect(r.stats.historyReads).toBe(0);
    expect((r as unknown as Record<string, unknown>).arrived).toBeUndefined();

    expect(() => store.route('ghost', 'ghost')).toThrow(/unknown node/);
    const region = setup();
    region.store.saveNode(makeNode('r', pt(0, 64, 0), { location: { kind: 'region', center: pt(0, 64, 0), radius: 2 } }));
    expect(() => region.store.route('r', 'r')).toThrow(/not an exact location/);
  });

  it('honors zero and boundary budgets, reporting stats within the limit', () => {
    const { store } = setupChain();
    const zero = store.route('a', 'c', { maxNodes: 0 });
    expect(zero.status).toBe('BUDGET_EXHAUSTED');
    expect(zero.exhausted).toBe('maxNodes');
    expect(zero.stats.nodesRead).toBe(0);

    const oneNode = store.route('a', 'c', { maxNodes: 1 });
    expect(oneNode.status).toBe('BUDGET_EXHAUSTED');
    expect(oneNode.stats.nodesRead).toBe(1);

    const zeroEdges = store.route('a', 'c', { maxEdges: 0 });
    expect(zeroEdges.status).toBe('BUDGET_EXHAUSTED');
    expect(zeroEdges.exhausted).toBe('maxEdges');
    expect(zeroEdges.stats.edgesChecked).toBe(0);

    const zeroReads = store.route('a', 'c', { maxHistoryReads: 0 });
    expect(zeroReads.status).toBe('BUDGET_EXHAUSTED');
    expect(zeroReads.exhausted).toBe('maxHistoryReads');
    expect(zeroReads.stats.historyReads).toBe(0);

    expect(() => store.route('a', 'c', { maxNodes: -1 })).toThrow(/non-negative safe integer/);
    expect(() => store.route('a', 'c', { maxNodes: 1.5 })).toThrow(/non-negative safe integer/);
    expect(() => store.route('a', 'c', { maxNodes: Infinity })).toThrow(/non-negative safe integer/);
  });

  it('keeps gap classification even when diagnostics are zeroed or truncated', () => {
    const { history, store } = setup();
    store.saveEdge(candidateEdge('e1', 'a', 'b'));
    store.saveEdge(candidateEdge('e2', 'a', 'c'));
    store.saveEdge(candidateEdge('e3', 'a', 'd'));

    const truncated = store.route('a', 'c', { maxDiagnostics: 0 });
    expect(truncated.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(truncated.gaps).toEqual(['candidate']);
    expect(truncated.diagnostics).toEqual([]);
    expect(truncated.stats.diagnostics).toBe(0);
    expect(truncated.stats.diagnosticsTruncated).toBe(true);

    const partial = store.route('a', 'c', { maxDiagnostics: 1 });
    expect(partial.diagnostics).toHaveLength(1);
    expect(partial.stats.diagnosticsTruncated).toBe(true);
    expect(partial.gaps).toEqual(['candidate']);
  });

  it('stops a high-degree expansion at the edge budget without reading all incident edges', () => {
    const { history, store } = setup();
    for (let i = 0; i < 10; i++) {
      store.saveNode(makeNode(`n${i}`, pt(10 + i, 64, 10)));
    }
    for (let i = 0; i < 10; i++) {
      seedResolvedEdge(history, store, `e${i}`, 'a', `n${i}`, `ev${i}`, `frag${i}`, A, pt(10 + i, 64, 10));
    }
    const r = store.reachable('a', { maxEdges: 3 });
    expect(r.disposition).toBe('budget_exhausted');
    expect(r.exhausted).toBe('maxEdges');
    expect(r.stats.edgesChecked).toBe(3);
    expect(r.nodes).toEqual(['a', 'n0', 'n1', 'n2']);
  });

  it('reflects delete / replace / re-import on the next query', () => {
    const { history, store } = setupChain();
    expect(store.route('a', 'c').status).toBe('FOUND');

    history.forgetFragment('frag-ab');
    const gone = store.route('a', 'c');
    expect(gone.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(gone.gaps).toContain('missing');

    // Identical re-import restores the route.
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    expect(store.route('a', 'c').status).toBe('FOUND');
  });

  it('propagates history read errors rather than reporting NO_RECORDED_ROUTE', () => {
    class FlakyHistory implements TopologyHistorySource {
      readonly worldId = WORLD;
      fail = false;
      private readonly traversals = new Map<string, TraversalEvidence>();
      private readonly fragments = new Map<string, PathFragment>();

      addFragment(f: PathFragment): void {
        this.fragments.set(f.id, f);
      }

      addTraversal(e: TraversalEvidence): void {
        this.traversals.set(e.id, e);
      }

      getFragment(id: string): PathFragment | null {
        return this.fragments.get(id) ?? null;
      }

      getTraversal(id: string): TraversalEvidence | null {
        if (this.fail) throw new Error('history read failed');
        return this.traversals.get(id) ?? null;
      }
    }

    const history = new FlakyHistory();
    history.addFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    const store = new TopologyStore(history);
    store.saveNode(makeNode('a', A));
    store.saveNode(makeNode('b', B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-ab']));

    history.fail = true;
    // A read error is a distinct failure, never translated to "no route".
    expect(() => store.route('a', 'b')).toThrow(/history read failed/);
  });

  it('isolates result snapshots from mutation', () => {
    const { store } = setupChain();
    const r = store.route('a', 'c');
    r.nodeIds.push('z');
    r.segments[0]!.evidence.from.x = 999;
    r.edgeIds.length = 0;

    const again = store.route('a', 'c');
    expect(again.nodeIds).toEqual(['a', 'b', 'c']);
    expect(again.edgeIds).toEqual(['e-ab', 'e-bc']);
    expect(again.segments[0]!.evidence.from.x).toBe(0.5);
  });

  it('accepts stable getter-provided query options', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B, { mode: 'walk' });
    class Options implements TopologyQueryOptions {
      get mode(): 'walk' {
        return 'walk';
      }
      get maxEdges(): number {
        return 10;
      }
    }
    expect(store.route('a', 'b', new Options()).status).toBe('FOUND');
  });

  it('does not mutate history time, uses, or node/edge content across queries', () => {
    const { history, store } = setupChain();
    const before = history.getTraversal('ev-ab')!;
    store.reachable('a');
    store.route('a', 'c');
    store.adjacency('a');
    const after = history.getTraversal('ev-ab')!;
    expect(after.observedAt).toBe(before.observedAt);
    expect(history.getFragment('frag-ab')!.uses).toBe(1);
    expect(store.nodes().total).toBe(4);
    expect(store.edges().total).toBe(2);
  });

  it('never exposes current traversability on a query result', () => {
    const { store } = setupChain();
    const r = store.route('a', 'c') as unknown as Record<string, unknown>;
    expect('open' in r).toBe(false);
    expect('blocked' in r).toBe(false);
    expect('traversable' in r).toBe(false);
  });
});

describe('TopologyStore — reachability query', () => {
  it('reports the confirmed reachable set with the start at depth zero', () => {
    const { store } = setupChain();
    const r = store.reachable('a');
    expect(r.nodes).toEqual(['a', 'b', 'c']);
    expect(r.disposition).toBe('complete');
    expect(r.gaps).toEqual([]);
  });

  it('distinguishes a complete search from one that hit evidence gaps', () => {
    const complete = setupChain();
    expect(complete.store.reachable('a').disposition).toBe('complete');

    const gapped = setupChain();
    gapped.store.saveEdge(candidateEdge('e-cd', 'c', 'd'));
    const r = gapped.store.reachable('a');
    expect(r.disposition).toBe('evidence_gaps');
    expect(r.gaps).toEqual(['candidate']);
  });
});

describe('TopologyStore — history read counting and lightweight scope reads', () => {
  class CountingHistory implements TopologyHistorySource {
    readonly worldId = WORLD;
    getTraversalCalls = 0;
    getFragmentCalls = 0;
    getFragmentScopeCalls = 0;
    private readonly traversals = new Map<string, TraversalEvidence>();
    private readonly fragments = new Map<string, PathFragment>();
    private readonly scopes = new Map<string, FragmentScope>();

    addFragment(f: PathFragment): void {
      this.fragments.set(f.id, f);
      this.scopes.set(f.id, { id: f.id, worldId: f.worldId, dim: f.dim });
    }

    addTraversal(e: TraversalEvidence): void {
      this.traversals.set(e.id, e);
    }

    getTraversal(id: string): TraversalEvidence | null {
      this.getTraversalCalls += 1;
      return this.traversals.get(id) ?? null;
    }

    getFragment(id: string): PathFragment | null {
      this.getFragmentCalls += 1;
      return this.fragments.get(id) ?? null;
    }

    getFragmentScope(id: string): FragmentScope | null {
      this.getFragmentScopeCalls += 1;
      return this.scopes.get(id) ?? null;
    }
  }

  it('uses the lightweight scope entry and counts reads accurately', () => {
    const history = new CountingHistory();
    history.addFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    const store = new TopologyStore(history);
    store.saveNode(makeNode('a', A));
    store.saveNode(makeNode('b', B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-ab']));

    history.getTraversalCalls = 0;
    history.getFragmentCalls = 0;
    history.getFragmentScopeCalls = 0;

    const r = store.route('a', 'b');
    expect(r.status).toBe('FOUND');
    expect(r.stats.historyReads).toBe(2);
    expect(history.getTraversalCalls).toBe(1);
    expect(history.getFragmentScopeCalls).toBe(1);
    expect(history.getFragmentCalls).toBe(0); // no full geometry copy
  });

  it('falls back to getFragment for a source without the lightweight entry', () => {
    class NoScopeHistory implements TopologyHistorySource {
      readonly worldId = WORLD;
      getTraversalCalls = 0;
      getFragmentCalls = 0;
      private readonly traversals = new Map<string, TraversalEvidence>();
      private readonly fragments = new Map<string, PathFragment>();

      addFragment(f: PathFragment): void {
        this.fragments.set(f.id, f);
      }

      addTraversal(e: TraversalEvidence): void {
        this.traversals.set(e.id, e);
      }

      getTraversal(id: string): TraversalEvidence | null {
        this.getTraversalCalls += 1;
        return this.traversals.get(id) ?? null;
      }

      getFragment(id: string): PathFragment | null {
        this.getFragmentCalls += 1;
        return this.fragments.get(id) ?? null;
      }
    }

    const history = new NoScopeHistory();
    history.addFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    const store = new TopologyStore(history);
    store.saveNode(makeNode('a', A));
    store.saveNode(makeNode('b', B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-ab']));

    history.getTraversalCalls = 0;
    history.getFragmentCalls = 0;

    const r = store.route('a', 'b');
    expect(r.status).toBe('FOUND');
    expect(r.stats.historyReads).toBe(2);
    expect(history.getTraversalCalls).toBe(1);
    expect(history.getFragmentCalls).toBe(1); // fallback scope read
  });
});
