import { describe, expect, it } from 'vitest';

import { FragmentStore, VoxelMap, WalkRouteExecutor, WalkRouteSearch } from '../src/index.js';
import {
  frontierCandidates,
  followKnownPath,
  inspectKnownRoute,
  navigateTo,
} from '../src/navigation/index.js';
import type {
  BodySample,
  BlockState,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  NavigateRequest,
  PathFragment,
  TraversalEvidence,
  Vec3Like,
} from '../src/index.js';
import type {
  FollowKnownPathEnvironment,
  FollowKnownPathOutcome,
  NavigateEnvironment,
  NavigateSearchSource,
} from '../src/navigation/index.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const NOW = 2000;

function pt(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function openCells(map: VoxelMap, cells: Array<[number, number]>, y = 0): void {
  for (const [x, z] of cells) {
    map.observe(obs(STONE, { x, y: y - 1, z }));
    map.observe(obs(AIR, { x, y, z }));
    map.observe(obs(AIR, { x, y: y + 1, z }));
  }
}

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function sampleAt(pos: Vec3Like, executionId: string, sequence: number, observedAt = NOW + sequence): BodySample {
  return {
    ...SCOPE,
    executionId,
    sequence,
    pos: { ...pos },
    observedAt,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    velocity: { x: 0, y: -0.0784, z: 0 },
  };
}

function measuredSample(pos: Vec3Like, observedAt = NOW + 1): BodySample {
  return sampleAt(pos, 'external-sample', 0, observedAt);
}

class TrackingMoveExecutor implements MoveExecutor {
  readonly requests: ExecutableMove[] = [];
  readonly stopped: string[] = [];
  private readonly measured: { current: BodySample | null };
  private readonly deferredAfter: number | undefined;
  private seq = 1;

  constructor(measured: { current: BodySample | null }, deferredAfter?: number) {
    this.measured = measured;
    this.deferredAfter = deferredAfter;
  }

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.requests.push(request);
    if (this.deferredAfter !== undefined && this.requests.length > this.deferredAfter) {
      return new Promise<ExecutableMoveResult>(() => {});
    }
    this.seq += 1;
    const sample = sampleAt(request.to, request.executionId, this.seq, NOW + this.seq);
    if (this.measured.current !== null) {
      this.measured.current = { ...this.measured.current, pos: { ...request.to }, observedAt: sample.observedAt };
    }
    return Promise.resolve({ sample });
  }

  stop(executionId: string): void {
    this.stopped.push(executionId);
  }
}

interface Harness {
  map: VoxelMap;
  move: MoveExecutor;
  search: WalkRouteSearch;
  executor: WalkRouteExecutor;
  measured: { current: BodySample | null };
  env: NavigateEnvironment;
}

function makeHarness(options: {
  map?: VoxelMap;
  measured?: BodySample;
  clock?: () => number;
  move?: MoveExecutor;
  searchSource?: NavigateSearchSource;
  timeoutMs?: number;
  moveTimeoutMs?: number;
  deadlineMs?: number;
  budget?: number;
  wait?: () => Promise<void>;
  segments?: NavigateEnvironment['segments'];
  signal?: AbortSignal;
  sample?: () => BodySample | null;
} = {}): Harness {
  const map = options.map ?? new VoxelMap('world');
  const clock = options.clock ?? (() => NOW);
  const measured = { current: options.measured ?? measuredSample(pt(0.5, 0, 0.5)) };
  const move = options.move ?? new TrackingMoveExecutor(measured);
  const search = new WalkRouteSearch(map, { now: clock });
  const executor = new WalkRouteExecutor(map, move, { now: clock });
  const env: NavigateEnvironment = {
    ...SCOPE,
    body: bodyAt(0.5, 0, 0.5),
    shapeProvider: fakeProvider,
    sample: options.sample ?? (() => measured.current),
    search: options.searchSource ?? { kind: 'search', search },
    executor,
    now: clock,
    timeoutMs: options.timeoutMs ?? 100_000,
    moveTimeoutMs: options.moveTimeoutMs ?? 50_000,
    budget: options.budget ?? 64,
    wait: options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.segments === undefined ? {} : { segments: options.segments }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return { map, move, search, executor, measured, env };
}

function navigateRequest(overrides: Partial<NavigateRequest> = {}): NavigateRequest {
  return {
    destination: pt(2.5, 0, 0.5),
    arrival: { kind: 'exact' },
    allowedModes: ['walk'],
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
    ...overrides,
  };
}

function drainSearch(search: WalkRouteSearch, budget = 1000) {
  let snapshot = search.status();
  if (snapshot === null) throw new Error('expected a started search');
  for (let i = 0; i < 10_000 && snapshot.state === 'PENDING'; i++) snapshot = search.advance(budget);
  return snapshot;
}

describe('navigateTo — integrated measured pipeline', () => {
  it('returns ARRIVED only from a measured executor confirmation and records the delegation', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
    });
    let written: 'saved' | 'pending' | 'failed' | undefined;
    let captured: import('../src/index.js').ActionRecord | null = null;
    harness.env.delegationId = 'deleg-7';
    harness.env.parentActionId = 'parent-7';
    harness.env.onMemoryWrite = (result, record) => {
      captured = record;
      written = result.outcome === 'ARRIVED' ? 'saved' : undefined;
      return written;
    };

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    if (result.outcome !== 'ARRIVED') throw new Error('expected ARRIVED');
    expect(result.lastPosition).toEqual(pt(2.5, 0, 0.5));
    expect(result.lastObservation).toMatchObject({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      onGround: true,
      inWater: false,
    });
    expect(result.lastObservation.observedAt).toBeGreaterThan(NOW);
    expect(result.trace.map((entry) => entry.pos)).toEqual([pt(1.5, 0, 0.5), pt(2.5, 0, 0.5)]);
    expect(result.consumption).toEqual({ placed: [] });
    expect(result.memoryWrite).toBe('saved');
    expect(move.requests.map((request) => request.to)).toEqual([pt(1.5, 0, 0.5), pt(2.5, 0, 0.5)]);

    expect(captured).not.toBeNull();
    const action = captured!;
    expect(action).toMatchObject({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      delegationId: 'deleg-7',
      parentActionId: 'parent-7',
      confirmed: true,
      from: pt(0.5, 0, 0.5),
      to: pt(2.5, 0, 0.5),
    });
    expect(action.delegation.requestedTarget).toEqual(pt(2.5, 0, 0.5));
    expect(action.delegation.target).toEqual(pt(2.5, 0, 0.5));
    expect(action.delegation.allowedModes).toEqual(['walk']);
    expect(action.delegation.arrival).toEqual({ kind: 'exact' });
    expect(action.delegation.allowDigging).toBe(false);
    expect(action.delegation.allowPlacing).toBe(false);
    expect(action.delegation.allowTower).toBe(false);
    expect(action.delegation.materials).toEqual([]);
    expect(action.delegation.exploration).toBe('known_only');
    expect(action.subActions).toHaveLength(2);
    expect(action.subActions).toEqual([
      { kind: 'walk', at: pt(1.5, 0, 0.5), origin: 'execution_helper', targetRole: 'body', outcome: 'ok' },
      { kind: 'walk', at: pt(2.5, 0, 0.5), origin: 'execution_helper', targetRole: 'body', outcome: 'ok' },
    ]);
    expect(action.trace.map((entry) => entry.pos)).toEqual(result.trace.map((entry) => entry.pos));
    expect(action.consumption).toEqual({ placed: [] });
    expect(action.observedChanges).toEqual([]);
    expect(action.failureAt).toBeUndefined();
    expect(action.failureReason).toBeUndefined();
    expect(action.result).toBe(result);
    expect(record).toBe(captured);
  });

  it('accepts a measured start older than executor.start after a bounded search (real clock)', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    let clock = NOW;
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      clock: () => {
        clock += 10;
        return clock;
      },
    });

    const { result } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.lastPosition).toEqual(pt(2.5, 0, 0.5));
  });

  it('does not report ARRIVED or start the executor when the delegation is already aborted', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const measured = { current: measuredSample(pt(2.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const controller = new AbortController();
    controller.abort('user stopped');
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      signal: controller.signal,
    });

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(result.lastPosition).toEqual(pt(2.5, 0, 0.5));
    expect(move.requests).toEqual([]);
    expect(record?.result).toBe(result);
  });

  it('returns ARRIVED from an already-measured exact target without starting a search or a route', async () => {
    const measured = { current: measuredSample(pt(2.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const harness = makeHarness({
      measured: measured.current,
      sample: () => measured.current,
      move,
    });
    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    if (result.outcome !== 'ARRIVED') throw new Error('expected ARRIVED');
    expect(result.lastPosition).toEqual(pt(2.5, 0, 0.5));
    expect(result.trace).toEqual([]);
    expect(result.consumption).toEqual({ placed: [] });
    expect(harness.search.status()).toBeNull();
    expect(harness.executor.status()).toBeNull();
    expect(move.requests).toEqual([]);
    expect(record!.confirmed).toBe(true);
    expect(record!.subActions).toEqual([]);
    expect(record!.trace).toEqual([]);
  });

  it('does not report ARRIVED when the move sample does not reach the target', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move: MoveExecutor = {
      move(request) {
        return Promise.resolve({ sample: sampleAt(request.from, request.executionId, 2, NOW + 2) });
      },
      stop() {},
    };
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
    });

    const { result } = await navigateTo(
      navigateRequest({ destination: pt(1.5, 0, 0.5) }),
      harness.env,
    );

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind).toBe('deviation');
  });

  it('maps a no-verified-path search to NO_PATH without claiming world unreachability', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0]]);
    fill(map, STONE, [
      [1, 0, 0], [1, 1, 0], [-1, 0, 0], [-1, 1, 0],
      [0, 0, 1], [0, 1, 1], [0, 0, -1], [0, 1, -1],
    ]);
    const harness = makeHarness({ map, measured: measuredSample(pt(0.5, 0, 0.5)) });

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('NO_PATH');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toEqual({ kind: 'no_path' });
    expect(result.lastPosition).toEqual(pt(0.5, 0, 0.5));
    expect(result.lastObservation).toBeDefined();
    expect(harness.executor.status()).toBeNull();
    expect(record!.confirmed).toBe(false);
    expect(record!.failureAt).toBeUndefined();
    expect(record!.failureReason).toContain('no walk route');
  });

  it('maps a blocked executor step to BLOCKED with measured evidence', async () => {
    // A separate, open map produced the candidate; execution happens on a map
    // whose next step is blocked. The candidate alone is never arrival.
    const sourceMap = new VoxelMap('world');
    openCells(sourceMap, [[0, 0], [1, 0]]);
    const sourceSearch = new WalkRouteSearch(sourceMap, { now: () => NOW });
    sourceSearch.start({
      ...SCOPE,
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      target: pt(1.5, 0, 0.5),
      arrival: { kind: 'exact' },
      shapeProvider: fakeProvider,
    });
    const snapshot = drainSearch(sourceSearch);
    expect(snapshot.state).toBe('FOUND');

    const blockedMap = new VoxelMap('world');
    openCells(blockedMap, [[0, 0]]);
    blockCell(blockedMap, 1, 0, 0);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const harness = makeHarness({
      map: blockedMap,
      measured: measured.current,
      sample: () => measured.current,
      move,
      searchSource: { kind: 'snapshot', snapshot },
    });

    const { result, record } = await navigateTo(
      navigateRequest({ destination: pt(1.5, 0, 0.5) }),
      harness.env,
    );

    expect(result.outcome).toBe('BLOCKED');
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind === 'blocked' || result.problem?.kind === 'head_blocked').toBe(true);
    expect(result.lastPosition).toEqual(pt(0.5, 0, 0.5));
    expect(record!.confirmed).toBe(false);
    expect(record!.failureAt).toEqual(pt(0.5, 0, 0.5));
    expect(move.requests).toEqual([]);
  });

  it('rejects unsupported requests with structured problems and starts nothing', async () => {
    const cases: Array<{ name: string; request: NavigateRequest; kind: string }> = [
      {
        name: 'near arrival',
        request: navigateRequest({ arrival: { kind: 'near', radius: 1 } }),
        kind: 'unsupported_target',
      },
      {
        name: 'non-walk mode',
        request: navigateRequest({ allowedModes: ['walk', 'jump'] }),
        kind: 'unsupported_mode',
      },
      {
        name: 'digging',
        request: navigateRequest({ allowDigging: true }),
        kind: 'not_authorized',
      },
      {
        name: 'placing',
        request: navigateRequest({ allowPlacing: true }),
        kind: 'not_authorized',
      },
      {
        name: 'towering',
        request: navigateRequest({ allowTower: true }),
        kind: 'not_authorized',
      },
      {
        name: 'materials',
        request: navigateRequest({ materials: [{ name: 'minecraft:dirt', maxCount: 4 }] }),
        kind: 'not_authorized',
      },
      {
        name: 'frontier exploration',
        request: navigateRequest({ exploration: 'allow_frontier' }),
        kind: 'not_authorized',
      },
      {
        name: 'avoid constraint',
        request: navigateRequest({ constraints: { avoid: [pt(1, 0, 0)] } }),
        kind: 'not_authorized',
      },
      {
        name: 'unknown field',
        request: { ...navigateRequest(), surprise: true } as NavigateRequest,
        kind: 'invalid_request',
      },
    ];

    for (const testCase of cases) {
      const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
      const move = new TrackingMoveExecutor(measured);
      const harness = makeHarness({ measured: measured.current, sample: () => measured.current, move });
      const { result, record } = await navigateTo(testCase.request, harness.env);
      expect(result.outcome, testCase.name).toBe('FAILED');
      expect(result.confirmed, testCase.name).toBe(false);
      expect(result.problem?.kind, testCase.name).toBe(testCase.kind);
      expect(record, testCase.name).toBeNull();
      expect(harness.executor.status(), testCase.name).toBeNull();
      expect(harness.search.status(), testCase.name).toBeNull();
      expect(move.requests, testCase.name).toEqual([]);
    }
  });

  it('preserves measured displacement on cancellation and reports CANCELLED, not PARTIAL', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured, 1);
    const controller = new AbortController();
    let waits = 0;
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      signal: controller.signal,
      wait: async () => {
        waits += 1;
        if (waits === 3) controller.abort('agent requested stop');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind).toBe('cancelled');
    expect(result.lastPosition).toEqual(pt(1.5, 0, 0.5));
    expect(result.trace.map((entry) => entry.pos)).toEqual([pt(1.5, 0, 0.5)]);
    expect(record!.confirmed).toBe(false);
    expect(record!.to).toEqual(pt(1.5, 0, 0.5));
    expect(record!.failureAt).toEqual(pt(1.5, 0, 0.5));
    expect(move.stopped.length).toBeGreaterThan(0);
  });

  it('preserves measured displacement on timeout and reports TIMEOUT, not PARTIAL', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const clock = { value: NOW };
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured, 1);
    let waits = 0;
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      clock: () => clock.value,
      timeoutMs: 5000,
      moveTimeoutMs: 5000,
      wait: async () => {
        waits += 1;
        if (waits === 2) clock.value = NOW + 10_000;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toEqual({ kind: 'timeout' });
    expect(result.lastPosition).toEqual(pt(1.5, 0, 0.5));
    expect(result.trace.map((entry) => entry.pos)).toEqual([pt(1.5, 0, 0.5)]);
    expect(record!.confirmed).toBe(false);
    expect(record!.failureAt).toEqual(pt(1.5, 0, 0.5));
  });

  it('reports PARTIAL only when a later explicit segment fails after an earlier one completed', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    fill(map, STONE, [
      [-1, 0, 0], [-1, 1, 0], [0, 0, 1], [0, 1, 1], [0, 0, -1], [0, 1, -1],
      [1, 0, 1], [1, 1, 1], [1, 0, -1], [1, 1, -1], [2, 0, 0], [2, 1, 0],
    ]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      segments: [
        { destination: pt(1.5, 0, 0.5), arrival: { kind: 'exact' } },
        { destination: pt(4.5, 0, 0.5), arrival: { kind: 'exact' } },
      ],
    });

    const { result, record } = await navigateTo(
      navigateRequest({ destination: pt(4.5, 0, 0.5) }),
      harness.env,
    );

    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toEqual({ kind: 'no_path' });
    expect(result.message).toContain('1 of 2');
    expect(result.lastPosition).toEqual(pt(1.5, 0, 0.5));
    expect(result.trace.map((entry) => entry.pos)).toEqual([pt(1.5, 0, 0.5)]);
    expect(record!.confirmed).toBe(false);
    expect(record!.delegation.target).toEqual(pt(4.5, 0, 0.5));
    expect(record!.failureAt).toEqual(pt(1.5, 0, 0.5));
    expect(record!.subActions).toHaveLength(1);
    expect(move.requests.map((request) => request.to)).toEqual([pt(1.5, 0, 0.5)]);
  });

  it('keeps the combined measured trace when every explicit segment ARRIVES', async () => {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0], [2, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const harness = makeHarness({
      map,
      measured: measured.current,
      sample: () => measured.current,
      move,
      segments: [
        { destination: pt(1.5, 0, 0.5), arrival: { kind: 'exact' } },
        { destination: pt(2.5, 0, 0.5), arrival: { kind: 'exact' } },
      ],
    });

    const { result, record } = await navigateTo(navigateRequest(), harness.env);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.trace.map((entry) => entry.pos)).toEqual([
      pt(1.5, 0, 0.5),
      pt(2.5, 0, 0.5),
    ]);
    expect(record!.confirmed).toBe(true);
    expect(record!.trace.map((entry) => entry.pos)).toEqual([
      pt(1.5, 0, 0.5),
      pt(2.5, 0, 0.5),
    ]);
    expect(move.requests.map((request) => request.to)).toEqual([
      pt(1.5, 0, 0.5),
      pt(2.5, 0, 0.5),
    ]);
  });

  it('fails safely without a measured start and never invents a record position', async () => {
    const harness = makeHarness({ sample: () => null });
    const { result, record } = await navigateTo(navigateRequest(), harness.env);
    expect(result.outcome).toBe('FAILED');
    expect(result.problem?.kind).toBe('unavailable');
    expect(result.lastPosition).toBeUndefined();
    expect(record).toBeNull();
  });
});

function blockCell(map: VoxelMap, x: number, y: number, z: number): void {
  map.observe(obs(STONE, { x, y, z }));
  map.observe(obs(STONE, { x, y: y + 1, z }));
}

describe('followKnownPath and inspectKnownRoute', () => {
  function historyWithFragment(): FragmentStore {
    const history = new FragmentStore('world');
    history.saveFragment(fragment());
    return history;
  }

  function fragment(overrides: Partial<PathFragment> = {}): PathFragment {
    return {
      id: 'frag-1',
      worldId: 'world',
      dim: 'overworld',
      kind: 'walked',
      entrances: [pt(0.5, 0, 0.5)],
      polyline: [pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)],
      geometrySource: 'traversal',
      links: [{ a: pt(0.5, 0, 0.5), b: pt(1.5, 0, 0.5) }],
      deepestY: 0,
      createdAt: 1000,
      lastUsedAt: 1200,
      uses: 3,
      ...overrides,
    };
  }

  function followEnv(
    history: FragmentStore,
    map: VoxelMap,
    measured: { current: BodySample | null },
    move: TrackingMoveExecutor,
    overrides: Partial<FollowKnownPathEnvironment> = {},
  ): FollowKnownPathEnvironment {
    const clock = () => NOW;
    const executor = new WalkRouteExecutor(map, move, { now: clock });
    return {
      history,
      executor,
      ...SCOPE,
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      sample: () => measured.current,
      now: clock,
      timeoutMs: 100_000,
      moveTimeoutMs: 50_000,
      budget: 64,
      wait: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ...overrides,
    };
  }

  function rejected(outcome: FollowKnownPathOutcome): Extract<FollowKnownPathOutcome, { kind: 'rejected' }> {
    if (outcome.kind !== 'rejected') throw new Error(`expected rejected, got ${outcome.kind}`);
    return outcome;
  }

  it('follows a pathId to a measured ARRIVED and records the historical delegation', async () => {
    const history = historyWithFragment();
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const env = followEnv(history, map, measured, move, { drive: true, delegationId: 'known-1' });
    let writtenRecord: import('../src/index.js').ActionRecord | null = null;
    env.onMemoryWrite = (_result, record) => {
      writtenRecord = record;
      return 'pending';
    };

    const outcome = await followKnownPath(
      { pathId: 'frag-1', mode: 'walk', arrival: { kind: 'exact' } },
      env,
    );

    expect(outcome.kind).toBe('finished');
    if (outcome.kind !== 'finished') throw new Error('expected finished');
    expect(outcome.start.kind).toBe('STARTED');
    expect(outcome.start.route.fragmentId).toBe('frag-1');
    expect(outcome.result.outcome).toBe('ARRIVED');
    expect(outcome.result.confirmed).toBe(true);
    expect(outcome.result.memoryWrite).toBe('pending');
    expect(outcome.result.lastPosition).toEqual(pt(1.5, 0, 0.5));
    expect(outcome.record).toBe(writtenRecord);
    expect(outcome.record.delegationId).toBe('known-1');
    expect(outcome.record.delegation.requestedTarget).toBe('frag-1');
    expect(outcome.record.delegation.target).toEqual(pt(1.5, 0, 0.5));
    expect(outcome.record.delegation.allowedModes).toEqual(['walk']);
    expect(outcome.record.delegation.arrival).toEqual({ kind: 'exact' });
    expect(outcome.record.from).toEqual(pt(0.5, 0, 0.5));
    expect(outcome.record.to).toEqual(pt(1.5, 0, 0.5));
    expect(outcome.record.confirmed).toBe(true);
  });

  it('accepts the fragmentId alias and starts without moving unless drive is requested', async () => {
    const history = historyWithFragment();
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const env = followEnv(history, map, measured, move);

    const outcome = await followKnownPath(
      { fragmentId: 'frag-1', mode: 'walk', arrival: { kind: 'exact' } },
      env,
    );

    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') throw new Error('expected started');
    expect(outcome.result).toBeNull();
    expect(outcome.start.route.fragmentId).toBe('frag-1');
    expect(outcome.record.confirmed).toBe(false);
    expect(outcome.record.result).toBeUndefined();
    expect(move.requests).toEqual([]);
  });

  it('rejects conflicting ids, non-walk modes and non-exact arrival explicitly', async () => {
    const history = historyWithFragment();
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    const measured = { current: measuredSample(pt(0.5, 0, 0.5)) };
    const move = new TrackingMoveExecutor(measured);
    const env = followEnv(history, map, measured, move);

    const conflicting = await followKnownPath(
      { pathId: 'frag-1', fragmentId: 'other', mode: 'walk', arrival: { kind: 'exact' } },
      env,
    );
    expect(rejected(conflicting).result.problem?.kind).toBe('invalid_request');

    const nonWalk = await followKnownPath(
      { pathId: 'frag-1', mode: 'jump', arrival: { kind: 'exact' } },
      env,
    );
    expect(rejected(nonWalk).result.problem?.kind).toBe('unsupported_mode');

    const near = await followKnownPath(
      { pathId: 'frag-1', mode: 'walk', arrival: { kind: 'near', radius: 1 } },
      env,
    );
    expect(rejected(near).result.problem?.kind).toBe('unsupported_target');

    const avoid = await followKnownPath(
      { pathId: 'frag-1', mode: 'walk', arrival: { kind: 'exact' }, constraints: { avoid: [pt(0, 0, 0)] } },
      env,
    );
    expect(rejected(avoid).result.problem?.kind).toBe('not_authorized');
    expect(move.requests).toEqual([]);
  });

  it('projects stored history read-only with explicitly unknown current facts', () => {
    const history = historyWithFragment();
    const traversal: TraversalEvidence = {
      id: 'trav-1',
      fragmentId: 'frag-1',
      from: pt(0.5, 0, 0.5),
      to: pt(1.5, 0, 0.5),
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      observedAt: 1500,
      source: 'confirmed_walk',
      mode: 'walk',
    };
    history.addTraversal(traversal);
    const map = new VoxelMap('world');
    map.observe(obs(STONE, { x: 0, y: -1, z: 0 }));

    const before = {
      snapshot: history.checkpointSnapshot(),
      revision: history.revision,
      traversalTotal: history.traversals().total,
      mapRevision: map.saveRevision,
      mapPins: map.pinState(),
    };

    const inspection = inspectKnownRoute(history, 'frag-1');

    expect(inspection.kind).toBe('route');
    if (inspection.kind !== 'route') throw new Error('expected route');
    expect(inspection.source).toBe('fragment_store');
    expect(inspection.worldId).toBe('world');
    expect(inspection.pathId).toBe('frag-1');
    expect(inspection.dim).toBe('overworld');
    expect(inspection.fragmentKind).toBe('walked');
    expect(inspection.geometrySource).toBe('traversal');
    expect(inspection.precision).toBe('traversal');
    expect(inspection.polyline).toEqual([pt(0.5, 0, 0.5), pt(1.5, 0, 0.5)]);
    expect(inspection.pointCount).toBe(2);
    expect(inspection.ends).toEqual({ start: pt(0.5, 0, 0.5), end: pt(1.5, 0, 0.5) });
    expect(inspection.links).toEqual([{ a: pt(0.5, 0, 0.5), b: pt(1.5, 0, 0.5) }]);
    expect(inspection.deepestY).toBe(0);
    expect(inspection.uses).toBe(3);
    expect(inspection.traversals).toEqual([
      {
        id: 'trav-1',
        from: pt(0.5, 0, 0.5),
        to: pt(1.5, 0, 0.5),
        sessionId: 's1',
        observedAt: 1500,
        source: 'confirmed_walk',
        mode: 'walk',
      },
    ]);
    expect(inspection.traversalCount).toBe(1);
    expect(inspection.current).toEqual({
      openness: 'unknown',
      freshness: 'unknown',
      source: 'none',
      blocked: [],
    });
    expect(inspection.currentOpennessClaimed).toBe(false);
    expect(inspection.observedNow).toBe(false);
    expect(inspection.loadedSections).toBe(false);
    expect(inspection.mutated).toBe(false);

    // Fresh copies never alias the store.
    inspection.polyline[0]!.x = 99;
    inspection.links[0]!.a.x = 99;
    expect(history.getFragment('frag-1')!.polyline[0]!.x).toBe(0.5);

    const supplied = inspectKnownRoute(history, 'frag-1', {
      evidence: {
        checkedAt: 5000,
        freshness: 'fresh',
        blocked: [{ pos: pt(1.5, 0, 0.5), block: 'minecraft:stone' }],
      },
    });
    expect(supplied.kind).toBe('route');
    if (supplied.kind !== 'route') throw new Error('expected route');
    expect(supplied.current.openness).toBe('blocked');
    expect(supplied.current.freshness).toBe('fresh');
    expect(supplied.current.source).toBe('caller_supplied');
    expect(supplied.current.checkedAt).toBe(5000);
    expect(supplied.current.blocked).toEqual([
      { pos: pt(1.5, 0, 0.5), block: 'minecraft:stone' },
    ]);

    const unverified = inspectKnownRoute(history, 'frag-1', {
      evidence: { checkedAt: 5001, freshness: 'fresh' },
    });
    if (unverified.kind !== 'route') throw new Error('expected route');
    expect(unverified.current.openness).toBe('unknown');

    const whole = inspectKnownRoute(history, 'frag-1', {
      evidence: { checkedAt: 5002, freshness: 'fresh', verifiedWholeRoute: true },
    });
    if (whole.kind !== 'route') throw new Error('expected route');
    expect(whole.current.openness).toBe('open');

    const stale = inspectKnownRoute(history, 'frag-1', {
      evidence: { checkedAt: 5003, freshness: 'stale', verifiedWholeRoute: true },
    });
    if (stale.kind !== 'route') throw new Error('expected route');
    expect(stale.current.openness).toBe('stale');

    expect(history.checkpointSnapshot()).toEqual(before.snapshot);
    expect(history.revision).toBe(before.revision);
    expect(history.traversals().total).toBe(before.traversalTotal);
    expect(map.saveRevision).toBe(before.mapRevision);
    expect(map.pinState()).toEqual(before.mapPins);

    const missing = inspectKnownRoute(history, 'missing');
    expect(missing.kind).toBe('not_found');
    if (missing.kind !== 'not_found') throw new Error('expected not_found');
    expect(missing.message).toContain('missing');
  });
});

describe('frontierCandidates — optional caller history lookup', () => {
  function frontierSnapshot() {
    const map = new VoxelMap('world');
    openCells(map, [[0, 0], [1, 0]]);
    const search = new WalkRouteSearch(map, { now: () => NOW });
    search.start({
      ...SCOPE,
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      target: pt(3.5, 0, 0.5),
      arrival: { kind: 'exact' },
      shapeProvider: fakeProvider,
    });
    return drainSearch(search);
  }

  it('keeps historicalConnection unknown by default and only uses caller-returned booleans', () => {
    const snapshot = frontierSnapshot();
    expect(snapshot.frontiers.length).toBeGreaterThan(0);

    const byDefault = frontierCandidates(snapshot);
    expect(byDefault.candidates.every((candidate) => candidate.historicalConnection === 'unknown')).toBe(true);

    const trueLookup = frontierCandidates(snapshot, { historicalConnection: () => true });
    expect(trueLookup.candidates.every((candidate) => candidate.historicalConnection === true)).toBe(true);

    const falseLookup = frontierCandidates(snapshot, { historicalConnection: () => false });
    expect(falseLookup.candidates.every((candidate) => candidate.historicalConnection === false)).toBe(true);

    const undefinedLookup = frontierCandidates(snapshot, { historicalConnection: () => undefined });
    expect(undefinedLookup.candidates.every((candidate) => candidate.historicalConnection === 'unknown')).toBe(true);
    expect(byDefault.selected).toBe(false);
    expect(byDefault.explorationStarted).toBe(false);
  });
});
