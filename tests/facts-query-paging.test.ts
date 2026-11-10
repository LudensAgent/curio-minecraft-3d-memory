import { describe, expect, it } from 'vitest';

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
  it('does not advertise legacy route reads when a facts store retires them', () => {
    const facts = new InMemoryFactStore();
    const sources = mixedFactsSources(facts);
    const capabilities = runSpatialQuery(sources, { kind: 'capabilities' });
    expect(capabilities.status).toBe('ok');
    if (capabilities.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(capabilities.data.capabilities.query).toMatchObject({
      fragments: false,
      traversals: false,
      edges: false,
      historyRoute: false,
      anchors: false,
      components: false,
      segments: false,
      portals: false,
      nodes: true,
      resourceAnchors: true,
      containerAnchors: true,
    });
    // The report and the dispatcher must agree for the same request.
    const history = runSpatialQuery(sources, {
      kind: 'historyRoute', dim: DIM, from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 },
    });
    expect(history.status).toBe('unsupported');
    expect(capabilities.data.capabilities.plan.walkSearch).toBe(false);
  });

  it('keeps the full compatibility composition report when facts are absent', () => {
    const capabilities = runSpatialQuery(makeQuerySources(makeQueryParts()), { kind: 'capabilities' });
    if (capabilities.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(capabilities.data.capabilities.query.fragments).toBe(true);
    expect(capabilities.data.capabilities.plan.walkSearch).toBe(true);
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
