import { describe, expect, it } from 'vitest';

import type { BodySample } from '../src/execution/types.js';
import { createWalkPath } from '../src/navigation/walk-path.js';
import type { WalkPathStartContext } from '../src/navigation/walk-path.js';
import type { WalkPathEnvironment, WalkPathResult } from '../src/navigation/walk-path-types.js';
import {
  RoutePlanRegistryCapacityError,
  RoutePlanRegistryImpl,
} from '../src/navigation/route-plan-registry.js';
import type { RoutePlanDraft } from '../src/navigation/route-plan-types.js';
import type { Vec3Like } from '../src/types.js';
import { bodyAt, fakeProvider } from './fakes.js';

const NOW = 5000;
const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const START = { x: 0.5, y: 64, z: 0.5 };
const END = { x: 1.5, y: 64, z: 0.5 };

function draft(overrides: Partial<RoutePlanDraft> = {}): RoutePlanDraft {
  return {
    backend: 'spatial_library',
    source: 'search',
    points: [{ ...START }, { ...END }],
    segments: [{ index: 0, mode: 'walk', points: [{ ...START }, { ...END }], cost: 1 }],
    cost: 1,
    confidence: 'verified',
    executable: true,
    boundaries: [],
    evidence: { ...SCOPE, validUntil: 100_000, ruleVersion: 'fake-1' },
    expiresAt: 100_000,
    requestedTarget: { ...END },
    resolvedTarget: { ...END },
    start: { ...START },
    ...overrides,
  };
}

function sampleAt(pos: Vec3Like, overrides: Partial<BodySample> = {}): BodySample {
  return {
    ...SCOPE,
    pos: { ...pos },
    observedAt: 4000,
    velocity: { x: 0, y: -0.0784, z: 0 },
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
    executionId: 'host-execution',
    sequence: 1,
    ...overrides,
  };
}

function registry(): RoutePlanRegistryImpl {
  return new RoutePlanRegistryImpl({ now: () => NOW });
}

/** A terminal result synthesized by the test executor, not by `walkPath`. */
function arrived(start: WalkPathStartContext): WalkPathResult {
  return {
    outcome: 'ARRIVED',
    contract: 'memory-host-contract/1',
    routeId: start.plan.routeId,
    executionId: start.executionId,
    lastPosition: { ...start.plan.points[start.plan.points.length - 1]! },
    lastObservation: {
      worldId: start.sample.worldId,
      dim: start.sample.dim,
      sessionId: start.sample.sessionId,
      observedAt: start.sample.observedAt,
      onGround: start.sample.onGround,
      inWater: start.sample.inWater,
    },
    confirmedSegments: 1,
    remainingPoints: [],
    consumption: { placed: [] },
    confirmed: true,
    trace: [{ pos: { ...start.sample.pos }, ts: start.sample.observedAt }],
  };
}

/**
 * The precheck path has no memory-write dependency at all: `WalkPathEnvironment`
 * exposes only world scope, body facts, a sample read and the body port. This
 * harness proves the port is untouched; there is no writable memory seam.
 */
function harness(overrides: Partial<WalkPathEnvironment> = {}, routeId?: string) {
  const bodyCalls = { move: 0, stop: 0 };
  const executionId = routeId === undefined ? 'host-execution' : `exec_${routeId}`;
  const { sample: sampleOverride, ...rest } = overrides;
  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(START.x, START.y, START.z),
    shapeProvider: fakeProvider,
    sample: sampleOverride === undefined
      ? () => sampleAt(START, { executionId })
      : () => {
          const sample = sampleOverride();
          return sample === null ? null : { ...sample, executionId };
        },
    bodyPort: {
      move: async () => {
        bodyCalls.move += 1;
        throw new Error('precheck must not call bodyPort.move');
      },
      stop: () => {
        bodyCalls.stop += 1;
      },
    },
    now: () => NOW,
    ...rest,
  };
  return { environment, bodyCalls };
}

/** Entry bound to a recording executor; precheck failures must never reach it. */
function entry(reg: RoutePlanRegistryImpl) {
  const starts: WalkPathStartContext[] = [];
  const walkPath = createWalkPath(reg, {
    execute: async (start) => {
      starts.push(start);
      return arrived(start);
    },
  });
  return { walkPath, starts };
}

describe('walkPath start precheck — handle lifecycle', () => {
  it('reports route_not_found for an id the registry never issued', async () => {
    const { walkPath, starts } = entry(registry());
    const { environment, bodyCalls } = harness({}, 'rt_missing');

    const result = await walkPath({ routeId: 'rt_missing', deadlineMs: 10_000 }, environment);

    expect(result).toMatchObject({
      outcome: 'INVALIDATED',
      contract: 'memory-host-contract/1',
      routeId: 'rt_missing',
      confirmed: false,
      confirmedSegments: 0,
      remainingPoints: [],
      trace: [],
    });
    expect(result.invalidation).toMatchObject({ reason: 'route_not_found', segment: 0 });
    expect(result.executionId).toBe('exec_rt_missing');
    expect(result.consumption?.placed).toEqual([]);
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('consumes on the first call, hands the start to the executor, and rejects reuse', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({}, plan.routeId);
    const request = { routeId: plan.routeId, deadlineMs: 10_000 };

    const first = await walkPath(request, environment);
    expect(first.outcome).toBe('ARRIVED');
    expect(first.confirmed).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      plan: { routeId: plan.routeId },
      sample: { pos: START },
      request,
    });
    expect(starts[0]!.executionId).toBe(first.executionId);

    const second = await walkPath(request, environment);
    expect(second.outcome).toBe('INVALIDATED');
    expect(second.invalidation).toMatchObject({ reason: 'route_consumed', segment: 0 });
    expect(second.executionId).toBe(first.executionId);
    expect(second.confirmed).toBe(false);
    expect(starts).toHaveLength(1);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('rejects an expired handle as route_expired without executing', async () => {
    const reg = registry();
    const plan = reg.register(draft({ expiresAt: NOW - 1 }));
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({}, plan.routeId);

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

    expect(result.invalidation).toMatchObject({ reason: 'route_expired' });
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('rejects a candidate plan as route_not_executable without executing', async () => {
    const reg = registry();
    const plan = reg.register(draft({ executable: false, confidence: 'candidate' }));
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({}, plan.routeId);

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

    expect(result.invalidation).toMatchObject({ reason: 'route_not_executable' });
    expect(result.problem).toMatchObject({ kind: 'route_invalidated' });
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('rejects a measured start that moved more than the 0.05 default', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const moved = { x: START.x + 0.06, y: START.y, z: START.z };
    const { environment, bodyCalls } = harness({ sample: () => sampleAt(moved) }, plan.routeId);
    const request = { routeId: plan.routeId, deadlineMs: 10_000 };

    const result = await walkPath(request, environment);

    expect(result).toMatchObject({ outcome: 'INVALIDATED', confirmed: false, confirmedSegments: 0 });
    expect(result.invalidation).toMatchObject({ reason: 'route_start_changed', segment: 0 });
    expect(result.lastPosition).toEqual(moved);
    expect(result.lastObservation).toMatchObject({ worldId: 'world', dim: 'overworld', sessionId: 's1' });
    expect(result.remainingPoints).toEqual(plan.points);
    expect(result.remainingPoints).not.toBe(plan.points);
    expect(result.consumption?.placed).toEqual([]);
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });

    // A failed start still consumed the handle; it cannot be retried.
    const retry = await walkPath(request, environment);
    expect(retry.invalidation).toMatchObject({ reason: 'route_consumed' });
  });

  it('hands a start within 0.05 to the executor and passes its result through', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const close = { x: START.x + 0.049, y: START.y, z: START.z };
    const { environment, bodyCalls } = harness({ sample: () => sampleAt(close) }, plan.routeId);
    const request = { routeId: plan.routeId, deadlineMs: 10_000 };

    const result = await walkPath(request, environment);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.sample.pos).toEqual(close);
    expect(starts[0]!.plan.points).toEqual(plan.points);
    expect(starts[0]!.executionId).toBe('exec_' + plan.routeId);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('keeps the consumed handle pinned until the bound executor settles', async () => {
    const reg = new RoutePlanRegistryImpl({ capacity: 1, now: () => NOW });
    const plan = reg.register(draft());
    let registrationWhileExecuting: unknown;
    const walkPath = createWalkPath(reg, {
      execute: async (start) => {
        // With capacity 1, a register can only fail while this consumed handle
        // is pinned; an early release would silently evict it instead.
        try {
          reg.register(draft());
        } catch (error) {
          registrationWhileExecuting = error;
        }
        return arrived(start);
      },
    });

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, harness({}, plan.routeId).environment);

    expect(result.outcome).toBe('ARRIVED');
    expect(registrationWhileExecuting).toBeInstanceOf(RoutePlanRegistryCapacityError);
    // The pin was released after the executor settled, so the consumed tombstone
    // may now be evicted and a new plan registered.
    expect(() => reg.register(draft())).not.toThrow();
  });
});

describe('walkPath start precheck — scope, session and body gates', () => {
  it('rejects world, dimension and session mismatches as scope_mismatch', async () => {
    const cases = [
      ['world', { worldId: 'other-world' }],
      ['dimension', { dim: 'the_nether' }],
      ['session', { sessionId: 's2' }],
    ] as const;

    for (const [label, override] of cases) {
      const reg = registry();
      const plan = reg.register(draft());
      const { walkPath, starts } = entry(reg);
      const { environment, bodyCalls } = harness(override, plan.routeId);

      const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

      expect(result.invalidation?.reason, label).toBe('scope_mismatch');
      expect(result.confirmed).toBe(false);
      expect(starts).toHaveLength(0);
      expect(bodyCalls).toEqual({ move: 0, stop: 0 });
    }
  });

  it('fails closed on a null sample as route_start_unmeasured', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({ sample: () => null }, plan.routeId);
    const request = { routeId: plan.routeId, deadlineMs: 10_000 };

    const result = await walkPath(request, environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'route_start_unmeasured' });
    expect(result.lastPosition).toBeUndefined();
    expect(result.lastObservation).toBeUndefined();
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });

    const retry = await walkPath(request, environment);
    expect(retry.invalidation).toMatchObject({ reason: 'route_consumed' });
  });

  it('rejects a start sample from another execution identity', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const environment: WalkPathEnvironment = {
      ...SCOPE,
      body: bodyAt(START.x, START.y, START.z),
      shapeProvider: fakeProvider,
      sample: () => sampleAt(START, { executionId: 'walk-1' }),
      bodyPort: {
        move: async () => {
          throw new Error('precheck must not call bodyPort.move');
        },
        stop: () => {},
      },
      now: () => NOW,
    };

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ reason: 'route_start_unmeasured' });
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(result.lastPosition).toBeUndefined();
    expect(starts).toHaveLength(0);
  });

  it('fails closed when the sample belongs to an old session', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({
      sample: () => sampleAt(START, { sessionId: 'old-session' }),
    }, plan.routeId);

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

    expect(result.invalidation).toMatchObject({ reason: 'scope_mismatch' });
    expect(result.problem).toMatchObject({ kind: 'scope_changed' });
    expect(result.lastPosition).toEqual(START);
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });

  it('fails closed on a disconnected body as route_body_unavailable', async () => {
    const reg = registry();
    const plan = reg.register(draft());
    const { walkPath, starts } = entry(reg);
    const { environment, bodyCalls } = harness({
      sample: () => sampleAt(START, { connected: false }),
    }, plan.routeId);

    const result = await walkPath({ routeId: plan.routeId, deadlineMs: 10_000 }, environment);

    expect(result.invalidation).toMatchObject({ reason: 'route_body_unavailable' });
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(starts).toHaveLength(0);
    expect(bodyCalls).toEqual({ move: 0, stop: 0 });
  });
});
