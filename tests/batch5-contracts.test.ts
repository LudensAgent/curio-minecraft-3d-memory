import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CapabilityContractError,
  CapabilityUnavailableError,
  composeCapabilities,
  hasCapability,
  requireCapability,
} from '../dist/index.js';
import type {
  MemoryHostCapabilities,
  Observation,
  SectionKey,
} from '../dist/index.js';
import {
  openSpatialSession,
  WorkingSetManager,
} from '../dist/storage/sqlite/index.js';
import { ObservationQueue } from '../dist/observation/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'batch5-'));
  tempDirs.push(dir);
  return join(dir, 'spatial.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function keyAt(cx: number, sy = 4): SectionKey {
  return { worldId: WORLD, dim: DIM, cx, cz: 0, sy };
}

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: stone,
    pos: { x: 0, y: 64, z: 0 },
    ...overrides,
  };
}

async function seedOne(dbPath: string): Promise<void> {
  const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  session.voxel.beginSession('s1');
  session.voxel.observe(obs({ pos: { x: 0, y: 64, z: 0 } }));
  await session.checkpoint();
  await session.close();
}

describe('WorkingSetManager — separated state and observable rejection', () => {
  it('reports observed, resident, persisted and pending counts separately', async () => {
    const dbPath = makeDbPath();
    await seedOne(dbPath);
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      voxelLoading: 'manual',
    });
    try {
      const manager = new WorkingSetManager(session);

      const before = manager.stats();
      expect(before.observedSections).toBe(1);
      expect(before.observedCells).toBe(1);
      expect(before.residentSections).toBe(0);
      expect(before.notResidentSections).toBe(1);
      expect(before.pendingSections).toBe(0);
      expect(before.persistedSections).toBe(1);

      const prepared = await manager.prepare([keyAt(0)]);
      expect(prepared.status).toBe('ready');

      const after = manager.stats();
      expect(after.residentSections).toBe(1);
      expect(after.notResidentSections).toBe(0);
      // Resolution into memory must not be reported as a new observation or as
      // a new save; the section was already persisted.
      expect(after.observedSections).toBe(1);
      expect(after.pendingSections).toBe(0);
      expect(after.persistedSections).toBe(1);
      session.releasePins([prepared.lease.token]);
    } finally {
      await session.close();
    }
  });

  it('records busy and no_record refusals with their request keys', async () => {
    const dbPath = makeDbPath();
    await seedOne(dbPath);
    const session = await openSpatialSession({
      databasePath: dbPath,
      worldId: WORLD,
      voxelLoading: 'manual',
    });
    try {
      const manager = new WorkingSetManager(session);
      session.acquireWorkingSetOperation();
      try {
        await expect(manager.prepare([keyAt(0)])).rejects.toMatchObject({ kind: 'busy' });
      } finally {
        session.releaseWorkingSetOperation();
      }

      const afterBusy = manager.stats();
      expect(afterBusy.rejections.busy).toBe(1);
      const busy = manager.recentRejections(1)[0]!;
      expect(busy).toMatchObject({ operation: 'prepare', kind: 'busy' });
      expect(busy.keys).toEqual([keyAt(0)]);

      const missing = await manager.prepare([keyAt(99)]);
      expect(missing.status).toBe('incomplete');
      expect(missing.noRecord).toEqual([keyAt(99)]);
      expect(manager.stats().rejections.no_record).toBe(1);
      expect(manager.recentRejections(1)[0]).toMatchObject({
        operation: 'prepare',
        kind: 'no_record',
        keys: [keyAt(99)],
      });
    } finally {
      await session.close();
    }
  });
});

describe('ObservationQueue — queue_full keeps stable refused identities', () => {
  it('reports the refused cells instead of only a count', () => {
    const queue = new ObservationQueue({ maxItems: 1 });
    const result = queue.enqueue({
      observations: [
        obs({ pos: { x: 0, y: 64, z: 0 }, sequence: 1 }),
        obs({ pos: { x: 1, y: 64, z: 0 }, sequence: 2 }),
      ],
      unobserved: [{ pos: { x: 2, y: 64, z: 0 }, reason: 'occluded' }],
    });

    expect(result.accepted).toBe(false);
    expect(result.overflow).toMatchObject({ observations: 2, gaps: 1, reason: 'max_items' });
    expect(result.overflow!.rejectedObservations).toEqual([
      'world/overworld/0,64,0@1000#1',
      'world/overworld/1,64,0@1000#2',
    ]);
    expect(result.overflow!.rejectedGaps).toEqual(['2,64,0:occluded']);
    expect(result.overflow!.truncated).toBe(false);
    // Nothing was silently queued.
    expect(queue.backlog()).toEqual({ observations: 0, gaps: 0, bytes: 0 });
  });

  it('bounds identifier retention but keeps exact counts', () => {
    const queue = new ObservationQueue({ maxItems: 1, maxRejectedIds: 1 });
    const result = queue.enqueue({
      observations: [
        obs({ pos: { x: 0, y: 64, z: 0 }, sequence: 1 }),
        obs({ pos: { x: 1, y: 64, z: 0 }, sequence: 2 }),
      ],
      unobserved: [],
    });
    expect(result.overflow!.observations).toBe(2);
    expect(result.overflow!.rejectedObservations).toHaveLength(1);
    expect(result.overflow!.truncated).toBe(true);
  });
});

describe('Capability composition — library and host are separate facts', () => {
  function libraryReport(): MemoryHostCapabilities {
    return {
      contract: 'memory-host-contract/2',
      memory: {
        observeBatch: true,
        beginSession: true,
        markStale: true,
        markTraversed: true,
        markModified: true,
        checkpoint: false,
        flush: false,
        close: false,
      },
      query: {
        cells: true,
        nodes: true,
        places: true,
        resourceAnchors: true,
        containerAnchors: true,
        containerContents: false,
        snapshot: true,
        capabilities: true,
      },
      persistence: {
        sqlite: false,
        manualResidency: false,
        workingSet: false,
        migrationAuthoritySwitch: false,
      },
    };
  }

  it('takes the intersection and reports overclaims without widening the library', () => {
    const library = libraryReport();
    const composed = composeCapabilities(library, {
      query: { places: false },
      persistence: { sqlite: true },
      // A retired key is not part of the library report and is an overclaim.
      memory: { saveFragment: true } as never,
    });

    expect(composed.owner).toBe('host_composed');
    expect(composed.effective.query.places).toBe(false);
    expect(composed.effective.query.nodes).toBe(true);
    expect(composed.effective.persistence.sqlite).toBe(false);
    expect(composed.library).toEqual(library);
    expect(composed.overclaims.map((entry) => `${entry.domain}.${entry.name}`).sort()).toEqual([
      'memory.saveFragment',
      'persistence.sqlite',
    ]);
  });

  it('rejects a contract mismatch', () => {
    expect(() => composeCapabilities(libraryReport(), { contract: 'other' as never })).toThrow(
      CapabilityContractError,
    );
  });

  it('requireCapability throws a structured unsupported error for false bits', () => {
    const composed = composeCapabilities(libraryReport(), { query: { places: false } });
    expect(hasCapability(composed, 'query', 'nodes')).toBe(true);
    expect(hasCapability(composed, 'query', 'places')).toBe(false);

    try {
      requireCapability(composed, 'query', 'places');
      throw new Error('expected requireCapability to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityUnavailableError);
      expect(error).toMatchObject({
        code: 'unsupported',
        domain: 'query',
        capability: 'places',
      });
    }
    expect(() => requireCapability(composed, 'persistence', 'sqlite')).toThrow(
      CapabilityUnavailableError,
    );
  });
});
