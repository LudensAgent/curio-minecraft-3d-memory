import { describe, expect, it } from 'vitest';

import type {
  BodySample,
  ExecutableMove,
  ExecutableMoveResult,
  GroundedArrival,
} from '../src/execution/types.js';
import { GROUNDED_ARRIVAL_DEFAULTS } from '../src/execution/types.js';
import { createWalkPath, createWalkPathExecution } from '../src/navigation/walk-path.js';
import type { WalkPathEnvironment, WalkPathResult } from '../src/navigation/walk-path-types.js';
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

/** Observe open air over a stone floor around the route. */
function observeWorld(map: VoxelMap, points: readonly Vec3Like[]): void {
  const maxX = Math.max(...points.map((p) => Math.floor(p.x)));
  for (let x = -1; x <= maxX + 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 2; y++) {
        const state = y === -1 ? STONE : AIR;
        map.observe(obs(state, { x, y, z }, { observedAt: 1000 }));
      }
    }
  }
}

interface HarnessOptions {
  /** Offset of the initial measured feet from `points[0]` (zero-edge custom-tolerance cases). */
  initialOffset?: Partial<Vec3Like>;
  /** Offset of the measured feet once the body reaches the point at this index. */
  offsetAt?: (pointIndex: number) => Partial<Vec3Like>;
  /** Per-read measured sample overrides; `null` makes `sample()` return null. */
  sampleOverrides?: (state: { pointIndex: number; read: number }) => Partial<BodySample> | null;
  /** Moves for which the body port resolves a result; every other move stays pending. */
  resolveMoveAt?: (moveIndex: number) => boolean;
  /** The resolved move result; requires `resolveMoveAt`. */
  moveResult?: (request: ExecutableMove, sample: BodySample, moveIndex: number) => ExecutableMoveResult;
}

/**
 * `walkPath` harness over the library executor. Measured samples are read from
 * `environment.sample()`; moves can stay pending (measured confirmation) or
 * resolve a result, so the tests can tell measurement apart from resolution.
 */
function harness(points: Vec3Like[], options: HarnessOptions = {}) {
  let clock = NOW;
  const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => clock });
  observeWorld(map, points);

  let sequence = 0;
  let reads = 0;
  let pointIndex = 0;
  const first = points[0]!;
  const initial = options.initialOffset ?? {};
  let position: Vec3Like = {
    x: first.x + (initial.x ?? 0),
    y: first.y + (initial.y ?? 0),
    z: first.z + (initial.z ?? 0),
  };
  const moves: ExecutableMove[] = [];
  const sampleIds: string[] = [];

  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;

  function measure(): BodySample | null {
    sequence += 1;
    reads += 1;
    const overrides = options.sampleOverrides?.({ pointIndex, read: reads });
    if (overrides === null) return null;
    const sample: BodySample = {
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
      ...overrides,
    };
    sampleIds.push(sample.executionId);
    return sample;
  }

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(first.x, first.y, first.z),
    shapeProvider: fakeProvider,
    sample: () => measure(),
    bodyPort: {
      move: (request) => {
        moves.push(request);
        const moveIndex = moves.length;
        pointIndex = moveIndex;
        const target = points[moveIndex]!;
        const offset = options.offsetAt?.(moveIndex) ?? {};
        position = {
          x: target.x + (offset.x ?? 0),
          y: target.y + (offset.y ?? 0),
          z: target.z + (offset.z ?? 0),
        };
        if (options.resolveMoveAt?.(moveIndex) !== true) {
          return new Promise<ExecutableMoveResult>(() => {});
        }
        // Resolve on a microtask so the result sample is ordered after the
        // loop's own synchronous reading at the same measured position.
        return Promise.resolve().then(() => {
          const sample = measure();
          if (sample === null) throw new Error('the move resolved without a measured sample');
          return options.moveResult!(request, sample, moveIndex);
        });
      },
      stop: () => {},
    },
    now: () => clock,
  };

  const execute = createWalkPathExecution({
    map,
    wait: async () => {
      clock += 40;
    },
  });
  const walkPath = createWalkPath(registry, { execute });

  return { plan, environment, walkPath, moves, sampleIds };
}

const nearMisses: Array<[string, Partial<BodySample>]> = [
  ['not grounded', { onGround: false }],
  ['in water', { inWater: true }],
  ['moving too fast horizontally', { velocity: { x: 0.5, y: -0.0784, z: 0 } }],
  ['falling too fast vertically', { velocity: { x: 0, y: -0.9, z: 0 } }],
  ['missing velocity', { velocity: undefined }],
];

describe('walkPath grounded arrival — multi-point executor path (M4.5)', () => {
  it('confirms ARRIVED from measured grounded samples at the default bodyArrival tolerances', async () => {
    const points = routeAlong(0, 1, 2);
    const offset = { x: 0.06, z: 0.04 };
    const measured = { x: points[2]!.x + offset.x, y: points[2]!.y, z: points[2]!.z + offset.z };
    const h = harness(points, { offsetAt: (index) => (index === 2 ? offset : {}) });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.confirmedSegments).toBe(2);
    expect(result.remainingPoints).toEqual([]);
    // The result carries the measured feet, not the nominal plan point.
    expect(result.lastPosition).toEqual(measured);
    expect(result.lastPosition).not.toEqual(points[2]);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.lastObservation?.observedAt).toBeGreaterThan(NOW);
    expect(result.trace[result.trace.length - 1]?.pos).toEqual(measured);
    // Every authorized move carried the effective grounded-arrival contract.
    expect(h.moves.map((move) => move.bodyArrival)).toEqual([
      GROUNDED_ARRIVAL_DEFAULTS,
      GROUNDED_ARRIVAL_DEFAULTS,
    ]);
  });

  it('honors a custom bodyArrival tolerance', async () => {
    const points = routeAlong(0, 1);
    const bodyArrival: GroundedArrival = {
      horizontalTolerance: 0.4,
      feetTolerance: 0.1,
      maxHorizontalSpeed: 0.003,
      maxVerticalSpeed: 0.1,
      stableMs: 150,
    };
    const h = harness(points, { offsetAt: (index) => (index === 1 ? { x: 0.3 } : {}) });

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: DEADLINE, bodyArrival },
      h.environment,
    );

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.lastPosition).toEqual({ x: points[1]!.x + 0.3, y: points[1]!.y, z: points[1]!.z });
    expect(h.moves[0]!.bodyArrival).toEqual(bodyArrival);
  });

  it('does not confirm ARRIVED at a measured point outside the default tolerance', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { offsetAt: (index) => (index === 1 ? { x: 0.3 } : {}) });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toBeDefined();
    expect(result.problem?.kind).toBe('timeout');
    expect(h.moves).toHaveLength(1);
  });

  it.each(nearMisses)('does not confirm ARRIVED from a %s sample at the target', async (_label, overrides) => {
    const points = routeAlong(0, 1);
    const h = harness(points, {
      sampleOverrides: ({ pointIndex }) => (pointIndex === 1 ? overrides : {}),
      resolveMoveAt: () => true,
      moveResult: (_request, sample) => ({ sample }),
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.outcome).toBe('EFFECT_NOT_CONFIRMED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    // The sample was measured at the target; only the grounded/stable
    // completion condition is missing, so arrival is not inferred from position.
    expect(result.lastPosition).toEqual(points[1]);
  });

  it('does not confirm ARRIVED when the move promise merely resolves', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, { resolveMoveAt: () => true, moveResult: () => ({}) });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('EFFECT_NOT_CONFIRMED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    expect(result.confirmedSegments).toBe(0);
    expect(result.remainingPoints).toEqual([points[1]]);
  });

  it('does not confirm ARRIVED merely because the next point index advanced', async () => {
    const points = routeAlong(0, 1, 2);
    // The first segment is confirmed by measured samples; the last move resolves
    // without any measurement. One confirmed segment is progress, not arrival.
    const h = harness(points, {
      resolveMoveAt: (moveIndex) => moveIndex === 2,
      moveResult: () => ({}),
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(1);
    expect(result.remainingPoints).toEqual([points[2]]);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
  });

  it('ignores a grounded sample at the target that belongs to an old execution', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, {
      sampleOverrides: ({ pointIndex }) => (pointIndex === 1 ? { executionId: 'exec_previous' } : {}),
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(h.sampleIds).toContain('exec_previous');
  });

  it('rejects an old-execution move result instead of treating it as arrival', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points, {
      resolveMoveAt: () => true,
      moveResult: (_request, sample) => ({ sample: { ...sample, executionId: 'exec_previous' } }),
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'execution_failed' });
    expect(result.invalidation).toMatchObject({ reason: 'execution_failed' });
  });
});

describe('walkPath grounded arrival — zero-edge path (M4.5)', () => {
  it('confirms a zero-edge ARRIVED from the measured grounded sample', async () => {
    const points = routeAlong(0);
    const h = harness(points, { initialOffset: { x: 0.04 } });
    const measured = { x: points[0]!.x + 0.04, y: points[0]!.y, z: points[0]!.z };

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.confirmedSegments).toBe(0);
    expect(result.remainingPoints).toEqual([]);
    expect(result.lastPosition).toEqual(measured);
    expect(result.lastObservation).toMatchObject({ ...SCOPE, onGround: true, inWater: false });
    expect(result.lastObservation?.observedAt).toBeGreaterThan(NOW);
    expect(h.moves).toHaveLength(0);
  });

  it('applies a custom zero-edge bodyArrival tolerance', async () => {
    const points = routeAlong(0);
    const h = harness(points, { initialOffset: { x: 0.04 } });
    const bodyArrival: GroundedArrival = { ...GROUNDED_ARRIVAL_DEFAULTS, horizontalTolerance: 0.02 };

    const result = await h.walkPath(
      { routeId: h.plan.routeId, deadlineMs: DEADLINE, bodyArrival },
      h.environment,
    );

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'unconfirmed_arrival' });
    expect(h.moves).toHaveLength(0);
  });

  it.each(nearMisses)('does not confirm a zero-edge ARRIVED from a %s sample', async (_label, overrides) => {
    const points = routeAlong(0);
    const h = harness(points, { sampleOverrides: () => overrides });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    expect(result.remainingPoints).toEqual(points);
  });

  it('does not confirm a zero-edge ARRIVED from a late old-execution sample', async () => {
    const points = routeAlong(0);
    const h = harness(points, {
      sampleOverrides: ({ read }) => (read > 1 ? { executionId: 'exec_previous' } : {}),
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: NOW + 800 }, h.environment);

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'timeout' });
    expect(h.sampleIds).toContain('exec_previous');
  });
});

/** Registry + environment for an injected-executor result; no movement is involved. */
function boundaryHarness(points: Vec3Like[]) {
  const registry = new RoutePlanRegistryImpl({ now: () => NOW });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;
  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => ({
      ...SCOPE,
      pos: { ...points[0]! },
      observedAt: NOW,
      velocity: { x: 0, y: -0.0784, z: 0 },
      alive: true,
      connected: true,
      observationReady: true,
      onGround: true,
      inWater: false,
      executionId,
      sequence: 1,
    }),
    bodyPort: {
      move: async () => {
        throw new Error('the boundary harness never moves');
      },
      stop: () => {},
    },
    now: () => NOW,
  };
  return { registry, plan, executionId, environment };
}

/** A terminal result synthesized by a test executor, not by `walkPath`. */
function synthesizedArrival(
  plan: { routeId: string; points: Vec3Like[] },
  executionId: string,
  overrides: Partial<WalkPathResult> = {},
): WalkPathResult {
  const target = plan.points[plan.points.length - 1]!;
  return {
    outcome: 'ARRIVED',
    contract: 'memory-host-contract/1',
    routeId: plan.routeId,
    executionId,
    lastPosition: { ...target },
    lastObservation: { ...SCOPE, observedAt: NOW, onGround: true, inWater: false },
    confirmedSegments: 1,
    remainingPoints: [],
    consumption: { placed: [] },
    memoryWrite: 'saved',
    confirmed: true,
    trace: [],
    ...overrides,
  };
}

describe('walkPath arrival envelope — injected executor boundary (M4.5)', () => {
  it('passes through an ARRIVED result that carries measured evidence', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const arrived = synthesizedArrival(b.plan, b.executionId);
    const walkPath = createWalkPath(b.registry, { execute: async () => arrived });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result).toBe(arrived);
    expect(result.confirmed).toBe(true);
  });

  it('rejects a grounded ARRIVED whose measured position is off-target', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () =>
        synthesizedArrival(b.plan, b.executionId, {
          // Grounded, in-scope observation, but still at the start point.
          lastPosition: { ...points[0]! },
        }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
  });

  it('rejects an ARRIVED from another execution identity', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => synthesizedArrival(b.plan, 'exec_other'),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.routeId).toBe(b.plan.routeId);
    expect(result.executionId).toBe(b.executionId);
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.remainingPoints).toEqual(points);
    expect(result.lastPosition).toBeUndefined();
    expect(result.lastObservation).toBeUndefined();
    expect(result.trace).toEqual([]);
    expect(result.consumption).toBeUndefined();
    expect(result.memoryWrite).toBeUndefined();
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'route_invalidated' });
    expect(result.problem).toMatchObject({ kind: 'route_invalidated' });
  });

  it('rejects an ARRIVED for another route identity', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => synthesizedArrival({ routeId: 'rt_other', points }, b.executionId),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.routeId).toBe(b.plan.routeId);
    expect(result.executionId).toBe(b.executionId);
    expect(result.confirmed).toBe(false);
    expect(result.confirmedSegments).toBe(0);
    expect(result.remainingPoints).toEqual(points);
    expect(result.lastPosition).toBeUndefined();
    expect(result.lastObservation).toBeUndefined();
    expect(result.trace).toEqual([]);
    expect(result.consumption).toBeUndefined();
    expect(result.memoryWrite).toBeUndefined();
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'route_invalidated' });
    expect(result.problem).toMatchObject({ kind: 'route_invalidated' });
  });

  it('sanitizes a non-ARRIVED result with an invalid confirmedSegments', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () =>
        synthesizedArrival(b.plan, b.executionId, {
          outcome: 'PARTIAL',
          confirmed: false,
          confirmedSegments: Number.NaN,
          remainingPoints: [],
        }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(Number.isSafeInteger(result.confirmedSegments)).toBe(true);
    expect(result.confirmedSegments).toBe(0);
    expect(result.remainingPoints).toEqual(points);
    expect(result.confirmed).toBe(false);
  });

  it('fails closed on an invalid bodyArrival tolerance', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => synthesizedArrival(b.plan, b.executionId),
    });

    const result = await walkPath(
      {
        routeId: b.plan.routeId,
        deadlineMs: DEADLINE,
        bodyArrival: { ...GROUNDED_ARRIVAL_DEFAULTS, horizontalTolerance: Number.POSITIVE_INFINITY },
      },
      b.environment,
    );

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(result.confirmed).toBe(false);
  });

  it('rejects an ARRIVED that leaves remaining points unconfirmed', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () =>
        synthesizedArrival(b.plan, b.executionId, {
          confirmedSegments: 0,
          remainingPoints: [points[1]!],
        }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('EFFECT_NOT_CONFIRMED');
    expect(result.confirmed).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['past the final point', 99],
  ] as Array<[string, number]>)(
    'never emits an invalid confirmedSegments (%s) and fails closed',
    async (_label, confirmedSegments) => {
      const points = routeAlong(0, 1);
      const b = boundaryHarness(points);
      // Evidence is valid; only the claimed count is malformed. The result must
      // not pass through (which would emit NaN/Infinity) and must not be ARRIVED.
      const walkPath = createWalkPath(b.registry, {
        execute: async () => synthesizedArrival(b.plan, b.executionId, { confirmedSegments }),
      });

      const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

      expect(Number.isSafeInteger(result.confirmedSegments)).toBe(true);
      expect(result.confirmedSegments).toBe(0);
      expect(result.outcome).toBe('EFFECT_NOT_CONFIRMED');
      expect(result.confirmed).toBe(false);
      expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
      expect(result.invalidation).toMatchObject({ segment: 0, reason: 'effect_not_confirmed' });
    },
  );

  const unbacked: Array<[string, Partial<WalkPathResult>]> = [
    ['no measured position', { lastPosition: undefined }],
    ['no observation', { lastObservation: undefined }],
    ['a non-finite position', { lastPosition: { x: Number.NaN, y: 0, z: 0.5 } }],
    [
      'a non-finite observation time',
      { lastObservation: { ...SCOPE, observedAt: Number.NaN, onGround: true, inWater: false } },
    ],
    [
      'a not-grounded observation',
      { lastObservation: { ...SCOPE, observedAt: NOW, onGround: false, inWater: false } },
    ],
    [
      'a wet observation',
      { lastObservation: { ...SCOPE, observedAt: NOW, onGround: true, inWater: true } },
    ],
    [
      'an observation from another scope',
      { lastObservation: { ...SCOPE, sessionId: 's2', observedAt: NOW, onGround: true, inWater: false } },
    ],
    ['confirmed:false', { confirmed: false }],
  ];

  it.each(unbacked)('fails closed on an ARRIVED result with %s', async (_label, overrides) => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => synthesizedArrival(b.plan, b.executionId, overrides),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).not.toBe('ARRIVED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    // One confirmed segment was claimed: the normal unconfirmed mapping is PARTIAL.
    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmedSegments).toBe(1);
  });

  it('clears confirmed:true from a non-ARRIVED result', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => ({
        outcome: 'PARTIAL',
        contract: 'memory-host-contract/1',
        routeId: b.plan.routeId,
        executionId: b.executionId,
        confirmedSegments: 1,
        remainingPoints: [],
        confirmed: true,
        trace: [],
      }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
  });

  it('reports an unbacked zero-edge ARRIVED as EFFECT_NOT_CONFIRMED', async () => {
    const points = routeAlong(0);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () =>
        synthesizedArrival(b.plan, b.executionId, {
          confirmedSegments: 0,
          lastPosition: undefined,
          lastObservation: undefined,
        }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('EFFECT_NOT_CONFIRMED');
    expect(result.confirmed).toBe(false);
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'effect_not_confirmed' });
    expect(result.problem).toMatchObject({ kind: 'unconfirmed_arrival' });
    expect(result.remainingPoints).toEqual(points);
  });
});

describe('walkPath — executor seam failures stay inside the contract', () => {
  it('maps an injected executor rejection to INVALIDATED without escaping', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () => {
        throw new Error('body adapter exploded');
      },
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.confirmed).toBe(false);
    expect(result.problem).toMatchObject({
      kind: 'execution_failed',
      detail: expect.stringContaining('body adapter exploded'),
    });
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'execution_failed' });
    // Only the measured start is known; no plan point is promoted to measured.
    expect(result.lastPosition).toEqual(b.environment.sample()?.pos);
  });

  it('does not throw when an injected ARRIVED omits remainingPoints', async () => {
    const points = routeAlong(0, 1);
    const b = boundaryHarness(points);
    const walkPath = createWalkPath(b.registry, {
      execute: async () =>
        synthesizedArrival(b.plan, b.executionId, {
          remainingPoints: undefined as never,
        }),
    });

    const result = await walkPath({ routeId: b.plan.routeId, deadlineMs: DEADLINE }, b.environment);

    // The confirmed segment count is retained as progress; only the unbacked
    // ARRIVED is withheld. The important invariant is that it did not throw.
    expect(result.outcome).toBe('PARTIAL');
    expect(result.confirmed).toBe(false);
    expect(result.remainingPoints).toEqual([]);
  });
});
