import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/observation/types.js';
import type { BlockState, Vec3Like } from '../src/types.js';
import { VoxelMap } from '../src/voxel/voxel-map.js';
import { checkWaterArrival, evaluateWaterRoute } from '../src/water/index.js';
import type {
  BoatDockGoal,
  BoatMeasurement,
  Box3,
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

function waterVolume(
  surfaceY: number,
  patch?: Partial<FluidSurfacePatch>,
  motion: FluidVolume['motion'] = 'still',
): FluidVolume {
  return {
    kind: 'water',
    box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: surfaceY, maxZ: 1 },
    motion,
    surface: { y: surfaceY, minX: 0, minZ: 0, maxX: 1, maxZ: 1, ...patch },
  };
}

function fluidProvider(options: {
  surfaceY?: number;
  patch?: Partial<FluidSurfacePatch>;
  risks?: FluidShape['risks'];
  motion?: FluidVolume['motion'];
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
              water: waterVolume(surfaceY, options.patch, options.motion ?? 'still'),
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
  passengerBreathing: [{ minX: -0.3, minY: 1.1, minZ: -0.3, maxX: 0.3, maxY: 1.4, maxZ: 0.3 }],
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
  const base: WaterBodySample = {
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
  // A normal host receipt carries boat telemetry bound to the same sample. Tests
  // that need missing/mismatched telemetry override `boatMeasurement` explicitly.
  if (!('boatMeasurement' in overrides) && base.boatId !== undefined) {
    base.boatMeasurement = {
      boatId: base.boatId,
      pos: { ...base.pos },
      velocity: { ...(base.velocity ?? { x: 0, y: 0, z: 0 }) },
      observedAt: base.observedAt,
      sequence: base.sequence,
      executionId: base.executionId,
      worldId: base.worldId,
      dim: base.dim,
      sessionId: base.sessionId,
    };
  }
  return base;
}

function boatMeasurement(overrides: Partial<BoatMeasurement> = {}): BoatMeasurement {
  return {
    boatId: 'boat-7',
    pos: { x: 4.5, y: 0, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    observedAt: 1000,
    sequence: 1,
    executionId: 'exec-1',
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
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

function surfaceTargetMap(): VoxelMap {
  const map = new VoxelMap('world');
  map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
  map.observe(observation(AIR, { x: 0, y: 1, z: 0 }));
  map.observe(observation(AIR, { x: 0, y: 2, z: 0 }));
  return map;
}

function swimTargetGoal(overrides: Partial<{ x: number; y: number; z: number }> = {}) {
  return {
    kind: 'surface_target' as const,
    target: { x: 0.5, y: 0.5, z: 0.5, ...overrides },
    horizontalTolerance: 0.1,
    verticalTolerance: 0.1,
    profile: swimProfile,
    solidShapeProvider: solidProvider,
    fluidShapeProvider: waterProvider,
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
    maxSampleGapMs: 500,
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
    expect(result.validUntil).toBe(Number.POSITIVE_INFINITY);
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

  it('does not leak one segment surface coverage into later segments', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    fill(map, { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, AIR);
    fill(map, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, AIR);

    const direct = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    expect(direct.status).toBe('BLOCKED');
    expect(direct.problem?.kind).toBe('missing_surface');

    const repeated = evaluateWaterRoute(
      map,
      swimQuery([swimRoute[0]!, { ...swimRoute[0]! }, swimRoute[1]!]),
      1000,
    );
    expect(repeated.status).toBe('BLOCKED');
    expect(repeated.problem?.kind).toBe('missing_surface');
  });

  it('accepts a repeated point when the surface actually covers both segment intervals', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const result = evaluateWaterRoute(
      map,
      swimQuery([swimRoute[0]!, { ...swimRoute[0]! }, swimRoute[1]!]),
      1000,
    );

    expect(result.status).toBe('OPEN');
  });

  it('uses the declared contact waterline inside a broad band', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, {
        profile: { ...swimProfile, surfaceBand: { minY: 0, maxY: 3 } },
      }),
      1000,
    );

    expect(result.status).toBe('OPEN');
  });

  it('does not accept a surface above the body/hull as contact even in a broad band', () => {
    const map = new VoxelMap('world');
    map.observe(observation(AIR, { x: 0, y: 0, z: 0 }));
    map.observe(observation(WATER, { x: 0, y: 1, z: 0 }));
    const highThinWater: FluidShapeProvider = {
      version: 'high-thin',
      resolve(state, cell) {
        if (state.name === 'minecraft:water' && cell.y === 1) {
          return {
            kind: 'shape',
            shape: {
              water: {
                kind: 'water',
                box: { minX: 0, minY: 0.4, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 },
                motion: 'still',
                surface: { y: 0.5, minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
              },
              lava: null,
              risks: [],
            },
          };
        }
        return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
      },
    };
    const profile: SurfaceSwimProfile = {
      ...swimProfile,
      body: { width: 0.6, height: 1.0 },
      breathing: { minY: 1.0, width: 0.5, height: 0.3 },
      surfaceBand: { minY: 0, maxY: 3 },
    };

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { profile, fluidShapeProvider: highThinWater }),
      1000,
    );

    expect(result.status).toBe('BLOCKED');
    expect(result.problem?.kind).toBe('missing_surface');
  });

  it('reports a submerged swimmer as an unsupported surface posture', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 0 }, WATER);
    const layeredWater: FluidShapeProvider = {
      version: 'layered-water',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: { water: waterVolume(cell.y === 1 ? 0.75 : 0.875), lava: null, risks: [] },
        };
      },
    };
    const profile: SurfaceSwimProfile = {
      ...swimProfile,
      body: { width: 0.6, height: 2.0 },
      breathing: { minY: 1.0, width: 0.5, height: 0.5 },
      surfaceBand: { minY: 0, maxY: 3 },
    };

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { profile, fluidShapeProvider: layeredWater }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('submerged_posture');
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(true);
  });

  it('reports a wet passenger breathing volume as an unsupported boat posture', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 2, y: 0, z: -1 }, { x: 4, y: 1, z: 1 }, WATER);
    const layeredWater: FluidShapeProvider = {
      version: 'layered-boat-water',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: { water: waterVolume(cell.y === 1 ? 0.4 : 0.375), lava: null, risks: [] },
        };
      },
    };
    const profile: MountedBoatProfile = {
      ...boatProfile,
      hull: { width: 1.0, length: 2.0, height: 2.0 },
      surfaceBand: { minY: 0, maxY: 3 },
    };

    const result = evaluateWaterRoute(
      map,
      boatQuery(boatRoute, { profile, fluidShapeProvider: layeredWater }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('submerged_posture');
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(true);
  });

  it('does not claim submersion from an upper patch outside the swept footprint', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    map.observe(observation(WATER, { x: 0, y: 1, z: 0 }));
    const narrowUpper: FluidShapeProvider = {
      version: 'narrow-upper-outside',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        if (cell.y === 0) {
          return { kind: 'shape', shape: { water: waterVolume(0.875), lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: {
            water: {
              kind: 'water',
              box: { minX: 0, minY: 0, minZ: 0, maxX: 0.1, maxY: 0.7, maxZ: 1 },
              motion: 'still',
              surface: { y: 0.7, minX: 0, minZ: 0, maxX: 0.1, maxZ: 1 },
            },
            lava: null,
            risks: [],
          },
        };
      },
    };
    const profile: SurfaceSwimProfile = {
      ...swimProfile,
      breathing: { minY: 1.6, width: 0.5, height: 0.2 },
      surfaceBand: { minY: 0.875, maxY: 1.7 },
    };
    const point = { x: 0.5, y: 0, z: 0.5 };

    const result = evaluateWaterRoute(
      map,
      swimQuery([point, { ...point }], { profile, fluidShapeProvider: narrowUpper }),
      1000,
    );

    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(false);
  });

  it('does not report hull submersion from torso-only water contact', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    map.observe(observation(WATER, { x: 0, y: 1, z: 0 }));
    const torsoWater: FluidShapeProvider = {
      version: 'torso-only',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        if (cell.y === 0) {
          return { kind: 'shape', shape: { water: waterVolume(0.375), lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: {
            water: {
              kind: 'water',
              box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.2, maxZ: 1 },
              motion: 'still',
              surface: { y: 0.2, minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
            },
            lava: null,
            risks: [],
          },
        };
      },
    };
    const profile: MountedBoatProfile = {
      kind: 'mounted_boat',
      orientation: { quarterTurns: 0 },
      hull: { width: 0.6, length: 0.6, height: 0.6 },
      passengerClearance: [{ minX: -0.25, minY: 0.6, minZ: -0.25, maxX: 0.25, maxY: 1.8, maxZ: 0.25 }],
      passengerBreathing: [{ minX: -0.2, minY: 1.6, minZ: -0.2, maxX: 0.2, maxY: 1.8, maxZ: 0.2 }],
      surfaceBand: { minY: 0.375, maxY: 0.375 },
    };
    const point = { x: 0.5, y: 0, z: 0.5 };

    const result = evaluateWaterRoute(
      map,
      boatQuery([point, { ...point }], { profile, fluidShapeProvider: torsoWater }),
      1000,
    );

    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(false);
  });

  it('does not claim breathing submersion from a high patch that misses the breathing footprint', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    map.observe(observation(WATER, { x: 0, y: 1, z: 0 }));
    const shoulderOnly: FluidShapeProvider = {
      version: 'shoulder-only',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        if (cell.y === 0) {
          return { kind: 'shape', shape: { water: waterVolume(0.875), lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: {
            water: {
              kind: 'water',
              box: { minX: 0.7, minY: 0, minZ: 0, maxX: 0.8, maxY: 0.7, maxZ: 1 },
              motion: 'still',
              surface: { y: 0.7, minX: 0.7, minZ: 0, maxX: 0.8, maxZ: 1 },
            },
            lava: null,
            risks: [],
          },
        };
      },
    };
    const profile: SurfaceSwimProfile = {
      ...swimProfile,
      breathing: { minY: 1.6, width: 0.2, height: 0.2 },
      surfaceBand: { minY: 0.875, maxY: 1.7 },
    };
    const point = { x: 0.5, y: 0, z: 0.5 };

    const result = evaluateWaterRoute(
      map,
      swimQuery([point, { ...point }], { profile, fluidShapeProvider: shoulderOnly }),
      1000,
    );

    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'water_contact')).toBe(true);
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(false);
  });

  it('still reports real hull inundation as unsupported surface posture', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 0, y: 1, z: 0 }));
    const inundated: FluidShapeProvider = {
      version: 'hull-inundated',
      resolve(state) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        return { kind: 'shape', shape: { water: waterVolume(1.0), lava: null, risks: [] } };
      },
    };
    const profile: MountedBoatProfile = {
      kind: 'mounted_boat',
      orientation: { quarterTurns: 0 },
      hull: { width: 0.6, length: 0.6, height: 0.6 },
      passengerClearance: [{ minX: -0.25, minY: 0.6, minZ: -0.25, maxX: 0.25, maxY: 1.8, maxZ: 0.25 }],
      passengerBreathing: [{ minX: -0.2, minY: 1.6, minZ: -0.2, maxX: 0.2, maxY: 1.8, maxZ: 0.2 }],
      surfaceBand: { minY: 0.375, maxY: 1.0 },
    };
    const point = { x: 0.5, y: 0, z: 0.5 };

    const result = evaluateWaterRoute(
      map,
      boatQuery([point, { ...point }], { profile, fluidShapeProvider: inundated }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('submerged_posture');
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(true);
  });

  it('still reports actual breathing-volume inundation', () => {
    const map = new VoxelMap('world');
    map.observe(observation(WATER, { x: 0, y: 0, z: 0 }));
    map.observe(observation(WATER, { x: 0, y: 1, z: 0 }));
    const breathingWet: FluidShapeProvider = {
      version: 'breathing-wet',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        if (cell.y === 0) {
          return { kind: 'shape', shape: { water: waterVolume(0.375), lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: {
            water: {
              kind: 'water',
              box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.7, maxZ: 1 },
              motion: 'still',
              surface: { y: 0.7, minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
            },
            lava: null,
            risks: [],
          },
        };
      },
    };
    const profile: MountedBoatProfile = {
      kind: 'mounted_boat',
      orientation: { quarterTurns: 0 },
      hull: { width: 0.6, length: 0.6, height: 0.6 },
      passengerClearance: [{ minX: -0.25, minY: 0.6, minZ: -0.25, maxX: 0.25, maxY: 1.8, maxZ: 0.25 }],
      passengerBreathing: [{ minX: -0.2, minY: 1.6, minZ: -0.2, maxX: 0.2, maxY: 1.8, maxZ: 0.2 }],
      surfaceBand: { minY: 0.375, maxY: 1.7 },
    };
    const point = { x: 0.5, y: 0, z: 0.5 };

    const result = evaluateWaterRoute(
      map,
      boatQuery([point, { ...point }], { profile, fluidShapeProvider: breathingWet }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('submerged_posture');
    expect(result.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(true);
  });

  it('preflights profile volume counts before reading entries', () => {
    const evilPassengers = new Array(1000);
    Object.defineProperty(evilPassengers, 0, {
      get() {
        throw new Error('profile entries must not be read after a budget rejection');
      },
    });
    const counting = countingSolid();
    const profile: MountedBoatProfile = {
      ...boatProfile,
      passengerClearance: evilPassengers as unknown as Box3[],
    };

    const result = evaluateWaterRoute(
      new VoxelMap('world'),
      boatQuery(boatRoute, { profile, solidShapeProvider: counting.provider }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxProfileVolumes' });
    expect(counting.calls()).toBe(0);
  });

  it('bounds provider risk facts before enumerating them', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const evilRisks = new Array(1000);
    Object.defineProperty(evilRisks, 0, {
      get() {
        throw new Error('risk facts must not be enumerated after a budget rejection');
      },
    });
    const risky: FluidShapeProvider = {
      version: 'huge-risk-list',
      resolve(state) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        return {
          kind: 'shape',
          shape: { water: waterVolume(0.875), lava: null, risks: evilRisks as never },
        };
      },
    };

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { fluidShapeProvider: risky, limits: { maxRiskFacts: 10 } }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxRiskFacts' });
  });

  it('rejects unsafe enumerable coordinates before any provider work', () => {
    const huge = 2 ** 53;
    const counting = countingSolid();

    const result = evaluateWaterRoute(
      new VoxelMap('world'),
      swimQuery(
        [
          { x: huge, y: 0, z: 0.5 },
          { x: huge, y: 0, z: 0.5 },
        ],
        { solidShapeProvider: counting.provider },
      ),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem?.kind).toBe('unsupported_range');
    expect(result.budget.candidateCells).toBe(0);
    expect(counting.calls()).toBe(0);
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

  it('does not age evidence past validUntil, and a same-state refresh keeps the revision', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);

    const fresh = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    expect(fresh.status).toBe('OPEN');
    const revision = fresh.dependencies[0]!.revision;

    const aged = evaluateWaterRoute(map, swimQuery(swimRoute), 70000);
    expect(aged.status).toBe('OPEN');

    fillSwimWater(map, 0, 2, { observedAt: 69000 });
    const refreshed = evaluateWaterRoute(map, swimQuery(swimRoute), 70000);
    expect(refreshed.status).toBe('OPEN');
    expect(refreshed.validUntil).toBe(Number.POSITIVE_INFINITY);
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

  it('accepts evidence from another session and rejects evidence pending an effect', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2, { sessionId: 's2' });

    expect(evaluateWaterRoute(map, swimQuery(swimRoute), 1000).status).toBe('OPEN');

    map.invalidatePendingEffect('overworld', { x: 1, y: 0, z: 0 });
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
        // An uncooperative infinite loop is stopped by the controlled-read sentinel.
        for (;;) {
          reads += 1;
          read.cell(cell.x, cell.y, cell.z);
        }
      },
    };

    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { fluidShapeProvider: noisy, limits: { maxNeighborReads: 2 } }),
      1000,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxNeighborReads' });
    expect(result.budget.neighborReads).toBe(3);
    expect(reads).toBe(3);
  });

  it('propagates non-budget provider errors unchanged', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const exploding: FluidShapeProvider = {
      version: 'exploding-fluid',
      resolve() {
        throw new Error('provider exploded');
      },
    };

    expect(() =>
      evaluateWaterRoute(map, swimQuery(swimRoute, { fluidShapeProvider: exploding }), 1000),
    ).toThrow('provider exploded');
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
  it('accepts an in-water surface target without requiring dry land or shore', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: true, onGround: false })],
        { map: surfaceTargetMap() },
      ),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.goal.target).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
    expect(result.lastObservedAt).toBe(1000);
    expect(result.surfaceGeometry?.status).toBe('OPEN');
    expect(result.dependencies?.length).toBeGreaterThan(0);
    expect(result.validUntil).toBe(6000);
    // No shore support is invented for a water target.
    expect(result.shoreSupport).toBeUndefined();
  });

  it('does not accept a dry body at a surface target even with OPEN water geometry', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: false, onGround: true })],
        { map: surfaceTargetMap() },
      ),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('not_in_water');
  });

  it('preserves target height and tolerances', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.7, z: 0.5 } })],
        { map: surfaceTargetMap() },
      ),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('outside_target');
    expect(result.goal.target).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });

  it('rejects a fully submerged surface target even though inWater is true', () => {
    const map = new VoxelMap('world');
    fill(map, { x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, WATER);
    const submergedProvider: FluidShapeProvider = {
      version: 'submerged-fluid',
      resolve(state, cell) {
        if (state.name !== 'minecraft:water') {
          return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
        }
        const surfaceY = cell.y === 2 ? 0.5 : 0.875;
        return {
          kind: 'shape',
          shape: { water: waterVolume(surfaceY), lava: null, risks: [] },
        };
      },
    };
    const goal = {
      ...swimTargetGoal(),
      profile: { ...swimProfile, surfaceBand: { minY: 0, maxY: 3 } },
      fluidShapeProvider: submergedProvider,
    };

    const result = checkWaterArrival(
      arrivalRequest(
        goal,
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: true })],
        { map },
      ),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('surface_geometry');
    expect(result.surfaceGeometry?.status).toBe('UNSUPPORTED');
    expect(result.surfaceGeometry?.hazards.some((hazard) => hazard.kind === 'submersion')).toBe(true);
  });

  it('rejects missing or pending-effect surface geometry, but not surface evidence past validUntil', () => {
    const missing = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, inWater: true })],
        { map: new VoxelMap('world') },
      ),
    );
    expect(missing.status).toBe('UNCONFIRMED');
    expect(missing.problem?.kind).toBe('surface_geometry');
    expect(missing.surfaceGeometry?.status).toBe('UNKNOWN');

    const aged = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, observedAt: 69000, inWater: true })],
        { map: surfaceTargetMap(), now: 70000 },
      ),
    );
    expect(aged.status).toBe('ARRIVED');

    const pendingMap = surfaceTargetMap();
    pendingMap.invalidatePendingEffect('overworld', { x: 0, y: 1, z: 0 });
    const stale = checkWaterArrival(
      arrivalRequest(
        swimTargetGoal(),
        [sample({ pos: { x: 0.5, y: 0.5, z: 0.5 }, observedAt: 1500, inWater: true })],
        { map: pendingMap, now: 2000 },
      ),
    );
    expect(stale.status).toBe('UNCONFIRMED');
    expect(stale.problem?.kind).toBe('surface_geometry');
    expect(stale.surfaceGeometry?.status).toBe('STALE');
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
    expect(result.dependencies?.length).toBeGreaterThan(0);
    expect(result.validUntil).toBe(6000);
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

  it('preflights a huge shore body before map or provider work', () => {
    class CountingMap extends VoxelMap {
      reads = 0;
      override sectionAt(dim: string, x: number, y: number, z: number) {
        this.reads += 1;
        return super.sectionAt(dim, x, y, z);
      }
    }
    const map = new CountingMap('world');
    const counting = countingSolid();
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 1_000_000, height: 1.8 },
      shapeProvider: counting.provider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxShoreCells' });
    expect(map.reads).toBe(0);
    expect(counting.calls()).toBe(0);
  });

  it('bounds excessive shore shape parts before the old evaluator iterates them', () => {
    const map = new VoxelMap('world');
    map.observe(observation(STONE, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    const hugeBoxes = new Array(5000);
    Object.defineProperty(hugeBoxes, 0, {
      get() {
        throw new Error('shore shape boxes must not be iterated after a budget rejection');
      },
    });
    const provider: CollisionShapeProvider = {
      version: 'huge-shore-shape',
      resolve(state, cell, read) {
        if (state.name === 'minecraft:stone') {
          return {
            kind: 'shape',
            shape: { boxes: hugeBoxes as never, supportFaces: FULL_CUBE.supportFaces },
          };
        }
        return solidProvider.resolve(state, cell, read);
      },
    };
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: provider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map, limits: { maxShoreShapeParts: 100 } }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxShoreShapeParts' });
  });

  it('stops runaway shore neighbour reads at the controlled budget', () => {
    const map = new VoxelMap('world');
    map.observe(observation(STONE, { x: 2, y: 0, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 1, z: 0 }));
    map.observe(observation(AIR, { x: 2, y: 2, z: 0 }));
    let reads = 0;
    const provider: CollisionShapeProvider = {
      version: 'noisy-shore',
      resolve(state, cell, read) {
        for (;;) {
          reads += 1;
          read.cell(cell.x, cell.y, cell.z);
        }
      },
    };
    const goal: DryShoreGoal = {
      kind: 'dry_shore',
      target: { x: 2.5, y: 1, z: 0.5 },
      horizontalTolerance: 0.1,
      verticalTolerance: 0.05,
      body: { width: 0.6, height: 1.8 },
      shapeProvider: provider,
      feetTolerance: 0.05,
    };

    const result = checkWaterArrival(
      arrivalRequest(goal, [
        sample({ pos: { x: 2.5, y: 1, z: 0.5 }, inWater: false, onGround: true }),
      ], { map, limits: { maxShoreNeighborReads: 2 } }),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxShoreNeighborReads' });
    expect(reads).toBeLessThanOrEqual(3);
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

  it('rejects a moving boat measured independently of the stationary player', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ observedAt: 1000, sequence: 1 }),
        sample({
          observedAt: 1200,
          sequence: 2,
          velocity: { x: 0, y: 0, z: 0 },
          boatMeasurement: boatMeasurement({
            observedAt: 1200,
            sequence: 2,
            velocity: { x: 0.5, y: 0, z: 0 },
          }),
        }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('moving');
  });

  it('rejects a sparse stable window even when the endpoint samples match', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        dockGoal({ stableWindowMs: 60000, maxSampleGapMs: 1000 }),
        [
          sample({ observedAt: 1000, sequence: 1 }),
          sample({ observedAt: 61000, sequence: 2, boatMeasurement: boatMeasurement({ observedAt: 61000, sequence: 2 }) }),
        ],
        { now: 62000, maxSampleAgeMs: 120000 },
      ),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('insufficient_stable_window');
  });

  it('restarts the stable window after a declared evidence gap', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        dockGoal({ stableWindowMs: 300, maxSampleGapMs: 5000 }),
        [
          sample({ observedAt: 1000, sequence: 1 }),
          sample({ observedAt: 2000, sequence: 2, boatMeasurement: boatMeasurement({ observedAt: 2000, sequence: 2 }) }),
          sample({ observedAt: 52000, sequence: 3, boatMeasurement: boatMeasurement({ observedAt: 52000, sequence: 3 }) }),
          sample({ observedAt: 52200, sequence: 4, boatMeasurement: boatMeasurement({ observedAt: 52200, sequence: 4 }) }),
          sample({ observedAt: 52400, sequence: 5, boatMeasurement: boatMeasurement({ observedAt: 52400, sequence: 5 }) }),
        ],
        { now: 53000, maxSampleAgeMs: 120000 },
      ),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.stableSince).toBe(52000);
    expect(result.stableSamples).toBe(3);
  });

  it('bounds validUntil by the oldest relied-on dock witness', () => {
    const result = checkWaterArrival(
      arrivalRequest(
        dockGoal(),
        [
          sample({ observedAt: 1000, sequence: 1 }),
          sample({ observedAt: 1200, sequence: 2, boatMeasurement: boatMeasurement({ observedAt: 1200, sequence: 2 }) }),
          sample({ observedAt: 1400, sequence: 3, boatMeasurement: boatMeasurement({ observedAt: 1400, sequence: 3 }) }),
        ],
        { now: 2000, maxSampleAgeMs: 1000 },
      ),
    );

    expect(result.status).toBe('ARRIVED');
    expect(result.validUntil).toBe(2000);
  });

  it('uses boat telemetry for dock position and speed', () => {
    const result = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({
          pos: { x: 4.5, y: 0, z: 0.5 },
          boatMeasurement: boatMeasurement({ pos: { x: 7.5, y: 0, z: 0.5 } }),
        }),
      ]),
    );

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem?.kind).toBe('outside_target');
    expect(result.lastPosition).toEqual({ x: 4.5, y: 0, z: 0.5 });
    expect(result.lastBoatPosition).toEqual({ x: 7.5, y: 0, z: 0.5 });
  });

  it('requires same-receipt boat telemetry for a dock', () => {
    const missing = checkWaterArrival(
      arrivalRequest(dockGoal(), [sample({ boatMeasurement: undefined })]),
    );
    expect(missing.status).toBe('UNCONFIRMED');
    expect(missing.problem?.kind).toBe('boat_measurement_missing');

    const unbound = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ boatMeasurement: boatMeasurement({ sequence: 99 }) }),
      ]),
    );
    expect(unbound.status).toBe('UNCONFIRMED');
    expect(unbound.problem?.kind).toBe('boat_measurement');

    const wrongExecution = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ boatMeasurement: boatMeasurement({ executionId: 'exec-2' }) }),
      ]),
    );
    expect(wrongExecution.status).toBe('UNCONFIRMED');
    expect(wrongExecution.problem?.kind).toBe('boat_measurement');

    const wrongScope = checkWaterArrival(
      arrivalRequest(dockGoal(), [
        sample({ boatMeasurement: boatMeasurement({ dim: 'the_nether' }) }),
      ]),
    );
    expect(wrongScope.status).toBe('UNCONFIRMED');
    expect(wrongScope.problem?.kind).toBe('boat_measurement');
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
    const result = checkWaterArrival(arrivalRequest(dockGoal(), samples, { limits: { maxSamples: 2 } }));

    expect(result.status).toBe('UNCONFIRMED');
    expect(result.problem).toMatchObject({ kind: 'budget_exceeded', limit: 'maxSamples' });
  });
});

// --- packaging / import boundaries ---

describe('fluid motion and residency semantics', () => {
  it('treats provider-declared unknown motion as UNKNOWN, never OPEN', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { fluidShapeProvider: fluidProvider({ motion: 'unknown' }) }),
      1000,
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('motion_unknown');
  });

  it('records flowing motion as a current hazard even when risks[] omits it', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const result = evaluateWaterRoute(
      map,
      swimQuery(swimRoute, { fluidShapeProvider: fluidProvider({ motion: 'flowing' }) }),
      1000,
    );
    expect(result.status).toBe('OPEN');
    expect(result.hazards.some((hazard) => hazard.kind === 'current')).toBe(true);
  });

  it('reports a saved but non-resident section as not_resident, not unobserved air', () => {
    const map = new VoxelMap('world', { manualResidency: true });
    map.installDirectory([{
      key: { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 },
      seq: 1, bytes: 1, observedCells: 1, paletteEntries: 1, revision: 9,
    }]);
    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.problem?.kind).toBe('not_resident');
    const dep = result.dependencies.find(
      (entry) => entry.key.cx === 0 && entry.key.cz === 0 && entry.key.sy === 0,
    );
    expect(dep).toMatchObject({
      revision: 0,
      residency: 'not_resident',
      residencyGeneration: 0,
    });
  });

  it('marks route results as geometry-only and non-executable', () => {
    const map = new VoxelMap('world');
    fillSwimWater(map, 0, 2);
    const result = evaluateWaterRoute(map, swimQuery(swimRoute), 1000);
    expect(result.assurance).toBe('geometry_only');
    expect(result.executable).toBe(false);
  });
});

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
