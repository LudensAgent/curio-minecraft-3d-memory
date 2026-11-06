import { describe, expect, it } from 'vitest';

import type { SpatialQueryRequest } from '../src/index.js';
import {
  A,
  B,
  captureStoreState,
  DIM,
  makeNode,
  makeQueryParts,
  runQuery,
} from './query-fixtures.js';

const CELL_A = { x: 0, y: 64, z: 0 };
const CELL_B = { x: 1, y: 64, z: 0 };

function invalid(parts: ReturnType<typeof makeQueryParts>, request: unknown): void {
  const result = parts.store.query(request as SpatialQueryRequest);
  expect(result.status).toBe('invalid_request');
  expect(result.problem?.kind).toBe('invalid_request');
  expect(result.data).toBeUndefined();
}

describe('SpatialQueryPort — request boundary', () => {
  it('rejects non-objects, missing kinds, and unknown kinds without throwing', () => {
    const parts = makeQueryParts();
    for (const bad of [null, 42, 'cells', [], {}, { kind: 'nope' }, { kind: 12 }]) {
      invalid(parts, bad);
    }
  });

  it('rejects unknown fields for every request kind', () => {
    const parts = makeQueryParts();
    const cases: unknown[] = [
      { kind: 'cells', dim: DIM, positions: [CELL_A], limit: 1 },
      { kind: 'fragments', dim: DIM, source: 'legacy' },
      { kind: 'traversals', dim: DIM, kindFilter: 'walked' },
      { kind: 'nodes', dim: DIM, namespace: 'agent' },
      { kind: 'edges', dim: DIM, direction: 'forward' },
      { kind: 'historyRoute', dim: DIM, from: A, to: B, pathId: 'x' },
      { kind: 'anchor', dim: DIM, here: A, order: 'surface', radius: 2 },
      { kind: 'components', dim: DIM, source: 'agent' },
      { kind: 'segments', fragmentId: 'f1', dim: DIM },
      { kind: 'portals', dim: DIM },
      { kind: 'resourceAnchors', dim: DIM, order: 'surface' },
      { kind: 'containerAnchors', dim: DIM, tag: 'resource' },
      { kind: 'containerContents', dim: DIM, contents: true },
      { kind: 'snapshot', limit: 1 },
      { kind: 'capabilities', scope: 'all' },
    ];
    for (const request of cases) invalid(parts, request);
  });

  it('enforces the 1..1000 limit and rejects non-integers', () => {
    const parts = makeQueryParts();
    for (const limit of [0, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      invalid(parts, { kind: 'fragments', limit });
    }
    for (const limit of [1, 100, 1000]) {
      const result = parts.store.query({ kind: 'fragments', limit });
      expect(result.status).not.toBe('invalid_request');
    }
  });

  it('rejects empty or non-string cursors and dimensions', () => {
    const parts = makeQueryParts();
    invalid(parts, { kind: 'fragments', after: '' });
    invalid(parts, { kind: 'fragments', after: 12 });
    invalid(parts, { kind: 'cells', dim: '', positions: [CELL_A] });
    invalid(parts, { kind: 'historyRoute', dim: '', from: A, to: B });
    invalid(parts, { kind: 'anchor', dim: '', here: A, order: 'surface' });
    invalid(parts, { kind: 'components', dim: '' });
    invalid(parts, { kind: 'segments', fragmentId: '' });
    // A syntactically valid cursor past the end is an empty page, not an error.
    const result = parts.store.query({ kind: 'fragments', after: 'zzz' });
    expect(result.status).toBe('ok');
  });

  it('caps cells at 4096 integer positions', () => {
    const parts = makeQueryParts();
    const positions = Array.from({ length: 4096 }, (_, index) => ({
      x: index,
      y: 64,
      z: 0,
    }));
    const accepted = parts.store.query({ kind: 'cells', dim: DIM, positions });
    expect(accepted.status).toBe('ok');

    invalid(parts, { kind: 'cells', dim: DIM, positions: [...positions, { x: 4096, y: 64, z: 0 }] });
    invalid(parts, { kind: 'cells', dim: DIM, positions: [{ x: 0.5, y: 64, z: 0 }] });
    invalid(parts, { kind: 'cells', dim: DIM, positions: [{ x: Number.POSITIVE_INFINITY, y: 64, z: 0 }] });
    invalid(parts, { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 64, z: 0, w: 1 }] });
  });

  it('validates positions, near values, and enum fields', () => {
    const parts = makeQueryParts();
    invalid(parts, { kind: 'historyRoute', dim: DIM, from: { x: Number.NaN, y: 0, z: 0 }, to: B });
    invalid(parts, { kind: 'historyRoute', dim: DIM, from: A, to: B, near: -1 });
    invalid(parts, { kind: 'historyRoute', dim: DIM, from: A, to: B, near: Number.NaN });
    invalid(parts, { kind: 'anchor', dim: DIM, here: A, order: 'middle' });
    invalid(parts, { kind: 'nodes', tag: 'container' });
    invalid(parts, { kind: 'edges', basis: 'guess' });
  });
});

describe('SpatialQueryPort — envelope and read-only boundary', () => {
  it('returns the contract envelope with injected time and literal read-only markers', () => {
    const parts = makeQueryParts();
    const result = runQuery(
      parts,
      { kind: 'fragments', dim: DIM },
      { now: () => 1234 },
    );
    expect(result).toMatchObject({
      status: 'ok',
      contract: 'memory-host-contract/1',
      worldId: 'world',
      dim: DIM,
      computedAt: 1234,
      readOnly: true,
      executable: false,
    });
    expect(result.data?.kind).toBe('fragments');
  });

  it('omits sessionId before a session and reports the active session afterwards', () => {
    const parts = makeQueryParts();
    expect(parts.store.query({ kind: 'snapshot' }).sessionId).toBeUndefined();
    parts.map.beginSession('s1');
    expect(parts.store.query({ kind: 'snapshot' }).sessionId).toBe('s1');
  });

  it('returns structured host_ledger for container contents, never an empty list', () => {
    const parts = makeQueryParts();
    const result = parts.store.query({ kind: 'containerContents', dim: DIM, nodeId: 'chest-1' });
    expect(result.status).toBe('unsupported');
    expect(result.problem).toEqual({
      kind: 'host_ledger',
      detail:
        'container contents are owned by the host precise inventory ledger; the spatial library stores location/reachability evidence only',
    });
    expect(result.data).toBeUndefined();
  });

  it('reports container anchors unsupported without a host classifier', () => {
    const parts = makeQueryParts();
    const result = parts.store.query({ kind: 'containerAnchors', dim: DIM });
    expect(result.status).toBe('unsupported');
    expect(result.problem?.kind).toBe('unsupported');
    if (result.problem?.kind === 'unsupported') {
      expect(result.problem.query).toBe('containerAnchors');
    }
    expect(result.data).toBeUndefined();
  });

  it('exposes the query method in the store capability report', () => {
    const parts = makeQueryParts();
    expect(parts.store.describeCapabilities().query.available).toBe(true);
  });

  it('passes the host container classifier through store construction', () => {
    const parts = makeQueryParts({
      query: { isContainer: (node) => node.label === 'chest' },
    });
    parts.topology.saveNode(makeNode('chest-1', { x: 0, y: 64, z: 0 }, { label: 'chest' }));
    parts.topology.saveNode(makeNode('coal-1', { x: 1, y: 64, z: 0 }, { label: 'coal' }));

    const result = parts.store.query({ kind: 'containerAnchors', dim: DIM });
    expect(result.status).toBe('ok');
    if (result.data?.kind !== 'containerAnchors') throw new Error('expected containerAnchors');
    expect(result.data.items.map((node) => node.id)).toEqual(['chest-1']);
    expect(result.data.total).toBe(1);
  });

  it('does not change store state for any query kind', () => {
    const parts = makeQueryParts();
    const before = captureStoreState(parts);
    const requests: SpatialQueryRequest[] = [
      { kind: 'cells', dim: DIM, positions: [CELL_A, CELL_B] },
      { kind: 'fragments', dim: DIM },
      { kind: 'traversals', dim: DIM },
      { kind: 'nodes', dim: DIM },
      { kind: 'edges', dim: DIM },
      { kind: 'portals' },
      { kind: 'historyRoute', dim: DIM, from: A, to: B },
      { kind: 'anchor', dim: DIM, here: A, order: 'deepest' },
      { kind: 'components', dim: DIM },
      { kind: 'segments', fragmentId: 'missing' },
      { kind: 'resourceAnchors', dim: DIM },
      { kind: 'containerAnchors', dim: DIM },
      { kind: 'containerContents', dim: DIM },
      { kind: 'snapshot' },
      { kind: 'capabilities' },
    ];
    for (const request of requests) {
      parts.store.query(request);
    }
    expect(captureStoreState(parts)).toEqual(before);
  });
});
