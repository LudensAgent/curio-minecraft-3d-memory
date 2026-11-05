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

const A = pt(0.5, 64, 0.5);
const B = pt(1.5, 64, 0.5);
const C = pt(2.5, 64, 0.5);

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

function fragment(id: string, overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [],
    polyline: [A, B],
    geometrySource: 'traversal',
    deepestY: 64,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

function evidence(
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

function openVerification(overrides: Partial<EdgeVerificationInput> = {}): EdgeVerificationInput {
  return {
    direction: 'forward',
    mode: 'walk',
    status: 'OPEN',
    computedAt: 900,
    validUntil: 2000,
    sessionId: 's1',
    contextKey: 'body:0.6x1.8',
    dependencies: [],
    ...overrides,
  };
}

function contactEvidence(observedAt = 950) {
  return {
    kind: 'contact' as const,
    pos: { ...A },
    observedAt,
    sessionId: 's1',
  };
}

/** a/b/c nodes, one resolved a→b edge backed by a fragment. */
function setup() {
  let now = 1000;
  const history = new FragmentStore(WORLD);
  history.saveFragment(fragment('frag-ab'));
  history.addTraversal(evidence('ev-ab', 'frag-ab', A, B));
  const store = new TopologyStore(history, { now: () => now });
  store.saveNode(node('a', A));
  store.saveNode(node('b', B));
  store.saveNode(node('c', C));
  store.saveEdge({
    id: 'e-ab',
    from: 'a',
    to: 'b',
    type: 'HORIZONTAL',
    basis: 'traversed',
    evidenceIds: ['ev-ab'],
    fragmentId: 'frag-ab',
  });
  return {
    history,
    store,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('TopologyStore — runtime edge verification', () => {
  it('reports direction and mode separately, never OPEN without a verification', () => {
    const { store } = setup();
    const view = store.edgeRuntime('e-ab')!;
    const walk = view.forward.modes.find((m) => m.mode === 'walk')!;
    expect(walk.status).toBe('UNKNOWN');
    expect(walk.verified).toBe(false);
    expect(walk.fresh).toBe(false);
    expect(view.reverse.supported).toBe(false);
    expect(view.reverse.status).toBe('UNSUPPORTED');
    expect(store.edgeRuntime('missing')).toBeNull();

    // The historical route still works, but it does not claim current OPEN.
    expect(store.route('a', 'b').status).toBe('FOUND');
  });

  it('accepts a fresh OPEN and exposes it per direction/mode', () => {
    const { store } = setup();
    expect(store.verifyEdge('e-ab', openVerification()).status).toBe('updated');
    const view = store.edgeRuntime('e-ab')!;
    const walk = view.forward.modes.find((m) => m.mode === 'walk')!;
    expect(walk.status).toBe('OPEN');
    expect(walk.verified).toBe(true);
    expect(walk.fresh).toBe(true);
    expect(view.forward.status).toBe('OPEN');
    expect(view.reverse.status).toBe('UNSUPPORTED');
    // Other modes stay unverified.
    expect(view.forward.modes.find((m) => m.mode === 'swim')!.verified).toBe(false);
  });

  it('rejects an OPEN verification without fresh evidence', () => {
    const { store } = setup();
    expect(() =>
      store.verifyEdge('e-ab', openVerification({ computedAt: 400, validUntil: 500 })),
    ).toThrow(/fresh/);
    expect(() => store.verifyEdge('e-ab', openVerification({ computedAt: 2000 }))).toThrow(/future/);
    expect(() => store.verifyEdge('e-ab', openVerification({ sessionId: '' }))).toThrow(/session/);
    expect(() => store.verifyEdge('e-ab', openVerification({ contextKey: '' }))).toThrow(/contextKey/);
    expect(() => store.verifyEdge('e-ab', openVerification({ validUntil: Number.NaN }))).toThrow(/finite/);
  });

  it('expires OPEN into STALE and excludes the route until revalidated', () => {
    const { store, setNow } = setup();
    store.verifyEdge('e-ab', openVerification({ validUntil: 2000 }));
    expect(store.route('a', 'b').status).toBe('FOUND');

    setNow(2500);
    const walk = store.edgeRuntime('e-ab')!.forward.modes.find((m) => m.mode === 'walk')!;
    expect(walk.status).toBe('STALE');
    expect(walk.fresh).toBe(false);
    const route = store.route('a', 'b');
    expect(route.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(route.gaps).toContain('stale');

    // A fresh revalidation restores OPEN.
    store.verifyEdge('e-ab', openVerification({ computedAt: 2400, validUntil: 4000 }));
    expect(store.route('a', 'b').status).toBe('FOUND');
  });

  it('aggregates a stale mode ahead of another mode still OPEN', () => {
    const { store, setNow } = setup();
    store.verifyEdge('e-ab', openVerification({ mode: 'walk', computedAt: 900, validUntil: 4000 }));
    store.verifyEdge('e-ab', openVerification({ mode: 'drop', computedAt: 900, validUntil: 1500 }));
    setNow(2000);
    const view = store.edgeRuntime('e-ab')!;
    expect(view.forward.modes.find((m) => m.mode === 'walk')!.status).toBe('OPEN');
    expect(view.forward.modes.find((m) => m.mode === 'drop')!.status).toBe('STALE');
    // An expired verification must not be hidden behind another OPEN mode.
    expect(view.forward.status).toBe('STALE');
  });

  it('blocks a direction without deleting the fragment, and excludes it from route/adjacency', () => {
    const { history, store } = setup();
    expect(
      store.blockEdge('e-ab', {
        mode: 'walk',
        blockedAt: contactEvidence(),
        computedAt: 950,
        validUntil: 3000,
        sessionId: 's1',
        contextKey: 'body:0.6x1.8',
      }).status,
    ).toBe('updated');

    // History is untouched.
    expect(history.getFragment('frag-ab')).not.toBeNull();
    expect(history.getTraversal('ev-ab')).not.toBeNull();
    expect(store.getEdge('e-ab')).not.toBeNull();

    const route = store.route('a', 'b');
    expect(route.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(route.gaps).toEqual(['blocked']);

    expect(store.adjacency('a').outEdges).toEqual([]);
    expect(store.adjacency('a', { includeBlocked: true }).outEdges.map((e) => e.id)).toEqual(['e-ab']);

    const walk = store.edgeRuntime('e-ab')!.forward.modes.find((m) => m.mode === 'walk')!;
    expect(walk.status).toBe('BLOCKED');
    expect(walk.blocked).toBe(true);
    expect(walk.verification!.blockedAt).toEqual(contactEvidence());
  });

  it('requires obstacle evidence for BLOCKED and does not accept BLOCKED through verifyEdge', () => {
    const { store } = setup();
    expect(() =>
      store.verifyEdge('e-ab', openVerification({ status: 'BLOCKED' })),
    ).toThrow(/blockEdge/);
    expect(() =>
      store.blockEdge('e-ab', {
        mode: 'walk',
        blockedAt: undefined as never,
        computedAt: 950,
        validUntil: 3000,
      }),
    ).toThrow(/obstacle evidence/);
    expect(() =>
      store.verifyEdge('e-ab', openVerification({ status: 'OPEN', blockedAt: contactEvidence() } as never)),
    ).toThrow(/blockedAt/);
  });

  it('clearEdgeBlock goes to explicit UNKNOWN, never straight back to OPEN', () => {
    const { store } = setup();
    store.blockEdge('e-ab', {
      mode: 'walk',
      blockedAt: contactEvidence(),
      computedAt: 950,
      validUntil: 3000,
      sessionId: 's1',
      contextKey: 'body:0.6x1.8',
    });
    expect(store.clearEdgeBlock('e-ab', 'forward', 'walk').status).toBe('updated');
    const walk = store.edgeRuntime('e-ab')!.forward.modes.find((m) => m.mode === 'walk')!;
    expect(walk.status).toBe('UNKNOWN');
    expect(walk.verified).toBe(true);
    expect(walk.blocked).toBe(false);
    expect(walk.verification!.blockedAt).toBeUndefined();

    // Still excluded until a fresh OPEN is recorded.
    expect(store.route('a', 'b').status).toBe('INSUFFICIENT_EVIDENCE');
    store.verifyEdge('e-ab', openVerification());
    expect(store.route('a', 'b').status).toBe('FOUND');
    // Clearing again with nothing blocked is a no-op.
    expect(store.clearEdgeBlock('e-ab', 'forward', 'walk').status).toBe('unchanged');
  });

  it('never lets forward OPEN authorize the reverse direction', () => {
    let now = 1000;
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment('frag-ab', { polyline: [A, B] }));
    history.addTraversal(evidence('ev-ab', 'frag-ab', A, B));
    history.addTraversal(evidence('ev-ba', 'frag-ab', B, A));
    const store = new TopologyStore(history, { now: () => now });
    store.saveNode(node('a', A));
    store.saveNode(node('b', B));
    store.saveEdge({
      id: 'e-both',
      from: 'a',
      to: 'b',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-ab', 'ev-ba'],
      directed: false,
    });

    store.verifyEdge('e-both', openVerification({ direction: 'forward' }));
    const view = store.edgeRuntime('e-both')!;
    expect(view.directed).toBe(false);
    expect(view.forward.modes.find((m) => m.mode === 'walk')!.status).toBe('OPEN');
    const reverse = view.reverse.modes.find((m) => m.mode === 'walk')!;
    expect(reverse.verified).toBe(false);
    expect(reverse.status).toBe('UNKNOWN');

    // Reverse still has its own historical evidence and routes.
    const forwardRoute = store.route('a', 'b');
    expect(forwardRoute.status).toBe('FOUND');
    expect(forwardRoute.segments[0]!.direction).toBe('forward');
    const reverseRoute = store.route('b', 'a');
    expect(reverseRoute.status).toBe('FOUND');
    expect(reverseRoute.segments[0]!.direction).toBe('reverse');
    expect(reverseRoute.segments[0]!.evidenceId).toBe('ev-ba');

    // Blocking reverse does not block forward.
    store.blockEdge('e-both', {
      direction: 'reverse',
      mode: 'walk',
      blockedAt: contactEvidence(),
      computedAt: 950,
      validUntil: 3000,
    });
    expect(store.route('b', 'a').status).toBe('INSUFFICIENT_EVIDENCE');
    expect(store.route('a', 'b').status).toBe('FOUND');
  });

  it('does not route reverse on an undirected edge without reverse traversal evidence', () => {
    let now = 1000;
    const history = new FragmentStore(WORLD);
    history.saveFragment(fragment('frag-ab'));
    history.addTraversal(evidence('ev-ab', 'frag-ab', A, B));
    const store = new TopologyStore(history, { now: () => now });
    store.saveNode(node('a', A));
    store.saveNode(node('b', B));
    store.saveEdge({
      id: 'e-both',
      from: 'a',
      to: 'b',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev-ab'],
      directed: false,
    });
    expect(store.route('a', 'b').status).toBe('FOUND');
    expect(store.route('b', 'a').status).toBe('NO_RECORDED_ROUTE');
  });

  it('rejects reverse verification on a directed edge and unknown edge ids', () => {
    const { store } = setup();
    expect(() =>
      store.verifyEdge('e-ab', openVerification({ direction: 'reverse' })),
    ).toThrow(/reverse/);
    expect(() => store.verifyEdge('ghost', openVerification())).toThrow(/unknown edge/);
    expect(() => store.clearEdgeBlock('ghost')).toThrow(/unknown edge/);
  });

  it('refuses verification modes the edge does not carry and filters routes by candidate mode', () => {
    const { store } = setup();
    store.updateEdge('e-ab', { modes: ['walk'] });
    expect(() => store.verifyEdge('e-ab', openVerification({ mode: 'swim' }))).toThrow(/candidate mode/);
    expect(store.route('a', 'b', { mode: 'swim' }).status).toBe('NO_RECORDED_ROUTE');
    // The traversal evidence does not name a mode, so a walk filter is an explicit gap.
    const walk = store.route('a', 'b', { mode: 'walk' });
    expect(walk.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(walk.gaps).toEqual(['mode_unknown']);
  });

  it('round-trips runtime verification records through a checkpoint', () => {
    let now = 1000;
    const { history, store } = setup();
    store.verifyEdge('e-ab', openVerification());
    store.blockEdge('e-ab', {
      mode: 'jump',
      blockedAt: contactEvidence(),
      computedAt: 950,
      validUntil: 3000,
    });
    const snapshot = store.checkpointSnapshot();
    const raw = snapshot.edges[0]!;
    expect(raw.directed).toBe(true);
    expect(raw.verifications?.map((v) => `${v.direction}:${v.mode}:${v.status}`)).toEqual([
      'forward:walk:OPEN',
      'forward:jump:BLOCKED',
    ]);

    const restored = new TopologyStore(history, { now: () => now });
    restored.restoreSnapshot(snapshot);
    const view = restored.edgeRuntime('e-ab')!;
    expect(view.forward.modes.find((m) => m.mode === 'walk')!.status).toBe('OPEN');
    const jump = view.forward.modes.find((m) => m.mode === 'jump')!;
    expect(jump.status).toBe('BLOCKED');
    expect(jump.verification!.blockedAt).toEqual(contactEvidence());

    // An expired OPEN restores as STALE, never as OPEN.
    now = 5000;
    expect(restored.edgeRuntime('e-ab')!.forward.modes.find((m) => m.mode === 'walk')!.status).toBe(
      'STALE',
    );
  });

  it('is idempotent for identical verification and isolates stored snapshots', () => {
    const { store } = setup();
    expect(store.verifyEdge('e-ab', openVerification()).status).toBe('updated');
    expect(store.verifyEdge('e-ab', openVerification()).status).toBe('unchanged');
    const view = store.getEdge('e-ab')!;
    expect(view.runtime.forward.modes.find((m) => m.mode === 'walk')!.status).toBe('OPEN');
    view.verifications[0]!.contextKey = 'mutated';
    view.runtime.forward.modes.length = 0;
    expect(store.getEdge('e-ab')!.verifications[0]!.contextKey).toBe('body:0.6x1.8');
    expect(store.getEdge('e-ab')!.runtime.forward.modes.length).toBeGreaterThan(0);
  });
});
