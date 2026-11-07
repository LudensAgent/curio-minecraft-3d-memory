import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BodySample,
  ExecutableMove,
  ExecutableMoveResult,
  WalkRouteRequest,
} from '../src/execution/types.js';
import { WalkRouteExecutor } from '../src/execution/walk-route-executor.js';
import { WalkRouteSearch } from '../src/navigation/walk-search.js';
import { createWalkPath, createWalkPathExecution } from '../src/navigation/walk-path.js';
import type { WalkPathEnvironment } from '../src/navigation/walk-path-types.js';
import { RoutePlanRegistryImpl } from '../src/navigation/route-plan-registry.js';
import type { RoutePlanDraft } from '../src/navigation/route-plan-types.js';
import type { Vec3Like } from '../src/types.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { AIR, STONE, bodyAt, fakeProvider, obs } from './fakes.js';

const NOW = 5000;
const DEADLINE = NOW + 20_000;
const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };

/** Same-height feet columns along +X, one block apart. */
function routeAlong(...cells: number[]): Vec3Like[] {
  return cells.map((x) => ({ x: x + 0.5, y: 0, z: 0.5 }));
}

function draft(points: Vec3Like[], scope = SCOPE): RoutePlanDraft {
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
    evidence: { ...scope, validUntil: NOW + 100_000, ruleVersion: 'fake-1' },
    expiresAt: NOW + 100_000,
    requestedTarget: { ...last },
    resolvedTarget: { ...last },
    start: { ...points[0]! },
  };
}

/**
 * Observe a walkable slab around the route. `skip` omits specific cells so a
 * segment has no OPEN evidence; `blocks` observes a solid feet-height cube;
 * `observedAt` controls the evidence age (for STALE coverage).
 */
function observeWorld(
  map: VoxelMap,
  points: readonly Vec3Like[],
  overrides: {
    skip?: (pos: Vec3Like) => boolean;
    blocks?: Vec3Like[];
    observedAt?: (pos: Vec3Like) => number;
  } = {},
): void {
  const maxX = Math.max(...points.map((p) => Math.floor(p.x)));
  const blocked = new Set((overrides.blocks ?? []).map((p) => `${p.x},${p.y},${p.z}`));
  for (let x = -1; x <= maxX + 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 2; y++) {
        const pos = { x, y, z };
        if (overrides.skip?.(pos) === true) continue;
        const state = y === -1 || blocked.has(`${x},${y},${z}`) ? STONE : AIR;
        map.observe(obs(state, pos, { observedAt: overrides.observedAt?.(pos) ?? 1000, sequence: 1 }));
      }
    }
  }
}

function harness(
  points: Vec3Like[],
  options: {
    skip?: (pos: Vec3Like) => boolean;
    blocks?: Vec3Like[];
    maxRouteLength?: number;
    /** Re-tag measurements after this many reads as another execution's stale callback. */
    foreignExecutionAfterCall?: number;
    /** Which identity the host tags measurements with. Delegation is a negative case. */
    sampleIdentity?: 'execution' | 'delegation';
    /** Return null after this many readings (the start sample is read 1). */
    sampleNullAfterCall?: number;
    /** Force the first (start) measurement to carry this sequence. */
    startSequence?: number;
    /** Plan/environment/sample world scope; defaults to the map's world. */
    scopeWorldId?: string;
    /** Evidence age control and validity window. */
    observedAt?: (pos: Vec3Like) => number;
    validityWindowMs?: number;
    /** Skip map observation (for plans that are rejected before execution). */
    skipObservation?: boolean;
  } = {},
) {
  const scope = options.scopeWorldId === undefined ? SCOPE : { ...SCOPE, worldId: options.scopeWorldId };
  const map = new VoxelMap('world', { validityWindowMs: options.validityWindowMs ?? 60_000 });
  if (options.skipObservation !== true) {
    observeWorld(map, points, { ...options, observedAt: options.observedAt });
  }

  let clock = NOW;
  let sequence = 0;
  let reads = 0;
  let position = { ...points[0]! };
  let delegationId: string | null = null;
  const sampleIds: string[] = [];
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];

  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draft(points, scope));
  const executionId = `exec_${plan.routeId}`;

  const environment: WalkPathEnvironment = {
    ...scope,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => measurement(),
    bodyPort: {
      // The host's single-step move begins; measured samples confirm the rest.
      move: (request) => {
        moves.push(request);
        position = { ...request.to };
        return new Promise<ExecutableMoveResult>(() => {});
      },
      stop: (id) => {
        stops.push(id);
      },
    },
    now: () => clock,
  };

  function measurement(): BodySample | null {
    sequence += 1;
    reads += 1;
    if (options.sampleNullAfterCall !== undefined && reads > options.sampleNullAfterCall) return null;
    const first = reads === 1;
    const stale = options.foreignExecutionAfterCall !== undefined && reads > options.foreignExecutionAfterCall;
    // The delegation identity comes from the real `WalkRouteExecutor.start`
    // result captured below; it is never hard-coded in this harness.
    const identity =
      options.sampleIdentity === 'delegation' && delegationId !== null ? delegationId : executionId;
    const tagged = stale ? 'exec_previous' : first ? executionId : identity;
    sampleIds.push(tagged);
    return {
      ...scope,
      pos: { ...position },
      observedAt: clock,
      velocity: { x: 0, y: -0.0784, z: 0 },
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
      executionId: tagged,
      sequence: first && options.startSequence !== undefined ? options.startSequence : sequence,
    };
  }

  const execute = createWalkPathExecution({
    map,
    ...(options.maxRouteLength === undefined ? {} : { maxRouteLength: options.maxRouteLength }),
    wait: async () => {
      clock += 40;
    },
  });
  const walkPath = createWalkPath(registry, { execute });

  // Pass-through spy: capture the executor's real delegation id for samples
  // that follow the host-push identity layer (and for start-call assertions).
  const realStart = WalkRouteExecutor.prototype.start;
  const startSpy = vi
    .spyOn(WalkRouteExecutor.prototype, 'start')
    .mockImplementation(function (this: WalkRouteExecutor, request: WalkRouteRequest) {
      const status = realStart.call(this, request);
      delegationId = status.delegationId;
      return status;
    });

  return {
    plan,
    executionId,
    environment,
    walkPath,
    moves,
    stops,
    sampleIds,
    startSpy,
    delegationId: () => delegationId,
    time: () => clock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('walkPath execution — WalkRouteExecutor binding', () => {
  it('executes each planned segment and confirms grounded arrival from measured samples', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({
      outcome: 'ARRIVED',
      contract: 'memory-host-contract/1',
      routeId: h.plan.routeId,
      executionId: h.executionId,
      confirmed: true,
      confirmedSegments: 2,
      remainingPoints: [],
    });
    expect(result.lastPosition).toEqual(points[2]);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.consumption?.placed).toEqual([]);
    expect(result.trace.length).toBe(2);

    // One segment per plan step, in the plan's original order, no substitution.
    expect(h.moves.map((m) => m.to)).toEqual([points[1], points[2]]);
    expect(h.moves.map((m) => m.from)).toEqual([points[0], points[1]]);
    expect(h.moves.every((m) => m.bodyArrival !== undefined)).toBe(true);
    // The host only ever sees the stable walkPath identity, never walk-<n>.
    expect(h.moves.every((m) => m.executionId === h.executionId)).toBe(true);
    expect(h.stops.every((id) => id === h.executionId)).toBe(true);
    expect(h.stops).toEqual(h.moves.map((m) => m.executionId));

    // Exactly one executor start and no search/pathfinder work.
    expect(h.startSpy).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it('only starts a segment whose current evidence is OPEN; a BLOCKED segment is never executed', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points, { blocks: [{ x: 2, y: 0, z: 0 }] });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({
      outcome: 'BLOCKED',
      confirmed: false,
      confirmedSegments: 1,
      remainingPoints: [points[2]],
    });
    expect(result.problem?.kind).toBe('blocked');
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.to).toEqual(points[1]);
    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });

  it('stops instead of re-planning when the next segment has no OPEN evidence', async () => {
    const points = routeAlong(0, 1, 2);
    // The second step's destination head cell was never observed: UNKNOWN, never
    // treated as OPEN, and no alternate route/point may be substituted.
    const h = harness(points, { skip: (pos) => pos.x === 2 && pos.y === 1 && pos.z === 0 });
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'unobserved', segment: 1 });
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind).toBe('unobserved');
    expect(result.confirmedSegments).toBe(1);
    expect(result.remainingPoints).toEqual([points[2]]);
    expect(h.moves).toHaveLength(1);
    expect(h.moves.map((m) => m.to)).toEqual([points[1]]);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects a plan longer than maxRouteLength before starting or moving', async () => {
    const points = routeAlong(0, 1, 2, 3, 4);
    const h = harness(points, { maxRouteLength: 4 });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({
      outcome: 'INVALIDATED',
      confirmed: false,
      confirmedSegments: 0,
    });
    expect(result.invalidation).toMatchObject({ reason: 'route_budget', segment: 0 });
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(result.remainingPoints).toEqual(points);
    expect(h.moves).toHaveLength(0);
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('ignores measurements that belong to another execution and never fabricates arrival', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { foreignExecutionAfterCall: 1 });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    expect(result).toMatchObject({
      outcome: 'TIMEOUT',
      confirmed: false,
      confirmedSegments: 0,
      // The start is already the measured position; only unreached points remain.
      remainingPoints: [points[1]],
    });
    expect(result.problem).toMatchObject({ kind: 'timeout' });
    expect(result.lastPosition).toEqual(points[0]);
    // The stale samples were never rebound or executed.
    expect(h.moves).toHaveLength(0);
  });

  it('rejects host measurements tagged with the executor delegation id', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { sampleIdentity: 'delegation' });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    // Option A: only exec_<routeId> is a valid external identity. The executor's
    // predictable walk-<n> id must never be accepted from the host.
    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(h.sampleIds[0]).toBe(h.executionId);
    const delegationId = h.delegationId();
    expect(delegationId).not.toBeNull();
    expect(h.sampleIds.slice(1).every((id) => id === delegationId)).toBe(true);
  });

  it.each([0, -1, 1.5])('rejects a start sample with an invalid sequence (%s) instead of fabricating one', async (startSequence) => {
    const points = routeAlong(0, 1);
    const h = harness(points, { startSequence });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'route_start_unmeasured', segment: 0 });
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(h.startSpy).not.toHaveBeenCalled();
    expect(h.moves).toHaveLength(0);
  });

  it('rejects a map/environment worldId mismatch without throwing', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { scopeWorldId: 'other-world', skipObservation: true });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({ outcome: 'INVALIDATED', confirmed: false, confirmedSegments: 0 });
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(result.remainingPoints).toEqual(points);
    expect(h.startSpy).not.toHaveBeenCalled();
    expect(h.moves).toHaveLength(0);
  });

  it('maps an executor.start rejection (invalid bodyArrival) to a result instead of rejecting', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points);

    const result = await h.walkPath(
      {
        routeId: h.plan.routeId,
        deadlineMs: DEADLINE,
        bodyArrival: {
          horizontalTolerance: 1,
          feetTolerance: 0.05,
          maxHorizontalSpeed: 0.003,
          maxVerticalSpeed: 0.1,
          stableMs: 150,
        },
      },
      h.environment,
    );

    expect(result).toMatchObject({ outcome: 'INVALIDATED', confirmed: false });
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(h.startSpy).toHaveBeenCalledTimes(1);
    expect(h.moves).toHaveLength(0);
  });

  it('refuses a segment whose evidence is STALE and stops before it', async () => {
    const points = routeAlong(0, 1, 2);
    // Cells at x>=2 lie only on the second step and are older than the window.
    const h = harness(points, {
      observedAt: (pos) => (pos.x >= 2 ? 1000 : NOW - 100),
      validityWindowMs: 2000,
    });
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'stale', segment: 1 });
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind).toBe('stale');
    expect(result.confirmedSegments).toBe(1);
    expect(result.remainingPoints).toEqual([points[2]]);
    expect(h.moves).toHaveLength(1);
    expect(h.moves.map((m) => m.to)).toEqual([points[1]]);
    expect(search).not.toHaveBeenCalled();
  });

  it('does not report PARTIAL when no segment was confirmed', async () => {
    const points = routeAlong(0, 1);
    // The first step's destination head was never observed: UNKNOWN, not OPEN.
    const h = harness(points, { skip: (pos) => pos.x === 1 && pos.y === 1 && pos.z === 0 });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.confirmedSegments).toBe(0);
    expect(result.confirmed).toBe(false);
    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'unobserved', segment: 0 });
    expect(h.moves).toHaveLength(0);
  });

  it('fails closed immediately when the host has no measured sample', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { sampleNullAfterCall: 1 });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'route_body_unavailable' });
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(result.confirmed).toBe(false);
    expect(h.time()).toBeLessThan(NOW + 800);
  });

  it('rejects a move result sample from another execution identity', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points);
    const local = h.environment.sample()!;
    h.environment.bodyPort.move = async () => ({
      sample: { ...local, executionId: 'walk-1' },
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'execution_failed' });
    expect(result.problem).toMatchObject({ kind: 'execution_failed' });
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
  });

  it('returns TIMEOUT before starting when the deadline already passed', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points);

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW }, h.environment);

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(h.moves).toHaveLength(0);
  });

  it('returns ARRIVED for a zero-edge plan without starting the executor', async () => {
    const points = routeAlong(0);
    const h = harness(points);

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({
      outcome: 'ARRIVED',
      confirmed: true,
      confirmedSegments: 0,
      remainingPoints: [],
      executionId: h.executionId,
    });
    expect(result.lastPosition).toEqual(points[0]);
    expect(h.moves).toHaveLength(0);
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it('does not ARRIVE a zero-edge plan without a grounded dry sample', async () => {
    const points = routeAlong(0);
    const h = harness(points);
    const base = h.environment.sample()!;
    h.environment.sample = () => ({ ...base, onGround: false });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.problem?.kind).toBe('unconfirmed_arrival');
    expect(result.confirmed).toBe(false);
  });

  it('fails closed on a disconnected sample during zero-edge stabilization', async () => {
    const points = routeAlong(0);
    const h = harness(points);
    const base = h.environment.sample()!;
    let reads = 0;
    h.environment.sample = () => (++reads === 1 ? base : { ...base, connected: false });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'route_body_unavailable' });
    expect(result.problem?.kind).toBe('unavailable');
  });

  it('fails closed on a wrong-scope sample during zero-edge stabilization', async () => {
    const points = routeAlong(0);
    const h = harness(points);
    const base = h.environment.sample()!;
    let reads = 0;
    h.environment.sample = () => (++reads === 1 ? base : { ...base, sessionId: 'old-session' });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'scope_mismatch' });
    expect(result.problem?.kind).toBe('scope_changed');
  });

  it('cancels a zero-edge plan when the signal is already aborted', async () => {
    const points = routeAlong(0);
    const h = harness(points);
    const controller = new AbortController();
    controller.abort();

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE, signal: controller.signal }, h.environment);

    expect(result.outcome).toBe('CANCELLED');
    expect(result.confirmed).toBe(false);
    expect(h.moves).toHaveLength(0);
  });

  it('executes a route whose length equals maxRouteLength', async () => {
    const points = routeAlong(0, 1, 2, 3, 4);
    const h = harness(points, { maxRouteLength: points.length });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({ outcome: 'ARRIVED', confirmed: true, confirmedSegments: 4, remainingPoints: [] });
    expect(h.moves.map((m) => m.to)).toEqual(points.slice(1));
    expect(h.stops).toHaveLength(4);
  });

  it('executes a multi-point route under the default (1024) budget without truncating it', async () => {
    const points = routeAlong(0, 1, 2, 3, 4, 5);
    const h = harness(points);

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({ outcome: 'ARRIVED', confirmed: true, confirmedSegments: 5, remainingPoints: [] });
    expect(h.moves.map((m) => m.to)).toEqual(points.slice(1));
    expect(h.stops).toHaveLength(5);
    expect(h.time()).toBeLessThan(DEADLINE);
  });

  it('rejects a plan exceeding the default 1024-point budget before starting', async () => {
    const points = routeAlong(...Array.from({ length: 1025 }, (_, i) => i));
    const h = harness(points, { skipObservation: true });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result).toMatchObject({ outcome: 'INVALIDATED', confirmed: false, confirmedSegments: 0 });
    expect(result.invalidation).toMatchObject({ reason: 'route_budget', segment: 0 });
    expect(h.startSpy).not.toHaveBeenCalled();
    expect(h.moves).toHaveLength(0);
  });
});
