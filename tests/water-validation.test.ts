import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/observation/types.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { checkWaterArrival, evaluateWaterRoute } from '../src/water/index.js';
import type {
  BoatDockGoal,
  DryShoreGoal,
  FluidShape,
  FluidShapeProvider,
  FluidSurfacePatch,
  FluidVolume,
  MountedBoatProfile,
  SurfaceSwimProfile,
  WaterArrivalRequest,
  WaterBodySample,
  WaterRouteQuery,
} from '../src/water/index.js';
import type {
  CollisionShape,
  CollisionShapeProvider,
} from '../src/traversability/collision-shape.js';

// --- test rules: deliberately small fake rules, NOT Minecraft 1.20.1 fluid rules ---

const AIR: BlockState = { name: 'minecraft:air', properties: {} };
const WATER: BlockState = { name: 'minecraft:water', properties: { level: '0' } };
const LAVA: BlockState = { name: 'minecraft:lava', properties: { level: '0' } };
const STONE: BlockState = { name: 'minecraft:stone', properties: {} };

const EMPTY_SHAPE: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const BOTTOM_SLAB: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }],
  supportFaces: [{ top: 0.5, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const THIN_WET_COLUMN: CollisionShape = {
  boxes: [{ minX: 0.3, minY: 0, minZ: 0.2, maxX: 0.5, maxY: 1, maxZ: 0.6 }],
  supportFaces: [],
};
/** A box whose Z span only touches the swimmer footprint boundary (z=0.8). */
const CORNER_TOUCH: CollisionShape = {
  boxes: [{ minX: 0.5, minY: 0, minZ: 0.8, maxX: 0.6, maxY: 1, maxZ: 1 }],
  supportFaces: [],
};

const solidProvider: CollisionShapeProvider = {
  version: 'test-solid-1',
  resolve(state) {
    switch (state.name) {
      case 'minecraft:air':
      case 'minecraft:water':
      case 'minecraft:lava':
        return { kind: 'shape', shape: EMPTY_SHAPE };
      case 'minecraft:stone':
      case 'test:waterlogged_full':
        return { kind: 'shape', shape: FULL_CUBE };
      case 'test:waterlogged_slab':
        return { kind: 'shape', shape: BOTTOM_SLAB };
      case 'test:thin_wet':
        return { kind: 'shape', shape: THIN_WET_COLUMN };
      case 'test:corner_thin_wet':
        return { kind: 'shape', shape: CORNER_TOUCH };
      default:
        return { kind: 'unsupported_shape', block: state.name, detail: `no solid rule for ${state.name}` };
    }
  },
};

function waterVolume(surfaceY: number, patch?: Partial<FluidSurfacePatch>): FluidVolume {
  return {
    kind: 'water',
    box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: surfaceY, maxZ: 1 },
    motion: 'still',
    surface: { y: surfaceY, minX: 0, minZ: 0, maxX: 1, maxZ: 1, ...patch },
  };
}

function fluidProvider(options: {
  surfaceY?: number;
  patch?: Partial<FluidSurfacePatch>;
  risks?: FluidShape['risks'];
} = {}): FluidShapeProvider {
  const surfaceY = options.surfaceY ?? 0.875;
  return {
    version: 'test-fluid-1',
    resolve(state) {
      switch (state.name) {
        case 'minecraft:water':
        case 'test:thin_wet':
        case 'test:corner_thin_wet':
        case 'test:waterlogged_full':
        case 'test:waterlogged_slab':
          return {
            kind: 'shape',
            shape: {
              water: waterVolume(surfaceY, options.patch),
              lava: null,
              risks: options.risks ?? [],
            },
          };
        case 'minecraft:lava':
          return {
            kind: 'shape',
            shape: {
              water: null,
              lava: {
                kind: 'lava',
                box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.875, maxZ: 1 },
                motion: 'flowing',
                surface: 'none',
              },
              risks: [{ kind: 'current', basis: 'observed', detail: 'flowing lava' }],
            },
          };
        default:
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
      }
    },
  };
}

const waterProvider = fluidProvider();
const boatWaterProvider = fluidProvider({ surfaceY: 0.375 });

const swimProfile: SurfaceSwimProfile = {
  kind: 'surface_swim',
  orientation: { quarterTurns: 0 },
  body: { width: 0.6, height: 1.8 },
  breathing: { minY: 1.8, width: 0.5, height: 0.3 },
  surfaceBand: { minY: 0.875, maxY: 0.875 },
};

const boatProfile: MountedBoatProfile = {
  kind: 'mounted_boat',
  orientation: { quarterTurns: 0 },
  hull: { width: 1.0, length: 2.0, height: 0.6 },
  passengerClearance: [{ minX: -0.35, minY: 0.6, minZ: -0.7, maxX: 0.35, maxY: 1.8, maxZ: 0.7 }],
  surfaceBand: { minY: 0.375, maxY: 0.375 },
};

// --- helpers ---

function observation(
  state: BlockState,
  pos: Vec3Like,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state,
    pos: { ...pos },
    ...overrides,
  };
}

function fill(
  map: VoxelMap,
  min: Vec3Like,
  max: Vec3Like,
  state: BlockState,
  overrides: Partial<Observation> = {},
): void {
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        map.observe(observation(state, { x, y, z }, overrides));
      }
    }
  }
}

function fillSwimWater(map: VoxelMap, minX: number, maxX: number, overrides: Partial<Observation> = {}): void {
  fill(map, { x: minX, y: 0, z: 0 }, { x: maxX, y: 0, z: 0 }, WATER, overrides);
  fill(map, { x: minX, y: 1, z: 0 }, { x: maxX, y: 2, z: 0 }, AIR, overrides);
}

function fillBoatWater(map: VoxelMap, minX: number, maxX: number, overrides: Partial<Observation> = {}): void {
  fill(map, { x: minX, y: 0, z: -1 }, { x: maxX, y: 0, z: 1 }, WATER, overrides);
  fill(map, { x: minX, y: 1, z: -1 }, { x: maxX, y: 1, z: 1 }, AIR, overrides);
}

function swimQuery(points: Vec3Like[], overrides: Partial<WaterRouteQuery> = {}): WaterRouteQuery {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    points,
    profile: swimProfile,
    solidShapeProvider: solidProvider,
    fluidShapeProvider: waterProvider,
    ...overrides,
  };
}

function boatQuery(points: Vec3Like[], overrides: Partial<WaterRouteQuery> = {}): WaterRouteQuery {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    points,
    profile: boatProfile,
    solidShapeProvider: solidProvider,
    fluidShapeProvider: boatWaterProvider,
    ...overrides,
  };
}

const swimRoute: Vec3Like[] = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

const boatRoute: Vec3Like[] = [
  { x: 2.5, y: 0, z: 0.5 },
  { x: 4.5, y: 0, z: 0.5 },
];

function scope() {
  return { worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: 'exec-1' };
}

function sample(overrides: Partial<WaterBodySample> = {}): WaterBodySample {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    pos: { x: 4.5, y: 0, z: 0.5 },
    observedAt: 1000,
    sequence: 1,
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    connected: true,
    observationReady: true,
    onGround: false,
    inWater: true,
    executionId: 'exec-1',
    boatId: 'boat-7',
    ...overrides,
  };
}

function arrivalRequest(
  goal: WaterArrivalRequest['goal'],
  samples: WaterBodySample[],
  overrides: Partial<WaterArrivalRequest> = {},
): WaterArrivalRequest {
  return {
    goal,
    scope: scope(),
    map: new VoxelMap('world'),
    samples,
    now: 2000,
    maxSampleAgeMs: 5000,
    ...overrides,
  };
}

function swimTargetGoal(overrides: Partial<{ x: number; y: number; z: number }> = {}) {
  return {
    kind: 'surface_target' as const,
    target: { x: 0.5, y: 0.5, z: 0.5, ...overrides },
    horizontalTolerance: 0.1,
    verticalTolerance: 0.1,
  };
}

function dockGoal(overrides: Partial<BoatDockGoal> = {}): BoatDockGoal {
  return {
    kind: 'boat_dock',
    target: { x: 4.5, y: 0, z: 0.5 },
    horizontalTolerance: 0.2,
    verticalTolerance: 0.1,
    boatId: 'boat-7',
    stableWindowMs: 300,
    maxHorizontalSpeed: 0.01,
    maxVerticalSpeed: 0.1,
    minStableSamples: 2,
    ...overrides,
  };
}

function countingSolid(): { provider: CollisionShapeProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      version: 'counting-solid',
      resolve(state, cell, read) {
        calls += 1;
        return solidProvider.resolve(state, cell, read);
      },
    },
    calls: () => calls,
  };
}

// --- route validation ---

describe('water route validation', () => {
  it('accepts clear surface water under a surface-swim profile', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('OPEN');
    expect(result.to).toEqual({ x: 2.5, y: 0, z: 0.5 });
    expect(result.points).toEqual(swimRoute);
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
    expect(result.budget.candidateCells).toBeGreaterThan(0);
    expect(result.validUntil).toBe(61000);
  });

  it('does not pass a dry-air route with no water surface', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 0 }, AIR);

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_surface');
  });

  it('accepts a hull + passenger-clearance boat route', () => {
    const map = new VoxelMap('world');
    fillBoatWater(map, 2, 4);

    const result = evaluateWaterRoute(map, boatQuery(boatRoute), 1000);

    expect(result.status).toBe('OPEN');
    expect(result.profileKind).toBe('mounted_boat');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
  });

  it('blocks a thin obstruction in the swept body volume', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    map.observe(observation({ name: 'test:thin_wet', properties: {} }, { x: 1, y: 0, z: 0 }, { observedAt: 2000 }));

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 3000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('collision');
    expect(result.obstacles.length).toBeGreaterThan(0);
    // Water contact remains a hazard fact, independent of the physical verdict.
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
  });

  it('does not treat an exact swept-envelope corner touch as a collision', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    // The box begins exactly at the footprint boundary z=0.8: no positive-time overlap.
    map.observe(observation({ name: 'test:corner_thin_wet', properties: {} }, { x: 2, y: 0, z: 0 }, { observedAt: 2000 }));

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 3000);

    expect(result.status).toBe('OPEN');
  });

  it('blocks a waterlogged solid obstruction while keeping the fluid fact', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    map.observe(observation({ name: 'test:waterlogged_full', properties: { waterlogged: 'true' } }, { x: 1, y: 0, z: 0 }, { observedAt: 2000 }));

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 3000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('collision');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
  });

  it('keeps a waterlogged slab below the body as fluid + non-obstructing solid', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, AIR);
    fill(map, { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, WATER);
    map.observe(observation({ name: 'test:waterlogged_slab', properties: { waterlogged: 'true' } }, { x: 1, y: 0, z: 0 }, { observedAt: 2000 }));

    const feetY = 0.5;
    const result = evaluateWaterRoute(
      map,
      swimQuery(
        [{ x: 0.5, y: feetY, z: 0.5 }, { x: 2.5, y: feetY, z: 0.5 }],
        {
          profile: {
            ...swimProfile,
            surfaceBand: { minY: 0.875, maxY: 0.875 },
          },
        },
      ),
      3000,
    );

    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
  });

  it('blocks a boat route when passenger headroom intersects a solid', () => {
    const map = new VoxelMap('world');
    fillBoatWater(map, 2, 4);
    map.observe(observation(STONE, { x: 3, y: 1, z: 0 }, { observedAt: 2000 }));

    const result = evaluateWaterRoute(map, boatQuery(boatRoute), 3000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('head_clearance');
  });

  it('detects a narrow dry gap between partial water surfaces', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    // Cell x=1 exposes surface only over local x∈[0,0.2], leaving a 0.8-wide dry gap
    // that is wider than the 0.6-wide swimmer footprint.
    const patchProvider = fluidProvider();
    const query = swimQuery(swimRoute, {
      fluidShapeProvider: {
        version: 'patch-fluid',
        resolve(state, cell, read) {
          if (cell.x === 1 && state.name === 'minecraft:water') {
            return {
              kind: 'shape',
              shape: { water: waterVolume(0.875, { maxX: 0.2 }), lava: null, risks: [] },
            };
          }
          return patchProvider.resolve(state, cell, read);
        },
      },
    });

    const result = evaluateWaterRoute(map, query, 1000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_surface');
  });

  it('does not let a corner-envelope obstacle block an L-shaped route', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }, WATER);
    fill(map, { x: 0, y: 1, z: 0 }, { x: 3, y: 2, z: 3 }, AIR);
    map.observe(observation(STONE, { x: 1, y: 0, z: 2 }));

    const result = evaluateWaterRoute(
      map,
      swimQuery([
        { x: 0.5, y: 0, z: 0.5 },
        { x: 3.5, y: 0, z: 0.5 },
        { x: 3.5, y: 0, z: 3.5 },
      ]),
      1000,
    );

    expect(result.status).toBe('OPEN');
  });

  it('handles negative and cross-section coordinates', () => {
    const map = new VoxelMap('world');
    fill(map, { x: -18, y: 0, z: 0 }, { x: -14, y: 0, z: 0 }, WATER);
    fill(map, { x: -18, y: 1, z: 0 }, { x: -14, y: 2, z: 0 }, AIR);

    const result = evaluateWaterRoute(
      map,
      swimQuery([
        { x: -17.5, y: 0, z: 0.5 },
        { x: -14.5, y: 0, z: 0.5 },
      ]),
      1000,
    );

    expect(result.status).toBe('OPEN');
    const sectionCx = new Set(result.dependencies.map((dep) => dep.key.cx));
    expect(sectionCx.has(-2)).toBe(true);
    expect(sectionCx.has(-1)).toBe(true);
  });

  it('reports a varying-height route as explicitly unsupported', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const result = evaluateWaterRoute(
      map,
      swimQuery([
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0.5, z: 0.5 },
        { x: 2.5, y: 0, z: 0.5 },
      ]),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('unsupported_profile');
  });

  it('reports lava contact as a hazard without turning the missing water surface into OPEN', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, LAVA);
    fill(map, { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, AIR);

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_surface');
    expect(result.hazards.some((hazard) => hazard.kind === 'lava_contact')).toBe(true);
  });

  it('carries provider current/bubble risk facts independently of OPEN', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const risky = fluidProvider({
      risks: [
        { kind: 'current', basis: 'observed', detail: 'flowing water' },
        { kind: 'bubble_column', basis: 'derived', detail: 'bubble column nearby' },
      ],
    });

    const result = evaluateWaterRoute(map, swimQuery(swimRoute, { fluidShapeProvider: risky }), 1000);

    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'current')).toBe(true);
    expect(result.hazards.some((hazard) => hazard.kind === 'bubble_column')).toBe(true);
  });
});

// --- evidence, dependencies and budgets ---

describe('water evidence and budgets', () => {
  it('returns UNKNOWN for a missing required water cell and records its section', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    // Remove one water cell by never observing it: rebuild without x=1.
    const partial = new VoxelMap('world');
    for (let x = 0; x <= 2; x++) {
      if (x === 1) continue;
      fill(partial, { x, y: 0, z: 0 }, { x, y: 0, z: 0 }, WATER);
    }
    fill(partial, { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, AIR);

    const result = evaluateWaterRoute(partial, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('unobserved');
    expect(result.dependencies.some((dep) => dep.key.cx === 0 && dep.key.cz === 0 && dep.key.sy === 0)).toBe(true);
    // The fully observed map is still independent of the partial one.
    expect(evaluateWaterRoute(map, swimQuery(swimRoute), 1000).status).toBe('OPEN');
  });

  it('expires evidence, refreshes the same state, and re-evaluates fresh', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const fresh = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    expect(fresh.status).toBe('OPEN');
    const revision = fresh.dependencies[0]!.revision;

    const expired = evaluateWaterRoute(map, swimQuery(swimRoute), 70000);
    expect(expired.status).toBe('STALE');

    fillSwimWater(map, 0, 2, { observedAt: 69000 });
    const refreshed = evaluateWaterRoute(map, swimQuery(swimRoute), 70000);
    expect(refreshed.status).toBe('OPEN');
    expect(refreshed.validUntil).toBe(129000);
    expect(refreshed.dependencies[0]!.revision).toBe(revision);
  });

  it('invalidates a route after a same-section content change', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const before = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    const beforeRevision = before.dependencies[0]!.revision;

    map.observe(observation(AIR, { x: 1, y: 0, z: 0 }, { observedAt: 2000 }));
    const after = evaluateWaterRoute(map, swimQuery(swimRoute), 3000);

    expect(after.status).toBe('BLOCKED');
    expect(after.problem?.kind).toBe('missing_surface');
    expect(after.dependencies[0]!.revision).toBeGreaterThan(beforeRevision);
  });

  it('rejects wrong-session evidence', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2, { sessionId: 's2' });

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('STALE');
    expect(result.problem?.kind).toBe('stale');
  });

  it('rejects state-incomplete evidence', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    map.observe(observation(WATER, { x: 1, y: 0, z: 0 }, { observedAt: 2000, stateComplete: false }));

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 3000);

    expect(result.status).toBe('UNKNOWN');
  });

  it('reports a provider neighbour gap truthfully', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const gapProvider: FluidShapeProvider = {
      version: 'gap-fluid',
      resolve(state, cell, read) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        const view = read.cell(50, 0, 50);
        if (view.kind !== 'observed') return { kind: 'neighbor_gap', view };
        return { kind: 'shape', shape: { water: waterVolume(0.875), lava: null, risks: [] } };
      },
    };

    const result = evaluateWaterRoute(map, swimQuery(swimRoute, { fluidShapeProvider: gapProvider }), 1000);

    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('neighbor_gap');
    expect(result.budget.neighborReads).toBeGreaterThan(0);
  });

  it('does not add unrelated far sections as dependencies', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    fill(map, { x: 100, y: 0, z: 100 }, { x: 100, y: 0, z: 100 }, WATER);

    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);

    expect(result.status).toBe('OPEN');
    expect(result.dependencies.some((dep) => dep.key.cx === 6 && dep.key.cz === 6)).toBe(false);
  });

  it('rejects an over-budget route before any provider work', () => {
    const map = new VoxelMap('world');
    const counting = countingSolid();
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];

    const result = evaluateWaterRoute(
      map,
      swimQuery(points, { solidShapeProvider: counting.provider, limits: { maxPoints: 2 } }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxPoints' });
    expect(result.budget.candidateCells).toBe(0);
    expect(counting.calls()).toBe(0);
  });

  it('rejects an over-budget swept envelope before enumeration', () => {
    const map = new VoxelMap('world');
    const counting = countingSolid();

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { solidShapeProvider: counting.provider, limits: { maxCandidateCells: 1 } }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxCandidateCells' });
    expect(result.budget.candidateCells).toBe(0);
    expect(counting.calls()).toBe(0);
  });

  it('bounds duplicate provider neighbour reads without bypass', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    let reads = 0;
    const noisy: FluidShapeProvider = {
      version: 'noisy-fluid',
      resolve(state, cell, read) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        for (let i = 0; i < 4; i++) {
          read.cell(cell.x, cell.y, cell.z);
          reads += 1;
        }
        return { kind: 'shape', shape: { water: waterVolume(0.875), lava: null, risks: [] } };
      },
    };

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { fluidShapeProvider: noisy, limits: { maxNeighborReads: 2 } }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxNeighborReads' });
    // The provider still issued its fourth call after the third crossed the budget;
    // the count reports the work actually attempted, not a clamped value.
    expect(result.budget.neighborReads).toBe(4);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('bounds cell reads and geometry work', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const readBound = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { limits: { maxReadCells: 1 } }),
      1000,
    );
    expect(readBound.status).toBe('UNSUPPORTED');
    expect(readBound.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxReadCells' });

    const shapeBound = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { limits: { maxShapeChecks: 1 } }),
      1000,
    );
    expect(shapeBound.status).toBe('UNSUPPORTED');
    expect(shapeBound.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxShapeChecks' });
  });

  it('leaves the map unchanged and does not begin a session', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const before = JSON.stringify(map.checkpointSnapshot());
    const saveRevision = map.saveRevision;

    evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    checkWaterArrival(arrivalRequest(swimTargetGoal(), [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 } })]));

    expect(map.saveRevision).toBe(saveRevision);
    expect(JSON.stringify(map.checkpointSnapshot())).toBe(before);
  });
});

// --- completion verification ---

describe('water arrival completion', () => {
  it('accepts an in-water surface target without requiring dry land', () => {
    const result = checkWaterArrival(
      arrivalRequest(swimTargetGoal(), [
        sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: true, onGround: false }),
      ]),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.goal.target).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    expect(result.lastObservedAt).toBe(1000);
  });

  it('does not accept a dry body at a surface target', () => {
    const result = checkWaterArrival(
      arrivalRequest(swimTargetGoal(), [
        sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: false, onGround: true }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('not_in_water');
  });

  it('preserves target height and tolerances', () => {
    const result = checkWaterArrival(
      arrivalRequest(swimTargetGoal(), [
        sample({ pos: { x: 0.5, y: 0.7, z: 0.5 } }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('outside_target');
    expect(result.goal.target).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });

  it('requires measured dry/grounded evidence and geometry-confirmed shore support', () => {
    const map = new VoxelMap('world');
    map.observe(observation(STONE, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: solidProvider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map }),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.shoreSupport?.status).toBe('OPEN');
    expect(result.goal).toEqual(goal);
  });

  it('does not accept the original shore when a different shore is the target', () => {
    const map = new VoxelMap('world');
    map.observe(observation(STONE, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: solidProvider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 0.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('outside_target');
  });

  it('does not invent shore support when the support geometry is missing', () => {
    const map = new VoxelMap('world');
    map.observe(observation(AIR, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: solidProvider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('shore_support');
    expect(result.shoreSupport?.status).not.toBe('OPEN');
  });

  it('does not accept a wet body as a dry shore', () => {
    const map = new VoxelMap('world');
    map.observe(observation(STONE, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: solidProvider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: true, onGround: true }),
      ], { map }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('not_dry_grounded');
  });

  it('accepts a docked boat after an ordered stable low-speed window', () => {
    const goal = dockGoal();
    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1200, sequence: 2 }),
        sample({ observedAt: 1400, sequence: 3 }),
      ]),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.stableSince).toBe(1000);
    expect(result.stableSamples).toBe(3);
    expect(result.lastObservedAt).toBe(1400);
    expect(result.goal).toEqual(goal);
  });

  it('rejects a moving boat', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1200, sequence: 2, velocity: { x: 0.5, y: 0, z: 0 } }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('moving');
  });

  it('rejects a forced unmount and never infers identity from a riding label', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1200, sequence: 2, boatId: undefined, ridingLabel: 'Boat' }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('not_mounted');
  });

  it('rejects a different boat identity', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1200, sequence: 2, boatId: 'boat-8' }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('boat_identity_mismatch');
  });

  it('rejects a stable window that has not elapsed', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1100, sequence: 2 }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('insufficient_stable_window');
  });

  it('rejects replayed and out-of-order samples', () => {
    const replayed = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 2 }),
        sample({ observedAt: 1200, sequence: 1 }),
      ]),
    );
    expect(replayed.status).toBe('UNCONFIRMED');
    expect(replayed.problem?.kind).toBe('sample_order');

    const outOfOrder = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({ observedAt: 1400, sequence: 2 }),
        sample({ observedAt: 1300, sequence: 3 }),
      ]),
    );
    expect(outOfOrder.status).toBe('UNCONFIRMED');
    expect(outOfOrder.problem?.kind).toBe('sample_order');
  });

  it('rejects stale, wrong-scope, wrong-execution and corrected samples', () => {
    const stale = checkWaterArrival(
      arrivalRequest(dockGoal(), [sample({ observedAt: 1000 })], { now: 10000, maxSampleAgeMs: 1000 }),
    );
    expect(stale.status).toBe('UNCONFIRMED');
    expect(stale.problem?.kind).toBe('stale');

    const wrongScope = checkWaterArrival(
      arrivalRequest(dockGoal(), [sample({ dim: 'the_nether' })]),
    );
    expect(wrongScope.status).toBe('UNCONFIRMED');
    expect(wrongScope.problem?.kind).toBe('wrong_scope');

    const wrongExecution = checkWaterArrival(
      arrivalRequest(dockGoal(), [sample({ executionId: 'exec-2' })]),
    );
    expect(wrongExecution.status).toBe('UNCONFIRMED');
    expect(wrongExecution.problem?.kind).toBe('wrong_execution');

    const corrected = checkWaterArrival(
      arrivalRequest(dockGoal(), [sample({ positionCorrected: true })]),
    );
    expect(corrected.status).toBe('UNCONFIRMED');
    expect(corrected.problem?.kind).toBe('body_correction');
  });

  it('reports absence of samples as unconfirmed rather than ARRIVED', () => {
    const result = checkWaterArrival(arrivalRequest(swimTargetGoal(), []));

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('no_evidence');
  });

  it('rejects a dock sample outside the vertical target tolerance', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ pos: { x: 4.5, y: 0.5, z: 0.5 }, observedAt: 1000, sequence: 1 }),
        sample({ pos: { x: 4.5, y: 0.5, z: 0.5 }, observedAt: 1200, sequence: 2 }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('outside_target');
  });

  it('bounds the sample set before processing', () => {
    const samples = Array.from({ length: 3 }, (_, index) =>
      sample({ observedAt: 1000 + index * 100, sequence: index + 1 }),
    );
    const result = checkWaterArrival(arrivalRequest(dockGoal(), samples, { maxSamples: 2 }));

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxSamples' });
  });
});

// --- packaging / import boundaries ---

describe('water module packaging', () => {
  it('declares the public ./water export', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports['./water']).toEqual({
      types: './dist/water/index.d.ts',
      import: './dist/water/index.js',
    });
  });

  it('does not import host, storage or controller modules', () => {
    const sources = ['types.ts', 'verify.ts', 'index.ts']
      .map((file) => readFileSync(new URL(`../src/water/${file}`, import.meta.url), 'utf8'))
      .join('\n');
    const specifiers = [...sources.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).not.toContain('better-sqlite3');
    expect(specifiers.some((specifier) => /sqlite|mineflayer|worker|storage|adapter|store\//.test(specifier))).toBe(false);
  });

  it('exposes callable functions from the built public entry', async () => {
    const entry = (await import('../dist/water/index.js')) as {
      evaluateWaterRoute?: unknown;
      checkWaterArrival?: unknown;
    };
    expect(typeof entry.evaluateWaterRoute).toBe('function');
    expect(typeof entry.checkWaterArrival).toBe('function');
  });
});
