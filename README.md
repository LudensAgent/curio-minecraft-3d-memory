# Spatial Memory Library

<p>
  <img src="https://img.shields.io/badge/version-0.9.0-blue.svg" alt="Version 0.9.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft 1.20.1">
  <img src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" alt="TypeScript 5.x">
  <img src="https://img.shields.io/badge/sqlite-optional-003B57.svg" alt="Optional SQLite">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
</p>

English | [简体中文](README_ZH.md)

A standalone TypeScript library for Minecraft Java 1.20.1 agents. It records what was last observed at a position, how that position was traversed before, whether current evidence supports passage, and which part of a route needs re-verification. Goals, strategy, resource spend and risk trade-offs remain the agent's decision.

The scope is **land walking and surface-water movement** — jumps, steps, ladders, drop transitions, surface swimming, riding a boat, and shore entry/exit. Flight, elytra and underwater 3D navigation are out of scope.

**Status: 0.9.0.** The first-version walk navigation pipeline, runtime store composition, topology runtime state and SQLite persistence are implemented and covered by offline tests. Real Minecraft / mineflayer / Curio integration is not yet validated.

## Features

- **Evidence-backed observation map** (`voxel/`, `observation/`): sparse, versioned Sections with per-cell evidence, freshness and session handling; a bounded `ObservationQueue`; and localized `ChangeReport`s that invalidate only dependent work.
- **Historical geometry kept separate from current state** (`topology/`): `FragmentStore` stores path fragments and confirmed traversal evidence; `TopologyStore` stores explicit nodes and directional edges. Blockage elsewhere never deletes history, and history never proves current passability.
- **Bounded historical queries**: `adjacency`, `reachable`, `route`, and `historicalAnchorCandidates` return recorded facts with finite work budgets — never a live `OPEN`, arrival claim, or executable point list.
- **Runtime topology state** (`topology/`): directional edge verification, separate portal edges, anchor queries, transient occupancy, and evidence-backed fragment connectivity/merge records. Derived state is invalidated without deleting history.
- **First-version walk navigation** (`navigation/`): `navigateTo` performs measured start → bounded search → re-verified execution → measured arrival. `followKnownPath` follows an explicit historical fragment; `inspectRoute`, `inspectKnownRoute` and `frontierCandidates` are read-only projections. `recall_route` is not implemented.
- **Controlled route execution** (`execution/`): `WalkRouteExecutor` drives an injected single-step `MoveExecutor`, requires current `OPEN` evidence before each segment, accepts arrival only from a measured exact position, and revokes in-flight segments when their evidence changes.
- **Land and water validation** (`traversability/`, `water/`): `evaluateLandTransition` / `LandRouteVerifier` check caller-declared land transitions and routes; `evaluateWaterRoute` / `checkWaterArrival` check surface swimming and mounted-boat geometry. Results carry `assurance: 'geometry_only'` and `executable: false`.
- **Explicit SQLite persistence** (`storage/`, `curio-minecraft-3d-memory/storage/sqlite`): one worker owns the connection and transactions. `checkpoint()` is the only explicit save trigger; incremental voxel checkpoints, manual Section residency, `WorkingSetManager`, placement/visit/portal ledgers, an append-only journal and an offline legacy-migration dry-run are included.
- **Host-independent integration surface**: `SpatialMemoryStoreImpl` composes the runtime stores with a scope guard; the library consumes perception and execution through narrow adapter types and never imports host source.

## Requirements

- **Node.js `>= 18`** for the core and `water` entries.
- **Node.js `>= 20` and `better-sqlite3@^12`** for the SQLite entry. `better-sqlite3` is an optional peer dependency and is only loaded by `curio-minecraft-3d-memory/storage/sqlite`.
- **Minecraft Java 1.20.1 semantics** for collision shapes and fluid interpretation. The library does not depend on a Minecraft client or server at runtime; callers inject versioned providers.
- An ESM / NodeNext TypeScript consumer. The package ships runtime JavaScript and `.d.ts` declarations from `dist/`.

## Install and consume

Build the package and create an installable archive:

```bash
npm install --no-audit --no-fund
npm run build
npm pack
```

Consumers install the real `.tgz` into their own project and import by package name and public subpath — never a source path, `../dist`, `npm link`, or a development-machine directory alias:

```json
{
  "dependencies": {
    "curio-minecraft-3d-memory": "file:./curio-minecraft-3d-memory-0.9.0.tgz",
    "better-sqlite3": "^12.0.0"
  }
}
```

| Entry | Contents | Native dependency |
|---|---|---|
| `curio-minecraft-3d-memory` | observation, voxel, traversability, topology, navigation, execution and runtime store | none |
| `curio-minecraft-3d-memory/water` | water-surface and mounted-boat validation | none |
| `curio-minecraft-3d-memory/storage/sqlite` | SQLite sessions, ledgers, journal and `WorkingSetManager` | `better-sqlite3@^12` |

## Quick start

### Open a shared spatial session

A host normally keeps one spatial session per world and reuses its map across perception updates and navigation delegations:

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  // Optional: 'manual' avoids decoding every committed Section at open.
  voxelLoading: 'eager',
});

session.voxel.beginSession('session-a');
session.voxel.observe({ /* confirmed observation */ });

await session.checkpoint(); // the only explicit save trigger
await session.close();
```

Restored facts keep their original observation times and sources, but saved `FRESH` state comes back `STALE`. A new observation refreshes only the cells actually observed.

### Navigate

```ts
import { navigateTo } from 'curio-minecraft-3d-memory';

const { result, record } = await navigateTo(
  {
    destination: { x: 10, y: 64, z: 10 },
    arrival: { kind: 'exact' },
    allowedModes: ['walk'],
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
  },
  environment,
);

if (result.outcome === 'ARRIVED') {
  // result.confirmed, result.lastPosition and result.lastObservation are measured.
}
```

`environment` is supplied by the caller and contains the world/dim/session identity, measured body samples, a `WalkRouteSearch` source, a `WalkRouteExecutor` bound to the same map, shape provider, budgets and an optional cancellation signal. The library never scans the world or owns the body.

Follow one explicitly selected historical fragment with `followKnownPath(request, { ...environment, history, drive: true })`; without `drive`, it only returns the start boundary.

### Validate land and water geometry

```ts
import {
  evaluateLandTransition,
  LandRouteVerifier,
  resolveLandLimits,
} from 'curio-minecraft-3d-memory';
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';

const transition = evaluateLandTransition(
  map,
  { worldId, dim, sessionId, body, transition: declaredTransition },
  { shapeProvider, jumpModel, climbProvider },
  Date.now(),
  resolveLandLimits({ maxWork: 4096 }),
);

const route = evaluateWaterRoute(
  map,
  {
    worldId, dim, sessionId,
    points,
    profile: 'surface_swim',
    solidShapeProvider,
    fluidShapeProvider,
  },
  Date.now(),
);

const arrival = checkWaterArrival({ goal, scope, map, samples, now, maxSampleAgeMs });
```

Land validation supports `step`, `drop`, `jump` and `ladder`; `jump` requires an injected versioned `LandMotionModel`, and `ladder` an injected versioned `ClimbRegionProvider`. Water routes must be constant-height with a fixed 90° orientation. Neither validator searches a route, moves the body, digs, places, mounts a boat, or applies a rescue strategy.

### Keep history and topology

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);

topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } } });
topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 1.5, y: 64, z: 0.5 } } });

topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'traversed', evidenceIds: ['ev-1'] });

const route = topology.route('a', 'b', { mode: 'walk' });
// route.status: FOUND | NO_RECORDED_ROUTE | INSUFFICIENT_EVIDENCE | BUDGET_EXHAUSTED
```

A→B and B→A are independent records. Only `traversed` edges whose evidence still resolves participate in historical queries. A candidate edge is a relation to verify, not proof that a traversal happened. See the acceptance documents linked below for full result and failure semantics.

### Manage a bounded working set

```ts
import { WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  voxelLoading: 'manual',
  residencyLimits: { maxResidentSections: 8 },
});
const manager = new WorkingSetManager(session);

const prepared = await manager.prepare(routeDependencySections);
// prepared.status: 'ready' | 'incomplete' | 'failed'
// prepared.lease is valid only when status === 'ready'; the caller owns release.
```

`prepare` validates the whole request, protects it with a temporary pin lease, evicts only committed, clean, unpinned LRU-eligible Sections, and loads the rest through the session's single worker. `free()` makes room for new observations and `stats()` reports a read-only snapshot.

## Host integration lifecycle

The library provides facts and execution assistance; the host owns the connection, legal perception and body control. See `examples/shared-session-lifecycle.ts` for the runnable Fake example.

1. **Startup** — the host supplies an absolute database path and `worldId`; await `openSpatialSession()` before using `session.voxel`. Do not recreate the map per action.
2. **Shared map** — continuous perception and multiple walk delegations reuse `session.voxel`; sharing the map does not share execution ownership.
3. **Connect / reconnect** — the observation `sessionId` comes from the real connection lifecycle. A reconnect to the same world keeps `worldId`; switch with `map.beginSession(sessionId)`. Late old-session evidence is rejected.
4. **Perception update** — write `map.observe(...)` first, then forward the returned `ChangeReport` to the active verifier or executor. The library never scans the world.
5. **Route lifecycle** — load and protect the actual route dependencies (`WorkingSetManager.prepare` + lease), verify, execute, then release. Cancelling one delegation never closes the shared session.
6. **Save and close** — `checkpoint()` captures and commits current changes; `flush()` only waits for an already-accepted save; `close()` shuts down within a bound. Stop accepting writes → final checkpoint → check confirmation → close.
7. **Restore** — history and original evidence times come back; current passability must be re-established and is never read from disk as a fresh observation.

## Navigation capability status

| Design §7 name | Status | Public entry | Boundary |
|---|---|---|---|
| `navigate_to` | implemented | `navigateTo` | Walk only; exact arrival; same height, ±1 block along X/Z; caller-supplied search, executor and measured samples |
| `follow_known_path` | implemented | `followKnownPath`, `startKnownWalkRoute` | Walk only; one explicitly selected fragment; `followKnownPath` drives only when `drive: true` |
| `inspect_route` | read-only | `inspectRoute`, `inspectKnownRoute` | Projects an existing snapshot or historical fragment; never moves, observes, pins or saves |
| `frontier_candidates` | read-only | `frontierCandidates` | Projects bounded unknown boundary candidates; never selects a target or starts exploration |
| `recall_route` | not implemented | — | No public runtime entry; historical queries do not become route recall or execution |

`navigateTo` explicitly rejects `near` / `reach_block` arrival, non-walk modes, digging, placing, towering, non-empty material lists, non-empty `avoid` constraints and `allow_frontier`. Those rejections are structured results, never silently ignored settings.

## Project structure

```
src/
├── index.ts            # public API entry (minimal, explicit export surface)
├── constants.ts        # shared configuration constants
├── types.ts            # base primitives (Vec3Like / BlockState / WorldScope / MoveMode)
├── observation/        # Observation / evidence / freshness and bounded queue
├── voxel/              # sparse Sections, palette, bit-packing and evidence history
├── traversability/     # derived traversability + bounded land transition/route validation
├── water/              # water-surface and mounted-boat validation (subpath /water)
├── topology/           # history, explicit topology, runtime edges, portals, anchors, occupancy
├── adapter/            # WorldAdapter target surface
├── navigation/         # walk search, navigateTo, followKnownPath and read-only projections
├── execution/          # controlled walk-route execution loop
├── store/              # SpatialMemoryStore runtime composition and scope guard
├── storage/            # SQLite persistence, ledgers, journal and worker
└── compat/             # legacy WorldMemory compatibility and migration dry-run

examples/
├── walk-route-execution.ts         # Fake execution loop
├── fragment-store-history.ts       # historical facts vs current blockage
├── topology-facts.ts               # explicit topology facts vs current blockage
├── historical-topology-query.ts    # bounded historical graph queries
├── historical-anchor-query.ts      # bounded historical anchor queries
├── history-checkpoint.ts           # SQLite history checkpoint lifecycle
├── spatial-checkpoint.ts           # combined spatial checkpoint lifecycle
├── spatial-checkpoint-incremental.ts # incremental voxel checkpoint
├── spatial-residency.ts            # manual on-demand Section residency
├── working-set.ts                  # bounded working set + Fake route
└── shared-session-lifecycle.ts     # host shared-session lifecycle reference
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/ (NodeNext ESM + type declarations)
```

Run the examples with `tsx`:

```bash
npx tsx examples/walk-route-execution.ts
npx tsx examples/shared-session-lifecycle.ts
npx tsx examples/working-set.ts
# …see the examples/ directory for the full list
```

Run the independent consumer acceptance (pack → throwaway install → runtime assertions + type-check):

```bash
node acceptance/run.mjs
```

The examples and tests use Fake perception, Fake bodies and Fake move executors. The persistence tests use a real SQLite database and a real worker. None of these tests start a Minecraft server or connect a mineflayer bot; in-game validation remains outstanding.

> Examples that import the package by its public name (`curio-minecraft-3d-memory`, or the `curio-minecraft-3d-memory/storage/sqlite` subpath) exercise the package `exports` entries. Run `npm run build` first.

## Documentation

- [Design and development constraints](docs/spatial-memory-library-design.md) — target contracts, data model, and implementation order.
- [AGENTS.md](AGENTS.md) — repository development rules and boundaries.
- [Navigation API status](docs/navigation-api-status.md) — the current §7 capability table and unsupported cases.
- [Runtime store composition](docs/spatial-memory-store.md) — `SpatialMemoryStoreImpl` behavior and known truth gaps.
- [Land route validation](docs/land-route-validation.md) — transition and route geometry contract.
- [Water validation](docs/water-validation.md) — surface-swim and mounted-boat contract.
- [0.9.0 implementation progress](docs/design-progress-0.9.0.md) — implemented sections, verification, and remaining gaps.
- Persistence acceptance: [5A](docs/phase-5a-history-checkpoint-acceptance.md), [5B](docs/phase-5b-spatial-checkpoint-acceptance.md), [5C](docs/phase-5c-voxel-incremental-checkpoint-acceptance.md), [5D1](docs/phase-5d1-section-residency-acceptance.md), [5D2](docs/phase-5d2-working-set-acceptance.md), [storage ledger](docs/phase-l5-storage-ledger-acceptance.md).
- [Event and action journal](docs/event-persistence.md) — append-only journal semantics.

## Known limitations

- **No live game validation.** Body samples, world adapters, search instances and shape/fluid providers are caller-supplied. Fake tests prove library logic, not mineflayer control or Minecraft physics.
- **Walk scope only.** `navigateTo` supports same-height, single-cell X/Z walking with exact arrival. Jumps, steps, ladders, drops, swimming, boats, `near` / `reach_block`, digging, placing, towering, materials, non-empty `avoid` and frontier exploration are not executable navigation modes.
- **`recall_route` is not implemented.** Historical route and anchor queries are facts, not an executable route selection or an arrival claim.
- **Land and water validators are geometry-only.** They never search a route, move the body, manage a boat, or apply a rescue strategy. Results are marked `assurance: 'geometry_only'` and `executable: false`.
- **Persistence is explicit.** There is no auto-save or background retry; only `checkpoint()` commits. Restored observations are `STALE`, and current passability must be re-established. The JSON → SQLite authority switch was not performed; only an offline migration dry-run exists.
- **Perception is host-owned.** The library does not scan the client world, load chunks, or treat raw `blockUpdate` events as evidence. It records only observations the host legally supplies.
- **Containers and inventory remain host-led.** The library associates locations and reachability evidence; it does not copy or maintain item counts.
- **No flight, elytra, or underwater 3D navigation.** These are outside the library's scope.
- **Known store truth gaps.** `markTraversed` / `markModified` are not available on the current `VoxelMap`; `SpatialEdge` is a lossy projection of `TopologyStore`; portal edges are separate from the walk graph; `Frontier.historicalConnection` cannot express unknown. Use the detailed reads and inspection APIs named in the store documentation.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
