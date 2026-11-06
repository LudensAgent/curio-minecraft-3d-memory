import { describe, expect, it } from 'vitest';

import {
  createWalkRouteSearchSource,
  WalkRouteSearch,
} from '../src/index.js';
import { concludeWalkSearch } from '../src/navigation/route-search.js';
import type { WalkSearchState } from '../src/index.js';
import { bodyAt, fakeProvider } from './fakes.js';
import { NOW, SESSION, straightCorridor, TestClock, WORLD, DIM } from './route-plan-fixtures.js';

function request(target: { x: number; y: number; z: number }) {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    mode: 'walk' as const,
    body: bodyAt(0.5, 0, 0.5),
    target,
    arrival: { kind: 'exact' as const },
    shapeProvider: fakeProvider,
  };
}

describe('WalkRouteSearch route-planning adapter', () => {
  it('delegates start/advance/snapshot/cancel without copying search state', () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const search = new WalkRouteSearch(map, { now: clock.now });
    const source = createWalkRouteSearchSource(search);

    expect(() => source.snapshot()).toThrow(/before start/);

    source.start(request({ x: 2.5, y: 0, z: 0.5 }));
    let snapshot = source.snapshot();
    expect(snapshot.state).toBe('PENDING');
    expect(source.advance(1)).toEqual(search.status());

    let guard = 0;
    while (snapshot.state === 'PENDING' && guard < 100) {
      snapshot = source.advance(4);
      guard += 1;
    }
    expect(snapshot.state).toBe('FOUND');
    expect(concludeWalkSearch(snapshot.state)).toBe('found');
    expect(snapshot.candidate?.points).toHaveLength(3);
  });

  it('forwards cancel and reports the cancellation conclusion', () => {
    const clock = new TestClock();
    const map = straightCorridor(2, { now: clock.now });
    const search = new WalkRouteSearch(map, { now: clock.now });
    const source = createWalkRouteSearchSource(search);

    source.start(request({ x: 5.5, y: 0, z: 0.5 }));
    source.advance(1);
    source.cancel('test stop');

    const snapshot = source.snapshot();
    expect(snapshot.state).toBe('CANCELLED');
    expect(concludeWalkSearch(snapshot.state)).toBe('cancelled');
  });

  it('maps every search state to one planning conclusion without reinterpretation', () => {
    const expected: Record<WalkSearchState, string> = {
      PENDING: 'pending',
      FOUND: 'found',
      NO_VERIFIED_PATH: 'no_verified_path',
      INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
      UNSUPPORTED: 'unsupported',
      BUDGET_EXHAUSTED: 'budget_exhausted',
      CANCELLED: 'cancelled',
      INVALIDATED: 'invalidated',
    };
    for (const state of Object.keys(expected) as WalkSearchState[]) {
      expect(concludeWalkSearch(state)).toBe(expected[state]);
    }
  });

  it('does not advance the underlying search when only snapshotting', () => {
    const clock = new TestClock();
    const map = straightCorridor(3, { now: clock.now });
    const search = new WalkRouteSearch(map, { now: clock.now });
    const source = createWalkRouteSearchSource(search);

    source.start(request({ x: 2.5, y: 0, z: 0.5 }));
    const before = source.snapshot();
    const after = source.snapshot();
    expect(after.counters).toEqual(before.counters);
    expect(after.computedAt).toBe(NOW);
  });
});
