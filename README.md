# Spatial Memory Library

Spatial facts, historical geometry, traversability verification, and composable navigation helpers for a Minecraft Java 1.20.1 agent — scoped to **land walking** and **surface-water movement** (jumping, steps, ladders, drop transitions, surface swimming, boating, and shore in/out).

> 中文说明见 [README_ZH.md](README_ZH.md).

## Overview

- **Facts and execution assistance only.** Answers *what was last observed here, how it was traversed before, whether current evidence supports passage, and which segment needs re-verification*. Goals, strategy, resource spend, and risk trade-offs remain the agent's decision.
- **Three-layer data separation.** Historical geometry (never deleted on blockage), recent observation state (versioned, evidence-backed), derived traversability (invalidation-friendly cache).
- **No host coupling.** Consumes mineflayer/Curio perception and execution through a `WorldAdapter` abstraction; never imports host source.

See [`docs/spatial-memory-library-design.md`](docs/spatial-memory-library-design.md) and [`AGENTS.md`](AGENTS.md) for the design rationale and development constraints. Interfaces in the design doc are **target contracts**; this repository lands behavior per design §10.

### Implemented so far

- **Voxel map** (`voxel/`): sparse, versioned observation state with per-cell evidence, session/interruption handling and localized `ChangeReport`s.
- **Traversability** (`traversability/`): read-only single-step walk evaluation, an invalidation-friendly cache, and bounded route verification over an ordered point list.
- **Controlled walk-route execution** (`execution/`): `WalkRouteExecutor` connects a verified route to an injectable single-step `MoveExecutor` with measured body feedback. It only executes the caller's ordered points (same height, ±1 along X/Z), never starts a step without current OPEN evidence, requires a measured `exact` position for `ARRIVED`, and revokes an in-flight segment when its evidence changes.
- **Historical path store** (`topology/`, phase 4A): `FragmentStore` keeps historical path geometry (`PathFragment`) and confirmed traversal evidence (`TraversalEvidence`) strictly separated from current world state — with idempotent writes, explicit update, delete, paginated reads, capacity limits, and snapshot isolation.
- **Topology facts store** (`topology/`, phase 4B): `TopologyStore` records explicit spatial nodes and directional connections (`candidate` vs evidence-backed `traversed`), keeps per-edge evidence references, and reports whether those references still resolve — never whether the path is currently passable.

These are validated **in-memory with a Fake executor** (see `tests/walk-route-executor.test.ts` and the runnable `examples/walk-route-execution.ts`). They do **not** yet wire a real mineflayer/Curio body, pathfinding, or SQLite persistence.

## Historical path store

`FragmentStore` is the phase 4A in-memory layer for historical path facts. It is bound to one immutable `worldId`; every record carries its own `dim`, so records in different worlds or dimensions are never merged by coincidental coordinates.

```ts
import { FragmentStore } from 'curio-minecraft-3d-memory';

const store = new FragmentStore('world');

// Historical geometry — saving it never proves a traversal or that it is passable now.
store.saveFragment({
  id: 'frag-1', worldId: 'world', dim: 'overworld', kind: 'walked',
  entrances: [{ x: 0.5, y: 64, z: 0.5 }],
  polyline: [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }],
  geometrySource: 'traversal', deepestY: 12,
  createdAt: 1000, lastUsedAt: 1000, uses: 1,
});

// Confirmed traversal evidence — explicit, directional (A→B ≠ B→A).
store.addTraversal({
  id: 'ev-1', fragmentId: 'frag-1',
  from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.5, y: 64, z: 0.5 },
  worldId: 'world', dim: 'overworld', sessionId: 's1',
  observedAt: 1000, source: 'confirmed_walk',
});

store.fragments({ dim: 'overworld' });   // paginated, id-ordered, read-only snapshots
store.traversals({ fragmentId: 'frag-1' });
```

Behavior:

- **Writes.** `saveFragment` / `addTraversal` insert, or return `unchanged` on an idempotent re-delivery of identical content; the same id with different content is a conflict and throws. `updateFragment(id, changes)` is the explicit update path — it never resets `createdAt`/identity or `uses`/`lastUsedAt` unless the caller supplies them.
- **Reads.** `getFragment`, `fragments`, and `traversals` return deep-copied snapshots and never mutate time, `uses`, or content. Pagination is by ascending `id` with an exclusive `after` cursor and a `limit` clamped to `maxQueryBatch`; `total` counts all matches.
- **Delete.** `forgetFragment(id)` removes the fragment and its own traversal evidence, leaving other fragments untouched; deleting an unknown id is a stable no-op.
- **Capacity.** `maxFragments`, `maxPolylinePoints`, `maxEntrances`, `maxLinks`, `maxTraversals`, and `maxQueryBatch` are configurable; exceeding them throws a clear error (no silent drop, no auto-eviction), and a failed write leaves prior state intact.

History is strictly separated from current state: the store never touches `VoxelMap`, never produces a current `OPEN`, and blockage/staleness elsewhere never deletes recorded history. See [`docs/phase-4a-history-facts-acceptance.md`](docs/phase-4a-history-facts-acceptance.md).

## Topology facts store

`TopologyStore` (phase 4B) records the *explicit* topology the caller submits, and keeps it separate from both historical geometry and current traversability. It is bound to one immutable `worldId` and reads evidence through a narrow read-only interface satisfied directly by `FragmentStore`.

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);

// Nodes (existing SpatialNode shape).
topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } } });
topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 1.5, y: 64, z: 0.5 } } });

// A candidate edge: an explicit "to-verify" relation, not a traversed fact.
topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'candidate', source: 'manual', evidenceIds: [] });

// A traversed edge: backed by a concrete A→B traversal record.
topology.saveEdge({ id: 'e-ab2', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'traversed', evidenceIds: ['ev-1'] });
```

Behavior:

- **Directed.** A→B and B→A are independent records; saving A→B never generates B→A.
- **Two bases.** `candidate` is a pending relation (no evidence); `traversed` requires matching `TraversalEvidence` whose `from`/`to` equal the edge endpoints exactly.
- **Reference resolution.** Each traversed edge is re-resolved against the history on read: `resolved` / `missing` / `mismatch`. Deleting a source fragment leaves the edge record and reports `missing` — it is never translated into a current `BLOCKED`.
- **Guards.** A node referenced by an edge cannot change `location` or be deleted; removing the edge first is required. Deleting an edge never deletes fragments or evidence.
- **Capacity.** Separate `agent`/`program` node quotas plus edge/evidence-ref/query limits; overflow is an explicit error, never silent eviction.

Only same-world, same-dimension, exact-endpoint, non-`PORTAL` connections are supported; region nodes can be stored and queried but not used as edge endpoints. See [`docs/phase-4b-topology-facts-acceptance.md`](docs/phase-4b-topology-facts-acceptance.md).

## Project structure

```
src/
├── index.ts            # public API entry (minimal, explicit export surface)
├── constants.ts        # single-source config constants (section size, PASSAGE_LINK, …)
├── types.ts            # base primitives (Vec3Like / BlockState / WorldScope / MoveMode)
├── observation/        # World Observer: Observation / evidence / freshness (§3.2)
├── voxel/              # Spatial Mapper: Section / Palette / bit-packing (§4)
├── traversability/     # derived traversability: Traversability / HazardFact (§3.3)
├── topology/           # Topology Manager: path fragments / nodes / edges (§3.1, §5)
├── adapter/            # WorldAdapter target surface (§2.1)
├── navigation/         # L2 navigation primitives and result envelope (§7)
├── execution/          # controlled walk-route execution loop (§7 first step, phase 3)
├── store/              # SpatialMemoryStore runtime interface (§9)
├── storage/            # SQLite persistence and worker (§9, phase 5)
└── compat/             # legacy WorldMemory entry compatibility layer (§8, §9.1)

examples/
├── walk-route-execution.ts   # runnable Fake demo of the execution loop
├── fragment-store-history.ts # runnable Fake demo of historical facts vs current blockage
└── topology-facts.ts         # runnable Fake demo of explicit topology facts vs current blockage
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/ (NodeNext ESM + type declarations)
npx tsx examples/walk-route-execution.ts    # run the Fake execution demo
npx tsx examples/fragment-store-history.ts  # run the Fake historical-facts demo
npx tsx examples/topology-facts.ts          # run the Fake explicit-topology demo
```

> `examples/fragment-store-history.ts` and `examples/topology-facts.ts` import the built package by its public name (`curio-minecraft-3d-memory`) rather than the source path, so they exercise the package `exports` entry — run `npm run build` first.

> The persistence driver (`better-sqlite3`) is wired in at phase 5 (design §9.2); `storage/` currently holds only the schema contract and worker interface, with no native dependency.

## License

UNLICENSED (private).
