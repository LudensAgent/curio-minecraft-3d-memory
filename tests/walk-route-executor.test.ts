import { describe, expect, it } from 'vitest';

import { VoxelMap, WalkRouteExecutor } from '../src/index.js';
import type {
  BlockState,
  BodySample,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Vec3Like,
  WalkRouteRequest,
} from '../src/index.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };

/** Fake single-step executor — NOT a Minecraft body. */
class FakeMoveExecutor implements MoveExecutor {
  readonly stopped: string[] = [];
  private queue: Array<(req: ExecutableMove) => ExecutableMoveResult | Promise<ExecutableMoveResult>> = [];
  private seq = 1;

  push(behavior: (req: ExecutableMove) => ExecutableMoveResult | Promise<ExecutableMoveResult>): void {
    this.queue.push(behavior);
  }

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const behavior = this.queue.shift();
    if (behavior === undefined) {
      return Promise.resolve({ sample: makeSample(request, request.to, { sequence: ++this.seq }) });
    }
    try {
      return Promise.resolve(behavior(request));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

/** Fake executor whose stop() synchronously invokes a callback (for re-entrancy tests). */
class ReentrantExecutor implements MoveExecutor {
  readonly stopped: string[] = [];
  private onStop: (() => void) | null = null;

  setOnStop(fn: () => void): void {
    this.onStop = fn;
  }

  move(): Promise<ExecutableMoveResult> {
    return new Promise<ExecutableMoveResult>(() => {}); // never resolves; control released only via stop
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
    this.onStop?.();
  }
}

/** Fake executor whose move() is deferred and whose stop() synchronously invokes a callback. */
class CancelOnStopExecutor implements MoveExecutor {
  readonly stopped: string[] = [];
  private onStop: (() => void) | null = null;
  private resolveMove: ((r: ExecutableMoveResult) => void) | null = null;

  setOnStop(fn: () => void): void {
    this.onStop = fn;
  }

  move(): Promise<ExecutableMoveResult> {
    return new Promise<ExecutableMoveResult>((resolve) => {
      this.resolveMove = resolve;
    });
  }

  resolve(result: ExecutableMoveResult): void {
    this.resolveMove?.(result);
    this.resolveMove = null;
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
    this.onStop?.();
  }
}

function makeSample(
  scope: { worldId: string; dim: string; sessionId: string; executionId: string },
  pos: Vec3Like,
  overrides: Partial<BodySample> = {},
): BodySample {
  return {
    worldId: scope.worldId,
    dim: scope.dim,
    sessionId: scope.sessionId,
    executionId: scope.executionId,
    sequence: 1,
    pos: { ...pos },
    observedAt: 2100,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    ...overrides,
  };
}

function openRouteMap(map: VoxelMap, nPoints: number): Vec3Like[] {
  for (let k = 0; k < nPoints; k++) {
    map.observe(obs(STONE, { x: k, y: -1, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 1, z: 0 }));
  }
  return Array.from({ length: nPoints }, (_, k) => ({ x: k + 0.5, y: 0, z: 0.5 }));
}

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function makeRequest(points: Vec3Like[], overrides: Partial<WalkRouteRequest> = {}): WalkRouteRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    points,
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    deadlineMs: 100_000,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Start a delegation and confirm the body is measured at the route start. */
function begin(loop: WalkRouteExecutor, points: Vec3Like[], overrides: Partial<WalkRouteRequest> = {}): string {
  const status = loop.start(makeRequest(points, overrides));
  const delegationId = status.delegationId;
  loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[0]!, { sequence: 1 }));
  return delegationId;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WalkRouteExecutor — controlled step-by-step execution', () => {
  it('walks a route one step at a time and only arrives on a measured target', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3); // 2 steps
    const executor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);

    const first = loop.advance(10);
    expect(first.activeStepIndex).toBe(0);
    expect(first.result).toBeNull(); // route OPEN alone is not arrival

    await tick();
    expect(loop.status()!.nextPointIndex).toBe(2);
    expect(loop.status()!.result).toBeNull();

    loop.advance(10);
    await tick();
    const done = loop.status()!;
    expect(done.result?.outcome).toBe('ARRIVED');
    expect(done.result?.confirmed).toBe(true);
    expect(done.result?.lastPosition).toEqual(points[2]);
  });

  it('does not arrive when the move resolves but the body did not reach the target', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, points[0]!, { sequence: 2 }) }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    expect(loop.status()!.result?.outcome).toBe('FAILED');
    expect(loop.status()!.result?.problem?.kind).toBe('deviation');
  });

  it('does not arrive at the wrong height', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, { ...points[1]!, y: points[1]!.y + 1 }, { sequence: 2 }) }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    expect(loop.status()!.result?.outcome).toBe('FAILED');
    expect(loop.status()!.result?.problem?.kind).toBe('deviation');
  });

  it('does not arrive on a stale pre-execution sample even at the target', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, points[1]!, { observedAt: 500, sequence: 2 }) }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    expect(loop.status()!.result?.outcome).toBe('FAILED');
    expect(loop.status()!.result?.problem?.kind).toBe('unconfirmed_arrival');
  });

  it('keeps a real arrival after a non-cancel move failure', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    let rejectMove!: (e: unknown) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((_resolve, reject) => { rejectMove = reject; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationId = begin(loop, points);
    loop.advance(10);

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[1]!, { sequence: 2 }));
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');

    rejectMove(new Error('executor crashed'));
    await tick();
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');
  });
});

describe('WalkRouteExecutor — start-position and sample validation', () => {
  it('does not start a move without a measured start position', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(makeRequest(points));
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.problem?.kind).toBe('unmeasured_position');
  });

  it('stops when the body is measured off the route start', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const start = loop.start(makeRequest(points));
    const status = loop.onSample(makeSample({ ...SCOPE, executionId: start.delegationId }, { x: 20.5, y: 0, z: 0.5 }, { sequence: 1 }));

    expect(status.result?.problem?.kind).toBe('deviation');
  });

  it('ignores a foreign, pre-execution, replayed, or non-finite sample', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const start = loop.start(makeRequest(points));
    const delegationId = start.delegationId;

    loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-999' }, points[0]!, { sequence: 1 }));
    expect(loop.status()!.lastPosition).toBeNull();

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[0]!, { observedAt: 500, sequence: 1 }));
    expect(loop.status()!.lastPosition).toBeNull();

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[0]!, { observedAt: Infinity, sequence: 1 }));
    expect(loop.status()!.lastPosition).toBeNull();

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, { x: Infinity, y: 0, z: 0.5 }, { sequence: 1 }));
    expect(loop.status()!.lastPosition).toBeNull();
  });
});

describe('WalkRouteExecutor — never starts an unpassable segment', () => {
  it('does not start a blocked step', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.outcome).toBe('BLOCKED');
    expect(status.result?.problem?.kind).toBe('blocked');
  });

  it('reports missing support as a geometric gap, not a fabricated contact', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [1, -1, 0]]);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ]);
    const status = loop.advance(10);

    expect(status.result?.outcome).toBe('BLOCKED');
    expect(status.result?.problem?.kind).toBe('support_missing');
  });

  it('does not start an unobserved (unknown) step', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0]]);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ]);
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.problem?.kind).toBe('unobserved');
  });

  it('does not start a stale step', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    begin(loop, points);
    clock = 70_000;
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.problem?.kind).toBe('stale');
  });

  it('does not start a move whose evidence expired in the same round', () => {
    let clock = 1500;
    const map = new VoxelMap('world', { validityWindowMs: 1000, now: () => clock });
    const points = openRouteMap(map, 2); // observedAt 1000 → validUntil 2000
    const provider: CollisionShapeProvider = {
      version: 'advance-clock',
      resolve(state, cell, read) {
        clock = 2500; // expire the evidence once verification has begun
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    begin(loop, points, { shapeProvider: provider });
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull(); // not started
    expect(status.route.steps[0]!.kind).toBe('pending'); // revoked by expiry
  });

  it('does not start an unverified step and does not report no-path', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4); // 3 steps
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();
    loop.advance(10); await tick(); // nextPointIndex = 3

    const report = map.observe(obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 1500, sequence: 99 }));
    loop.observe(report, 1);
    loop.advance(1);

    const status = loop.status()!;
    expect(status.activeStepIndex).toBeNull();
    expect(status.result).toBeNull();
    expect(status.route.steps[2]!.kind).toBe('pending');
  });
});

describe('WalkRouteExecutor — in-flight invalidation and stopping', () => {
  it('stops the in-flight step when its section changes', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    let resolveMove!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveMove = resolve; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBe(0);

    const report = map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const status = loop.observe(report, 10);

    expect(status.result?.problem?.kind).toBe('route_invalidated');
    expect(status.activeStepIndex).toBeNull();
    expect(executor.stopped).toContain('walk-1-step-0');

    resolveMove({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, points[1]!) });
    await tick();
    expect(loop.status()!.result?.problem?.kind).toBe('route_invalidated');
  });

  it('does not interrupt on an unrelated change', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);

    const report = map.observe(obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const status = loop.observe(report, 10);

    expect(status.result).toBeNull();
    expect(status.activeStepIndex).toBe(0);
  });

  it('observe checks expiry even with an unrelated report', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    begin(loop, points, { timeoutMs: 200_000 });
    loop.advance(10);
    clock = 70_000; // TTL expired
    const status = loop.observe({ sections: [] }, 10);

    expect(status.result?.problem?.kind).toBe('route_invalidated');
  });

  it('TTL expiry revokes the in-flight step without a new observation', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    begin(loop, points, { timeoutMs: 200_000 });
    loop.advance(10);

    clock = 70_000;
    const status = loop.advance(10);
    expect(status.result?.problem?.kind).toBe('route_invalidated');
    expect(status.activeStepIndex).toBeNull();
  });

  it('a rule-version change revokes the in-flight step even if still OPEN', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const provider: CollisionShapeProvider = {
      version: 'v1',
      resolve(state, cell, read) {
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points, { shapeProvider: provider });
    loop.advance(10);

    provider.version = 'v2';
    const status = loop.advance(10);

    expect(status.result?.problem?.kind).toBe('route_invalidated');
    expect(status.activeStepIndex).toBeNull();
  });

  it('move completion also checks rule-version invalidation', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    let resolveMove!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveMove = resolve; }));
    const provider: CollisionShapeProvider = {
      version: 'v1',
      resolve(state, cell, read) {
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points, { shapeProvider: provider });
    loop.advance(10);

    provider.version = 'v2';
    resolveMove({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, points[1]!, { sequence: 2 }) });
    await tick();

    expect(loop.status()!.result?.problem?.kind).toBe('route_invalidated');
  });
});

describe('WalkRouteExecutor — cancel, timeout, priority and ownership', () => {
  it('cancel preserves confirmed partial displacement', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();

    const result = loop.cancel('agent', 'stop');
    expect(result.outcome).toBe('CANCELLED');
    expect(result.lastPosition).toEqual(points[1]);
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'agent' });
  });

  it('cancel returns an isolated snapshot', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();

    const result = loop.cancel('agent', 'stop');
    result.message = 'MUTATED';
    expect(loop.status()!.result?.message).toBe('cancelled by agent: stop');
  });

  it('timeout preserves the last confirmed position', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    begin(loop, points, { deadlineMs: 50_000 });
    loop.advance(10); await tick();

    clock = 60_000;
    const status = loop.checkTimeout();
    expect(status.result?.outcome).toBe('TIMEOUT');
    expect(status.result?.lastPosition).toEqual(points[1]);
  });

  it('step-by-step advance does not reset the original deadline', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    begin(loop, points, { deadlineMs: 50_000 });
    loop.advance(10); await tick();
    clock = 3000;
    const status = loop.status()!;
    expect(status.deadlineMs).toBe(50_000);
    expect(status.remainingMs).toBe(47_000);
  });

  it('a cancelled failure overrides a confirming sample', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, points[1]!, { sequence: 2 }), failure: { kind: 'cancelled' } }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('CANCELLED');
    expect(status.result?.lastPosition).toEqual(points[1]);
  });

  it('onSample checks the deadline', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    const delegationId = begin(loop, points, { deadlineMs: 3000 });
    loop.advance(10);
    clock = 4000;

    const status = loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[1]!, { sequence: 2 }));
    expect(status.result?.outcome).toBe('TIMEOUT');
  });

  it('does not arrive when the result arrives after the deadline', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    let resolveMove!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveMove = resolve; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    begin(loop, points, { deadlineMs: 3000 });
    loop.advance(10);
    clock = 4000;

    resolveMove({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, points[1]!, { sequence: 2 }) });
    await tick();

    expect(loop.status()!.result?.outcome).toBe('TIMEOUT');
  });

  it('enforces the per-move timeout at the check entry', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    begin(loop, points, { timeoutMs: 1000 });
    loop.advance(10);
    clock = 3100;

    expect(loop.checkTimeout().result?.outcome).toBe('TIMEOUT');
  });

  it('a late result from a replaced delegation is ignored', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    let resolveOld!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveOld = resolve; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); // step 0 in flight (deferred)

    begin(loop, points); // generation 2
    loop.advance(10); await tick();
    expect(loop.status()!.nextPointIndex).toBe(2);

    resolveOld({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, points[1]!, { sequence: 2 }) });
    await tick();

    expect(loop.status()!.nextPointIndex).toBe(2);
    expect(loop.status()!.result).toBeNull();
  });

  it('releases control when the move promise returns a sample', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick(); // step 0 promise returns a sample

    expect(loop.status()!.nextPointIndex).toBe(2);
    expect(executor.stopped).toContain('walk-1-step-0'); // control released
  });

  it('releases the old move when an external sample confirms arrival', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    let resolveStep0!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveStep0 = resolve; }));
    executor.push((req) => ({ sample: makeSample(req, req.to, { sequence: 3 }) })); // step 1 explicit
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationId = begin(loop, points);
    loop.advance(10);

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[1]!, { sequence: 2 }));
    expect(loop.status()!.nextPointIndex).toBe(2);
    expect(executor.stopped).toContain('walk-1-step-0');

    loop.advance(10); await tick();
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');

    resolveStep0({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, points[1]!, { sequence: 2 }) });
    await tick();
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');
  });

  it('rejects a replayed same-millisecond sample', async () => {
    const map = new VoxelMap('world');
    const A = { x: 0.5, y: 0, z: 0.5 };
    const B = { x: 1.5, y: 0, z: 0.5 };
    const points = [A, B, A, B];
    fill(map, STONE, [[0, -1, 0], [1, -1, 0]]);
    fill(map, AIR, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0]]);
    const executor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationId = begin(loop, points);
    loop.advance(10); await tick(); // step 0 → B (seq 2)
    loop.advance(10); await tick(); // step 1 → A (seq 3)
    expect(loop.status()!.nextPointIndex).toBe(3);

    // Replay the step-0 B sample (same sequence) at the same-ms: must be rejected.
    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, B, { sequence: 2 }));
    expect(loop.status()!.nextPointIndex).toBe(3); // unchanged, not ARRIVED
    expect(loop.status()!.result).toBeNull();
  });
});

describe('WalkRouteExecutor — cache invalidation across termination', () => {
  it('keeps the cache invalidated across cancellation and re-registration', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();
    loop.cancel('agent', 'stop');

    const report = map.observe(obs(STONE, { x: 2, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    loop.observe(report, 10);

    begin(loop, points);
    const status = loop.advance(10);
    const step1 = status.route.steps[1]!;
    expect(step1.kind === 'verified' && step1.result.status).toBe('BLOCKED');
  });
});

describe('WalkRouteExecutor — explicit rejection of unsupported requests', () => {
  it('rejects a non-walk mode', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { mode: 'jump' }));
    expect(status.result?.problem?.kind).toBe('unsupported_mode');
  });

  it('rejects a non-exact arrival', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { arrival: { kind: 'near', radius: 2 } }));
    expect(status.result?.problem?.kind).toBe('unsupported_target');
  });

  it('rejects a non-empty avoid constraint', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }));
    expect(status.result?.problem?.kind).toBe('not_authorized');
  });

  it('executes only the authorized ordered points, never dig/place/target changes', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4);
    const executor = new FakeMoveExecutor();
    const targets: Vec3Like[] = [];
    for (let i = 0; i < 3; i++) {
      executor.push((req) => {
        targets.push({ ...req.to });
        return { sample: makeSample(req, req.to, { sequence: i + 2 }) };
      });
    }
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();
    loop.advance(10); await tick();
    loop.advance(10); await tick();

    expect(loop.status()!.result?.outcome).toBe('ARRIVED');
    expect(targets).toEqual([points[1], points[2], points[3]]);
  });
});

describe('WalkRouteExecutor — coordinates, isolation and public entry', () => {
  it('walks consecutive fractional coordinates exactly', async () => {
    const map = new VoxelMap('world');
    const points: Vec3Like[] = [
      { x: 1.3, y: 0, z: 0.5 },
      { x: 2.3, y: 0, z: 0.5 },
      { x: 3.3, y: 0, z: 0.5 },
    ];
    fill(map, STONE, [[1, -1, 0], [2, -1, 0], [3, -1, 0]]);
    fill(map, AIR, [[1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 1, 0], [3, 0, 0], [3, 1, 0]]);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); await tick();
    loop.advance(10); await tick();

    expect(loop.status()!.result?.outcome).toBe('ARRIVED');
    expect(loop.status()!.result?.lastPosition).toEqual({ x: 3.3, y: 0, z: 0.5 });
  });

  it('isolates input and output snapshots from external mutation', () => {
    const map = new VoxelMap('world');
    const pts = openRouteMap(map, 3);
    const request = makeRequest(pts);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(request);
    pts[0] = { x: 999, y: 999, z: 999 };
    request.body.feet.x = 999;

    const status = loop.status()!;
    expect(status.route.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(status.route.body.feet.x).toBe(0.5);

    status.route.points[0] = { x: 1, y: 1, z: 1 };
    expect(loop.status()!.route.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
  });

  it('exposes the execution API from the public entry', () => {
    expect(typeof WalkRouteExecutor).toBe('function');
    const loop = new WalkRouteExecutor(new VoxelMap('world'), new FakeMoveExecutor(), { now: () => 2000 });
    expect(loop.status()).toBeNull();
  });
});

describe('WalkRouteExecutor — re-entrancy and terminal-ordering', () => {
  it('re-checks the deadline after verification before starting a move', () => {
    let clock = 1500;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    let moveCalled = false;
    executor.push((req) => {
      moveCalled = true;
      return { sample: makeSample(req, req.to, { sequence: 2 }) };
    });
    const provider: CollisionShapeProvider = {
      version: 'cross-deadline',
      resolve(state, cell, read) {
        clock = 2500; // cross the 2000 deadline during verification
        return fakeProvider.resolve(state, cell, read);
      },
    };
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    begin(loop, points, { shapeProvider: provider, deadlineMs: 2000 });
    const status = loop.advance(10);

    expect(moveCalled).toBe(false);
    expect(status.result?.outcome).toBe('TIMEOUT');
    expect(status.activeStepIndex).toBeNull();
  });

  it('a re-entrant start during stop does not pollute the new delegation', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0], [1, -1, 0], [10, -1, 0], [11, -1, 0]]);
    fill(map, AIR, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [10, 0, 0], [10, 1, 0], [11, 0, 0], [11, 1, 0]]);
    const pointsA = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const pointsB = [{ x: 10.5, y: 0, z: 0.5 }, { x: 11.5, y: 0, z: 0.5 }];

    const executor = new ReentrantExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.start(makeRequest(pointsB));
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationIdA = begin(loop, pointsA);
    loop.advance(10); // route A step 0 in flight

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationIdA }, pointsA[1]!, { sequence: 2 }));

    const status = loop.status()!;
    expect(status.delegationId).toBe('walk-2');
    expect(status.result).toBeNull(); // route B running, not ARRIVED by route A
    expect(status.nextPointIndex).toBe(1);
    expect(status.lastPosition).toBeNull();
  });

  it('timeout preserves the measured displacement of a trusted sample', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    const delegationId = begin(loop, points, { deadlineMs: 3000 });
    loop.advance(10); // step 0 in flight
    clock = 4000; // past deadline

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, { x: 1.0, y: 0, z: 0.5 }, { observedAt: 2500, sequence: 2 }));

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('TIMEOUT');
    expect(status.result?.lastPosition).toEqual({ x: 1.0, y: 0, z: 0.5 }); // not the old start
  });

  it('a foreign sample does not override an explicit cancel result', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({
      sample: makeSample({ worldId: 'world', dim: 'nether', sessionId: 's1', executionId: 'other-execution' }, { x: 5, y: 0, z: 0.5 }, { sequence: 99 }),
      failure: { kind: 'cancelled' },
    }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    expect(loop.status()!.result?.outcome).toBe('CANCELLED');
  });
});

describe('WalkRouteExecutor — sample admission, terminal writes and ownership', () => {
  it('a duplicate sample still runs the timeout check', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    const delegationId = begin(loop, points, { deadlineMs: 3000 });
    loop.advance(10); // step 0 in flight
    clock = 4000; // past deadline

    // A replayed sample (same sequence as the start sample) must not bypass the deadline.
    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[0]!, { sequence: 1 }));

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('TIMEOUT');
    expect(status.activeStepIndex).toBeNull();
  });

  it('an old observe call reads a freshly invalidated cache on a re-entrant start', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    fill(map, STONE, [[0, -1, 0], [1, -1, 0], [10, -1, 0], [11, -1, 0]]);
    fill(map, AIR, [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [10, 0, 0], [10, 1, 0], [11, 0, 0], [11, 1, 0]]);
    const pointsA = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const pointsB = [{ x: 10.5, y: 0, z: 0.5 }, { x: 11.5, y: 0, z: 0.5 }];

    const executor = new ReentrantExecutor();
    let loop!: WalkRouteExecutor;
    loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    // Verify route B first to populate the cache with an OPEN step.
    begin(loop, pointsB);
    loop.advance(10); // B's step OPEN (cache entry); move stays in-flight

    // Replace B with A.
    begin(loop, pointsA, { deadlineMs: 3000 });
    loop.advance(10); // A's move in flight
    clock = 4000; // past A's deadline

    executor.setOnStop(() => {
      const s = loop.start(makeRequest(pointsB));
      loop.onSample(makeSample({ ...SCOPE, executionId: s.delegationId }, pointsB[0]!, { sequence: 1, observedAt: 4000 }));
      loop.advance(10); // B's re-verification must see the wall, not the stale OPEN
    });

    const report = map.observe(obs(STONE, { x: 10, y: 0, z: 0 }, { observedAt: 3500, sequence: 99 })); // wall at B's target
    loop.observe(report, 10);

    const status = loop.status()!;
    expect(status.delegationId).toBe('walk-3');
    expect(status.activeStepIndex).toBeNull(); // no move scheduled against stale OPEN
    const step = status.route.steps[0]!;
    expect(step.kind === 'verified' && step.result.status).toBe('BLOCKED');
  });

  it('a re-entrant advance during stop does not re-schedule the same step', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new ReentrantExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.advance(1); // re-entrant advance on the same delegation
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); // step 0 in flight

    loop.cancel('agent', 'stop');

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('CANCELLED');
    expect(status.activeStepIndex).toBeNull(); // no orphaned move
  });

  it('a Promise-returned displacement is retained across a synchronous cancel', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new CancelOnStopExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.cancel('agent', 'stop');
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); // step 0 in flight (deferred promise)

    executor.resolve({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, { x: 1.0, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }) });
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('CANCELLED');
    expect(status.result?.lastPosition).toEqual({ x: 1.0, y: 0, z: 0.5 });
    expect(status.result?.lastObservation?.observedAt).toBe(2200);
  });

  it('a cancel in the stop callback is not overwritten by arrival', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new ReentrantExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.cancel('agent', 'stop');
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationId = begin(loop, points);
    loop.advance(10); // step 0 in flight

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, points[1]!, { sequence: 2 }));

    expect(loop.status()!.result?.outcome).toBe('CANCELLED');
  });

  it('a replayed sample with a broken lifecycle does not override a cancel', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({
      sample: makeSample(req, req.to, { sequence: 1, observationReady: false }),
      failure: { kind: 'cancelled' },
    }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);
    await tick();

    expect(loop.status()!.result?.outcome).toBe('CANCELLED');
  });

  it('does not schedule a move when the captured start time meets the deadline', () => {
    let call = 0;
    const now = () => {
      call += 1;
      return call;
    };
    const map = new VoxelMap('world', { now });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    let moveCalled = false;
    executor.push((req) => {
      moveCalled = true;
      return { sample: makeSample(req, req.to, { sequence: 2 }) };
    });
    const loop = new WalkRouteExecutor(map, executor, { now });

    begin(loop, points, { deadlineMs: 9 });
    const status = loop.advance(10);

    expect(moveCalled).toBe(false);
    expect(status.result?.outcome).toBe('TIMEOUT');
  });

  it('lifecycle termination preserves the latest measured position', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const delegationId = begin(loop, points);
    loop.advance(10); // step 0 in flight

    loop.onSample(makeSample({ ...SCOPE, executionId: delegationId }, { x: 1.0, y: 0, z: 0.5 }, { sequence: 2, alive: false }));

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unavailable');
    expect(status.result?.lastPosition).toEqual({ x: 1.0, y: 0, z: 0.5 });
  });
});

describe('WalkRouteExecutor — newer sample and release ordering', () => {
  it('a newer sample received in the stop callback is not overwritten by the old arrival sample', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2); // 0.5 → 1.5
    const executor = new CancelOnStopExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-1' }, { x: 0.5, y: 0, z: 0.5 }, { sequence: 3, observedAt: 2300 }));
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points); // start sample seq 1
    loop.advance(10); // step 0 in flight (deferred)

    executor.resolve({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, { x: 1.5, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }) });
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED'); // not ARRIVED by the stale sample
    expect(status.result?.problem?.kind).toBe('unconfirmed_arrival'); // structured gap, not re-schedulable
    expect(status.nextPointIndex).toBe(1); // not advanced
    expect(status.lastPosition).toEqual({ x: 0.5, y: 0, z: 0.5 }); // newer sample retained
  });

  it('a re-entrant advance during cancel does not report deviation', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new ReentrantExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.advance(1); // re-entrant advance during cancel's stopActive
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10); // step 0 in flight

    loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-1' }, { x: 1.0, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }));

    loop.cancel('agent', 'stop');

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('CANCELLED'); // not FAILED/deviation
    expect(status.result?.lastPosition).toEqual({ x: 1.0, y: 0, z: 0.5 });
  });
});

describe('WalkRouteExecutor — unified completion across release', () => {
  it('a released-time sample at the target yields arrival, not deviation', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new CancelOnStopExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-1' }, { x: 1.5, y: 0, z: 0.5 }, { sequence: 3, observedAt: 2300 }));
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);

    executor.resolve({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, { x: 1.5, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }) });
    await tick();

    expect(loop.status()!.result?.outcome).toBe('ARRIVED');
  });

  it('a released-time correction to the start yields a gap, not a retry', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new CancelOnStopExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-1' }, { x: 0.5, y: 0, z: 0.5 }, { sequence: 3, observedAt: 2300 }));
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);

    executor.resolve({ sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, { x: 1.5, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }) });
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unconfirmed_arrival');
    expect(status.lastPosition).toEqual({ x: 0.5, y: 0, z: 0.5 });

    // A further advance must not silently retry the same step.
    loop.advance(10);
    expect(loop.status()!.activeStepIndex).toBeNull();
    expect(loop.status()!.result?.outcome).toBe('FAILED');
  });

  it('a released-time partial displacement preserves cancel semantics', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new CancelOnStopExecutor();
    let loop!: WalkRouteExecutor;
    executor.setOnStop(() => {
      loop.onSample(makeSample({ ...SCOPE, executionId: 'walk-1' }, { x: 0.5, y: 0, z: 0.5 }, { sequence: 3, observedAt: 2300 }));
    });
    loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    begin(loop, points);
    loop.advance(10);

    executor.resolve({
      sample: makeSample({ ...SCOPE, executionId: 'walk-1-step-0' }, { x: 1.0, y: 0, z: 0.5 }, { sequence: 2, observedAt: 2200 }),
      failure: { kind: 'cancelled' },
    });
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('CANCELLED');
    expect(status.result?.lastPosition).toEqual({ x: 0.5, y: 0, z: 0.5 });
  });
});
