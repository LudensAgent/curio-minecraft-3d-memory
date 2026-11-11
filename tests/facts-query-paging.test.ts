import { describe, expect, it, vi } from 'vitest';

import { InMemoryFactStore, VoxelMap, createVoxelFactsQueryPort } from '../src/index.js';
import type { ContainerAnchorFact, PlaceFact, ResourceAnchorFact } from '../src/index.js';
import { runSpatialQuery } from '../src/query/index.js';
import type { SpatialQueryResult, SpatialQuerySources } from '../src/query/types.js';
import { makeQueryParts, makeQuerySources, WORLD, DIM } from './query-fixtures.js';

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

function resource(id: string, overrides: Partial<ResourceAnchorFact> = {}): ResourceAnchorFact {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    label: 'iron_ore',
    sourceCell: { x: 5, y: 60, z: 0 },
    sourceCellVersion: 3,
    observedAt: 200,
    source: { source: 'vision' },
    revoked: false,
    ...overrides,
  };
}

function container(id: string, overrides: Partial<ContainerAnchorFact> = {}): ContainerAnchorFact {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    pos: { x: 2, y: 64, z: 2 },
    externalRef: `chest-${id}`,
    observedAt: 300,
    source: { source: 'vision' },
    gone: false,
    ...overrides,
  };
}

function ids(result: SpatialQueryResult): string[] {
  if (result.data === undefined || !('items' in result.data)) throw new Error('expected paged data');
  return result.data.items.map((item) => item.id);
}

function mixedFactsSources(facts: InMemoryFactStore): SpatialQuerySources {
  return { ...makeQuerySources(makeQueryParts()), facts };
}

describe('capability report matches facts dispatch', () => {
  it('advertises exactly the facts-backed semantic kinds', () => {
    const facts = new InMemoryFactStore();
    const sources = mixedFactsSources(facts);
    const capabilities = runSpatialQuery(sources, { kind: 'capabilities' });
    expect(capabilities.status).toBe('ok');
    if (capabilities.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(capabilities.data.capabilities.query).toEqual({
      cells: true,
      nodes: true,
      places: true,
      resourceAnchors: true,
      containerAnchors: true,
      containerContents: false,
      snapshot: false,
      capabilities: true,
    });
    expect(capabilities.data.capabilities).not.toHaveProperty('plan');
    // Retired kinds are rejected by the request boundary, not reported at all.
    expect(runSpatialQuery(sources, { kind: 'fragments', dim: DIM }).status).toBe('invalid_request');
  });

  it('reports no semantic kinds when facts are absent', () => {
    const capabilities = runSpatialQuery(
      { ...makeQuerySources(makeQueryParts()), facts: undefined },
      { kind: 'capabilities' },
    );
    if (capabilities.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(capabilities.data.capabilities.query.nodes).toBe(false);
    expect(capabilities.data.capabilities.query.places).toBe(false);
  });
});

describe('facts snapshot world scoping', () => {
  it('counts only the query port world when one store holds two worlds', () => {
    const facts = new InMemoryFactStore();
    facts.upsertPlace(place('a-place'));
    facts.upsertResource(resource('a-ore'));
    facts.upsertContainer(container('a-chest'));
    facts.upsertPlace(place('b-place', { worldId: 'other-world' }));
    facts.upsertResource(resource('b-ore', { worldId: 'other-world' }));
    facts.upsertContainer(container('b-chest', { worldId: 'other-world' }));

    const map = new VoxelMap(WORLD, { now: () => 5000 });
    const port = createVoxelFactsQueryPort({
      worldId: WORLD,
      voxel: map,
      facts,
      query: { now: () => 5000 },
    });
    const snapshot = port.query({ kind: 'snapshot' });
    expect(snapshot.status).toBe('ok');
    if (snapshot.data?.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(snapshot.data.snapshot.facts).toEqual({ revision: 6, places: 1, resources: 1, containers: 1 });

    const nodes = port.query({ kind: 'nodes' });
    expect(nodes.total).toBe(3);
  });
});

describe('bounded places paging', () => {
  function portWithFacts(facts: InMemoryFactStore) {
    const map = new VoxelMap(WORLD, { now: () => 5000 });
    return createVoxelFactsQueryPort({ worldId: WORLD, voxel: map, facts, query: { now: () => 5000 } });
  }

  it('pages by stable id over three or more pages', () => {
    const facts = new InMemoryFactStore();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) facts.upsertPlace(place(id));
    const port = portWithFacts(facts);

    const collected: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = port.query({ kind: 'places', limit: 2, ...(after === undefined ? {} : { after }) });
      expect(page.status).toBe('ok');
      expect(page.total).toBe(5);
      if (page.data?.kind !== 'places') throw new Error('expected places');
      expect(page.data.pageSource).toBe('memory');
      collected.push(...ids(page));
      after = page.nextAfter;
      pages += 1;
    } while (after !== undefined);
    expect(pages).toBe(3);
    expect(collected).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('reuses the filtered id sequence across pages and rebuilds it after a write', () => {
    const facts = new InMemoryFactStore();
    for (const id of ['p1', 'p2', 'p3', 'p4']) facts.upsertPlace(place(id));

    const first = facts.places({ limit: 2 });
    expect(first.total).toBe(4);
    expect(first.items.map((item) => item.id)).toEqual(['p1', 'p2']);
    const second = facts.places({ limit: 2, after: first.nextAfter });
    expect(second.items.map((item) => item.id)).toEqual(['p3', 'p4']);
    expect(second.total).toBe(4);
    expect(second.nextAfter).toBeUndefined();

    facts.markPlaceGone('p2', { observedAt: 200, source: { source: 'vision' } });
    const live = facts.places({ limit: 10 });
    expect(live.total).toBe(3);
    expect(live.items.map((item) => item.id)).toEqual(['p1', 'p3', 'p4']);
    const all = facts.places({ limit: 10, includeGone: true });
    expect(all.total).toBe(4);
  });

  it('filters by tag, label and source with an exact total', () => {
    const facts = new InMemoryFactStore();
    facts.upsertPlace(place('base1', { kind: 'base', label: 'home' }));
    facts.upsertPlace(place('base2', { kind: 'base', label: 'mine', source: { source: 'program' } }));
    facts.upsertPlace(place('way', { kind: 'place', label: 'home', source: { source: 'program' } }));
    facts.upsertPlace(place('other-world', { worldId: 'other-world', kind: 'base', label: 'home' }));
    const port = portWithFacts(facts);

    const bases = port.query({ kind: 'places', tag: 'base' });
    expect(bases.total).toBe(2);
    expect(ids(bases)).toEqual(['base1', 'base2']);

    const homeProgram = port.query({ kind: 'places', label: 'home', source: 'program' });
    expect(homeProgram.total).toBe(1);
    expect(ids(homeProgram)).toEqual(['way']);

    const secondPage = port.query({ kind: 'places', tag: 'base', limit: 1, after: 'base1' });
    expect(secondPage.total).toBe(2);
    expect(ids(secondPage)).toEqual(['base2']);
    expect(secondPage.nextAfter).toBeUndefined();

    facts.upsertResource(resource('ore', { label: 'home' }));
    facts.upsertContainer(container('chest', { externalRef: 'home' }));
    const mixed = port.query({ kind: 'nodes', label: 'home', source: 'program' });
    expect(mixed.total).toBe(3);
    expect(ids(mixed)).toEqual(['chest', 'ore', 'way']);
  });

  it('filters a large collection in one store read and copies only the requested page', () => {
    const facts = new InMemoryFactStore();
    for (let index = 0; index < 2500; index += 1) {
      facts.upsertPlace(place(String(index).padStart(4, '0'), {
        kind: 'base',
        label: index % 1000 === 0 ? 'home' : 'other',
        source: { source: 'vision' },
      }));
    }
    facts.upsertPlace(place('gone', { kind: 'base', label: 'home', source: { source: 'program' }, gone: true }));
    facts.upsertPlace(place('other-world', { worldId: 'other', kind: 'base', label: 'home', source: { source: 'program' } }));
    const read = vi.spyOn(facts, 'places');
    const page = portWithFacts(facts).query({
      kind: 'places', tag: 'base', label: 'home', source: 'program', after: '0000', limit: 1,
    });
    expect(ids(page)).toEqual(['1000']);
    expect(page.total).toBe(3);
    expect(page.nextAfter).toBe('1000');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.results[0]!.value.items).toHaveLength(1);
  });

  it('hides gone places by default and reveals them only when asked', () => {
    const facts = new InMemoryFactStore();
    facts.upsertPlace(place('live'));
    facts.upsertPlace(place('gone', { gone: true }));
    const port = portWithFacts(facts);

    const live = port.query({ kind: 'places' });
    expect(live.total).toBe(1);
    expect(ids(live)).toEqual(['live']);

    const all = port.query({ kind: 'places', includeGone: true });
    expect(all.total).toBe(2);
    expect(ids(all)).toEqual(['gone', 'live']);
  });

  it('merges nodes from three fact streams in id order across pages', () => {
    const facts = new InMemoryFactStore();
    facts.upsertPlace(place('a-place'));
    facts.upsertPlace(place('c-place'));
    facts.upsertResource(resource('b-ore'));
    facts.upsertResource(resource('e-ore', { sourceCell: { x: 6, y: 60, z: 0 } }));
    facts.upsertContainer(container('d-chest'));
    const port = portWithFacts(facts);

    const collected: string[] = [];
    let after: string | undefined;
    do {
      const page = port.query({ kind: 'nodes', limit: 2, ...(after === undefined ? {} : { after }) });
      expect(page.status).toBe('ok');
      expect(page.total).toBe(5);
      collected.push(...ids(page));
      after = page.nextAfter;
    } while (after !== undefined);
    expect(collected).toEqual(['a-place', 'b-ore', 'c-place', 'd-chest', 'e-ore']);
  });

  it.each([1, 2])('keeps equal ids from all three kinds across pages of %i', (limit) => {
    const facts = new InMemoryFactStore();
    facts.upsertPlace(place('same'));
    facts.upsertResource(resource('same'));
    facts.upsertContainer(container('same'));
    facts.upsertPlace(place('tail'));
    facts.upsertResource(resource('tail', { sourceCell: { x: 6, y: 60, z: 0 } }));
    facts.upsertContainer(container('tail'));
    const port = portWithFacts(facts);
    const collected: string[] = [];
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
      const page = port.query({ kind: 'nodes', limit, ...(after === undefined ? {} : { after }) });
      if (page.data?.kind !== 'nodes') throw new Error('expected nodes');
      expect(page.total).toBe(6);
      expect(page.data.items.length).toBeLessThanOrEqual(limit);
      collected.push(...page.data.items.map(item => `${item.id}:${item.metadata?.factKind}`));
      after = page.nextAfter;
      if (after === undefined) break;
    }
    expect(after).toBeUndefined();
    expect(collected).toEqual([
      'same:place', 'same:resource', 'same:container',
      'tail:place', 'tail:resource', 'tail:container',
    ]);

    // Existing callers may still supply an exclusive bare-id cursor.
    const legacy = port.query({ kind: 'nodes', after: 'same', limit: 3 });
    expect(ids(legacy)).toEqual(['tail', 'tail', 'tail']);
    expect(legacy.total).toBe(6);
    expect(legacy.nextAfter).toBeUndefined();
  });

  it('rejects unknown fields for the places kind', () => {
    const facts = new InMemoryFactStore();
    const port = portWithFacts(facts);
    const result = port.query({ kind: 'places', unexpected: true } as never);
    expect(result.status).toBe('invalid_request');
  });
});

describe('resource source version projection', () => {
  it('exposes both the version and whether it is a known version', () => {
    const facts = new InMemoryFactStore();
    facts.upsertResource(resource('known', { sourceCellVersion: 7 }));
    facts.upsertResource(resource('unknown', {
      sourceCell: { x: 6, y: 60, z: 0 },
      sourceCellVersion: undefined,
    }));
    const map = new VoxelMap(WORLD, { now: () => 5000 });
    const port = createVoxelFactsQueryPort({ worldId: WORLD, voxel: map, facts, query: { now: () => 5000 } });
    const result = port.query({ kind: 'resourceAnchors' });
    if (result.data?.kind !== 'resourceAnchors') throw new Error('expected resourceAnchors');
    const byId = new Map(result.data.items.map((item) => [item.id, item]));
    expect(byId.get('known')?.metadata).toMatchObject({
      sourceCellVersion: 7,
      sourceCellVersionKnown: true,
    });
    // The gap is visible as null/known=false — never a fabricated 0.
    expect(byId.get('unknown')?.metadata).toMatchObject({
      sourceCellVersion: null,
      sourceCellVersionKnown: false,
    });
  });
});
