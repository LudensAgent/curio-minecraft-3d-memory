import { describe, expect, it } from 'vitest';

import type { SpatialQueryData, SpatialQueryResult } from '../src/query/index.js';
import type { PortalTraversalEvidence } from '../src/topology/index.js';
import { pathFragment, traversalEvidence } from './fakes.js';
import {
  A,
  B,
  C,
  DIM,
  captureStoreState,
  makeNode,
  makeQueryParts,
  runQuery,
} from './query-fixtures.js';
import type { QueryParts } from './query-fixtures.js';

/** Narrow one successful query's `data` to its concrete kind. */
function dataOf<K extends SpatialQueryData['kind']>(
  result: SpatialQueryResult,
  kind: K,
): Extract<SpatialQueryData, { kind: K }> {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe(kind);
  const data = result.data;
  if (data === undefined || data.kind !== kind) {
    throw new Error(`expected ${kind} query data`);
  }
  return data as Extract<SpatialQueryData, { kind: K }>;
}

function pad(value: number, width = 3): string {
  return String(value).padStart(width, '0');
}

function seedFragments(count: number): QueryParts {
  const parts = makeQueryParts();
  for (let i = 0; i < count; i += 1) {
    parts.fragments.saveFragment(pathFragment(`f${pad(i)}`));
  }
  return parts;
}

function portalTraversal(id: string, edgeId: string): PortalTraversalEvidence {
  return {
    id,
    edgeId,
    direction: 'forward',
    sessionId: 's1',
    observedAt: 1000,
    observationIds: [`obs-${id}`],
    source: 'portal_use',
  };
}

describe('queryTopology — fragments', () => {
  it('joins store pages for a default limit of 100', () => {
    const parts = seedFragments(250);

    const first = runQuery(parts, { kind: 'fragments' });
    const data = dataOf(first, 'fragments');
    expect(data.items).toHaveLength(100);
    expect(data.total).toBe(250);
    expect(data.nextAfter).toBe('f099');
    expect(first.total).toBe(250);
    expect(first.nextAfter).toBe('f099');
    expect(data.items[0]!.id).toBe('f000');
    expect(data.items[99]!.id).toBe('f099');
    expect(first.readOnly).toBe(true);
    expect(first.executable).toBe(false);
  });

  it('returns all 250 across multiple store pages when limit is 250 or 1000', () => {
    const parts = seedFragments(250);

    for (const limit of [250, 1000]) {
      const result = runQuery(parts, { kind: 'fragments', limit });
      const data = dataOf(result, 'fragments');
      expect(data.items).toHaveLength(250);
      expect(data.total).toBe(250);
      expect(data.nextAfter).toBeUndefined();
      expect(result.total).toBe(250);
      expect(result.nextAfter).toBeUndefined();
      expect(data.items.map((item) => item.id)).toEqual(
        Array.from({ length: 250 }, (_, i) => `f${pad(i)}`),
      );
    }
  });

  it('pages with an exclusive after cursor without duplicates or loss', () => {
    const parts = seedFragments(250);

    const page1 = dataOf(runQuery(parts, { kind: 'fragments', limit: 100 }), 'fragments');
    expect(page1.items.map((item) => item.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => `f${pad(i)}`),
    );
    expect(page1.nextAfter).toBe('f099');

    const page2 = dataOf(
      runQuery(parts, { kind: 'fragments', limit: 100, after: page1.nextAfter! }),
      'fragments',
    );
    expect(page2.items.map((item) => item.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => `f${pad(100 + i)}`),
    );
    expect(page2.nextAfter).toBe('f199');
    expect(page2.total).toBe(250);

    const page3 = dataOf(
      runQuery(parts, { kind: 'fragments', limit: 100, after: page2.nextAfter! }),
      'fragments',
    );
    expect(page3.items).toHaveLength(50);
    expect(page3.items[0]!.id).toBe('f200');
    expect(page3.items[49]!.id).toBe('f249');
    expect(page3.nextAfter).toBeUndefined();

    const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(250);
  });

  it('filters by dim, fragmentKind, and geometrySource', () => {
    const parts = makeQueryParts();
    parts.fragments.saveFragment(pathFragment('frag-a'));
    parts.fragments.saveFragment(pathFragment('frag-b', { dim: 'nether' }));
    parts.fragments.saveFragment(
      pathFragment('frag-c', { kind: 'bridge', geometrySource: 'observed_structure' }),
    );
    parts.fragments.saveFragment(
      pathFragment('frag-d', { kind: 'bridge', geometrySource: 'legacy' }),
    );
    parts.fragments.saveFragment(
      pathFragment('frag-e', {
        dim: 'nether',
        kind: 'bridge',
        geometrySource: 'observed_structure',
      }),
    );

    const byDim = dataOf(runQuery(parts, { kind: 'fragments', dim: 'nether' }), 'fragments');
    expect(byDim.items.map((item) => item.id)).toEqual(['frag-b', 'frag-e']);
    expect(byDim.total).toBe(2);

    const byKind = dataOf(runQuery(parts, { kind: 'fragments', fragmentKind: 'bridge' }), 'fragments');
    expect(byKind.items.map((item) => item.id)).toEqual(['frag-c', 'frag-d', 'frag-e']);
    expect(byKind.total).toBe(3);

    const bySource = dataOf(
      runQuery(parts, { kind: 'fragments', geometrySource: 'observed_structure' }),
      'fragments',
    );
    expect(bySource.items.map((item) => item.id)).toEqual(['frag-c', 'frag-e']);
    expect(bySource.total).toBe(2);

    const combined = dataOf(
      runQuery(parts, { kind: 'fragments', dim: 'nether', fragmentKind: 'bridge' }),
      'fragments',
    );
    expect(combined.items.map((item) => item.id)).toEqual(['frag-e']);

    const empty = runQuery(parts, { kind: 'fragments', dim: 'end' });
    const emptyData = dataOf(empty, 'fragments');
    expect(emptyData.items).toEqual([]);
    expect(emptyData.total).toBe(0);
    expect(emptyData.nextAfter).toBeUndefined();
    expect(empty.nextAfter).toBeUndefined();
  });
});

describe('queryTopology — traversals', () => {
  it('pages and filters traversal evidence by dim and fragmentId', () => {
    const parts = makeQueryParts();
    parts.fragments.saveFragment(pathFragment('fa'));
    parts.fragments.saveFragment(pathFragment('fb', { dim: 'nether' }));
    for (let i = 0; i < 120; i += 1) {
      parts.fragments.addTraversal(traversalEvidence(`t${pad(i)}`, 'fa', A, B));
    }
    for (let i = 0; i < 30; i += 1) {
      parts.fragments.addTraversal(
        traversalEvidence(`n${pad(i)}`, 'fb', A, B, { dim: 'nether' }),
      );
    }

    const first = dataOf(runQuery(parts, { kind: 'traversals', dim: DIM }), 'traversals');
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(120);
    expect(first.nextAfter).toBe('t099');

    const second = dataOf(
      runQuery(parts, { kind: 'traversals', dim: DIM, after: first.nextAfter! }),
      'traversals',
    );
    expect(second.items).toHaveLength(20);
    expect(second.items[0]!.id).toBe('t100');
    expect(second.items[19]!.id).toBe('t119');
    expect(second.total).toBe(120);
    expect(second.nextAfter).toBeUndefined();

    const nether = dataOf(runQuery(parts, { kind: 'traversals', dim: 'nether' }), 'traversals');
    expect(nether.items.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `n${pad(i)}`),
    );
    expect(nether.total).toBe(30);

    const byFragment = dataOf(
      runQuery(parts, { kind: 'traversals', fragmentId: 'fb' }),
      'traversals',
    );
    expect(byFragment.items).toHaveLength(30);
    expect(byFragment.total).toBe(30);
    expect(byFragment.nextAfter).toBeUndefined();
    expect(byFragment.items.every((item) => item.fragmentId === 'fb')).toBe(true);

    const empty = runQuery(parts, { kind: 'traversals', fragmentId: 'ghost' });
    const emptyData = dataOf(empty, 'traversals');
    expect(emptyData.items).toEqual([]);
    expect(emptyData.total).toBe(0);
    expect(emptyData.nextAfter).toBeUndefined();
  });
});

describe('queryTopology — nodes', () => {
  it('pages and filters nodes by dim, tag, label, and source', () => {
    const parts = makeQueryParts();
    for (let i = 0; i < 130; i += 1) {
      parts.topology.saveNode(makeNode(`n${pad(i)}`, A));
    }
    parts.topology.saveNode(makeNode('x-base', A, { tag: 'base', label: 'home' }));
    parts.topology.saveNode(makeNode('x-resource', B, { tag: 'resource', label: 'mine' }));
    parts.topology.saveNode(makeNode('p-home', C, { tag: 'base', label: 'home', source: 'program' }));
    parts.topology.saveNode(makeNode('nether-base', A, { dim: 'nether', tag: 'base', label: 'home' }));

    const first = dataOf(runQuery(parts, { kind: 'nodes' }), 'nodes');
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(134);
    expect(first.nextAfter).toBe('n099');

    const tail = dataOf(
      runQuery(parts, { kind: 'nodes', after: first.nextAfter! }),
      'nodes',
    );
    expect(tail.items).toHaveLength(34);
    expect(tail.total).toBe(134);
    expect(tail.nextAfter).toBeUndefined();
    expect(first.items.length + tail.items.length).toBe(134);

    const byTag = dataOf(runQuery(parts, { kind: 'nodes', tag: 'base' }), 'nodes');
    expect(byTag.items.map((item) => item.id)).toEqual(['nether-base', 'p-home', 'x-base']);
    expect(byTag.total).toBe(3);

    const byLabel = dataOf(runQuery(parts, { kind: 'nodes', label: 'home' }), 'nodes');
    expect(byLabel.items.map((item) => item.id)).toEqual(['nether-base', 'p-home', 'x-base']);
    expect(byLabel.total).toBe(3);

    const bySource = dataOf(runQuery(parts, { kind: 'nodes', source: 'program' }), 'nodes');
    expect(bySource.items.map((item) => item.id)).toEqual(['p-home']);
    expect(bySource.total).toBe(1);

    const byDim = dataOf(runQuery(parts, { kind: 'nodes', dim: 'nether' }), 'nodes');
    expect(byDim.items.map((item) => item.id)).toEqual(['nether-base']);

    const combined = dataOf(runQuery(parts, { kind: 'nodes', dim: DIM, tag: 'base' }), 'nodes');
    expect(combined.items.map((item) => item.id)).toEqual(['p-home', 'x-base']);

    const empty = runQuery(parts, { kind: 'nodes', label: 'nope' });
    const emptyData = dataOf(empty, 'nodes');
    expect(emptyData.items).toEqual([]);
    expect(emptyData.total).toBe(0);
    expect(emptyData.nextAfter).toBeUndefined();
  });
});

describe('queryTopology — edges', () => {
  it('pages and filters edges by dim, from, to, type, and basis', () => {
    const parts = makeQueryParts();
    parts.fragments.saveFragment(pathFragment('ef'));
    parts.fragments.addTraversal(traversalEvidence('ev1', 'ef', A, B));

    parts.topology.saveNode(makeNode('node-a', A));
    parts.topology.saveNode(makeNode('node-b', B));
    parts.topology.saveNode(makeNode('node-c', C, { dim: 'nether' }));
    parts.topology.saveNode(makeNode('node-d', A, { dim: 'nether' }));

    parts.topology.saveEdge({
      id: 'e-traversed',
      from: 'node-a',
      to: 'node-b',
      type: 'HORIZONTAL',
      basis: 'traversed',
      evidenceIds: ['ev1'],
    });
    for (let i = 0; i < 110; i += 1) {
      parts.topology.saveEdge({
        id: `e${pad(i)}`,
        from: 'node-a',
        to: 'node-b',
        type: 'HORIZONTAL',
        basis: 'candidate',
        evidenceIds: [],
      });
    }
    parts.topology.saveEdge({
      id: 'e-nether',
      from: 'node-c',
      to: 'node-d',
      type: 'CAVE_PASSAGE',
      basis: 'candidate',
      evidenceIds: [],
    });

    const first = dataOf(runQuery(parts, { kind: 'edges' }), 'edges');
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(112);
    expect(first.nextAfter).toBeDefined();
    const tail = dataOf(runQuery(parts, { kind: 'edges', after: first.nextAfter! }), 'edges');
    expect(tail.items).toHaveLength(12);
    expect(tail.total).toBe(112);
    expect(tail.nextAfter).toBeUndefined();

    const overworld = dataOf(runQuery(parts, { kind: 'edges', dim: DIM }), 'edges');
    expect(overworld.total).toBe(111);
    expect(overworld.items.every((item) => item.id !== 'e-nether')).toBe(true);

    const nether = dataOf(runQuery(parts, { kind: 'edges', dim: 'nether' }), 'edges');
    expect(nether.items.map((item) => item.id)).toEqual(['e-nether']);

    const byFrom = dataOf(runQuery(parts, { kind: 'edges', from: 'node-a' }), 'edges');
    expect(byFrom.total).toBe(111);
    expect(byFrom.items.every((item) => item.from === 'node-a')).toBe(true);

    const byTo = dataOf(runQuery(parts, { kind: 'edges', to: 'node-b' }), 'edges');
    expect(byTo.total).toBe(111);
    expect(byTo.items.every((item) => item.to === 'node-b')).toBe(true);

    const byType = dataOf(runQuery(parts, { kind: 'edges', type: 'HORIZONTAL' }), 'edges');
    expect(byType.total).toBe(111);
    expect(byType.items.every((item) => item.type === 'HORIZONTAL')).toBe(true);

    const candidates = dataOf(runQuery(parts, { kind: 'edges', basis: 'candidate' }), 'edges');
    expect(candidates.total).toBe(111);
    expect(candidates.items.every((item) => item.basis === 'candidate')).toBe(true);

    const traversed = dataOf(runQuery(parts, { kind: 'edges', basis: 'traversed' }), 'edges');
    expect(traversed.items.map((item) => item.id)).toEqual(['e-traversed']);

    const empty = runQuery(parts, { kind: 'edges', dim: 'end' });
    const emptyData = dataOf(empty, 'edges');
    expect(emptyData.items).toEqual([]);
    expect(emptyData.total).toBe(0);
    expect(emptyData.nextAfter).toBeUndefined();

    const emptyFrom = dataOf(runQuery(parts, { kind: 'edges', from: 'ghost' }), 'edges');
    expect(emptyFrom.items).toEqual([]);
    expect(emptyFrom.total).toBe(0);
  });
});

describe('queryTopology — portals', () => {
  it('sorts portal edges by id regardless of insertion order and pages them', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('o', A, { dim: 'overworld', tag: 'portal' }));
    parts.topology.saveNode(makeNode('n', B, { dim: 'nether', tag: 'portal' }));
    for (const id of ['z', 'a', 'm']) {
      parts.topology.savePortalEdge({ id, from: 'o', to: 'n' }, [portalTraversal(`t-${id}`, id)]);
    }

    const all = runQuery(parts, { kind: 'portals' });
    const allData = dataOf(all, 'portals');
    expect(allData.items.map((item) => item.id)).toEqual(['a', 'm', 'z']);
    expect(allData.total).toBe(3);
    expect(allData.nextAfter).toBeUndefined();
    expect(all.dim).toBeUndefined();
    expect(allData.items[0]!.fromDim).toBe('overworld');
    expect(allData.items[0]!.toDim).toBe('nether');

    const page1 = dataOf(runQuery(parts, { kind: 'portals', limit: 2 }), 'portals');
    expect(page1.items.map((item) => item.id)).toEqual(['a', 'm']);
    expect(page1.total).toBe(3);
    expect(page1.nextAfter).toBe('m');

    const page2 = dataOf(
      runQuery(parts, { kind: 'portals', limit: 2, after: page1.nextAfter! }),
      'portals',
    );
    expect(page2.items.map((item) => item.id)).toEqual(['z']);
    expect(page2.total).toBe(3);
    expect(page2.nextAfter).toBeUndefined();

    const exact = dataOf(runQuery(parts, { kind: 'portals', limit: 3 }), 'portals');
    expect(exact.items.map((item) => item.id)).toEqual(['a', 'm', 'z']);
    expect(exact.nextAfter).toBeUndefined();
  });

  it('returns an empty page when no portal edges exist', () => {
    const parts = makeQueryParts();
    const result = runQuery(parts, { kind: 'portals' });
    const data = dataOf(result, 'portals');
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.nextAfter).toBeUndefined();
  });
});

describe('queryTopology — read-only and isolation', () => {
  function seedMixed(): QueryParts {
    const parts = makeQueryParts();
    parts.fragments.saveFragment(
      pathFragment('f000', { uses: 7, lastUsedAt: 1234, createdAt: 1000 }),
    );
    parts.fragments.saveFragment(pathFragment('f001', { dim: 'nether' }));
    parts.fragments.addTraversal(traversalEvidence('t000', 'f000', A, B));
    parts.topology.saveNode(makeNode('n000', A));
    parts.topology.saveNode(makeNode('n001', B, { tag: 'base', label: 'home' }));
    parts.topology.saveEdge({
      id: 'e000',
      from: 'n000',
      to: 'n001',
      type: 'HORIZONTAL',
      basis: 'candidate',
      evidenceIds: [],
    });
    parts.topology.saveNode(makeNode('portal-o', A, { tag: 'portal' }));
    parts.topology.saveNode(makeNode('portal-n', B, { dim: 'nether', tag: 'portal' }));
    parts.topology.savePortalEdge(
      { id: 'portal-1', from: 'portal-o', to: 'portal-n' },
      [portalTraversal('pt-out', 'portal-1')],
    );
    return parts;
  }

  it('does not mutate stores or fragment scoring/time metadata', () => {
    const parts = seedMixed();
    const before = captureStoreState(parts);
    const fragmentBefore = parts.fragments.getFragment('f000');

    const requests = [
      { kind: 'fragments' },
      { kind: 'fragments', dim: DIM, fragmentKind: 'walked', limit: 2 },
      { kind: 'traversals' },
      { kind: 'traversals', fragmentId: 'f000' },
      { kind: 'nodes' },
      { kind: 'nodes', tag: 'base' },
      { kind: 'edges' },
      { kind: 'edges', basis: 'candidate' },
      { kind: 'portals' },
      { kind: 'portals', limit: 1 },
    ];
    for (const request of requests) {
      expect(runQuery(parts, request).status).toBe('ok');
    }

    expect(captureStoreState(parts)).toEqual(before);
    const fragmentAfter = parts.fragments.getFragment('f000');
    expect(fragmentAfter).toEqual(fragmentBefore);
    expect(fragmentAfter!.uses).toBe(7);
    expect(fragmentAfter!.lastUsedAt).toBe(1234);
    expect(fragmentAfter!.createdAt).toBe(1000);
  });

  it('returns copies, so mutating a result does not change stored facts', () => {
    const parts = makeQueryParts();
    parts.fragments.saveFragment(pathFragment('f000'));
    parts.topology.saveNode(makeNode('n000', A, { tag: 'base', label: 'home' }));

    const fragments = dataOf(runQuery(parts, { kind: 'fragments' }), 'fragments');
    const mutated = fragments.items[0]!;
    mutated.polyline[0]!.x = 999;
    mutated.polyline.push({ x: 0, y: 0, z: 0 });
    mutated.entrances.length = 0;

    const again = dataOf(runQuery(parts, { kind: 'fragments' }), 'fragments');
    expect(again.items[0]!.polyline).toEqual([
      { x: 0.5, y: 64, z: 0.5 },
      { x: 1.5, y: 64, z: 0.5 },
    ]);
    expect(again.items[0]!.entrances).toHaveLength(1);

    const nodes = dataOf(runQuery(parts, { kind: 'nodes' }), 'nodes');
    const node = nodes.items[0]!;
    node.label = 'hacked';
    (node.location as { kind: 'exact'; pos: { x: number } }).pos.x = 999;

    const nodesAgain = dataOf(runQuery(parts, { kind: 'nodes' }), 'nodes');
    expect(nodesAgain.items[0]!.label).toBe('home');
    expect(nodesAgain.items[0]!.location).toEqual({
      kind: 'exact',
      pos: { x: 0.5, y: 64, z: 0.5 },
    });
  });
});
