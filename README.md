# Spatial Memory Library

<p>
  <img src="https://img.shields.io/badge/version-0.11.0-blue.svg" alt="Version 0.11.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft 1.20.1">
  <img src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" alt="TypeScript 5.x">
  <img src="https://img.shields.io/badge/sqlite-optional-003B57.svg" alt="Optional SQLite">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
</p>

English | [简体中文](README_ZH.md)

A standalone TypeScript library for Minecraft Java 1.20.1 agents. It records what was last observed at a cell, stores semantic place/resource/container facts, searches bounded land routes over the observed voxel map, validates land and water geometry, and persists the working set with an explicit checkpoint. Goals, strategy, resource spend and risk trade-offs remain the agent's decision.

The scope is **land walking and surface-water movement** — jumps, steps, ladders, drop transitions, surface swimming, riding a boat, and shore entry/exit. Flight, elytra and underwater 3D navigation are out of scope.

**Status: v0.11 voxel-first core.** The library is now built from the observed `VoxelMap`, semantic facts, bounded `LandSearch`, land/water validators and SQLite persistence for voxel, facts, ledger and journal domains. The retired fragment/topology stores, historical route planning, route registries, walk-path bindings and library-side walk executor are gone. Host execution is its own `navigate_to` / `advance` and direct movement primitives; this library returns evidence and route candidates, never an arrival claim.

`MemoryHostCapabilities` has `memory`, `query` and `persistence` domains only. The contract version is `memory-host-contract/2`; body execution and route planning are not library capabilities. Real Minecraft / mineflayer / Curio integration is not validated by this package.

## Features

- **Evidence-backed observation map** (`voxel/`, `observation/`): sparse, versioned Sections with per-cell evidence, freshness and session handling; a bounded `ObservationQueue`; and localized `ChangeReport`s that invalidate only dependent work.
- **Semantic facts** (`facts/`): flat place, resource and container anchors with stable ids, original observation times, gone/revoked state and bounded cursor paging. Resource anchors may carry the exact source-cell evidence revision. Container contents remain host-led.
- **Bounded voxel land search** (`searchLandRoute` / `searchLandRouteAsync`): A* over observed support surfaces for walk/step/drop, plus explicitly allowed horizontal `jump` edges when the caller supplies a `LandMotionModel`, and explicitly allowed `ladder` edges when the caller supplies a `ClimbRegionProvider`. Results require current revalidation and carry `executable: false`.
- **Land and water validation** (`traversability/`, `water/`): `evaluateLandTransition` / `LandRouteVerifier` check caller-declared land transitions and routes; `evaluateWaterRoute` / `checkWaterArrival` check surface swimming and mounted-boat geometry. Results are geometry/evidence verdicts, never execution.
- **Explicit SQLite persistence** (`storage/`, `curio-minecraft-3d-memory/storage/sqlite`): one worker owns the connection and transactions. `checkpoint()` is the only explicit save trigger. It commits voxel Sections, placement/visit/portal ledger rows, the append-only journal and the semantic facts domain in one transaction. Manual Section residency, `WorkingSetManager`, bounded dirty batches and facts migration receipts are included.
- **Retired domains are read-only metadata.** `legacyStoreSummary` reports row counts and the old `curio:migration` marker. The worker never loads, writes, restores or deletes the retired route tables. Fresh databases do not create them.
- **Host-independent integration surface**: observation, facts, search, validation and persistence consume caller-supplied evidence, body dimensions and versioned shape providers. The library never imports host source.

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
    "curio-minecraft-3d-memory": "file:./curio-minecraft-3d-memory-0.11.0.tgz",
    "better-sqlite3": "^12.0.0"
  }
}
```

| Entry | Contents | Native dependency |
|---|---|---|
| `curio-minecraft-3d-memory` | root entry: observation, voxel, traversability, land search, facts, persistence types and water validation | none |
| `curio-minecraft-3d-memory/memory` | pure memory core: observation, voxel, query and capability report; no navigation or body entries | none |
| `curio-minecraft-3d-memory/navigation` | bounded voxel land search (`searchLandRoute`, `searchLandRouteAsync`) | none |
| `curio-minecraft-3d-memory/water` | water-surface and mounted-boat validation | none |
| `curio-minecraft-3d-memory/storage/sqlite` | SQLite session, ledgers, journal, facts, working set | `better-sqlite3@^12` |

## Quick start

### Open a spatial session

A host normally keeps one spatial session per world and reuses its map across perception updates:

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  // Optional: 'manual' reads only the committed section directory at open.
  voxelLoading: 'eager',
});

session.voxel.beginSession('session-a');
session.voxel.observe({ /* confirmed observation */ });

session.facts.upsertPlace({ /* semantic place fact */ });

await session.checkpoint(); // the only explicit save trigger
await session.close();
```

Restored cells keep their original evidence times and sources but read as `STALE`. A new observation refreshes only the cells actually observed. A restored facts domain keeps its exact ids, times and gone/revoked state.

### Search a bounded land route

```ts
import { searchLandRoute } from 'curio-minecraft-3d-memory/navigation';

const result = searchLandRoute({
  map: session.voxel,
  scope: { worldId, dim, sessionId },
  start: measuredFeet,
  target: { kind: 'exact', pos: destinationFeet },
  body,
  shapeProvider,
  allowed: ['walk', 'step', 'drop'],
  limits: { maxNodes: 4096, maxExpandedEdges: 16384, maxWork: 65536 },
  now: Date.now,
});
// result.status: FOUND | NO_PATH | INSECURE | BUDGET_EXHAUSTED | CANCELLED | ...
// result.executable is always false: current evidence is not authorization.
```

`searchLandRouteAsync` provides the same bounded search in cooperative slices. The host validates and executes any chosen route itself with its own `navigate_to` / `advance`; this library does not move the body.

### Query voxel state and facts

```ts
import { createVoxelFactsQueryPort } from 'curio-minecraft-3d-memory';

const port = createVoxelFactsQueryPort({
  worldId,
  voxel: session.voxel,
  facts: session.facts,
});

const cells = port.query({ kind: 'cells', dim, positions: [cell] });
const places = port.query({ kind: 'places', dim, limit: 50 });
const resources = port.query({ kind: 'resourceAnchors', dim, includeGone: false });
```

Supported query kinds are `cells`, `nodes`, `places`, `resourceAnchors`, `containerAnchors`, `containerContents`, `snapshot` and `capabilities`. `nodes` is a facts-backed semantic view, not an old topology graph. `containerContents` always returns the host-ledger boundary rather than an empty list. Retired route kinds are rejected as unknown requests.

### Validate land and water geometry

```ts
import { evaluateLandTransition, LandRouteVerifier } from 'curio-minecraft-3d-memory';
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';

const transition = evaluateLandTransition(map, query, rules, now, limits);
const route = evaluateWaterRoute(map, waterQuery, now);
const arrival = checkWaterArrival({ goal, scope, map, samples, now, maxSampleAgeMs });
```

Land validation supports `step`, `drop`, `jump` and `ladder`; `jump` requires an injected versioned `LandMotionModel`, and `ladder` an injected versioned `ClimbRegionProvider`. Water routes must be constant-height with a fixed 90° orientation. Neither validator searches a route, moves the body, digs, places, mounts a boat, or applies a rescue strategy.

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

const prepared = await manager.prepare(dependencySections);
// prepared.status: 'ready' | 'incomplete' | 'failed'
// prepared.lease is valid only when status === 'ready'; the caller owns release.
```

`prepare` validates the whole request, protects it with a temporary pin lease, evicts only committed, clean, unpinned LRU-eligible Sections, and loads the rest through the session's single worker. `free()` makes room for new observations and `stats()` reports a read-only snapshot.

## Persistence and migration

- `checkpoint()` commits the captured revisions of every changed domain. A clean domain is not rewritten.
- Voxel dirty batches are bounded; the ACK confirms exactly the captured Section keys. A later change stays pending.
- Facts are committed only after their referenced source-cell versions are present in the same transaction; otherwise the checkpoint reports a structured `factsDeferred` gap and leaves facts pending.
- Journal rows are append-only. An empty batch never deletes committed rows.
- `legacyStoreSummary` is the only read path for retired route tables. Existing old rows stay byte-identical across new checkpoints; no `DROP` or `DELETE` targets them.
- `runLegacySemanticMigrationDryRun` / `applyLegacySemanticMigration` are independent pure data functions for offline semantic-fact migration. They do not import the retired stores.

## Host integration lifecycle

The library provides facts, candidates and persistence; the host owns the connection, legal perception and body control.

1. **Startup** — the host supplies an absolute database path and `worldId`; await `openSpatialSession()` before using `session.voxel`. Do not recreate the map per action.
2. **Shared map** — continuous perception, land search and host navigation reuse `session.voxel`.
3. **Connect / reconnect** — the observation `sessionId` comes from the real connection lifecycle. A reconnect to the same world keeps `worldId`; switch with `map.beginSession(sessionId)`. Late old-session evidence is rejected.
4. **Perception update** — write `map.observe(...)` first, then forward the returned `ChangeReport` to the host control loop. The library never scans the world.
5. **Search and execute** — the host protects the Sections it needs (`WorkingSetManager.prepare` + lease), calls `searchLandRoute`, verifies the chosen route, and executes it with its own primitives. Cancelling one delegation never closes the shared session.
6. **Save and close** — `checkpoint()` captures and commits current changes; `flush()` only waits for an already-accepted save; `close()` shuts down within a bound.
7. **Restore** — original evidence times and fact records come back; current passability must be re-established and is never read from disk as a fresh observation.

## Capability contract

`MemoryHostCapabilities` reports only:

- `memory`: observation/session writes and checkpoint/flush/close lifecycle;
- `query`: cells, facts-backed nodes/places/anchors and snapshot/capabilities;
- `persistence`: SQLite, manual residency, working set and migration authority switch.

`execute` and `plan` blocks do not exist in `memory-host-contract/2`. Use `composeCapabilities` to intersect the library report with the host's own wiring before calling anything; a `false` or omitted capability is an explicit `unsupported` refusal, not a silent fallback.

## Project structure

```
src/
├── index.ts            # public API entry (minimal, explicit export surface)
├── constants.ts        # shared configuration constants
├── types.ts            # base primitives (Vec3Like / BlockState / WorldScope / MoveMode)
├── observation/        # Observation / evidence / freshness and bounded queue
├── voxel/              # sparse Sections, palette, bit-packing, residency and snapshots
├── traversability/     # derived traversability, land transitions and LandRouteVerifier
├── water/              # water-surface and mounted-boat validation (subpath /water)
├── facts/              # semantic facts, paging, persistence and offline migration
├── navigation/         # bounded voxel LandSearch and shared delegation contracts
├── query/              # read-only voxel + facts projection
├── adapter/            # WorldAdapter target surface
└── storage/            # SQLite persistence, ledgers, journal, facts and worker
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/ (NodeNext ESM + type declarations)
```

Tests use Fake perception, Fake bodies and Fake shape providers. Persistence tests use a real SQLite database and a real worker. None of these tests start a Minecraft server or connect a mineflayer bot; in-game validation remains outstanding.

## Documentation

- [AGENTS.md](AGENTS.md) — repository development rules and boundaries.
- [v0.11.0 upgrade plan](docs/v0.11.0-upgrade-plan.md) and [implementation plan](docs/v0.11.0-implementation-plan.md) — staged voxel-first design and implementation records.
- [Design and development constraints](docs/spatial-memory-library-design.md) — target contracts, data model and implementation order.
- [Memory-host interface contract](docs/memory-host-interface-contract.md) — capability negotiation and host boundaries.
- [Legacy migration gate](docs/legacy-migration-gate.md) — offline migration authority rules.

Older audits remain in `docs/` as historical records; they describe implementations that this branch has retired.

## Known limitations

- **No live game validation.** Body samples, world adapters and shape/fluid providers are caller-supplied. Tests prove library logic, not mineflayer control or Minecraft physics.
- **Search, not execution.** `searchLandRoute` returns bounded candidates only. Arrival, movement, digging, placing, towering and material spend are host decisions and host actions.
- **Land and water validators are geometry-only.** They never search a route, move the body, manage a boat, or apply a rescue strategy. Results are marked `assurance: 'geometry_only'` and `executable: false`.
- **Persistence is explicit.** There is no auto-save or background retry; only `checkpoint()` commits. Restored observations are `STALE`, and current passability must be re-established.
- **Perception is host-owned.** The library does not scan the client world, load chunks, or treat raw `blockUpdate` events as evidence. It records only observations the host legally supplies.
- **Containers and inventory remain host-led.** The library associates locations, identities and reachability evidence; it does not copy or maintain item counts.
- **No flight, elytra, or underwater 3D navigation.** These are outside the library's scope.
- **Retired route data is not used.** Existing old tables may still be counted for diagnostics, but they never contribute places, edges, routes or passability to current queries.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
