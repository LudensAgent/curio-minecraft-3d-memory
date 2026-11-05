import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/topology/index.js';
import type { SpatialNode } from '../src/topology/index.js';
import type { Vec3Like } from '../src/types.js';

const WORLD = 'world';
const DIM = 'overworld';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function node(id: string, pos: Vec3Like, overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id,
    kind: 'place',
    source: 'agent',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { ...pos } },
    ...overrides,
  };
}

function stubHistory() {
  return { worldId: WORLD, getFragment: () => null, getTraversal: () => null };
}

describe('TopologyStore — named agent nodes', () => {
  it('records a named point as a durable agent node and re-records idempotently', () => {
    const store = new TopologyStore(new FragmentStore(WORLD));
    const first = store.recordNode('我的基地', pt(1.5, 64, 2.5), 'base', {
      dim: DIM,
      observedAt: 1000,
      externalRef: 'landmark-1',
    });
    expect(first.source).toBe('agent');
    expect(first.label).toBe('我的基地');
    expect(first.tag).toBe('base');
    expect(first.kind).toBe('place');
    expect(first.observedAt).toBe(1000);
    expect(first.externalRef).toBe('landmark-1');

    const second = store.recordNode('我的基地', pt(1.5, 64, 2.5), 'waypoint', {
      dim: DIM,
      observedAt: 2000,
    });
    expect(second.id).toBe(first.id);
    expect(second.tag).toBe('waypoint');
    expect(second.observedAt).toBe(2000);
    expect(store.nodes().total).toBe(1);
    expect(store.nodes({ label: '我的基地' }).items.map((n) => n.id)).toEqual([first.id]);

    expect(() => store.recordNode('', pt(0, 0, 0), undefined, { dim: DIM })).toThrow(/label/);
    expect(() => store.recordNode('x', pt(0, 0, 0), undefined, { dim: '' })).toThrow(/dim/);
    expect(() => store.recordNode('x', pt(0, Number.NaN, 0), undefined, { dim: DIM })).toThrow(/finite/);
  });

  it('keeps kind and tag orthogonal', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node('a', pt(0, 64, 0), { kind: 'branch', tag: 'resource' }));
    const got = store.getNode('a')!;
    expect(got.kind).toBe('branch');
    expect(got.tag).toBe('resource');
    expect(() => store.saveNode(node('bad', pt(0, 64, 0), { source: 'other' as never }))).toThrow(/source/);
  });

  it('separates the agent display namespace from program-generated points', () => {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node('agent-1', pt(0, 64, 0), { label: '家', tag: 'base' }));
    store.saveNode(node('prog-1', pt(5, 64, 5), { source: 'program', label: 'ore' }));

    // Default display namespace is agent-only, so program noise cannot bury names.
    expect(store.displayNodes().items.map((n) => n.id)).toEqual(['agent-1']);
    expect(store.displayNodes({ namespace: 'program' }).items.map((n) => n.id)).toEqual(['prog-1']);
    // The raw listing still exposes both for diagnostics.
    expect(store.nodes().total).toBe(2);
  });

  it('evicts the oldest program node but never an agent node or a referenced program node', () => {
    const store = new TopologyStore(stubHistory(), { maxAgentNodes: 2, maxProgramNodes: 1 });
    store.saveNode(node('agent-1', pt(0, 64, 0)));
    store.saveNode(node('prog-1', pt(1, 64, 0), { source: 'program' }));
    expect(store.saveNode(node('prog-2', pt(2, 64, 0), { source: 'program' })).status).toBe('inserted');
    expect(store.getNode('prog-1')).toBeNull();
    expect(store.getNode('prog-2')).not.toBeNull();
    expect(store.getNode('agent-1')).not.toBeNull();

    // Referencing prog-2 from an edge makes it ineligible for eviction.
    store.saveNode(node('target', pt(3, 64, 0), { source: 'agent' }));
    store.saveEdge({
      id: 'e',
      from: 'prog-2',
      to: 'target',
      type: 'HORIZONTAL',
      basis: 'candidate',
      evidenceIds: [],
    });
    expect(() =>
      store.saveNode(node('prog-3', pt(4, 64, 0), { source: 'program' })),
    ).toThrow(/every program node is referenced/);
    expect(store.getNode('prog-2')).not.toBeNull();
    // Agent remains durable.
    expect(() => store.saveNode(node('agent-2', pt(5, 64, 0)))).toThrow(/agent/);
  });
});

describe('TopologyStore — gone anchors', () => {
  function setup() {
    const store = new TopologyStore(stubHistory());
    store.saveNode(node('cave', pt(10, 30, 10), { observedAt: 1000, label: '我的矿洞' }));
    store.saveNode(node('surface', pt(10, 70, 10)));
    return { store };
  }

  it('requires real observation evidence to mark a node gone', () => {
    const { store } = setup();
    expect(() => store.markGone('cave', { sessionId: '', observedAt: 2000, source: 'vision' })).toThrow(
      /sessionId/,
    );
    expect(() =>
      store.markGone('cave', { sessionId: 's1', observedAt: Number.NaN, source: 'vision' }),
    ).toThrow(/observedAt/);
    expect(() => store.markGone('cave', { sessionId: 's1', observedAt: 2000, source: '' })).toThrow(
      /source/,
    );
    expect(() => store.markGone('ghost', { sessionId: 's1', observedAt: 2000, source: 'vision' })).toThrow(
      /unknown node/,
    );
    // Evidence older than the node's last observation cannot rewrite history.
    expect(() => store.markGone('cave', { sessionId: 's1', observedAt: 500, source: 'vision' })).toThrow(
      /older/,
    );
    expect(store.getNode('cave')!.gone).toBeUndefined();
  });

  it('preserves the node and its evidence, and is idempotent', () => {
    const { store } = setup();
    const evidence = {
      sessionId: 's1',
      observedAt: 2000,
      source: 'vision_scan',
      observationIds: ['obs-9'],
      reason: 'scanned an empty face',
    };
    expect(store.markGone('cave', evidence).status).toBe('updated');
    const node = store.getNode('cave')!;
    expect(node.gone).toBe(true);
    expect(node.goneAt).toBe(2000);
    expect(node.goneEvidence).toEqual(evidence);
    expect(node.label).toBe('我的矿洞');
    expect(store.nodes().total).toBe(2);

    expect(store.markGone('cave', evidence).status).toBe('unchanged');
  });

  it('finds gone anchors near a position', () => {
    const { store } = setup();
    store.markGone('cave', { sessionId: 's1', observedAt: 2000, source: 'vision' });
    expect(store.goneNear(DIM, pt(10.5, 31, 10.5), 2).map((n) => n.id)).toEqual(['cave']);
    expect(store.goneNear(DIM, pt(10.5, 31, 10.5), 0.5)).toEqual([]);
    expect(store.goneNear('nether', pt(10.5, 31, 10.5), 2)).toEqual([]);
    // The still-present node is not reported.
    expect(store.goneNear(DIM, pt(10, 70, 10), 1)).toEqual([]);
  });
});
