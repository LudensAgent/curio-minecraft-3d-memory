import { describe, expect, it } from 'vitest';

import { FragmentStore, VoxelMap, WalkRouteExecutor, startKnownWalkRoute } from '../src/index.js';
import type {
  BodySample,
  ExecutableMove,
  ExecutableMoveResult,
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  MoveExecutor,
  PathFragment,
  Vec3Like,
  WalkRouteRequest,
} from '../src/index.js';
import { AIR, STONE, bodyAt, fakeProvider, obs } from './fakes.js';

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const NOW = 2000;

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function fragment(overrides: Partial<PathFragment> = {}): PathFragment {
  return {
    id: 'frag-1',
    worldId: 'world',
    dim: 'overworld',
    kind: 'walked',
    entrances: [pt(0, 0, 0)],
    polyline: [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)],
    geometrySource: 'traversal',
    deepestY: 0,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
    ...overrides,
  };
}

/** Real FragmentStore with one fragment (or an empty one when `record` is false). */
function historyWith(overrides: Partial<PathFragment> = {}, worldId = 'world', record = true): FragmentStore {
  const history = new FragmentStore(worldId);
  if (record) history.saveFragment(fragment({ worldId, ...overrides }));
  return history;
}

function knownRequest(overrides: Partial<KnownWalkRouteRequest> = {}): KnownWalkRouteRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    deadlineMs: 100_000,
    timeoutMs: 1000,
    fragmentId: 'frag-1',
    ...overrides,
  };
}

/** Fake single-step executor — NOT a Minecraft body. */
class FakeMoveExecutor implements MoveExecutor {
  readonly stopped: string[] = [];
  readonly requests: ExecutableMove[] = [];
  private queue: Array<(req: ExecutableMove) => ExecutableMoveResult | Promise<ExecutableMoveResult>> = [];
  private seq = 1;

  push(behavior: (req: ExecutableMove) => ExecutableMoveResult | Promise<ExecutableMoveResult>): void {
    this.queue.push(behavior);
  }

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.requests.push(request);
    const behavior = this.queue.shift();
    if (behavior === undefined) {
      return Promise.resolve({ sample: sampleFor(request, request.to, ++this.seq) });
    }
    return Promise.resolve(behavior(request));
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

/** Fake executor whose current move never resolves by itself (control is released via stop/cancel). */
class DeferredMoveExecutor implements MoveExecutor {
  readonly stopped: string[] = [];
  readonly requests: ExecutableMove[] = [];

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.requests.push(request);
    return new Promise<ExecutableMoveResult>(() => {});
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

function sampleFor(request: ExecutableMove, pos: Vec3Like, sequence: number): BodySample {
  return sample(request.executionId, pos, sequence);
}

function sample(executionId: string, pos: Vec3Like, sequence: number, overrides: Partial<BodySample> = {}): BodySample {
  return {
    ...SCOPE,
    executionId,
    sequence,
    pos: { ...pos },
    observedAt: 2100,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    velocity: { x: 0, y: -0.0784, z: 0 },
    ...overrides,
  };
}

function openCells(map: VoxelMap, cells: Array<[number, number]>): void {
  for (const [x, z] of cells) {
    map.observe(obs(STONE, { x, y: -1, z }));
    map.observe(obs(AIR, { x, y: 0, z }));
    map.observe(obs(AIR, { x, y: 1, z }));
  }
}

function openLine(map: VoxelMap): void {
  openCells(map, [[0, 0], [1, 0]]);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An in-flight existing delegation the rejection cases must never disturb. */
function existingDelegation(): {
  loop: WalkRouteExecutor;
  moveExecutor: FakeMoveExecutor;
  before: NonNullable<ReturnType<WalkRouteExecutor['status']>>;
} {
  const map = new VoxelMap('world');
  openCells(map, [[10, 0], [11, 0]]);
  const moveExecutor = new FakeMoveExecutor();
  moveExecutor.push(() => new Promise<ExecutableMoveResult>(() => {})); // stays in flight
  const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });
  const points = [pt(10.5, 0, 0.5), pt(11.5, 0, 0.5)];
  const request: WalkRouteRequest = {
    ...SCOPE,
    mode: 'walk',
    body: bodyAt(10.5, 0, 0.5),
    points,
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    deadlineMs: 100_000,
    timeoutMs: 1000,
  };
  const started = loop.start(request);
  loop.onSample(sample(started.delegationId, points[0]!, 1));
  loop.advance(10);
  return { loop, moveExecutor, before: loop.status()! };
}

describe('startKnownWalkRoute — starts an explicit historical polyline', () => {
  it('walks the exact original ordered polyline to a measured ARRIVED', async () => {
    const points = [pt(1.3, 0, 0.5), pt(2.3, 0, 0.5), pt(2.3, 0, 1.5)];
    const history = historyWith({ polyline: points, geometrySource: 'observed_structure' });
    const snapshotBefore = history.checkpointSnapshot();
    const revisionBefore = history.revision;

    const map = new VoxelMap('world');
    openCells(map, [[1, 0], [2, 0], [2, 1]]);
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const started = startKnownWalkRoute(
      history,
      loop,
      knownRequest({ body: bodyAt(1.3, 0, 0.5), parentActionId: 'parent-7' }),
    );
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    // STARTED is an accepted delegation, not OPEN and not ARRIVED.
    expect(started.status.result).toBeNull();
    expect(started.status.route.verdict).toBe('INCOMPLETE');
    expect(started.route.fragmentId).toBe('frag-1');
    expect(started.route.geometrySource).toBe('observed_structure');
    expect(started.route.kind).toBe('walked');
    expect(started.route.parentActionId).toBe('parent-7');
    expect(started.route.points).toEqual(points);
    expect(started.route.points).not.toBe(points);
    expect(started.route.target).toEqual(points[2]);
    expect(started.route.mode).toBe('walk');
    expect(started.route.arrival).toEqual({ kind: 'exact' });

    loop.onSample(sample(started.status.delegationId, points[0]!, 1));
    loop.advance(10);
    await tick();
    expect(loop.status()!.nextPointIndex).toBe(2);

    loop.advance(10);
    await tick();

    const done = loop.status()!;
    expect(done.result?.outcome).toBe('ARRIVED');
    expect(done.result?.confirmed).toBe(true);
    expect(done.result?.lastPosition).toEqual(points[2]);
    expect(done.result?.trace.map((t) => t.pos)).toEqual([points[1], points[2]]);
    expect(moveExecutor.requests.map((r) => r.to)).toEqual([points[1], points[2]]);

    // Reading and executing geometry never rewrites history or invents traversal facts.
    expect(history.checkpointSnapshot()).toEqual(snapshotBefore);
    expect(history.revision).toBe(revisionBefore);
    expect(history.traversals().total).toBe(0);
  });

  it('accepts more than 1024 points when the caller budget and executor limit allow it', () => {
    const points = Array.from({ length: 1025 }, (_, i) => pt(0.5 + i, 0, 0.5));
    const history = historyWith({ polyline: points });
    const map = new VoxelMap('world');
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => NOW, maxRouteLength: 2048 });

    const started = startKnownWalkRoute(history, loop, knownRequest({ maxRoutePoints: 2048 }));
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    // No truncation: both the seam's snapshot and the executor's own route keep
    // every original point in its original order.
    expect(started.route.points).toHaveLength(1025);
    expect(started.route.points).toEqual(points);
    expect(started.route.target).toEqual(points[1024]);
    expect(started.status.route.points).toHaveLength(1025);
    expect(started.status.route.points).toEqual(points);
  });

  it('isolates the returned snapshot from history and from later caller mutation', () => {
    const points = [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)];
    const history = historyWith({ polyline: points });
    const map = new VoxelMap('world');
    openLine(map);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => NOW });

    const request = knownRequest();
    const started = startKnownWalkRoute(history, loop, request);
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    started.route.points[0]!.x = 999;
    started.route.target.z = 999;
    request.body.feet.x = 777;
    started.status.route.points[0]!.x = 888;

    expect(history.getFragment('frag-1')!.polyline).toEqual(points);
    expect(loop.status()!.route.points[0]).toEqual(points[0]);
    expect(loop.status()!.route.body.feet).toEqual(points[0]);
  });
});

describe('startKnownWalkRoute — history is geometry, not current passability', () => {
  it('does not move or arrive when current evidence is missing', async () => {
    const history = historyWith();
    const map = new VoxelMap('world'); // no observations at all
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const started = startKnownWalkRoute(history, loop, knownRequest());
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    loop.onSample(sample(started.status.delegationId, pt(0.5, 0, 0.5), 1));
    const status = loop.advance(10);
    await tick();

    expect(moveExecutor.requests).toHaveLength(0);
    expect(status.result?.outcome).not.toBe('ARRIVED');
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('unobserved');
  });

  it('does not move through currently blocked evidence', () => {
    const history = historyWith();
    const map = new VoxelMap('world');
    openLine(map);
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const started = startKnownWalkRoute(history, loop, knownRequest());
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    loop.onSample(sample(started.status.delegationId, pt(0.5, 0, 0.5), 1));
    const status = loop.advance(10);

    expect(moveExecutor.requests).toHaveLength(0);
    expect(status.result?.outcome).toBe('BLOCKED');
    expect(status.result?.problem?.kind).toBe('blocked');
  });

  it('does not move on stale evidence', () => {
    let clock = NOW;
    const history = historyWith();
    const map = new VoxelMap('world', { now: () => clock });
    openLine(map);
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => clock });

    const started = startKnownWalkRoute(history, loop, knownRequest());
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    loop.onSample(sample(started.status.delegationId, pt(0.5, 0, 0.5), 1));
    clock = 70_000;
    const status = loop.advance(10);

    expect(moveExecutor.requests).toHaveLength(0);
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result?.problem?.kind).toBe('stale');
  });

  it('accepts legacy/built geometry as geometry without creating traversal facts', async () => {
    const points = [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)];
    const history = historyWith({ kind: 'built', geometrySource: 'legacy', polyline: points });
    const snapshotBefore = history.checkpointSnapshot();
    const revisionBefore = history.revision;
    const map = new VoxelMap('world');
    openLine(map);
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const started = startKnownWalkRoute(history, loop, knownRequest());
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;
    expect(started.route.kind).toBe('built');
    expect(started.route.geometrySource).toBe('legacy');
    expect(started.route.mode).toBe('walk');

    loop.onSample(sample(started.status.delegationId, points[0]!, 1));
    loop.advance(10);
    await tick();
    expect(loop.status()!.result?.outcome).toBe('ARRIVED');

    expect(history.traversals().total).toBe(0);
    expect(history.traversals({ fragmentId: 'frag-1' }).total).toBe(0);
    expect(history.revision).toBe(revisionBefore);
    expect(history.checkpointSnapshot()).toEqual(snapshotBefore);
  });
});

describe('startKnownWalkRoute — deadline and caller-owned control', () => {
  it('preserves the supplied deadline and per-move timeout', () => {
    const history = historyWith();
    const map = new VoxelMap('world');
    openLine(map);
    const loop = new WalkRouteExecutor(map, new FakeMoveExecutor(), { now: () => NOW });

    const started = startKnownWalkRoute(
      history,
      loop,
      knownRequest({ deadlineMs: 50_000, timeoutMs: 2500 }),
    );
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;
    expect(started.status.deadlineMs).toBe(50_000);
    expect(started.status.timeoutMs).toBe(2500);
    expect(started.status.remainingMs).toBe(48_000);
  });

  it('reaches TIMEOUT through the original executor without resetting the deadline', () => {
    let clock = NOW;
    const history = historyWith();
    const map = new VoxelMap('world', { now: () => clock });
    openLine(map);
    const moveExecutor = new DeferredMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => clock });

    const started = startKnownWalkRoute(
      history,
      loop,
      knownRequest({ deadlineMs: 3000, timeoutMs: 500 }),
    );
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    loop.onSample(sample(started.status.delegationId, pt(0.5, 0, 0.5), 1));
    loop.advance(10);
    expect(moveExecutor.requests).toHaveLength(1);
    expect(moveExecutor.requests[0]!.deadlineMs).toBe(3000);
    expect(moveExecutor.requests[0]!.timeoutMs).toBe(500);

    clock = 4000;
    const status = loop.checkTimeout();
    expect(status.result?.outcome).toBe('TIMEOUT');
  });

  it('preserves caller cancellation and partial measured effects', () => {
    const history = historyWith();
    const map = new VoxelMap('world');
    openLine(map);
    const moveExecutor = new DeferredMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const started = startKnownWalkRoute(history, loop, knownRequest());
    expect(started.kind).toBe('STARTED');
    if (started.kind !== 'STARTED') return;

    loop.onSample(sample(started.status.delegationId, pt(0.5, 0, 0.5), 1));
    loop.advance(10);
    expect(moveExecutor.requests).toHaveLength(1);

    const partial = pt(1.0, 0, 0.5);
    loop.onSample(sample(started.status.delegationId, partial, 2, { observedAt: 2200 }));

    const result = loop.cancel('agent', 'stop');
    expect(result.outcome).toBe('CANCELLED');
    expect(result.lastPosition).toEqual(partial);
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'agent' });
    expect(moveExecutor.stopped).toEqual([moveExecutor.requests[0]!.executionId]);
    expect(moveExecutor.requests[0]!.signal.aborted).toBe(true);
  });
});

describe('startKnownWalkRoute — pre-start rejection leaves the active delegation untouched', () => {
  const tooManyByDefault = Array.from({ length: 1025 }, (_, i) => pt(0.5 + i, 0, 0.5));

  const cases: Array<{
    name: string;
    reason: KnownWalkRouteRejectionReason;
    fragmentOverrides?: Partial<PathFragment>;
    record?: boolean;
    requestOverrides?: Partial<KnownWalkRouteRequest>;
  }> = [
    {
      name: 'missing fragment',
      reason: 'missing_history',
      requestOverrides: { fragmentId: 'absent' },
    },
    {
      name: 'request/history world mismatch',
      reason: 'wrong_scope',
      requestOverrides: { worldId: 'another-world' },
    },
    {
      name: 'fragment dimension mismatch',
      reason: 'wrong_scope',
      fragmentOverrides: { dim: 'nether' },
    },
    {
      name: 'non-walk mode',
      reason: 'unsupported_mode',
      requestOverrides: { mode: 'jump' },
    },
    {
      name: 'non-exact arrival',
      reason: 'unsupported_arrival',
      requestOverrides: { arrival: { kind: 'near', radius: 2 } },
    },
    {
      name: 'non-empty avoid constraint',
      reason: 'unsupported_constraint',
      requestOverrides: { constraints: { avoid: [pt(1, 0, 0)] } },
    },
    {
      name: 'wrong origin',
      reason: 'wrong_start',
      requestOverrides: { body: bodyAt(0.6, 0, 0.5) },
    },
    {
      name: 'too few points',
      reason: 'unsupported_geometry',
      fragmentOverrides: { polyline: [pt(0.5, 0, 0.5)] },
    },
    {
      name: 'sparse segment',
      reason: 'unsupported_geometry',
      fragmentOverrides: { polyline: [pt(0.5, 0, 0.5), pt(2.5, 0, 0.5)] },
    },
    {
      name: 'diagonal segment',
      reason: 'unsupported_geometry',
      fragmentOverrides: { polyline: [pt(0.5, 0, 0.5), pt(1.5, 0, 1.5)] },
    },
    {
      name: 'height-changing segment',
      reason: 'unsupported_geometry',
      fragmentOverrides: { polyline: [pt(0.5, 0, 0.5), pt(0.5, 1, 0.5)] },
    },
    {
      name: 'duplicate segment',
      reason: 'unsupported_geometry',
      fragmentOverrides: { polyline: [pt(0.5, 0, 0.5), pt(0.5, 0, 0.5)] },
    },
    {
      name: 'route exceeding an explicit budget',
      reason: 'route_budget',
      fragmentOverrides: {
        polyline: [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5), pt(2.5, 0, 0.5), pt(3.5, 0, 0.5)],
      },
      requestOverrides: { maxRoutePoints: 3 },
    },
    {
      name: 'route exceeding the default budget',
      reason: 'route_budget',
      fragmentOverrides: { polyline: tooManyByDefault },
    },
    {
      name: 'fractional route budget',
      reason: 'route_budget',
      requestOverrides: { maxRoutePoints: 2.5 },
    },
  ];

  it.each(cases)('$name', ({ reason, fragmentOverrides, record, requestOverrides }) => {
    const history = historyWith(fragmentOverrides ?? {}, 'world', record ?? true);
    const { loop, moveExecutor, before } = existingDelegation();

    const result = startKnownWalkRoute(history, loop, knownRequest(requestOverrides));

    expect(result.kind).toBe('REJECTED');
    if (result.kind !== 'REJECTED') return;
    expect(result.reason).toBe(reason);
    expect(result.message.length).toBeGreaterThan(0);

    const after = loop.status()!;
    expect(after.delegationId).toBe(before.delegationId);
    expect(after.nextPointIndex).toBe(before.nextPointIndex);
    expect(after.activeStepIndex).toBe(before.activeStepIndex);
    expect(after.result).toBeNull();
    expect(moveExecutor.stopped).toEqual([]);
    expect(moveExecutor.requests).toHaveLength(1); // only the pre-existing move
  });

  it('a wrong origin never silently attaches to the historical route', () => {
    const history = historyWith({ polyline: [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)] });
    const map = new VoxelMap('world');
    openLine(map);
    const moveExecutor = new FakeMoveExecutor();
    const loop = new WalkRouteExecutor(map, moveExecutor, { now: () => NOW });

    const result = startKnownWalkRoute(history, loop, knownRequest({ body: bodyAt(1.5, 0, 0.5) }));

    expect(result).toMatchObject({ kind: 'REJECTED', reason: 'wrong_start' });
    expect(loop.status()).toBeNull(); // no delegation was started at all
    expect(moveExecutor.requests).toHaveLength(0);
    expect(history.revision).toBe(1); // only the original save
  });
});
