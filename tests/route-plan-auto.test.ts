import { describe, expect, it, vi } from 'vitest';

import { planRoute } from '../src/index.js';
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
  it('uses voxel search without reading an otherwise executable historical fragment', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const revision = history.revision;
    const readHistory = vi.spyOn(history, 'getFragment').mockImplementation(() => {
      throw new Error('auto planning must not read legacy fragments');
    });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, { history, search: searchSource(map, clock) });

    const result = await planRoute(planRequest({ source: 'auto', pathId: 'frag' }), environment);
    const plan = planOf(result);

    expect(plan.source).toBe('search');
    expect(plan.pathId).toBeUndefined();
    expect(plan.executable).toBe(true);
    expect(parts.registry.size).toBe(1);
    expect(readHistory).not.toHaveBeenCalled();
    expect(history.revision).toBe(revision);
  });

  it('plans a current detour without being constrained by a blocked historical fragment', async () => {
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

  it('keeps the requested target when a historical endpoint is nearer', async () => {
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

  it.each(['frag', 'missing'])('requires a search source even when pathId is %s', async (pathId) => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const parts = makePlanParts({ map, clock });
    const environment = makePlanEnvironment(parts, {
      history: historyWith([straightFragment('frag', 3)]),
    });

    const result = await planRoute(planRequest({ source: 'auto', pathId }), environment);

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'unavailable' });
    expect(result.problem?.kind).not.toBe('no_path');
  });

  it('cancels the voxel search under the original delegation', async () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const history = historyWith([straightFragment('frag', 3)]);
    const parts = makePlanParts({ map, clock });
    const controller = new AbortController();
    const search = searchSource(map, clock);
    const cancel = vi.spyOn(search, 'cancel');
    const readHistory = vi.spyOn(history, 'getFragment');

    const result = await planRoute(
      planRequest({ source: 'auto', pathId: 'frag' }),
      makePlanEnvironment(parts, {
        history,
        search,
        signal: controller.signal,
        cancellationOrigin: 'user',
        budgetPerSlice: 1,
        wait: async () => controller.abort('caller stopped'),
      }),
    );

    expect(result.plan).toBeUndefined();
    expect(result.problem).toMatchObject({ kind: 'cancelled', by: 'user' });
    expect(cancel).toHaveBeenCalledWith('caller stopped');
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('reports the voxel search conclusion independently of history', async () => {
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
