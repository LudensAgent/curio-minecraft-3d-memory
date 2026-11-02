import { describe, expect, it } from 'vitest';

import { RouteVerifier, VoxelMap } from '../src/index.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import type { CollisionShapeProvider } from '../src/traversability/collision-shape.js';
import type { RouteRequest, RouteStatus } from '../src/traversability/route.js';
import { AIR, bodyAt, EMPTY, fakeProvider, FULL_CUBE, obs, STONE } from './fakes.js';

type Cell = [number, number, number];

/** Air for every cell the 0.6 × 1.8 body sweep touches when stepping +X from (0.5,0,0.5). */
const SWEPT_AIR: Cell[] = [
  [0, 0, 0],
  [0, 1, 0],
  [1, 0, 0],
  [1, 1, 0],
];

/**
 * Fill an all-OPEN +X route of `nPoints` feet (nPoints−1 steps), feet at
 * (k+0.5, 0, 0.5). Stone under every foot, air in every body cell.
 */
function openRouteMap(map: VoxelMap, nPoints: number): Vec3Like[] {
  for (let k = 0; k < nPoints; k++) {
    map.observe(obs(STONE, { x: k, y: -1, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 0, z: 0 }));
    map.observe(obs(AIR, { x: k, y: 1, z: 0 }));
  }
  return Array.from({ length: nPoints }, (_, k) => ({ x: k + 0.5, y: 0, z: 0.5 }));
}

function routeRequest(points: Vec3Like[], overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: fakeProvider,
    points,
    ...overrides,
  };
}

function fill(map: VoxelMap, state: BlockState, cells: Cell[]): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }));
}

function countingProvider(base: CollisionShapeProvider): {
  provider: CollisionShapeProvider;
  resolves: () => number;
} {
  let count = 0;
  const provider: CollisionShapeProvider = {
    version: base.version,
    resolve(state, cell, read) {
      count += 1;
      return base.resolve(state, cell, read);
    },
  };
  return { provider, resolves: () => count };
}

function status(verifier: RouteVerifier): RouteStatus {
  const s = verifier.status();
  if (s === null) throw new Error('expected a registered route');
  return s;
}

describe('RouteVerifier — decomposition and bounded verification', () => {
  it('verifies a multi-step route all OPEN only after full advance', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4); // 3 steps
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    const initial = verifier.register(routeRequest(points));
    expect(initial.verdict).toBe('INCOMPLETE');
    expect(initial.complete).toBe(false);
    expect(initial.stepCount).toBe(3);
    expect(initial.pendingStepIndexes).toEqual([0, 1, 2]);

    const done = verifier.advance(10);
    expect(done.verdict).toBe('OPEN');
    expect(done.complete).toBe(true);
    expect(done.openPrefix).toBe(3);
    expect(done.verifiedStepIndexes).toEqual([0, 1, 2]);
  });

  it('reports the earliest blocked step and the OPEN prefix', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4);
    // Wall at x=2 blocks step 1 (1.5→2.5) and later, but not step 0.
    map.observe(obs(STONE, { x: 2, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    const s = verifier.advance(10);

    expect(s.verdict).toBe('BLOCKED');
    expect(s.openPrefix).toBe(1);
    expect(s.earliestProblem?.stepIndex).toBe(1);
    expect(s.earliestProblem?.status).toBe('BLOCKED');
  });

  it('reports a missing-support step as UNKNOWN with the correct prefix', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4);
    // Remove the destination support under step 1 by confirming air there.
    map.observe(obs(AIR, { x: 2, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    const s = verifier.advance(10);

    expect(s.verdict).toBe('BLOCKED'); // confirmed air → missing support is a confirmed gap
    expect(s.openPrefix).toBe(1);
    expect(s.earliestProblem?.stepIndex).toBe(1);
  });

  it('reports a stale middle step at the right index', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 4);
    // Make only the support under step 1's destination stale, via a same-timestamp
    // content conflict. Step 0 (cells 0,1) stays FRESH.
    map.observe(obs(AIR, { x: 2, y: -1, z: 0 }, { observedAt: 1000, sequence: 2 }));

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    const s = verifier.advance(10);

    expect(s.verdict).toBe('STALE');
    expect(s.openPrefix).toBe(1);
    expect(s.earliestProblem?.stepIndex).toBe(1);
    expect(s.earliestProblem?.status).toBe('STALE');
  });

  it('handles negative coordinates, a section boundary, and both X/Z directions', () => {
    const map = new VoxelMap('world');
    // Route: (0.5,0,-0.5) → (-0.5,0,-0.5) [-X across cx boundary] → (-0.5,0,0.5) [+Z].
    const points: Vec3Like[] = [
      { x: 0.5, y: 0, z: -0.5 },
      { x: -0.5, y: 0, z: -0.5 },
      { x: -0.5, y: 0, z: 0.5 },
    ];
    fill(map, STONE, [
      [-1, -1, -1],
      [0, -1, -1],
      [-1, -1, 0],
    ]);
    fill(map, AIR, [
      [-1, 0, -1],
      [-1, 1, -1],
      [0, 0, -1],
      [0, 1, -1],
      [-1, 0, 0],
      [-1, 1, 0],
    ]);

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    const s = verifier.advance(10);

    expect(s.verdict).toBe('OPEN');
    expect(s.openPrefix).toBe(2);
    // Dependencies span both the negative and non-negative sections.
    const cxs = new Set<number>();
    for (const step of s.steps) {
      if (step.kind === 'verified') {
        for (const dep of step.result.dependencies) cxs.add(dep.key.cx);
      }
    }
    expect([...cxs].sort((a, b) => a - b)).toEqual([-1, 0]);
  });

  it('budget-limited advance never reports OPEN and converges to full verification', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 5); // 4 steps
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));

    const one = verifier.advance(1);
    expect(one.verdict).toBe('INCOMPLETE');
    expect(one.complete).toBe(false);
    expect(one.verifiedStepIndexes).toEqual([0]);

    const two = verifier.advance(2);
    expect(two.verifiedStepIndexes).toEqual([0, 1, 2]);
    expect(two.verdict).toBe('INCOMPLETE');

    const last = verifier.advance(10);
    expect(last.verdict).toBe('OPEN');
    expect(last.complete).toBe(true);
    expect(last.verifiedStepIndexes).toEqual([0, 1, 2, 3]);
  });

  it('rejects non-finite points, duplicate/diagonal/height/super-step moves', () => {
    const map = new VoxelMap('world');
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    expect(() => verifier.register(routeRequest([{ x: Number.NaN, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]))).toThrow(/finite/);
    expect(() =>
      verifier.register(routeRequest([{ x: 0.5, y: 0, z: 0.5 }, { x: 0.5, y: 0, z: 0.5 }])),
    ).toThrow(/exactly one cell/);
    expect(() =>
      verifier.register(routeRequest([{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }])),
    ).toThrow(/exactly one cell/);
    expect(() =>
      verifier.register(routeRequest([{ x: 0.5, y: 0, z: 0.5 }, { x: 0.5, y: 1, z: 0.5 }])),
    ).toThrow(/height/);
    expect(() =>
      verifier.register(routeRequest([{ x: 0.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }])),
    ).toThrow(/±1 cell/);
  });

  it('rejects non-finite body, mismatched feet, short routes, and exceeding the length cap', () => {
    const map = new VoxelMap('world');
    const verifier = new RouteVerifier(map, { now: () => 2000, maxRouteLength: 3 });
    const points = openRouteMap(map, 2);

    expect(() => verifier.register(routeRequest(points, { body: bodyAt(Number.NaN, 0, 0.5) }))).toThrow(/finite/);
    expect(() => verifier.register(routeRequest(points, { body: bodyAt(9, 0, 0.5) }))).toThrow(/must equal/);
    expect(() => verifier.register(routeRequest([points[0]!]))).toThrow(/at least two points/);
    expect(() => verifier.register(routeRequest(openRouteMap(map, 4)))).toThrow(/exceeding the limit/);
  });

  it('rejects invalid budgets', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));

    expect(() => verifier.advance(0)).toThrow(/positive integer/);
    expect(() => verifier.advance(-1)).toThrow(/positive integer/);
    expect(() => verifier.advance(1.5)).toThrow(/positive integer/);
    expect(() => verifier.advance(Number.NaN)).toThrow(/positive integer/);
  });

  it('reports a non-walk mode as UNSUPPORTED, not a physical block', () => {
    const map = new VoxelMap('world');
    openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    const s = verifier.register(routeRequest(openRouteMap(map, 2), { mode: 'jump' }));
    expect(s.verdict).toBe('UNSUPPORTED');
    expect(s.stepCount).toBe(0);
    expect(s.reason).toMatch(/outside the walk route verifier/);
  });

  it('rejects a worldId that does not match the map', () => {
    const map = new VoxelMap('world');
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    expect(() =>
      verifier.register(routeRequest(openRouteMap(map, 2), { worldId: 'other' })),
    ).toThrow(/does not match/);
  });

  it('requires a registered route before advance/apply and returns null status', () => {
    const map = new VoxelMap('world');
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    expect(verifier.status()).toBeNull();
    expect(() => verifier.advance(1)).toThrow(/no route registered/);
    expect(() => verifier.apply({ sections: [] }, 1)).toThrow(/no route registered/);
  });
});

describe('RouteVerifier — dependency-driven partial re-verification', () => {
  it('re-verifies only the steps depending on the changed section', () => {
    const map = new VoxelMap('world');
    // Route crossing the cx = 0 / cx = 1 boundary at x = 16.
    fill(map, STONE, [
      [15, -1, 0],
      [16, -1, 0],
      [17, -1, 0],
    ]);
    fill(map, AIR, [
      [15, 0, 0],
      [15, 1, 0],
      [16, 0, 0],
      [16, 1, 0],
      [17, 0, 0],
      [17, 1, 0],
    ]);
    const points: Vec3Like[] = [
      { x: 15.5, y: 0, z: 0.5 },
      { x: 16.5, y: 0, z: 0.5 },
      { x: 17.5, y: 0, z: 0.5 },
    ];

    let clock = 2000;
    const verifier = new RouteVerifier(map, { now: () => clock });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    clock = 3000;
    // Change a cell only in cx = 0 (x=15): step 0 depends on it, step 1 does not.
    const report = map.observe(obs(AIR, { x: 15, y: -1, z: 0 }, { observedAt: 3000, sequence: 2 }));
    const s = verifier.apply(report, 10);

    expect(s.steps[0]!.kind).toBe('verified');
    expect(s.steps[0]!.kind === 'verified' && s.steps[0]!.result.status).toBe('BLOCKED');
    // Step 1 was never invalidated: its result is preserved with the old computedAt.
    const step1 = s.steps[1]!;
    expect(step1.kind).toBe('verified');
    expect(step1.kind === 'verified' && step1.result.status).toBe('OPEN');
    expect(step1.kind === 'verified' && step1.result.computedAt).toBe(2000);
  });

  it('an unrelated section change triggers no re-evaluation', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const { provider, resolves } = countingProvider(fakeProvider);

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points, { shapeProvider: provider }));
    expect(verifier.advance(10).verdict).toBe('OPEN');
    const after = resolves();

    const report = map.observe(obs(STONE, { x: 100, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const s = verifier.apply(report, 10);

    expect(s.verdict).toBe('OPEN');
    expect(resolves()).toBe(after); // no step re-evaluated
  });

  it('a shape-rule neighbour outside the sweep invalidates locally', () => {
    const GATE: BlockState = { name: 'minecraft:gate', properties: {} };
    const gateProvider: CollisionShapeProvider = {
      version: 'gate-1',
      resolve(state, cell, read) {
        if (state.name !== 'minecraft:gate') return fakeProvider.resolve(state, cell, read);
        const front = read.cell(cell.x + 1, cell.y, cell.z);
        if (front.kind === 'observed') {
          return front.state.name === 'minecraft:air'
            ? { kind: 'shape', shape: EMPTY }
            : { kind: 'shape', shape: FULL_CUBE };
        }
        return { kind: 'neighbor_gap', view: front };
      },
    };

    // Step from 14.5 → 15.5; gate at x=15 whose required neighbour is x=16 (cx=1),
    // outside the body sweep.
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [14, -1, 0],
      [15, -1, 0],
    ]);
    fill(map, AIR, [
      [14, 0, 0],
      [14, 1, 0],
      [15, 1, 0],
    ]);
    map.observe(obs(GATE, { x: 15, y: 0, z: 0 }));
    const points: Vec3Like[] = [
      { x: 14.5, y: 0, z: 0.5 },
      { x: 15.5, y: 0, z: 0.5 },
    ];

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points, { shapeProvider: gateProvider }));
    expect(verifier.advance(10).verdict).toBe('UNKNOWN'); // neighbour section missing

    // First observation of the neighbour section recovers.
    let report = map.observe(obs(AIR, { x: 16, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    let s = verifier.apply(report, 10);
    expect(s.verdict).toBe('OPEN');

    // Neighbour becomes solid → locally re-verified to BLOCKED.
    report = map.observe(obs(STONE, { x: 16, y: 0, z: 0 }, { observedAt: 2000, sequence: 3 }));
    s = verifier.apply(report, 10);
    expect(s.verdict).toBe('BLOCKED');
  });
});

describe('RouteVerifier — time, session and context changes', () => {
  it('TTL expiry revokes old OPEN without a ChangeReport, and re-observation recovers', () => {
    let clock = 2000;
    const map = new VoxelMap('world', { now: () => clock });
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => clock });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    clock = 70_000; // past observedAt 1000 + 60_000 window
    const expired = status(verifier);
    expect(expired.verdict).toBe('INCOMPLETE');
    expect(expired.openPrefix).toBe(0);
    expect(expired.invalidatedCount).toBe(1);
    expect(expired.steps[0]).toEqual({ kind: 'pending', reason: 'invalidated' });

    clock = 71_000;
    const batch = {
      observations: [
        obs(STONE, { x: 0, y: -1, z: 0 }, { observedAt: 71_000, sequence: 2 }),
        obs(STONE, { x: 1, y: -1, z: 0 }, { observedAt: 71_000, sequence: 3 }),
        ...SWEPT_AIR.map(([x, y, z]) => obs(AIR, { x, y, z }, { observedAt: 71_000, sequence: 4 })),
      ],
      unobserved: [],
    };
    const report = map.observeBatch(batch);
    const s = verifier.apply(report, 10);
    expect(s.verdict).toBe('OPEN');
  });

  it('a session switch invalidates the route to STALE', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    const report = map.beginSession('s2');
    const s = verifier.apply(report, 10);
    expect(s.verdict).toBe('STALE');
  });

  it('a same-timestamp content conflict never leaves a stale OPEN', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    // Conflicting content at the exact same timestamp as the original observation.
    const report = map.observe(obs(AIR, { x: 0, y: -1, z: 0 }, { observedAt: 1000, sequence: 2 }));
    const s = verifier.apply(report, 10);
    expect(s.verdict).not.toBe('OPEN');
  });

  it('re-registering with a different body or rule version clears old results', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    // Different body width → old OPEN must not carry over.
    const wider = verifier.register(routeRequest(points, { body: bodyAt(0.5, 0, 0.5, 1.2, 1.8) }));
    expect(wider.verdict).toBe('INCOMPLETE');
    expect(wider.verifiedStepIndexes).toEqual([]);

    // Different rule version (hollow stone) → not OPEN.
    const hollow: CollisionShapeProvider = {
      version: 'hollow',
      resolve: () => ({ kind: 'shape', shape: { boxes: [], supportFaces: [] } }),
    };
    verifier.register(routeRequest(points, { shapeProvider: hollow }));
    expect(verifier.advance(10).verdict).toBe('BLOCKED');
  });
});

describe('RouteVerifier — bounded re-verification under budget pressure', () => {
  it('invalidates affected steps immediately and preserves unaffected ones', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [14, -1, 0],
      [15, -1, 0],
      [16, -1, 0],
      [17, -1, 0],
    ]);
    fill(map, AIR, [
      [14, 0, 0],
      [14, 1, 0],
      [15, 0, 0],
      [15, 1, 0],
      [16, 0, 0],
      [16, 1, 0],
      [17, 0, 0],
      [17, 1, 0],
    ]);
    const points: Vec3Like[] = [
      { x: 14.5, y: 0, z: 0.5 },
      { x: 15.5, y: 0, z: 0.5 },
      { x: 16.5, y: 0, z: 0.5 },
      { x: 17.5, y: 0, z: 0.5 },
    ];

    const verifier = new RouteVerifier(map, { now: () => 2000 });
    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    // Remove support in cx=1 → invalidates steps 1 and 2, but not step 0 (cx=0).
    const report = map.observe(obs(AIR, { x: 16, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const s = verifier.apply(report, 1); // budget only enough for one re-verification

    expect(s.steps[0]!.kind === 'verified' && s.steps[0]!.result.status).toBe('OPEN'); // preserved
    expect(s.steps[1]!.kind === 'verified' && s.steps[1]!.result.status).toBe('BLOCKED'); // re-verified
    expect(s.steps[2]).toEqual({ kind: 'pending', reason: 'invalidated' }); // budget exhausted
    expect(s.invalidatedCount).toBe(1);
    expect(s.verdict).toBe('BLOCKED'); // earliest problem is step 1
    expect(s.complete).toBe(false);
  });
});

describe('RouteVerifier — replace/clear isolation', () => {
  it('clearing a route detaches its dependencies from future changes', () => {
    const map = new VoxelMap('world');
    openRouteMap(map, 2); // route A region (cx=0)
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    verifier.register(routeRequest(openRouteMap(map, 2)));
    expect(verifier.advance(10).verdict).toBe('OPEN');
    verifier.clear();
    expect(verifier.status()).toBeNull();

    // Register route B in a different section, then mutate route A's section.
    fill(map, STONE, [
      [100, -1, 0],
      [101, -1, 0],
    ]);
    fill(map, AIR, [
      [100, 0, 0],
      [100, 1, 0],
      [101, 0, 0],
      [101, 1, 0],
    ]);
    verifier.register(
      routeRequest([
        { x: 100.5, y: 0, z: 0.5 },
        { x: 101.5, y: 0, z: 0.5 },
      ]),
    );
    expect(verifier.advance(10).verdict).toBe('OPEN');

    const report = map.observe(obs(AIR, { x: 0, y: -1, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const s = verifier.apply(report, 10);
    expect(s.verdict).toBe('OPEN'); // route B unaffected by route A's old section
  });

  it('replacing a route clears the previous route results', () => {
    const map = new VoxelMap('world');
    openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    verifier.register(routeRequest(openRouteMap(map, 2)));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    const replaced = verifier.register(routeRequest(openRouteMap(map, 3)));
    expect(replaced.verdict).toBe('INCOMPLETE');
    expect(replaced.verifiedStepIndexes).toEqual([]);
  });
});

describe('RouteVerifier — immutability and read-only guarantees', () => {
  it('mutating the request or a returned status does not pollute internal state', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    const request = routeRequest(points);
    verifier.register(request);
    // Mutate the caller-owned request after registration.
    request.points[0]!.x = 999;
    request.body.feet.x = 999;
    request.body.width = 999;

    const s = verifier.advance(10);
    expect(s.verdict).toBe('OPEN');
    expect(s.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(s.body.feet.x).toBe(0.5);
    expect(s.body.width).toBe(0.6);

    // Mutate the returned status.
    s.points[0]!.x = 999;
    s.body.width = 999;
    if (s.steps[0]!.kind === 'verified') s.steps[0]!.result.from.x = 999;

    const again = status(verifier);
    expect(again.points[0]).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(again.body.width).toBe(0.6);
    expect(again.steps[0]!.kind === 'verified' && again.steps[0]!.result.from.x).toBe(0.5);
  });

  it('status, advance and apply never mutate map evidence or time', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 2);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    const sectionBefore = map.sectionAt('overworld', 0, 0, 0);
    const cellBefore = map.cellAt('overworld', 0, -1, 0);

    verifier.register(routeRequest(points));
    verifier.advance(10);
    verifier.status();
    verifier.apply({ sections: [] }, 1);

    expect(map.sectionAt('overworld', 0, 0, 0)).toEqual(sectionBefore);
    expect(map.cellAt('overworld', 0, -1, 0)).toEqual(cellBefore);
  });

  it('full loop: observe → ChangeReport → invalidate → bounded re-verify → read', () => {
    const map = new VoxelMap('world');
    const points = openRouteMap(map, 3);
    const verifier = new RouteVerifier(map, { now: () => 2000 });

    verifier.register(routeRequest(points));
    expect(verifier.advance(10).verdict).toBe('OPEN');

    // World changes: a wall appears mid-route.
    const report = map.observe(obs(STONE, { x: 1, y: 0, z: 0 }, { observedAt: 1500, sequence: 2 }));
    const s = verifier.apply(report, 10);

    expect(s.verdict).toBe('BLOCKED');
    expect(s.earliestProblem?.stepIndex).toBe(0); // the wall is in step 0's sweep
    expect(s.steps[0]!.kind === 'verified' && s.steps[0]!.result.status).toBe('BLOCKED');
  });
});
