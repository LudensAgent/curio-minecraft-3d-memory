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

  push(behavior: (req: ExecutableMove) => ExecutableMoveResult | Promise<ExecutableMoveResult>): void {
    this.queue.push(behavior);
  }

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    const behavior = this.queue.shift();
    if (behavior === undefined) {
      // Default: immediately confirm arrival at the target.
      return Promise.resolve({ sample: makeSample(request, request.to) });
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

function makeSample(
  scope: { worldId: string; dim: string; sessionId: string },
  pos: Vec3Like,
  overrides: Partial<BodySample> = {},
): BodySample {
  return {
    worldId: scope.worldId,
    dim: scope.dim,
    sessionId: scope.sessionId,
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WalkRouteExecutor — controlled step-by-step execution', () => {
  it('walks a route one step at a time and only arrives on a measured target', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3); // 2 steps
    const executor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    const start = loop.start(makeRequest(points));
    expect(start.result).toBeNull();
    expect(start.nextPointIndex).toBe(1);

    const first = loop.advance(10);
    expect(first.activeStepIndex).toBe(0);
    expect(first.result).toBeNull(); // route OPEN alone is not arrival

    await tick(); // move resolves and confirms step 0
    expect(loop.status()!.nextPointIndex).toBe(2);
    expect(loop.status()!.result).toBeNull(); // still not arrived

    const second = loop.advance(10);
    expect(second.activeStepIndex).toBe(1);

    await tick();
    const done = loop.status()!;
    expect(done.result?.outcome).toBe('ARRIVED');
    expect(done.result?.confirmed).toBe(true);
    expect(done.result?.lastPosition).toEqual(points[2]);
    expect(done.result?.lastObservation).toMatchObject({ worldId: 'world', dim: 'overworld', sessionId: 's1', onGround: true, inWater: false });
  });

  it('does not arrive when the move resolves but the body did not reach the target', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2); // 1 step
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, points[0]!) })); // body stayed put
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10);
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('deviation');
  });

  it('does not arrive at the wrong height', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push((req) => ({ sample: makeSample(req, { ...points[1]!, y: points[1]!.y + 1 }) }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10);
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('deviation');
  });

  it('an old (pre-execution) body snapshot does not produce arrival', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    // The executor hands back a stale pre-move snapshot rather than a fresh measure.
    executor.push((req) => ({ sample: makeSample(req, points[0]!, { observedAt: 1000 }) }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10);
    await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('deviation');
  });

  it('keeps a real arrival after a non-cancel move failure', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2); // 1 step
    const executor = new FakeMoveExecutor();
    let rejectMove!: (e: unknown) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((_resolve, reject) => { rejectMove = reject; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10); // step 0 in flight

    // The host measures the body at the target before the move rejects.
    loop.onSample(makeSample(SCOPE, points[1]!));
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');

    // The move then fails (non-cancel): the arrival must survive.
    rejectMove(new Error('executor crashed'));
    await tick();
    const status = loop.status()!;
    expect(status.result?.outcome).toBe('ARRIVED');
    expect(status.result?.confirmed).toBe(true);
  });
});

describe('WalkRouteExecutor — never starts an unpassable segment', () => {
  it('does not start a blocked step', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 })); // wall in step 0's sweep
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(makeRequest(points));
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.outcome).toBe('BLOCKED');
    expect(status.result?.problem?.kind).toBe('blocked');
  });

  it('does not start an unobserved (unknown) step', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ]); // destination support (1,-1,0) never observed
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(makeRequest([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
    ]));
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unobserved');
  });

  it('does not start a stale step', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    loop.start(makeRequest(points));
    clock = 70_000; // past observedAt 1000 + 60_000 window
    const status = loop.advance(10);

    expect(status.activeStepIndex).toBeNull();
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('stale');
  });

  it('does not start an unverified step and does not report no-path', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4); // 3 steps
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10); await tick(); // confirm step 0
    loop.advance(10); await tick(); // confirm step 1 → nextPointIndex = 3

    // Invalidate the whole section: every step depends on cx = 0.
    const report = map.observe(obs(STONE, { x: 0, y: 0, z: 0 }, { observedAt: 1500, sequence: 99 }));
    loop.observe(report, 1); // re-verify only step 0; steps 1, 2 stay pending
    loop.advance(1); // re-verify step 1; step 2 still pending

    const status = loop.status()!;
    expect(status.activeStepIndex).toBeNull(); // not started
    expect(status.result).toBeNull(); // waiting, not a no-path
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

    loop.start(makeRequest(points));
    loop.advance(10); // step 0 in flight
    expect(loop.status()!.activeStepIndex).toBe(0);

    const report = map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const status = loop.observe(report, 10);

    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('route_invalidated');
    expect(status.activeStepIndex).toBeNull();
    expect(executor.stopped).toContain('walk-1-0');

    resolveMove({ sample: makeSample(SCOPE, points[1]!) }); // late resolve is ignored
    await tick();
    expect(loop.status()!.result?.problem?.kind).toBe('route_invalidated');
  });

  it('does not interrupt on an unrelated change', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10); // step 0 in flight

    const report = map.observe(obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const status = loop.observe(report, 10);

    expect(status.result).toBeNull();
    expect(status.activeStepIndex).toBe(0);
  });

  it('TTL expiry revokes the in-flight step without a new observation', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const executor = new FakeMoveExecutor();
    executor.push(() => new Promise<ExecutableMoveResult>(() => {}));
    const loop = new WalkRouteExecutor(map, executor, { now: () => clock });

    loop.start(makeRequest(points));
    loop.advance(10); // step 0 in flight
    expect(loop.status()!.activeStepIndex).toBe(0);

    clock = 70_000;
    const status = loop.advance(10);
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('stale');
    expect(status.activeStepIndex).toBeNull();
  });

  it('a rule-version change revokes the in-flight step', () => {
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

    loop.start(makeRequest(points, { shapeProvider: provider }));
    loop.advance(10); // step 0 OPEN, in flight

    provider.version = 'v2';
    provider.resolve = () => ({ kind: 'shape', shape: { boxes: [], supportFaces: [] } });
    const status = loop.advance(10);

    expect(status.result?.outcome).toBe('BLOCKED'); // new rules remove support
    expect(status.activeStepIndex).toBeNull();
  });
});

describe('WalkRouteExecutor — cancel, timeout and ownership', () => {
  it('cancel preserves confirmed partial displacement', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(makeRequest(points));
    loop.advance(10); await tick(); // confirm step 0

    const result = loop.cancel('agent', 'stop');
    expect(result.outcome).toBe('CANCELLED');
    expect(result.lastPosition).toEqual(points[1]); // partial displacement preserved
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'agent' });
  });

  it('timeout preserves the last confirmed position', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    loop.start(makeRequest(points, { deadlineMs: 50_000 }));
    loop.advance(10); await tick(); // confirm step 0

    clock = 60_000; // past deadline
    const status = loop.checkTimeout();
    expect(status.result?.outcome).toBe('TIMEOUT');
    expect(status.result?.lastPosition).toEqual(points[1]);
  });

  it('step-by-step advance does not reset the original deadline', async () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 3);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => clock });

    loop.start(makeRequest(points, { deadlineMs: 50_000 }));
    expect(loop.status()!.deadlineMs).toBe(50_000);

    loop.advance(10); await tick();
    clock = 3000;
    const status = loop.status()!;
    expect(status.deadlineMs).toBe(50_000); // unchanged
    expect(status.remainingMs).toBe(47_000);
  });

  it('a late result from a replaced delegation is ignored', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const executor = new FakeMoveExecutor();
    let resolveOld!: (r: ExecutableMoveResult) => void;
    executor.push(() => new Promise<ExecutableMoveResult>((resolve) => { resolveOld = resolve; }));
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points)); // generation 1
    loop.advance(10); // step 0 in flight (deferred)

    loop.start(makeRequest(points)); // generation 2; stops + orphans gen 1
    loop.advance(10); await tick(); // gen 2 confirms step 0 (default executor)
    expect(loop.status()!.nextPointIndex).toBe(2);

    resolveOld({ sample: makeSample(SCOPE, points[1]!) }); // gen 1 late callback
    await tick();

    expect(loop.status()!.nextPointIndex).toBe(2); // unchanged
    expect(loop.status()!.result).toBeNull(); // still running
  });
});

describe('WalkRouteExecutor — explicit rejection of unsupported requests', () => {
  it('rejects a non-walk mode', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { mode: 'jump' }));
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unsupported_mode');
  });

  it('rejects a non-exact arrival', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { arrival: { kind: 'near', radius: 2 } }));
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unsupported_target');
  });

  it('rejects a non-empty avoid constraint', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    const status = loop.start(makeRequest(points, { constraints: { avoid: [{ x: 1, y: 0, z: 0 }] } }));
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('not_authorized');
  });

  it('executes only the authorized ordered points, never dig/place/target changes', async () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4); // 3 steps
    const executor = new FakeMoveExecutor();
    const targets: Vec3Like[] = [];
    for (let i = 0; i < 3; i++) {
      executor.push((req) => {
        targets.push({ ...req.to });
        return { sample: makeSample(req, req.to) };
      });
    }
    const loop = new WalkRouteExecutor(map, executor, { now: () => 2000 });

    loop.start(makeRequest(points));
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

    loop.start(makeRequest(points));
    loop.advance(10); await tick();
    loop.advance(10); await tick();

    const status = loop.status()!;
    expect(status.result?.outcome).toBe('ARRIVED');
    expect(status.result?.lastPosition).toEqual({ x: 3.3, y: 0, z: 0.5 });
  });

  it('isolates input and output snapshots from external mutation', () => {
    const map = new VoxelMap('world');
    const pts = openRouteMap(map, 3);
    const request = makeRequest(pts);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => 2000 });

    loop.start(request);
    pts[0] = { x: 999, y: 999, z: 999 }; // mutate caller-owned input
    request.body.feet.x = 999;

    const status = loop.status()!;
    expect(status.route.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(status.route.body.feet.x).toBe(0.5);

    status.route.points[0] = { x: 1, y: 1, z: 1 }; // mutate the returned snapshot
    const again = loop.status()!;
    expect(again.route.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
  });

  it('exposes the execution API from the public entry', () => {
    expect(typeof WalkRouteExecutor).toBe('function');
    const loop = new WalkRouteExecutor(new VoxelMap('world'), new FakeMoveExecutor(), { now: () => 2000 });
    expect(loop.status()).toBeNull();
  });
});
