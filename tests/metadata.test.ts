import { describe, expect, it } from 'vitest';

import { FragmentStore, TopologyStore } from '../src/index.js';
import type { PathFragment, SpatialNode, Vec3Like } from '../src/index.js';

const WORLD = 'world';
const DIM = 'overworld';

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function fragment(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'frag-1',
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [pt(0.5, 64, 0.5)],
    polyline: [pt(0.5, 64, 0.5), pt(1.5, 64, 0.5)],
    geometrySource: 'traversal',
    deepestY: 64,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

function node(overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id: 'node-1',
    kind: 'place',
    source: 'program',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: pt(1, 64, 1) },
    ...overrides,
  };
}

describe('PathFragment opaque metadata', () => {
  it('round-trips metadata and externalRef through save/get', () => {
    const store = new FragmentStore(WORLD);
    const saved = fragment({
      externalRef: 'psg_legacy',
      metadata: { curio: { v: 1, dug: 3, ores: { iron_ore: 2 }, archivedAt: 2000 } },
    });
    expect(store.saveFragment(saved)).toEqual({ status: 'inserted' });

    const read = store.getFragment('frag-1');
    expect(read?.externalRef).toBe('psg_legacy');
    expect(read?.metadata).toEqual(saved.metadata);

    // Returned values are isolated copies.
    (read!.metadata!.curio as { dug: number }).dug = 99;
    expect(store.getFragment('frag-1')?.metadata).toEqual(saved.metadata);
  });

  it('is idempotent for deep-equal metadata regardless of key order', () => {
    const store = new FragmentStore(WORLD);
    store.saveFragment(fragment({ metadata: { a: 1, b: { c: 2, d: 3 } } }));
    expect(store.saveFragment(fragment({ metadata: { b: { d: 3, c: 2 }, a: 1 } }))).toEqual({
      status: 'unchanged',
    });
  });

  it('rejects a conflicting re-save and updates through FragmentChanges', () => {
    const store = new FragmentStore(WORLD);
    store.saveFragment(fragment({ metadata: { a: 1 } }));
    expect(() => store.saveFragment(fragment({ metadata: { a: 2 } }))).toThrow(/already exists/);

    expect(store.updateFragment('frag-1', { metadata: { a: 2 } })).toEqual({ status: 'updated' });
    expect(store.getFragment('frag-1')?.metadata).toEqual({ a: 2 });

    expect(store.updateFragment('frag-1', { metadata: undefined })).toEqual({ status: 'updated' });
    expect(store.getFragment('frag-1')?.metadata).toBeUndefined();
  });

  it('rejects non-JSON, cyclic, too-deep and oversized metadata', () => {
    const store = new FragmentStore(WORLD, { maxMetadataBytes: 200 });
    expect(() =>
      store.saveFragment(fragment({ metadata: { a: undefined } as never })),
    ).toThrow(/non-JSON/);
    expect(() =>
      store.saveFragment(fragment({ metadata: { n: Number.NaN } })),
    ).toThrow(/non-finite/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => store.saveFragment(fragment({ metadata: cyclic as never }))).toThrow(/cycle/);

    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } };
    expect(() => store.saveFragment(fragment({ metadata: deep }))).toThrow(/depth/);

    expect(() => store.saveFragment(fragment({ metadata: { text: 'x'.repeat(300) } }))).toThrow(
      /exceeding/,
    );
  });
});

describe('SpatialNode opaque metadata and durability', () => {
  it('round-trips metadata through save/get and supports a metadata update', () => {
    const store = new TopologyStore(new FragmentStore(WORLD));
    const saved = node({ externalRef: 'chest:overworld:1,64,1', metadata: { curio: { type: 'chest' } } });
    store.saveNode(saved);
    expect(store.getNode('node-1')?.metadata).toEqual(saved.metadata);
    expect(store.getNode('node-1')?.externalRef).toBe('chest:overworld:1,64,1');

    expect(store.updateNode('node-1', { metadata: { curio: { type: 'chest', freeSlots: 3 } } })).toEqual({
      status: 'updated',
    });
    expect(store.getNode('node-1')?.metadata).toEqual({ curio: { type: 'chest', freeSlots: 3 } });
  });

  it('does not evict a durable program node when the program quota is full', () => {
    const store = new TopologyStore(new FragmentStore(WORLD), { maxProgramNodes: 1 });
    store.saveNode(node({ id: 'durable', durable: true, metadata: { keep: true } }));
    expect(() => store.saveNode(node({ id: 'other' }))).toThrow(/program node capacity/);
    expect(store.getNode('durable')?.metadata).toEqual({ keep: true });
  });
});
