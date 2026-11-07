import { describe, expect, it } from 'vitest';

import type { BodySample, ExecutableMove, ExecutableMoveResult } from '../src/execution/types.js';
import { createWalkPath, createWalkPathExecution } from '../src/navigation/walk-path.js';
import type { WalkBodyPort, WalkPathEnvironment } from '../src/navigation/walk-path-types.js';
import type { CancellationOrigin } from '../src/navigation/route-plan-types.js';
import { RoutePlanRegistryImpl } from '../src/navigation/route-plan-registry.js';
import type { RoutePlanDraft } from '../src/navigation/route-plan-types.js';
import type { Vec3Like } from '../src/types.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { AIR, STONE, bodyAt, fakeProvider, obs } from './fakes.js';

const NOW = 5000;
const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const WAIT_STEP_MS = 40;

/** Same-height feet columns along +X, one block apart. */
function routeAlong(...cells: number[]): Vec3Like[] {
  return cells.map((x) => ({ x: x + 0.5, y: 0, z: 0.5 }));
}

function draft(points: Vec3Like[]): RoutePlanDraft {
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

/** Observe open air over a stone floor around every route point. */
function observeWorld(map: VoxelMap, points: readonly Vec3Like[]): void {
  const minX = Math.min(...points.map((p) => Math.floor(p.x)));
  const maxX = Math.max(...points.map((p) => Math.floor(p.x)));
  for (let x = minX - 1; x <= maxX + 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 2; y++) {
        const state = y === -1 ? STONE : AIR;
        map.observe(obs(state, { x, y, z }, { observedAt: 1000 }));
      }
    }
  }
}

interface HarnessOptions {
  /** Feet reported after a move; defaults to the move target. */
  feetAfterMove?: (move: ExecutableMove, moveIndex: number) => Vec3Like;
  /** Runs after each wait's clock advance; used to abort the signal mid-execution. */
  afterWait?: (waitCount: number, clock: number) => void;
  startPosition?: Vec3Like;
  /** Parent delegation that owns the cancellation. */
  cancellationOrigin?: CancellationOrigin;
  /** Resolve a body-port move immediately with this failure instead of a pending promise. */
  moveFailure?: ExecutableMoveResult['failure'];
}

/**
 * `walkPath` harness over the real library executor. Moves never resolve by
 * themselves, so progress is measured, not promise-driven; a wait advances the
 * clock by one slice and is the only seam a test needs to cancel mid-run.
 */
function harness(points: Vec3Like[], options: HarnessOptions = {}) {
  let clock = NOW;
  let sequence = 0;
  let position: Vec3Like = { ...(options.startPosition ?? points[0]!) };
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];
  const moveSignals: AbortSignal[] = [];
  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;
  const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => clock });
  observeWorld(map, points);

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => {
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
    },
    bodyPort: {
      move: (request) => {
        moves.push(request);
        moveSignals.push(request.signal);
        position = options.feetAfterMove?.(request, moves.length) ?? { ...request.to };
        if (options.moveFailure !== undefined) {
          return Promise.resolve({ failure: options.moveFailure });
        }
        return new Promise<ExecutableMoveResult>(() => {});
      },
      stop: (id) => {
        stops.push(id);
      },
    },
    now: () => clock,
    ...(options.cancellationOrigin === undefined
      ? {}
      : { cancellationOrigin: options.cancellationOrigin }),
  };

  const wait = async (): Promise<void> => {
    clock += WAIT_STEP_MS;
    options.afterWait?.(Math.round((clock - NOW) / WAIT_STEP_MS), clock);
  };
  const execute = createWalkPathExecution({ map, wait });
  const walkPath = createWalkPath(registry, { execute });

  return { plan, executionId, environment, walkPath, moves, stops, moveSignals, position: () => position };
}

describe('walkPath cancellation — partial effects and signal (M4.6)', () => {
  it('preserves confirmed displacement, segments, observation and trace when the signal aborts', async () => {
    const points = routeAlong(0, 1, 2);
    const controller = new AbortController();
    // The first move starts once the start point stabilizes (5 waits); the first
    // segment then confirms after a 160 ms settled window (wait 10). Abort right
    // after that confirmation, before the next segment starts.
    const h = harness(points, {
      afterWait: (waitCount) => {
        if (waitCount === 10) controller.abort();
      },
    });

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: NOW + 20_000, signal: controller.signal },
      h.environment,
    );

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(1);
    expect(result.remainingPoints).toEqual([points[2]]);
    expect(result.lastPosition).toEqual(points[1]);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.pos).toEqual(points[1]);
    expect(result.trace[0]!.ts).toBeGreaterThan(NOW);
    expect(result.problem).toMatchObject({ kind: 'cancelled' });

    // Only the first segment ran; the body effect is reported, never rolled back.
    expect(h.moves.map((move) => move.to)).toEqual([points[1]]);
    expect(h.position()).toEqual(points[1]);
    expect(h.stops).toEqual([h.executionId]);
    expect(h.moveSignals[0]!.aborted).toBe(true);
  });

  it('preserves confirmed progress and measured evidence when the deadline expires', async () => {
    const points = routeAlong(0, 1, 2);
    // The first segment confirms at 5360 ms; the deadline (5400 ms) expires
    // before the next segment can start.
    const h = harness(points);

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: NOW + 400 },
      h.environment,
    );

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.outcome).not.toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(1);
    expect(result.remainingPoints).toEqual([points[2]]);
    expect(result.lastPosition).toEqual(points[1]);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.trace).toHaveLength(1);
    expect(result.problem).toMatchObject({ kind: 'timeout' });
    expect(h.moves.map((move) => move.to)).toEqual([points[1]]);
    expect(h.stops).toEqual([h.executionId]);
  });

  it('preserves a measured partial displacement on timeout without confirming it', async () => {
    const points = routeAlong(0, 1, 2);
    // Move progresses half a block toward the next point; it is measured but not
    // within the grounded-arrival tolerance, so it must be kept, not confirmed.
    const midpoint = { x: 1.05, y: 0, z: 0.5 };
    const h = harness(points, { feetAfterMove: () => ({ ...midpoint }) });

    // The move starts at 5200 ms after the start point stabilizes; the deadline
    // (5240 ms) expires while it is still in flight.
    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: NOW + 240 },
      h.environment,
    );

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(midpoint);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.trace).toEqual([]);
    expect(result.remainingPoints).toEqual([points[1], points[2]]);
    expect(h.position()).toEqual(midpoint);
    expect(h.stops).toEqual([h.executionId]);
    expect(h.moveSignals[0]!.aborted).toBe(true);
  });

  it('stops a pending in-flight move when the parent signal aborts', async () => {
    const points = routeAlong(0, 1, 2);
    const controller = new AbortController();
    const midpoint = { x: 1.05, y: 0, z: 0.5 };
    const h = harness(points, {
      feetAfterMove: () => ({ ...midpoint }),
      cancellationOrigin: 'agent',
      afterWait: (waitCount) => {
        // The move starts at 5200 ms after the start point stabilizes.
        if (waitCount === 6) controller.abort();
      },
    });

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: NOW + 20_000, signal: controller.signal },
      h.environment,
    );

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(midpoint);
    expect(result.trace).toEqual([]);
    expect(result.remainingPoints).toEqual([points[1], points[2]]);
    // The cancellation is attributed to the parent delegation that owned the signal.
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'agent' });
    // The in-flight move's own stop was scoped to this execution.
    expect(h.stops).toEqual([h.executionId]);
    expect(h.moveSignals).toHaveLength(1);
    expect(h.moveSignals[0]!.aborted).toBe(true);
  });

  it('maps a body-port cancelled move to CANCELLED without rewriting measured progress', async () => {
    const points = routeAlong(0, 1, 2);
    const midpoint = { x: 1.05, y: 0, z: 0.5 };
    const h = harness(points, {
      feetAfterMove: () => ({ ...midpoint }),
      moveFailure: { kind: 'cancelled' },
    });

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: NOW + 20_000 },
      h.environment,
    );

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(midpoint);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.trace).toEqual([]);
    expect(result.problem).toMatchObject({ kind: 'cancelled' });
    expect(result.remainingPoints).toEqual([points[1], points[2]]);
    expect(h.stops).toEqual([h.executionId]);
  });
});

interface SharedPorts {
  port: WalkBodyPort;
  moves: ExecutableMove[];
  stops: string[];
  signals: AbortSignal[];
  positions: Map<string, Vec3Like>;
  resolveMove: (moveIndex: number, result: ExecutableMoveResult) => boolean;
}

/** One body port shared by concurrent executions, exactly as a host has one body. */
function sharedPorts(): SharedPorts {
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];
  const signals: AbortSignal[] = [];
  const positions = new Map<string, Vec3Like>();
  const resolvers: Array<(result: ExecutableMoveResult) => void> = [];
  return {
    moves,
    stops,
    signals,
    positions,
    port: {
      move: (request) => {
        moves.push(request);
        signals.push(request.signal);
        positions.set(request.executionId, { ...request.to });
        return new Promise<ExecutableMoveResult>((resolve) => {
          resolvers.push(resolve);
        });
      },
      stop: (id) => {
        stops.push(id);
      },
    },
    resolveMove: (moveIndex, result) => {
      const resolve = resolvers[moveIndex];
      if (resolve === undefined) return false;
      resolve(result);
      return true;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the two in-flight executions reach their first move and suspend on the gate. */
async function flushMicrotasks(times = 100): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Waits needed before the executor's start-point boundary check lets the first
 * move start: the accepted start sample plus a settled window at 40 ms/slice.
 */
const START_SETTLE_WAITS = 5;

/**
 * One execution over a shared body port. It settles the start point, starts its
 * first move, then suspends on the gate. `registryNow` keeps the two concurrent
 * plans' routeIds distinct.
 */
function isolatedExecution(
  points: Vec3Like[],
  shared: SharedPorts,
  gate: Promise<void>,
  registryNow = NOW,
) {
  let clock = NOW;
  let sequence = 0;
  let waits = 0;
  const registry = new RoutePlanRegistryImpl({ now: () => registryNow });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;
  const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => clock });
  observeWorld(map, points);

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => {
      sequence += 1;
      return {
        ...SCOPE,
        pos: { ...(shared.positions.get(executionId) ?? points[0]!) },
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
    },
    bodyPort: shared.port,
    now: () => clock,
  };

  const execute = createWalkPathExecution({
    map,
    wait: async () => {
      clock += WAIT_STEP_MS;
      waits += 1;
      if (waits > START_SETTLE_WAITS) await gate;
    },
  });
  return { plan, executionId, environment, walkPath: createWalkPath(registry, { execute }) };
}

describe('walkPath cancellation — old execution isolation (M4.6)', () => {
  it('stops and settles only its own execution; a new execution is unaffected', async () => {
    const shared = sharedPorts();
    const gateA = deferred();
    const gateB = deferred();
    const controller = new AbortController();
    const oldPoints = routeAlong(0, 1, 2);
    const newPoints = routeAlong(10, 11, 12);
    const oldRun = isolatedExecution(oldPoints, shared, gateA.promise);
    const newRun = isolatedExecution(newPoints, shared, gateB.promise, NOW + 1_000);

    // Both executions are in flight: one measured move each, suspended on a wait.
    const oldResultPromise = oldRun.walkPath(
      { routeId: oldRun.plan.routeId, deadlineMs: NOW + 60_000, signal: controller.signal },
      oldRun.environment,
    );
    const newResultPromise = newRun.walkPath(
      { routeId: newRun.plan.routeId, deadlineMs: NOW + 60_000 },
      newRun.environment,
    );
    await flushMicrotasks();
    expect(shared.moves.map((move) => move.executionId)).toEqual([oldRun.executionId, newRun.executionId]);
    const newMoveSignal = shared.signals[1]!;

    // Cancel the old execution; its stop must name only the old execution.
    controller.abort();
    gateA.resolve();
    const oldResult = await oldResultPromise;

    expect(oldResult.outcome).toBe('CANCELLED');
    expect(oldResult.confirmed).toBe(false);
    expect(oldResult.lastPosition).toEqual(oldPoints[1]);
    expect(shared.stops).toEqual([oldRun.executionId]);
    expect(newMoveSignal.aborted).toBe(false);

    // A late result from the old execution's move must not revive or rewrite it,
    // and must not touch the new execution.
    expect(
      shared.resolveMove(0, {
        sample: {
          ...SCOPE,
          pos: { ...oldPoints[2]! },
          observedAt: NOW,
          velocity: { x: 0, y: -0.0784, z: 0 },
          alive: true,
          connected: true,
          observationReady: true,
          onGround: true,
          inWater: false,
          executionId: oldRun.executionId,
          sequence: 99,
        },
      }),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldResult.outcome).toBe('CANCELLED');
    expect(oldResult.confirmed).toBe(false);

    // Let the new execution finish on its own measured samples.
    gateB.resolve();
    const newResult = await newResultPromise;

    expect(newResult.outcome).toBe('ARRIVED');
    expect(newResult.confirmed).toBe(true);
    expect(newResult.executionId).toBe(newRun.executionId);
    expect(newResult.lastPosition).toEqual(newPoints[2]);
    expect(shared.moves.filter((move) => move.executionId === newRun.executionId).map((move) => move.to))
      .toEqual([newPoints[1], newPoints[2]]);
    expect(shared.moves.filter((move) => move.executionId === oldRun.executionId)).toHaveLength(1);
    // Every stop names its own execution; the old cancellation never stopped the new one.
    expect(new Set(shared.stops)).toEqual(new Set([oldRun.executionId, newRun.executionId]));
    expect(shared.stops.filter((id) => id === oldRun.executionId)).toHaveLength(1);
    expect(shared.stops.filter((id) => id === newRun.executionId).length).toBeGreaterThan(0);
  });
});
