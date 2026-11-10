import { describe, expect, it } from 'vitest';

import {
  InMemoryFactStore,
  applyLegacySemanticMigration,
  runLegacySemanticMigrationDryRun,
} from '../src/index.js';
import type { LegacySemanticSnapshot, SemanticFact } from '../src/index.js';

const WORLD = 'world-1';
const DIM = 'overworld';

function snapshot(): LegacySemanticSnapshot {
  return {
    worldId: WORLD,
    nodes: [
      {
        id: 'lm_base',
        kind: 'place',
        tag: 'base',
        label: 'Home',
        dim: DIM,
        location: { kind: 'exact', pos: { x: -120.5, y: 64, z: -33.25 } },
        observedAt: 1_700_001_100_000,
        source: 'agent',
      },
      {
        id: 'lm_iron',
        kind: 'place',
        tag: 'resource',
        label: 'iron_ore',
        resourceType: 'ore',
        dim: DIM,
        location: { kind: 'exact', pos: { x: -15, y: 20, z: -30 } },
        observedAt: 1_700_001_300_000,
        source: 'agent',
      },
      {
        id: 'chest_node',
        kind: 'place',
        tag: 'container',
        dim: DIM,
        location: { kind: 'exact', pos: { x: -12, y: 64, z: -30 } },
        externalRef: 'chest:base:1',
        ledgerRef: 'ledger:7',
        observedAt: 1_700_002_100_000,
        source: 'agent',
      },
      {
        id: 'lm_death',
        kind: 'place',
        tag: 'death',
        label: 'Death by lava',
        dim: DIM,
        location: { kind: 'exact', pos: { x: 7, y: 11, z: -9 } },
        observedAt: 1_700_003_000_000,
        gone: true,
        goneAt: 1_700_003_100_000,
        source: 'agent',
        legacyId: 'legacy-death',
      },
      { id: 'route_entry', kind: 'entrance' },
      { id: 'route_branch', kind: 'branch' },
      {
        id: 'missing_location',
        kind: 'place',
        label: 'no location',
        dim: DIM,
        observedAt: 1,
      },
      {
        id: 'region_resource',
        kind: 'place',
        tag: 'resource',
        label: 'gold_ore',
        dim: DIM,
        location: { kind: 'region', center: { x: 1, y: 2, z: 3 }, radius: 5 },
        observedAt: 1,
      },
      {
        id: 'gone_container',
        kind: 'place',
        tag: 'container',
        dim: DIM,
        location: { kind: 'exact', pos: { x: 1, y: 2, z: 3 } },
        externalRef: 'chest:gone',
        observedAt: 1,
        gone: true,
      },
      {
        kind: 'place',
        label: 'missing id',
        dim: DIM,
        location: { kind: 'exact', pos: { x: 1, y: 2, z: 3 } },
        observedAt: 1,
      },
    ],
    edges: [{ id: 'edge-1' }, { id: 'edge-2' }],
    fragments: [{ id: 'fragment-1' }],
  };
}

describe('legacy semantic-node migration dry run', () => {
  it('migrates semantic nodes only and reports skipped/unknown counts', () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    const plan = runLegacySemanticMigrationDryRun(input);

    expect(plan.report.migrated).toBe(4);
    expect(plan.report.skippedRoute).toBe(5); // 2 route nodes + 2 edges + 1 fragment
    expect(plan.report.duplicates).toBe(0);
    expect(plan.report.conflicts).toBe(0);
    expect(plan.report.gone).toBe(1);
    expect(plan.report.unknown).toBe(4);
    expect(plan.facts.map((fact) => fact.id).sort()).toEqual([
      'chest_node',
      'lm_base',
      'lm_death',
      'lm_iron',
    ]);

    const place = plan.facts.find((fact) => fact.id === 'lm_base');
    expect(place && 'location' in place ? place.location : undefined).toEqual({
      kind: 'exact',
      pos: { x: -120.5, y: 64, z: -33.25 },
    });
    if (place === undefined || !('kind' in place)) throw new Error('expected base place');
    expect(place.kind).toBe('base');
    expect(place.legacyId).toBe('lm_base');

    const resource = plan.facts.find((fact) => fact.id === 'lm_iron');
    if (resource === undefined || !('sourceCell' in resource)) {
      throw new Error('expected resource anchor');
    }
    expect(resource.sourceCell).toEqual({ x: -15, y: 20, z: -30 });
    expect(resource.resourceType).toBe('ore');
    expect(resource.legacyId).toBe('lm_iron');

    const container = plan.facts.find((fact) => fact.id === 'chest_node');
    if (container === undefined || !('externalRef' in container)) {
      throw new Error('expected container anchor');
    }
    expect(container.externalRef).toBe('chest:base:1');
    expect(container.ledgerRef).toBe('ledger:7');
    expect('contents' in container).toBe(false);

    const gone = plan.facts.find((fact) => fact.id === 'lm_death');
    if (gone === undefined || !('kind' in gone)) throw new Error('expected death place');
    expect(gone.gone).toBe(true);
    expect(gone.goneAt).toBe(1_700_003_100_000);
    expect(gone.legacyId).toBe('legacy-death');

    expect(plan.report.unknownIds).toEqual([
      'missing_location',
      'region_resource',
      'gone_container',
      'node#9',
    ]);
    expect(plan.report.skippedRouteIds).toEqual([
      'route_entry',
      'route_branch',
      'edge-1',
      'edge-2',
      'fragment-1',
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('re-running against the previous plan reports duplicates, not new facts', () => {
    const plan = runLegacySemanticMigrationDryRun(snapshot());
    const rerun = runLegacySemanticMigrationDryRun(snapshot(), { existing: plan.facts });

    expect(rerun.report.migrated).toBe(0);
    expect(rerun.report.duplicates).toBe(4);
    expect(rerun.report.conflicts).toBe(0);
    expect(rerun.report.gone).toBe(1);
    expect(rerun.facts).toHaveLength(4);
  });

  it('applying the same plan twice is idempotent', () => {
    const plan = runLegacySemanticMigrationDryRun(snapshot());
    const store = new InMemoryFactStore();

    expect(applyLegacySemanticMigration(store, plan)).toEqual({
      inserted: 4,
      updated: 0,
      duplicate: 0,
      conflict: 0,
    });
    expect(applyLegacySemanticMigration(store, plan)).toEqual({
      inserted: 0,
      updated: 0,
      duplicate: 4,
      conflict: 0,
    });

    expect(store.places().total).toBe(1);
    expect(store.places({ includeGone: true }).total).toBe(2);
    expect(store.resources().total).toBe(1);
    expect(store.containers().total).toBe(1);
  });

  it('reports canonical duplicates and conflicts deterministically', () => {
    const snapshotWithDuplicates: LegacySemanticSnapshot = {
      worldId: WORLD,
      nodes: [
        {
          id: 'ore',
          kind: 'place',
          tag: 'resource',
          label: 'iron_ore',
          dim: DIM,
          location: { kind: 'exact', pos: { x: 1, y: 2, z: 3 } },
          observedAt: 100,
        },
        {
          id: 'ore',
          kind: 'place',
          tag: 'resource',
          label: 'iron_ore',
          dim: DIM,
          location: { kind: 'exact', pos: { x: 1, y: 2, z: 3 } },
          observedAt: 100,
        },
        {
          id: 'ore-alias',
          kind: 'place',
          tag: 'resource',
          label: 'iron_ore',
          dim: DIM,
          location: { kind: 'exact', pos: { x: 1, y: 2, z: 3 } },
          observedAt: 100,
        },
        {
          id: 'home',
          kind: 'place',
          tag: 'base',
          label: 'old',
          dim: DIM,
          location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
          observedAt: 100,
        },
        {
          id: 'home',
          kind: 'place',
          tag: 'base',
          label: 'new',
          dim: DIM,
          location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
          observedAt: 200,
        },
      ],
    };

    const plan = runLegacySemanticMigrationDryRun(snapshotWithDuplicates);
    expect(plan.report.migrated).toBe(2);
    expect(plan.report.duplicates).toBe(2); // exact ore repeat + newer home observation
    expect(plan.report.conflicts).toBe(1); // same cell+label under another id
    expect(plan.report.duplicateIds).toEqual(['ore', 'home']);
    expect(plan.report.conflictIds).toEqual(['ore-alias']);
    const home = plan.facts.find((fact) => fact.id === 'home');
    if (home === undefined || !('kind' in home)) throw new Error('expected home place');
    expect(home.label).toBe('new');
    expect(plan.facts).toHaveLength(2);
  });

  it('reports a same-time incompatible existing fact as a conflict', () => {
    const existing: SemanticFact[] = [
      {
        id: 'home',
        kind: 'base',
        label: 'different name',
        worldId: WORLD,
        dim: DIM,
        location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
        observedAt: 100,
        source: { source: 'vision_scan' },
        gone: false,
        legacyId: 'home',
      },
    ];
    const plan = runLegacySemanticMigrationDryRun(
      {
        worldId: WORLD,
        nodes: [
          {
            id: 'home',
            kind: 'place',
            tag: 'base',
            label: 'Home',
            dim: DIM,
            location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
            observedAt: 100,
          },
        ],
      },
      { existing },
    );
    expect(plan.report.migrated).toBe(0);
    expect(plan.report.duplicates).toBe(0);
    expect(plan.report.conflicts).toBe(1);
    expect(plan.report.conflictIds).toEqual(['home']);
  });
});
