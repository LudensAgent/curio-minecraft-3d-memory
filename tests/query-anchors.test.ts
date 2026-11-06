import { describe, expect, it } from 'vitest';

import type { SpatialNode } from '../src/topology/index.js';
import type { SpatialQueryResult } from '../src/query/types.js';
import {
  A,
  B,
  C,
  DIM,
  makeNode,
  makeQueryParts,
  captureStoreState,
  runQuery,
} from './query-fixtures.js';

function resourceAnchors(result: SpatialQueryResult) {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('resourceAnchors');
  if (result.data?.kind !== 'resourceAnchors') throw new Error('expected resourceAnchors data');
  return result.data;
}

function containerAnchors(result: SpatialQueryResult) {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('containerAnchors');
  if (result.data?.kind !== 'containerAnchors') throw new Error('expected containerAnchors data');
  return result.data;
}

function goneNode(id: string, node: Partial<SpatialNode> = {}): SpatialNode {
  return makeNode(id, { x: 3.5, y: 64, z: 0.5 }, {
    gone: true,
    goneAt: 1000,
    goneEvidence: { sessionId: 'session-1', observedAt: 1000, source: 'vision_scan' },
    ...node,
  });
}

describe('resourceAnchors', () => {
  function setup() {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A, { tag: 'resource', label: 'coal' }));
    parts.topology.saveNode(makeNode('b', B, { tag: 'resource', label: 'iron' }));
    parts.topology.saveNode(makeNode('c', C, { tag: 'base', label: 'home' }));
    parts.topology.saveNode(makeNode('d', A, { dim: 'nether', tag: 'resource', label: 'quartz' }));
    return parts;
  }

  it('filters by tag, label, and dim', () => {
    const parts = setup();

    expect(resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', tag: 'resource' })).items.map((n) => n.id)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(
      resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', tag: 'resource', dim: DIM })).items.map((n) => n.id),
    ).toEqual(['a', 'b']);
    expect(resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', label: 'coal' })).items.map((n) => n.id)).toEqual([
      'a',
    ]);

    const result = runQuery(parts, { kind: 'resourceAnchors', label: 'coal' });
    expect(result.dim).toBeUndefined();
    expect(result.total).toBe(1);
    const data = resourceAnchors(result);
    expect(data.total).toBe(1);
    expect(data.nextAfter).toBeUndefined();
    // Anchor records are stored nodes, not computed reachability views.
    expect('reachability' in data.items[0]!).toBe(false);
  });

  it('pages with an exclusive cursor and reports the filter total', () => {
    const parts = setup();
    const first = resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', tag: 'resource', limit: 2 }));
    expect(first.items.map((n) => n.id)).toEqual(['a', 'b']);
    expect(first.total).toBe(3);
    expect(first.nextAfter).toBe('b');

    const second = resourceAnchors(
      runQuery(parts, { kind: 'resourceAnchors', tag: 'resource', limit: 2, after: first.nextAfter }),
    );
    expect(second.items.map((n) => n.id)).toEqual(['d']);
    expect(second.total).toBe(3);
    expect(second.nextAfter).toBeUndefined();
  });

  it('returns an empty ordered result, not an error, for zero matches', () => {
    const parts = setup();
    const result = runQuery(parts, { kind: 'resourceAnchors', tag: 'danger' });
    const data = resourceAnchors(result);
    expect(result.status).toBe('ok');
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.nextAfter).toBeUndefined();
  });
});

describe('containerAnchors', () => {
  it('is unsupported without a host classifier and returns no data', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('chest-1', A, { label: 'chest' }));

    const result = runQuery(parts, { kind: 'containerAnchors' });
    expect(result.status).toBe('unsupported');
    expect(result.problem).toMatchObject({ kind: 'unsupported', query: 'containerAnchors' });
    expect(result.data).toBeUndefined();
    expect(result.total).toBeUndefined();
  });

  it('returns only exact nodes the host classifier identifies, never inferring from label or metadata', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('chest-1', A, { label: 'chest' }));
    parts.topology.saveNode(
      makeNode('chest-region', B, {
        label: 'chest',
        location: { kind: 'region', center: { ...B }, radius: 8 },
      }),
    );
    parts.topology.saveNode(makeNode('foo', C, { label: 'foo' }));
    parts.topology.saveNode(makeNode('box', A, { label: 'box', metadata: { kind: 'container' } }));

    const result = runQuery(
      parts,
      { kind: 'containerAnchors' },
      { isContainer: (node) => node.label === 'chest' },
    );
    const data = containerAnchors(result);
    expect(data.items.map((n) => n.id)).toEqual(['chest-1']);
    expect(result.total).toBe(1);
  });

  it('pages the collected matches and keeps gone anchors with their flags', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A));
    parts.topology.saveNode(makeNode('b', B));
    parts.topology.saveNode(makeNode('c', C));
    parts.topology.saveNode(goneNode('z'));

    const options = { isContainer: () => true };
    const first = runQuery(parts, { kind: 'containerAnchors', limit: 2 }, options);
    const firstData = containerAnchors(first);
    expect(firstData.items.map((n) => n.id)).toEqual(['a', 'b']);
    expect(firstData.total).toBe(4);
    expect(firstData.nextAfter).toBe('b');
    expect(first.total).toBe(4);
    expect(first.nextAfter).toBe('b');

    const second = runQuery(
      parts,
      { kind: 'containerAnchors', limit: 2, after: firstData.nextAfter },
      options,
    );
    const secondData = containerAnchors(second);
    expect(secondData.items.map((n) => n.id)).toEqual(['c', 'z']);
    expect(secondData.total).toBe(4);
    expect(secondData.nextAfter).toBeUndefined();
    expect(secondData.items.find((n) => n.id === 'z')?.gone).toBe(true);
  });

  it('scans across node-store pages and pages the complete match set', () => {
    const parts = makeQueryParts();
    for (let index = 0; index < 250; index++) {
      parts.topology.saveNode(makeNode(`n${String(index).padStart(3, '0')}`, A));
    }
    const options = { isContainer: () => true };

    const first = containerAnchors(
      runQuery(parts, { kind: 'containerAnchors', limit: 100 }, options),
    );
    expect(first.items.map((n) => n.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `n${String(index).padStart(3, '0')}`),
    );
    expect(first.total).toBe(250);
    expect(first.nextAfter).toBe('n099');

    const second = containerAnchors(
      runQuery(parts, { kind: 'containerAnchors', limit: 100, after: first.nextAfter }, options),
    );
    expect(second.items[0]?.id).toBe('n100');
    expect(second.items[99]?.id).toBe('n199');
    expect(second.total).toBe(250);
    expect(second.nextAfter).toBe('n199');

    const third = containerAnchors(
      runQuery(parts, { kind: 'containerAnchors', limit: 100, after: second.nextAfter }, options),
    );
    expect(third.items).toHaveLength(50);
    expect(third.items[0]?.id).toBe('n200');
    expect(third.total).toBe(250);
    expect(third.nextAfter).toBeUndefined();
  });

  it('filters interleaved non-matches across node-store pages and by dim', () => {
    const parts = makeQueryParts();
    for (let index = 0; index < 150; index++) {
      parts.topology.saveNode(
        makeNode(`n${String(index).padStart(3, '0')}`, A, {
          label: index % 3 === 0 ? 'chest' : 'coal',
        }),
      );
    }
    parts.topology.saveNode(makeNode('nether-chest', A, { dim: 'nether', label: 'chest' }));

    const result = runQuery(
      parts,
      { kind: 'containerAnchors', dim: DIM, limit: 1000 },
      { isContainer: (node) => node.label === 'chest' },
    );
    const data = containerAnchors(result);
    expect(data.total).toBe(50);
    expect(data.items).toHaveLength(50);
    expect(data.items[0]?.id).toBe('n000');
    expect(data.items[49]?.id).toBe('n147');
    expect(data.items.every((node) => node.label === 'chest')).toBe(true);
  });

  it('returns an empty result when the classifier matches nothing', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A, { label: 'coal' }));

    const result = runQuery(
      parts,
      { kind: 'containerAnchors' },
      { isContainer: (node) => node.label === 'chest' },
    );
    const data = containerAnchors(result);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    expect(result.total).toBe(0);
  });

  it('propagates classifier errors instead of answering as if nothing matched', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A));
    expect(() =>
      runQuery(
        parts,
        { kind: 'containerAnchors' },
        {
          isContainer: () => {
            throw new Error('classifier boom');
          },
        },
      ),
    ).toThrow('classifier boom');
  });
});

describe('containerContents', () => {
  it('always answers with the host ledger boundary and never an empty inventory', () => {
    const parts = makeQueryParts();

    const plain = runQuery(parts, { kind: 'containerContents' });
    expect(plain.status).toBe('unsupported');
    expect(plain.problem).toEqual({
      kind: 'host_ledger',
      detail:
        'container contents are owned by the host precise inventory ledger; ' +
        'the spatial library stores location/reachability evidence only',
    });
    expect(plain.data).toBeUndefined();
    expect('items' in plain).toBe(false);

    const scoped = runQuery(parts, {
      kind: 'containerContents',
      dim: DIM,
      nodeId: 'chest-1',
    });
    expect(scoped.status).toBe('unsupported');
    expect(scoped.problem?.kind).toBe('host_ledger');
    expect(scoped.dim).toBe(DIM);
    expect(scoped.data).toBeUndefined();
    expect('items' in scoped).toBe(false);
  });
});

describe('anchor query isolation', () => {
  it('returns copies: mutating a result node does not change stored facts', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A, { tag: 'resource', label: 'coal' }));

    const first = resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', tag: 'resource' }));
    first.items[0]!.label = 'mutated';
    first.items[0]!.location = { kind: 'exact', pos: { x: 99, y: 99, z: 99 } };

    const second = resourceAnchors(runQuery(parts, { kind: 'resourceAnchors', tag: 'resource' }));
    expect(second.items[0]!.label).toBe('coal');
    expect(second.items[0]!.location).toEqual({ kind: 'exact', pos: { ...A } });
  });

  it('is read-only: store state is unchanged by every anchor query', () => {
    const parts = makeQueryParts();
    parts.topology.saveNode(makeNode('a', A, { tag: 'resource', label: 'coal' }));
    parts.topology.saveNode(makeNode('chest-1', B, { label: 'chest' }));
    const before = captureStoreState(parts);

    runQuery(parts, { kind: 'resourceAnchors', tag: 'resource' });
    runQuery(parts, { kind: 'containerAnchors' }, { isContainer: (node) => node.label === 'chest' });
    runQuery(parts, { kind: 'containerContents', nodeId: 'chest-1' });

    expect(captureStoreState(parts)).toEqual(before);
  });
});
