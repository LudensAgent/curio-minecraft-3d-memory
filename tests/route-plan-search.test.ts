import { describe, expect, it } from 'vitest';

import { planRoute, RouteVerifier } from '../src/index.js';
import { bodyAt, fakeProvider, obs, STONE } from './fakes.js';
import {
  capturePlanningState,
  loosePlanRequest,
  makePlanEnvironment,
  makePlanParts,
  makeSample,
  NOW,
  openFloorMap,
  planOf,
  planRequest,
  replayAdvancingSearchSource,
  replaySearchSource,
  runSearch,
  searchSource,
  straightCorridor,
  TestClock,
  wallOffSingleCell,
} from './route-plan-fixtures.js';
import { verifyRoutePoints } from '../src/navigation/route-plan-support.js';

function switchState(
  map: ReturnType<typeof openFloorMap>,
  pos: { x: number; y: number; z: number },
  sequence = 10,
): void {
  // A later real observation replaces the fixture AIR; reusing the fixture
  // timestamp would be an unordered same-timestamp conflict and STALE evidence.
  map.observe(obs(STONE, pos, { observedAt: NOW - 500, sequence }));
}

describe('planRoute — search source', () => {
  it('plans a verified OPEN walk route from the measured start to the exact target', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });
    const before = capturePlanningState(parts);

    const result = await planRoute(planRequest(), environment);
    const plan = planOf(result);

    expect(plan.backend).toBe('spatial_library');
    expect(plan.source).toBe('search');
    expect(plan.confidence).toBe('verified');
    expect(plan.executable).toBe(true);
    expect(plan.points).toEqual([
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ]);
    expect(plan.cost).toBe(2);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.points).toEqual(plan.points);
    expect(plan.start).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(plan.requestedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.resolvedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.boundaries).toEqual([]);
    expect(plan.unsupported).toBeUndefined();
    expect(plan.verdict).toBe('OPEN');
    expect(plan.evidence).toMatchObject({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      ruleVersion: 'fake-1',
    });
    expect(plan.evidence.dependencies?.length).toBeGreaterThan(0);
    expect(plan.expiresAt).toBeLessThanOrEqual(plan.evidence.validUntil);
    expect(plan.routeId).toMatch(/^rt_/);
    expect(parts.registry.size).toBe(1);

    // Planning is read-only for the map: no evidence, pin, residency or dirty
    // state was written by the search adapter or the verifier.
    expect(capturePlanningState(parts)).toEqual(before);

    const consumed = parts.registry.consume(plan.routeId, {
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
    }, NOW);
    expect('kind' in consumed).toBe(false);
  });

  it('accepts a measured zero-edge completion without fabricating movement', async () => {
    const clock = new TestClock();
    const map = straightCorridor(1, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ to: { x: 0.5, y: 0, z: 0.5 } }), environment);
    const plan = planOf(result);

    expect(plan.points).toEqual([{ x: 0.5, y: 0, z: 0.5 }]);
    expect(plan.cost).toBe(0);
    expect(plan.confidence).toBe('verified');
    expect(plan.executable).toBe(true);
    expect(plan.verdict).toBe('OPEN');
    expect(plan.boundaries).toEqual([]);
    // No evaluator evidence was used; the plan TTL is the bounded validity.
    expect(plan.evidence.validUntil).toBe(NOW + 30_000);
    expect(plan.expiresAt).toBe(NOW + 30_000);
  });

  it('reports NO_VERIFIED_PATH as no_path without claiming the world is unreachable', async () => {
    const clock = new TestClock();
    const map = openFloorMap([{ x: 0, z: 0 }], { now: clock.now });
    wallOffSingleCell(map);
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toEqual({ kind: 'no_path' });
    expect(result.message).toContain('does not prove the target is unreachable');
    expect(parts.registry.size).toBe(0);
  });

  it('reports insufficient evidence as unobserved, never as no_path', async () => {
    const clock = new TestClock();
    const map = straightCorridor(2, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ to: { x: 3.5, y: 0, z: 0.5 } }), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem?.kind).toBe('unobserved');
    if (result.problem?.kind !== 'unobserved') throw new Error('expected unobserved');
    expect(result.problem.gap.reason).toBe('unknown');
  });

  it('does not treat expired evidence as OPEN and reports STALE as stale', async () => {
    const clock = new TestClock(5000);
    const map = straightCorridor(3, { now: clock.now, validityWindowMs: 100 });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'stale' });
    if (result.problem?.kind !== 'stale') throw new Error('expected stale');
    expect(Number.isFinite(result.problem.pos.x)).toBe(true);
  });

  it('reports unsupported-only boundary evidence as unsupported geometry', async () => {
    const clock = new TestClock();
    const map = openFloorMap([{ x: 0, z: 0 }], { now: clock.now });
    wallOffSingleCell(map);
    // Replace the +X wall with a state the fake shape rules cannot interpret.
    const unknownState = { name: 'minecraft:mystery', properties: {} };
    map.observe(obs(unknownState, { x: 1, y: 0, z: 0 }, { observedAt: NOW - 500, sequence: 20 }));
    map.observe(obs(unknownState, { x: 1, y: 1, z: 0 }, { observedAt: NOW - 500, sequence: 21 }));
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unsupported_geometry' });
  });

  it('reports a point-cap overflow as a points budget, not a node budget', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      maxRoutePoints: 2,
    });

    const result = await planRoute(planRequest(), environment);
    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'points' });
  });

  it('returns a non-executable candidate with boundaries when verification finds a current block', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const snapshot = runSearch(map, { x: 2.5, y: 0, z: 0.5 }, clock);
    expect(snapshot.state).toBe('FOUND');

    // The search snapshot is now old: the middle stance has since become solid.
    switchState(map, { x: 1, y: 0, z: 0 }, 10);
    switchState(map, { x: 1, y: 1, z: 0 }, 11);

    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: replaySearchSource(snapshot) });
    const result = await planRoute(planRequest(), environment);
    const plan = planOf(result);

    expect(plan.confidence).toBe('candidate');
    expect(plan.executable).toBe(false);
    expect(plan.verdict).toBe('BLOCKED');
    expect(plan.boundaries.length).toBeGreaterThan(0);
    expect(plan.boundaries.every((boundary) => boundary.status === 'BLOCKED')).toBe(true);
    expect(plan.boundaries[0]).toMatchObject({
      stance: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 0, z: 0.5 },
    });

    const consumed = parts.registry.consume(
      plan.routeId,
      { worldId: 'world', dim: 'overworld', sessionId: 's1' },
      NOW,
    );
    expect(consumed).toMatchObject({ kind: 'route_not_executable', routeId: plan.routeId });
  });

  it('enforces request node/edge budgets without silently truncating', async () => {
    const clock = new TestClock();
    const map = straightCorridor(11, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(
      planRequest({ to: { x: 10.5, y: 0, z: 0.5 }, constraints: { maxEdges: 4 } }),
      environment,
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'edges' });
  });

  it('maps a search node cap to a structured node budget', async () => {
    const clock = new TestClock();
    const map = straightCorridor(11, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(
      planRequest({ to: { x: 10.5, y: 0, z: 0.5 }, constraints: { maxNodes: 1 } }),
      environment,
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'nodes' });
  });

  it('caps a large slice by the remaining node budget', async () => {
    const clock = new TestClock();
    // Two edges are needed (three nodes) but only two nodes are allowed.
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      budgetPerSlice: 64,
    });

    const result = await planRoute(
      planRequest({ constraints: { maxNodes: 2 } }),
      environment,
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'nodes' });
    expect(parts.registry.size).toBe(0);
  });

  it('does not exceed maxNodes on a long corridor even with a large slice', async () => {
    const clock = new TestClock();
    const map = straightCorridor(11, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      budgetPerSlice: 256,
    });

    const result = await planRoute(
      planRequest({ to: { x: 10.5, y: 0, z: 0.5 }, constraints: { maxNodes: 2 } }),
      environment,
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'nodes' });
    expect(parts.registry.size).toBe(0);
  });

  it('rejects an over-budget terminal snapshot returned by advance before registering', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const found = runSearch(map, { x: 2.5, y: 0, z: 0.5 }, clock);
    const overBudget = {
      ...found,
      counters: { ...found.counters, nodesReached: 5 },
    };
    const pending = {
      ...found,
      state: 'PENDING' as const,
      candidate: null,
      counters: { ...found.counters, nodesReached: 1, edgesEvaluated: 0 },
    };
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: replayAdvancingSearchSource(pending, overBudget),
      budgetPerSlice: 64,
    });

    const result = await planRoute(
      planRequest({ constraints: { maxNodes: 2 } }),
      environment,
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'nodes' });
    expect(parts.registry.size).toBe(0);
  });

  it('accepts a one-edge target with maxNodes 2 and a zero-edge target with maxNodes 1', async () => {
    const clock = new TestClock();
    const oneEdgeMap = straightCorridor(2, { now: clock.now });
    const oneEdgeParts = makePlanParts({ map: oneEdgeMap, clock });
    const oneEdge = await planRoute(
      planRequest({ to: { x: 1.5, y: 0, z: 0.5 }, constraints: { maxNodes: 2 } }),
      makePlanEnvironment(oneEdgeParts, {
        search: searchSource(oneEdgeMap, clock),
        budgetPerSlice: 64,
      }),
    );
    expect(planOf(oneEdge).points).toHaveLength(2);

    const zeroEdgeMap = straightCorridor(1, { now: clock.now });
    const zeroEdgeParts = makePlanParts({ map: zeroEdgeMap, clock });
    const zeroEdge = await planRoute(
      planRequest({ to: { x: 0.5, y: 0, z: 0.5 }, constraints: { maxNodes: 1 } }),
      makePlanEnvironment(zeroEdgeParts, {
        search: searchSource(zeroEdgeMap, clock),
        budgetPerSlice: 64,
      }),
    );
    expect(planOf(zeroEdge).points).toHaveLength(1);
  });

  it('accepts exactly maxEdges evaluations and rejects one fewer', async () => {
    const clock = new TestClock();
    const acceptedMap = straightCorridor(3, { now: clock.now });
    const acceptedParts = makePlanParts({ map: acceptedMap, clock });
    const accepted = await planRoute(
      planRequest({ constraints: { maxEdges: 5 } }),
      makePlanEnvironment(acceptedParts, {
        search: searchSource(acceptedMap, clock),
        budgetPerSlice: 64,
      }),
    );
    expect(planOf(accepted).confidence).toBe('verified');

    const rejectedMap = straightCorridor(3, { now: clock.now });
    const rejectedParts = makePlanParts({ map: rejectedMap, clock });
    const rejected = await planRoute(
      planRequest({ constraints: { maxEdges: 4 } }),
      makePlanEnvironment(rejectedParts, {
        search: searchSource(rejectedMap, clock),
        budgetPerSlice: 64,
      }),
    );
    expect(rejected.plan).toBeUndefined();
    expect(rejected.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'edges' });
    expect(rejectedParts.registry.size).toBe(0);
  });

  it('accepts a plan that uses exactly the requested node budget', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      budgetPerSlice: 64,
    });

    const result = await planRoute(
      planRequest({ constraints: { maxNodes: 3 } }),
      environment,
    );
    const plan = planOf(result);

    expect(plan.confidence).toBe('verified');
    expect(plan.points).toHaveLength(3);
    expect(parts.registry.size).toBe(1);
  });
});

describe('planRoute — request and environment boundaries', () => {
  function baseEnvironment() {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    return {
      map,
      parts,
      clock,
      environment: makePlanEnvironment(parts, { search: searchSource(map, clock) }),
    };
  }

  it('rejects unknown request fields', async () => {
    const { environment } = baseEnvironment();
    const raw = loosePlanRequest({ teleport: true });
    const result = await planRoute(raw, environment);
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(result.message).toContain('teleport');
  });

  it('rejects non-walk modes instead of approximating them', async () => {
    const { environment } = baseEnvironment();
    const result = await planRoute(loosePlanRequest({ mode: 'swim' }), environment);
    expect(result.problem).toMatchObject({ kind: 'unsupported_mode', mode: 'swim' });
  });

  it('rejects near and reach_block arrival', async () => {
    const { environment } = baseEnvironment();
    const near = await planRoute(loosePlanRequest({ arrival: { kind: 'near', radius: 1 } }), environment);
    expect(near.problem).toMatchObject({ kind: 'unsupported_arrival' });

    const reach = await planRoute(loosePlanRequest({ arrival: { kind: 'reach_block' } }), environment);
    expect(reach.problem).toMatchObject({ kind: 'unsupported_arrival' });
  });

  it('rejects a non-empty avoid constraint', async () => {
    const { environment } = baseEnvironment();
    const result = await planRoute(
      planRequest({ constraints: { avoid: [{ x: 1.5, y: 0, z: 0.5 }] } }),
      environment,
    );
    expect(result.problem).toMatchObject({ kind: 'unsupported_constraint', constraint: 'avoid' });
  });

  it('rejects unsupported target geometry without rounding it', async () => {
    const { environment } = baseEnvironment();
    const offLattice = await planRoute(planRequest({ to: { x: 1.7, y: 0, z: 0.5 } }), environment);
    expect(offLattice.problem).toMatchObject({ kind: 'unsupported_geometry' });

    const otherHeight = await planRoute(planRequest({ to: { x: 1.5, y: 1, z: 0.5 } }), environment);
    expect(otherHeight.problem).toMatchObject({ kind: 'unsupported_geometry' });
  });

  it('rejects invalid budgets, deadlines and history-without-pathId', async () => {
    const { environment } = baseEnvironment();
    const tooManyNodes = await planRoute(planRequest({ constraints: { maxNodes: 99_999 } }), environment);
    expect(tooManyNodes.problem).toMatchObject({ kind: 'invalid_request' });

    const past = await planRoute(planRequest({ deadlineMs: NOW }), environment);
    expect(past.problem).toMatchObject({ kind: 'timeout' });

    const notFinite = await planRoute(planRequest({ deadlineMs: Number.NaN }), environment);
    expect(notFinite.problem).toMatchObject({ kind: 'invalid_request' });

    const historyWithoutPath = await planRoute(planRequest({ source: 'history' }), environment);
    expect(historyWithoutPath.problem).toMatchObject({ kind: 'invalid_request' });
    expect(historyWithoutPath.message).toContain('pathId');
  });

  it('fails without a measured sample or with a different scope', async () => {
    const { parts, map, clock } = baseEnvironment();

    const noSample = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, { search: searchSource(map, clock), sample: () => null }),
    );
    expect(noSample.problem).toMatchObject({ kind: 'unavailable' });

    const wrongScope = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        sample: () => makeSample({ x: 0.5, y: 0, z: 0.5 }, { sessionId: 's2' }),
      }),
    );
    expect(wrongScope.problem).toMatchObject({ kind: 'scope_changed' });

    const dead = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        sample: () => makeSample({ x: 0.5, y: 0, z: 0.5 }, { alive: false }),
      }),
    );
    expect(dead.problem).toMatchObject({ kind: 'unavailable' });
  });

  it('rejects unusable body dimensions', async () => {
    const { parts, map, clock } = baseEnvironment();
    const result = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        body: bodyAt(0.5, 0, 0.5, 0, 1.8),
      }),
    );
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
  });

  it('rejects a host verifier without a usable point limit', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      verifier: {} as RouteVerifier,
    });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
  });

  it('returns a points budget before register when a route exceeds the verifier limit', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const verifier = new RouteVerifier(map, { now: clock.now, maxRouteLength: 2 });
    // Pre-register a valid route so the post-call clear assertion is meaningful.
    verifier.register({
      worldId: 'world',
      dim: 'overworld',
      sessionId: 's1',
      mode: 'walk',
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
    });
    expect(verifier.status()).not.toBeNull();
    const outcome = await verifyRoutePoints({
      verifier,
      scope: { worldId: 'world', dim: 'overworld', sessionId: 's1' },
      body: bodyAt(0.5, 0, 0.5),
      shapeProvider: fakeProvider,
      points: [
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0, z: 0.5 },
        { x: 2.5, y: 0, z: 0.5 },
      ],
      now: clock.now,
      deadlineMs: NOW + 10_000,
      budget: 8,
      wait: async () => {},
      cancellationOrigin: 'unknown',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a verifier point-limit failure');
    expect(outcome.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'points' });
    expect(verifier.status()).toBeNull();
  });

  it('rejects maxRoutePoints above the verifier limit as invalid_request', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const limitedVerifier = new RouteVerifier(map, { now: clock.now, maxRouteLength: 2 });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      verifier: limitedVerifier,
      maxRoutePoints: 2000,
    });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'invalid_request' });
    expect(parts.registry.size).toBe(0);
  });

  it('defaults maxRoutePoints to the verifier limit and returns a points budget', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const limitedVerifier = new RouteVerifier(map, { now: clock.now, maxRouteLength: 2 });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      verifier: limitedVerifier,
    });

    const result = await planRoute(planRequest(), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'budget_exhausted', limit: 'points' });
    expect(parts.registry.size).toBe(0);
  });

  it('accepts a route exactly at the verifier point limit', async () => {
    const clock = new TestClock();
    const map = straightCorridor(2, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const limitedVerifier = new RouteVerifier(map, { now: clock.now, maxRouteLength: 2 });
    const environment = makePlanEnvironment(parts, {
      search: searchSource(map, clock),
      verifier: limitedVerifier,
    });

    const result = await planRoute(
      planRequest({ to: { x: 1.5, y: 0, z: 0.5 } }),
      environment,
    );
    const plan = planOf(result);

    expect(plan.confidence).toBe('verified');
    expect(plan.points).toHaveLength(2);

    const zeroMap = straightCorridor(1, { now: clock.now });
    const zeroParts = makePlanParts({ map: zeroMap, clock });
    const zeroVerifier = new RouteVerifier(zeroMap, { now: clock.now, maxRouteLength: 2 });
    const zero = await planRoute(
      planRequest({ to: { x: 0.5, y: 0, z: 0.5 } }),
      makePlanEnvironment(zeroParts, {
        search: searchSource(zeroMap, clock),
        verifier: zeroVerifier,
      }),
    );
    expect(planOf(zero).points).toHaveLength(1);
  });

  it('reports cancellation before reading a search', async () => {
    const { parts, map, clock } = baseEnvironment();
    const controller = new AbortController();
    controller.abort('caller stopped');
    const result = await planRoute(
      planRequest(),
      makePlanEnvironment(parts, {
        search: searchSource(map, clock),
        signal: controller.signal,
        cancellationOrigin: 'user',
      }),
    );
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'user', reason: 'caller stopped' });
  });
});
