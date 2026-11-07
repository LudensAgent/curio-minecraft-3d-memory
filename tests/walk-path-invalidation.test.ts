import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BodySample, ExecutableMove, ExecutableMoveResult } from '../src/execution/types.js';
import { WalkRouteExecutor } from '../src/execution/walk-route-executor.js';
import { RoutePlanRegistryImpl } from '../src/navigation/route-plan-registry.js';
import type { RoutePlanDraft } from '../src/navigation/route-plan-types.js';
import { createWalkPath, createWalkPathExecution } from '../src/navigation/walk-path.js';
import type { ChangeReportSource, WalkPathEnvironment } from '../src/navigation/walk-path-types.js';
import { WalkRouteSearch } from '../src/navigation/walk-search.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import type { ChangeReport } from '../src/voxel/voxel-map.js';
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

/**
 * `walkPath` harness whose body keeps the move pending until measured samples
 * confirm the step, and whose change reports can be emitted at a controlled
 * moment (inside the in-flight move) or replayed verbatim.
 */
function harness(points: Vec3Like[]) {
  let clock = NOW;
  const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => clock });
  observeWorld(map, points);

  let sampleSequence = 0;
  let observationSequence = 0;
  let lastSampleObservedAt = 0;
  let position = { ...points[0]! };
  const moves: ExecutableMove[] = [];
  const stops: string[] = [];
  const moveHooks: Array<(move: ExecutableMove) => void> = [];

  // Host -> executor report chain. `forwarding` lets a test acquire a report
  // without delivering it, so it can replay that (older) report later.
  let sink: ((report: ChangeReport) => void) | null = null;
  let forwarding = true;
  const changes: ChangeReportSource = {
    subscribe(callback) {
      sink = callback;
      return () => {
        if (sink === callback) sink = null;
      };
    },
  };
  map.subscribeChanges((report) => {
    if (forwarding) sink?.(report);
  });

  const registry = new RoutePlanRegistryImpl({ now: () => clock });
  const plan = registry.register(draft(points));
  const executionId = `exec_${plan.routeId}`;

  const environment: WalkPathEnvironment = {
    ...SCOPE,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    sample: () => measurement(),
    bodyPort: {
      move: (request) => {
        moves.push(request);
        position = { ...request.to };
        moveHooks.shift()?.(request);
        return new Promise<ExecutableMoveResult>(() => {});
      },
      stop: (id) => {
        stops.push(id);
      },
    },
    changes,
    now: () => clock,
  };

  function measurement(): BodySample {
    sampleSequence += 1;
    lastSampleObservedAt = clock;
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
      sequence: sampleSequence,
    };
  }

  const execute = createWalkPathExecution({
    map,
    wait: async () => {
      clock += 40;
    },
  });
  const walkPath = createWalkPath(registry, { execute });

  const startSpy = vi.spyOn(WalkRouteExecutor.prototype, 'start');

  return {
    plan,
    executionId,
    environment,
    walkPath,
    moves,
    stops,
    moveHooks,
    startSpy,
    time: () => clock,
    lastSampleObservedAt: () => lastSampleObservedAt,
    /** Observe one cell through the normal report chain and return its report. */
    observe(pos: Vec3Like, state: BlockState = STONE, observedAt = clock): ChangeReport {
      observationSequence += 1;
      return map.observe(obs(state, pos, { observedAt, sequence: observationSequence }));
    },
    /** Replay a previously captured report to the active execution. */
    deliver(report: ChangeReport): void {
      sink?.(report);
    },
    setForwarding(value: boolean): void {
      forwarding = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('walkPath report invalidation (M4.4)', () => {
  it('maps an in-flight segment invalidation to INVALIDATED and forwards the ChangeReport', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');
    let report: ChangeReport | null = null;

    // The destination of the segment about to execute becomes solid while the
    // move is in flight. The report is forwarded synchronously, exactly as a
    // host observation would be.
    h.moveHooks.push(() => {
      report = h.observe({ x: 1, y: 0, z: 0 });
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.confirmed).toBe(false);
    expect(result.problem?.kind).toBe('route_invalidated');
    // Measured evidence is preserved; progress is not invented.
    expect(result.confirmedSegments).toBe(0);
    expect(result.lastPosition).toEqual(points[0]);
    expect(result.lastObservation).toMatchObject({
      ...SCOPE,
      observedAt: h.lastSampleObservedAt(),
      onGround: true,
      inWater: false,
    });
    expect(result.remainingPoints).toEqual(points.slice(1));
    // The report that caused the stop is attached verbatim, with its cells.
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'route_invalidated' });
    expect(result.invalidation?.changes).toBe(report);
    expect(result.invalidation?.changes?.sections[0]?.invalidated).toBe(true);
    expect(result.invalidation?.changes?.sections[0]?.cells).toContainEqual({
      pos: { x: 1, y: 0, z: 0 },
      kind: 'changed',
    });
    // The in-flight body action was stopped, not re-sent, and nothing re-planned.
    expect(h.moves.map((m) => m.to)).toEqual([points[1]]);
    expect(h.stops).toEqual([h.executionId]);
    expect(h.startSpy).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it('omits invalidation.changes when the stop came from a non-report failure', async () => {
    const points = routeAlong(0, 1);
    const h = harness(points);
    const baseSample = h.environment.sample;
    let reads = 0;
    // The start precheck reads the first sample; the execution then finds the
    // body gone. No ChangeReport is involved in this failure.
    h.environment.sample = () => (++reads === 1 ? baseSample() : null);

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('INVALIDATED');
    expect(result.problem?.kind).toBe('unavailable');
    expect(result.invalidation).toMatchObject({ reason: 'route_body_unavailable' });
    expect(result.invalidation?.changes).toBeUndefined();
    expect(result.confirmed).toBe(false);
  });

  it('keeps the terminal report and ignores a report delivered after the execution ended', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);
    let terminalReport: ChangeReport | null = null;
    let lateReport: ChangeReport | null = null;

    h.moveHooks.push(() => {
      // This report revokes the in-flight segment and makes the execution terminal.
      terminalReport = h.observe({ x: 1, y: 0, z: 0 });
      // A later report reaches the subscription only after the terminal stop.
      lateReport = h.observe({ x: 2, y: 0, z: 0 });
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(terminalReport).not.toBeNull();
    expect(lateReport).not.toBeNull();
    expect(lateReport).not.toBe(terminalReport);
    expect(result.outcome).toBe('INVALIDATED');
    expect(result.invalidation).toMatchObject({ segment: 0, reason: 'route_invalidated' });
    // The report that ended the execution is kept; the later one cannot replace it.
    expect(result.invalidation?.changes).toBe(terminalReport);
    expect(result.invalidation?.changes).not.toBe(lateReport);
  });

  it('does not interrupt the in-flight segment for a change that only revokes a later segment', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);
    const search = vi.spyOn(WalkRouteSearch.prototype, 'advance');
    let report: ChangeReport | null = null;

    // The obstacle is in the same Section but outside the current segment's
    // corridor: it only invalidates the later segment.
    h.moveHooks.push(() => {
      report = h.observe({ x: 2, y: 0, z: 0 });
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    // The current segment is confirmed and completed; only then does the
    // re-verified later segment stop the route.
    expect(report).not.toBeNull();
    expect(result.confirmedSegments).toBe(1);
    expect(result.outcome).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('blocked');
    expect(result.confirmed).toBe(false);
    expect(result.lastPosition).toEqual(points[1]);
    expect(result.remainingPoints).toEqual([points[2]]);
    // The invalidated later segment was never executed with stale OPEN evidence.
    expect(h.moves.map((m) => m.to)).toEqual([points[1]]);
    expect(h.stops).toEqual([h.executionId]);
    expect(search).not.toHaveBeenCalled();
  });

  it('does not interrupt the route for an unrelated change in another section', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);

    h.moveHooks.push(() => {
      h.observe({ x: 100, y: 0, z: 0 });
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.invalidation).toBeUndefined();
    expect(result.confirmedSegments).toBe(2);
    expect(result.remainingPoints).toEqual([]);
    expect(h.moves.map((m) => m.to)).toEqual([points[1], points[2]]);
    expect(h.stops).toEqual([h.executionId, h.executionId]);
  });

  it('lets newer evidence win when an older report is replayed', async () => {
    const points = routeAlong(0, 1, 2);
    const h = harness(points);

    // Acquire a report that would have blocked the first segment, then observe
    // the cell again with newer evidence. Neither report is forwarded yet.
    h.setForwarding(false);
    const older = h.observe({ x: 1, y: 0, z: 0 }, STONE, NOW);
    h.observe({ x: 1, y: 0, z: 0 }, AIR, NOW + 1);
    h.setForwarding(true);

    // Deliver the older report while the first segment is in flight: the map
    // already holds the newer AIR evidence, so re-verification stays OPEN.
    h.moveHooks.push(() => {
      h.deliver(older);
    });

    const result = await h.walkPath({ routeId: h.plan.routeId, deadlineMs: DEADLINE }, h.environment);

    expect(older.sections[0]?.invalidated).toBe(true);
    expect(result.outcome).toBe('ARRIVED');
    expect(result.confirmed).toBe(true);
    expect(result.invalidation).toBeUndefined();
    expect(result.confirmedSegments).toBe(2);
    expect(h.moves.map((m) => m.to)).toEqual([points[1], points[2]]);
  });
});
