import { describe, expect, it } from 'vitest';

import { planRoute } from '../src/index.js';
import type { RouteSearchSource } from '../src/index.js';
import { obs, STONE } from './fakes.js';
import {
  historyWith,
  makePlanEnvironment,
  makePlanParts,
  openFloorMap,
  planOf,
  planRequest,
  searchSource,
  straightCorridor,
  straightFragment,
  TestClock,
  wallOffSingleCell,
} from './route-plan-fixtures.js';

describe('planRoute — auto source', () => {
  it('uses an explicit executable history fragment first', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history, search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ source: 'auto', pathId: 'frag' }), environment);
    const plan = planOf(result);

    expect(plan.source).toBe('history');
    expect(plan.pathId).toBe('frag');
    expect(plan.executable).toBe(true);
    expect(parts.registry.size).toBe(1);
  });

  it('falls back to search when the historical fragment is currently blocked', async () => {
    const clock = new TestClock();
    const map = openFloorMap(
      [
        { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
        { x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 },
      ],
      { now: clock.now },
    );
    // The straight historical route is blocked; an open detour remains.
    map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 4500, sequence: 10 }));
    map.observe(obs(STONE, { x: 1, y: 1, z: 0 }, { observedAt: 4500, sequence: 11 }));

    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history, search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ source: 'auto', pathId: 'frag' }), environment);
    const plan = planOf(result);

    expect(plan.source).toBe('search');
    expect(plan.pathId).toBeUndefined();
    expect(plan.confidence).toBe('verified');
    expect(plan.executable).toBe(true);
    expect(plan.resolvedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.points.some((point) => point.z === 1.5)).toBe(true);
  });

  it('falls back to search when the historical endpoint is nearer than the requested target', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 2)]); // ends at 1.5
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history, search: searchSource(map, clock) });

    const result = await planRoute(
      planRequest({ source: 'auto', pathId: 'frag', to: { x: 2.5, y: 0, z: 0.5 } }),
      environment,
    );
    const plan = planOf(result);

    expect(plan.source).toBe('search');
    expect(plan.resolvedTarget).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(plan.executable).toBe(true);
  });

  it('uses search directly when no pathId is supplied', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ source: 'auto' }), environment);
    expect(planOf(result).source).toBe('search');
  });

  it('never reports a missing history as "no path" when search is unavailable', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      history: historyWith([straightFragment('other', 3)]),
    });

    const result = await planRoute(planRequest({ source: 'auto', pathId: 'frag' }), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(result.problem?.kind).not.toBe('no_path');
  });

  it('does not fall back to search after history planning is cancelled', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const controller = new AbortController();
    let searchStarted = false;
    const forbiddenSearch: RouteSearchSource = {
      start: () => {
        searchStarted = true;
      },
      advance: () => {
        throw new Error('search must not start after cancellation');
      },
      snapshot: () => {
        throw new Error('search must not start after cancellation');
      },
      cancel: () => {},
    };

    const result = await planRoute(
      planRequest({ source: 'auto', pathId: 'frag' }),
      makePlanEnvironment(parts, {
        history,
        search: forbiddenSearch,
        signal: controller.signal,
        cancellationOrigin: 'user',
        budgetPerSlice: 1,
        wait: async () => controller.abort('caller stopped'),
      }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'user' });
    expect(searchStarted).toBe(false);
  });

  it('reports the search conclusion when both history and search fail', async () => {
    const clock = new TestClock();
    const map = openFloorMap([{ x: 0, z: 0 }], { now: clock.now });
    wallOffSingleCell(map);
    const history = historyWith([straightFragment('frag', 2)]);
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history, search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ source: 'auto', pathId: 'frag' }), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toEqual({ kind: 'no_path' });
  });
});
