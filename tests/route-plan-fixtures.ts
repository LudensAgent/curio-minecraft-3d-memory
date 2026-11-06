/**
 * Shared fixtures for M3 route-planning tests. Not a vitest suite.
 *
 * These fixtures use the real `WalkRouteSearch`, `RouteVerifier` and
 * `RoutePlanRegistryImpl` over an in-memory `VoxelMap`; the fake collision
 * provider is explicitly not Minecraft physics.
 */

import {
  createWalkRouteSearchSource,
  FragmentStore,
  RoutePlanRegistryImpl,
  RouteVerifier,
  VoxelMap,
  WalkRouteSearch,
} from '../src/index.js';
import type {
  BodySample,
  PathFragment,
  RoutePlan,
  RoutePlanEnvironment,
  RoutePlanRequest,
  RoutePlanResult,
  RouteSearchSource,
  Vec3Like,
  WalkSearchSnapshot,
} from '../src/index.js';
import { AIR, bodyAt, fakeProvider, obs, pathFragment, STONE } from './fakes.js';

export const WORLD = 'world';
export const DIM = 'overworld';
export const SESSION = 's1';
export const NOW = 5000;
export const DEADLINE = NOW + 10_000;

export class TestClock {
  current: number;
  readonly now: () => number;

  constructor(current = NOW) {
    this.current = current;
    this.now = () => this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** A standable, fully observed same-height column at each requested XZ cell. */
export function openFloorMap(
  cells: readonly { x: number; z: number }[],
  options: { now?: () => number; validityWindowMs?: number } = {},
): VoxelMap {
  const map = new VoxelMap(WORLD, {
    now: options.now ?? (() => NOW),
    ...(options.validityWindowMs === undefined ? {} : { validityWindowMs: options.validityWindowMs }),
  });
  for (const { x, z } of cells) {
    map.observe(obs(STONE, { x, y: -1, z }));
    map.observe(obs(AIR, { x, y: 0, z }));
    map.observe(obs(AIR, { x, y: 1, z }));
  }
  return map;
}

/** A straight observed corridor along +X from 0 to `length - 1` at z = 0. */
export function straightCorridor(length: number, options: { now?: () => number; validityWindowMs?: number } = {}): VoxelMap {
  return openFloorMap(
    Array.from({ length }, (_, x) => ({ x, z: 0 })),
    options,
  );
}

export function makeSample(pos: Vec3Like, overrides: Partial<BodySample> = {}): BodySample {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    executionId: 'exec-plan',
    sequence: 1,
    pos: { ...pos },
    observedAt: NOW - 100,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    ...overrides,
  };
}

export interface PlanParts {
  map: VoxelMap;
  verifier: RouteVerifier;
  registry: RoutePlanRegistryImpl;
  clock: TestClock;
}

export function makePlanParts(options: {
  map: VoxelMap;
  clock?: TestClock;
  registry?: RoutePlanRegistryImpl;
}): PlanParts {
  const clock = options.clock ?? new TestClock();
  return {
    map: options.map,
    verifier: new RouteVerifier(options.map, { now: clock.now }),
    registry: options.registry ?? new RoutePlanRegistryImpl({ now: clock.now }),
    clock,
  };
}

export function searchSource(map: VoxelMap, clock: TestClock = new TestClock()): RouteSearchSource {
  return createWalkRouteSearchSource(new WalkRouteSearch(map, { now: clock.now }));
}

export function makePlanEnvironment(
  parts: PlanParts,
  overrides: Partial<RoutePlanEnvironment> = {},
): RoutePlanEnvironment {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    body: bodyAt(0.5, 0, 0.5),
    shapeProvider: fakeProvider,
    sample: () => makeSample({ x: 0.5, y: 0, z: 0.5 }),
    verifier: parts.verifier,
    registry: parts.registry,
    now: parts.clock.now,
    budgetPerSlice: 8,
    planTtlMs: 30_000,
    wait: async () => {},
    ...overrides,
  };
}

export function planRequest(overrides: Partial<RoutePlanRequest> = {}): RoutePlanRequest {
  return {
    to: { x: 2.5, y: 0, z: 0.5 },
    mode: 'walk',
    source: 'search',
    arrival: { kind: 'exact' },
    deadlineMs: DEADLINE,
    ...overrides,
  };
}

/** Raw boundary input for cases the typed contract deliberately rejects. */
export function loosePlanRequest(overrides: Record<string, unknown> = {}): RoutePlanRequest {
  return { ...planRequest(), ...overrides } as unknown as RoutePlanRequest;
}

export function planOf(result: RoutePlanResult): RoutePlan {
  if (result.problem !== undefined || result.plan === undefined) {
    throw new Error(`expected a route plan, got ${JSON.stringify(result.problem ?? null)}`);
  }
  return result.plan;
}

/** Wall off the single fixture column at (0, y, 0) in all four horizontal directions. */
export function wallOffSingleCell(map: VoxelMap): void {
  for (const cell of [
    [1, 0, 0], [1, 1, 0],
    [-1, 0, 0], [-1, 1, 0],
    [0, 0, 1], [0, 1, 1],
    [0, 0, -1], [0, 1, -1],
  ] as const) {
    map.observe(obs(STONE, { x: cell[0], y: cell[1], z: cell[2] }));
  }
}

/**
 * A search source that replays one terminal snapshot. Used only to isolate the
 * planner's re-verification boundary from the search implementation.
 */
export function replaySearchSource(snapshot: WalkSearchSnapshot): RouteSearchSource {
  return {
    start: () => {},
    advance: () => snapshot,
    snapshot: () => snapshot,
    cancel: () => {},
  };
}

/** First read returns `initial`; the first advance returns `advanced`. */
export function replayAdvancingSearchSource(
  initial: WalkSearchSnapshot,
  advanced: WalkSearchSnapshot,
): RouteSearchSource {
  return {
    start: () => {},
    advance: () => advanced,
    snapshot: () => initial,
    cancel: () => {},
  };
}

/** Run a real search to a terminal snapshot (fixture helper, not part of planning). */
export function runSearch(
  map: VoxelMap,
  target: Vec3Like,
  clock: TestClock = new TestClock(),
): WalkSearchSnapshot {
  const search = new WalkRouteSearch(map, { now: clock.now });
  search.start({
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    target: { ...target },
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
  });
  let snapshot = search.status();
  if (snapshot === null) throw new Error('search did not start');
  for (let i = 0; i < 10_000 && snapshot.state === 'PENDING'; i++) snapshot = search.advance(256);
  return snapshot;
}

export function historyWith(fragments: readonly PathFragment[]): FragmentStore {
  const history = new FragmentStore(WORLD);
  for (const fragment of fragments) history.saveFragment(fragment);
  return history;
}

/** Straight +X historical fragment from `length` points at feet y = 0. */
export function straightFragment(
  id: string,
  length: number,
  overrides: Partial<PathFragment> = {},
): PathFragment {
  return pathFragment(id, {
    kind: 'walked',
    geometrySource: 'traversal',
    polyline: Array.from({ length }, (_, x) => ({ x: x + 0.5, y: 0, z: 0.5 })),
    entrances: [{ x: 0.5, y: 0, z: 0.5 }],
    deepestY: 0,
    ...overrides,
  });
}

/** Read-only state used to prove planning did not write the map or history. */
export function capturePlanningState(parts: PlanParts, history?: FragmentStore): unknown {
  return {
    saveRevision: parts.map.saveRevision,
    pins: parts.map.pinState(),
    resident: parts.map.residentSize(),
    dirty: parts.map.checkpointDirtyMeasure(),
    fragmentRevision: history?.revision,
    fragments: history === undefined ? undefined : history.fragments({ limit: 1000 }).items.map((f) => ({
      id: f.id,
      uses: f.uses,
      lastUsedAt: f.lastUsedAt,
      polyline: f.polyline,
    })),
  };
}
