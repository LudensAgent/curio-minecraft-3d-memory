import { describe, expect, it } from 'vitest';

import type { BodySample, ExecutableMove, ExecutableMoveResult } from '../src/execution/types.js';
import { planRoute } from '../src/index.js';
import { RoutePlanRegistryImpl } from '../src/navigation/route-plan-registry.js';
import type { RoutePlanDraft } from '../src/navigation/route-plan-types.js';
import type { ActionRecord } from '../src/navigation/types.js';
import { createWalkPath, createWalkPathExecution } from '../src/navigation/walk-path.js';
import type { WalkPathEnvironment, WalkPathResult } from '../src/navigation/walk-path-types.js';
import type { Vec3Like } from '../src/types.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { AIR, STONE, bodyAt, fakeProvider, obs } from './fakes.js';
import {
  makePlanEnvironment,
  makePlanParts,
  NOW,
  openFloorMap,
  planRequest,
  searchSource,
  straightCorridor,
  TestClock,
  wallOffSingleCell,
} from './route-plan-fixtures.js';

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const DEADLINE = NOW + 20_000;
const WAIT_STEP_MS = 40;

/** Flush the hook's post-result microtask chain. */
const settleHook = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** A caller-owned record; the library must hand it through verbatim. */
function actionRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: 'act_1',
    ts: NOW,
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    delegationId: 'del_1',
    delegation: {
      requestedTarget: { x: 2.5, y: 0, z: 0.5 },
      target: { x: 2.5, y: 0, z: 0.5 },
      allowedModes: ['walk'],
      arrival: { kind: 'exact' },
      allowDigging: false,
      allowPlacing: false,
      allowTower: false,
      materials: [],
      exploration: 'known_only',
    },
    subActions: [{ kind: 'walk', origin: 'execution_helper', outcome: 'ok' }],
    from: { x: 0.5, y: 0, z: 0.5 },
    to: { x: 2.5, y: 0, z: 0.5 },
    trace: [],
    consumption: { placed: [] },
    observedChanges: [],
    confirmed: true,
    ...overrides,
  };
}

/** Observe open air over a stone floor around every route point. */
function observeWorld(
  map: VoxelMap,
  points: readonly Vec3Like[],
  skip?: (pos: { x: number; y: number; z: number }) => boolean,
): void {
  const maxX = Math.max(...points.map((p) => Math.floor(p.x)));
  for (let x = -1; x <= maxX + 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 2; y++) {
        if (skip?.({ x, y, z }) === true) continue;
        map.observe(obs(y === -1 ? STONE : AIR, { x, y, z }, { observedAt: 1000 }));
      }
    }
  }
}

function draftWith(points: Vec3Like[]): RoutePlanDraft {
  const last = points[points.length - 1]!;
  return {
    backend: 'spatial_library',
    source: 'search',
    points: points.map((p) => ({ ...p })),
    segments: [{ index: 0, mode: 'walk', points: points.map((p) => ({ ...p })), cost: points.length - 1 }],
    cost: points.length - 1,
    confidence: 'verified',
    executable: true,
    boundaries: [],
    evidence: { ...SCOPE, validUntil: NOW + 100_000, ruleVersion: 'fake-1' },
    expiresAt: NOW + 100_000,
    requestedTarget: { ...last },
    resolvedTarget: { ...last },
    start: { ...points[0]! },
  };
}

interface ExecutionOptions {
  points: Vec3Like[];
  /** Runs after each wait; used to abort the signal mid-execution. */
  afterWait?: (waitCount: number) => void;
  persistAction?: WalkPathEnvironment['persistAction'];
  onPersistenceFailure?: WalkPathEnvironment['onPersistenceFailure'];
  actionRecord?: ActionRecord | null;
  /** Replace the measured start sample; `null` makes the sample unavailable. */
  startSample?: (sample: BodySample) => BodySample | null;
  /** Make the move at this 1-based index resolve instead of staying pending. */
  resolveMoveAt?: (moveIndex: number) => boolean;
  /** Leave these cells unobserved, so the executor meets UNKNOWN evidence. */
  skipObserve?: (pos: { x: number; y: number; z: number }) => boolean;
}

/**
 * Real library executor over the whole walkPath entry, with a counting body
 * port. Moves stay pending so progress comes from measured samples only.
 */
function runExecution(options: ExecutionOptions) {
  const points = options.points;
  let clock = NOW;
  let sequence = 0;
  let position: Vec3Like = { ...points[0]! };
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];
  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draftWith(points));
  const executionId = `exec_${plan.routeId}`;
  const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => clock });
  observeWorld(map, points, options.skipObserve);

  const measure = (): BodySample => {
    sequence += 1;
    return {
      ...SCOPE,
      pos: { ...position },
      observedAt: clock,
      velocity: { x: 0, y: -0.0784, z: 0 },
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
      executionId,
      sequence,
    };
  };

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => {
      const sample = measure();
      return options.startSample === undefined ? sample : options.startSample(sample);
    },
    bodyPort: {
      move: (request) => {
        moves.push(request);
        position = { ...request.to };
        if (options.resolveMoveAt?.(moves.length) === true) {
          // Resolve without a measured sample: the move promise resolving is
          // not arrival evidence, so the entry reports a progress failure.
          return Promise.resolve<ExecutableMoveResult>({});
        }
        return new Promise<ExecutableMoveResult>(() => {});
      },
      stop: (id) => {
        stops.push(id);
      },
    },
    now: () => clock,
    ...(options.persistAction === undefined ? {} : { persistAction: options.persistAction }),
    ...(options.actionRecord === undefined ? {} : { actionRecord: options.actionRecord }),
    ...(options.onPersistenceFailure === undefined
      ? {}
      : { onPersistenceFailure: options.onPersistenceFailure }),
  };

  const execute = createWalkPathExecution({
    map,
    wait: async () => {
      clock += WAIT_STEP_MS;
      options.afterWait?.(Math.round((clock - NOW) / WAIT_STEP_MS));
    },
  });
  const walkPath = createWalkPath(registry, { execute });

  const walk = async (
    request: { deadlineMs: number; signal?: AbortSignal },
  ): Promise<{ result: WalkPathResult; moves: Vec3Like[]; stops: string[] }> => {
    const result = await walkPath({ routeId: plan.routeId, ...request }, environment);
    // Snapshot the counting port so a hook rejection cannot be observed through it.
    return { result, moves: moves.map((move) => move.to), stops: [...stops] };
  };
  return walk;
}

const stripWalkIdentity = (result: WalkPathResult): WalkPathResult => ({
  ...result,
  routeId: '@',
  executionId: '@',
});

/** A registry-backed entry whose executor synthesizes one chosen terminal state. */
function injectedEntry(outcome: WalkPathResult['outcome']) {
  const clock = NOW;
  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const plan = registry.register(draftWith(points));
  const executionId = `exec_${plan.routeId}`;
  const walkPath = createWalkPath(registry, {
    execute: async () => ({
      outcome,
      contract: 'memory-host-contract/1',
      routeId: plan.routeId,
      executionId,
      lastPosition: { ...points[0]! },
      lastObservation: { ...SCOPE, observedAt: NOW, onGround: true, inWater: false },
      confirmedSegments: outcome === 'PARTIAL' ? 1 : 0,
      remainingPoints: [points[1]!],
      consumption: { placed: [] },
      confirmed: false,
      trace: [],
    }),
  });
  return { plan, walkPath };
}

function countingEnvironment(
  overrides: Partial<WalkPathEnvironment>,
  plan: { start: Vec3Like; routeId: string },
): { environment: WalkPathEnvironment; bodyCalls: { move: number; stop: number } } {
  const bodyCalls = { move: 0, stop: 0 };
  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(plan.start.x, plan.start.y, plan.start.z),
    shapeProvider: fakeProvider,
    sample: () => ({
      ...SCOPE,
      pos: { ...plan.start },
      observedAt: NOW,
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
      executionId: `exec_${plan.routeId}`,
      sequence: 1,
    }),
    bodyPort: {
      move: async () => {
        bodyCalls.move += 1;
        return { failure: { kind: 'cancelled' } };
      },
      stop: () => {
        bodyCalls.stop += 1;
      },
    },
    now: () => NOW,
    ...overrides,
  };
  return { environment, bodyCalls };
}

describe('planRoute ActionRecord persistence hook (M6.2)', () => {
  it('hands the caller record through verbatim after a successful plan and leaves the result unchanged', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const baseline = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock) }),
    );

    const record = actionRecord();
    const seen: (ActionRecord | null)[] = [];
    const hooked = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
      }),
    );
    await settleHook();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(record);
    const strip = (r: typeof hooked) => ({ ...r, plan: r.plan === undefined ? undefined : { ...r.plan, routeId: '@' } });
    expect(strip(hooked)).toEqual(strip(baseline));
    expect(hooked.plan?.executable).toBe(true);
  });

  it('persists nothing when no hook is supplied, even when the caller passes a record', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const baseline = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock) }),
    );
    const withRecordOnly = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock), actionRecord: actionRecord() }),
    );
    const strip = (r: typeof baseline) => ({ ...r, plan: r.plan === undefined ? undefined : { ...r.plan, routeId: '@' } });
    expect(strip(withRecordOnly)).toEqual(strip(baseline));
  });

  it('calls the hook with an explicit null when the caller supplied no record', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const seen: (ActionRecord | null)[] = [];
    await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        persistAction: (candidate) => {
          seen.push(candidate);
        },
      }),
    );
    await settleHook();
    expect(seen).toEqual([null]);
  });

  it('calls the hook after a planning failure without changing the failure result', async () => {
    const clock = new TestClock();
    const map = openFloorMap([{ x: 0, z: 0 }], { now: clock.now });
    wallOffSingleCell(map);
    const parts = makePlanParts({ map, clock });
    const baseline = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock) }),
    );
    expect(baseline.problem).toEqual({ kind: 'no_path' });

    const record = actionRecord();
    const seen: (ActionRecord | null)[] = [];
    const hooked = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
      }),
    );
    await settleHook();
    expect(seen).toEqual([record]);
    expect(hooked).toEqual(baseline);
  });

  it('calls the hook after cancellation and after timeout', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const controller = new AbortController();
    controller.abort();
    const cancelledSeen: (ActionRecord | null)[] = [];
    const cancelled = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        signal: controller.signal,
        actionRecord: actionRecord(),
        persistAction: (candidate) => {
          cancelledSeen.push(candidate);
        },
      }),
    );
    await settleHook();
    expect(cancelled.problem).toMatchObject({ kind: 'cancelled' });
    expect(cancelledSeen).toHaveLength(1);

    const timeoutSeen: (ActionRecord | null)[] = [];
    const timedOut = await planRoute(
      planRequest({ deadlineMs: NOW }),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        persistAction: (candidate) => {
          timeoutSeen.push(candidate);
        },
      }),
    );
    await settleHook();
    expect(timedOut.problem).toEqual({ kind: 'timeout' });
    expect(timeoutSeen).toEqual([null]);
  });

  it('absorbs a throwing or rejecting hook without changing the plan result', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const baseline = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock) }),
    );
    const strip = (r: typeof baseline) => ({ ...r, plan: r.plan === undefined ? undefined : { ...r.plan, routeId: '@' } });

    const failures: unknown[] = [];
    const throwing = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        persistAction: () => {
          throw new Error('journal unavailable');
        },
        onPersistenceFailure: (error) => {
          failures.push(error);
        },
      }),
    );
    const rejecting = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        persistAction: () => Promise.reject(new Error('journal unavailable')),
        onPersistenceFailure: (error) => {
          failures.push(error);
        },
      }),
    );
    await settleHook();

    expect(strip(throwing)).toEqual(strip(baseline));
    expect(strip(rejecting)).toEqual(strip(baseline));
    // A failed save is observable, not silently swallowed.
    expect(failures).toHaveLength(2);
    expect(failures).toEqual([
      new Error('journal unavailable'),
      new Error('journal unavailable'),
    ]);
  });
});


describe('walkPath ActionRecord persistence hook (M6.2)', () => {
  it.each(['PARTIAL', 'NO_PATH', 'BLOCKED', 'INVALIDATED', 'TIMEOUT', 'CANCELLED'] as const)(
    'calls the hook for the %s terminal outcome',
    async (outcome) => {
      const record = actionRecord();
      const seen: (ActionRecord | null)[] = [];
      const { plan, walkPath } = injectedEntry(outcome);
      const { environment, bodyCalls } = countingEnvironment(
        {
          actionRecord: record,
          persistAction: (candidate) => {
            seen.push(candidate);
          },
        },
        plan,
      );

      const result = await walkPath({ routeId: plan.routeId, deadlineMs: DEADLINE }, environment);
      await settleHook();

      expect(result.outcome).toBe(outcome);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(record);
      expect(bodyCalls).toEqual({ move: 0, stop: 0 });
    },
  );

  it('calls the hook after a registry rejection as well', async () => {
    const seen: (ActionRecord | null)[] = [];
    const record = actionRecord();
    const registry = new RoutePlanRegistryImpl({ now: () => NOW });
    const walkPath = createWalkPath(registry, {
      execute: async () => {
        throw new Error('precheck must not execute');
      },
    });
    const { environment } = countingEnvironment(
      {
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
      },
      { start: { x: 0.5, y: 0, z: 0.5 }, routeId: 'rt_missing' },
    );

    const result = await walkPath({ routeId: 'rt_missing', deadlineMs: DEADLINE }, environment);
    await settleHook();

    expect(result.invalidation).toMatchObject({ reason: 'route_not_found' });
    expect(seen).toEqual([record]);
  });

  it('keeps a real TIMEOUT execution and its body port sequence unchanged when the hook rejects', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const hookedWalk = runExecution({
      points,
      actionRecord: actionRecord(),
      persistAction: () => Promise.reject(new Error('journal unavailable')),
    });
    const plainWalk = runExecution({ points });

    // The first segment confirms at 5360 ms; the deadline (5400 ms) expires
    // before the next segment can start.
    const hooked = await hookedWalk({ deadlineMs: NOW + 400 });
    const plain = await plainWalk({ deadlineMs: NOW + 400 });
    await settleHook();

    expect(plain.result.outcome).toBe('TIMEOUT');
    expect(hooked.result.outcome).toBe('TIMEOUT');
    expect(stripWalkIdentity(hooked.result)).toEqual(stripWalkIdentity(plain.result));
    expect(hooked.moves).toEqual(plain.moves);
    expect(hooked.stops).toEqual(plain.stops);
  });

  it('leaves a real ARRIVED execution and its body port sequence unchanged when the hook rejects', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const hookedWalk = runExecution({
      points,
      actionRecord: actionRecord(),
      persistAction: () => Promise.reject(new Error('journal unavailable')),
    });

    const hooked = await hookedWalk({ deadlineMs: DEADLINE });
    await settleHook();

    expect(hooked.result.outcome).toBe('ARRIVED');
    expect(hooked.result.confirmed).toBe(true);
    const plainWalk = runExecution({ points });
    const plain = await plainWalk({ deadlineMs: DEADLINE });
    expect(stripWalkIdentity(hooked.result)).toEqual(stripWalkIdentity(plain.result));
    // A rejecting hook must not add, drop or reorder any body port call.
    expect(hooked.moves).toEqual(plain.moves);
    expect(hooked.stops).toEqual(plain.stops);
    expect(plain.moves).toHaveLength(2);
  });

  it('keeps a real CANCELLED execution unchanged when the hook throws', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const run = (withHook: boolean) => {
      const controller = new AbortController();
      const walk = runExecution({
        points,
        afterWait: (waitCount) => {
          if (waitCount === 10) controller.abort();
        },
        ...(withHook
          ? {
              actionRecord: actionRecord(),
              persistAction: () => {
                throw new Error('journal unavailable');
              },
            }
          : {}),
      });
      return { walk, signal: controller.signal };
    };

    const plain = run(false);
    const plainRun = await plain.walk({ deadlineMs: DEADLINE, signal: plain.signal });
    const hooked = run(true);
    const hookedRun = await hooked.walk({ deadlineMs: DEADLINE, signal: hooked.signal });
    await settleHook();

    expect(plainRun.result.outcome).toBe('CANCELLED');
    expect(hookedRun.result.outcome).toBe('CANCELLED');
    expect(stripWalkIdentity(hookedRun.result)).toEqual(stripWalkIdentity(plainRun.result));
    expect(hookedRun.moves).toEqual(plainRun.moves);
    expect(hookedRun.stops).toEqual(plainRun.stops);
    expect(plainRun.stops).toHaveLength(1);
  });

  it('persists nothing when no hook is supplied despite a caller record', async () => {
    const seen = { calls: 0 };
    const record = actionRecord();
    const registry = new RoutePlanRegistryImpl({ now: () => NOW });
    const plan = registry.register(draftWith([{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }]));
    const executionId = `exec_${plan.routeId}`;
    const walkPath = createWalkPath(registry, {
      execute: async () => ({
        outcome: 'CANCELLED',
        contract: 'memory-host-contract/1',
        routeId: plan.routeId,
        executionId,
        confirmedSegments: 0,
        remainingPoints: plan.points.map((p) => ({ ...p })),
        consumption: { placed: [] },
        confirmed: false,
        trace: [],
      }),
    });
    const { environment } = countingEnvironment({ actionRecord: record }, plan);

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: DEADLINE }, environment);
    await settleHook();

    expect(result.outcome).toBe('CANCELLED');
    expect(seen.calls).toBe(0);
  });

  it('calls the hook after a pre-execution route_start_unmeasured invalidation', async () => {
    const record = actionRecord();
    const seen: (ActionRecord | null)[] = [];
    const { plan, walkPath } = injectedEntry('INVALIDATED');
    const { environment, bodyCalls } = countingEnvironment(
      {
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
        sample: () => null,
      },
      plan,
    );

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: DEADLINE }, environment);
    await settleHook();

    expect(result.invalidation).toMatchObject({ reason: 'route_start_unmeasured' });
    expect(seen).toEqual([record]);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('calls the hook after a pre-execution start-drift invalidation', async () => {
    const record = actionRecord();
    const seen: (ActionRecord | null)[] = [];
    const { plan, walkPath } = injectedEntry('INVALIDATED');
    const { environment } = countingEnvironment(
      {
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
        sample: () => ({
          ...SCOPE,
          pos: { x: plan.start.x + 0.2, y: plan.start.y, z: plan.start.z },
          observedAt: NOW,
          alive: true,
          connected: true,
          observationReady: true,
          onGround: true,
          inWater: false,
          executionId: `exec_${plan.routeId}`,
          sequence: 1,
        }),
      },
      plan,
    );

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: DEADLINE }, environment);
    await settleHook();

    expect(result.invalidation).toMatchObject({ reason: 'route_start_changed' });
    expect(seen).toEqual([record]);
  });

  it('calls the hook after a pre-execution scope_mismatch invalidation', async () => {
    const record = actionRecord();
    const seen: (ActionRecord | null)[] = [];
    const { plan, walkPath } = injectedEntry('INVALIDATED');
    const { environment } = countingEnvironment(
      {
        actionRecord: record,
        persistAction: (candidate) => {
          seen.push(candidate);
        },
        sample: () => ({
          ...SCOPE,
          dim: 'nether',
          pos: { ...plan.start },
          observedAt: NOW,
          alive: true,
          connected: true,
          observationReady: true,
          onGround: true,
          inWater: false,
          executionId: `exec_${plan.routeId}`,
          sequence: 1,
        }),
      },
      plan,
    );

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: DEADLINE }, environment);
    await settleHook();

    expect(result.invalidation).toMatchObject({ reason: 'scope_mismatch' });
    expect(seen).toEqual([record]);
  });

  it('keeps a real PARTIAL execution and its body port sequence unchanged when the hook rejects', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const hookedWalk = runExecution({
      points,
      resolveMoveAt: (moveIndex) => moveIndex === 2,
      actionRecord: actionRecord(),
      persistAction: () => Promise.reject(new Error('journal unavailable')),
    });
    const plainWalk = runExecution({ points, resolveMoveAt: (moveIndex) => moveIndex === 2 });

    const hooked = await hookedWalk({ deadlineMs: DEADLINE });
    const plain = await plainWalk({ deadlineMs: DEADLINE });
    await settleHook();

    expect(plain.result.outcome).toBe('PARTIAL');
    expect(hooked.result.outcome).toBe('PARTIAL');
    expect(stripWalkIdentity(hooked.result)).toEqual(stripWalkIdentity(plain.result));
    expect(hooked.moves).toEqual(plain.moves);
    expect(hooked.stops).toEqual(plain.stops);
    expect(plain.moves).toHaveLength(2);
  });

  it('keeps a real execution-time INVALIDATED and its body port sequence unchanged when the hook throws', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    // The second step's destination head cell stays unobserved: UNKNOWN, never
    // treated as OPEN, so the executor invalidates after the first segment.
    const skipObserve = (pos: { x: number; y: number; z: number }): boolean =>
      pos.x === 2 && pos.y === 1 && pos.z === 0;
    const hookedWalk = runExecution({
      points,
      skipObserve,
      actionRecord: actionRecord(),
      persistAction: () => {
        throw new Error('journal unavailable');
      },
    });
    const plainWalk = runExecution({ points, skipObserve });

    const hooked = await hookedWalk({ deadlineMs: DEADLINE });
    const plain = await plainWalk({ deadlineMs: DEADLINE });
    await settleHook();

    expect(plain.result.outcome).toBe('INVALIDATED');
    expect(hooked.result.outcome).toBe('INVALIDATED');
    expect(stripWalkIdentity(hooked.result)).toEqual(stripWalkIdentity(plain.result));
    expect(hooked.moves).toEqual(plain.moves);
    expect(hooked.stops).toEqual(plain.stops);
    expect(plain.moves).toHaveLength(1);
  });

  it('reports a rejecting hook through onPersistenceFailure without touching the walk result', async () => {
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const failures: unknown[] = [];
    const failure = new Error('journal unavailable');
    const hookedWalk = runExecution({
      points,
      actionRecord: actionRecord(),
      persistAction: () => Promise.reject(failure),
      onPersistenceFailure: (error) => {
        failures.push(error);
      },
    });

    const hooked = await hookedWalk({ deadlineMs: DEADLINE });
    await settleHook();

    expect(hooked.result.outcome).toBe('ARRIVED');
    expect(failures).toEqual([failure]);
  });

  it('hands the hook the caller record once per call and never a synthesized one', async () => {
    const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const record = actionRecord({ id: 'host-owned' });
    const seen: (ActionRecord | null)[] = [];
    const run = runExecution({
      points,
      actionRecord: record,
      persistAction: (candidate) => {
        seen.push(candidate);
      },
    });

    const { result } = await run({ deadlineMs: DEADLINE });
    await settleHook();
    expect(result.outcome).toBe('ARRIVED');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(record);
  });
});
