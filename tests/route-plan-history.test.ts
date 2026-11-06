import { describe, expect, it } from 'vitest';

import { FragmentStore, planRoute, RouteVerifier } from '../src/index.js';

import { obs, STONE } from './fakes.js';
import {
  capturePlanningState,
  historyWith,
  makePlanEnvironment,
  makePlanParts,
  makeSample,
  NOW,
  planOf,
  planRequest,
  straightCorridor,
  straightFragment,
  TestClock,
} from './route-plan-fixtures.js';

function historyRequest(pathId: string, to = { x: 2.5, y: 0, z: 0.5 }) {
  return planRequest({ source: 'history', pathId, to });
}

describe('planRoute — history source', () => {
  it('re-verifies an explicit fragment and reports it as historical geometry', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history });
    const before = capturePlanningState(parts, history);

    const result = await planRoute(historyRequest('frag'), environment);
    const plan = planOf(result);

    expect(plan.source).toBe('history');
    expect(plan.pathId).toBe('frag');
    expect(plan.kind).toBe('walked');
    expect(plan.backend).toBe('spatial_library');
    expect(plan.confidence).toBe('verified');
    expect(plan.executable).toBe(true);
    expect(plan.verdict).toBe('OPEN');
    expect(plan.points).toEqual([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ]);
    expect(plan.requestedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.resolvedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.boundaries).toEqual([]);
    expect(plan.routeId).toMatch(/^rt_/);

    // Reading history never updates the fragment's uses/timestamps or revision.
    expect(capturePlanningState(parts, history)).toEqual(before);
    const fragment = history.getFragment('frag');
    expect(fragment).not.toBeNull();
    expect(fragment!.uses).toBe(1);
    expect(fragment!.lastUsedAt).toBe(1000);
  });

  it('reports a missing pathId as invalid_request and an unknown fragment as unavailable', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history: historyWith([straightFragment('other', 3)]) });

    const emptyPath = await planRoute(
      planRequest({ source: 'history', pathId: '' }),
      environment,
    );
    expect(emptyPath.problem).toMatchObject({ kind: 'invalid_request' });

    const missing = await planRoute(historyRequest('frag'), environment);
    expect(missing.plan).toBeUndefined();
    expect(missing.problem).toMatchObject({ kind: 'unavailable' });
    expect(missing.message).toContain('frag');
  });

  it('rejects a fragment from another dimension or history store without cross-scope reuse', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });

    const otherDim = historyWith([straightFragment('frag', 3, { dim: 'the_nether' })]);
    const dimResult = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, { history: otherDim }),
    );
    expect(dimResult.problem).toMatchObject({ kind: 'scope_changed' });

    const otherWorld = new FragmentStore('other-world');
    otherWorld.saveFragment(straightFragment('frag', 3, { worldId: 'other-world' }));
    const worldResult = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, { history: otherWorld }),
    );
    expect(worldResult.problem).toMatchObject({ kind: 'scope_changed' });
  });

  it('reports unsupported historical geometry instead of coercing it', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const diagonal = historyWith([
      straightFragment('frag', 2, {
        polyline: [
          { x: 0.5, y: 0, z: 0.5 },
          { x: 1.5, y: 0, z: 1.5 },
        ],
      }),
    ]);

    const result = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, { history: diagonal }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unsupported_geometry' });
  });

  it('rejects a near-unit step as structured unsupported geometry instead of throwing', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const nearUnit = historyWith([
      straightFragment('frag', 2, {
        // Δx = 1.0000005: inside the old 1e-6 precheck but outside the
        // verifier's 1e-9 unit-step contract.
        polyline: [
          { x: 0.5, y: 0, z: 0.5 },
          { x: 1.5000005, y: 0, z: 0.5 },
        ],
      }),
    ]);

    const result = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, { history: nearUnit }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unsupported_geometry' });
    if (result.problem?.kind !== 'unsupported_geometry') throw new Error('expected unsupported geometry');
    expect(result.problem.detail).toContain('one-cell');
  });

  it('keeps a currently blocked historical route as a candidate boundary', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: NOW - 500, sequence: 10 }));
    map.observe(obs(STONE, { x: 1, y: 1, z: 0 }, { observedAt: NOW - 500, sequence: 11 }));
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const before = capturePlanningState(parts, history);

    const result = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, { history }),
    );
    const plan = planOf(result);

    expect(plan.confidence).toBe('candidate');
    expect(plan.executable).toBe(false);
    expect(plan.verdict).toBe('BLOCKED');
    expect(plan.points).toHaveLength(3); // geometry is retained, not deleted
    expect(plan.boundaries.length).toBeGreaterThan(0);
    expect(plan.boundaries.every((boundary) => boundary.status === 'BLOCKED')).toBe(true);
    expect(plan.boundaries[0]).toMatchObject({
      kind: 'blocked',
      status: 'BLOCKED',
      stance: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 0, z: 0.5 },
    });
    expect(history.getFragment('frag')).not.toBeNull();
    expect(capturePlanningState(parts, history)).toEqual(before);
  });

  it('keeps the requested target and the slightly nearer historical endpoint separate', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 2)]); // ends at x = 1.5
    const parts = makePlanParts({ map, clock });

    const result = await planRoute(
      historyRequest('frag', { x: 2.5, y: 0, z: 0.5 }),
      makePlanEnvironment(parts, { history }),
    );
    const plan = planOf(result);

    expect(plan.resolvedTarget).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(plan.requestedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.executable).toBe(false);
    expect(plan.confidence).toBe('candidate');
    expect(plan.unsupported).toMatchObject({ kind: 'unsupported_geometry' });
    if (plan.unsupported?.kind !== 'unsupported_geometry') throw new Error('expected unsupported');
    expect(plan.unsupported.detail).toContain('ends at');
    expect(plan.verdict).toBe('OPEN'); // current evidence supports the geometry itself
  });

  it('refuses a historical route whose start is not the measured position', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });

    const result = await planRoute(
      historyRequest('frag'),
      makePlanEnvironment(parts, {
        history,
        sample: () => makeSample({ x: 1.5, y: 0, z: 0.5 }),
      }),
    );
    const plan = planOf(result);

    expect(plan.start).toEqual({ x: 1.5, y: 0, z: 0.5 });
    expect(plan.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(plan.executable).toBe(false);
    expect(plan.unsupported).toMatchObject({ kind: 'unsupported_geometry' });
    if (plan.unsupported?.kind !== 'unsupported_geometry') throw new Error('expected unsupported');
    expect(plan.unsupported.detail).toContain('starts at');
  });

  it('supports a one-point historical fragment only when the measured target already holds', async () => {
    const clock = new TestClock();
    const map = straightCorridor(1, { now: clock.now });
    const history = historyWith([straightFragment('frag', 1)]);
    const parts = makePlanParts({ map, clock });

    const result = await planRoute(
      historyRequest('frag', { x: 0.5, y: 0, z: 0.5 }),
      makePlanEnvironment(parts, { history }),
    );
    const plan = planOf(result);

    expect(plan.points).toHaveLength(1);
    expect(plan.cost).toBe(0);
    expect(plan.executable).toBe(true);
    expect(plan.confidence).toBe('verified');
  });

  it('rejects search budgets that history cannot consume', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history: historyWith([straightFragment('frag', 3)]) });

    const nodeResult = await planRoute(
      planRequest({ source: 'history', pathId: 'frag', constraints: { maxNodes: 10 } }),
      environment,
    );
    expect(nodeResult.plan).toBeUndefined();
    expect(nodeResult.problem).toMatchObject({ kind: 'unsupported_constraint', constraint: 'search_budget' });

    const edgeResult = await planRoute(
      planRequest({ source: 'history', pathId: 'frag', constraints: { maxEdges: 10 } }),
      environment,
    );
    expect(edgeResult.plan).toBeUndefined();
    expect(edgeResult.problem).toMatchObject({ kind: 'unsupported_constraint', constraint: 'search_budget' });
  });

  it('returns a points budget instead of throwing when history exceeds the verifier limit', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const limitedVerifier = new RouteVerifier(map, { now: clock.now, maxRouteLength: 2 });
    const environment = makePlanEnvironment(parts, {
      history: historyWith([straightFragment('frag', 3)]),
      verifier: limitedVerifier,
    });

    const result = await planRoute(historyRequest('frag'), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'points' });
    expect(parts.registry.size).toBe(0);
  });

  it('reports history as unavailable when no history store was supplied', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });

    const result = await planRoute(historyRequest('frag'), makePlanEnvironment(parts));

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
  });
});
