import { describe, expect, it } from 'vitest';

import * as navigation from '../src/navigation/index.js';
import {
  frontierCandidates,
  inspectRoute,
  NAVIGATION_CAPABILITIES,
  NAVIGATION_CAPABILITY_STATUSES,
  startKnownWalkRoute,
  VoxelMap,
  WalkRouteSearch,
} from '../src/index.js';
import type {
  NavigationCapabilityName,
  NavigationCapabilityStatus,
  WalkSearchRequest,
  WalkSearchSnapshot,
} from '../src/index.js';
import type { BlockState } from '../src/types.js';
import { AIR, bodyAt, fakeProvider, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

const NAMES: readonly NavigationCapabilityName[] = [
  'navigate_to',
  'follow_known_path',
  'inspect_route',
  'frontier_candidates',
  'recall_route',
];

const NO_EFFECTS = {
  movesBody: false,
  turnsHead: false,
  writesLibrary: false,
  pinsSections: false,
  triggersObservation: false,
  startsAction: false,
};

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

/** One standable/air column at each integer XZ cell. */
function floorCells(map: VoxelMap, xs: readonly number[], zs: readonly number[]): void {
  for (const x of xs) {
    for (const z of zs) {
      map.observe(obs(STONE, { x, y: -1, z }));
      map.observe(obs(AIR, { x, y: 0, z }));
      map.observe(obs(AIR, { x, y: 1, z }));
    }
  }
}

function request(overrides: Partial<WalkSearchRequest> = {}): WalkSearchRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(0.5, 0, 0.5),
    target: { x: 1.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    shapeProvider: fakeProvider,
    ...overrides,
  };
}

function drain(search: WalkRouteSearch, budget = 1000): WalkSearchSnapshot {
  let snapshot = search.status();
  if (snapshot === null) throw new Error('expected a started search');
  for (let i = 0; i < 10_000 && snapshot.state === 'PENDING'; i++) snapshot = search.advance(budget);
  return snapshot;
}

function capability(name: NavigationCapabilityName) {
  const found = NAVIGATION_CAPABILITIES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing capability ${name}`);
  return found;
}

describe('navigation capability table', () => {
  it('lists each design §7 name exactly once with a declared status', () => {
    expect(NAVIGATION_CAPABILITIES.map((entry) => entry.name)).toEqual(NAMES);
    expect([...NAVIGATION_CAPABILITY_STATUSES]).toEqual([
      'implemented',
      'read_only',
      'host_approximation',
      'not_implemented',
    ]);
    for (const entry of NAVIGATION_CAPABILITIES) {
      expect(NAVIGATION_CAPABILITY_STATUSES).toContain(entry.status);
      expect(entry.notes.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.contracts)).toBe(true);
      expect(Array.isArray(entry.seams)).toBe(true);
      expect(Array.isArray(entry.supported)).toBe(true);
      expect(Array.isArray(entry.unsupported)).toBe(true);
    }
  });

  it('reports the real entry for each name', () => {
    expect(capability('navigate_to')).toMatchObject({ status: 'not_implemented', entry: null });
    expect(capability('follow_known_path')).toMatchObject({
      status: 'implemented',
      entry: ['startKnownWalkRoute'],
    });
    expect(capability('inspect_route')).toMatchObject({
      status: 'read_only',
      entry: ['inspectRoute'],
    });
    expect(capability('frontier_candidates')).toMatchObject({
      status: 'read_only',
      entry: ['frontierCandidates'],
    });
    expect(capability('recall_route')).toMatchObject({ status: 'not_implemented', entry: null });

    expect(typeof startKnownWalkRoute).toBe('function');
    expect(typeof inspectRoute).toBe('function');
    expect(typeof frontierCandidates).toBe('function');
  });

  it('does not expose the §7 names as runtime entries', () => {
    expect('navigate_to' in navigation).toBe(false);
    expect('follow_known_path' in navigation).toBe(false);
    expect('inspect_route' in navigation).toBe(false);
    expect('frontier_candidates' in navigation).toBe(false);
    expect('recall_route' in navigation).toBe(false);
  });

  it('declares no side effects for not_implemented and read_only names', () => {
    for (const entry of NAVIGATION_CAPABILITIES) {
      if (entry.status === 'not_implemented' || entry.status === 'read_only') {
        expect(entry.effects).toEqual(NO_EFFECTS);
      }
    }
  });

  it('declares the follow_known_path start seam as action-starting but not body-moving', () => {
    expect(capability('follow_known_path').effects).toEqual({
      movesBody: false,
      turnsHead: false,
      writesLibrary: false,
      pinsSections: false,
      triggersObservation: false,
      startsAction: true,
    });
  });

  it('keeps statuses within the declared union', () => {
    const statuses: NavigationCapabilityStatus[] = NAVIGATION_CAPABILITIES.map((entry) => entry.status);
    expect(statuses.every((status) => NAVIGATION_CAPABILITY_STATUSES.includes(status))).toBe(true);
  });
});

describe('frontierCandidates — read-only projection', () => {
  it('projects bounded candidates without selecting, exploring or claiming the gap reachable', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);

    expect(snapshot.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(snapshot.frontiers.length).toBeGreaterThan(0);

    const result = frontierCandidates(snapshot);

    expect(result.source).toBe('walk_search_snapshot');
    expect(result.state).toBe(snapshot.state);
    expect(result.selected).toBe(false);
    expect(result.explorationStarted).toBe(false);
    expect(result.candidates).toHaveLength(snapshot.frontiers.length);
    expect(result.truncated).toBe(snapshot.counters.frontierLimitReached);
    expect(result.unavailableHistoricalCount).toBe(snapshot.counters.unavailableHistoricalReported);
    expect(result.unavailableHistoricalTruncated).toBe(snapshot.counters.unavailableHistoricalLimitReached);

    for (const [index, candidate] of result.candidates.entries()) {
      const source = snapshot.frontiers[index]!;
      expect(candidate.pos).toEqual(source.to);
      expect(candidate.stance).toEqual(source.stance);
      expect(candidate.gap).toEqual(source.gap);
      expect(candidate.reachability).toBe('OPEN'); // the stance only
      expect(candidate.historicalConnection).toBe('unknown');
      expect(candidate.basis).toEqual(source.basis);
      expect(candidate.reason).toBe(source.reason);
      expect(candidate.computedAt).toBe(source.computedAt);
      expect(candidate.validUntil).toBe(source.validUntil);
    }
  });

  it('returns no candidates for an empty map and never invents reachability', () => {
    const map = new VoxelMap('world');

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);

    expect(snapshot.state).toBe('INSUFFICIENT_EVIDENCE');
    const result = frontierCandidates(snapshot);
    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.candidates).toEqual([]);
  });

  it('returns fresh copies; mutating them never reaches the snapshot', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);
    const result = frontierCandidates(snapshot);
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();

    candidate!.pos.x = 12_345;
    candidate!.stance.x = 12_345;
    candidate!.gap[0]!.x = 12_345;

    expect(snapshot.frontiers[0]!.to.x).not.toBe(12_345);
    expect(snapshot.frontiers[0]!.stance.x).not.toBe(12_345);
    expect(snapshot.frontiers[0]!.gap[0]!.x).not.toBe(12_345);
  });
});

describe('inspectRoute — read-only projection', () => {
  it('reports a FOUND candidate without turning it into arrival or execution', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);

    expect(snapshot.state).toBe('FOUND');
    expect(snapshot.candidate).not.toBeNull();

    const inspection = inspectRoute(snapshot);

    expect(inspection.source).toBe('walk_search_snapshot');
    expect(inspection.state).toBe('FOUND');
    expect(inspection.candidate).toEqual(snapshot.candidate);
    expect(inspection.candidate).not.toBe(snapshot.candidate);
    expect(inspection.arrivalConfirmed).toBe(false);
    expect(inspection.executionStarted).toBe(false);
    expect(inspection.counters).toEqual(snapshot.counters);
    expect(inspection.limits).toEqual(snapshot.limits);
    expect(inspection.computedAt).toBe(snapshot.computedAt);
    expect(inspection.validUntil).toBe(snapshot.validUntil);
    // A FOUND search can still carry unrelated boundary candidates; none of
    // them are selected or presented as the found route.
    expect(inspection.frontiers).toHaveLength(snapshot.frontiers.length);
  });

  it('reports blocked boundaries and no candidate for an enclosed start', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0], [0]);
    fill(map, STONE, [
      [1, 0, 0],
      [1, 1, 0],
      [-1, 0, 0],
      [-1, 1, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 0, -1],
      [0, 1, -1],
    ]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 1.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);

    expect(snapshot.state).toBe('NO_VERIFIED_PATH');
    const inspection = inspectRoute(snapshot);
    expect(inspection.state).toBe('NO_VERIFIED_PATH');
    expect(inspection.candidate).toBeNull();
    expect(inspection.arrivalConfirmed).toBe(false);
    expect(inspection.executionStarted).toBe(false);
    expect(inspection.boundaries.length).toBeGreaterThan(0);
    expect(inspection.boundaries.every((boundary) => boundary.status === 'BLOCKED')).toBe(true);
  });

  it('returns fresh copies; mutating them never reaches the snapshot', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2], [0]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 2.5, y: 0, z: 0.5 } }));
    const snapshot = drain(search);
    const inspection = inspectRoute(snapshot);

    inspection.candidate!.points[0]!.x = 12_345;
    inspection.from.x = 12_345;
    inspection.counters.nodesReached = 12_345;

    expect(snapshot.candidate!.points[0]!.x).not.toBe(12_345);
    expect(snapshot.from.x).not.toBe(12_345);
    expect(snapshot.counters.nodesReached).not.toBe(12_345);
  });
});

describe('read-only queries preserve map and search state', () => {
  it('does not advance the search, refresh evidence or change pending/pins/residency', () => {
    const map = new VoxelMap('world');
    floorCells(map, [0, 1, 2, 3], [0, 1]);

    const search = new WalkRouteSearch(map, { now: () => 2000 });
    search.start(request({ target: { x: 3.5, y: 0, z: 0.5 } }));
    const pending = search.advance(1);

    expect(pending.state).toBe('PENDING');
    expect(pending.counters.hasMoreWork).toBe(true);

    const before = {
      revision: map.saveRevision,
      pins: map.pinState(),
      dirty: map.checkpointDirtyMeasure(),
      resident: map.residentSize(),
      cell: map.cellAt('overworld', 0, 0, 0),
      snapshot: search.status(),
    };

    const inspection = inspectRoute(pending);
    const frontiers = frontierCandidates(pending);

    expect(inspection.arrivalConfirmed).toBe(false);
    expect(inspection.executionStarted).toBe(false);
    expect(frontiers.selected).toBe(false);
    expect(frontiers.explorationStarted).toBe(false);

    expect(map.saveRevision).toBe(before.revision);
    expect(map.pinState()).toEqual(before.pins);
    expect(map.checkpointDirtyMeasure()).toEqual(before.dirty);
    expect(map.residentSize()).toEqual(before.resident);
    expect(map.cellAt('overworld', 0, 0, 0)).toEqual(before.cell);
    expect(search.status()).toEqual(before.snapshot);
    expect(search.status()!.state).toBe('PENDING');
    expect(search.status()!.counters.edgesEvaluated).toBe(pending.counters.edgesEvaluated);
  });
});
