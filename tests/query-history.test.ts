import { describe, expect, it } from 'vitest';

import type {
  AnchorResult,
  ComponentReport,
  FragmentSegmentsResult,
  HistoricalRouteInspection,
  Vec3Like,
} from '../src/index.js';
import type { SpatialQueryResult } from '../src/query/types.js';
import { AIR, obs, pathFragment, traversalEvidence } from './fakes.js';
import {
  A,
  B,
  C,
  DIM,
  WORLD,
  captureComponentCache,
  captureStoreState,
  makeNode,
  makeQueryParts,
  runQuery,
  type QueryParts,
} from './query-fixtures.js';

/** Save a resolved traversed edge, creating its own fragment + traversal. */
function seedResolvedEdge(
  parts: QueryParts,
  edgeId: string,
  fromId: string,
  toId: string,
  evidenceId: string,
  fragmentId: string,
  from: Vec3Like,
  to: Vec3Like,
): void {
  parts.fragments.saveFragment(
    pathFragment(fragmentId, {
      entrances: [{ ...from }],
      polyline: [{ ...from }, { ...to }],
      deepestY: Math.min(from.y, to.y),
    }),
  );
  parts.fragments.addTraversal(traversalEvidence(evidenceId, fragmentId, from, to));
  parts.topology.saveEdge({
    id: edgeId,
    from: fromId,
    to: toId,
    type: 'HORIZONTAL',
    basis: 'traversed',
    evidenceIds: [evidenceId],
  });
}

function routeInspectionOf(result: SpatialQueryResult): HistoricalRouteInspection {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('historyRoute');
  if (result.data?.kind !== 'historyRoute') throw new Error('expected historyRoute data');
  return result.data.inspection;
}

function anchorOf(result: SpatialQueryResult): AnchorResult | null {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('anchor');
  if (result.data?.kind !== 'anchor') throw new Error('expected anchor data');
  return result.data.anchor;
}

function componentsOf(result: SpatialQueryResult): ComponentReport {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('components');
  if (result.data?.kind !== 'components') throw new Error('expected components data');
  return result.data.report;
}

function segmentsOf(result: SpatialQueryResult): FragmentSegmentsResult {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('segments');
  if (result.data?.kind !== 'segments') throw new Error('expected segments data');
  return result.data.segments;
}

function chainParts(): QueryParts {
  const parts = makeQueryParts();
  parts.topology.saveNode(makeNode('a', A));
  parts.topology.saveNode(makeNode('b', B));
  parts.topology.saveNode(makeNode('c', C));
  seedResolvedEdge(parts, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
  seedResolvedEdge(parts, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);
  return parts;
}

describe('queryHistory — historyRoute', () => {
  it('returns an ordered FOUND historical route without executable claims', () => {
    const parts = chainParts();

    const result = runQuery(parts, {
      kind: 'historyRoute',
      dim: DIM,
      from: A,
      to: C,
      near: 5,
    });

    expect(result.status).toBe('ok');
    expect(result.readOnly).toBe(true);
    expect(result.executable).toBe(false);
    expect(result.worldId).toBe(WORLD);
    expect(result.dim).toBe(DIM);

    const inspection = routeInspectionOf(result);
    expect(inspection.status).toBe('FOUND');
    expect(inspection.points).toEqual([A, B, C]);
    expect(inspection.nodeIds).toEqual(['a', 'b', 'c']);
    expect(inspection.edgeIds).toEqual(['e-ab', 'e-bc']);
    expect(inspection.from).toEqual(A);
    expect(inspection.to).toEqual(C);
    expect(inspection.near).toBe(5);
    // Historical geometry is never an executable or a current-passability claim.
    expect(inspection.historicalGeometry).toBe(true);
    expect(inspection.executable).toBe(false);
    expect(inspection.currentPassability).toBe('UNKNOWN');
  });

  it('reports ENDPOINT_NOT_RECORDED as an ok envelope with no points', () => {
    const parts = makeQueryParts();
    const farFrom: Vec3Like = { x: 100.5, y: 64, z: 100.5 };
    const farTo: Vec3Like = { x: 120.5, y: 64, z: 120.5 };

    const result = runQuery(parts, {
      kind: 'historyRoute',
      dim: DIM,
      from: farFrom,
      to: farTo,
    });

    expect(result.status).toBe('ok');
    const inspection = routeInspectionOf(result);
    expect(inspection.status).toBe('ENDPOINT_NOT_RECORDED');
    expect(inspection.points).toEqual([]);
    expect(inspection.fromNodeId).toBeNull();
    expect(inspection.toNodeId).toBeNull();
  });

  it('reports NO_RECORDED_ROUTE when both endpoints exist but no connection is recorded', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A));
    parts.topology.saveNode(makeNode('b', B));
    parts.topology.saveNode(makeNode('c', C));

    const inspection = routeInspectionOf(
      runQuery(parts, { kind: 'historyRoute', dim: DIM, from: A, to: C, near: 5 }),
    );

    expect(inspection.status).toBe('NO_RECORDED_ROUTE');
    expect(inspection.fromNodeId).toBe('a');
    expect(inspection.toNodeId).toBe('c');
    expect(inspection.points).toEqual([]);
  });

  it('accepts near:0 for nodes exactly at the endpoints', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A));
    parts.topology.saveNode(makeNode('b', B));
    seedResolvedEdge(parts, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);

    const inspection = routeInspectionOf(
      runQuery(parts, { kind: 'historyRoute', dim: DIM, from: A, to: B, near: 0 }),
    );

    expect(inspection.status).toBe('FOUND');
    expect(inspection.near).toBe(0);
    expect(inspection.fromNodeId).toBe('a');
    expect(inspection.toNodeId).toBe('b');
  });

  it.each([-1, Number.NaN])('rejects near:%s as invalid_request', (near) => {
    const parts = makeQueryParts();

    const result = runQuery(parts, {
      kind: 'historyRoute',
      dim: DIM,
      from: A,
      to: C,
      near,
    });

    expect(result.status).toBe('invalid_request');
    expect(result.problem?.kind).toBe('invalid_request');
    expect(result.executable).toBe(false);
    expect(result.data).toBeUndefined();
    // Rejected before any source method ran.
    expect(parts.fragments.revision).toBe(0);
    expect(parts.topology.revision).toBe(0);
  });
});

describe('queryHistory — anchor', () => {
  const HIGH: Vec3Like = { x: 1.5, y: 70, z: 0.5 };
  const DEEP: Vec3Like = { x: 2.5, y: 60, z: 0.5 };

  function anchorParts(): QueryParts {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A));
    parts.topology.saveNode(makeNode('b', HIGH));
    parts.topology.saveNode(makeNode('c', DEEP));
    seedResolvedEdge(parts, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, HIGH);
    seedResolvedEdge(parts, 'e-ac', 'a', 'c', 'ev-ac', 'frag-ac', A, DEEP);
    return parts;
  }

  it('returns the highest/lowest reachable exact anchor for the requested order', () => {
    const parts = anchorParts();

    const surface = anchorOf(
      runQuery(parts, { kind: 'anchor', dim: DIM, here: A, order: 'surface' }),
    );
    expect(surface).not.toBeNull();
    expect(surface?.nodeId).toBe('b');
    expect(surface?.y).toBe(70);
    expect(surface?.precision).toBe('exact');
    expect(surface?.startNodeId).toBe('a');

    const deepest = anchorOf(
      runQuery(parts, { kind: 'anchor', dim: DIM, here: A, order: 'deepest' }),
    );
    expect(deepest).not.toBeNull();
    expect(deepest?.nodeId).toBe('c');
    expect(deepest?.y).toBe(60);
  });

  it('returns a null anchor (not not_found) when nothing is near here', () => {
    const parts = anchorParts();
    const farHere: Vec3Like = { x: 500, y: 64, z: 500 };

    const surface = anchorOf(
      runQuery(parts, { kind: 'anchor', dim: DIM, here: farHere, order: 'surface' }),
    );
    const deepest = anchorOf(
      runQuery(parts, { kind: 'anchor', dim: DIM, here: farHere, order: 'deepest' }),
    );

    expect(surface).toBeNull();
    expect(deepest).toBeNull();
  });

  it('forwards near to the store selection radius', () => {
    const parts = anchorParts();
    // On the -x axis `a` is the nearest node, so a large radius selects it as
    // the start and `b` is the highest reachable anchor from that component.
    const farHere: Vec3Like = { x: -500, y: 64, z: 0.5 };

    expect(
      anchorOf(
        runQuery(parts, {
          kind: 'anchor',
          dim: DIM,
          here: farHere,
          order: 'surface',
          near: 1000,
        }),
      )?.nodeId,
    ).toBe('b');
    expect(
      anchorOf(
        runQuery(parts, {
          kind: 'anchor',
          dim: DIM,
          here: farHere,
          order: 'surface',
          near: 100,
        }),
      ),
    ).toBeNull();
  });
});

describe('queryHistory — components', () => {
  it('returns evidence-backed groups, a byNode Map, and recomputed node count', () => {
    const parts = chainParts();

    const report = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    expect(report.components).toBe(1);
    expect(report.groups).toEqual([['a', 'b', 'c']]);
    expect(report.byNode).toBeInstanceOf(Map);
    expect(report.byNode.get('a')).toBe(0);
    expect(report.byNode.get('b')).toBe(0);
    expect(report.byNode.get('c')).toBe(0);
    expect(report.recomputedNodes).toBe(3);
  });

  it('does not connect candidate edges', () => {
    const parts = chainParts();
    const d: Vec3Like = { x: 3.5, y: 64, z: 0.5 };
    parts.topology.saveNode(makeNode('d', d));
    parts.topology.saveEdge({
      id: 'e-cand',
      from: 'c',
      to: 'd',
      type: 'HORIZONTAL',
      basis: 'candidate',
      evidenceIds: [],
    });

    const report = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    expect(report.components).toBe(2);
    expect(report.groups).toEqual([['a', 'b', 'c'], ['d']]);
    expect(report.byNode.get('d')).not.toBe(report.byNode.get('a'));
  });

  it('returns a deep-equal report for consecutive queries', () => {
    // Insert out of order: component and group order must not depend on
    // node insertion order.
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('c', C));
    parts.topology.saveNode(makeNode('a', A));
    parts.topology.saveNode(makeNode('b', B));
    seedResolvedEdge(parts, 'e-ab', 'a', 'b', 'ev-ab', 'frag-ab', A, B);
    seedResolvedEdge(parts, 'e-bc', 'b', 'c', 'ev-bc', 'frag-bc', B, C);

    const first = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));
    const second = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    expect(first.groups).toEqual([['a', 'b', 'c']]);
    expect(second).toEqual(first);
    expect([...second.byNode]).toEqual([...first.byNode]);
    expect(second.recomputedNodes).toBe(first.recomputedNodes);
  });

  it('rebuilds identical reports across multiple source pages', () => {
    const parts = makeQueryParts();
    // More nodes than one store page (default maxQueryBatch is 100), so this
    // exercises the cursor loop rather than a single page.
    for (let i = 249; i >= 0; i -= 1) {
      const id = `n${String(i).padStart(3, '0')}`;
      parts.topology.saveNode(makeNode(id, { x: i + 0.5, y: 64, z: 0.5 }));
    }

    const first = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));
    const second = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    expect(first.components).toBe(250);
    expect(first.groups).toHaveLength(250);
    expect(first.groups[0]).toEqual(['n000']);
    expect(first.groups[249]).toEqual(['n249']);
    expect(first.recomputedNodes).toBe(250);
    expect(second).toEqual(first);
  });

  it('orders groups with the store locale comparator', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('B', A));
    parts.topology.saveNode(makeNode('a', B));

    const report = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    // Code-unit order would put 'B' before 'a'; the store uses localeCompare.
    expect(report.groups).toEqual([['a'], ['B']]);
    expect([...report.byNode]).toEqual([
      ['a', 0],
      ['B', 1],
    ]);
    expect(report).toEqual(parts.topology.components(DIM));
  });

  it('does not populate the store component cache, including for an empty dimension', () => {
    const parts = chainParts();

    runQuery(parts, { kind: 'components', dim: DIM });
    runQuery(parts, { kind: 'components', dim: 'the_nether' });

    expect(captureComponentCache(parts)).toEqual({ cached: [], counters: [] });
    // The store cache is still cold: its first call recomputes every node.
    expect(parts.topology.components(DIM).recomputedNodes).toBe(3);
  });

  it('reports an empty dimension without inventing nodes or groups', () => {
    const parts = chainParts();

    const report = componentsOf(runQuery(parts, { kind: 'components', dim: 'the_nether' }));
    expect(report.components).toBe(0);
    expect(report.groups).toEqual([]);
    expect(report.byNode.size).toBe(0);
    expect(report.recomputedNodes).toBe(0);

    const again = componentsOf(runQuery(parts, { kind: 'components', dim: 'the_nether' }));
    expect(again).toEqual(report);
  });

  it('only groups nodes that belong to the requested dimension', () => {
    const parts = chainParts();
    parts.topology.saveNode(makeNode('nether-a', A, { dim: 'the_nether' }));

    const report = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));

    expect(report.groups).toEqual([['a', 'b', 'c']]);
    expect(report.byNode.has('nether-a')).toBe(false);
    expect(report.recomputedNodes).toBe(3);
  });

  it('matches the topology store component projection', () => {
    const parts = chainParts();
    const d: Vec3Like = { x: 3.5, y: 64, z: 0.5 };
    parts.topology.saveNode(makeNode('d', d));

    const queryReport = componentsOf(runQuery(parts, { kind: 'components', dim: DIM }));
    const storeReport = parts.topology.components(DIM);

    expect(queryReport).toEqual(storeReport);
  });
});

describe('queryHistory — segments', () => {
  it('returns the current-passable pieces of a recorded fragment', () => {
    const parts = chainParts();
    const result = runQuery(parts, { kind: 'segments', fragmentId: 'frag-ab' });

    expect(result.status).toBe('ok');
    expect(result.dim).toBe(DIM);
    const segments = segmentsOf(result);
    expect(segments.fragmentId).toBe('frag-ab');
    expect(segments.totalPoints).toBe(2);
    expect(segments.segments.length).toBe(1);
    expect(segments.blockedEdgeIds).toEqual([]);
    expect(segments.cuts).toEqual([]);
  });

  it('reports an unknown fragment as not_found instead of an empty segment list', () => {
    const parts = chainParts();
    const result = runQuery(parts, { kind: 'segments', fragmentId: 'missing' });

    expect(result.status).toBe('not_found');
    expect(result.problem).toEqual({
      kind: 'not_found',
      detail: 'no fragment "missing" is recorded in this world',
    });
    expect(result.data).toBeUndefined();
  });
});

describe('queryHistory — read-only guarantees', () => {
  it('does not change store state, revisions, or evidence across all query kinds', () => {
    const parts = chainParts();
    parts.map.observe(obs(AIR, { x: 0, y: 0, z: 0 }, { observedAt: 4321 }));
    parts.topology.saveNode(
      makeNode('observed', { x: 9.5, y: 64, z: 0.5 }, { observedAt: 4242 }),
    );
    const before = captureStoreState(parts);
    const fragmentRevision = parts.fragments.revision;
    const topologyRevision = parts.topology.revision;
    const traversal = parts.fragments.getTraversal('ev-ab');
    const fragment = parts.fragments.getFragment('frag-ab');

    runQuery(parts, { kind: 'historyRoute', dim: DIM, from: A, to: C, near: 5 });
    runQuery(parts, { kind: 'anchor', dim: DIM, here: A, order: 'surface' });
    runQuery(parts, { kind: 'components', dim: DIM });
    runQuery(parts, { kind: 'segments', fragmentId: 'frag-ab' });

    expect(parts.fragments.revision).toBe(fragmentRevision);
    expect(parts.topology.revision).toBe(topologyRevision);
    expect(parts.fragments.getTraversal('ev-ab')).toEqual(traversal);
    expect(parts.fragments.getFragment('frag-ab')).toEqual(fragment);
    // Evidence time and fragment use records are never refreshed by a query.
    expect(parts.map.cellAt(DIM, 0, 0, 0)).toMatchObject({
      observed: true,
      evidence: { observation: { observedAt: 4321 } },
    });
    expect(parts.topology.getNode('observed')?.observedAt).toBe(4242);
    expect(parts.fragments.getTraversal('ev-ab')?.observedAt).toBe(1000);
    expect(parts.fragments.getFragment('frag-ab')?.lastUsedAt).toBe(1000);
    expect(parts.fragments.getFragment('frag-ab')?.uses).toBe(1);
    expect(captureStoreState(parts)).toEqual(before);
  });
});
