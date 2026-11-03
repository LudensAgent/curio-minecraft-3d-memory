import { describe, expect, it } from 'vitest';
import { VoxelMap, WalkRouteExecutor } from '../src/index.js';
import type { BodySample, ExecutableMove, ExecutableMoveResult, GroundedArrival, Vec3Like } from '../src/index.js';
import { AIR, STONE, bodyAt, fakeProvider, obs } from './fakes.js';

const arrival: GroundedArrival = { horizontalTolerance: 0.12, feetTolerance: 0.05, maxHorizontalSpeed: 0.003, maxVerticalSpeed: 0.1, stableMs: 150 };
const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }];
function setup(validityWindowMs = 60_000) {
  const map = new VoxelMap('world', { validityWindowMs });
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 4; z++) for (let y = -1; y <= 2; y++) map.observe(obs(y === -1 ? STONE : AIR, { x, y, z }));
  let now = 2000, sequence = 0;
  const requests: ExecutableMove[] = [], stopped: string[] = [];
  let resolve: (result: ExecutableMoveResult) => void = () => {};
  const loop = new WalkRouteExecutor(map, {
    move: (request) => { requests.push(request); return new Promise((r) => { resolve = r; }); },
    stop: (id) => { stopped.push(id); },
  }, { now: () => now });
  const initial = loop.start({ worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk', body: bodyAt(0.5, 0, 0.5), points, arrival: { kind: 'exact' }, bodyArrival: arrival, shapeProvider: fakeProvider, deadlineMs: 20_000, timeoutMs: 3000 });
  const sample = (pos: Vec3Like, overrides: Partial<BodySample> = {}) => loop.onSample({ worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: initial.delegationId, observedAt: now, sequence: ++sequence, alive: true, connected: true, observationReady: true, onGround: true, inWater: false, pos, velocity: { x: 0, y: -0.0784, z: 0 }, ...overrides });
  const settle = (pos: Vec3Like, overrides: Partial<BodySample> = {}) => { sample(pos, overrides); now += 150; return sample(pos, overrides); };
  return { map, loop, requests, stopped, sample, settle, time: (ms: number) => { now += ms; }, resolve: (r: ExecutableMoveResult) => resolve(r) };
}

describe('grounded walk arrival (opt-in)', () => {
  it('waits for stable ground then executes three segments including a turn from measured offsets', () => {
    const h = setup();
    const start = { x: 0.54, y: 0, z: 0.52 };
    h.sample(start);
    h.loop.advance(10);
    expect(h.requests).toHaveLength(0);
    h.time(150); h.sample(start); h.loop.advance(10);
    expect(h.requests[0]?.from).toEqual(start);
    expect(h.requests[0]?.bodyArrival).toEqual(arrival);
    const measured = [{ x: 1.46, y: 0, z: 0.52 }, { x: 1.53, y: 0, z: 1.46 }, { x: 2.46, y: 0, z: 1.52 }];
    measured.forEach((pos, i) => {
      const status = h.settle(pos);
      expect(status.nextPointIndex).toBe(i + 2);
      if (i < 2) { h.loop.advance(10); expect(h.requests[i + 1]?.from).toEqual(pos); }
    });
    const result = h.loop.status()!.result;
    expect(result?.outcome).toBe('ARRIVED');
    expect(result?.lastPosition).toEqual(measured[2]);
    expect(result?.trace.map((t) => t.pos)).toEqual(measured);
  });

  it.each([
    ['airborne', { onGround: false }], ['water', { inWater: true }],
    ['sliding', { velocity: { x: 0.01, y: -0.0784, z: 0 } }],
    ['vertical motion', { velocity: { x: 0, y: 0.2, z: 0 } }],
    ['no velocity evidence', { velocity: undefined }],
  ] satisfies [string, Partial<BodySample>][])('does not confirm %s at the nominal target', (_name, change) => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    h.settle(points[1]!, change);
    expect(h.loop.status()!.nextPointIndex).toBe(1);
    expect(h.loop.status()!.result).toBeNull();
  });

  it('rejects a single stationary result as unconfirmed instead of inventing stable history', async () => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    h.resolve({ sample: { worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: h.requests[0]!.executionId, observedAt: 2200, sequence: 3, alive: true, connected: true, observationReady: true, onGround: true, inWater: false, pos: points[1]!, velocity: { x: 0, y: -0.0784, z: 0 } } });
    await Promise.resolve();
    expect(h.loop.status()!.result?.outcome).toBe('FAILED');
    expect(h.loop.status()!.nextPointIndex).toBe(1);
  });

  it('requires the foot-height contract, preserving a stable partial sample', () => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    h.settle({ ...points[1]!, y: 0.5 });
    expect(h.loop.status()!.nextPointIndex).toBe(1);
    expect(h.loop.cancel('user', 'check').lastPosition?.y).toBe(0.5);
  });

  it('accepts supported feet just above the support plane without snapping the returned y', () => {
    const h = setup(); h.settle({ ...points[0]!, y: 0.01 }); h.loop.advance(10);
    expect(h.requests).toHaveLength(1);
    h.settle({ ...points[1]!, y: 0.01 });
    expect(h.loop.status()!.nextPointIndex).toBe(2);
    expect(h.loop.status()!.lastPosition?.y).toBe(0.01);
  });

  it('rechecks actual-offset body geometry, not only the nominal route', () => {
    const h = setup();
    // Nominal body maxZ=.8; real offset reaches .91. A thin obstacle occupies only that sliver.
    const provider = { ...fakeProvider, resolve: (state: Parameters<typeof fakeProvider.resolve>[0], cell: Vec3Like, read: Parameters<typeof fakeProvider.resolve>[2]) => state.name === 'test:sliver' ? { kind: 'shape' as const, shape: { boxes: [{ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0.85, maxZ: 1 }], supportFaces: [] } } : fakeProvider.resolve(state, cell, read) };
    h.map.observe(obs({ name: 'test:sliver', properties: {} }, { x: 0, y: 0, z: 0 }, { observedAt: 2000, sequence: 2 }));
    const initial = h.loop.start({ worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk', body: bodyAt(0.5, 0, 0.5), points, arrival: { kind: 'exact' }, bodyArrival: arrival, shapeProvider: provider, deadlineMs: 20_000, timeoutMs: 3000 });
    h.settle({ x: 0.5, y: 0, z: 0.61 }, { executionId: initial.delegationId }); h.loop.advance(10);
    expect(h.requests).toHaveLength(0);
    expect(h.loop.status()!.result?.outcome).toBe('BLOCKED');
  });

  it('keeps the active segment on unrelated/later same-section changes, then refuses the blocked next segment', () => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    h.loop.observe(h.map.observe(obs(STONE, { x: 4, y: 0, z: 4 }, { observedAt: 2200, sequence: 2 })), 10);
    expect(h.stopped).toHaveLength(0);
    h.loop.observe(h.map.observe(obs(STONE, { x: 1, y: 0, z: 1 }, { observedAt: 2200, sequence: 3 })), 10);
    expect(h.stopped).toHaveLength(0);
    h.settle(points[1]!); h.loop.advance(10);
    expect(h.requests).toHaveLength(1);
    expect(h.loop.status()!.result?.outcome).toBe('BLOCKED');
  });

  it('stops immediately when fresh perception changes the active corridor', () => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    const partial = { x: 0.8, y: 0, z: 0.5 }; h.sample(partial);
    const status = h.loop.observe(h.map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 2200, sequence: 2 })), 10);
    expect(status.result?.outcome).toBe('FAILED');
    expect(status.result && 'problem' in status.result && status.result.problem?.kind).toBe('route_invalidated');
    expect(status.result?.lastPosition).toEqual(partial);
    expect(h.stopped).toEqual([h.requests[0]!.executionId]);
  });

  it('never treats onGround as a substitute for spatial support evidence', () => {
    const h = setup();
    h.map.observe(obs(AIR, { x: 1, y: -1, z: 0 }, { observedAt: 2000, sequence: 2 }));
    h.settle(points[0]!); h.loop.advance(10);
    expect(h.requests).toHaveLength(0);
    expect(h.loop.status()!.result?.outcome).toBe('BLOCKED');
  });
  it('does not infer continuous stability across a missing observation window or position jitter', () => {
    const h = setup(); h.sample(points[0]!); h.time(1000); h.sample(points[0]!); h.loop.advance(10);
    expect(h.requests).toHaveLength(0);
    h.time(150); h.sample(points[0]!); h.loop.advance(10);
    expect(h.requests).toHaveLength(1);
    h.sample(points[1]!); h.time(150); h.sample({ ...points[1]!, x: 1.55 });
    expect(h.loop.status()!.nextPointIndex).toBe(1);
    h.time(150); h.sample({ ...points[1]!, x: 1.55 });
    expect(h.loop.status()!.nextPointIndex).toBe(2);
  });

  it('preserves cancellation and ignores a late measured result without starting another segment', async () => {
    const h = setup(); h.settle(points[0]!); h.loop.advance(10);
    const partial = { x: 0.9, y: 0, z: 0.5 }; h.sample(partial);
    const result = h.loop.cancel('user', 'stop');
    expect(result.outcome).toBe('CANCELLED');
    expect(result.lastPosition).toEqual(partial);
    expect(h.requests[0]!.signal.aborted).toBe(true);
    h.resolve({ sample: { worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: h.requests[0]!.executionId, observedAt: 2300, sequence: 50, alive: true, connected: true, observationReady: true, onGround: true, inWater: false, pos: points[1]!, velocity: { x: 0, y: -0.0784, z: 0 } } });
    await Promise.resolve(); h.loop.advance(10);
    expect(h.loop.status()!.result?.outcome).toBe('CANCELLED');
    expect(h.loop.status()!.lastPosition).toEqual(partial);
    expect(h.requests).toHaveLength(1);
  });

  it('refreshes an active segment TTL only from its freshly observed required cells', () => {
    const h = setup(2000); h.settle(points[0]!); h.loop.advance(10); // original TTL=3000
    h.time(700);
    for (let x = 0; x <= 1; x++) for (let y = -1; y <= 1; y++) {
      h.loop.observe(h.map.observe(obs(y === -1 ? STONE : AIR, { x, y, z: 0 }, { observedAt: 2850, sequence: 3 })), 10);
    }
    h.time(300); // now 3150: old TTL expired, current corridor is fresh until 4850
    expect(h.loop.checkTimeout().result).toBeNull();
    h.settle(points[1]!);
    expect(h.loop.status()!.nextPointIndex).toBe(2);
  });

  it('does not refresh unobserved required neighbors from one refreshed cell', () => {
    const h = setup(2000); h.settle(points[0]!); h.loop.advance(10);
    h.time(700);
    h.loop.observe(h.map.observe(obs(STONE, { x: 0, y: -1, z: 0 }, { observedAt: 2850, sequence: 3 })), 10);
    h.time(300);
    const result = h.loop.checkTimeout().result;
    expect(result?.outcome).toBe('FAILED');
    expect(result && 'problem' in result && result.problem?.kind).toBe('route_invalidated');
    expect(h.stopped).toEqual([h.requests[0]!.executionId]);
  });

});
