import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type {
  FragmentScope,
  HistoricalAnchorQueryOptions,
  PathFragment,
  SpatialNode,
  TopologyEdge,
  TopologyHistorySource,
  TraversalEvidence,
  Vec3Like,
} from '../src/index.js';

const WORLD = 'world';
const DIM = 'overworld';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

const A = pt(0.5, 64, 0.5);
const B = pt(1.5, 70, 0.5);
const C = pt(2.5, 60, 0.5);
const D = pt(3.5, 66, 0.5);
const E = pt(4.5, 50, 0.5);

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
    deepestY: 0,
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

/** Fresh store with nodes a..e already saved (no edges). */
function setup() {
  const history = new FragmentStore(WORLD);
  const store = new TopologyStore(history);
  store.saveNode(makeNode('a', A));
  store.saveNode(makeNode('b', B));
  store.saveNode(makeNode('c', C));
  store.saveNode(makeNode('d', D));
  store.saveNode(makeNode('e', E));
  return { history, store };
}

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

/** a→b→c resolved chain (b high at y=70, c low at y=60). */
function setupChain() {
  const { history, store } = setup();
  seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
  seedResolvedEdge(history, store, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);
  return { history, store };
}

describe('TopologyStore — historicalAnchorCandidates defaults and start', () => {
  it('includes the start as a zero-hop candidate with no proof edge', () => {
    const { store } = setupChain();
    const r = store.historicalAnchorCandidates('a', { limit: 1, order: 'bfs' });
    expect(r.order).toBe('bfs');
    expect(r.items.map((i) => i.node.id)).toEqual(['a']);
    expect(r.items[0]!.hops).toBe(0);
    expect(r.proofSegments).toEqual([]); // start needs no proof edge
    expect(r.matchedCount).toBe(3); // a, b, c all match before limit
    expect(r.resultsTruncated).toBe(true);
  });

  it('excludes the start with includeStart=false but still traverses from it', () => {
    const { store } = setupChain();
    const r = store.historicalAnchorCandidates('a', { includeStart: false });
    expect(r.items.map((i) => i.node.id)).toEqual(['b', 'c']);
    expect(r.matchedCount).toBe(2);
  });

  it('filters by source/tag/kind with AND; a missing tag never matches', () => {
    const { history, store } = setup();
    store.updateNode('b', { tag: 'base' });
    store.updateNode('c', { tag: 'resource', kind: 'branch' });
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);

    // Missing tag (a, and nodes without tag) never match a specified tag.
    expect(store.historicalAnchorCandidates('a', { tag: 'base' }).items.map((i) => i.node.id)).toEqual(['b']);
    expect(store.historicalAnchorCandidates('a', { tag: 'resource' }).items.map((i) => i.node.id)).toEqual(['c']);
    expect(store.historicalAnchorCandidates('a', { kind: 'branch' }).items.map((i) => i.node.id)).toEqual(['c']);
    // AND combination.
    expect(
      store.historicalAnchorCandidates('a', { tag: 'resource', kind: 'branch' }).items.map((i) => i.node.id),
    ).toEqual(['c']);
    expect(store.historicalAnchorCandidates('a', { tag: 'base', kind: 'branch' }).items).toEqual([]);
  });

  it('lets a non-matching intermediate node still reach a matching candidate', () => {
    const history = new FragmentStore(WORLD);
    const store = new TopologyStore(history);
    store.saveNode(makeNode('a', A)); // agent (default)
    store.saveNode(makeNode('b', B, { source: 'program' })); // intermediate, source program
    store.saveNode(makeNode('c', C, { tag: 'base' })); // target candidate, source agent
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);

    const r = store.historicalAnchorCandidates('a', { source: 'agent' });
    // Only the agent-source nodes match: a and c; program node b is skipped but traversed.
    expect(r.items.map((i) => i.node.id)).toEqual(['a', 'c']);
    // The proof path to c still crosses b.
    expect(r.proofSegments.map((s) => s.from).concat(r.proofSegments.map((s) => s.to))).toContain('b');
  });
});

describe('TopologyStore — historicalAnchorCandidates direction and reachability', () => {
  it('does not follow reverse or round-trip reachability on one-directional edges', () => {
    const { store } = setupChain();
    // Only a→b→c exists; nothing reachable from c.
    const r = store.historicalAnchorCandidates('c');
    expect(r.items.map((i) => i.node.id)).toEqual(['c']);
    expect(r.matchedCount).toBe(1);
  });

  it('excludes higher/deeper nodes in another disconnected historical region', () => {
    const { history, store } = setupChain();
    // A separate region with a very high node, unreachable from a.
    store.saveNode(makeNode('x', pt(100, 200, 100)));
    store.saveNode(makeNode('y', pt(101, 210, 100)));
    seedResolvedEdge(history, store, 'e-xy', 'x', 'y', 'ev-xy', 'frag-xy', pt(100, 200, 100), pt(101, 210, 100));

    const highest = store.historicalAnchorCandidates('a', { order: 'highest' });
    expect(highest.items[0]!.node.id).toBe('b'); // y=70, not the disconnected y=210
    expect(highest.items.map((i) => i.node.id)).not.toContain('y');
  });
});

describe('TopologyStore — historicalAnchorCandidates ordering', () => {
  it('uses node pos.y for highest/deepest, unaffected by fragment deepestY', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ac', 'a', 'c', 'ev-ac', 'frag-ac', A, C);
    // Give the fragments a deepestY that would reverse the pos.y ordering.
    history.updateFragment('frag-ab', { deepestY: -1000 }); // b's fragment
    history.updateFragment('frag-ac', { deepestY: 1000 }); // c's fragment

    const highest = store.historicalAnchorCandidates('a', { order: 'highest', includeStart: false });
    expect(highest.items.map((i) => i.node.id)).toEqual(['b', 'c']); // by pos.y 70 > 60
    const deepest = store.historicalAnchorCandidates('a', { order: 'deepest', includeStart: false });
    expect(deepest.items.map((i) => i.node.id)).toEqual(['c', 'b']); // by pos.y 60 < 70
  });

  it('finds a later higher/deeper candidate even with limit=1', () => {
    const { history, store } = setup();
    // Lower node discovered first (e-alow), higher discovered second (e-ahigh).
    seedResolvedEdge(history, store, 'e-alow', 'a', 'c', 'ev-alow', 'frag-alow', A, C); // c y=60
    seedResolvedEdge(history, store, 'e-ahigh', 'a', 'b', 'ev-ahigh', 'frag-ahigh', A, B); // b y=70

    const highest = store.historicalAnchorCandidates('a', { order: 'highest', includeStart: false, limit: 1 });
    expect(highest.items.map((i) => i.node.id)).toEqual(['b']);
    expect(highest.matchedCount).toBe(2);
    expect(highest.resultsTruncated).toBe(true);
  });

  it('keeps same-height candidates in stable BFS order', () => {
    const { history, store } = setup();
    store.saveNode(makeNode('x', pt(3.5, 70, 0.5))); // same height as b (y=70)
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ax', 'a', 'x', 'ev-ax', 'frag-ax', A, pt(3.5, 70, 0.5));

    const r = store.historicalAnchorCandidates('a', { order: 'highest', includeStart: false });
    expect(r.items.map((i) => i.node.id)).toEqual(['b', 'x']); // b discovered before x
  });

  it('handles cycles, self-loops and parallel edges without duplicating candidates', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ba', 'b', 'a', 'ev-ba', 'frag-ba', B, A);
    store.saveEdge(candidateEdge('e-self', 'a', 'a'));
    seedResolvedEdge(history, store, 'e-ab2', 'a', 'b', 'ev-ab2', 'frag-ab2', A, B);

    const r = store.historicalAnchorCandidates('a');
    expect(r.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(r.items.filter((i) => i.node.id === 'b')).toHaveLength(1);
  });
});

describe('TopologyStore — historicalAnchorCandidates evidence and mode', () => {
  it('excludes candidate, missing and mismatch edges and reports them', () => {
    const candidate = setup();
    candidate.store.saveEdge(candidateEdge('e-cand', 'a', 'b'));
    const rc = candidate.store.historicalAnchorCandidates('a');
    expect(rc.items.map((i) => i.node.id)).toEqual(['a']);
    expect(rc.gaps).toEqual(['candidate']);

    const missing = setup();
    missing.history.saveFragment(makeFragment('frag-miss'));
    missing.history.addTraversal(makeEvidence('ev-miss', 'frag-miss', A, B));
    missing.store.saveEdge(traversedEdge('e-miss', 'a', 'b', ['ev-miss']));
    missing.history.forgetFragment('frag-miss');
    const rm = missing.store.historicalAnchorCandidates('a');
    expect(rm.items.map((i) => i.node.id)).toEqual(['a']);
    expect(rm.gaps).toEqual(['missing']);

    const mismatch = setup();
    seedResolvedEdge(mismatch.history, mismatch.store, 'e-mm', 'a', 'b', 'ev-mm', 'frag-mm', A, B);
    mismatch.history.forgetFragment('frag-mm');
    mismatch.history.saveFragment(makeFragment('frag-mm'));
    mismatch.history.addTraversal(makeEvidence('ev-mm', 'frag-mm', A, B, { observedAt: 2000 }));
    const rx = mismatch.store.historicalAnchorCandidates('a');
    expect(rx.items.map((i) => i.node.id)).toEqual(['a']);
    expect(rx.gaps).toEqual(['mismatch']);
  });

  it('excludes an edge when one reference resolves but another is missing', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-1'));
    history.addTraversal(makeEvidence('ev-1', 'frag-1', A, B));
    history.saveFragment(makeFragment('frag-2'));
    history.addTraversal(makeEvidence('ev-2', 'frag-2', A, B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-1', 'ev-2']));
    history.forgetFragment('frag-2');

    const r = store.historicalAnchorCandidates('a');
    expect(r.items.map((i) => i.node.id)).toEqual(['a']);
    expect(r.gaps).toEqual(['missing']);
  });

  it('respects specified mode, unknown mode, known-unmatched mode, and mixed witness', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-walk', 'frag-ab', A, B, { mode: 'walk' }));
    history.addTraversal(makeEvidence('ev-swim', 'frag-ab', A, B, { mode: 'swim' }));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-walk', 'ev-swim']));

    const walk = store.historicalAnchorCandidates('a', { mode: 'walk', includeStart: false });
    expect(walk.items.map((i) => i.node.id)).toEqual(['b']);
    expect(walk.proofSegments[0]!.evidence.mode).toBe('walk');

    const jump = store.historicalAnchorCandidates('a', { mode: 'jump', includeStart: false });
    expect(jump.items).toEqual([]);
    expect(jump.gaps).toEqual([]); // known-but-unmatched is a normal filter

    // Unknown-mode evidence with a mode filter → mode_unknown gap.
    const unknown = setup();
    unknown.history.saveFragment(makeFragment('frag-ab'));
    unknown.history.addTraversal(makeEvidence('ev-u', 'frag-ab', A, B));
    unknown.store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-u']));
    const ru = unknown.store.historicalAnchorCandidates('a', { mode: 'walk', includeStart: false });
    expect(ru.items).toEqual([]);
    expect(ru.gaps).toEqual(['mode_unknown']);
  });

  it('picks the smallest evidenceId as the witness', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-z', 'frag-ab', A, B, { mode: 'walk' }));
    history.addTraversal(makeEvidence('ev-a', 'frag-ab', A, B, { mode: 'walk' }));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-z', 'ev-a']));

    const r = store.historicalAnchorCandidates('a', { mode: 'walk', includeStart: false });
    expect(r.proofSegments[0]!.evidenceId).toBe('ev-a');
  });

  it('keeps evidence_gaps or budget_exhausted even when candidates were returned', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    store.saveEdge(candidateEdge('e-ac', 'a', 'c'));
    const r = store.historicalAnchorCandidates('a');
    expect(r.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(r.disposition).toBe('evidence_gaps');
    expect(r.gaps).toEqual(['candidate']);
  });
});

describe('TopologyStore — historicalAnchorCandidates budgets and completeness', () => {
  it('distinguishes results truncation from an incomplete search', () => {
    const { store } = setupChain();
    const truncated = store.historicalAnchorCandidates('a', { includeStart: false, limit: 1, order: 'bfs' });
    expect(truncated.items).toHaveLength(1);
    expect(truncated.matchedCount).toBe(2);
    expect(truncated.resultsTruncated).toBe(true);
    expect(truncated.disposition).toBe('complete'); // truncation ≠ incomplete
  });

  it('keeps already-collected candidates and proof valid when each budget is exhausted', () => {
    // maxEdges=1: a→b collected, then b→c edge never inspected.
    const edges = setupChain();
    const re = edges.store.historicalAnchorCandidates('a', { maxEdges: 1 });
    expect(re.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(re.disposition).toBe('budget_exhausted');
    expect(re.proofSegments.map((s) => s.edgeId)).toEqual(['e-ab']);

    // maxNodes=2: a and b read, c's node read is refused.
    const nodes = setupChain();
    const rn = nodes.store.historicalAnchorCandidates('a', { maxNodes: 2 });
    expect(rn.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(rn.disposition).toBe('budget_exhausted');

    // maxHistoryReads=2: e-ab fully resolved (2 reads), e-bc's first read refused.
    const reads = setupChain();
    const rh = reads.store.historicalAnchorCandidates('a', { maxHistoryReads: 2 });
    expect(rh.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(rh.disposition).toBe('budget_exhausted');
    expect(rh.proofSegments.map((s) => s.edgeId)).toEqual(['e-ab']);
  });

  it('preserves a confirmed missing gap when the history budget runs out mid-edge', () => {
    const { history, store } = setup();
    history.saveFragment(makeFragment('frag-1'));
    history.addTraversal(makeEvidence('ev-1', 'frag-1', A, B));
    history.saveFragment(makeFragment('frag-2'));
    history.addTraversal(makeEvidence('ev-2', 'frag-2', A, B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-1', 'ev-2']));
    history.forgetFragment('frag-1');

    const r = store.historicalAnchorCandidates('a', { maxHistoryReads: 1 });
    expect(r.disposition).toBe('budget_exhausted');
    expect(r.gaps).toEqual(['missing']);
    expect(r.diagnostics[0]!.kind).toBe('missing');
  });

  it('keeps gap classification when maxDiagnostics=0', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    store.saveEdge(candidateEdge('e-ac', 'a', 'c'));
    const r = store.historicalAnchorCandidates('a', { maxDiagnostics: 0 });
    expect(r.disposition).toBe('evidence_gaps');
    expect(r.gaps).toEqual(['candidate']);
    expect(r.diagnostics).toEqual([]);
    expect(r.stats.diagnosticsTruncated).toBe(true);
  });

  it('returns no unvalidated start under maxNodes=0', () => {
    const { store } = setupChain();
    const r = store.historicalAnchorCandidates('a', { maxNodes: 0 });
    expect(r.items).toEqual([]);
    expect(r.disposition).toBe('budget_exhausted');
    expect(r.stats.nodesRead).toBe(0);
  });

  it('fails on missing/region start and invalid options', () => {
    const { store } = setupChain();
    expect(() => store.historicalAnchorCandidates('ghost')).toThrow(/unknown node/);

    const region = setup();
    region.store.saveNode(makeNode('r', pt(0, 64, 0), { location: { kind: 'region', center: pt(0, 64, 0), radius: 2 } }));
    expect(() => region.store.historicalAnchorCandidates('r')).toThrow(/not an exact location/);

    expect(() => store.historicalAnchorCandidates('a', { source: 'bogus' as never })).toThrow(/source/);
    expect(() => store.historicalAnchorCandidates('a', { tag: 'bogus' as never })).toThrow(/tag/);
    expect(() => store.historicalAnchorCandidates('a', { kind: 'bogus' as never })).toThrow(/kind/);
    expect(() => store.historicalAnchorCandidates('a', { order: 'bogus' as never })).toThrow(/order/);
    expect(() => store.historicalAnchorCandidates('a', { includeStart: 'yes' as never })).toThrow(/includeStart/);
  });

  it('validates limit default, clamping, and invalid values', () => {
    const { store } = setupChain();
    expect(store.historicalAnchorCandidates('a').items.length).toBe(3); // default limit 20 > 3
    expect(() => store.historicalAnchorCandidates('a', { limit: 0 })).toThrow(/limit/);
    expect(() => store.historicalAnchorCandidates('a', { limit: -1 })).toThrow(/limit/);
    expect(() => store.historicalAnchorCandidates('a', { limit: 1.5 })).toThrow(/limit/);
    expect(() => store.historicalAnchorCandidates('a', { limit: NaN })).toThrow(/limit/);
    expect(() => store.historicalAnchorCandidates('a', { limit: Infinity })).toThrow(/limit/);
    expect(() => store.historicalAnchorCandidates('a', { limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/limit/);

    const bounded = new TopologyStore(new FragmentStore(WORLD), { maxQueryBatch: 2 });
    bounded.saveNode(makeNode('a', A));
    bounded.saveNode(makeNode('b', B));
    bounded.saveNode(makeNode('c', C));
    expect(bounded.historicalAnchorCandidates('a', { limit: 50 }).items.length).toBeLessThanOrEqual(2);
    // Default limit is min(20, maxQueryBatch)=2 here.
    expect(bounded.historicalAnchorCandidates('a').items.length).toBeLessThanOrEqual(2);
  });

  it('accepts stable getter-provided options', () => {
    const { store } = setupChain();
    class Options implements HistoricalAnchorQueryOptions {
      get order(): 'highest' {
        return 'highest';
      }
      get limit(): number {
        return 1;
      }
    }
    const r = store.historicalAnchorCandidates('a', new Options());
    expect(r.items[0]!.node.id).toBe('b');
  });
});

describe('TopologyStore — historicalAnchorCandidates proof and isolation', () => {
  it('deduplicates shared prefixes and closes each candidate proof with correct hops', () => {
    const { history, store } = setup();
    store.updateNode('c', { tag: 'resource' });
    store.updateNode('d', { tag: 'resource' });
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);
    seedResolvedEdge(history, store, 'e-bd', 'b', 'd', 'ev-bd', 'frag-bd', B, D);

    const r = store.historicalAnchorCandidates('a', { tag: 'resource' });
    expect(r.items.map((i) => i.node.id)).toEqual(['c', 'd']);
    expect(r.items.map((i) => i.hops)).toEqual([2, 2]);
    // Shared e-ab returned once; each candidate's own edge returned once.
    expect(r.proofSegments.map((s) => s.edgeId)).toEqual(['e-ab', 'e-bc', 'e-bd']);
    // Predecessor-first: the shared e-ab comes before e-bc/e-bd.
    expect(r.proofSegments[0]!.from).toBe('a');
    expect(r.proofSegments[0]!.to).toBe('b');
  });

  it('does not emit proof for filtered-out leaves unless on a returned candidate path', () => {
    const { history, store } = setup();
    seedResolvedEdge(history, store, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(history, store, 'e-ac', 'a', 'c', 'ev-ac', 'frag-ac', A, C);
    // Return only b.
    const r = store.historicalAnchorCandidates('a', { includeStart: false, order: 'bfs', limit: 1 });
    expect(r.items.map((i) => i.node.id)).toEqual(['b']);
    expect(r.proofSegments.map((s) => s.edgeId)).toEqual(['e-ab']);
  });

  it('isolates returned snapshots and does not mutate history on query', () => {
    const { history, store } = setupChain();
    const before = history.getTraversal('ev-ab')!;
    const r = store.historicalAnchorCandidates('a');
    r.items[0]!.node.location = { kind: 'exact', pos: pt(999, 999, 999) };
    r.items[0]!.node.id = 'mutated';
    r.items.forEach((i) => {
      if (i.node.location.kind === 'exact') i.node.location.pos.y = 123;
    });
    r.proofSegments.length = 0;

    const again = store.historicalAnchorCandidates('a');
    expect(again.items[0]!.node.id).toBe('a');
    expect(again.items.map((i) => i.node.id)).toEqual(['a', 'b', 'c']);
    expect(again.proofSegments.length).toBe(2);
    expect(history.getTraversal('ev-ab')!.observedAt).toBe(before.observedAt);
    expect(history.getFragment('frag-ab')!.uses).toBe(1);
  });

  it('reflects delete / replace / re-import on the next query', () => {
    const { history, store } = setupChain();
    expect(store.historicalAnchorCandidates('a').items.map((i) => i.node.id)).toEqual(['a', 'b', 'c']);

    history.forgetFragment('frag-ab');
    const afterDelete = store.historicalAnchorCandidates('a');
    expect(afterDelete.items.map((i) => i.node.id)).toEqual(['a']);
    expect(afterDelete.gaps).toContain('missing');

    history.saveFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    expect(store.historicalAnchorCandidates('a').items.map((i) => i.node.id)).toEqual(['a', 'b', 'c']);
  });

  it('propagates history read errors rather than returning empty candidates', () => {
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
    expect(() => store.historicalAnchorCandidates('a')).toThrow(/history read failed/);
  });
});

describe('TopologyStore — historicalAnchorCandidates read counting', () => {
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

  it('caches per-query reads and uses the lightweight scope entry', () => {
    const history = new CountingHistory();
    history.addFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    history.addFragment(makeFragment('frag-bc'));
    history.addTraversal(makeEvidence('ev-bc', 'frag-bc', B, C));
    const store = new TopologyStore(history);
    store.saveNode(makeNode('a', A));
    store.saveNode(makeNode('b', B));
    store.saveNode(makeNode('c', C));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-ab']));
    store.saveEdge(traversedEdge('e-bc', 'b', 'c', ['ev-bc']));

    history.getTraversalCalls = 0;
    history.getFragmentCalls = 0;
    history.getFragmentScopeCalls = 0;

    const r = store.historicalAnchorCandidates('a');
    expect(r.items.map((i) => i.node.id)).toEqual(['a', 'b', 'c']);
    // Two edges × (1 traversal + 1 scope) = 4 history reads.
    expect(r.stats.historyReads).toBe(4);
    expect(history.getTraversalCalls).toBe(2);
    expect(history.getFragmentScopeCalls).toBe(2);
    expect(history.getFragmentCalls).toBe(0);
  });

  it('performs one search over a branching shared-prefix graph and bounds proof size', () => {
    const history = new CountingHistory();
    const store = new TopologyStore(history);
    const P: Vec3Like[] = [
      pt(0.5, 64, 0.5),
      pt(1.5, 65, 0.5),
      pt(2.5, 66, 0.5),
      pt(3.5, 67, 0.5),
      pt(4.5, 68, 0.5),
      pt(5.5, 69, 0.5),
    ];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id, i) => store.saveNode(makeNode(id, P[i]!)));
    store.updateNode('e', { tag: 'resource' });
    store.updateNode('f', { tag: 'resource' });

    const edge = (id: string, from: string, to: string, fi: number, ti: number): void => {
      history.addFragment(makeFragment(`frag-${id}`));
      history.addTraversal(makeEvidence(`ev-${id}`, `frag-${id}`, P[fi]!, P[ti]!));
      store.saveEdge(traversedEdge(id, from, to, [`ev-${id}`]));
    };
    edge('e-ab', 'a', 'b', 0, 1);
    edge('e-bc', 'b', 'c', 1, 2);
    edge('e-cd', 'c', 'd', 2, 3);
    edge('e-de', 'd', 'e', 3, 4);
    edge('e-df', 'd', 'f', 3, 5);

    history.getTraversalCalls = 0;
    history.getFragmentCalls = 0;
    history.getFragmentScopeCalls = 0;

    const r = store.historicalAnchorCandidates('a', { tag: 'resource' });
    expect(r.items.map((i) => i.node.id)).toEqual(['e', 'f']);
    expect(r.items.map((i) => i.hops)).toEqual([4, 4]);
    // Shared prefix a→b→c→d emitted once; total proof edges = nodes - 1 = 5.
    expect(r.proofSegments.map((s) => s.edgeId)).toEqual(['e-ab', 'e-bc', 'e-cd', 'e-de', 'e-df']);
    // One search: each edge's evidence read exactly once (5 traversals + 5 scopes).
    expect(r.stats.historyReads).toBe(10);
    expect(history.getTraversalCalls).toBe(5);
    expect(history.getFragmentScopeCalls).toBe(5);
    expect(history.getFragmentCalls).toBe(0);
  });

  it('falls back to getFragment for a source without the lightweight entry', () => {
    const history = new CountingHistory();
    history.addFragment(makeFragment('frag-ab'));
    history.addTraversal(makeEvidence('ev-ab', 'frag-ab', A, B));
    const store = new TopologyStore({
      worldId: WORLD,
      getTraversal: (id) => history.getTraversal(id),
      getFragment: (id) => history.getFragment(id),
    });
    store.saveNode(makeNode('a', A));
    store.saveNode(makeNode('b', B));
    store.saveEdge(traversedEdge('e-ab', 'a', 'b', ['ev-ab']));

    history.getTraversalCalls = 0;
    history.getFragmentCalls = 0;
    history.getFragmentScopeCalls = 0;

    const r = store.historicalAnchorCandidates('a');
    expect(r.items.map((i) => i.node.id)).toEqual(['a', 'b']);
    expect(history.getFragmentCalls).toBe(1); // fallback scope read
    expect(history.getTraversalCalls).toBe(1);
  });
});
