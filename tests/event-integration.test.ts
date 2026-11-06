import { describe, expect, it } from 'vitest';

import type {
  ChangeReport,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Vec3Like,
  WalkRouteRequest,
} from '../src/index.js';
import { SpatialMemoryStoreImpl, VoxelMap, WalkRouteExecutor } from '../src/index.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

const WORLD = 'world';
const DIM = 'overworld';
const SCOPE = { worldId: WORLD, dim: DIM, sessionId: 's1' };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake single-step executor whose moves stay in flight until stopped. */
class InFlightExecutor implements MoveExecutor {
  readonly stopped: string[] = [];

  move(_request: ExecutableMove): Promise<ExecutableMoveResult> {
    return new Promise<ExecutableMoveResult>(() => {});
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

function openRoute(map: VoxelMap, nPoints: number): Vec3Like[] {
  for (let k = 0; k < nPoints; k++) {
    map.observe(obs(STONE, { x: k, y: -1, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 1, z: 0 }));
  }
  return Array.from({ length: nPoints }, (_, k) => ({ x: k + 0.5, y: 0, z: 0.5 }));
}

function requestFor(points: Vec3Like[]): WalkRouteRequest {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    points,
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    deadlineMs: 100_000,
    timeoutMs: 1000,
  };
}

describe('change-report forwarding', () => {
  it('delivers accepted reports synchronously and stops after unsubscribe', () => {
    const map = new VoxelMap(WORLD, { now: () => 2000 });
    const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map });
    const seen: ChangeReport[] = [];
    const unsubscribe = store.subscribeChanges((report) => seen.push(report));

    const report = store.observeBatch({
      observations: [obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 2000 })],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(report);
    expect(seen[0]?.sections).toHaveLength(1);

    // A duplicate same-state observation at the same time changes nothing and
    // therefore is not delivered.
    store.observeBatch({
      observations: [obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 2000 })],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);

    unsubscribe();
    unsubscribe();
    store.observeBatch({
      observations: [obs(AIR, { x: 1, y: 0, z: 0 }, { observedAt: 2001, sequence: 2 })],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);

    expect(() => store.subscribeChanges(null as unknown as (report: ChangeReport) => void)).toThrow(
      /must be a function/,
    );
  });

  it('delivers beginSession and markStale reports but not empty reports', () => {
    const map = new VoxelMap(WORLD, { now: () => 5000 });
    const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map });
    const seen: ChangeReport[] = [];
    store.subscribeChanges((report) => seen.push(report));

    // First session starts from no prior evidence: empty, not delivered.
    expect(store.beginSession('s1').sections).toEqual([]);
    expect(seen).toHaveLength(0);

    store.observeBatch({
      observations: [
        obs(STONE, { x: 0, y: 0, z: 0 }, { sessionId: 's1', observedAt: 2000 }),
      ],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);

    const switched = store.beginSession('s2');
    expect(switched.sections[0]?.cells[0]?.kind).toBe('staled');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(switched);

    const staled = store.markStale(DIM, 'observation_gap');
    expect(seen).toHaveLength(2); // already STALE: nothing changes

    const newSession = store.observeBatch({
      observations: [
        obs(AIR, { x: 0, y: 0, z: 0 }, { sessionId: 's2', observedAt: 6000, sequence: 1 }),
      ],
      unobserved: [],
    });
    expect(seen).toHaveLength(3);
    expect(seen[2]).toBe(newSession);

    const emptyStale = store.markStale('the_nether', 'unloaded');
    expect(emptyStale.sections).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(staled.sections).toHaveLength(0);
  });

  it('does not deliver rejected (older) or old-session writes', () => {
    const map = new VoxelMap(WORLD, { now: () => 5000 });
    const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map });
    const seen: ChangeReport[] = [];
    store.subscribeChanges((report) => seen.push(report));

    store.observeBatch({
      observations: [obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 3000 })],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);

    // Genuinely older acquisition is rejected: no report, newer evidence wins.
    store.observeBatch({
      observations: [obs(AIR, { x: 0, y: 0, z: 0 }, { observedAt: 2000, sequence: 2 })],
      unobserved: [],
    });
    expect(seen).toHaveLength(1);
    const cell = map.cellAt(DIM, 0, 0, 0);
    expect(cell.observed).toBe(true);
    if (!cell.observed) throw new Error('expected observed evidence');
    expect(cell.evidence.observation.state.name).toBe('minecraft:stone');
    expect(cell.evidence.observation.observedAt).toBe(3000);

    store.beginSession('s2');
    seen.length = 0;
    // A late old-session write is rejected: no report.
    const late = store.observeBatch({
      observations: [
        obs(AIR, { x: 0, y: 0, z: 0 }, { sessionId: 's1', observedAt: 9000, sequence: 99 }),
      ],
      unobserved: [],
    });
    expect(late.sections).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('stops an in-flight segment when its section is invalidated through the subscription', async () => {
    const map = new VoxelMap(WORLD, { now: () => 2000 });
    const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map });
    const mover = new InFlightExecutor();
    const loop = new WalkRouteExecutor(map, mover, { now: () => 2000 });

    const points = openRoute(map, 3);
    const start = loop.start(requestFor(points));
    loop.onSample({
      ...SCOPE,
      executionId: start.delegationId,
      sequence: 1,
      pos: { ...points[0]! },
      observedAt: 2100,
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
    });
    // Wire the forwarding only while the delegation is active.
    store.subscribeChanges((report) => loop.observe(report, 10));
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0);

    store.observeBatch({
      observations: [obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 2200, sequence: 2 })],
      unobserved: [],
    });

    const status = loop.status()!;
    expect(status.result?.problem?.kind).toBe('route_invalidated');
    expect(status.activeStepIndex).toBeNull();
    expect(mover.stopped).toContain('walk-1-step-0');
    await tick();
  });

  it('does not interrupt an in-flight segment for an unrelated section', () => {
    const map = new VoxelMap(WORLD, { now: () => 2000 });
    const store = new SpatialMemoryStoreImpl({ worldId: WORLD, map });
    const mover = new InFlightExecutor();
    const loop = new WalkRouteExecutor(map, mover, { now: () => 2000 });

    const points = openRoute(map, 3);
    const start = loop.start(requestFor(points));
    loop.onSample({
      ...SCOPE,
      executionId: start.delegationId,
      sequence: 1,
      pos: { ...points[0]! },
      observedAt: 2100,
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
    });
    store.subscribeChanges((report) => loop.observe(report, 10));
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0);

    store.observeBatch({
      observations: [obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 2200, sequence: 2 })],
      unobserved: [],
    });

    expect(loop.status()!.result).toBeNull();
    expect(loop.status()!.activeStepIndex).toBe(0);
    expect(mover.stopped).toEqual([]);
  });
});
