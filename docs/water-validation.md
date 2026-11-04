# Water-surface and mounted-boat validation

This document describes the bounded, read-only M5 validation slice implemented in
`src/water/` and exported from the package subpath `curio-minecraft-3d-memory/water`.

It answers two separate questions:

1. **Route geometry and evidence** — given evidence already accepted by a
   `VoxelMap`, does the declared swimmer or mounted-boat geometry hold along the
   *entire* linear sweep of a caller-selected, constant-height route?
2. **Completion** — given measured, ordered body samples, does the original
   surface / dry-shore / dock goal hold?

It does **not** search or smooth routes, choose a shore, execute a controller,
mount or dismount a boat, build/recover a boat, clear lily pads, or perform any
rescue strategy. Route verification and completion verification are separate
checks; neither one implies the other.

## What is implemented

### Separate solid and fluid authorities

Solid collision remains the existing versioned `CollisionShapeProvider`. Fluid
interpretation is a separate versioned `FluidShapeProvider`:

```ts
interface FluidShapeProvider {
  version: string;
  resolve(state: BlockState, cell: Vec3Like, read: ControlledNeighborRead): FluidShapeResolution;
}

interface FluidShape {
  water: FluidVolume | null;
  lava: FluidVolume | null;
  risks: readonly FluidRiskFact[];
}

interface FluidVolume {
  kind: 'water' | 'lava';
  box: UnitBox;                 // unit-local [0,1]^3, may be a partial waterlogged volume
  motion: 'still' | 'flowing' | 'falling' | 'unknown';
  // Explicit surface geometry; 'none' = positively no horizontal surface,
  // 'unknown' = provider cannot tell (never treated as OPEN).
  surface: FluidSurfacePatch | 'none' | 'unknown';
}
```

The library does **not** implement Minecraft water-level formulae and does not
read block names itself. The injected provider is the versioned authority for
source/flowing/falling state, partial waterlogged volumes, and surface height.
An unsupported or unresolved fluid shape never becomes air or `OPEN`.

Both providers may inspect neighbours only through the controlled read. Every
read is checked for session, freshness, expiry and completeness, is recorded as
a section dependency, and consumes a real read budget. Once the budget is
exhausted the read reports `budgetExhausted` and returns `unobserved`; it never
guesses a missing cell.

A cell can have both a solid shape and a fluid shape (for example a waterlogged
slab). Both are evaluated: the solid shape participates in collision while the
fluid volume/surface participates in hazards and water-surface coverage.

### Profiles

`surface_swim`:

```ts
{
  kind: 'surface_swim',
  orientation: { quarterTurns: 0 },
  body: { width: 0.6, height: 1.8 },                       // route point = feet
  breathing: { minY: 1.8, width: 0.5, height: 0.3 },      // separate head clearance
  surfaceBand: { minY: 0.875, maxY: 0.875 }               // absolute world Y
}
```

`mounted_boat`:

```ts
{
  kind: 'mounted_boat',
  orientation: { quarterTurns: 0 },                        // fixed orientation only
  hull: { width: 1.0, length: 2.0, height: 0.6 },          // route point = hull bottom center
  passengerClearance: [                                    // not the player AABB
    { minX: -0.35, minY: 0.6, minZ: -0.7, maxX: 0.35, maxY: 1.8, maxZ: 0.7 }
  ],
  surfaceBand: { minY: 0.375, maxY: 0.375 }
}
```

The declared `surfaceBand` is the waterline/contact contract. The observed
surface must lie in that absolute band at every point of the route; a surface
outside it is not silently clipped. The band must intersect the body's or
hull's vertical span, otherwise the profile is rejected as internally
inconsistent.

### Constant height, fixed orientation

All route points must have exactly the same `Y`. A vertical transition returns
`UNSUPPORTED` with `unsupported_profile`; it is never approximated. Only fixed
90° quarter-turn orientation is modeled. Arbitrary yaw rotation, per-point
rotation, varying waterline dynamics and enter/exit shore trajectories are not
implemented by this slice.

Route coordinates, order and the final target are preserved exactly. Nothing is
floored to a cell, smoothed, interpolated into new waypoints, reordered, or
replaced by a nearby shore/higher or lower target.

### Exact swept geometry and surface coverage

For each consecutive segment, every declared volume (swimmer body and breathing
clearance; hull and each passenger clearance volume) is swept exactly against
solid unit boxes using common-time interval overlap on all three axes. Contact
at an exact boundary is not penetration, and a corner of the swept envelope
that the body never enters is not a collision.

Water-surface contact is also continuous, not sampled: the moving footprint
must overlap an observed surface patch in the declared band over a covering set
of intervals for the whole route. A narrow dry gap cannot disappear between
fixed samples. If unresolved cells could fill the gap, the result is
`UNKNOWN`/`STALE`/`UNSUPPORTED`; only a gap that remains after all potential
surface cells are considered is `BLOCKED` with `missing_surface`.

### Status and hazards

`OPEN` means only that **this bounded geometry contract is supported by current
evidence**. It does not mean arrival, execution success, caller authorization,
safety, or no risk.

- `BLOCKED` — confirmed physical collision, passenger-headroom collision, or
  uncovered water surface.
- `UNKNOWN` — required cells are unobserved/state-incomplete/neighbour-gapped.
- `STALE` — required evidence is stale, expired, or from another session.
- `UNSUPPORTED` — the profile/shape/fluid interpretation is outside the slice,
  or a work budget was exceeded.
- Hazards (`water_contact`, `lava_contact`, `current`, `fall`, `bubble_column`)
  are returned independently. Water/lava/current/bubble facts do not by
  themselves make ordinary swimming `BLOCKED`; authorization and risk decisions
  remain the caller's.

### Budgets, dependencies and validity

`WaterRouteQuery.limits` bounds, before expensive enumeration or cloning where
possible:

| Limit | Meaning |
| --- | --- |
| `maxPoints` | route point count |
| `maxCandidateCells` | combined swept envelope cell count |
| `maxReadCells` | distinct evidence-map cell reads |
| `maxNeighborReads` | provider `read.cell()` calls, including duplicates |
| `maxShapeChecks` | geometric box/interval checks |

Exceeding a limit returns `UNSUPPORTED` with a structured `budget_exceeded`
problem and actual work counts. Duplicate neighbour reads still count, so a
provider cannot bypass the budget by re-reading one cell.

Each actual cell/provider read contributes its section revision and validity
ceiling to `dependencies` / `validUntil`. Reads never mutate the map, evidence
timestamps, section revisions, sessions or persistence state. There is no
persistent cache; every call re-evaluates current evidence. Callers can use the
exposed dependencies and `validUntil` for their own local invalidation.

### Completion verification

`checkWaterArrival` is separate from route verification and consumes the
original goal, scope, execution identity, and measured ordered samples.

- `surface_target` requires the measured position within the original
  horizontal/vertical tolerances and `inWater=true`. It does not require dry
  land or ground support.
- `dry_shore` requires the measured position within the original tolerances,
  actual `onGround=true` / `inWater=false` evidence, and an `OPEN` result from
  the existing read-only `evaluateGroundedWalkSegment` stationary check at that
  position. The actual `StepEvaluation` is returned as `shoreSupport`; the
  water layer does not invent a `supportConfirmed` boolean.
- `boat_dock` requires an explicit stable `boatId` that matches on the final
  sample, simulated/measured velocity within the declared limits, and ordered
  stable samples spanning `stableWindowMs` (at least `minStableSamples`, default
  2). A display `ridingLabel` is never parsed for identity.

Absence, stale samples, replayed/out-of-order samples, wrong world/dim/session,
wrong execution identity, server position correction, forced unmount, identity
mismatch, movement, or an incomplete stable window return `UNCONFIRMED` with a
factual reason. The original sample observation time is preserved in
`lastObservedAt` / `stableSince`; the query time is never substituted. No
dismount, mount, boat construction/recovery, lily-pad clearing or rescue action
is performed.

## Runnable example

Build the package first (`npm run build`). The example below uses deliberately
tiny fake rules — **not** Minecraft 1.20.1 rules — to show the call shape.

```ts
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type {
  BlockState,
  CollisionShape,
  CollisionShapeProvider,
  Observation,
} from 'curio-minecraft-3d-memory';
import {
  checkWaterArrival,
  evaluateWaterRoute,
} from 'curio-minecraft-3d-memory/water';
import type {
  FluidShapeProvider,
  SurfaceSwimProfile,
  WaterBodySample,
} from 'curio-minecraft-3d-memory/water';

const AIR: BlockState = { name: 'minecraft:air', properties: {} };
const WATER: BlockState = { name: 'minecraft:water', properties: { level: '0' } };
const EMPTY: CollisionShape = { boxes: [], supportFaces: [] };

const solid: CollisionShapeProvider = {
  version: 'demo-solid-1',
  resolve() {
    return { kind: 'shape', shape: EMPTY };
  },
};

const fluid: FluidShapeProvider = {
  version: 'demo-fluid-1',
  resolve(state) {
    if (state.name !== 'minecraft:water') {
      return { kind: 'shape', shape: { water: null, lava: null, risks: [] } };
    }
    return {
      kind: 'shape',
      shape: {
        water: {
          kind: 'water',
          box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.875, maxZ: 1 },
          motion: 'still',
          surface: { y: 0.875, minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
        },
        lava: null,
        risks: [],
      },
    };
  },
};

const map = new VoxelMap('demo-world');
const observed = (state: BlockState, x: number, y: number, z: number): Observation => ({
  worldId: 'demo-world',
  dim: 'overworld',
  sessionId: 's1',
  observedAt: 1000,
  sequence: 1,
  source: 'vision',
  evidence: 'seen',
  stateComplete: true,
  state,
  pos: { x, y, z },
});

for (let x = 0; x <= 2; x++) {
  map.observe(observed(WATER, x, 0, 0));
  map.observe(observed(AIR, x, 1, 0));
  map.observe(observed(AIR, x, 2, 0));
}

const profile: SurfaceSwimProfile = {
  kind: 'surface_swim',
  orientation: { quarterTurns: 0 },
  body: { width: 0.6, height: 1.8 },
  breathing: { minY: 1.8, width: 0.5, height: 0.3 },
  surfaceBand: { minY: 0.875, maxY: 0.875 },
};

const route = evaluateWaterRoute(
  map,
  {
    worldId: 'demo-world',
    dim: 'overworld',
    sessionId: 's1',
    points: [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ],
    profile,
    solidShapeProvider: solid,
    fluidShapeProvider: fluid,
  },
  1000,
);
console.log(route.status); // "OPEN" for this declared contract

const sample: WaterBodySample = {
  worldId: 'demo-world',
  dim: 'overworld',
  sessionId: 's1',
  pos: { x: 0.5, y: 0.5, z: 0.5 },
  observedAt: 1000,
  sequence: 1,
  velocity: { x: 0, y: 0, z: 0 },
  alive: true,
  connected: true,
  observationReady: true,
  onGround: false,
  inWater: true,
  executionId: 'exec-1',
};

const arrival = checkWaterArrival({
  goal: {
    kind: 'surface_target',
    target: { x: 0.5, y: 0.5, z: 0.5 },
    horizontalTolerance: 0.1,
    verticalTolerance: 0.1,
  },
  scope: { worldId: 'demo-world', dim: 'overworld', sessionId: 's1', executionId: 'exec-1' },
  samples: [sample],
  now: 1000,
  maxSampleAgeMs: 5000,
});
console.log(arrival.status); // "ARRIVED" for the measured in-water sample
```

## Not implemented by this slice

- No default complete Minecraft fluid rules or built-in fluid provider. The
  caller must supply versioned rules that interpret actual block state and
  properties.
- No host runtime controller integration: no `swimTo`, `ride`, `drive`, key
  control, pathfinder call or perception loop.
- No route search, smoothing, waypoint insertion, shore selection or target
  replacement.
- No arbitrary boat rotation/yaw dynamics; only a fixed quarter-turn
  orientation.
- No varying waterline dynamics, flowing-fluid propagation, or 3D underwater
  navigation.
- No shore enter/exit trajectory execution; only a separate stationary dry-shore
  completion check over measured samples.
- No mount, dismount, boat construction, boat recovery, lily-pad clearing, water
  blocking, equipment change or rescue strategy.
- No automatic memory update or persistence. Evaluations are read-only and
  expose dependencies/`validUntil` for the caller's invalidation.

## Validation evidence

`tests/water-validation.test.ts` covers clear and dry routes, thin obstructions,
exact corner contact, waterlogged solid+fluid cells, narrow surface gaps, boat
hull and passenger headroom, negative/cross-section coordinates, missing /
expired / wrong-session / state-incomplete / neighbour-gap evidence, same-state
refresh and content-change re-evaluation, unrelated-cell dependency isolation,
route/cell/read/neighbour/shape budgets, map immutability, package export shape,
and the surface/shore/dock completion contracts.

These are in-memory fake-rule tests. They do not prove real mineflayer,
Pathfinder, server-correction or in-game boat behaviour, and they do not mean
the whole M5 water/boat milestone is complete. Host integration remains a
separate deliverable.
