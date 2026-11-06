import { describe, expect, it } from 'vitest';

import type {
  MemoryIngest,
  Observation,
  ObservationBatch,
  ObservationGap,
  Vec3Like,
} from '../src/index.js';
import { FragmentStore, SpatialMemoryStoreImpl, VoxelMap } from '../src/index.js';
import {
  AIR,
  obs,
  pathFragment as makeFragment,
  STONE,
  traversalEvidence as makeEvidence,
} from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';
const A: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
const B: Vec3Like = { x: 1.5, y: 64, z: 0.5 };

function makeIngest(options: { fragments?: FragmentStore } = {}): {
  ingest: MemoryIngest;
  store: SpatialMemoryStoreImpl;
  map: VoxelMap;
  fragments: FragmentStore;
} {
  const map = new VoxelMap(WORLD, { now: () => 5000 });
  const fragments = options.fragments ?? new FragmentStore(WORLD);
  const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map, fragments });
  return { ingest: store, store, map, fragments };
}

const batch = (observations: Observation[], unobserved: ObservationGap[] = []): ObservationBatch => ({
  observations,
  unobserved,
});

describe('MemoryIngest — contract write port', () => {
  it('exposes no action or execution API', () => {
    type IngestKeys = keyof MemoryIngest;
    type Forbidden = Extract<
      IngestKeys,
      | 'moveTo'
      | 'swimTo'
      | 'stopAll'
      | 'dig'
      | 'placeBlockAt'
      | 'recentDug'
      | 'recentPlaced'
      | 'navigateTo'
      | 'walkPath'
      | 'planRoute'
      | 'observe'
    >;
    const noActionApi: Forbidden extends never ? true : false = true;
    expect(noActionApi).toBe(true);
  });

  it('accepts confirmed evidence, explicit air and real gaps atomically', () => {
    const { ingest, map } = makeIngest();
    const report = ingest.observeBatch(
      batch(
        [
          obs(AIR, { x: 0, y: 0, z: 0 }, { observedAt: 2000, sequence: 1 }),
          obs(STONE, { x: 0, y: -1, z: 0 }, { observedAt: 2000, sequence: 2 }),
          obs(STONE, { x: 1, y: 0, z: 0 }, {
            observedAt: 2000,
            sequence: 3,
            source: 'agent_action',
            evidence: 'confirmed_effect',
            actionId: 'act-1',
          }),
        ],
        [{ pos: { x: 2, y: 0, z: 0 }, reason: 'occluded' }],
      ),
    );

    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.gaps).toEqual([{ pos: { x: 2, y: 0, z: 0 }, reason: 'occluded' }]);
    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    expect(map.cellAt(DIM, 1, 0, 0)).toMatchObject({ observed: true });
    // A gap is not air and not a cell.
    expect(map.cellAt(DIM, 2, 0, 0)).toEqual({ observed: false });
  });

  it('rejects malformed evidence combinations before writing anything', () => {
    const { ingest, map } = makeIngest();
    const revision = map.saveRevision;

    expect(() =>
      ingest.observeBatch(
        batch([
          obs(STONE, { x: 0, y: 0, z: 0 }, {
            source: 'agent_action',
            evidence: 'seen',
          }),
        ]),
      ),
    ).toThrow(/agent_action observation must be a confirmed_effect/);

    expect(() =>
      ingest.observeBatch(
        batch([obs(STONE, { x: 0, y: 0, z: 0 }, { evidence: 'confirmed_effect' })]),
      ),
    ).toThrow(/requires the verified actionId/);

    expect(() =>
      ingest.observeBatch(
        batch([obs(STONE, { x: 0, y: 0, z: 0 }, { evidence: 'seen', actionId: 'act-1' })]),
      ),
    ).toThrow(/actionId is only valid with confirmed_effect/);

    expect(map.saveRevision).toBe(revision);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
  });

  it('requires contact evidence to acknowledge an incomplete state and never spreads it', () => {
    const { ingest, map } = makeIngest();

    expect(() =>
      ingest.observeBatch(
        batch([obs(STONE, { x: 0, y: 0, z: 0 }, { evidence: 'contact' })]),
      ),
    ).toThrow(/contact observation must be stateComplete=false/);

    const report = ingest.observeBatch(
      batch([
        obs(STONE, { x: 0, y: 0, z: 0 }, {
          evidence: 'contact',
          stateComplete: false,
          observedAt: 2000,
        }),
      ]),
    );
    expect(report.sections).toHaveLength(1);
    expect(map.cellAt(DIM, 0, 0, 0)).toMatchObject({ observed: true });
    // Contact proves this cell only; no neighbor is fabricated from it.
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
  });

  it('rejects a cross-world observation batch without partial writes', () => {
    const { ingest, map } = makeIngest();

    expect(() =>
      ingest.observeBatch(
        batch([
          obs(STONE, { x: 0, y: 0, z: 0 }),
          obs(STONE, { x: 1, y: 0, z: 0 }, { worldId: 'other' }),
        ]),
      ),
    ).toThrow(/does not match this store's world/);
    expect(map.cellAt(DIM, 0, 0, 0)).toEqual({ observed: false });
    expect(map.cellAt(DIM, 1, 0, 0)).toEqual({ observed: false });
  });

  it('records history flags only from explicit evidence', () => {
    const { ingest, map } = makeIngest();
    ingest.markTraversed(DIM, { x: 0, y: 64, z: 0 });
    ingest.markModified(DIM, { x: 1, y: 64, z: 0 }, 'act-1');

    expect(map.historyAt(DIM, 0, 64, 0)).toMatchObject({ traversed: true, modified: false });
    expect(map.historyAt(DIM, 1, 64, 0)).toMatchObject({ traversed: false, modified: true });
    expect(() => ingest.markModified(DIM, { x: 1, y: 64, z: 0 }, '')).toThrow(/actionId/);
    expect(() => ingest.markTraversed('', { x: 0, y: 64, z: 0 })).toThrow(/dim/);
  });

  it('saves fragment geometry without inventing traversal or an edge', () => {
    const { ingest, store, fragments } = makeIngest();
    ingest.saveFragment(
      makeFragment('bridge-1', {
        kind: 'bridge',
        geometrySource: 'observed_structure',
        polyline: [{ ...A }, { ...B }],
        links: [{ a: { ...A }, b: { ...B } }],
      }),
    );

    expect(fragments.getTraversal('anything')).toBeNull();
    expect(store.graph(DIM).edges).toEqual([]);
    expect(store.fragments(DIM)).toHaveLength(1);
    expect(() => ingest.saveFragment(makeFragment('other-world', { worldId: 'other' }))).toThrow(
      /does not match this store's world/,
    );
  });

  it('records traversal evidence only through the memory store', () => {
    const { ingest, fragments } = makeIngest();
    ingest.saveFragment(makeFragment('f1'));

    expect(ingest.addTraversal(makeEvidence('t1', 'f1', A, B))).toEqual({ status: 'inserted' });
    expect(ingest.addTraversal(makeEvidence('t1', 'f1', A, B))).toEqual({ status: 'unchanged' });
    expect(fragments.getTraversal('t1')).toMatchObject({ fragmentId: 'f1', from: A, to: B });

    expect(() =>
      ingest.addTraversal({ ...makeEvidence('t1', 'f1', A, B), worldId: 'other' }),
    ).toThrow(/does not match this store's world/);
  });

  it('records nodes, walk edges and portal edges without merging graphs', () => {
    const { ingest, store } = makeIngest();
    const portalFrom = ingest.recordNode('portal-a', { x: 0, y: 64, z: 0 }, 'portal', { dim: DIM });
    const portalTo = ingest.recordNode('portal-b', { x: 20, y: 64, z: 0 }, 'portal', {
      dim: DIM,
    });
    const far = ingest.recordNode('far', { x: 40, y: 64, z: 0 }, undefined, { dim: DIM });

    ingest.upsertEdge({
      id: 'walk-e',
      from: portalFrom.id,
      to: far.id,
      type: 'HORIZONTAL',
      directed: true,
      modes: ['walk'],
      verifications: [],
    });
    const traversal = {
      id: 'pt-1',
      edgeId: 'portal-e',
      direction: 'forward' as const,
      sessionId: 's1',
      observedAt: 1000,
      observationIds: ['o-1'],
      source: 'confirmed_walk',
    };
    ingest.savePortalEdge(
      { id: 'portal-e', from: portalFrom.id, to: portalTo.id },
      [traversal],
    );

    expect(store.graph(DIM).edges.map((edge) => edge.id)).toEqual(['walk-e']);
    expect(store.portalEdges().map((edge) => edge.id)).toEqual(['portal-e']);
    expect(store.portalEdges()[0]?.traversals).toHaveLength(1);

    ingest.addPortalTraversal('portal-e', {
      ...traversal,
      id: 'pt-2',
      direction: 'reverse',
      observedAt: 1500,
      observationIds: ['o-2'],
    });
    expect(store.portalEdges()[0]?.return).toHaveLength(1);
  });

  it('validates scope and identifiers on anchor, edge and portal writes', () => {
    const { ingest } = makeIngest();
    const a = ingest.recordNode('a', A, undefined, { dim: DIM });
    const b = ingest.recordNode('b', B, undefined, { dim: DIM });
    const traversal = {
      id: 'pt-1',
      edgeId: 'portal-e',
      direction: 'forward' as const,
      sessionId: 's1',
      observedAt: 1000,
      observationIds: ['o-1'],
      source: 'confirmed_walk',
    };

    expect(() => ingest.recordNode('missing-dim', A)).toThrow(/options.dim is required/);
    expect(() => ingest.markModified('', A, 'act-1')).toThrow(/dim/);
    expect(() =>
      ingest.upsertEdge({
        id: '',
        from: a.id,
        to: b.id,
        type: 'HORIZONTAL',
        directed: true,
        modes: ['walk'],
        verifications: [],
      }),
    ).toThrow(/edge id/);
    expect(() =>
      ingest.upsertEdge({
        id: 'e',
        from: '',
        to: b.id,
        type: 'HORIZONTAL',
        directed: true,
        modes: ['walk'],
        verifications: [],
      }),
    ).toThrow(/edge from/);
    expect(() =>
      ingest.upsertEdge({
        id: 'e-unknown',
        from: 'missing-node',
        to: b.id,
        type: 'HORIZONTAL',
        directed: true,
        modes: ['walk'],
        verifications: [],
      }),
    ).toThrow(/unknown node/);
    const otherDim = ingest.recordNode('other-dim', A, undefined, { dim: 'the_nether' });
    expect(() =>
      ingest.upsertEdge({
        id: 'e-cross-dim',
        from: a.id,
        to: otherDim.id,
        type: 'HORIZONTAL',
        directed: true,
        modes: ['walk'],
        verifications: [],
      }),
    ).toThrow(/span dimensions/);
    expect(() =>
      ingest.savePortalEdge({ id: 'p', from: a.id, to: 'missing-node' }, [traversal]),
    ).toThrow(/unknown node/);
    expect(() =>
      ingest.savePortalEdge({ id: 'p', from: a.id, to: b.id }, [
        { ...traversal, edgeId: 'other-edge' },
      ]),
    ).toThrow(/belongs to edge/);
    expect(() =>
      ingest.addPortalTraversal('missing-edge', { ...traversal, edgeId: 'missing-edge' }),
    ).toThrow(/unknown portal edge/);
  });

  it('marks stale through the port and keeps history', () => {
    const { ingest, map, store, fragments } = makeIngest();
    ingest.observeBatch(
      batch([obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 2000 })]),
    );
    ingest.saveFragment(makeFragment('f1'));
    ingest.addTraversal(makeEvidence('t1', 'f1', A, B));

    const report = ingest.markStale(DIM, 'observation_gap');
    expect(report.sections[0]?.cells[0]?.kind).toBe('staled');
    const stale = map.cellAt(DIM, 0, 0, 0);
    expect(stale.observed).toBe(true);
    if (!stale.observed) throw new Error('expected observed evidence');
    expect(stale.evidence.freshness).toBe('STALE');
    expect(store.fragments(DIM)).toHaveLength(1);
    expect(fragments.getTraversal('t1')).not.toBeNull();
    expect(() => ingest.markStale(DIM, 'made_up' as never)).toThrow(/stale reason is not known/);
  });

  it('switches sessions through the port and rejects late old-session evidence', () => {
    const { ingest, map } = makeIngest();
    ingest.beginSession('s1');
    ingest.observeBatch(
      batch([
        obs(STONE, { x: 0, y: 0, z: 0 }, {
          sessionId: 's1',
          observedAt: 2000,
          sequence: 1,
        }),
      ]),
    );

    const report = ingest.beginSession('s2');
    expect(report.sections[0]?.cells[0]?.kind).toBe('staled');

    const late = ingest.observeBatch(
      batch([
        obs(STONE, { x: 0, y: 0, z: 0 }, {
          sessionId: 's1',
          observedAt: 9000,
          sequence: 99,
        }),
      ]),
    );
    expect(late.sections).toEqual([]);
    const cell = map.cellAt(DIM, 0, 0, 0);
    expect(cell.observed).toBe(true);
    if (!cell.observed) throw new Error('expected observed evidence');
    expect(cell.evidence.observation.sessionId).toBe('s1');
    expect(cell.evidence.observation.observedAt).toBe(2000);
  });
});
