import { describe, expect, it } from 'vitest';

import { LandRouteVerifier, VoxelMap } from '../src/index.js';
import type {
  BlockState,
  BodyContext,
  ChangeReport,
  ClimbRegionProvider,
  CollisionShapeProvider,
  LandMotionModel,
  LandRouteRequest,
  LandRouteStatus,
  LandRules,
  LandTransition,
  Observation,
} from '../src/index.js';
import { AIR, EMPTY, fakeProvider, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

const LADDER: BlockState = { name: 'minecraft:ladder', properties: { facing: 'north' } };

const landProvider: CollisionShapeProvider = {
  version: 'land-route-shapes-1',
  resolve(state, cell, read) {
    if (state.name === LADDER.name) return { kind: 'shape', shape: EMPTY };
    return fakeProvider.resolve(state, cell, read);
  },
};

function testJumpModel(version = 'test-quadratic-v1'): LandMotionModel {
  return {
    version,
    resolve({ from, to }) {
      if (from.y !== to.y) return { kind: 'unsupported', detail: 'test model requires equal feet heights' };
      return { kind: 'supported', trajectory: { apexHeight: 1.25 } };
    },
  };
}

function testClimbProvider(version = 'test-climb-v1'): ClimbRegionProvider {
  return {
    version,
    resolve(input) {
      if (input.state.name !== LADDER.name) return { kind: 'regions', regions: [] };
      return {
        kind: 'regions',
        regions: [{ minFeetY: input.cell.y, maxFeetY: input.cell.y + 1 }],
      };
    },
  };
}

function bodyAt(feet: { x: number; y: number; z: number }): BodyContext {
  return { feet: { ...feet }, width: 0.6, height: 1.8, pose: 'standing' };
}

function fill(map: VoxelMap, state: BlockState, cells: readonly Cell[], observedAt = 1000): ChangeReport {
  return map.observeBatch({
    observations: cells.map(([x, y, z]) => obs(state, { x, y, z }, { observedAt })),
    unobserved: [],
  });
}

function refill(map: VoxelMap, entries: ReadonlyArray<{ state: BlockState; cells: readonly Cell[] }>, observedAt: number): ChangeReport {
  const observations: Observation[] = [];
  for (const entry of entries) {
    for (const [x, y, z] of entry.cells) {
      observations.push(obs(entry.state, { x, y, z }, { observedAt }));
    }
  }
  return map.observeBatch({ observations, unobserved: [] });
}

function request(
  transitions: readonly LandTransition[],
  rules: LandRules,
  body?: BodyContext,
  overrides: Partial<LandRouteRequest> = {},
): LandRouteRequest {
  const first = transitions[0];
  if (first === undefined) throw new Error('test route needs a transition');
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    body: body ?? bodyAt(first.from),
    rules,
    transitions,
    ...overrides,
  };
}

function statusOf(verifier: LandRouteVerifier): LandRouteStatus {
  const status = verifier.status();
  if (status === null) throw new Error('expected a registered route');
  return status;
}

const STEP: LandTransition = {
  kind: 'step',
  from: { x: 0.5, y: 0, z: 0.5 },
  to: { x: 1.5, y: 1, z: 0.5 },
};

function fillOpenStep(map: VoxelMap): void {
  fill(map, STONE, [
    [0, -1, 0],
    [1, 0, 0],
  ]);
  fill(map, AIR, [
    [0, 0, 0],
    [0, 1, 0],
    [0, 2, 0],
    [1, 1, 0],
    [1, 2, 0],
  ]);
}

describe('LandRouteVerifier — mixed route and bounded advance', () => {
  const MIXED: LandTransition[] = [
    { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 0.5 } },
    { kind: 'jump', from: { x: 1.5, y: 1, z: 0.5 }, to: { x: 2.5, y: 1, z: 0.5 } },
    { kind: 'drop', from: { x: 2.5, y: 1, z: 0.5 }, to: { x: 3.5, y: 0, z: 0.5 } },
  ];

  function fillMixed(map: VoxelMap): void {
    fill(map, STONE, [
      [0, -1, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, -1, 0],
    ]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
      [1, 3, 0],
      [1, 4, 0],
      [2, 1, 0],
      [2, 2, 0],
      [2, 3, 0],
      [2, 4, 0],
      [3, 0, 0],
      [3, 1, 0],
      [3, 2, 0],
    ]);
  }

  const rules: LandRules = { shapeProvider: landProvider, jumpModel: testJumpModel() };

  it('verifies an exactly joined typed route and exposes geometry-only, non-executable status', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    const initial = verifier.register(request(MIXED, rules));

    expect(initial.verdict).toBe('INCOMPLETE');
    expect(initial.complete).toBe(false);
    expect(initial.pendingTransitionIndexes).toEqual([0, 1, 2]);
    expect(initial.assurance).toBe('geometry_only');
    expect(initial.executable).toBe(false);
    expect(initial.transitions).toEqual(MIXED);

    const done = verifier.advance(10000);
    expect(done.verdict).toBe('OPEN');
    expect(done.complete).toBe(true);
    expect(done.openPrefix).toBe(3);
    expect(done.verifiedTransitionIndexes).toEqual([0, 1, 2]);
    expect(done.assurance).toBe('geometry_only');
    expect(done.executable).toBe(false);
    expect(done.ruleVersions).toEqual({ shapeProvider: 'land-route-shapes-1', jumpModel: 'test-quadratic-v1' });
  });

  it('preserves map observations, revisions and evidence time across verification reads', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const before = {
      saveRevision: map.saveRevision,
      counts: map.checkpointCounts(),
      cell: map.cellAt('overworld', 1, 1, 0),
      revision: map.sectionAt('overworld', 1, 1, 0)?.revision,
    };
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request(MIXED, rules));
    verifier.advance(10000);
    verifier.status();
    verifier.status();
    expect(map.saveRevision).toBe(before.saveRevision);
    expect(map.checkpointCounts()).toEqual(before.counts);
    expect(map.cellAt('overworld', 1, 1, 0)).toEqual(before.cell);
    expect(map.sectionAt('overworld', 1, 1, 0)?.revision).toBe(before.revision);
  });

  it('keeps a budget-exhausted transition pending with an explicit used/required gap', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request(MIXED, rules));

    const first = verifier.advance(1);
    expect(first.verdict).toBe('INCOMPLETE');
    expect(first.openPrefix).toBe(0);
    expect(first.complete).toBe(false);
    expect(first.pendingTransitionIndexes).toEqual([0, 1, 2]);
    expect(first.budgetGap).toBeDefined();
    expect(first.budgetGap!.used).toBeLessThanOrEqual(1);
    expect(first.budgetGap!.requiredAtLeast).toBeGreaterThan(0);
    expect(first.budgetGap!.transitionIndex).toBe(0);
    expect(first.budgetGap!.limit).toBe('advance_budget');
    expect(first.budgetGap!.limitValue).toBe(1);
    expect(first.budgetGap!.recovery).toBe('increase_advance_budget');
    expect(first.budgetGap!.diagnostic.kind).toBe('budget');
    expect(first.budgetGap!.transitionWork.exhausted).toBe(true);
    expect(first.budgetGap!.transitionWork.used).toBeLessThanOrEqual(1);

    const retry = verifier.advance(1);
    expect(retry.verdict).toBe('INCOMPLETE');
    expect(retry.budgetGap).toBeDefined();

    const done = verifier.advance(10000);
    expect(done.verdict).toBe('OPEN');
    expect(done.budgetGap).toBeUndefined();
  });

  it('isolates nested budget-gap diagnostics and work from later status reads', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request(MIXED, rules));

    const first = verifier.advance(1);
    const gap = first.budgetGap;
    if (gap === undefined) throw new Error('expected a budget gap');
    const original = {
      detail: gap.diagnostic.detail,
      cells: gap.diagnostic.cells.map((cell) => ({ ...cell })),
      work: { ...gap.transitionWork },
    };

    gap.diagnostic.detail = 'externally modified';
    gap.diagnostic.cells.push({ x: 99, y: 99, z: 99 });
    gap.transitionWork.used = 12345;
    gap.transitionWork.exhausted = false;

    const later = statusOf(verifier).budgetGap;
    if (later === undefined) throw new Error('expected the retained budget gap');
    expect(later.diagnostic.detail).toBe(original.detail);
    expect(later.diagnostic.cells).toEqual(original.cells);
    expect(later.transitionWork).toEqual(original.work);
  });

  it('distinguishes the configured maxWork ceiling from a per-call budget shortfall', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    const capped = new LandRouteVerifier(map, { now: () => 2000, limits: { maxWork: 2 } });
    capped.register(request([STEP], { shapeProvider: landProvider }));

    const first = capped.advance(10000);
    expect(first.verdict).toBe('INCOMPLETE');
    expect(first.budgetGap!.limit).toBe('maxWork');
    expect(first.budgetGap!.limitValue).toBe(2);
    expect(first.budgetGap!.recovery).toBe('raise_configured_limits');
    expect(first.budgetGap!.requiredLimitAtLeast).toBeGreaterThan(2);
    expect(first.budgetGap!.transitionIndex).toBe(0);

    // A larger per-call budget cannot exceed the verifier's configured ceiling.
    const bigger = capped.advance(1_000_000);
    expect(bigger.verdict).toBe('INCOMPLETE');
    expect(bigger.budgetGap!.limit).toBe('maxWork');
    expect(bigger.budgetGap!.recovery).toBe('raise_configured_limits');

    const raised = new LandRouteVerifier(map, { now: () => 2000, limits: { maxWork: 100000 } });
    raised.register(request([STEP], { shapeProvider: landProvider }));
    expect(raised.advance(10000).verdict).toBe('OPEN');
  });

  it('reports a candidate capacity as a configured limit and recovers with new limits', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    const small = new LandRouteVerifier(map, { now: () => 2000, limits: { maxCandidateCells: 1 } });
    small.register(request([STEP], { shapeProvider: landProvider }));

    const first = small.advance(10000);
    expect(first.verdict).toBe('INCOMPLETE');
    expect(first.complete).toBe(false);
    expect(first.verifiedTransitionIndexes).toEqual([]);
    expect(first.pendingTransitionIndexes).toEqual([0]);
    expect(first.budgetGap!.limit).toBe('maxCandidateCells');
    expect(first.budgetGap!.limitValue).toBe(1);
    expect(first.budgetGap!.requiredLimitAtLeast).toBeGreaterThan(1);
    expect(first.budgetGap!.recovery).toBe('raise_configured_limits');
    expect(first.budgetGap!.diagnostic.kind).toBe('capacity');

    // Increasing the advance budget alone cannot pass a configured capacity.
    const still = small.advance(1_000_000);
    expect(still.budgetGap!.limit).toBe('maxCandidateCells');

    const raised = new LandRouteVerifier(map, { now: () => 2000, limits: { maxCandidateCells: 10000 } });
    raised.register(request([STEP], { shapeProvider: landProvider }));
    expect(raised.advance(10000).verdict).toBe('OPEN');
  });

  it('keeps a capacity-capped segment pending while earlier segments remain verified', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    fill(map, STONE, [[2, 1, 0]]);
    fill(map, AIR, [
      [1, 3, 0],
      [2, 3, 0],
    ]);
    const pairState: BlockState = { name: 'minecraft:box_pair', properties: {} };
    fill(map, pairState, [[2, 2, 0]]);
    const pairProvider: CollisionShapeProvider = {
      version: 'land-route-box-pair-1',
      resolve(state, cell, read) {
        if (state.name === pairState.name) {
          return {
            kind: 'shape',
            shape: {
              // Three boxes outside the body's Z footprint: they count against
              // the shape-box cap without introducing a real collision.
              boxes: [
                { minX: 0, minY: 0, minZ: 0, maxX: 0.3, maxY: 1, maxZ: 0.01 },
                { minX: 0.3, minY: 0, minZ: 0, maxX: 0.6, maxY: 1, maxZ: 0.01 },
                { minX: 0.6, minY: 0, minZ: 0, maxX: 0.9, maxY: 1, maxZ: 0.01 },
              ],
              supportFaces: [],
            },
          };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    const route: LandTransition[] = [
      STEP,
      { kind: 'step', from: { x: 1.5, y: 1, z: 0.5 }, to: { x: 2.5, y: 2, z: 0.5 } },
    ];
    const verifier = new LandRouteVerifier(map, { now: () => 2000, limits: { maxShapeBoxes: 2 } });
    verifier.register(request(route, { shapeProvider: pairProvider }));

    const capped = verifier.advance(100000);
    expect(capped.verdict).toBe('INCOMPLETE');
    expect(capped.complete).toBe(false);
    expect(capped.verifiedTransitionIndexes).toEqual([0]);
    expect(capped.pendingTransitionIndexes).toEqual([1]);
    expect(capped.segments[0]).toMatchObject({ kind: 'verified' });
    expect(capped.segments[1]).toMatchObject({ kind: 'pending' });
    expect(capped.budgetGap!.transitionIndex).toBe(1);
    expect(capped.budgetGap!.limit).toBe('maxShapeBoxes');
    expect(capped.budgetGap!.limitValue).toBe(2);
    expect(capped.budgetGap!.requiredLimitAtLeast).toBeGreaterThan(2);
    expect(capped.budgetGap!.diagnostic.kind).toBe('capacity');

    const raised = new LandRouteVerifier(map, { now: () => 2000, limits: { maxShapeBoxes: 10 } });
    raised.register(request(route, { shapeProvider: pairProvider }));
    expect(raised.advance(100000).verdict).toBe('OPEN');
  });

  it('reports a provider support-face cap as a configured limit and recovers with new limits', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    const small = new LandRouteVerifier(map, { now: () => 2000, limits: { maxSupportFaces: 1 } });
    small.register(request([STEP], { shapeProvider: landProvider }));

    const capped = small.advance(10000);
    expect(capped.verdict).toBe('INCOMPLETE');
    expect(capped.budgetGap!.limit).toBe('maxSupportFaces');
    expect(capped.budgetGap!.limitValue).toBe(1);
    expect(capped.budgetGap!.requiredLimitAtLeast).toBeGreaterThan(1);
    expect(capped.budgetGap!.recovery).toBe('raise_configured_limits');

    const raised = new LandRouteVerifier(map, { now: () => 2000, limits: { maxSupportFaces: 100 } });
    raised.register(request([STEP], { shapeProvider: landProvider }));
    expect(raised.advance(10000).verdict).toBe('OPEN');
  });

  it('rejects an oversized route before visiting later transition elements', () => {
    const map = new VoxelMap('world');
    const verifier = new LandRouteVerifier(map, { now: () => 2000, limits: { maxTransitions: 1 } });
    const transitions: LandTransition[] = [STEP];
    Object.defineProperty(transitions, 1, {
      enumerable: true,
      get() {
        throw new Error('later transition element was visited');
      },
    });

    expect(() => verifier.register(request(transitions, { shapeProvider: landProvider }))).toThrow(
      /exceeding the limit/,
    );
  });

  it('snapshots registration inputs and returns isolated status copies', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const transitions: LandTransition[] = MIXED.map((transition) => ({
      kind: transition.kind,
      from: { ...transition.from },
      to: { ...transition.to },
    }));
    const body = bodyAt(transitions[0]!.from);
    const input = request(transitions, rules, body);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(input);

    transitions[0]!.to.x = 99;
    transitions.push({ kind: 'step', from: { x: 99, y: 99, z: 99 }, to: { x: 100, y: 100, z: 99 } });
    body.feet.x = 77;

    const first = statusOf(verifier);
    expect(first.transitions).toEqual(MIXED);
    expect(first.body.feet.x).toBe(0.5);

    first.transitions[0]!.to.x = 42;
    expect(statusOf(verifier).transitions[0]!.to.x).toBe(1.5);
  });

  it('rejects invalid registration without replacing the existing route', () => {
    const map = new VoxelMap('world');
    fillMixed(map);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    const initial = verifier.register(request(MIXED, rules));

    const broken = MIXED.map((transition) => ({
      kind: transition.kind,
      from: { ...transition.from },
      to: { ...transition.to },
    }));
    broken[1]!.from.x = 1.25;
    expect(() => verifier.register(request(broken, rules))).toThrow(/must exactly equal/);

    const after = statusOf(verifier);
    expect(after.transitionCount).toBe(initial.transitionCount);
    expect(after.transitions).toEqual(initial.transitions);
    expect(after.pendingTransitionIndexes).toEqual([0, 1, 2]);

    const mismatchedBody = request(MIXED, rules, bodyAt({ x: 0.6, y: 0, z: 0.5 }));
    expect(() => verifier.register(mismatchedBody)).toThrow(/body\.feet/);
    expect(statusOf(verifier).transitions).toEqual(initial.transitions);
  });
});

describe('LandRouteVerifier — local invalidation, recovery and identity changes', () => {
  const TWO_SECTIONS: LandTransition[] = [
    { kind: 'step', from: { x: 15.5, y: 0, z: 0.5 }, to: { x: 16.5, y: 1, z: 0.5 } },
    { kind: 'drop', from: { x: 16.5, y: 1, z: 0.5 }, to: { x: 17.5, y: 0, z: 0.5 } },
  ];

  function fillTwoSections(map: VoxelMap): void {
    fill(map, STONE, [
      [15, -1, 0],
      [16, 0, 0],
      [17, -1, 0],
    ]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
      [15, 2, 0],
      [16, 1, 0],
      [16, 2, 0],
      [17, 0, 0],
      [17, 1, 0],
      [17, 2, 0],
    ]);
  }

  it('invalidates only transitions that depend on a changed Section', () => {
    const map = new VoxelMap('world');
    fillTwoSections(map);
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request(TWO_SECTIONS, { shapeProvider: landProvider }));
    expect(verifier.advance(10000).verdict).toBe('OPEN');

    // A far cell in Section cx = 0 is not read by either corridor, but Section 0
    // is a dependency of transition 0 and not transition 1.
    const report = fill(map, STONE, [[0, 0, 0]], 1500);
    const status = verifier.apply(report, 1);
    expect(status).not.toBeNull();
    expect(status!.pendingTransitionIndexes).toEqual([0]);
    expect(status!.verifiedTransitionIndexes).toEqual([1]);
    expect(status!.openPrefix).toBe(0);
    expect(status!.verdict).toBe('INCOMPLETE');
    expect(status!.budgetGap).toBeDefined();

    const done = verifier.advance(10000);
    expect(done.verdict).toBe('OPEN');
    expect(done.verifiedTransitionIndexes).toEqual([0, 1]);
  });

  it('recovers a STALE conclusion on a refresh-only ChangeReport without a revision bump', () => {
    const map = new VoxelMap('world', { validityWindowMs: 100 });
    fillOpenStep(map);
    let clock = 1050;
    const verifier = new LandRouteVerifier(map, { now: () => clock });
    verifier.register(request([STEP], { shapeProvider: landProvider }));

    const open = verifier.advance(10000);
    expect(open.verdict).toBe('OPEN');
    expect(open.validUntil).toBe(1100);
    // Reading status does not extend the proof TTL.
    expect(statusOf(verifier).validUntil).toBe(1100);

    clock = 1200;
    const expiredView = statusOf(verifier);
    expect(expiredView.verdict).not.toBe('OPEN');
    expect(expiredView.pendingTransitionIndexes).toEqual([0]);

    const stale = verifier.advance(10000);
    expect(stale.verdict).toBe('STALE');
    expect(stale.earliestProblem?.reason?.kind).toBe('expired');

    const revisionBefore = map.sectionAt('overworld', 0, 0, 0)?.revision;
    const report = refill(
      map,
      [
        { state: STONE, cells: [[0, -1, 0], [1, 0, 0]] },
        {
          state: AIR,
          cells: [
            [0, 0, 0],
            [0, 1, 0],
            [0, 2, 0],
            [1, 1, 0],
            [1, 2, 0],
          ],
        },
      ],
      1150,
    );
    expect(report.sections.every((section) => !section.invalidated)).toBe(true);
    expect(map.sectionAt('overworld', 0, 0, 0)?.revision).toBe(revisionBefore);

    const recovered = verifier.apply(report, 10000);
    expect(recovered?.verdict).toBe('OPEN');
    expect(recovered?.earliestProblem).toBeNull();
  });

  it('recovers an evidence-limited UNSUPPORTED conclusion on a same-content refresh', () => {
    const map = new VoxelMap('world', { validityWindowMs: 100 });
    const PROBE: BlockState = { name: 'minecraft:freshness_probe', properties: {} };
    const freshnessProvider: CollisionShapeProvider = {
      version: 'land-route-freshness-1',
      resolve(state, cell, read) {
        if (state.name === PROBE.name) {
          const neighbour = read.cell(0, 1, 2);
          if (neighbour.kind !== 'observed') {
            return {
              kind: 'unsupported_shape',
              block: state.name,
              detail: 'probe neighbour is not currently observed',
            };
          }
          return { kind: 'shape', shape: EMPTY };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    fill(map, STONE, [
      [0, -1, 0],
      [1, 0, 0],
    ], 1100);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ], 1100);
    fill(map, PROBE, [[0, 1, 0]], 1100);
    // This provider-consulted neighbour expires at 1100 while the corridor
    // evidence stays valid until 1200.
    fill(map, STONE, [[0, 1, 2]], 1000);

    const verifier = new LandRouteVerifier(map, { now: () => 1150 });
    verifier.register(request([STEP], { shapeProvider: freshnessProvider }));

    const unsupported = verifier.advance(10000);
    expect(unsupported.verdict).toBe('UNSUPPORTED');
    expect(unsupported.earliestProblem?.reason?.kind).toBe('unsupported_shape');
    expect(unsupported.pendingTransitionIndexes).toEqual([]);
    expect(unsupported.verifiedTransitionIndexes).toEqual([0]);
    const segment = unsupported.segments[0];
    if (segment?.kind !== 'verified') throw new Error('expected a verified conclusion');
    expect(segment.result.reasons.some((reason) => reason.kind === 'expired')).toBe(true);

    const revisionBefore = map.sectionAt('overworld', 0, 0, 0)?.revision;
    const report = fill(map, STONE, [[0, 1, 2]], 1150);
    expect(report.sections.every((section) => !section.invalidated)).toBe(true);
    expect(map.sectionAt('overworld', 0, 0, 0)?.revision).toBe(revisionBefore);

    const recovered = verifier.apply(report, 10000);
    expect(recovered?.verdict).toBe('OPEN');
    expect(recovered?.earliestProblem).toBeNull();
  });

  it('revokes proofs on shape-provider and jump-model version changes', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    for (let x = -1; x <= 1; x++) {
      for (let y = 0; y <= 3; y++) fill(map, AIR, [[x, y, 0]]);
    }
    const provider = { ...landProvider };
    const model = testJumpModel();
    const rules = { shapeProvider: provider, jumpModel: model };
    const jump: LandTransition[] = [{ kind: 'jump', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 } }];
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request(jump, rules));
    expect(verifier.advance(10000).verdict).toBe('OPEN');

    provider.version = 'land-route-shapes-2';
    const revoked = statusOf(verifier);
    expect(revoked.verdict).toBe('INCOMPLETE');
    expect(revoked.pendingTransitionIndexes).toEqual([0]);
    expect(revoked.invalidatedCount).toBe(1);
    const reopened = verifier.advance(10000);
    expect(reopened.verdict).toBe('OPEN');
    expect(reopened.ruleVersions.shapeProvider).toBe('land-route-shapes-2');

    model.version = 'test-quadratic-v2';
    expect(statusOf(verifier).pendingTransitionIndexes).toEqual([0]);
    const rejumped = verifier.advance(10000);
    expect(rejumped.verdict).toBe('OPEN');
    expect(rejumped.ruleVersions.jumpModel).toBe('test-quadratic-v2');
  });

  it('revokes proofs on a climb-provider version change', () => {
    const map = new VoxelMap('world');
    for (let y = 0; y <= 4; y++) map.observe(obs(y <= 2 ? LADDER : AIR, { x: 0, y, z: 0 }));
    const provider = testClimbProvider();
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(
      request(
        [{ kind: 'ladder', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 0.5, y: 3, z: 0.5 } }],
        { shapeProvider: landProvider, climbProvider: provider },
      ),
    );
    expect(verifier.advance(10000).verdict).toBe('OPEN');

    provider.version = 'test-climb-v2';
    expect(statusOf(verifier).invalidatedCount).toBe(1);
    const again = verifier.advance(10000);
    expect(again.verdict).toBe('OPEN');
    expect(again.ruleVersions.climbProvider).toBe('test-climb-v2');
  });

  it('invalidates a ladder proof when a cross-Section provider wall neighbour changes', () => {
    const map = new VoxelMap('world');
    for (let y = 15; y <= 19; y++) {
      map.observe(obs(y <= 17 ? LADDER : AIR, { x: 15, y, z: 0 }));
    }
    fill(map, STONE, [
      [16, 15, 0],
      [16, 16, 0],
      [16, 17, 0],
    ]);
    const wallClimb: ClimbRegionProvider = {
      version: 'test-wall-climb-1',
      resolve(input, read) {
        if (input.state.name !== LADDER.name) return { kind: 'regions', regions: [] };
        const neighbour = read.cell(input.cell.x + 1, input.cell.y, input.cell.z);
        if (neighbour.kind !== 'observed' || neighbour.state.name !== STONE.name) {
          return { kind: 'unsupported', detail: 'test ladder requires an observed wall neighbour' };
        }
        return { kind: 'regions', regions: [{ minFeetY: input.cell.y, maxFeetY: input.cell.y + 1 }] };
      },
    };
    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(
      request(
        [{ kind: 'ladder', from: { x: 15.5, y: 15, z: 0.5 }, to: { x: 15.5, y: 17.5, z: 0.5 } }],
        { shapeProvider: landProvider, climbProvider: wallClimb },
      ),
    );
    const open = verifier.advance(10000);
    expect(open.verdict).toBe('OPEN');
    const segment = open.segments[0];
    if (segment?.kind !== 'verified') throw new Error('expected a verified ladder');
    // The ladder cells are in cx = 0; the provider-consulted wall is in cx = 1.
    expect(segment.result.dependencies.some((dep) => dep.key.cx === 1 && dep.key.sy === 1)).toBe(true);

    const report = fill(map, AIR, [[16, 16, 0]], 1500);
    const changed = verifier.apply(report, 10000);
    expect(changed?.verdict).toBe('UNSUPPORTED');
    expect(changed?.earliestProblem?.reason?.kind).toBe('unsupported_provider');
    expect(changed?.verifiedTransitionIndexes).toEqual([0]);
  });
});

describe('LandRouteVerifier — TTL and residency', () => {
  it('revokes an old OPEN after Section unload/reload and recovers only after current evidence', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory([]);
    fillOpenStep(map);
    map.confirmSections(map.saveRevision);
    const checkpoint = map.checkpointSnapshot();
    map.commitDirectory('full', checkpoint.sections, []);
    const sectionKey = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 };

    const verifier = new LandRouteVerifier(map, { now: () => 2000 });
    verifier.register(request([STEP], { shapeProvider: landProvider }));
    expect(verifier.advance(10000).verdict).toBe('OPEN');

    const unloaded = map.unloadSections([sectionKey]);
    expect(unloaded.unloaded).toEqual([sectionKey]);
    const afterUnload = verifier.advance(10000);
    expect(afterUnload.verdict).toBe('UNKNOWN');
    expect(afterUnload.earliestProblem?.reason?.kind).toBe('nonresident');

    const sectionSnapshot = checkpoint.sections.find(
      (section) => section.cx === 0 && section.cz === 0 && section.sy === 0,
    );
    if (sectionSnapshot === undefined) throw new Error('missing checkpoint section');
    map.installLoadedSections([sectionSnapshot]);
    const afterReload = verifier.advance(10000);
    expect(afterReload.verdict).toBe('STALE');
    expect(afterReload.verdict).not.toBe('OPEN');

    const report = refill(
      map,
      [
        { state: STONE, cells: [[1, 0, 0]] },
        {
          state: AIR,
          cells: [
            [0, 0, 0],
            [0, 1, 0],
            [0, 2, 0],
            [1, 1, 0],
            [1, 2, 0],
          ],
        },
      ],
      1500,
    );
    const recovered = verifier.apply(report, 10000);
    expect(recovered?.verdict).toBe('OPEN');
  });
});
