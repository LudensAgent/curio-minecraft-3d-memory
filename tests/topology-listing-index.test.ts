/**
 * M8.3 H2 — the materialized paging indexes must be interchangeable with the
 * linear (filter + sort + page) listing they replaced.
 *
 * Every assertion here compares the store's page against a reference linear
 * implementation over the fixture arrays used to populate the store: same
 * visible set, same order, same `total`, same `nextAfter`, under every filter
 * combination, every page size and every cursor position. The `restoreSnapshot`
 * case restores from `checkpointSnapshot()` input and still compares the
 * restored store's page against the fixture linear reference.
 * The index is a derived view only, so writes after a read must be reflected by
 * the next read.
 */

import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type {
  EdgeQuery,
  FragmentQuery,
  NodeQuery,
  PathFragment,
  SpatialNode,
  TraversalEvidence,
  TraversalQuery,
} from '../src/index.js';
import { pathFragment, traversalEvidence } from './fakes.js';

const WORLD = 'world';

// --- linear reference implementations (the pre-index algorithm) ---

function linearPage(
  keys: readonly string[],
  after: string | undefined,
  limit: number,
): { ids: string[]; total: number; nextAfter?: string } {
  const start = after === undefined ? 0 : keys.findIndex((id) => id > after);
  const from = start === -1 ? keys.length : start;
  const ids = keys.slice(from, from + limit);
  const nextAfter = from + ids.length < keys.length ? ids[ids.length - 1] : undefined;
  // `nextAfter` is absent (not present-and-undefined) when the listing is exhausted.
  return nextAfter === undefined ? { ids, total: keys.length } : { ids, total: keys.length, nextAfter };
}

function refNodes(nodes: readonly SpatialNode[], query: NodeQuery) {
  const ids = nodes
    .filter(
      (node) =>
        (query.dim === undefined || node.dim === query.dim) &&
        (query.source === undefined || node.source === query.source) &&
        (query.tag === undefined || node.tag === query.tag) &&
        (query.label === undefined || node.label === query.label),
    )
    .map((node) => node.id)
    .sort();
  return linearPage(ids, query.after, query.limit ?? 100);
}

function refEdges(edges: readonly { id: string; from: string; to: string; type: string; basis: string }[], nodes: readonly SpatialNode[], query: EdgeQuery) {
  const dimOf = new Map(nodes.map((node) => [node.id, node.dim]));
  const ids = edges
    .filter((edge) => {
      if (query.dim !== undefined && dimOf.get(edge.from) !== query.dim) return false;
      if (query.from !== undefined && edge.from !== query.from) return false;
      if (query.to !== undefined && edge.to !== query.to) return false;
      if (query.type !== undefined && edge.type !== query.type) return false;
      if (query.basis !== undefined && edge.basis !== query.basis) return false;
      return true;
    })
    .map((edge) => edge.id)
    .sort();
  return linearPage(ids, query.after, query.limit ?? 100);
}

function refFragments(fragments: readonly PathFragment[], query: FragmentQuery) {
  const ids = fragments
    .filter(
      (f) =>
        (query.dim === undefined || f.dim === query.dim) &&
        (query.source === undefined || f.geometrySource === query.source) &&
        (query.kind === undefined || f.kind === query.kind),
    )
    .map((f) => f.id)
    .sort();
  return linearPage(ids, query.after, query.limit ?? 100);
}

function refTraversals(traversals: readonly TraversalEvidence[], query: TraversalQuery) {
  const ids = traversals
    .filter(
      (t) =>
        (query.fragmentId === undefined || t.fragmentId === query.fragmentId) &&
        (query.dim === undefined || t.dim === query.dim),
    )
    .map((t) => t.id)
    .sort();
  return linearPage(ids, query.after, query.limit ?? 100);
}

function pageShape<T extends { id: string }>(page: { items: T[]; total: number; nextAfter?: string }) {
  const shape: { ids: string[]; total: number; nextAfter?: string } = {
    ids: page.items.map((item) => item.id),
    total: page.total,
  };
  if (page.nextAfter !== undefined) shape.nextAfter = page.nextAfter;
  return shape;
}

// --- fixtures: id order deliberately differs from insertion order ---

const DIMS = ['overworld', 'nether'];
const TAGS = ['base', 'resource', 'danger', undefined] as const;
const LABELS = ['home', 'mine', undefined] as const;
const SOURCES = ['agent', 'program'] as const;

function seededNode(i: number): SpatialNode {
  const t = i * 7919;
  const node: SpatialNode = {
    id: `node:${String((t * 31) % 9973).padStart(4, '0')}:${i}`,
    kind: i % 5 === 0 ? 'turn' : 'place',
    source: SOURCES[t % 2]!,
    worldId: WORLD,
    dim: DIMS[t % 2]!,
    location: { kind: 'exact', pos: { x: i, y: 64, z: i % 7 } },
  };
  const tag = TAGS[t % 4]!;
  if (tag !== undefined) node.tag = tag;
  const label = LABELS[t % 3]!;
  if (label !== undefined) node.label = label;
  if (i % 11 === 0) {
    node.gone = true;
    node.goneAt = 900;
  }
  return node;
}

const INSERTION_ORDER = [5, 3, 9, 0, 8, 1, 7, 2, 6, 4, 14, 10, 13, 11, 12, 20, 19, 18, 17, 16];

function makeTopology() {
  const history = new FragmentStore(WORLD, { maxTraversals: 64 });
  const topology = new TopologyStore(history, { now: () => 1000 });
  const nodes = INSERTION_ORDER.map(seededNode);
  for (const node of nodes) topology.saveNode(node);
  // Edges reference existing nodes; every dim-pairing edge stays inside one dim.
  const byDim = DIMS.map((dim) => nodes.filter((node) => node.dim === dim && node.gone !== true));
  const edges: { id: string; from: string; to: string; type: string; basis: string }[] = [];
  for (const group of byDim) {
    for (let i = 0; i + 1 < group.length; i += 1) {
      const id = `edge:${group[i]!.id}->${group[i + 1]!.id}`;
      topology.saveEdge({
        id,
        from: group[i]!.id,
        to: group[i + 1]!.id,
        type: i % 3 === 0 ? 'STAIRCASE' : 'HORIZONTAL',
        basis: 'candidate',
        evidenceIds: [],
      });
      edges.push({ id, from: group[i]!.id, to: group[i + 1]!.id, type: i % 3 === 0 ? 'STAIRCASE' : 'HORIZONTAL', basis: 'candidate' });
    }
  }
  return { history, topology, nodes, edges };
}

function makeFragments() {
  const history = new FragmentStore(WORLD, { maxTraversals: 64 });
  const kinds = ['dug', 'walked', 'bridge', 'built'] as const;
  const sources = ['traversal', 'observed_structure', 'legacy'] as const;
  const order = [7, 2, 9, 0, 5, 3, 8, 1, 6, 4];
  const fragments = order.map((i) =>
    pathFragment(`frag:${i}`, {
      dim: DIMS[i % 2]!,
      kind: kinds[i % 4]!,
      geometrySource: sources[i % 3]!,
    }),
  );
  for (const fragment of fragments) history.saveFragment(fragment);
  const traversals: TraversalEvidence[] = [];
  const evOrder = [4, 0, 3, 1, 2];
  for (const i of evOrder) {
    const fragment = fragments[i % fragments.length]!;
    const evidence = traversalEvidence(
      `ev:${i}`,
      fragment.id,
      { x: i, y: 64, z: 0 },
      { x: i + 1, y: 64, z: 0 },
      { dim: fragment.dim },
    );
    history.addTraversal(evidence);
    traversals.push(evidence);
  }
  return { history, fragments, traversals };
}

// --- assertions ---

describe('TopologyStore.nodes — index page equals the linear listing', () => {
  it('matches for every filter combination, limit and cursor', () => {
    const { topology, nodes } = makeTopology();
    const queries: NodeQuery[] = [{}, { dim: 'overworld' }, { dim: 'nether' }, { source: 'agent' }, { source: 'program' }];
    for (const tag of TAGS) {
      for (const label of LABELS) {
        for (const source of SOURCES) {
          const base: NodeQuery = { source };
          if (tag !== undefined) base.tag = tag;
          if (label !== undefined) base.label = label;
          for (const dim of DIMS) {
            const query: NodeQuery = { ...base, dim };
            queries.push(query);
            queries.push({ dim, source });
            if (tag !== undefined) queries.push({ dim, tag });
            if (label !== undefined) queries.push({ dim, label, source });
          }
          queries.push(base);
          if (tag !== undefined) queries.push({ tag });
          if (label !== undefined) queries.push({ label });
        }
      }
    }
    const allIds = nodes.map((node) => node.id).sort();
    for (const base of queries) {
      for (const limit of [1, 2, 3, 7, 100]) {
        const cursors: (string | undefined)[] = [undefined, ...allIds];
        for (const after of cursors) {
          const query: NodeQuery = { ...base, limit };
          if (after !== undefined) query.after = after;
          expect(pageShape(topology.nodes(query)), JSON.stringify(query)).toEqual(refNodes(nodes, query));
        }
      }
    }
  });

  it('keeps the unfiltered total and page across every cursor', () => {
    const { topology, nodes } = makeTopology();
    const sorted = nodes.map((node) => node.id).sort();
    let after: string | undefined;
    const seen: string[] = [];
    for (;;) {
      const page = topology.nodes({ after, limit: 3 });
      expect(page.total).toBe(nodes.length);
      seen.push(...page.items.map((node) => node.id));
      if (page.nextAfter === undefined) break;
      after = page.nextAfter;
    }
    expect(seen).toEqual(sorted);
  });
});

describe('TopologyStore.edges — index page equals the linear listing', () => {
  it('matches for every filter combination, limit and cursor', () => {
    const { topology, nodes, edges } = makeTopology();
    const queries: EdgeQuery[] = [{}, { dim: 'overworld' }, { dim: 'nether' }, { type: 'HORIZONTAL' }, { basis: 'candidate' }, { basis: 'traversed' }];
    const fromIds = [...new Set(edges.map((edge) => edge.from))].slice(0, 4);
    const toIds = [...new Set(edges.map((edge) => edge.to))].slice(0, 4);
    for (const from of fromIds) queries.push({ from }, { dim: 'overworld', from });
    for (const to of toIds) queries.push({ to }, { dim: 'nether', to });
    queries.push({ dim: 'overworld', type: 'STAIRCASE' }, { type: 'STAIRCASE', basis: 'candidate' });
    const allIds = edges.map((edge) => edge.id).sort();
    for (const base of queries) {
      for (const limit of [1, 3, 100]) {
        for (const after of [undefined, ...allIds]) {
          const query: EdgeQuery = { ...base, limit };
          if (after !== undefined) query.after = after;
          expect(pageShape(topology.edges(query)), JSON.stringify(query)).toEqual(refEdges(edges, nodes, query));
        }
      }
    }
  });
});

describe('FragmentStore.fragments / traversals — index page equals the linear listing', () => {
  it('matches fragments for every filter combination, limit and cursor', () => {
    const { history, fragments } = makeFragments();
    const queries: FragmentQuery[] = [{}, { dim: 'overworld' }, { dim: 'nether' }, { kind: 'dug' }, { source: 'legacy' }];
    for (const dim of DIMS) {
      for (const kind of ['dug', 'walked', 'bridge', 'built'] as const) {
        for (const source of ['traversal', 'observed_structure', 'legacy'] as const) {
          queries.push({ dim, kind, source }, { dim, kind });
        }
      }
    }
    const allIds = fragments.map((f) => f.id).sort();
    for (const base of queries) {
      for (const limit of [1, 2, 4, 100]) {
        for (const after of [undefined, ...allIds]) {
          const query: FragmentQuery = { ...base, limit };
          if (after !== undefined) query.after = after;
          expect(pageShape(history.fragments(query)), JSON.stringify(query)).toEqual(refFragments(fragments, query));
        }
      }
    }
  });

  it('matches traversals for every filter combination, limit and cursor', () => {
    const { history, fragments, traversals } = makeFragments();
    const queries: TraversalQuery[] = [{}, { dim: 'overworld' }, { dim: 'nether' }];
    for (const fragment of fragments) queries.push({ fragmentId: fragment.id }, { fragmentId: fragment.id, dim: fragment.dim });
    const allIds = traversals.map((t) => t.id).sort();
    for (const base of queries) {
      for (const limit of [1, 2, 100]) {
        for (const after of [undefined, ...allIds]) {
          const query: TraversalQuery = { ...base, limit };
          if (after !== undefined) query.after = after;
          expect(pageShape(history.traversals(query)), JSON.stringify(query)).toEqual(refTraversals(traversals, query));
        }
      }
    }
  });
});

describe('listing index — writes after a read stay consistent', () => {
  it('reflects node add / update / delete and edge add / delete', () => {
    const { topology } = makeTopology();
    // Warm the index with reads.
    topology.nodes({ limit: 2 });
    topology.nodes({ dim: 'overworld', limit: 2 });
    topology.nodes({ tag: 'base', limit: 2 });
    topology.edges({ limit: 2 });
    topology.edges({ dim: 'overworld', limit: 2 });

    const added: SpatialNode = {
      id: 'node:0000:added',
      kind: 'place',
      source: 'agent',
      worldId: WORLD,
      dim: 'overworld',
      location: { kind: 'exact', pos: { x: 100, y: 64, z: 100 } },
      tag: 'base',
      label: 'home',
    };
    topology.saveNode(added);
    expect(topology.nodes().total).toBe(21);
    expect(topology.nodes({ dim: 'overworld' }).total).toBeGreaterThan(0);
    expect(topology.nodes({ tag: 'base' }).items.map((n) => n.id)).toContain('node:0000:added');
    expect(topology.nodes({ label: 'home' }).items.map((n) => n.id)).toContain('node:0000:added');

    // Tag changes move the node between tag buckets.
    topology.updateNode('node:0000:added', { tag: 'danger' });
    expect(topology.nodes({ tag: 'base' }).items.map((n) => n.id)).not.toContain('node:0000:added');
    expect(topology.nodes({ tag: 'danger' }).items.map((n) => n.id)).toContain('node:0000:added');

    const edgeId = `edge:${added.id}->node:0000:added`;
    const edgeCountBefore = topology.edges().total;
    topology.saveEdge({ id: edgeId, from: added.id, to: added.id, type: 'HORIZONTAL', basis: 'candidate', evidenceIds: [] });
    expect(topology.edges().total).toBe(edgeCountBefore + 1);
    expect(topology.edges({ from: added.id }).items.map((e) => e.id)).toEqual([edgeId]);
    expect(topology.edges({ dim: 'overworld' }).items.map((e) => e.id)).toContain(edgeId);
    topology.forgetEdge(edgeId);
    expect(topology.edges().total).toBe(edgeCountBefore);
    expect(topology.edges({ dim: 'overworld' }).items.map((e) => e.id)).not.toContain(edgeId);

    topology.forgetNode(added.id);
    expect(topology.nodes().total).toBe(20);
    expect(topology.nodes({ tag: 'danger' }).items.map((n) => n.id)).not.toContain(added.id);
  });

  it('reflects an evicted program node', () => {
    const history = new FragmentStore(WORLD);
    const topology = new TopologyStore(history, { maxProgramNodes: 2, maxAgentNodes: 10, now: () => 1000 });
    const program = (i: number): SpatialNode => ({
      id: `prog:${i}`,
      kind: 'branch',
      source: 'program',
      worldId: WORLD,
      dim: 'overworld',
      location: { kind: 'exact', pos: { x: i, y: 64, z: 0 } },
    });
    topology.saveNode(program(0));
    topology.saveNode(program(1));
    expect(topology.nodes({ source: 'program' }).items.map((n) => n.id)).toEqual(['prog:0', 'prog:1']);
    // Reaching the quota evicts the oldest (unreferenced) program node.
    topology.saveNode(program(2));
    expect(topology.nodes({ source: 'program' }).items.map((n) => n.id)).toEqual(['prog:1', 'prog:2']);
    expect(topology.nodes({ source: 'program' }).total).toBe(2);
    expect(topology.nodes().total).toBe(2);
  });

  it('reflects fragment add / delete cascade and traversal add', () => {
    const { history } = makeFragments();
    history.fragments({ limit: 1 });
    history.fragments({ dim: 'overworld', limit: 1 });
    history.traversals({ limit: 1 });

    const extra = pathFragment('frag:zzz', { dim: 'overworld', kind: 'dug', geometrySource: 'legacy' });
    history.saveFragment(extra);
    expect(history.fragments().total).toBe(11);
    expect(history.fragments({ dim: 'overworld' }).items.map((f) => f.id)).toContain('frag:zzz');

    history.updateFragment('frag:zzz', { kind: 'built' });
    expect(history.fragments({ kind: 'dug' }).items.map((f) => f.id)).not.toContain('frag:zzz');
    expect(history.fragments({ kind: 'built' }).items.map((f) => f.id)).toContain('frag:zzz');

    const evidence = traversalEvidence('ev:zzz', 'frag:zzz', { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 });
    history.addTraversal(evidence);
    expect(history.traversals().total).toBe(6);
    expect(history.traversals({ fragmentId: 'frag:zzz' }).items.map((t) => t.id)).toEqual(['ev:zzz']);

    history.forgetFragment('frag:zzz');
    expect(history.fragments().total).toBe(10);
    expect(history.traversals().total).toBe(5);
    expect(history.traversals({ fragmentId: 'frag:zzz' }).total).toBe(0);
  });

  it('rebuilds the index after restoreSnapshot', () => {
    const { topology, nodes } = makeTopology();
    topology.nodes({ limit: 5 });
    const snapshot = topology.checkpointSnapshot();
    const history = new FragmentStore(WORLD);
    const restored = new TopologyStore(history, { now: () => 1000 });
    restored.restoreSnapshot(snapshot);
    expect(pageShape(restored.nodes({ limit: 100 }))).toEqual(refNodes(nodes, { limit: 100 }));
  });
});
