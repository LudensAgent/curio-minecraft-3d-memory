import { describe, expect, it } from 'vitest';
import { searchLandRoute, searchLandRouteAsync } from '../src/navigation/index.js';
import type {
  LandSearchEdgePolicy,
  LandSearchPolicyCell,
  LandSearchPolicyDecision,
  LandSearchRequest,
} from '../src/navigation/index.js';
import type { LandSearchEdgePolicy as RootEdgePolicy } from '../src/index.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { AIR, SLAB, STONE, bodyAt, fakeProvider, obs } from './fakes.js';

type Column = { x: number; z: number; height: number };

function terrain(columns: readonly Column[]): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  columns.forEach(({ x, z, height }) => {
    for (let y = -6; y <= 10; y++) {
      const state = y + 1 <= height ? STONE
        : y < height ? SLAB : AIR;
      map.observe(obs(state, { x, y, z }));
    }
  });
  return map;
}

function request(overrides: Partial<LandSearchRequest> = {}): LandSearchRequest {
  return {
    worldId: 'world', dim: 'overworld', sessionId: 's1',
    body: bodyAt(0.5, 0, 0.5), to: { x: 2.5, y: 0, z: 0.5 },
    rules: { shapeProvider: fakeProvider }, ...overrides,
  };
}

const flat = (length = 3): Column[] => Array.from({ length }, (_, x) => ({ x, z: 0, height: 0 }));

/** One floating floor layer at y=-1, fully observed. Only walk surfaces exist. */
function floatingFloor(): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  for (let x = -2; x <= 4; x++) {
    for (let z = -2; z <= 3; z++) {
      for (let y = -6; y <= 4; y++) {
        map.observe(obs(y === -1 ? STONE : AIR, { x, y, z }));
      }
    }
  }
  return map;
}

/** Start support only; every other fully observed column has no support. */
function observedNoSupport(): VoxelMap {
  const map = new VoxelMap('world', { now: () => 1000 });
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -5; y <= 2; y++) {
        map.observe(obs(x === 0 && z === 0 && y === -1 ? STONE : AIR, { x, y, z }));
      }
    }
  }
  return map;
}

function countingPolicy(): { policy: LandSearchEdgePolicy; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    policy: { version: 'counting', evaluate() { calls += 1; return { allow: true }; } },
  };
}

describe('edge policy integration', () => {
  it('leaves default synchronous and asynchronous behavior unchanged', async () => {
    const map = terrain(flat());
    const sync = searchLandRoute(map, request(), 2000);
    const asyncResult = await searchLandRouteAsync(map, request(), 2000);
    expect(sync.status).toBe('FOUND');
    expect(sync.cost).toBe(2);
    expect(sync.transitions.map((transition) => transition.cost)).toEqual([1, 1]);
    expect(sync.policy).toBeUndefined();
    expect(asyncResult.points).toEqual(sync.points);
    expect(asyncResult.cost).toBe(sync.cost);
    expect(asyncResult.policy).toBeUndefined();
  });

  it('does not call the policy for disallowed, corridor-excluded or non-OPEN candidates', () => {
    const counting = countingPolicy();
    const disallowed = searchLandRoute(terrain([{ x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 1 }]), request({
      allowed: ['walk'], edgePolicy: counting.policy,
    }), 2000);
    expect(counting.calls()).toBe(0);
    expect(disallowed.policy).toEqual({ version: 'counting', reads: 0, rejectedEdges: 0 });

    const nonOpen = searchLandRoute(observedNoSupport(), request({ edgePolicy: counting.policy }), 2000);
    expect(counting.calls()).toBe(0);
    expect(nonOpen.policy).toEqual({ version: 'counting', reads: 0, rejectedEdges: 0 });

    const excluded = searchLandRoute(terrain([
      { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 },
    ]), request({
      body: bodyAt(0.5, 0, 1.5), to: { x: 1.5, y: 0, z: 1.5 }, edgePolicy: counting.policy,
      corridor: { origin: { x: 0.5, y: 0, z: 0.5 }, bearing: { x: 1, z: 0 }, maxLateral: 0.5 },
    }), 2000);
    expect(counting.calls()).toBe(0);
    expect(excluded.corridorLimited).toBe(true);
    expect(excluded.policy).toEqual({ version: 'counting', reads: 0, rejectedEdges: 0 });
  });

  it('finds a longer allowed detour when the policy rejects the shortcut', () => {
    const map = terrain([
      { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 0 }, { x: 2, z: 0, height: 0 },
      { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 }, { x: 2, z: 1, height: 0 },
    ]);
    const policy: LandSearchEdgePolicy = {
      version: 'no-shortcut',
      evaluate(edge) {
        return edge.from.z === 0.5 && edge.to.z === 0.5 && edge.to.x > edge.from.x
          ? { allow: false, reason: 'caller rejects direct dry shortcut' }
          : { allow: true };
      },
    };
    const result = searchLandRoute(map, request({ edgePolicy: policy }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.cost).toBe(4);
    expect(result.points.some((point) => point.z === 1.5)).toBe(true);
    expect(result.points.at(-1)).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(result.transitions.reduce((sum, transition) => sum + transition.cost, 0)).toBe(4);
    expect(result.policy!.rejectedEdges).toBeGreaterThan(0);
    expect(result.policy!.firstRejection).toMatchObject({
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 0, z: 0.5 },
      reason: 'caller rejects direct dry shortcut',
    });
    // The rejected edge was geometry-OPEN, so it never became a boundary.
    expect(result.boundaries.some((entry) => entry.from.x === 0.5 && entry.to.x === 1.5
      && entry.to.y === 0 && entry.to.z === 0.5)).toBe(false);
  });

  it('applies nonnegative surcharges to transition and path costs, keeping A*/zero equal', () => {
    const map = terrain([
      { x: 0, z: 0, height: 0 }, { x: 1, z: 0, height: 0 }, { x: 2, z: 0, height: 0 },
      { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 }, { x: 2, z: 1, height: 0 },
    ]);
    const policy: LandSearchEdgePolicy = {
      version: 'surcharge-shortcut',
      evaluate(edge) {
        return edge.from.z === 0.5 && edge.to.z === 0.5 && edge.to.x > edge.from.x
          ? { allow: true, extraCost: 10 }
          : { allow: true };
      },
    };
    const astar = searchLandRoute(map, request({ edgePolicy: policy }), 2000);
    const zero = searchLandRoute(map, request({ edgePolicy: policy, heuristic: 'zero' }), 2000);
    expect(astar.status).toBe('FOUND');
    expect(zero.status).toBe('FOUND');
    expect(astar.cost).toBe(4);
    expect(zero.cost).toBe(4);
    expect(astar.points.some((point) => point.z === 1.5)).toBe(true);
    expect(astar.transitions.reduce((sum, transition) => sum + transition.cost, 0)).toBe(astar.cost);
    expect(zero.transitions.reduce((sum, transition) => sum + transition.cost, 0)).toBe(zero.cost);

    const sole: LandSearchEdgePolicy = {
      version: 'surcharge-all',
      evaluate() { return { allow: true, extraCost: 2 }; },
    };
    const expensive = searchLandRoute(terrain(flat()), request({ edgePolicy: sole }), 2000);
    expect(expensive.status).toBe('FOUND');
    expect(expensive.cost).toBe(6);
    expect(expensive.transitions.map((transition) => transition.cost)).toEqual([3, 3]);
    expect(expensive.transitions.reduce((sum, transition) => sum + transition.cost, 0)).toBe(6);
  });

  it('reports policy refusal as a delegation restriction, never terrain or a blocker', () => {
    const rejectAll: LandSearchEdgePolicy = {
      version: 'reject-all',
      evaluate() { return { allow: false, reason: 'caller veto' }; },
    };
    const map = floatingFloor();
    const result = searchLandRoute(map, request({ edgePolicy: rejectAll }), 2000);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.reason).toContain('edge policy');
    expect(result.policy).toMatchObject({ version: 'reject-all', reads: 0, rejectedEdges: 4 });
    expect(result.policy!.firstRejection).toMatchObject({
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 0, z: 0.5 },
      reason: 'caller veto',
    });
    expect(result.boundaries).toEqual([]);
    expect(result.prefix).toBeDefined();
    expect(result.prefix!.atStart).toBe(true);
    expect(result.prefix!.transitions).toEqual([]);
    expect(result.prefix!.knownBlockerAhead).toBeUndefined();

    const remembered = searchLandRoute(map, request({ evidenceMode: 'remembered', edgePolicy: rejectAll }), 2000);
    expect(remembered.status).toBe('UNSUPPORTED');
    expect(remembered.prefix).toBeUndefined();
  });

  it('keeps policy-rejected edges out of a current prefix and out of truncated diagnostics', () => {
    const gapMap = terrain([
      ...flat(3),
      { x: 0, z: 1, height: 0 }, { x: 1, z: 1, height: 0 }, { x: 2, z: 1, height: 0 },
    ]);
    const axisPolicy: LandSearchEdgePolicy = {
      version: 'stay-on-axis',
      evaluate(edge) {
        return edge.to.z === 0.5 ? { allow: true } : { allow: false, reason: 'caller stays on axis' };
      },
    };
    const gap = searchLandRoute(gapMap, request({ to: { x: 3.5, y: 0, z: 0.5 }, edgePolicy: axisPolicy }), 2000);
    expect(gap.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(gap.policy!.rejectedEdges).toBeGreaterThan(0);
    expect(gap.prefix).toBeDefined();
    expect(gap.prefix!.points.map((point) => point.x)).toEqual([0.5, 1.5, 2.5]);
    expect(gap.prefix!.transitions.every((transition) => transition.kind === 'walk' && transition.to.z === 0.5))
      .toBe(true);
    expect(gap.prefix!.knownBlockerAhead).toBeUndefined();

    // A floating floor with two fully observed unsupported side columns creates
    // real BLOCKED diagnostics. The policy-rejected OPEN walks must never
    // appear there, even when maxBoundaries truncates.
    const truncatedMap = new VoxelMap('world', { now: () => 1000 });
    for (let x = -2; x <= 4; x++) {
      for (let z = -2; z <= 3; z++) {
        const unsupportedSide = (x === -1 && z === 0) || (x === 0 && z === -1);
        for (let y = -6; y <= 4; y++) {
          truncatedMap.observe(obs(!unsupportedSide && y === -1 ? STONE : AIR, { x, y, z }));
        }
      }
    }
    const rejectWalk: LandSearchEdgePolicy = {
      version: 'reject-walk',
      evaluate() { return { allow: false, reason: 'caller veto walk' }; },
    };
    const truncated = searchLandRoute(truncatedMap, request({ edgePolicy: rejectWalk, maxBoundaries: 1 }), 2000);
    expect(truncated.status).toBe('UNSUPPORTED');
    expect(truncated.stats.boundariesTruncated).toBe(true);
    expect(truncated.boundaries).toHaveLength(1);
    expect(truncated.boundaries.some((entry) => entry.from.x === 0.5 && entry.to.x === 1.5
      && entry.to.y === 0 && entry.to.z === 0.5)).toBe(false);
    expect(truncated.policy!.firstRejection).toMatchObject({
      from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 }, reason: 'caller veto walk',
    });
    expect(truncated.prefix).toBeDefined();
    expect(truncated.prefix!.atStart).toBe(true);
    expect(truncated.prefix!.knownBlockerAhead).toBeUndefined();
  });
});

describe('edge policy reads and invalidation', () => {
  const dependencyPolicy = (): LandSearchEdgePolicy => ({
    version: 'read-neighbor',
    evaluate(_edge, read) { read.cell(0, 20, 0); return { allow: true }; },
  });

  const navigation = () => ({
    allowed: ['walk'] as const, maxDrop: 0, maxWorkPerSlice: 8, clock: () => 1000,
  });

  it('invalidates on a policy-only Section content change but not an unrelated change', async () => {
    const map = terrain(flat(8));
    map.observe(obs(STONE, { x: 0, y: 20, z: 0 }));
    const before = map.checkpointSnapshot();
    const pending = searchLandRouteAsync(map, request({
      ...navigation(), edgePolicy: dependencyPolicy(), to: { x: 7.5, y: 0, z: 0.5 },
    }), 2000);
    map.observe(obs(AIR, { x: 0, y: 20, z: 0 }, { observedAt: 1500 }));
    const changed = await pending;
    expect(changed.status).toBe('INVALIDATED');
    expect(changed.prefix).toBeUndefined();
    expect(changed.policy!.reads).toBeGreaterThan(0);
    expect(map.checkpointSnapshot()).not.toEqual(before);

    const unrelatedMap = terrain(flat(8));
    unrelatedMap.observe(obs(STONE, { x: 0, y: 20, z: 0 }));
    const pendingUnrelated = searchLandRouteAsync(unrelatedMap, request({
      ...navigation(), edgePolicy: dependencyPolicy(), to: { x: 7.5, y: 0, z: 0.5 },
    }), 2000);
    unrelatedMap.observe(obs(STONE, { x: 100, y: 20, z: 100 }, { observedAt: 1500 }));
    const unrelated = await pendingUnrelated;
    expect(unrelated.status).toBe('FOUND');
    expect(unrelated.policy!.reads).toBeGreaterThan(0);
  });

  it.each([false, true])('invalidates when a policy-only used page is unloaded (reload=%s)', async (reload) => {
    // Restored checkpoint evidence is STALE by design; this recorded-page test
    // uses remembered geometry rather than forging fresh evidence.
    const source = terrain(flat(8));
    source.observe(obs(STONE, { x: 0, y: 20, z: 0 }));
    const sections = source.checkpointSnapshot().sections;
    const manual = new VoxelMap('world', { manualResidency: true });
    manual.installDirectory(sections.map((section, seq) => ({
      key: { worldId: 'world', dim: section.dim, cx: section.cx, cz: section.cz, sy: section.sy },
      seq, bytes: 10000, observedCells: section.evidence.length,
      paletteEntries: section.palette.length, revision: section.revision,
    })));
    manual.installLoadedSections(sections);
    // Wait until the policy-only page has actually been read and registered;
    // the first async pause may happen during support scanning.
    let markPolicyRead!: () => void;
    const policyRead = new Promise<void>((resolve) => { markPolicyRead = resolve; });
    const policy: LandSearchEdgePolicy = {
      version: 'read-neighbor',
      evaluate(_edge, read) { read.cell(0, 20, 0); markPolicyRead(); return { allow: true }; },
    };
    const pending = searchLandRouteAsync(manual, request({
      ...navigation(), evidenceMode: 'remembered', edgePolicy: policy, to: { x: 7.5, y: 0, z: 0.5 },
    }), 2000);
    await policyRead;
    const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 1 };
    expect(manual.unloadSections([key]).unloaded).toEqual([key]);
    if (reload) manual.installLoadedSections(sections.filter((section) => section.sy === 1));
    const result = await pending;
    expect(result.status).toBe('INVALIDATED');
    expect(result.prefix).toBeUndefined();
    expect(result.policy!.reads).toBeGreaterThan(0);
  });

  it('invalidates when the policy version changes and does not refresh map evidence', async () => {
    const map = terrain(flat(8));
    const before = map.checkpointSnapshot();
    const mutable: LandSearchEdgePolicy = {
      version: 'policy-v1',
      evaluate() { return { allow: true }; },
    };
    const pending = searchLandRouteAsync(map, request({
      ...navigation(), edgePolicy: mutable, to: { x: 7.5, y: 0, z: 0.5 },
    }), 2000);
    mutable.version = 'policy-v2';
    const result = await pending;
    expect(result.status).toBe('INVALIDATED');
    expect(result.prefix).toBeUndefined();
    expect(result.policy!.version).toBe('policy-v1');
    expect(map.checkpointSnapshot()).toEqual(before);
  });
});

describe('edge policy evidence projection', () => {
  function freshPolicyMap(): VoxelMap {
    const map = new VoxelMap('world', { now: () => 1000 });
    for (const x of [0, 1, 2]) {
      for (let y = -6; y <= 10; y++) {
        map.observe(obs(y + 1 <= 0 ? STONE : AIR, { x, y, z: 0 }, { observedAt: 60000 }));
      }
    }
    map.observe(obs(STONE, { x: 0, y: 20, z: 0 }, { observedAt: 1000 }));
    map.observe(obs(AIR, { x: 0, y: 21, z: 0 }, { observedAt: 60000, stateComplete: false }));
    return map;
  }

  it('returns recorded names with completeness, including stale and incomplete facts', () => {
    const map = freshPolicyMap();
    const before = map.checkpointSnapshot();
    let stale: LandSearchPolicyCell | undefined;
    let incomplete: LandSearchPolicyCell | undefined;
    let unknown: LandSearchPolicyCell | undefined;
    const policy: LandSearchEdgePolicy = {
      version: 'facts',
      evaluate(_edge, read) {
        stale = read.cell(0, 20, 0);
        incomplete = read.cell(0, 21, 0);
        unknown = read.cell(0, 22, 0);
        return { allow: true };
      },
    };
    const result = searchLandRoute(map, request({ edgePolicy: policy }), 62000);
    expect(result.status).toBe('FOUND');
    expect(result.assurance).toBe('geometry_only');
    expect(stale).toMatchObject({
      kind: 'recorded', state: { name: 'minecraft:stone' }, stateComplete: true,
    });
    expect(incomplete).toMatchObject({
      kind: 'recorded', state: { name: 'minecraft:air' }, stateComplete: false,
    });
    expect(unknown).toEqual({ kind: 'unknown' });
    expect(map.checkpointSnapshot()).toEqual(before);

    const remembered = searchLandRoute(map, request({ edgePolicy: policy, evidenceMode: 'remembered' }), 62000);
    expect(remembered.status).toBe('FOUND');
    expect(remembered.assurance).toBe('historical_geometry');
    expect(remembered.prefix).toBeUndefined();
  });

  it('reports a saved nonresident policy page as unavailable without loading it', () => {
    // The loaded geometry pages are restored STALE; use remembered geometry
    // rather than forging fresh state. The policy-only page stays unloaded.
    const source = terrain(flat(8));
    source.observe(obs(STONE, { x: 0, y: 20, z: 0 }));
    const sections = source.checkpointSnapshot().sections;
    const manual = new VoxelMap('world', { manualResidency: true });
    manual.installDirectory(sections.map((section, seq) => ({
      key: { worldId: 'world', dim: section.dim, cx: section.cx, cz: section.cz, sy: section.sy },
      seq, bytes: 10000, observedCells: section.evidence.length,
      paletteEntries: section.palette.length, revision: section.revision,
    })));
    manual.installLoadedSections(sections.filter((section) => section.sy !== 1));
    const residentBefore = manual.residentSize().sections;
    let cell: LandSearchPolicyCell | undefined;
    const policy: LandSearchEdgePolicy = {
      version: 'nonresident',
      evaluate(_edge, read) { cell = read.cell(0, 20, 0); return { allow: true }; },
    };
    const result = searchLandRoute(manual, request({
      edgePolicy: policy, evidenceMode: 'remembered', to: { x: 7.5, y: 0, z: 0.5 },
    }), 2000);
    expect(result.status).toBe('FOUND');
    expect(result.assurance).toBe('historical_geometry');
    expect(result.prefix).toBeUndefined();
    expect(result.policy!.reads).toBeGreaterThan(0);
    expect(cell).toEqual({ kind: 'unavailable' });
    const key = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 1 };
    expect(result.unavailableSections).toContainEqual(key);
    expect(manual.sectionResidency(key).residency).toBe('not_resident');
    expect(manual.residentSize().sections).toBe(residentBefore);
  });
});

describe('edge policy budgets and failures', () => {
  const twoReads = (): LandSearchEdgePolicy => ({
    version: 'two-reads',
    evaluate(_edge, read) { read.cell(0, 20, 0); read.cell(0, 21, 0); return { allow: true }; },
  });

  it('stops before an uncharged policy read under total and per-edge limits', () => {
    const perEdge = searchLandRoute(terrain(flat()), request({
      edgePolicy: twoReads(), maxPolicyReads: 100, maxPolicyReadsPerEdge: 1,
    }), 2000);
    expect(perEdge.status).toBe('BUDGET_EXHAUSTED');
    expect(perEdge.budget).toBe('reads');
    expect(perEdge.reason).toContain('maxPolicyReadsPerEdge');
    expect(perEdge.policy!.reads).toBe(1);

    const total = searchLandRoute(terrain(flat()), request({
      edgePolicy: twoReads(), maxPolicyReads: 1, maxPolicyReadsPerEdge: 100,
    }), 2000);
    expect(total.status).toBe('BUDGET_EXHAUSTED');
    expect(total.budget).toBe('reads');
    expect(total.reason).toContain('maxPolicyReads');
    expect(total.policy!.reads).toBe(1);
  });

  it('stops on deadline and cancellation inside controlled policy reads', () => {
    let now = 1000;
    const deadlinePolicy: LandSearchEdgePolicy = {
      version: 'deadline',
      evaluate(_edge, read) { now = 2000; read.cell(0, 20, 0); return { allow: true }; },
    };
    const timed = searchLandRoute(terrain(flat()), request({
      edgePolicy: deadlinePolicy, clock: () => now, maxSearchMs: 500,
    }), 2000);
    expect(timed.status).toBe('BUDGET_EXHAUSTED');
    expect(timed.budget).toBe('time');
    expect(timed.policy!.reads).toBe(0);
    expect(timed.prefix).toBeUndefined();

    const controller = new AbortController();
    const cancelledPolicy: LandSearchEdgePolicy = {
      version: 'cancel',
      evaluate(_edge, read) { controller.abort(); read.cell(0, 20, 0); return { allow: true }; },
    };
    const cancelled = searchLandRoute(terrain(flat()), request({
      edgePolicy: cancelledPolicy, signal: controller.signal,
    }), 2000);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.policy!.reads).toBe(0);
    expect(cancelled.prefix).toBeUndefined();
  });

  it('keeps yielding across repeated policy rejections', async () => {
    const reject: LandSearchEdgePolicy = {
      version: 'reject-yield',
      evaluate() { return { allow: false, reason: 'caller veto' }; },
    };
    const result = await searchLandRouteAsync(floatingFloor(), request({
      edgePolicy: reject, maxWorkPerSlice: 1, clock: () => 1000,
    }), 2000);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.stats.yieldCount).toBeGreaterThan(0);
  });

  it('treats policy exceptions and invalid decisions as caller errors, not terrain', () => {
    const map = terrain(flat());
    const before = map.checkpointSnapshot();
    const failure = new Error('policy failed');
    expect(() => searchLandRoute(map, request({
      edgePolicy: { version: 'boom', evaluate() { throw failure; } },
    }), 2000)).toThrow(failure);

    const invalid = (decision: unknown): LandSearchEdgePolicy => ({
      version: 'invalid',
      evaluate: () => decision as LandSearchPolicyDecision,
    });
    for (const decision of [
      {},
      { allow: true, extraCost: -1 },
      { allow: true, extraCost: Number.NaN },
      { allow: true, extraCost: Number.POSITIVE_INFINITY },
      { allow: false, reason: '' },
    ]) {
      expect(() => searchLandRoute(map, request({ edgePolicy: invalid(decision) }), 2000)).toThrow();
    }
    expect(map.checkpointSnapshot()).toEqual(before);
  });

  it('requires a supplied policy to have a nonempty version', () => {
    const missingVersion = {
      version: undefined,
      evaluate: () => ({ allow: true }),
    } as unknown as LandSearchEdgePolicy;
    expect(() => searchLandRoute(terrain(flat()), request({ edgePolicy: missingVersion }), 2000))
      .toThrow(/nonempty version/);
  });

  it('rejects non-finite accumulated policy path cost without clamping', () => {
    const huge: LandSearchEdgePolicy = {
      version: 'huge-cost',
      evaluate() { return { allow: true, extraCost: 1e308 }; },
    };
    expect(() => searchLandRoute(terrain(flat()), request({ edgePolicy: huge }), 2000))
      .toThrow(/non-finite accumulated/);
    const single = searchLandRoute(terrain(flat()), request({
      edgePolicy: huge, to: { x: 1.5, y: 0, z: 0.5 },
    }), 2000);
    expect(single.status).toBe('FOUND');
    expect(single.cost).toBe(1e308);
    expect(single.transitions[0]!.cost).toBe(1e308);
  });
});

describe('edge policy public type entry points', () => {
  it('exports the policy types from the root and navigation entries', () => {
    const policy: RootEdgePolicy = { version: 'export', evaluate: () => ({ allow: true }) };
    const navigationPolicy: LandSearchEdgePolicy = policy;
    expect(navigationPolicy.version).toBe('export');
  });
});
