import { describe, expect, it } from 'vitest';

import { RoutePlanRegistryCapacityError, RoutePlanRegistryImpl } from '../src/index.js';
import type { RoutePlanDraft } from '../src/index.js';

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };
const START = { x: 0.5, y: 0, z: 0.5 };
const END = { x: 1.5, y: 0, z: 0.5 };

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
    evidence: {
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      validUntil: 100_000,
      ruleVersion: 'fake-1',
    },
    expiresAt: 100_000,
    requestedTarget: { ...END },
    resolvedTarget: { ...END },
    start: { ...START },
    ...overrides,
  };
}

describe('RoutePlanRegistry — issuance and single use', () => {
  it('issues a routeId at registration and returns a fresh plan copy', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    expect(plan.routeId).toMatch(/^rt_5000_1$/);
    expect(registry.size).toBe(1);

    const consumed = registry.consume(plan.routeId, SCOPE, 5000);
    expect('kind' in consumed).toBe(false);
    if ('kind' in consumed) throw new Error('expected a plan');
    expect(consumed).not.toBe(plan);
    expect(consumed.points).toEqual(plan.points);
    consumed.points[0]!.x = 99;
    expect(plan.points[0]!.x).toBe(0.5);
  });

  it('consumes once even when the following checks fail', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft({ executable: false, confidence: 'candidate' }));

    const first = registry.consume(plan.routeId, SCOPE, 5000);
    expect(first).toMatchObject({ kind: 'route_not_executable', routeId: plan.routeId });
    const second = registry.consume(plan.routeId, SCOPE, 5000);
    expect(second).toMatchObject({ kind: 'route_consumed', routeId: plan.routeId });
  });

  it('validates the consume clock before touching the handle', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    expect(registry.consume(plan.routeId, SCOPE, Number.NaN)).toMatchObject({ kind: 'invalid_request' });
    // The invalid call did not consume the handle.
    expect('kind' in registry.consume(plan.routeId, SCOPE, 5000)).toBe(false);
  });

  it('never accepts a host-invented routeId', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    expect(registry.consume('rt_fake', SCOPE, 5000)).toEqual({
      kind: 'route_not_found',
      routeId: 'rt_fake',
    });
  });

  it('allows exactly one executable consumption', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    expect('kind' in registry.consume(plan.routeId, SCOPE, 5000)).toBe(false);
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
    registry.release(plan.routeId);
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });

  it('release after a terminal outcome leaves the handle consumed', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());
    expect('kind' in registry.consume(plan.routeId, SCOPE, 5000)).toBe(false);

    registry.release(plan.routeId);
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });
});

describe('RoutePlanRegistry — scope and expiry', () => {
  it('rejects a different world or dimension and consumes the handle', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    const mismatch = registry.consume(plan.routeId, { worldId: 'other', dim: 'overworld', sessionId: 's1' }, 5000);
    expect(mismatch).toMatchObject({
      kind: 'scope_mismatch',
      routeId: plan.routeId,
      expected: SCOPE,
      actual: { worldId: 'other', dim: 'overworld', sessionId: 's1' },
    });
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });

  it('always checks the planning session', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    expect(registry.consume(plan.routeId, { ...SCOPE, sessionId: 's2' }, 5000)).toMatchObject({
      kind: 'scope_mismatch',
    });
  });

  it('expires at the plan expiry or the registry TTL, whichever comes first', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000, ttlMs: 1000 });
    const plan = registry.register(draft({ expiresAt: 100_000 }));

    expect(plan.expiresAt).toBe(6000);
    expect(registry.consume(plan.routeId, SCOPE, 6001)).toEqual({
      kind: 'route_expired',
      routeId: plan.routeId,
      expiresAt: 6000,
    });
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });
});

describe('RoutePlanRegistry — capacity and pinning', () => {
  it('evicts an old handle when capacity is reached', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000, capacity: 2 });
    const first = registry.register(draft());
    const second = registry.register(draft());

    const third = registry.register(draft());
    expect(registry.size).toBe(2);
    expect(registry.consume(first.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_not_found' });
    expect('kind' in registry.consume(second.routeId, SCOPE, 5000)).toBe(false);
    expect('kind' in registry.consume(third.routeId, SCOPE, 5000)).toBe(false);
  });

  it('never evicts a pinned execution handle', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000, capacity: 1 });
    const active = registry.register(draft());
    expect('kind' in registry.consume(active.routeId, SCOPE, 5000)).toBe(false);

    expect(() => registry.register(draft())).toThrow(RoutePlanRegistryCapacityError);
    expect(registry.size).toBe(1);

    registry.release(active.routeId);
    const next = registry.register(draft());
    expect(registry.size).toBe(1);
    expect('kind' in registry.consume(next.routeId, SCOPE, 5000)).toBe(false);
  });

  it('prefers consumed tombstones over unconsumed handles when evicting', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000, capacity: 2 });
    const consumed = registry.register(draft());
    const available = registry.register(draft());
    expect('kind' in registry.consume(consumed.routeId, SCOPE, 5000)).toBe(false);
    registry.release(consumed.routeId);

    registry.register(draft());
    expect(registry.consume(consumed.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_not_found' });
    expect('kind' in registry.consume(available.routeId, SCOPE, 5000)).toBe(false);
  });
});

describe('RoutePlanRegistry — scope invalidation', () => {
  it('rejects a dimension-only mismatch and burns the handle', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const plan = registry.register(draft());

    expect(registry.consume(plan.routeId, { ...SCOPE, dim: 'nether' }, 5000)).toMatchObject({
      kind: 'scope_mismatch',
      routeId: plan.routeId,
      expected: SCOPE,
      actual: { ...SCOPE, dim: 'nether' },
    });
    expect(registry.consume(plan.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });

  it('drops unpinned handles from another session and keeps the current scope', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const stale = registry.register(draft());
    const current = registry.register(draft({
      evidence: { ...draft().evidence, sessionId: 's2' },
    }));

    expect(registry.invalidateScope({ worldId: 'world', dim: 'overworld', sessionId: 's2' })).toBe(1);
    expect(registry.consume(stale.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_not_found' });
    expect('kind' in registry.consume(current.routeId, { ...SCOPE, sessionId: 's2' }, 5000)).toBe(false);
  });

  it('turns a pinned handle into a consumed tombstone until its execution releases it', () => {
    const registry = new RoutePlanRegistryImpl({ now: () => 5000 });
    const active = registry.register(draft());
    expect('kind' in registry.consume(active.routeId, SCOPE, 5000)).toBe(false);

    expect(registry.invalidateScope({ worldId: 'world', dim: 'nether', sessionId: 's9' })).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.consume(active.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });

    registry.release(active.routeId);
    expect(registry.consume(active.routeId, SCOPE, 5000)).toMatchObject({ kind: 'route_consumed' });
  });
});
