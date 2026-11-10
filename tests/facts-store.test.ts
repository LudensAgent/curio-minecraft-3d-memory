import { describe, expect, it } from 'vitest';

import { InMemoryFactStore } from '../src/index.js';
import type {
  ContainerAnchorFact,
  PlaceFact,
  ResourceAnchorFact,
} from '../src/index.js';

const WORLD = 'world-1';
const DIM = 'overworld';
const SOURCE = { source: 'vision_scan' } as const;

function place(id: string, overrides: Partial<PlaceFact> = {}): PlaceFact {
  return {
    id,
    kind: 'place',
    label: `place ${id}`,
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: -1, y: 64, z: -2 } },
    observedAt: 100,
    source: { ...SOURCE },
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
    sourceCell: { x: -3, y: 64, z: -7 },
    observedAt: 100,
    source: { ...SOURCE },
    revoked: false,
    ...overrides,
  };
}

function container(
  id: string,
  overrides: Partial<ContainerAnchorFact> = {},
): ContainerAnchorFact {
  return {
    id,
    worldId: WORLD,
    dim: DIM,
    pos: { x: -12, y: 64, z: -30 },
    externalRef: 'chest:base:1',
    observedAt: 100,
    source: { ...SOURCE },
    gone: false,
    ...overrides,
  };
}

describe('fact evidence and host metadata', () => {
  it('keeps newer disappearance evidence ahead of delayed present observations', () => {
    const store = new InMemoryFactStore();
    store.upsertPlace(place('p'));
    store.upsertResource(resource('r'));
    store.upsertContainer(container('c'));
    for (const observedAt of [200, 300]) {
      const evidence = { observedAt, source: SOURCE };
      expect(store.markPlaceGone('p', evidence).outcome).toBe('updated');
      expect(store.revokeResource('r', evidence).outcome).toBe('updated');
      expect(store.markContainerGone('c', evidence).outcome).toBe('updated');
    }
    expect(store.upsertPlace(place('p', { observedAt: 250 })).outcome).toBe('duplicate');
    expect(store.upsertResource(resource('r', { observedAt: 250 })).outcome).toBe('duplicate');
    expect(store.upsertContainer(container('c', { observedAt: 250 })).outcome).toBe('duplicate');
    expect(store.places().total + store.resources().total + store.containers().total).toBe(0);
    expect(store.places({ includeGone: true }).items[0]?.goneAt).toBe(300);
    expect(store.resources({ includeGone: true }).items[0]?.revokedAt).toBe(300);
    expect(store.containers({ includeGone: true }).items[0]?.goneAt).toBe(300);
    expect(store.markContainerGone('c', { observedAt: 250, source: SOURCE }).outcome).toBe('duplicate');
  });

  it('updates opaque host data without re-dating evidence or sharing mutable references', () => {
    const store = new InMemoryFactStore();
    const original = { cells: [{ x: 1, y: 64, z: 2 }], harvests: 1 };
    store.upsertPlace(place('p', { hostData: original }));
    store.upsertResource(resource('r', { hostData: { role: 'ore' } }));
    store.upsertContainer(container('c', { hostData: { block: 'furnace' } }));
    original.cells[0]!.x = 99;
    expect(store.places().items[0]?.hostData).toEqual({ cells: [{ x: 1, y: 64, z: 2 }], harvests: 1 });
    const update = { nested: { count: 2 } };
    for (const [kind, id] of [['place', 'p'], ['resource', 'r'], ['container', 'c']] as const) {
      const result = store.updateHostData(kind, id, update);
      expect(result.outcome).toBe('updated');
      expect(result.record.observedAt).toBe(100);
      expect(store.updateHostData(kind, id, { nested: { count: 2 } }).outcome).toBe('duplicate');
      expect(() => store.updateHostData(kind, id, { invalid: NaN })).toThrow();
    }
    update.nested.count = 3;
    const captured = store.captureSnapshot();
    expect(captured.places[0]?.hostData).toEqual({ nested: { count: 2 } });
    expect(captured.resources[0]?.hostData).toEqual({ nested: { count: 2 } });
    expect(captured.containers[0]?.hostData).toEqual({ nested: { count: 2 } });
    expect(store.upsertPlace(place('p', { hostData: { nested: { count: 4 } } })).outcome).toBe('conflict');
    captured.places[0]!.hostData!.changed = true;
    expect(store.places().items[0]?.hostData).toEqual({ nested: { count: 2 } });
  });
});

describe('InMemoryFactStore places', () => {
  it('keeps negative coordinates and pages with a stable exclusive cursor', () => {
    const store = new InMemoryFactStore();
    for (let count = 1; count <= 5; count += 1) {
      const id = `p-0${count}`;
      store.upsertPlace(
        place(id, {
          id,
          location: { kind: 'exact', pos: { x: -count, y: 64 - count, z: -20 - count } },
        }),
      );
    }

    const first = store.places({ worldId: WORLD, dim: DIM, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['p-01', 'p-02']);
    expect(first.total).toBe(5);
    expect(first.nextAfter).toBe('p-02');

    const second = store.places({ worldId: WORLD, dim: DIM, after: first.nextAfter, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual(['p-03', 'p-04']);
    expect(second.total).toBe(5);
    expect(second.nextAfter).toBe('p-04');

    const third = store.places({ worldId: WORLD, dim: DIM, after: second.nextAfter, limit: 2 });
    expect(third.items.map((item) => item.id)).toEqual(['p-05']);
    expect(third.nextAfter).toBeUndefined();
    expect(third.items[0]?.location).toEqual({
      kind: 'exact',
      pos: { x: -5, y: 59, z: -25 },
    });
  });

  it('keeps area locations and applies world/dim filters', () => {
    const store = new InMemoryFactStore();
    store.upsertPlace(
      place('area', {
        location: { kind: 'area', center: { x: -30, y: 70, z: -40 }, radius: 8 },
      }),
    );
    store.upsertPlace(place('other-world', { worldId: 'world-2' }));
    store.upsertPlace(place('other-dim', { dim: 'the_nether' }));

    const page = store.places({ worldId: WORLD, dim: DIM });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe('area');
    expect(page.items[0]?.location).toEqual({
      kind: 'area',
      center: { x: -30, y: 70, z: -40 },
      radius: 8,
    });
  });

  it('dedupes by place identity and never rewrites with an older observation', () => {
    const store = new InMemoryFactStore();
    expect(store.upsertPlace(place('home')).outcome).toBe('inserted');

    expect(store.upsertPlace(place('home')).outcome).toBe('duplicate');
    expect(store.places().total).toBe(1);

    expect(
      store.upsertPlace(place('home', { observedAt: 200, label: 'Home base' })).outcome,
    ).toBe('updated');
    expect(store.places().items[0]?.label).toBe('Home base');

    expect(
      store.upsertPlace(place('home', { observedAt: 150, label: 'stale name' })).outcome,
    ).toBe('duplicate');
    expect(store.places().items[0]?.label).toBe('Home base');

    expect(
      store.upsertPlace(
        place('home', {
          observedAt: 200,
          label: 'conflicting name',
          location: { kind: 'exact', pos: { x: 5, y: 70, z: 5 } },
        }),
      ).outcome,
    ).toBe('conflict');
    expect(store.places().items[0]?.label).toBe('Home base');
  });

  it('retains gone places and exposes them only with includeGone', () => {
    const store = new InMemoryFactStore();
    store.upsertPlace(place('old-base'));

    expect(
      store.markPlaceGone('old-base', { observedAt: 200, source: { source: 'vision_scan' } })
        .outcome,
    ).toBe('updated');
    expect(store.places().total).toBe(0);
    const withGone = store.places({ includeGone: true });
    expect(withGone.total).toBe(1);
    expect(withGone.items[0]?.gone).toBe(true);
    expect(withGone.items[0]?.goneAt).toBe(200);

    // An observation older than the disappearance does not resurrect the place.
    expect(store.upsertPlace(place('old-base', { observedAt: 150 })).outcome).toBe('duplicate');
    expect(store.places().total).toBe(0);

    // A newer observation does, and the record keeps its durable id.
    expect(
      store.upsertPlace(place('old-base', { observedAt: 300, label: 'rebuilt' })).outcome,
    ).toBe('updated');
    expect(store.places().total).toBe(1);
    expect(store.places().items[0]?.gone).toBe(false);

    // Gone evidence older than the current observation is a conflict, not a write.
    expect(
      store.markPlaceGone('old-base', { observedAt: 250, source: { source: 'vision_scan' } })
        .outcome,
    ).toBe('conflict');
    expect(() => store.markPlaceGone('missing', { observedAt: 1, source: SOURCE })).toThrow(
      /unknown place id/,
    );
  });

  it('bounds page size even when the caller asks for more', () => {
    const store = new InMemoryFactStore({ maxQueryLimit: 2 });
    store.upsertPlace(place('a'));
    store.upsertPlace(place('b'));
    store.upsertPlace(place('c'));

    const page = store.places({ limit: 10_000 });
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(page.total).toBe(3);
    expect(page.nextAfter).toBe('b');

    expect(() => store.places({ limit: 0 })).toThrow(/positive safe integer/);
    expect(() => store.places({ limit: 1.5 })).toThrow(/positive safe integer/);
  });
});

describe('InMemoryFactStore resources', () => {
  it('re-anchors by source cell without duplicating or rebuilding', () => {
    const store = new InMemoryFactStore();
    expect(store.upsertResource(resource('ore')).outcome).toBe('inserted');
    expect(
      store.resources({ sourceCell: { x: -3, y: 64, z: -7 } }).total,
    ).toBe(1);

    const moved = store.updateResourceSource('ore', {
      sourceCell: { x: 4, y: 65, z: 8 },
      observedAt: 200,
      source: { source: 'vision_scan' },
    });
    expect(moved.outcome).toBe('updated');
    expect(moved.record.id).toBe('ore');
    expect(moved.record.sourceCell).toEqual({ x: 4, y: 65, z: 8 });
    expect(store.resources({ sourceCell: { x: -3, y: 64, z: -7 } }).total).toBe(0);
    expect(store.resources({ sourceCell: { x: 4, y: 65, z: 8 } }).total).toBe(1);
    expect(store.resources().total).toBe(1);

    // Same durable id observed at another cell is a move, not a second fact.
    expect(
      store.upsertResource(
        resource('ore', {
          sourceCell: { x: -8, y: 30, z: -9 },
          observedAt: 300,
        }),
      ).outcome,
    ).toBe('updated');
    expect(store.resources().total).toBe(1);
    expect(store.resources().items[0]?.sourceCell).toEqual({ x: -8, y: 30, z: -9 });

    // An older observation never moves the anchor back.
    expect(
      store.updateResourceSource('ore', {
        sourceCell: { x: 0, y: 0, z: 0 },
        observedAt: 250,
        source: { source: 'vision_scan' },
      }).outcome,
    ).toBe('duplicate');
    expect(store.resources().items[0]?.sourceCell).toEqual({ x: -8, y: 30, z: -9 });
  });

  it('revokes by id and by source cell while retaining the record', () => {
    const store = new InMemoryFactStore();
    store.upsertResource(resource('ore'));

    expect(
      store.revokeResource('ore', { observedAt: 300, source: { source: 'vision_scan' } })
        .outcome,
    ).toBe('updated');
    expect(store.resources().total).toBe(0);
    const revoked = store.resources({ includeGone: true });
    expect(revoked.total).toBe(1);
    expect(revoked.items[0]?.revoked).toBe(true);
    expect(revoked.items[0]?.revokedAt).toBe(300);
    expect(
      store.revokeResource('ore', { observedAt: 400, source: { source: 'vision_scan' } })
        .outcome,
    ).toBe('updated');

    // A revoked anchor is not moved until it is re-observed through upsert.
    expect(
      store.updateResourceSource('ore', {
        sourceCell: { x: 1, y: 2, z: 3 },
        observedAt: 500,
        source: { source: 'vision_scan' },
      }).outcome,
    ).toBe('duplicate');

    store.upsertResource(resource('gold', { label: 'gold_ore', sourceCell: { x: -2, y: 20, z: -2 } }));
    expect(
      store.revokeResourceAt(
        {
          worldId: WORLD,
          dim: DIM,
          sourceCell: { x: -2, y: 20, z: -2 },
          label: 'gold_ore',
        },
        { observedAt: 300, source: { source: 'vision_scan' } },
      ).outcome,
    ).toBe('updated');
    expect(store.resources({ includeGone: true }).total).toBe(2);
  });

  it('conflicts when another id already owns the source cell + label', () => {
    const store = new InMemoryFactStore();
    store.upsertResource(resource('ore'));

    const conflict = store.upsertResource(resource('ore-2'));
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.record.id).toBe('ore');
    expect(store.resources({ includeGone: true }).total).toBe(1);
  });
});

describe('InMemoryFactStore containers', () => {
  it('dedupes by stable identity, never by position alone', () => {
    const store = new InMemoryFactStore();
    expect(store.upsertContainer(container('c1')).outcome).toBe('inserted');

    // Re-observing the shell updates the record but not its identity.
    expect(store.upsertContainer(container('c1', { observedAt: 200 })).outcome).toBe('updated');
    expect(store.containers().total).toBe(1);
    expect(store.containers().items[0]?.observedAt).toBe(200);

    // Same identity under a different durable id is a conflict, not a second chest.
    expect(
      store.upsertContainer(container('c2', { observedAt: 300 })).outcome,
    ).toBe('conflict');
    expect(store.containers().total).toBe(1);
    expect(store.containers().items[0]?.id).toBe('c1');

    // The same id cannot be re-labelled as a different container.
    expect(
      store.upsertContainer(
        container('c1', {
          externalRef: 'chest:base:2',
          pos: { x: 50, y: 60, z: 70 },
          observedAt: 300,
        }),
      ).outcome,
    ).toBe('conflict');
    expect(store.containers({ worldId: WORLD, dim: DIM }).total).toBe(1);
  });

  it('stores exact negative positions and an optional ledger reference', () => {
    const store = new InMemoryFactStore();
    store.upsertContainer(
      container('c1', { ledgerRef: 'ledger:7', pos: { x: -101, y: 12, z: -203 } }),
    );
    const page = store.containers({ worldId: WORLD, dim: DIM });
    expect(page.items[0]?.pos).toEqual({ x: -101, y: 12, z: -203 });
    expect(page.items[0]?.ledgerRef).toBe('ledger:7');
  });

  it('marks a container gone while retaining its identity and history', () => {
    const store = new InMemoryFactStore();
    store.upsertContainer(container('c1', { ledgerRef: 'ledger:7' }));

    expect(
      store.markContainerGone('c1', {
        observedAt: 200,
        source: { source: 'vision_scan', sessionId: 's2' },
      }).outcome,
    ).toBe('updated');
    expect(store.containers().total).toBe(0);
    const withGone = store.containers({ includeGone: true });
    expect(withGone.total).toBe(1);
    expect(withGone.items[0]).toMatchObject({
      id: 'c1',
      externalRef: 'chest:base:1',
      ledgerRef: 'ledger:7',
      observedAt: 100,
      gone: true,
      goneAt: 200,
      goneSource: { source: 'vision_scan', sessionId: 's2' },
    });

    expect(
      store.markContainerGone('c1', { observedAt: 300, source: SOURCE }).outcome,
    ).toBe('updated');
    // Gone evidence older than the observed shell is a conflict, not a write.
    store.upsertContainer(container('c2', {
      externalRef: 'chest:base:2',
      observedAt: 500,
      gone: false,
    }));
    expect(
      store.markContainerGone('c2', { observedAt: 400, source: SOURCE }).outcome,
    ).toBe('conflict');
    expect(() => store.markContainerGone('missing', { observedAt: 1, source: SOURCE })).toThrow(
      /unknown container id/,
    );

    // A newer shell observation resurrects the anchor under the same id.
    expect(
      store.upsertContainer(container('c1', { observedAt: 600, gone: false })).outcome,
    ).toBe('updated');
    // c1 is present again; c2 (observed at 500) remains a visible anchor.
    expect(store.containers().total).toBe(2);
    expect(store.containers().items.find((item) => item.id === 'c1')?.gone).toBe(false);
  });
});
