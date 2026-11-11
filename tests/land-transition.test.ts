import { describe, expect, it, vi } from 'vitest';

import {
  evaluateLandTransition,
  resolveLandLimits,
  VoxelMap,
} from '../src/index.js';
import type {
  BlockState,
  BodyContext,
  ClimbRegionProvider,
  CollisionShape,
  CollisionShapeProvider,
  LandLimits,
  LandMotionModel,
  LandRules,
  LandTransition,
  LandTransitionQuery,
  UnitBox,
} from '../src/index.js';
import {
  cellsInAabbBounded,
  jumpHitsBox,
  supportCandidateCells,
} from '../src/traversability/land-geometry.js';
import { AIR, EMPTY, fakeProvider, FULL_CUBE, obs, SLAB, STONE } from './fakes.js';

type Cell = [number, number, number];

const LADDER: BlockState = { name: 'minecraft:ladder', properties: { facing: 'north' } };

/** Test-only shape rules. Not Minecraft collision rules. Ladder collision is deliberately empty. */
const landProvider: CollisionShapeProvider = {
  version: 'land-test-shapes-1',
  resolve(state, cell, read) {
    if (state.name === LADDER.name) return { kind: 'shape', shape: EMPTY };
    return fakeProvider.resolve(state, cell, read);
  },
};

/** Test-only quadratic jump model. This is a geometric curve, not body capability. */
function testJumpModel(apexHeight = 1.25, version = 'test-quadratic-v1'): LandMotionModel {
  return {
    version,
    resolve({ from, to }) {
      if (from.y !== to.y) return { kind: 'unsupported', detail: 'test model requires equal feet heights' };
      return { kind: 'supported', trajectory: { apexHeight } };
    },
  };
}

/** Test-only ladder provider. Returns a one-block feet interval per observed ladder cell. */
function testClimbProvider(
  version = 'test-climb-v1',
  regionFor: (cell: Cell, input: Parameters<ClimbRegionProvider['resolve']>[0]) => Array<[number, number]> = (
    [x, y, z],
  ) => [[y, y + 1]],
): ClimbRegionProvider {
  return {
    version,
    resolve(input) {
      if (input.body.width > 0.6 || input.body.height > 1.8 || input.body.pose !== 'standing') {
        return { kind: 'unsupported', detail: 'test ladder only supports a 0.6 × 1.8 standing body' };
      }
      if (input.state.name !== LADDER.name) return { kind: 'regions', regions: [] };
      const cell: Cell = [input.cell.x, input.cell.y, input.cell.z];
      return {
        kind: 'regions',
        regions: regionFor(cell, input).map(([minFeetY, maxFeetY]) => ({ minFeetY, maxFeetY })),
      };
    },
  };
}

function fill(map: VoxelMap, state: BlockState, cells: readonly Cell[], observedAt = 1000): void {
  for (const [x, y, z] of cells) map.observe(obs(state, { x, y, z }, { observedAt }));
}

function bodyAt(from: { x: number; y: number; z: number }, width = 0.6, height = 1.8): BodyContext {
  return { feet: { x: from.x, y: from.y, z: from.z }, width, height, pose: 'standing' };
}

function query(transition: LandTransition, overrides: Partial<LandTransitionQuery> = {}): LandTransitionQuery {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    body: bodyAt(transition.from),
    transition,
    ...overrides,
  };
}

function evaluate(
  map: VoxelMap,
  transition: LandTransition,
  rules: LandRules = { shapeProvider: landProvider },
  options: { now?: number; limits?: Partial<LandLimits>; body?: BodyContext; sessionId?: string } = {},
) {
  return evaluateLandTransition(
    map,
    query(transition, {
      body: options.body ?? bodyAt(transition.from),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }),
    rules,
    options.now ?? 2000,
    resolveLandLimits(options.limits),
  );
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

describe('land step geometry', () => {
  it('OPEN: exact linear lift plus target-height translation with start/landing support', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);

    const result = evaluate(map, STEP);
    expect(result.status).toBe('OPEN');
    expect(result.assurance).toBe('geometry_only');
    expect(result.executable).toBe(false);
    expect(result.from).toEqual(STEP.from);
    expect(result.to).toEqual(STEP.to);
    expect(result.dependencies.length).toBeGreaterThan(0);
    expect(result.work.used).toBeGreaterThan(0);
  });

  it('BLOCKED: known head/side collision in the declared corridor', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    fill(map, STONE, [[1, 1, 0]], 1500);

    const result = evaluate(map, STEP);
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('collision');
    expect(result.obstacles).toHaveLength(1);
  });

  it('OPEN: negative coordinates and fractional slab support at the exact feet height', () => {
    const map = new VoxelMap('world');
    fill(map, SLAB, [
      [-1, 0, -1],
      [-2, 1, -1],
    ]);
    fill(map, AIR, [
      [-1, 1, -1],
      [-1, 2, -1],
      [-1, 3, -1],
      [-2, 0, -1],
      [-2, 2, -1],
      [-2, 3, -1],
    ]);

    const transition: LandTransition = {
      kind: 'step',
      from: { x: -0.5, y: 0.5, z: -0.5 },
      to: { x: -1.5, y: 1.5, z: -0.5 },
    };
    const result = evaluate(map, transition);
    expect(result.status).toBe('OPEN');
  });

  it('BLOCKED: destination support is observed absent', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    fill(map, AIR, [[1, 0, 0]], 1500);

    const result = evaluate(map, STEP);
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('missing_support');
  });

  it('UNKNOWN: a support candidate is unobserved (unknown, not known absence)', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);
    // (1,0,0) deliberately unobserved.

    const result = evaluate(map, STEP);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason?.kind).toBe('unobserved');
  });

  it('UNSUPPORTED: wrong rise and non-axis target are disallowed ranges', () => {
    const map = new VoxelMap('world');
    const tooHigh = evaluate(map, { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 2, z: 0.5 } });
    expect(tooHigh.status).toBe('UNSUPPORTED');
    expect(tooHigh.reason?.kind).toBe('unsupported_range');

    const diagonal = evaluate(map, { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 1.5 } });
    expect(diagonal.status).toBe('UNSUPPORTED');
    expect(diagonal.reason?.kind).toBe('unsupported_range');

    const sameColumn = evaluate(map, { kind: 'step', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 0.5, y: 1, z: 0.5 } });
    expect(sameColumn.status).toBe('UNSUPPORTED');
  });

  it('UNKNOWN: state-incomplete evidence is distinct from unobserved cells', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);
    map.observe(obs(AIR, { x: 1, y: 1, z: 0 }, { observedAt: 1500, stateComplete: false }));

    const result = evaluate(map, STEP);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reasons.some((reason) => reason.kind === 'incomplete_evidence')).toBe(true);
  });

  it('evidence from another session or past validUntil stays usable; only a pending effect is STALE', () => {
    const otherSession = new VoxelMap('world');
    fillOpenStep(otherSession);
    expect(evaluate(otherSession, STEP, { shapeProvider: landProvider }, { sessionId: 's2' }).status).toBe('OPEN');

    const aged = new VoxelMap('world', { validityWindowMs: 100 });
    fillOpenStep(aged);
    expect(evaluate(aged, STEP, { shapeProvider: landProvider }, { now: 2000 }).status).toBe('OPEN');

    aged.invalidatePendingEffect('overworld', { x: 1, y: 1, z: 0 });
    const pending = evaluate(aged, STEP, { shapeProvider: landProvider }, { now: 2000 });
    expect(pending.status).toBe('STALE');
    expect(pending.reasons.some((reason) => reason.kind === 'stale')).toBe(true);
    expect(pending.reasons.some((reason) => reason.kind === 'expired' || reason.kind === 'wrong_session')).toBe(false);
  });

  it('BLOCKED: all-observed zero-area support contact does not count as support', () => {
    const edgeProvider: CollisionShapeProvider = {
      version: 'land-test-edge-1',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:edge_support') {
          const shape: CollisionShape = {
            boxes: [],
            supportFaces: [{ top: 1, minX: 0.8, minZ: 0, maxX: 1, maxZ: 1 }],
          };
          return { kind: 'shape', shape };
        }
        if (state.name === 'minecraft:edge_support_positive') {
          const shape: CollisionShape = {
            boxes: [],
            supportFaces: [{ top: 1, minX: 0.79, minZ: 0, maxX: 1, maxZ: 1 }],
          };
          return { kind: 'shape', shape };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    const touching = new VoxelMap('world');
    fill(touching, { name: 'minecraft:edge_support', properties: {} }, [[0, -1, 0]]);
    fill(touching, STONE, [[1, 0, 0]]);
    fill(touching, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);
    const blocked = evaluate(touching, STEP, { shapeProvider: edgeProvider });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.reason?.kind).toBe('missing_support');

    const overlapping = new VoxelMap('world');
    fill(overlapping, { name: 'minecraft:edge_support_positive', properties: {} }, [[0, -1, 0]]);
    fill(overlapping, STONE, [[1, 0, 0]]);
    fill(overlapping, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);
    const open = evaluate(overlapping, STEP, { shapeProvider: edgeProvider });
    expect(open.status).toBe('OPEN');
  });

  it('BLOCKED: an off-center body hits a side obstacle a centered body would miss', () => {
    const edgeColumn: CollisionShape = {
      boxes: [{ minX: 0.8, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
      supportFaces: [],
    };
    const provider: CollisionShapeProvider = {
      version: 'land-test-edge-column-1',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:edge_column') return { kind: 'shape', shape: edgeColumn };
        return landProvider.resolve(state, cell, read);
      },
    };
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, 0, 0],
    ]);
    fill(map, { name: 'minecraft:edge_column', properties: {} }, [[-1, 0, 0]]);
    fill(map, AIR, [
      [-1, 1, 0],
      [-1, 2, 0],
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);

    const transition: LandTransition = {
      kind: 'step',
      from: { x: 0.1, y: 0, z: 0.5 },
      to: { x: 1.1, y: 1, z: 0.5 },
    };
    const result = evaluate(map, transition, { shapeProvider: provider });
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('collision');
  });
});

describe('land support evidence and optional candidate diagnostics', () => {
  const PROBE: BlockState = { name: 'minecraft:support_probe', properties: {} };
  const supportProbeProvider: CollisionShapeProvider = {
    version: 'land-test-support-probe-2',
    resolve(state, cell, read) {
      if (state.name === PROBE.name) {
        const view = read.cell(cell.x - 1, cell.y, cell.z);
        if (view.kind !== 'observed') return { kind: 'neighbor_gap', view };
        return { kind: 'shape', shape: EMPTY };
      }
      return landProvider.resolve(state, cell, read);
    },
  };

  const PROBE_STEP: LandTransition = {
    kind: 'step',
    from: { x: 1, y: 0, z: 0.5 },
    to: { x: 2, y: 1, z: 0.5 },
  };

  /** Air cells needed by both legs of PROBE_STEP's collision corridors. */
  function fillProbeCorridor(map: VoxelMap): void {
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 2, 0],
      [2, 1, 0],
      [2, 2, 0],
    ]);
  }

  it('OPEN: one known positive-area support face is enough while an optional candidate is unobserved', () => {
    const transition: LandTransition = {
      kind: 'step',
      from: { x: 0.1, y: 0, z: 0.5 },
      to: { x: 1.1, y: 1, z: 0.5 },
    };
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, 0, 0],
    ]);
    fill(map, AIR, [
      [-1, 0, 0],
      [-1, 1, 0],
      [-1, 2, 0],
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);
    // (-1,-1,0) is a support-only candidate and deliberately unobserved.
    expect(evaluate(map, transition).status).toBe('OPEN');
  });

  it('OPEN: an optional support provider neighbor gap does not poison proven support', () => {
    // Probe is visited first and buffers its neighbor_gap; the later stone face
    // proves start support, so the optional gap must be discarded.
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [2, 0, 0],
      [1, -1, 0],
    ]);
    fill(map, PROBE, [[0, -1, 0]]);
    fillProbeCorridor(map);
    // (-1,-1,0), consulted by the optional probe, is deliberately unobserved.
    const result = evaluate(map, PROBE_STEP, { shapeProvider: supportProbeProvider });
    expect(result.status).toBe('OPEN');
  });

  it('OPEN: the reported scenario with sufficient support before an optional probe', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [2, 0, 0],
      [0, -1, 0],
    ]);
    fill(map, PROBE, [[1, -1, 0]]);
    fillProbeCorridor(map);

    const result = evaluate(map, PROBE_STEP, { shapeProvider: supportProbeProvider });
    expect(result.status).toBe('OPEN');
  });

  it('UNKNOWN: a supporting provider cannot hide its own consulted neighbor gap by returning a face', () => {
    // Opposite direction to the optional-gap case above: here the start support
    // can only come from the provider that consults unobserved (-1,-1,0). A face
    // returned while its own consulted evidence is missing cannot prove support.
    const hiddenGapProvider: CollisionShapeProvider = {
      version: 'land-test-support-hidden-gap-1',
      resolve(state, cell, read) {
        if (state.name === STONE.name) {
          read.cell(cell.x - 1, cell.y, cell.z);
          return { kind: 'shape', shape: FULL_CUBE };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    const transition: LandTransition = {
      kind: 'step',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 1, z: 0.5 },
    };
    const map = new VoxelMap('world');
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

    const result = evaluate(map, transition, { shapeProvider: hiddenGapProvider });
    expect(result.status).toBe('UNKNOWN');
    const gap = result.reasons.find((reason) => reason.kind === 'unobserved');
    expect(gap?.cells).toContainEqual({ x: -1, y: -1, z: 0 });
  });

  it('UNKNOWN: an optional provider gap is preserved when no support can be proven', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[2, 0, 0]]);
    fill(map, PROBE, [[0, -1, 0]]);
    fillProbeCorridor(map);
    // (1,-1,0) is observed air; (-1,-1,0) is the probe's missing neighbor.

    const result = evaluate(map, PROBE_STEP, { shapeProvider: supportProbeProvider });
    expect(result.status).toBe('UNKNOWN');
    const gap = result.reasons.find((reason) => reason.kind === 'unobserved');
    expect(gap?.cells).toContainEqual({ x: -1, y: -1, z: 0 });

    // The same geometry with ordinary air is a known absence, not UNKNOWN.
    const allAir = new VoxelMap('world');
    fill(allAir, STONE, [[2, 0, 0]]);
    fill(allAir, AIR, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    fillProbeCorridor(allAir);
    const blocked = evaluate(allAir, PROBE_STEP);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.reason?.kind).toBe('missing_support');
  });
});

const DROP: LandTransition = {
  kind: 'drop',
  from: { x: 0.5, y: 0, z: 0.5 },
  to: { x: 1.5, y: -5, z: 0.5 },
};

function fillOpenDrop(map: VoxelMap): void {
  fill(map, STONE, [
    [0, -1, 0],
    [1, -6, 0],
  ]);
  fill(map, AIR, [
    [-1, 0, 0],
    [-1, 1, 0],
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
    [1, -1, 0],
    [1, -2, 0],
    [1, -3, 0],
    [1, -4, 0],
    [1, -5, 0],
  ]);
}

describe('land drop geometry', () => {
  it('OPEN: horizontal translation then vertical descent, with an actual fall hazard and no veto', () => {
    const map = new VoxelMap('world');
    fillOpenDrop(map);

    const result = evaluate(map, DROP);
    expect(result.status).toBe('OPEN');
    expect(result.hazards).toHaveLength(1);
    expect(result.hazards[0]?.kind).toBe('fall');
    expect(result.hazards[0]?.detail).toContain('5');
    expect(result.executable).toBe(false);
  });

  it('BLOCKED: known landing support absent', () => {
    const map = new VoxelMap('world');
    fillOpenDrop(map);
    fill(map, AIR, [[1, -6, 0]], 1500);

    const result = evaluate(map, DROP);
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('missing_support');
  });

  it('UNKNOWN: landing support candidate unobserved', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [[0, -1, 0]]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
      [1, -1, 0],
      [1, -2, 0],
      [1, -3, 0],
      [1, -4, 0],
      [1, -5, 0],
    ]);
    // (1,-6,0) deliberately unobserved.

    const result = evaluate(map, DROP);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason?.kind).toBe('unobserved');
  });

  it('BLOCKED: known obstacle in the horizontal leg', () => {
    const map = new VoxelMap('world');
    fillOpenDrop(map);
    fill(map, STONE, [[1, 0, 0]], 1500);

    const result = evaluate(map, DROP);
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('collision');
  });

  it('BLOCKED: a narrow obstacle between both endpoints is caught by the continuous sweep', () => {
    const midGapProvider: CollisionShapeProvider = {
      version: 'land-test-midgap-1',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:midgap') {
          return {
            kind: 'shape',
            shape: {
              boxes: [{ minX: 0, minY: 0.5, minZ: 0.3, maxX: 0.05, maxY: 0.6, maxZ: 0.4 }],
              supportFaces: [],
            },
          };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    const map = new VoxelMap('world');
    fillOpenDrop(map);
    // World box [1, 1.05] × [0.5, 0.6] × [0.3, 0.4]. The body misses it at
    // both endpoint positions and only intersects it mid-translation.
    fill(map, { name: 'minecraft:midgap', properties: {} }, [[1, 0, 0]], 1500);

    const result = evaluate(map, DROP, { shapeProvider: midGapProvider });
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('collision');
  });

  it('UNSUPPORTED: non-adjacent or upward target is outside the drop subset', () => {
    const map = new VoxelMap('world');
    const far = evaluate(map, { kind: 'drop', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 3.5, y: -1, z: 0.5 } });
    expect(far.status).toBe('UNSUPPORTED');
    expect(far.reason?.kind).toBe('unsupported_range');

    const up = evaluate(map, { kind: 'drop', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 0.5 } });
    expect(up.status).toBe('UNSUPPORTED');
  });
});

const JUMP: LandTransition = {
  kind: 'jump',
  from: { x: 0.5, y: 0, z: 0.5 },
  to: { x: 1.5, y: 0, z: 0.5 },
};

function fillOpenJump(map: VoxelMap, toX = 1.5): void {
  fill(map, STONE, [
    [0, -1, 0],
    [Math.floor(toX), -1, 0],
  ]);
  const maxX = Math.floor(toX + 0.3 - 1e-9);
  for (let x = -1; x <= maxX; x++) {
    for (let y = 0; y <= 3; y++) fill(map, AIR, [[x, y, 0]]);
  }
}

describe('land jump geometry', () => {
  const rules = (model?: LandMotionModel): LandRules => ({
    shapeProvider: landProvider,
    ...(model === undefined ? {} : { jumpModel: model }),
  });

  it('OPEN: explicit quadratic model, whole-arc collision sweep, no airborne support requirement', () => {
    const map = new VoxelMap('world');
    fillOpenJump(map);

    const result = evaluate(map, JUMP, rules(testJumpModel()));
    expect(result.status).toBe('OPEN');
    expect(result.model).toEqual({ kind: 'jump', version: 'test-quadratic-v1' });
    expect(result.hazards).toHaveLength(0);
  });

  it('UNSUPPORTED: missing model even with empty space; unsupported model output is distinct', () => {
    const map = new VoxelMap('world');
    fillOpenJump(map);

    const missing = evaluate(map, JUMP, rules());
    expect(missing.status).toBe('UNSUPPORTED');
    expect(missing.reason?.kind).toBe('unsupported_model');

    const unsupported = evaluate(map, JUMP, rules({
      version: 'test-unsupported-v1',
      resolve: () => ({ kind: 'unsupported', detail: 'test model refuses this arc' }),
    }));
    expect(unsupported.status).toBe('UNSUPPORTED');
    expect(unsupported.reason?.kind).toBe('unsupported_model');
    expect(unsupported.reason?.detail).toContain('refuses');
  });

  it('BLOCKED: whole quadratic arc is swept, not endpoints or a bounding envelope', () => {
    const map = new VoxelMap('world');
    fillOpenJump(map);
    fill(map, STONE, [[1, 2, 0]], 1500); // only reachable near the apex

    const result = evaluate(map, JUMP, rules(testJumpModel()));
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('collision');
  });

  it('OPEN: an envelope corner never occupied by the body is not a collision', () => {
    const map = new VoxelMap('world');
    const transition: LandTransition = {
      kind: 'jump',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 2.5, y: 0, z: 0.5 },
    };
    fillOpenJump(map, 2.5);
    fill(map, STONE, [[-1, 3, 0]], 1500); // envelope corner: low X only at t=0, high Y only near t=0.5

    const result = evaluate(map, transition, rules(testJumpModel()));
    expect(result.status).toBe('OPEN');
  });

  it('OPEN: a true in-envelope cell the body never occupies needs neither collision nor evidence', () => {
    const transition: LandTransition = {
      kind: 'jump',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 2.5, y: 0, z: 0.5 },
    };

    // [0,3,0] is inside the jump envelope, but X overlap ends at t=0.4 while the
    // body top only rises above y=3 at t>0.4. A solid block there is not a hit.
    const solid = new VoxelMap('world');
    fillOpenJump(solid, 2.5);
    fill(solid, STONE, [[0, 3, 0]], 1500);
    expect(evaluate(solid, transition, rules(testJumpModel())).status).toBe('OPEN');

    // Leaving exactly that unoccupied cell unobserved must not demand evidence.
    const missing = new VoxelMap('world');
    fill(missing, STONE, [
      [0, -1, 0],
      [2, -1, 0],
    ]);
    for (let x = -1; x <= 2; x++) {
      for (let y = 0; y <= 3; y++) {
        if (x === 0 && y === 3) continue;
        missing.observe(obs(AIR, { x, y, z: 0 }));
      }
    }
    expect(evaluate(missing, transition, rules(testJumpModel())).status).toBe('OPEN');
  });

  it('UNKNOWN: any unobserved cell actually needed by the arc blocks OPEN', () => {
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, -1, 0],
    ]);
    for (let x = -1; x <= 1; x++) {
      for (let y = 0; y <= 3; y++) {
        if (x === 1 && y === 1) continue; // remove one required swept cell
        map.observe(obs(AIR, { x, y, z: 0 }));
      }
    }

    const result = evaluate(map, JUMP, rules(testJumpModel()));
    expect(result.status).toBe('UNKNOWN');
    expect(result.reasons.some((reason) => reason.kind === 'unobserved')).toBe(true);
  });

  it('UNSUPPORTED: diagonal, height-changing and over-limit jumps are ranges, not BLOCKED', () => {
    const map = new VoxelMap('world');
    const diagonal = evaluate(
      map,
      { kind: 'jump', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 1.5 } },
      rules(testJumpModel()),
    );
    expect(diagonal.status).toBe('UNSUPPORTED');
    expect(diagonal.reason?.kind).toBe('unsupported_range');

    const higher = evaluate(
      map,
      { kind: 'jump', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 1, z: 0.5 } },
      rules(testJumpModel()),
    );
    expect(higher.status).toBe('UNSUPPORTED');

    const tooFar = evaluate(
      map,
      { kind: 'jump', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 5.5, y: 0, z: 0.5 } },
      rules(testJumpModel()),
      { limits: { maxJumpDistance: 4 } },
    );
    expect(tooFar.status).toBe('UNSUPPORTED');
    expect(tooFar.reason?.kind).toBe('unsupported_range');
  });
});

describe('continuous quadratic collision intervals', () => {
  const FULL: UnitBox = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  const from = { x: 0.5, y: 0, z: 0.5 };
  const to = { x: 2.5, y: 0, z: 0.5 };
  const apex = 1.25;
  const half = 0.3;
  const height = 1.8;

  it('keeps ascending-only, descending-only and mid-arc contacts distinct', () => {
    // Low cell at the start is only reachable while y is still below 1 (ascending).
    expect(jumpHitsBox({ x: 0, y: 0, z: 0 }, FULL, from, to, apex, half, height)).toBe(true);
    // Low cell at the far end is only reachable after the descending branch.
    expect(jumpHitsBox({ x: 2, y: 0, z: 0 }, FULL, from, to, apex, half, height)).toBe(true);
    // Mid-arc cell is reachable near the apex.
    expect(jumpHitsBox({ x: 1, y: 2, z: 0 }, FULL, from, to, apex, half, height)).toBe(true);
  });

  it('treats an exact apex tangency and an unoccupied envelope corner as non-collisions', () => {
    // With apex 1.5 and body height 1.5, the body top is exactly 3.0 at the
    // apex. A full cell at y=3 only touches it at a single instant (zero positive
    // overlap), using exactly representable floating-point values.
    expect(jumpHitsBox({ x: 1, y: 3, z: 0 }, FULL, from, to, 1.5, half, 1.5)).toBe(false);
    expect(jumpHitsBox({ x: 0, y: 3, z: 0 }, FULL, from, to, apex, half, height)).toBe(false);
  });

  it('detects a thin obstacle only while the moving body overlaps it', () => {
    const thin: UnitBox = { minX: 0.9, minY: 0, minZ: 0, maxX: 0.95, maxY: 1, maxZ: 1 };
    expect(jumpHitsBox({ x: 1, y: 0, z: 0 }, thin, from, to, apex, half, height)).toBe(true);
  });
});

const LADDER_UP: LandTransition = {
  kind: 'ladder',
  from: { x: 0.5, y: 0, z: 0.5 },
  to: { x: 0.5, y: 3, z: 0.5 },
};

function fillLadder(map: VoxelMap, from: number, to: number): void {
  for (let y = from; y <= to + 1; y++) {
    map.observe(obs(y <= to - 1 ? LADDER : AIR, { x: 0, y, z: 0 }));
  }
}

describe('land ladder geometry', () => {
  it('OPEN: continuous provider regions cover the full fixed-XZ vertical travel', () => {
    const map = new VoxelMap('world');
    fillLadder(map, 0, 3);

    const result = evaluate(map, LADDER_UP, {
      shapeProvider: landProvider,
      climbProvider: testClimbProvider(),
    });
    expect(result.status).toBe('OPEN');
    expect(result.provider).toEqual({ kind: 'climb', version: 'test-climb-v1' });
  });

  it('OPEN: a provider region from upper-body contact above the feet interval counts', () => {
    // The only ladder is at cell Y = 1 while the feet travel is [0, 0.5]. The
    // 1.8-tall body overlaps that cell throughout the travel, so it is a source
    // candidate even though no feet position enters [1, 2]. The provider region
    // [-0.7, 1.9] is asserted as-is and must not be clipped to [cellY, cellY + 1].
    const transition: LandTransition = {
      kind: 'ladder',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 0.5, y: 0.5, z: 0.5 },
    };
    const map = new VoxelMap('world');
    fill(map, AIR, [[0, 0, 0]]);
    fill(map, LADDER, [[0, 1, 0]]);
    fill(map, AIR, [[0, 2, 0]]);
    const consulted: Cell[] = [];
    const upperBodyProvider: ClimbRegionProvider = {
      version: 'test-upper-body-climb-1',
      resolve(input) {
        consulted.push([input.cell.x, input.cell.y, input.cell.z]);
        if (input.cell.y === 1) {
          return { kind: 'regions', regions: [{ minFeetY: -0.7, maxFeetY: 1.9 }] };
        }
        return { kind: 'regions', regions: [] };
      },
    };

    const result = evaluate(map, transition, {
      shapeProvider: landProvider,
      climbProvider: upperBodyProvider,
    });
    expect(result.status).toBe('OPEN');
    expect(consulted).toContainEqual([0, 1, 0]);
  });

  it('BLOCKED: no provider region covering the travel is a known absence', () => {
    const transition: LandTransition = {
      kind: 'ladder',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 0.5, y: 0.5, z: 0.5 },
    };
    const map = new VoxelMap('world');
    fill(map, AIR, [[0, 0, 0]]);
    fill(map, LADDER, [[0, 1, 0]]);
    fill(map, AIR, [[0, 2, 0]]);
    const noContact: ClimbRegionProvider = {
      version: 'test-no-contact-1',
      resolve() {
        return { kind: 'regions', regions: [] };
      },
    };

    const result = evaluate(map, transition, {
      shapeProvider: landProvider,
      climbProvider: noContact,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('missing_climb_contact');
  });

  it('BLOCKED: a known continuous gap in climb contact is not skipped', () => {
    const map = new VoxelMap('world');
    fillLadder(map, 0, 3);
    const provider = testClimbProvider('test-climb-gap-v1', ([, y]) => (y <= 1 ? [[y, y + 1]] : []));

    const result = evaluate(map, LADDER_UP, { shapeProvider: landProvider, climbProvider: provider });
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('missing_climb_contact');
  });

  it('BLOCKED: even a narrow uncovered interval is a gap', () => {
    const map = new VoxelMap('world');
    fillLadder(map, 0, 3);
    const provider = testClimbProvider('test-climb-narrow-gap-v1', ([, y]) => {
      if (y === 0) return [[0, 2]];
      if (y === 1) return [[2.0001, 3]];
      return [];
    });

    const result = evaluate(map, LADDER_UP, { shapeProvider: landProvider, climbProvider: provider });
    expect(result.status).toBe('BLOCKED');
    expect(result.reason?.kind).toBe('missing_climb_contact');
  });

  it('UNSUPPORTED: missing provider, diagonal travel and body-dependent provider refusal', () => {
    const map = new VoxelMap('world');
    fillLadder(map, 0, 3);

    const missing = evaluate(map, LADDER_UP, { shapeProvider: landProvider });
    expect(missing.status).toBe('UNSUPPORTED');
    expect(missing.reason?.kind).toBe('unsupported_provider');

    const diagonal = evaluate(
      map,
      { kind: 'ladder', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 3, z: 0.5 } },
      { shapeProvider: landProvider, climbProvider: testClimbProvider() },
    );
    expect(diagonal.status).toBe('UNSUPPORTED');
    expect(diagonal.reason?.kind).toBe('unsupported_range');

    const wideBody = evaluate(
      map,
      LADDER_UP,
      { shapeProvider: landProvider, climbProvider: testClimbProvider() },
      { body: bodyAt(LADDER_UP.from, 1.2) },
    );
    expect(wideBody.status).toBe('UNSUPPORTED');
    expect(wideBody.reason?.kind).toBe('unsupported_provider');
  });

  it('OPEN: a high multi-section traversal reads every necessary cell', () => {
    const map = new VoxelMap('world');
    const transition: LandTransition = {
      kind: 'ladder',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 0.5, y: 40, z: 0.5 },
    };
    for (let y = 0; y <= 41; y++) {
      map.observe(obs(y <= 39 ? LADDER : AIR, { x: 0, y, z: 0 }));
    }

    const result = evaluate(map, transition, {
      shapeProvider: landProvider,
      climbProvider: testClimbProvider(),
    });
    expect(result.status).toBe('OPEN');

    const budgeted = evaluate(
      map,
      transition,
      { shapeProvider: landProvider, climbProvider: testClimbProvider() },
      { limits: { maxWork: 50 } },
    );
    expect(budgeted.status).toBe('INCOMPLETE');
    expect(budgeted.reason?.kind).toBe('budget');
    expect(budgeted.work.exhausted).toBe(true);
    expect(budgeted.work.requiredAtLeast).toBeGreaterThan(budgeted.work.used);
  });
});

describe('land evidence boundaries and hard limits', () => {
  it('UNKNOWN: a provider-consulted neighbor gap is tracked even when a shape is returned', () => {
    const probeProvider: CollisionShapeProvider = {
      version: 'land-test-probe-1',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:test_probe') {
          read.cell(cell.x, cell.y, cell.z + 1); // deliberately ignore the gap and return EMPTY
          return { kind: 'shape', shape: EMPTY };
        }
        return landProvider.resolve(state, cell, read);
      },
    };
    const map = new VoxelMap('world');
    fill(map, STONE, [
      [0, -1, 0],
      [1, 0, 0],
    ]);
    fill(map, { name: 'minecraft:test_probe', properties: {} }, [[0, 1, 0]]);
    fill(map, AIR, [
      [0, 0, 0],
      [0, 2, 0],
      [1, 1, 0],
      [1, 2, 0],
    ]);

    const result = evaluate(map, STEP, { shapeProvider: probeProvider });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reasons.some((reason) => reason.kind === 'unobserved')).toBe(true);
    expect(result.dependencies.some((dep) => dep.key.cz === 0)).toBe(true);
  });

  it('UNKNOWN: committed-but-non-resident Sections are distinct from never-observed cells', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory([
      {
        key: { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 },
        seq: 0,
        bytes: 100,
        observedCells: 2,
        paletteEntries: 2,
        revision: 5,
      },
    ]);
    // Start support lives in the resident sy = -1 Section; every required sy = 0
    // cell is committed but not loaded, so it is non-resident rather than
    // never-observed.
    fill(map, STONE, [[0, -1, 0]]);

    const result = evaluate(map, STEP);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason?.kind).toBe('nonresident');
    expect(result.dependencies.some((dep) => dep.residency === 'not_resident')).toBe(true);
  });

  it('INCOMPLETE: candidate, neighbor-read, shape-box, support-face and climb-region caps are actionable limits', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);

    const candidate = evaluate(map, STEP, { shapeProvider: landProvider }, { limits: { maxCandidateCells: 1 } });
    expect(candidate.status).toBe('INCOMPLETE');
    expect(candidate.reason?.kind).toBe('capacity');
    expect(candidate.limitGap).toMatchObject({ field: 'maxCandidateCells', value: 1 });
    expect(candidate.limitGap!.requiredAtLeast).toBeGreaterThan(1);
    expect(candidate.work.exhausted).toBe(false);

    const readLimited = evaluate(
      map,
      STEP,
      {
        shapeProvider: {
          version: 'land-test-read-limit-1',
          resolve(state, cell, read) {
            read.cell(cell.x + 2, cell.y, cell.z);
            read.cell(cell.x + 3, cell.y, cell.z);
            return landProvider.resolve(state, cell, read);
          },
        },
      },
      { limits: { maxNeighborReads: 1 } },
    );
    expect(readLimited.status).toBe('INCOMPLETE');
    expect(readLimited.reason?.kind).toBe('capacity');
    expect(readLimited.limitGap).toMatchObject({ field: 'maxNeighborReads', value: 1, requiredAtLeast: 2 });

    const twoBoxes: CollisionShape = {
      boxes: [
        { minX: 0, minY: 0, minZ: 0, maxX: 0.5, maxY: 1, maxZ: 1 },
        { minX: 0.5, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      ],
      supportFaces: [],
    };
    const boxLimited = evaluate(
      map,
      STEP,
      {
        shapeProvider: {
          version: 'land-test-box-limit-1',
          resolve(state, cell, read) {
            if (state.name === AIR.name) return { kind: 'shape', shape: twoBoxes };
            return landProvider.resolve(state, cell, read);
          },
        },
      },
      { limits: { maxShapeBoxes: 1 } },
    );
    expect(boxLimited.status).toBe('INCOMPLETE');
    expect(boxLimited.reason?.kind).toBe('capacity');
    expect(boxLimited.limitGap).toMatchObject({ field: 'maxShapeBoxes', value: 1, requiredAtLeast: 2 });

    const twoFaces: CollisionShape = {
      boxes: [],
      supportFaces: [
        { top: 0.5, minX: 0, minZ: 0, maxX: 0.5, maxZ: 1 },
        { top: 0.5, minX: 0.5, minZ: 0, maxX: 1, maxZ: 1 },
      ],
    };
    const faceLimited = evaluate(
      map,
      STEP,
      {
        shapeProvider: {
          version: 'land-test-face-limit-1',
          resolve(state, cell, read) {
            if (state.name === AIR.name) return { kind: 'shape', shape: twoFaces };
            return landProvider.resolve(state, cell, read);
          },
        },
      },
      { limits: { maxSupportFaces: 1 } },
    );
    expect(faceLimited.status).toBe('INCOMPLETE');
    expect(faceLimited.reason?.kind).toBe('capacity');
    expect(faceLimited.limitGap).toMatchObject({ field: 'maxSupportFaces', value: 1, requiredAtLeast: 2 });

    const climbMap = new VoxelMap('world');
    fillLadder(climbMap, 0, 3);
    const regionLimited = evaluate(
      climbMap,
      LADDER_UP,
      {
        shapeProvider: landProvider,
        climbProvider: {
          version: 'test-climb-two-regions-1',
          resolve() {
            return {
              kind: 'regions',
              regions: [
                { minFeetY: 0, maxFeetY: 2 },
                { minFeetY: 2, maxFeetY: 3 },
              ],
            };
          },
        },
      },
      { limits: { maxClimbRegions: 1 } },
    );
    expect(regionLimited.status).toBe('INCOMPLETE');
    expect(regionLimited.reason?.kind).toBe('capacity');
    expect(regionLimited.limitGap).toMatchObject({ field: 'maxClimbRegions', value: 1, requiredAtLeast: 2 });
  });

  it('UNSUPPORTED: unrepresentable numeric coordinates are distinct from configurable capacity', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);

    const result = evaluate(
      map,
      STEP,
      { shapeProvider: landProvider },
      { body: bodyAt(STEP.from, 2 ** 54) },
    );
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.reason?.kind).toBe('unsupported_range');
    expect(result.reason?.detail).toMatch(/safely representable/);
    expect(result.limitGap).toBeUndefined();
  });

  it('INCOMPLETE: a huge candidate cap still charges enumeration before allocation', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);

    const result = evaluate(
      map,
      STEP,
      { shapeProvider: landProvider },
      {
        body: bodyAt(STEP.from, 1024),
        limits: { maxCandidateCells: 2 ** 40, maxWork: 1024 },
      },
    );
    expect(result.status).toBe('INCOMPLETE');
    expect(result.work.exhausted).toBe(true);
    expect(result.work.requiredAtLeast).toBeGreaterThan(1024);
    expect(result.limitGap).toBeUndefined();
  });

  it('direct helpers report numeric and capacity bounds and invoke the count before allocation', () => {
    const huge = 2 ** 54;
    const numericAabb = cellsInAabbBounded(
      { minX: huge, maxX: huge, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
      100,
    );
    expect(numericAabb.kind).toBe('numeric');
    expect(supportCandidateCells({ x: huge, y: 0, z: 0 }, 0.3, 100).kind).toBe('numeric');

    const capacity = cellsInAabbBounded({ minX: 0, maxX: 2, minY: 0, maxY: 2, minZ: 0, maxZ: 2 }, 4);
    expect(capacity).toEqual({ kind: 'capacity', total: 8 });

    let counted = -1;
    expect(() =>
      cellsInAabbBounded({ minX: 0, maxX: 2, minY: 0, maxY: 2, minZ: 0, maxZ: 2 }, 100, (total) => {
        counted = total;
        throw new Error('stop before allocation');
      }),
    ).toThrow(/stop before allocation/);
    expect(counted).toBe(8);
  });

  it('INCOMPLETE: work budget exhaustion is explicit and never OPEN', () => {
    const map = new VoxelMap('world');
    fillOpenStep(map);

    const result = evaluate(map, STEP, { shapeProvider: landProvider }, { limits: { maxWork: 2 } });
    expect(result.status).toBe('INCOMPLETE');
    expect(result.reason?.kind).toBe('budget');
    expect(result.work.exhausted).toBe(true);
    expect(result.work.requiredAtLeast).toBeGreaterThan(result.work.used);
  });

  it('rejects non-finite or non-positive boundary inputs and mismatched body feet', () => {
    const map = new VoxelMap('world');
    expect(() => resolveLandLimits({ maxWork: 0 })).toThrow(/positive safe integer/);
    expect(() =>
      evaluateLandTransition(
        map,
        query({ ...STEP, from: { x: Number.NaN, y: 0, z: 0.5 } }),
        { shapeProvider: landProvider },
        2000,
        resolveLandLimits(),
      ),
    ).toThrow(/finite/);

    const mismatched = query(STEP, { body: bodyAt({ x: 0.6, y: 0, z: 0.5 }) });
    expect(() =>
      evaluateLandTransition(map, mismatched, { shapeProvider: landProvider }, 2000, resolveLandLimits()),
    ).toThrow(/must exactly equal/);
  });
});

describe('land transition hot reads', () => {
  it('uses live sectionRef instead of deep-copying every Section', () => {
    const map = new VoxelMap('world', { now: () => 2000 });
    fillOpenStep(map);
    const sectionAt = vi.spyOn(map, 'sectionAt');
    const sectionRef = vi.spyOn(map, 'sectionRef');

    const evaluation = evaluate(map, STEP);

    expect(evaluation.status).toBe('OPEN');
    expect(sectionAt).not.toHaveBeenCalled();
    expect(sectionRef).toHaveBeenCalled();
    // The returned evidence must not be the store's live cell record.
    const stored = map.cellAt('overworld', 1, 0, 0);
    expect(stored.observed).toBe(true);
    if (stored.observed) {
      const before = stored.evidence.observation.state.name;
      stored.evidence.observation.state.name = 'mutated';
      const again = map.cellAt('overworld', 1, 0, 0);
      expect(again.observed).toBe(true);
      if (again.observed) expect(again.evidence.observation.state.name).toBe(before);
    }
  });
});
