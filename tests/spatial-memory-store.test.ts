import { describe, expect, it } from 'vitest';

import {
  FragmentStore,
  TopologyStore,
  VoxelMap,
  WalkRouteSearch,
} from '../src/index.js';
import type {
  Observation,
  ObservationBatch,
  ObservationGap,
  SpatialNode,
  Vec3Like,
  WalkSearchRequest,
  WalkSearchSnapshot,
} from '../src/index.js';
import {
  SpatialMemoryScopeError,
  SpatialMemoryStoreImpl,
  SpatialMemoryUnsupportedError,
} from '../src/store/index.js';
import {
  AIR,
  bodyAt,
  fakeProvider,
  obs,
  pathFragment as makeFragment,
  STONE,
  traversalEvidence as makeEvidence,
} from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';

const A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
const B: Vec3Like = { x: 1.5, y: 64, z: 0.5 };
const C: Vec3Like = { x: 2.5, y: 64, z: 0.5 };
const FAR: Vec3Like = { x: 50.5, y: 64, z: 50.5 };
const FAR_NEXT: Vec3Like = { x: 51.5, y: 64, z: 50.5 };

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

interface StoreParts {
  store: SpatialMemoryStoreImpl;
  map: VoxelMap;
  fragments: FragmentStore;
  topology: TopologyStore;
}

function makeStore(
  overrides: {
    map?: VoxelMap;
    fragments?: FragmentStore;
    topology?: TopologyStore;
    frontierSource?: (dim: string, here: Vec3Like) => WalkSearchSnapshot | null;
  } = {},
): StoreParts {
  const map = overrides.map ?? new VoxelMap(WORLD, { now: () => 5000 });
  const fragments = overrides.fragments ?? new FragmentStore(WORLD);
  const topology = overrides.topology ?? new TopologyStore(fragments, { now: () => 5000 });
  const store = new SpatialMemoryStoreImpl({
    worldId: WORLD,
    map,
    fragments,
    topology,
    ...(overrides.frontierSource === undefined ? {} : { frontierSource: overrides.frontierSource }),
  });
  return { store, map, fragments, topology };
}

function floorCells(store: SpatialMemoryStoreImpl, xs: readonly number[]): void {
  for (const x of xs) {
    store.observe(obs(STONE, { x, y: -1, z: 0 }));
    store.observe(obs(AIR, { x, y: 0, z: 0 }));
    store.observe(obs(AIR, { x, y: 1, z: 0 }));
  }
}

function searchRequest(): WalkSearchRequest {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    target: { x: 3.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
  };
}

function drain(search: WalkRouteSearch, budget = 1000): WalkSearchSnapshot {
  const started = search.status();
  if (started === null) throw new Error('expected a started search');
  let snapshot = started;
  for (let i = 0; i < 10_000 && snapshot.state === 'PENDING'; i++) {
    snapshot = search.advance(budget);
  }
  return snapshot;
}

describe('SpatialMemoryStoreImpl — scope and world isolation', () => {
  it('refuses to compose runtime parts bound to a different world', () => {
    const fragments = new FragmentStore(WORLD);
    const topology = new TopologyStore(fragments);
    const otherFragments = new FragmentStore('other');

    expect(
      () =>
        new SpatialMemoryStoreImpl({
          worldId: WORLD,
          map: new VoxelMap('other'),
          fragments,
          topology,
        }),
    ).toThrow(SpatialMemoryScopeError);

    expect(
      () =>
        new SpatialMemoryStoreImpl({
          worldId: WORLD,
          fragments: otherFragments,
          topology: new TopologyStore(otherFragments),
        }),
    ).toThrow(SpatialMemoryScopeError);

    expect(
      () =>
        new SpatialMemoryStoreImpl({
          worldId: WORLD,
          map: new VoxelMap(WORLD),
          fragments,
          topology: new TopologyStore(otherFragments),
        }),
    ).toThrow(SpatialMemoryScopeError);
  });

  it('rejects cross-world writes before any cell is applied', () => {
    const { store, map } = makeStore();

    expect(() =>
      store.observe(obs(STONE, { x: 0, y: 0, z: 0 }, { worldId: 'other' })),
    ).toThrow(SpatialMemoryScopeError);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });

    expect(() =>
      store.observeBatch({
        observations: [
          obs(STONE, { x: 0, y: 0, z: 0 }),
          obs(STONE, { x: 1, y: 0, z: 0 }, { worldId: 'other' }),
        ],
        unobserved: [],
      }),
    ).toThrow(SpatialMemoryScopeError);
    // The whole batch was rejected, not half-applied.
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });

    expect(() => store.saveFragment(makeFragment('f', { worldId: 'other' }))).toThrow(
      SpatialMemoryScopeError,
    );
    expect(() => store.upsertNode(makeNode('n', A, { worldId: 'other' }))).toThrow(
      SpatialMemoryScopeError,
    );
  });
});

describe('SpatialMemoryStoreImpl — voxel state', () => {
  it('returns resident Section copies and never invents unobserved cells as air', () => {
    const { store, map } = makeStore();
    store.observe(obs(STONE, { x: -1, y: -2, z: -3 }));

    const section = store.sectionAt(DIM, -1, -2, -3);
    expect(section).not.toBeNull();
    expect(section?.key).toEqual({ worldId: WORLD, dim: DIM, cx: -1, cz: -1, sy: -1 });

    // A different cell in the same allocated Section is still never observed.
    expect(map.cellAt(DIM, -2, -2, -3)).toEqual({ observed: false });
    // A Section that was never allocated is not returned as empty air.
    expect(store.sectionAt(DIM, 100, 100, 100)).toBeNull();
    expect(store.sectionAt('the_nether', -1, -2, -3)).toBeNull();

    section?.palette.push('minecraft:bogus');
    expect(store.sectionAt(DIM, -1, -2, -3)?.palette).not.toContain('minecraft:bogus');
  });

  it('keeps stale evidence distinct from never-observed evidence on reads', () => {
    const { store, map } = makeStore();
    store.observe(obs(STONE, { x: 0, y: 0, z: 0 }));

    map.markStale(DIM, 'unloaded');
    const stale = map.cellAt(DIM, 0, 0, 0);
    expect(stale.observed).toBe(true);
    if (!stale.observed) throw new Error('expected observed evidence');
    expect(stale.evidence.freshness).toBe('STALE');
    expect(stale.evidence.observation.observedAt).toBe(1000);

    expect(store.sectionAt(DIM, 0, 0, 0)).not.toBeNull();
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
    // Reading through the store never refreshes the evidence.
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual(stale);
  });
});

describe('SpatialMemoryStoreImpl — batch and lifecycle write ports', () => {
  it('returns the batch change report and the requested gaps', () => {
    const { store, map } = makeStore();
    const batch: ObservationBatch = {
      observations: [
        obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 2000, sequence: 1 }),
        obs(AIR, { x: 1, y: 0, z: 0 }, { observedAt: 2000, sequence: 2 }),
      ],
      unobserved: [{ pos: { x: 2, y: 0, z: 0 }, reason: 'occluded' }],
    };

    const report = store.observeBatch(batch);

    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.key).toEqual({
      worldId: WORLD,
      dim: DIM,
      cx: 0,
      cz: 0,
      sy: 0,
    });
    expect(report.sections[0]?.invalidated).toBe(true);
    expect(report.sections[0]?.cells.map((cell) => cell.kind)).toEqual([
      'inserted',
      'inserted',
    ]);
    expect(report.gaps).toEqual(batch.unobserved);
    // A gap is a diagnostic: it never becomes a cell or air.
    expect(map.cellAt(DIM, 2, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
  });

  it('rejects an invalid batch before a single cell is written', () => {
    const { store, map, fragments } = makeStore();
    const revision = map.saveRevision;

    expect(() =>
      store.observeBatch({
        observations: [
          obs(STONE, { x: 0, y: 0, z: 0 }),
          obs(STONE, { x: 1, y: 0, z: 0 }, { worldId: 'other' }),
        ],
        unobserved: [],
      }),
    ).toThrow(SpatialMemoryScopeError);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
    expect(map.saveRevision).toBe(revision);

    expect(() =>
      store.observeBatch({
        observations: [
          obs(STONE, { x: 0, y: 0, z: 0 }),
          obs(STONE, { x: 1, y: 0, z: 0 }, { pos: { x: Number.NaN, y: 0, z: 0 } }),
        ],
        unobserved: [],
      }),
    ).toThrow(/integer grid coordinates/);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
    expect(map.saveRevision).toBe(revision);

    expect(() =>
      store.observeBatch({
        observations: [obs(STONE, { x: 0, y: 0, z: 0 })],
        unobserved: [{ pos: { x: 2, y: 0, z: 0 }, reason: 'bogus' } as unknown as ObservationGap],
      }),
    ).toThrow(/gap reason is not known/);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });

    expect(() =>
      store.observeBatch({ observations: [] } as unknown as ObservationBatch),
    ).toThrow(/observations and unobserved arrays/);
    // Malformed input is rejected by the owning validator, not by a native
    // TypeError from the store's scope pre-check.
    expect(() => store.observeBatch(null as unknown as ObservationBatch)).toThrow(
      /observations and unobserved arrays/,
    );
    expect(() =>
      store.observeBatch({
        observations: [null as unknown as Observation],
        unobserved: [],
      }),
    ).toThrow(/observation must be an object/);
    expect(fragments.revision).toBe(0);
  });

  it('switches sessions, reports stale evidence and rejects late old-session writes', () => {
    const { store, map, fragments } = makeStore();
    store.beginSession('s1');
    store.observeBatch({
      observations: [
        obs(STONE, { x: 0, y: 0, z: 0 }, { sessionId: 's1', observedAt: 2000, sequence: 1 }),
      ],
      unobserved: [],
    });
    store.saveFragment(makeFragment('f1'));
    const history = store.snapshot();

    const report = store.beginSession('s2');
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.invalidated).toBe(true);
    expect(report.sections[0]?.cells).toEqual([
      { pos: { x: 0, y: 0, z: 0 }, kind: 'staled' },
    ]);

    const stale = map.cellAt(DIM, 0, 0, 0);
    expect(stale.observed).toBe(true);
    if (!stale.observed) throw new Error('expected observed evidence');
    expect(stale.evidence.freshness).toBe('STALE');
    expect(stale.evidence.staleReason).toBe('observation_gap');
    expect(stale.evidence.observation.observedAt).toBe(2000);

    // A late old-session write is rejected even with a newer observedAt and sequence.
    const late = store.observeBatch({
      observations: [
        obs(STONE, { x: 0, y: 0, z: 0 }, { sessionId: 's1', observedAt: 9000, sequence: 99 }),
      ],
      unobserved: [],
    });
    expect(late.sections).toEqual([]);
    const afterLate = map.cellAt(DIM, 0, 0, 0);
    expect(afterLate.observed).toBe(true);
    if (!afterLate.observed) throw new Error('expected observed evidence');
    expect(afterLate.evidence.observation.sessionId).toBe('s1');
    expect(afterLate.evidence.observation.observedAt).toBe(2000);
    expect(afterLate.evidence.freshness).toBe('STALE');

    // A current-session write re-establishes current evidence.
    const fresh = store.observeBatch({
      observations: [
        obs(AIR, { x: 0, y: 0, z: 0 }, { sessionId: 's2', observedAt: 3000, sequence: 1 }),
      ],
      unobserved: [],
    });
    expect(fresh.sections).toHaveLength(1);
    const current = map.cellAt(DIM, 0, 0, 0);
    expect(current.observed).toBe(true);
    if (!current.observed) throw new Error('expected observed evidence');
    expect(current.evidence.freshness).toBe('FRESH');
    expect(current.evidence.observation.sessionId).toBe('s2');

    // Session changes never delete historical geometry or traversal history.
    expect(store.fragments(DIM).map((fragment) => fragment.id)).toEqual(['f1']);
    expect(fragments.revision).toBe(history.fragments.revision);
    expect(store.snapshot().fragments.total).toBe(1);

    // Same-session beginSession is an idempotent no-op.
    expect(store.beginSession('s2').sections).toEqual([]);
    expect(() => store.beginSession('')).toThrow(/sessionId/);
  });

  it('marks evidence stale without deleting history and validates the reason', () => {
    const { store, map, fragments } = makeStore();
    store.observeBatch({
      observations: [obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 2000 })],
      unobserved: [],
    });
    store.saveFragment(makeFragment('f1'));
    fragments.addTraversal(makeEvidence('t1', 'f1', A, B));

    const report = store.markStale(DIM, 'observation_gap');
    expect(report.sections[0]?.cells).toEqual([
      { pos: { x: 0, y: 0, z: 0 }, kind: 'staled' },
    ]);
    const stale = map.cellAt(DIM, 0, 0, 0);
    expect(stale.observed).toBe(true);
    if (!stale.observed) throw new Error('expected observed evidence');
    expect(stale.evidence.freshness).toBe('STALE');
    expect(stale.evidence.staleReason).toBe('observation_gap');
    expect(stale.evidence.observation.observedAt).toBe(2000);

    // Evidence acquired at or before the interruption boundary is rejected.
    const late = store.observeBatch({
      observations: [obs(AIR, { x: 0, y: 0, z: 0 }, { observedAt: 5000, sequence: 2 })],
      unobserved: [],
    });
    expect(late.sections).toEqual([]);

    expect(store.fragments(DIM)).toHaveLength(1);
    expect(fragments.getTraversal('t1')).not.toBeNull();
    expect(store.markStale('the_nether', 'unloaded').sections).toEqual([]);
    expect(() => store.markStale('', 'unloaded')).toThrow(/dim/);
    expect(() =>
      store.markStale(DIM, 'made_up' as unknown as Parameters<typeof store.markStale>[1]),
    ).toThrow(/stale reason is not known/);
  });

  it('adds traversal evidence with fragment, scope, idempotence, conflict and capacity rules', () => {
    const fragments = new FragmentStore(WORLD, { maxTraversals: 2 });
    const { store } = makeStore({ fragments });
    store.saveFragment(makeFragment('f1'));

    const evidence = makeEvidence('t1', 'f1', A, B);
    expect(store.addTraversal(evidence)).toEqual({ status: 'inserted' });
    expect(store.addTraversal(makeEvidence('t1', 'f1', A, B))).toEqual({
      status: 'unchanged',
    });
    expect(store.fragments(DIM)[0]).toMatchObject({ uses: 1, lastUsedAt: 1000 });

    // Same id, different content conflicts and leaves the original intact.
    expect(() => store.addTraversal(makeEvidence('t1', 'f1', A, C))).toThrow(
      /already exists with different content/,
    );
    expect(fragments.getTraversal('t1')?.to).toEqual(B);

    // Unknown fragment, cross-world and cross-dimension writes are rejected.
    expect(() => store.addTraversal(makeEvidence('t2', 'missing', A, B))).toThrow(
      /unknown fragment/,
    );
    expect(() =>
      store.addTraversal({ ...makeEvidence('t2', 'f1', A, B), worldId: 'other' }),
    ).toThrow(SpatialMemoryScopeError);
    expect(() =>
      store.addTraversal({ ...makeEvidence('t2', 'f1', A, B), dim: 'the_nether' }),
    ).toThrow(SpatialMemoryScopeError);
    expect(() =>
      store.addTraversal({ ...makeEvidence('t2', 'f1', A, B), fragmentId: '' }),
    ).toThrow(/fragmentId/);
    expect(fragments.getTraversal('t2')).toBeNull();

    // Capacity is a rejection, never a silent drop.
    expect(store.addTraversal(makeEvidence('t2', 'f1', B, C))).toEqual({
      status: 'inserted',
    });
    expect(() => store.addTraversal(makeEvidence('t3', 'f1', A, C))).toThrow(
      /capacity .* reached/,
    );
    expect(fragments.getTraversal('t3')).toBeNull();
    // Adding traversal evidence never creates a fragment or an edge.
    expect(store.fragments(DIM)).toHaveLength(1);
    expect(store.graph(DIM).edges).toHaveLength(0);
  });
});

describe('SpatialMemoryStoreImpl — fragments, nodes and edges', () => {
  it('round-trips fragments, nodes and candidate edges without mutating stored facts', () => {
    const { store, topology } = makeStore();
    store.saveFragment(makeFragment('f1'));

    const fragments = store.fragments(DIM);
    expect(fragments.map((fragment) => fragment.id)).toEqual(['f1']);
    fragments[0]?.polyline.push({ x: 9, y: 9, z: 9 });
    expect(store.fragments(DIM)[0]?.polyline).toHaveLength(2);

    const a = store.recordNode('home', A, 'base', { dim: DIM });
    const b = store.recordNode('shaft', B, undefined, { dim: DIM });
    expect(a.id).toMatch(/^agent:.*:home$/);
    expect(a.tag).toBe('base');
    expect(a.location).toEqual({ kind: 'exact', pos: A });
    // Same label + exact position is the same stable agent node, not a new one.
    expect(store.recordNode('home', A, undefined, { dim: DIM }).id).toBe(a.id);
    expect(() => store.upsertNode({ ...a, label: 'changed' })).toThrow(/already exists/);

    store.upsertEdge({
      id: 'e-candidate',
      from: a.id,
      to: b.id,
      type: 'HORIZONTAL',
      directed: false,
      modes: ['walk'],
      verifications: [],
    });

    const graph = store.graph(DIM);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort());
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      id: 'e-candidate',
      from: a.id,
      to: b.id,
      type: 'HORIZONTAL',
      // TopologyStore records are directional; presentation fields are not stored.
      directed: true,
      modes: [],
      verifications: [],
    });

    expect(store.edgesDetailed(DIM)[0]?.basis).toBe('candidate');
    expect(store.edgesDetailed(DIM)[0]?.resolution).toBeNull();
    // A candidate that claims evidence is rejected, not silently downgraded.
    expect(() =>
      store.upsertEdge({
        id: 'e-contradiction',
        from: a.id,
        to: b.id,
        type: 'HORIZONTAL',
        directed: true,
        modes: ['walk'],
        verifications: [],
        basis: 'candidate',
        evidenceIds: ['t1'],
      }),
    ).toThrow(/candidate edges must not reference/);
    // A candidate relation is not a recorded route: it surfaces as an evidence gap.
    expect(store.route(DIM, A, B)).toBeNull();
    expect(store.routeInspection(DIM, A, B).status).toBe('INSUFFICIENT_EVIDENCE');

    store.dropEdge(a.id, b.id);
    expect(store.graph(DIM).edges).toHaveLength(0);
    expect(topology.getNode(a.id)).not.toBeNull();
  });

  it('records traversed edges only with evidence, routes over them, and keeps history on severance', () => {
    const { store, map, fragments } = makeStore();
    store.saveFragment(makeFragment('f1'));
    const a = store.recordNode('a', A, undefined, { dim: DIM });
    const b = store.recordNode('b', B, undefined, { dim: DIM });
    fragments.addTraversal(makeEvidence('t1', 'f1', A, B));

    store.upsertEdge({
      id: 'e1',
      from: a.id,
      to: b.id,
      type: 'HORIZONTAL',
      directed: true,
      modes: ['walk'],
      verifications: [],
      evidenceIds: ['t1'],
    });

    const detailed = store.edgesDetailed(DIM)[0];
    expect(detailed?.basis).toBe('traversed');
    expect(detailed?.resolution).toBe('resolved');

    expect(store.route(DIM, A, B)).toEqual([A, B]);
    const found = store.routeInspection(DIM, A, B);
    expect(found.status).toBe('FOUND');
    expect(found.historicalGeometry).toBe(true);
    expect(found.executable).toBe(false);
    expect(found.currentPassability).toBe('UNKNOWN');
    expect(found.points).toEqual([A, B]);

    // The mode/hop/link geometric options are not silently ignored.
    expect(() => store.route(DIM, A, B, { hop: 7 })).toThrow(SpatialMemoryUnsupportedError);

    // Severing the current connection deletes only the edge record.
    store.dropEdge(a.id, b.id);
    expect(store.route(DIM, A, B)).toBeNull();
    expect(store.routeInspection(DIM, A, B).status).toBe('NO_RECORDED_ROUTE');
    expect(store.fragments(DIM).map((fragment) => fragment.id)).toEqual(['f1']);
    expect(fragments.getTraversal('t1')).not.toBeNull();
    expect(store.fragmentation(DIM).records).toBe(1);

    // Current-world invalidation does not rewrite history either.
    map.markStale(DIM, 'unloaded');
    expect(store.fragments(DIM)).toHaveLength(1);
    expect(fragments.getTraversal('t1')).not.toBeNull();
  });

  it('returns connected anchors without a whole-network fallback', () => {
    const { store, fragments } = makeStore();
    store.saveFragment(makeFragment('f1'));
    const start = store.recordNode('start', { x: 0.5, y: 60, z: 0.5 }, 'base', { dim: DIM });
    const top = store.recordNode('top', { x: 0.5, y: 80, z: 0.5 }, undefined, { dim: DIM });
    const deep = store.recordNode('deep', { x: 0.5, y: 40, z: 0.5 }, undefined, { dim: DIM });
    fragments.addTraversal(
      makeEvidence('t-top', 'f1', { x: 0.5, y: 60, z: 0.5 }, { x: 0.5, y: 80, z: 0.5 }),
    );
    fragments.addTraversal(
      makeEvidence('t-deep', 'f1', { x: 0.5, y: 60, z: 0.5 }, { x: 0.5, y: 40, z: 0.5 }),
    );
    store.upsertEdge({
      id: 'e-top',
      from: start.id,
      to: top.id,
      type: 'VERTICAL_SHAFT',
      directed: true,
      modes: ['climb'],
      verifications: [],
      evidenceIds: ['t-top'],
    });
    store.upsertEdge({
      id: 'e-deep',
      from: start.id,
      to: deep.id,
      type: 'VERTICAL_SHAFT',
      directed: true,
      modes: ['drop'],
      verifications: [],
      evidenceIds: ['t-deep'],
    });

    expect(store.surfaceAnchor(DIM, { x: 0.5, y: 60, z: 0.5 })?.pos).toEqual({
      x: 0.5,
      y: 80,
      z: 0.5,
    });
    expect(store.deepestAnchor(DIM, { x: 0.5, y: 60, z: 0.5 })?.pos).toEqual({
      x: 0.5,
      y: 40,
      z: 0.5,
    });
    // No connected start = no anchor; never the global deepest node.
    expect(store.deepestAnchor(DIM, { x: 100.5, y: 60, z: 100.5 })).toBeNull();
    expect(store.surfaceAnchor(DIM, { x: 100.5, y: 60, z: 100.5 })).toBeNull();
  });

  it('counts fragment components from recorded links and shared coordinates only', () => {
    const { store } = makeStore();
    store.saveFragment(makeFragment('f1', { polyline: [{ ...A }, { ...B }], links: [{ a: A, b: B }] }));
    store.saveFragment(
      makeFragment('f2', {
        polyline: [{ ...FAR }, { ...FAR_NEXT }],
        links: [{ a: FAR, b: FAR_NEXT }],
      }),
    );

    expect(store.fragmentation(DIM)).toMatchObject({
      records: 2,
      points: 4,
      components: 2,
    });

    // A shared coordinate joins the union-find component; no proximity edge is
    // invented for FAR/FAR_NEXT.
    store.saveFragment(makeFragment('f3', { polyline: [{ ...B }, { ...C }] }));
    const merged = store.fragmentation(DIM);
    // A/B are linked and f3 starts at B; FAR/FAR_NEXT form their own component;
    // C is a new coordinate with no connecting evidence, so it stays separate.
    expect(merged).toMatchObject({ records: 3, points: 5, components: 3 });
    expect(merged.pieces.some((piece) => piece.fragmentIds.includes('f3'))).toBe(true);
  });
});

describe('SpatialMemoryStoreImpl — frontier candidates', () => {
  it('returns an explicit unavailable result when no walk-search snapshot is supplied', () => {
    const { store } = makeStore();
    const here = { x: 1.5, y: 0, z: 0.5 };

    expect(store.describeCapabilities().frontierCandidates.available).toBe(false);
    expect(() => store.frontierCandidates(DIM, here)).toThrow(SpatialMemoryUnsupportedError);
    expect(store.frontierInspection(DIM, here)).toMatchObject({
      status: 'unavailable',
      worldId: WORLD,
      dim: DIM,
    });
  });

  it('projects only caller-supplied candidates and never selects or explores', () => {
    const map = new VoxelMap(WORLD, { now: () => 2000 });
    const fragments = new FragmentStore(WORLD);
    const topology = new TopologyStore(fragments);
    const writer = new SpatialMemoryStoreImpl({ worldId: WORLD, map, fragments, topology });
    floorCells(writer, [0, 1]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(searchRequest());
    const snapshot = drain(search);
    const provider = (dim: string): WalkSearchSnapshot | null =>
      dim === DIM ? snapshot : null;
    const store = new SpatialMemoryStoreImpl({
      worldId: WORLD,
      map,
      fragments,
      topology,
      frontierSource: provider,
    });
    const here = { x: 1.5, y: 0, z: 0.5 };

    const frontiers = store.frontierCandidates(DIM, here);
    expect(frontiers.length).toBeGreaterThan(0);
    for (const frontier of frontiers) {
      // The stance is OPEN-validated; the boundary itself is not claimed passable.
      expect(frontier.reachability).toBe('OPEN');
      expect(frontier.basis.length).toBeGreaterThan(0);
      // No history lookup was supplied, so this is unknown, never a fabricated false.
      expect(frontier.historicalConnection).toBe('unknown');
    }

    const inspection = store.frontierInspection(DIM, here);
    expect(inspection.status).toBe('available');
    if (inspection.status !== 'available') throw new Error('expected available frontier inspection');
    expect(inspection.historicalConnection).toBe('unknown');
    expect(inspection.result.selected).toBe(false);
    expect(inspection.result.explorationStarted).toBe(false);
    expect(inspection.result.candidates.length).toBe(frontiers.length);
    for (const candidate of inspection.result.candidates) {
      expect(candidate.historicalConnection).toBe('unknown');
    }

    // A provider that returns nothing for the dimension is unavailable, not an empty scan.
    expect(store.frontierInspection('the_nether', here)).toMatchObject({ status: 'unavailable' });
    expect(() => store.frontierCandidates('the_nether', here)).toThrow(
      SpatialMemoryUnsupportedError,
    );

    // A snapshot for another world is a scope error, never a cross-world read.
    const mismatched = new SpatialMemoryStoreImpl({
      worldId: WORLD,
      map,
      fragments,
      topology,
      frontierSource: () => ({ ...snapshot, worldId: 'other' }),
    });
    expect(() => mismatched.frontierCandidates(DIM, here)).toThrow(SpatialMemoryScopeError);
  });
});

describe('SpatialMemoryStoreImpl — read-only queries and capability reports', () => {
  it('leaves revisions, pins, residency and evidence untouched across read-only queries', () => {
    const map = new VoxelMap(WORLD, { now: () => 2000 });
    const fragments = new FragmentStore(WORLD);
    const topology = new TopologyStore(fragments, { now: () => 2000 });
    const seed = new SpatialMemoryStoreImpl({ worldId: WORLD, map, fragments, topology });
    seed.observe(obs(STONE, { x: 0, y: -1, z: 0 }));
    seed.observe(obs(AIR, { x: 0, y: 0, z: 0 }));
    seed.observe(obs(AIR, { x: 0, y: 1, z: 0 }));
    seed.observe(obs(AIR, { x: 1, y: 0, z: 0 }));
    seed.saveFragment(makeFragment('f1'));
    const a = seed.recordNode('a', A, undefined, { dim: DIM });
    const b = seed.recordNode('b', B, undefined, { dim: DIM });
    fragments.addTraversal(makeEvidence('t1', 'f1', A, B));
    seed.upsertEdge({
      id: 'e1',
      from: a.id,
      to: b.id,
      type: 'HORIZONTAL',
      directed: true,
      modes: ['walk'],
      verifications: [],
      evidenceIds: ['t1'],
    });

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(
      searchRequest(),
    );
    const snapshot = drain(search);
    const store = new SpatialMemoryStoreImpl({
      worldId: WORLD,
      map,
      fragments,
      topology,
      frontierSource: (dim) => (dim === DIM ? snapshot : null),
    });

    const capture = () => ({
      mapSaveRevision: map.saveRevision,
      pins: map.pinState(),
      residency: map.residentSize(),
      fragmentRevision: fragments.revision,
      topologyRevision: topology.revision,
      cell: map.cellAt(DIM, 0, 0, 0),
      section: map.sectionAt(DIM, 0, 0, 0),
      fragments: store.fragments(DIM),
      graph: store.graph(DIM),
      edges: store.edgesDetailed(DIM),
      fragmentation: store.fragmentation(DIM),
      anchors: [
        store.surfaceAnchor(DIM, A),
        store.deepestAnchor(DIM, A),
      ],
    });
    const before = capture();

    store.sectionAt(DIM, 0, 0, 0);
    store.fragments();
    store.fragments(DIM);
    store.graph(DIM);
    store.edgesDetailed(DIM);
    store.route(DIM, A, B);
    store.routeInspection(DIM, A, B);
    store.surfaceAnchor(DIM, A);
    store.deepestAnchor(DIM, A);
    store.fragmentation(DIM);
    store.describeCapabilities();
    store.snapshot();
    store.frontierCandidates(DIM, { x: 0.5, y: 0, z: 0.5 });
    store.frontierInspection(DIM, { x: 0.5, y: 0, z: 0.5 });
    store.inspectRoute(snapshot);
    store.query({ kind: 'cells', dim: DIM, positions: [A, B] });
    store.query({ kind: 'fragments', dim: DIM });
    store.query({ kind: 'traversals', dim: DIM });
    store.query({ kind: 'nodes', dim: DIM });
    store.query({ kind: 'edges', dim: DIM });
    store.query({ kind: 'portals' });
    store.query({ kind: 'historyRoute', dim: DIM, from: A, to: B });
    store.query({ kind: 'anchor', dim: DIM, here: A, order: 'surface' });
    store.query({ kind: 'components', dim: DIM });
    store.query({ kind: 'segments', fragmentId: 'missing' });
    store.query({ kind: 'resourceAnchors', dim: DIM });
    store.query({ kind: 'containerAnchors', dim: DIM });
    store.query({ kind: 'containerContents', dim: DIM });
    store.query({ kind: 'snapshot' });
    store.query({ kind: 'capabilities' });

    expect(capture()).toEqual(before);
  });

  it('records measured history flags and exposes an empty portal graph honestly', () => {
    const { store, map } = makeStore();
    expect(store.describeCapabilities().markTraversed.available).toBe(true);
    expect(store.describeCapabilities().markModified.available).toBe(true);
    expect(store.describeCapabilities().portalEdges.available).toBe(true);
    expect(store.describeCapabilities().query.available).toBe(true);
    expect(store.portalEdges()).toEqual([]);

    const cell = { x: 0, y: 64, z: 0 };
    store.markTraversed(DIM, cell);
    store.markModified(DIM, cell, 'act-1');
    expect(map.historyAt(DIM, cell.x, cell.y, cell.z)).toMatchObject({
      traversed: true,
      modified: true,
    });
    expect(store.markModified.bind(store, DIM, cell, '')).toThrow(/actionId/);
  });

  it('summarizes runtime counts and capabilities without changing them', () => {
    const { store, map } = makeStore();
    store.observe(obs(STONE, { x: 0, y: 0, z: 0 }));
    store.saveFragment(makeFragment('f1'));
    store.recordNode('home', A, undefined, { dim: DIM });

    const capabilities = store.describeCapabilities();
    expect(Object.keys(capabilities).sort()).toEqual([
      'addPortalTraversal',
      'addTraversal',
      'beginSession',
      'blockEdge',
      'clearEdgeBlock',
      'components',
      'deepestAnchor',
      'displayNodes',
      'dropEdge',
      'edgeRuntime',
      'forgetFragment',
      'fragmentation',
      'fragments',
      'frontierCandidates',
      'goneNear',
      'graph',
      'markGone',
      'markModified',
      'markStale',
      'markTraversed',
      'mergeFragments',
      'observe',
      'observeBatch',
      'portalEdges',
      'query',
      'recordNode',
      'route',
      'saveFragment',
      'savePortalEdge',
      'sectionAt',
      'segments',
      'subscribeChanges',
      'surfaceAnchor',
      'upsertEdge',
      'upsertNode',
      'verifyEdge',
    ]);
    expect(capabilities.portalEdges.available).toBe(true);
    expect(capabilities.frontierCandidates.available).toBe(false);
    expect(capabilities.observe.available).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.worldId).toBe(WORLD);
    expect(snapshot.voxel.saveRevision).toBe(map.saveRevision);
    expect(snapshot.fragments).toEqual({ revision: 1, total: 1 });
    expect(snapshot.topology.nodes).toBe(1);
    expect(snapshot.topology.edges).toBe(0);
    expect(snapshot.capabilities).toEqual(capabilities);
  });
});
