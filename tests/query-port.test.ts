import { describe, expect, it } from 'vitest';

import type { PlaceFact, SpatialQueryRequest } from '../src/index.js';
import { runSpatialQuery } from '../src/query/index.js';
import type { SpatialQueryResult } from '../src/query/types.js';
import { captureStoreState, DIM, makeQueryParts, makeQuerySources, runQuery, WORLD } from './query-fixtures.js';

const CELL_A = { x: 0, y: 64, z: 0 };
const CELL_B = { x: 1, y: 64, z: 0 };

function place(id: string, overrides: Partial<PlaceFact> = {}): PlaceFact {
  return {
    id,
    kind: 'place',
    label: `place ${id}`,
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
    observedAt: 100,
    source: { source: 'agent' },
    gone: false,
    ...overrides,
  };
}

function invalid(request: unknown): string {
  const result = runQuery(makeQueryParts(), request);
  expect(result.status).toBe('invalid_request');
  return result.problem?.kind === 'invalid_request' ? result.problem.detail : '';
}

function ids(result: SpatialQueryResult): string[] {
  if (result.data === undefined || !('items' in result.data)) throw new Error('expected paged data');
  return result.data.items.map((item) => item.id);
}

describe('query request boundary', () => {
  it('rejects retired route kinds instead of keeping unsupported stubs', () => {
    for (const kind of [
      'fragments',
      'traversals',
      'edges',
      'historyRoute',
      'anchor',
      'components',
      'segments',
      'portals',
      'frontiers',
    ]) {
      expect(invalid({ kind, dim: DIM })).toBe(`unknown query kind "${kind}"`);
    }
  });

  it('rejects unknown fields and malformed cells', () => {
    expect(invalid({ kind: 'cells', dim: DIM, positions: [CELL_A], limit: 1 })).toContain('unknown field "limit"');
    expect(invalid({ kind: 'nodes', dim: DIM, namespace: 'agent' })).toContain('unknown field "namespace"');
    expect(invalid({ kind: 'cells', dim: '', positions: [CELL_A] })).toContain('cells.dim');
    expect(invalid({ kind: 'cells', dim: DIM, positions: [{ x: 0.5, y: 64, z: 0 }] })).toContain('finite integer');
    expect(invalid({ kind: 'places', limit: 0 })).toContain('limit must be an integer');
  });

  it('answers containerContents with the host ledger boundary, never an empty list', () => {
    const result = runQuery(makeQueryParts(), { kind: 'containerContents', dim: DIM });
    expect(result.status).toBe('unsupported');
    expect(result.problem?.kind).toBe('host_ledger');
  });
});

describe('facts-backed semantic kinds', () => {
  it('projects places and merges nodes from the facts store only', () => {
    const parts = makeQueryParts();
    parts.facts.upsertPlace(place('p1'));
    parts.facts.upsertPlace(place('p2', { kind: 'base', label: 'home' }));

    expect(ids(runQuery(parts, { kind: 'places', dim: DIM }))).toEqual(['p1', 'p2']);
    expect(ids(runQuery(parts, { kind: 'nodes', dim: DIM }))).toEqual(['p1', 'p2']);
    const base = (runQuery(parts, { kind: 'nodes', dim: DIM, tag: 'base' }).data as
      | { items: { id: string; tag: string }[] }
      | undefined)?.items;
    expect(base).toHaveLength(1);
    expect(base?.[0]).toMatchObject({ id: 'p2', tag: 'base' });
  });

  it('is read-only across every supported kind', () => {
    const parts = makeQueryParts();
    parts.facts.upsertPlace(place('p1'));
    const before = captureStoreState(parts);
    const requests: SpatialQueryRequest[] = [
      { kind: 'cells', dim: DIM, positions: [CELL_A, CELL_B] },
      { kind: 'nodes', dim: DIM },
      { kind: 'places', dim: DIM },
      { kind: 'resourceAnchors', dim: DIM },
      { kind: 'containerAnchors', dim: DIM },
      { kind: 'containerContents', dim: DIM },
      { kind: 'snapshot' },
      { kind: 'capabilities' },
    ];
    for (const request of requests) runQuery(parts, request);
    expect(captureStoreState(parts)).toEqual(before);
  });

  it('keeps an empty facts store distinct from a missing one', () => {
    const parts = makeQueryParts();
    expect(runQuery(parts, { kind: 'places', dim: DIM }).status).toBe('ok');
    const withoutFacts = runSpatialQuery(
      { ...makeQuerySources(parts), facts: undefined },
      { kind: 'places', dim: DIM },
    );
    expect(withoutFacts.status).toBe('unsupported');
  });
});
