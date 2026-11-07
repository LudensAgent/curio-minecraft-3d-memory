import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BodySample, ExecutableMove, ExecutableMoveResult } from '../src/execution/types.js';
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
const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' } as const;

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

/** Observe a walkable slab around the route, so every step has current OPEN evidence. */
function observeWorld(map: VoxelMap, points: readonly Vec3Like[]): void {
  const maxX = Math.max(...points.map((p) => Math.floor(p.x)));
  for (let x = -1; x <= maxX + 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 2; y++) {
        const pos = { x, y, z };
        map.observe(obs(y === -1 ? STONE : AIR, pos, { observedAt: 1000, sequence: 1 }));
      }
    }
  }
}

/**
 * Drive `walkPath` with a fake single-step body port. Moves record their request
 * and start measuring at the requested target, but stay pending until a test
 * resolves them; host-pushed samples are scripted per test.
 */
function harness(points: Vec3Like[], options: { measuredStart?: Vec3Like } = {}) {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  observeWorld(map, points);

  let clock = NOW;
  let sequence = 0;
  let position = { ...(options.measuredStart ?? points[0]!) };
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];
  const portAccess: string[] = [];
  const pendingMoves: ((result: ExecutableMoveResult) => void)[] = [];

  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;

  const makeSample = (overrides: Partial<BodySample> = {}): BodySample => ({
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
    sequence: 0,
    ...overrides,
  });

  const nextSample = (): BodySample => {
    sequence += 1;
    return makeSample({ sequence });
  };

  const bodyPort = new Proxy(
    {
      move: (request: ExecutableMove): Promise<ExecutableMoveResult> => {
        moves.push(request);
        position = { ...request.to };
        return new Promise<ExecutableMoveResult>((resolve) => {
          pendingMoves.push(resolve);
        });
      },
      stop: (id: string): void => {
        stops.push(id);
      },
    },
    {
      get(target, property, receiver) {
        if (typeof property === 'string') portAccess.push(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: nextSample,
    bodyPort,
    now: () => clock,
  };

  const walkPath = createWalkPath(registry, {
    execute: createWalkPathExecution({
      map,
      wait: async () => {
        clock += 40;
      },
    }),
  });

  return {
    plan,
    executionId,
    environment,
    walkPath,
    moves,
    stops,
    portAccess,
    makeSample,
    nextSample,
    resolveMove: (index: number, result: ExecutableMoveResult): void => {
      pendingMoves[index]?.(result);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WalkBodyPort contract §7.3 / §7.5.11', () => {
  it('issues one stable single-step move per authorized point and exposes no construction surface', async () => {
    const points = routeAlong(0, 1, 2, 3);
    // Measured feet intentionally differ from the nominal plan start (within the
    // 0.05 start tolerance) so `from` cannot be the route point by accident.
    const measuredStart = { x: points[0]!.x + 0.02, y: points[0]!.y, z: points[0]!.z };
    const h = harness(points, { measuredStart });
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    // Stable host identity, never the executor's internal delegation id.
    expect(result.executionId).toBe(`exec_${h.plan.routeId}`);
    expect(result.executionId).toBe(h.executionId);
    expect(result).toMatchObject({
      outcome: 'ARRIVED',
      contract: 'memory-host-contract/1',
      confirmed: true,
      confirmedSegments: 3,
      remainingPoints: [],
    });
    expect(result.lastPosition).toEqual(points[3]);
    // §7.5.7: no construction/material surface at all, not merely an empty placed list.
    expect(result.consumption).toEqual({ placed: [] });
    expect(Object.keys(result.consumption!)).toEqual(['placed']);
    expect(result.trace.map((entry) => entry.pos)).toEqual([points[1], points[2], points[3]]);

    // Exactly one authorized move per route edge, in order, with no skip/merge/retarget.
    expect(h.moves).toHaveLength(points.length - 1);
    expect(h.moves.map((move) => move.to)).toEqual([points[1], points[2], points[3]]);
    expect(h.moves.map((move) => move.from)).toEqual([measuredStart, points[1], points[2]]);
    expect(h.moves[0]!.from).not.toEqual(points[0]);
    expect(h.moves.every((move) => move.executionId === h.executionId)).toBe(true);

    // stop only ever receives this execution's id.
    expect(h.stops).toHaveLength(h.moves.length);
    expect(h.stops.every((id) => id === h.executionId)).toBe(true);
    expect(h.stops).not.toContain('exec_previous');

    // Only move/stop are invoked on the body port.
    expect([...new Set(h.portAccess)].sort()).toEqual(['move', 'stop']);

    // No dig/place/tower/tool/material surface on a move request.
    const forbidden = /^(dig|place|tower|tool|material|break|build|place_support|swing|attack|consume|inventory)$/i;
    for (const move of h.moves) {
      expect(Object.keys(move).filter((key) => forbidden.test(key))).toEqual([]);
    }

    // No search/re-plan path behind the delegation.
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ['replayed', 6],
    ['lower', 5],
  ])('rejects a %s sample sequence without advancing progress or faking arrival', async (_label, replaySequence) => {
    const points = routeAlong(0, 1);
    const h = harness(points);
    let reads = 0;
    // The first six reads settle the body on the from-point and start the move;
    // every later read reports the target under a non-increasing sequence.
    h.environment.sample = () => {
      reads += 1;
      return reads <= 6
        ? h.makeSample({ sequence: reads, pos: { ...points[0]! } })
        : h.makeSample({ sequence: replaySequence, pos: { ...points[1]! } });
    };

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 400 }, h.environment);

    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]!.to).toEqual(points[1]);
    // The execution consumed at least five target samples after the move started:
    // if any replay were accepted, that many settled samples would confirm ARRIVED.
    expect(reads).toBeGreaterThanOrEqual(11);
    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(points[0]);
    expect(result.remainingPoints).toEqual([points[1]]);
    expect(result.trace).toEqual([]);
  });

  it('does not accept host-pushed samples that carry an old execution id', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points);
    let reads = 0;
    // The start settles under this execution; every target measurement belongs
    // to a previous execution and must never confirm (or become evidence for) it.
    h.environment.sample = () => {
      reads += 1;
      return reads <= 6
        ? h.nextSample()
        : { ...h.nextSample(), executionId: 'exec_previous', pos: { ...points[1]! } };
    };

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 400 }, h.environment);

    expect(h.moves).toHaveLength(1);
    // Five or more target samples were delivered under the old identity; a single
    // accepted one could not arrive, but all five would if the identity were ignored.
    expect(reads).toBeGreaterThanOrEqual(11);
    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(points[0]);
    expect(result.trace).toEqual([]);
  });

  it('ignores a late move result and samples carrying an old execution id', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);
    let lateResolved = false;
    let foreignSamples = 0;
    h.environment.sample = () => {
      // Step 1 is active: the pending step-0 move resolves late under an old id.
      if (h.moves.length === 2 && !lateResolved) {
        lateResolved = true;
        h.resolveMove(0, {
          sample: h.makeSample({ executionId: 'exec_previous', pos: { ...points[0]! } }),
        });
      }
      // A host-pushed sample from the old execution is ignored as well.
      if (h.moves.length === 2 && foreignSamples === 0) {
        foreignSamples += 1;
        return { ...h.nextSample(), executionId: 'exec_previous', pos: { ...points[0]! } };
      }
      return h.nextSample();
    };

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(lateResolved).toBe(true);
    expect(result).toMatchObject({
      outcome: 'ARRIVED',
      executionId: h.executionId,
      confirmed: true,
      confirmedSegments: 2,
      remainingPoints: [],
    });
    // The old callback never became this execution's evidence.
    expect(result.lastPosition).toEqual(points[2]);
    expect(result.trace.map((entry) => entry.pos)).toEqual([points[1], points[2]]);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    // Neither the late result nor the old sample stopped or re-stopped anything.
    expect(h.stops).toEqual([h.executionId, h.executionId]);
    expect(h.moves).toHaveLength(2);
  });

  it('isolates a finished execution from a new one sharing the same body port', async () => {
    const aPoints = routeAlong(0, 1);
    const bPoints = routeAlong(2, 3, 4);
    const map = new VoxelMap('world', { validityWindowMs: 60_000 });
    observeWorld(map, [...aPoints, ...bPoints]);

    let clock = NOW;
    let sequence = 0;
    let position = { ...aPoints[0]! };
    const moves: ExecutableMove[] = [];
    const stops: string[] = [];
    const pending: ((result: ExecutableMoveResult) => void)[] = [];

    const makeSample = (executionId: string): BodySample => {
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

    const bodyPort: WalkPathEnvironment['bodyPort'] = {
      move: (request) => {
        moves.push(request);
        position = { ...request.to };
        return new Promise<ExecutableMoveResult>((resolve) => {
          pending.push(resolve);
        });
      },
      stop: (id) => {
        stops.push(id);
      },
    };

    const registry = new RoutePlanRegistryImpl({ now: () => clock });
    const planA = registry.register(draft(aPoints));
    const planB = registry.register(draft(bPoints));
    const execAId = `exec_${planA.routeId}`;
    const execBId = `exec_${planB.routeId}`;
    expect(execBId).not.toBe(execAId);

    const walkPath = createWalkPath(registry, {
      execute: createWalkPathExecution({
        map,
        wait: async () => {
          clock += 40;
        },
      }),
    });

    const environment = (executionId: string, points: Vec3Like[]): WalkPathEnvironment => ({
      ...SCOPE,
      body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
      shapeProvider: fakeProvider,
      sample: () => makeSample(executionId),
      bodyPort,
      now: () => clock,
    });

    // Execution A ends by cancellation while its single move promise is still
    // pending, so A has left a late callback behind.
    const controller = new AbortController();
    const environmentA = environment(execAId, aPoints);
    environmentA.sample = () => {
      const sample = makeSample(execAId);
      if (moves.some((move) => move.executionId === execAId)) controller.abort();
      return sample;
    };
    const resultA = await walkPath(
      { routeId: planA.routeId, deadlineMs: DEADLINE, signal: controller.signal },
      environmentA,
    );

    expect(resultA).toMatchObject({ outcome: 'CANCELLED', executionId: execAId, confirmed: false });
    expect(resultA.problem).toMatchObject({ kind: 'cancelled' });
    expect(moves.filter((move) => move.executionId === execAId)).toHaveLength(1);
    expect(stops).toEqual([execAId]);

    // Execution B is a different route on the same port; the body is measured at
    // B's start and A's late move result lands while B has a step in flight.
    position = { ...bPoints[0]! };
    const movesBeforeB = moves.length;
    const stopsBeforeB = stops.length;
    let lateResolved = false;
    const environmentB = environment(execBId, bPoints);
    environmentB.sample = () => {
      if (!lateResolved && moves.some((move) => move.executionId === execBId)) {
        lateResolved = true;
        const late = makeSample(execAId);
        pending[0]?.({ sample: { ...late, pos: { ...aPoints[1]! } } });
      }
      return makeSample(execBId);
    };
    const resultB = await walkPath({ routeId: planB.routeId, deadlineMs: DEADLINE }, environmentB);

    expect(lateResolved).toBe(true);
    expect(resultB).toMatchObject({
      outcome: 'ARRIVED',
      executionId: execBId,
      confirmed: true,
      confirmedSegments: 2,
      remainingPoints: [],
    });
    // A's old position never became B's evidence.
    expect(resultB.lastPosition).toEqual(bPoints[2]);
    expect(resultB.trace.map((entry) => entry.pos)).toEqual([bPoints[1], bPoints[2]]);

    const bMoves = moves.slice(movesBeforeB);
    expect(bMoves.map((move) => move.to)).toEqual([bPoints[1], bPoints[2]]);
    expect(bMoves.every((move) => move.executionId === execBId)).toBe(true);
    // B only ever stops its own execution, both before and after A's late result.
    expect(stops.slice(stopsBeforeB)).toEqual([execBId, execBId]);
  });
});
