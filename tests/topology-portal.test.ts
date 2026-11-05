import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/topology/index.js';
import type {
  PortalTraversalEvidence,
  SpatialNode,
} from '../src/topology/index.js';
import type { Vec3Like } from '../src/types.js';

const WORLD = 'world';
const OVERWORLD = 'overworld';
const NETHER = 'nether';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function node(id: string, dim: string, pos: Vec3Like): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'agent',
    tag: 'portal',
    worldId: WORLD,
    dim,
    location: { kind: 'exact', pos: { ...pos } },
  };
}

function outbound(id = 'pt-out'): PortalTraversalEvidence {
  return {
    id,
    edgeId: 'portal-1',
    direction: 'forward',
    sessionId: 's1',
    observedAt: 1000,
    observationIds: ['obs-1'],
    source: 'portal_use',
  };
}

function back(id = 'pt-back'): PortalTraversalEvidence {
  return {
    id,
    edgeId: 'portal-1',
    direction: 'reverse',
    sessionId: 's2',
    observedAt: 2000,
    observationIds: ['obs-2'],
    source: 'portal_use',
  };
}

function setup() {
  const history = new FragmentStore(WORLD);
  const store = new TopologyStore(history);
  // Observed coordinates only: the Nether endpoint is not 1/8 of the overworld one.
  store.saveNode(node('o', OVERWORLD, pt(10, 64, 10)));
  store.saveNode(node('n', NETHER, pt(77, 40, -33)));
  return { history, store };
}

describe('TopologyStore — portal connections', () => {
  it('accepts a cross-dimension portal and keeps it out of the walk graph', () => {
    const { store } = setup();
    expect(
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound()]).status,
    ).toBe('inserted');

    const portals = store.portalEdges();
    expect(portals).toHaveLength(1);
    expect(portals[0]!.fromDim).toBe(OVERWORLD);
    expect(portals[0]!.toDim).toBe(NETHER);
    expect(portals[0]!.from).toBe('o');
    expect(portals[0]!.to).toBe('n');

    // Never mixed with walk edges, adjacency or route.
    expect(store.edges().total).toBe(0);
    expect(store.adjacency('o').outEdges).toEqual([]);
    expect(() => store.route('o', 'n')).toThrow(/dimensions/);
  });

  it('derives returnVerified from raw reverse evidence instead of storing it', () => {
    const { store } = setup();
    store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound()]);
    expect(store.getPortalEdge('portal-1')!.returnVerified).toBe(false);

    expect(store.addPortalTraversal('portal-1', back()).status).toBe('inserted');
    const view = store.getPortalEdge('portal-1')!;
    expect(view.returnVerified).toBe(true);
    expect(view.outbound.map((t) => t.id)).toEqual(['pt-out']);
    expect(view.return.map((t) => t.id)).toEqual(['pt-back']);
    expect(view.traversals.map((t) => t.id)).toEqual(['pt-out', 'pt-back']);

    // Raw timestamps and sessions survive; no field named returnVerified is persisted.
    const snapshot = store.checkpointSnapshot();
    expect(snapshot.portalEdges).toHaveLength(1);
    const raw = snapshot.portalEdges![0]! as unknown as Record<string, unknown>;
    expect('returnVerified' in raw).toBe(false);
    expect(snapshot.portalEdges![0]!.traversals.map((t) => t.sessionId)).toEqual(['s1', 's2']);
    expect(snapshot.portalEdges![0]!.traversals.map((t) => t.observedAt)).toEqual([1000, 2000]);
  });

  it('never derives coordinates from scaling; only observed endpoints exist', () => {
    const { store } = setup();
    store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound()]);
    const nether = store.getNode('n')!;
    expect(nether.location).toEqual({ kind: 'exact', pos: pt(77, 40, -33) });
    expect(store.nodes().total).toBe(2);
    // No synthetic scaled endpoint was created anywhere.
    expect(store.nodes().items.map((n) => n.dim).sort()).toEqual([NETHER, OVERWORLD]);
  });

  it('requires outbound traversal evidence and rejects reverse on a directed portal', () => {
    const { store } = setup();
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, []),
    ).toThrow(/at least one/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [back()]),
    ).toThrow(/outbound/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n', directed: true }, [
        outbound(),
        back(),
      ]),
    ).toThrow(/reverse traversal/);
    expect(store.portalEdges()).toEqual([]);
  });

  it('validates traversal evidence shape and ownership', () => {
    const { store } = setup();
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [
        { ...outbound(), edgeId: 'other' },
      ]),
    ).toThrow(/belongs to edge/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [
        { ...outbound(), sessionId: '' },
      ]),
    ).toThrow(/sessionId/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [
        { ...outbound(), observedAt: Number.NaN },
      ]),
    ).toThrow(/observedAt/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [
        { ...outbound(), observationIds: [''] },
      ]),
    ).toThrow(/observationIds/);
    expect(() =>
      store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound(), outbound()]),
    ).toThrow(/duplicate/);

    store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound()]);
    expect(() => store.addPortalTraversal('ghost', back())).toThrow(/unknown portal edge/);
    expect(store.addPortalTraversal('portal-1', outbound()).status).toBe('unchanged');
    expect(() =>
      store.addPortalTraversal('portal-1', { ...outbound(), observedAt: 3000 }),
    ).toThrow(/different content/);
  });

  it('refuses node deletion or relocation while a portal endpoint references it', () => {
    const { store } = setup();
    store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound()]);
    expect(() => store.forgetNode('o')).toThrow(/portal/);
    expect(() =>
      store.updateNode('o', { location: { kind: 'exact', pos: pt(11, 64, 10) } }),
    ).toThrow(/portal/);
    expect(store.getNode('o')?.location).toMatchObject({ pos: pt(10, 64, 10) });
  });

  it('restores portal edges and traversals from a checkpoint', () => {
    const { store } = setup();
    store.savePortalEdge({ id: 'portal-1', from: 'o', to: 'n' }, [outbound(), back()]);
    const snapshot = store.checkpointSnapshot();

    const history2 = new FragmentStore(WORLD);
    const store2 = new TopologyStore(history2);
    store2.restoreSnapshot(snapshot);
    const restored = store2.getPortalEdge('portal-1')!;
    expect(restored.fromDim).toBe(OVERWORLD);
    expect(restored.toDim).toBe(NETHER);
    expect(restored.returnVerified).toBe(true);
    expect(restored.traversals.map((t) => t.id)).toEqual(['pt-out', 'pt-back']);
    expect(store2.edges().total).toBe(0);
  });
});
