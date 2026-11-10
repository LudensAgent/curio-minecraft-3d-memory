import { describe, expect, it } from 'vitest';

import {
  InMemoryFactStore,
  VoxelMap,
  createVoxelFactsQueryPort,
} from '../src/index.js';
import type { ContainerAnchorFact, PlaceFact, ResourceAnchorFact } from '../src/index.js';
import { obs, STONE } from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';

function productionPort(facts = new InMemoryFactStore()) {
  const map = new VoxelMap(WORLD, { now: () => 5000 });
  const port = createVoxelFactsQueryPort({ worldId: WORLD, voxel: map, facts, query: { now: () => 5000 } });
  return { map, facts, port };
}

const place = (over: Partial<PlaceFact> = {}): PlaceFact => ({
  id: 'base', kind: 'base', label: 'home', worldId: WORLD, dim: DIM,
  location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
  observedAt: 100, source: { source: 'agent' }, gone: false, ...over,
});

const resource = (over: Partial<ResourceAnchorFact> = {}): ResourceAnchorFact => ({
  id: 'ore', worldId: WORLD, dim: DIM, label: 'iron_ore',
  sourceCell: { x: 5, y: 60, z: 0 }, observedAt: 200,
  source: { source: 'vision' }, revoked: false, ...over,
});

const container = (over: Partial<ContainerAnchorFact> = {}): ContainerAnchorFact => ({
  id: 'chest', worldId: WORLD, dim: DIM, pos: { x: 2, y: 64, z: 2 },
  externalRef: 'chest-1', observedAt: 300, source: { source: 'vision' },
  gone: false, ledgerRef: `${WORLD}:${DIM}:2,64,2`, ...over,
});

describe('voxel+facts production query composition', () => {
  it('answers cells and semantic facts without any legacy FragmentStore/TopologyStore', () => {
    const { map, facts, port } = productionPort();
    map.observe(obs(STONE, { x: 0, y: 64, z: 0 }));
    facts.upsertPlace(place());
    facts.upsertResource(resource());
    facts.upsertContainer(container());

    const cells = port.query({ kind: 'cells', dim: DIM, positions: [{ x: 0, y: 64, z: 0 }] });
    expect(cells.status).toBe('ok');
    if (cells.data?.kind !== 'cells') throw new Error('expected cells');
    expect(cells.data.cells[0]?.observed).toBe(true);
    expect(cells.data.cells[0]?.state?.name).toBe(STONE.name);

    const nodes = port.query({ kind: 'nodes', dim: DIM });
    expect(nodes.status).toBe('ok');
    expect(nodes.total).toBe(3);

    const places = port.query({ kind: 'nodes', dim: DIM, tag: 'base' });
    expect(places.total).toBe(1);
    const resources = port.query({ kind: 'resourceAnchors', dim: DIM });
    expect(resources.total).toBe(1);
    expect(resources.data?.kind === 'resourceAnchors' ? resources.data.items[0]?.id : null).toBe('ore');
    const containers = port.query({ kind: 'containerAnchors', dim: DIM });
    expect(containers.total).toBe(1);
    expect(containers.data?.kind === 'containerAnchors' ? containers.data.items[0]?.id : null).toBe('chest');
  });

  it('does not fall back to a legacy store when facts are empty', () => {
    const { port } = productionPort();
    const nodes = port.query({ kind: 'nodes', dim: DIM });
    expect(nodes.status).toBe('ok');
    expect(nodes.total).toBe(0);

    const retired = [
      port.query({ kind: 'fragments', dim: DIM }),
      port.query({ kind: 'traversals', dim: DIM, fragmentId: 'f1' }),
      port.query({ kind: 'edges', dim: DIM }),
      port.query({ kind: 'portals' }),
      port.query({ kind: 'historyRoute', dim: DIM, from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 } }),
      port.query({ kind: 'anchor', dim: DIM, here: { x: 0, y: 64, z: 0 }, order: 'surface' }),
      port.query({ kind: 'components', dim: DIM }),
      port.query({ kind: 'segments', fragmentId: 'f1' }),
    ];
    for (const result of retired) {
      expect(result.status).toBe('unsupported');
      expect(result.problem?.kind).toBe('unsupported');
      expect(result.data).toBeUndefined();
    }
  });

  it('reports composition capability, not the package compatibility surface', () => {
    const { port } = productionPort();
    const result = port.query({ kind: 'capabilities' });
    if (result.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    const capabilities = result.data.capabilities;

    expect(capabilities.query.cells).toBe(true);
    expect(capabilities.query.nodes).toBe(true);
    expect(capabilities.query.resourceAnchors).toBe(true);
    expect(capabilities.query.containerAnchors).toBe(true);
    expect(capabilities.query.fragments).toBe(false);
    expect(capabilities.query.historyRoute).toBe(false);
    expect(capabilities.query.portals).toBe(false);
    expect(capabilities.query.containerContents).toBe(false);

    expect(capabilities.memory.beginSession).toBe(true);
    expect(capabilities.memory.markStale).toBe(true);
    expect(capabilities.memory.saveFragment).toBe(false);
    expect(capabilities.memory.addTraversal).toBe(false);
    expect(capabilities.memory.recordNode).toBe(false);
    expect(capabilities.memory.upsertEdge).toBe(false);

    expect(Object.values(capabilities.plan).some(Boolean)).toBe(false);
  });

  it('snapshot reports voxel and facts, never fabricated empty legacy domains', () => {
    const { facts, port } = productionPort();
    facts.upsertPlace(place());
    facts.upsertResource(resource());
    const result = port.query({ kind: 'snapshot' });
    if (result.data?.kind !== 'snapshot') throw new Error('expected snapshot');
    const snapshot = result.data.snapshot;
    expect(snapshot.worldId).toBe(WORLD);
    expect(snapshot.facts).toEqual({ revision: facts.revision, places: 1, resources: 1, containers: 0 });
    expect(snapshot.fragments).toBeUndefined();
    expect(snapshot.topology).toBeUndefined();
  });

  it('keeps gone/revoked history queryable and the query read-only', () => {
    const { map, facts, port } = productionPort();
    map.observe(obs(STONE, { x: 0, y: 64, z: 0 }));
    facts.upsertPlace(place());
    facts.upsertResource(resource());
    facts.markPlaceGone('base', { observedAt: 400, source: { source: 'vision' } });
    facts.revokeResource('ore', { observedAt: 500, source: { source: 'vision' } });

    const revision = facts.revision;
    const saveRevision = map.saveRevision;
    expect(port.query({ kind: 'nodes', dim: DIM }).total).toBe(0);
    expect(port.query({ kind: 'resourceAnchors', dim: DIM }).total).toBe(0);
    expect(port.query({ kind: 'resourceAnchors', dim: DIM, includeGone: true }).total).toBe(1);
    expect(facts.revision).toBe(revision);
    expect(map.saveRevision).toBe(saveRevision);
  });
});
