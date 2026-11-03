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
- **Bounded historical graph queries** (`topology/`, phase 4C): `TopologyStore` adds bounded, read-only `adjacency`, `reachable`, and `route` queries over the recorded topology — finite work budgets, mode filtering, lightweight history reads, and precise `FOUND` / `NO_RECORDED_ROUTE` / `INSUFFICIENT_EVIDENCE` / `BUDGET_EXHAUSTED` results — still never a current-traversability or executable-route claim.
- **Bounded historical anchor queries** (`topology/`, phase 4D): `TopologyStore.historicalAnchorCandidates` finds the recorded, evidence-resolved anchors reachable from a node (filtered by source/tag/kind, sorted by `bfs`/`highest`/`deepest`, limited), with shared proof segments — never a current-passability, target-selection, or executable-route claim.
- **Explicit history checkpoint persistence** (`storage/`, phase 5A): `openHistorySession` from the `curio-minecraft-3d-memory/storage/sqlite` subpath persists the four historical facts (`PathFragment`, `TraversalEvidence`, `SpatialNode`, topology edges with their original binding snapshots) through a single SQLite worker. `checkpoint()` is the only explicit save trigger; `flush()`/`close()` never implicitly save new memory changes. See `docs/phase-5a-history-checkpoint-acceptance.md`.

The in-memory layers are validated **with a Fake executor** (see `tests/walk-route-executor.test.ts` and the runnable `examples/walk-route-execution.ts`); the checkpoint layer is validated against **real SQLite + a real worker** (see `tests/storage-checkpoint.test.ts` and `examples/history-checkpoint.ts`). They do **not** yet wire a real mineflayer/Curio body or pathfinding.

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

## Bounded historical graph queries

`TopologyStore` (phase 4C) answers three bounded, read-only, synchronous queries over the *recorded* history graph — never whether the world is currently passable or how to walk it:

- **`adjacency(nodeId, options?)`** — the recorded in-edges and out-edges of a node, from the incident index in insertion order. The returned edges are plain `TopologyEdge` snapshots and are *not* reference-resolved here.
- **`reachable(fromNodeId, options?)`** — the confirmed reachable node ids (including the start at depth 0), by walking only `traversed` out-edges whose evidence fully resolves and whose mode passes the filter.
- **`route(fromNodeId, toNodeId, options?)`** — one fewest-edges directed historical connection sequence, with per-segment witness evidence, or a precise reason it could not.

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);
// … save nodes a/b/c, save traversed edges e-ab (a→b) and e-bc (b→c) …

const r = topology.route('a', 'c', { mode: 'walk' });
if (r.status === 'FOUND') {
  r.nodeIds;   // ['a', 'b', 'c']
  r.edgeIds;   // ['e-ab', 'e-bc']
  r.segments;  // [{ edgeId: 'e-ab', evidenceId: 'ev-ab', evidence: … }, …]
}
```

Behavior:

- **Endpoints.** Reachability/route accept only existing, `exact`, same-world, same-dimension nodes. Missing nodes, region endpoints, and cross-dimension requests fail explicitly (never silently replaced).
- **Edges that count.** Only `basis: 'traversed'` edges whose every reference resolves (`resolved`) participate; `candidate` / `missing` / `mismatch` edges are excluded (and reported as gaps). Direction is strictly `from → to`.
- **Mode.** An optional `mode` filter requires a matching explicit evidence mode; unknown-mode evidence yields a `mode_unknown` gap, while known-but-unmatched modes are a normal filter. Without a filter, the adopted evidence's real mode is preserved (unknown stays unknown).
- **Budgets.** `maxNodes` / `maxEdges` / `maxHistoryReads` / `maxDiagnostics` are finite, clamped to store ceilings, and zero is honored literally. Budget exhaustion is reported as `BUDGET_EXHAUSTED`, never confused with `NO_RECORDED_ROUTE`.
- **Results.** `FOUND` / `NO_RECORDED_ROUTE` / `INSUFFICIENT_EVIDENCE` / `BUDGET_EXHAUSTED` have precise meanings; diagnostics are bounded and truncation never loses the gap classification.

These queries return historical facts and never produce a current `OPEN`, a body-arrival claim, or an executable point list. See [`docs/phase-4c-historical-topology-query-acceptance.md`](docs/phase-4c-historical-topology-query-acceptance.md).

## Bounded historical anchor queries

`TopologyStore.historicalAnchorCandidates(fromNodeId, options?)` (phase 4D) answers "from this known node, which recorded anchors are reachable over evidence-resolved, mode-matching `traversed` edges — and which is highest/deepest?".

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);
// … save nodes and traversed edges …

const r = topology.historicalAnchorCandidates('a', { tag: 'resource', order: 'highest', limit: 1 });
r.items;          // [{ node: SpatialNode, hops: 3 }]
r.matchedCount;   // candidates before limit
r.proofSegments;  // union of predecessor paths to the returned candidates
r.disposition;    // 'complete' | 'evidence_gaps' | 'budget_exhausted'
```

Behavior:

- **Endpoints.** The start must be an existing, `exact` node. Region endpoints and missing nodes fail explicitly; `maxNodes: 0` returns no unvalidated start.
- **Filters.** `source` / `tag` / `kind` are AND-combined and only filter the returned candidates — never the traversal. A node with no tag never matches a specified `tag`; a non-matching intermediate node is still traversed.
- **Ordering.** `bfs` (discovery order), `highest` (descending `pos.y`), `deepest` (ascending `pos.y`); height ties keep BFS order. Height comes only from the node's exact `pos.y`, never from fragment `deepestY` or connection type.
- **Completeness.** `matchedCount` counts candidates before `limit`; `resultsTruncated` only means the limit cut the list; `disposition` reports whether the search finished. An empty `items` is not by itself "no candidates".
- **Proof.** `proofSegments` is the deduplicated union of BFS predecessor paths to the returned candidates, ordered predecessor-first, with the witness evidence per segment.

`highest`/`deepest` never claim a surface or a cave floor, and the query never proves current passability or selects an action target. See [`docs/phase-4d-historical-anchor-query-acceptance.md`](docs/phase-4d-historical-anchor-query-acceptance.md).

## History checkpoint persistence

`openHistorySession` (phase 5A, `curio-minecraft-3d-memory/storage/sqlite` subpath) persists the four historical facts through one SQLite worker. Callers keep using the in-memory `FragmentStore` / `TopologyStore` exactly as before; `checkpoint()` is the *only* explicit save trigger.

```ts
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openHistorySession({ databasePath, worldId: 'world' });

session.history.saveFragment({ /* … */ });
session.topology.saveNode({ /* … */ });
await session.checkpoint();   // capture + commit the full history in one transaction
await session.close();        // stop accepting writes, shut the worker down within a bound

const reopened = await openHistorySession({ databasePath, worldId: 'world' });
reopened.history.fragments(); // committed state restored
```

Behavior:

- **Explicit save.** Memory writes are queryable immediately; only `checkpoint()` persists them. There is no auto-save, incremental log, or background retry.
- **Bounded, atomic.** One checkpoint replaces the world's four facts in a single transaction with hard, documented capacity limits (`SnapshotLimits`); over-capacity saves are rejected before any copy, leaving memory and the previous checkpoint intact.
- **Original bindings.** Edges restore with their original evidence binding snapshots — never re-bound through `saveEdge` — so deleted/replaced evidence keeps reporting `missing`/`mismatch`, and insertion order (which 4C/4D queries depend on) is preserved.
- **Lifecycle.** `checkpoint()` rejects `busy`/`closing`/`closed`; `flush()` waits only for an accepted checkpoint; `close()` reports the last confirmed checkpoint, unsaved changes, and unconfirmed requests.
- **Failure semantics.** `PersistenceError` distinguishes capacity/argument rejection, SQL rollback, worker failure, `timeout_unconfirmed` (commit may have landed but was not confirmed), and schema/data validation — never fabricating a save or clearing later dirty state.
- **Isolation.** `worldId` is explicit and isolated per database; an empty checkpoint clears only its own world.

The native driver (`better-sqlite3` `^12`) is an **optional peer dependency**: the core `curio-minecraft-3d-memory` entry loads no native driver and works on Node `>=18`, while the SQLite subpath additionally requires `better-sqlite3` (Node `>=20`). See [`docs/phase-5a-history-checkpoint-acceptance.md`](docs/phase-5a-history-checkpoint-acceptance.md).

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
├── walk-route-execution.ts         # runnable Fake demo of the execution loop
├── fragment-store-history.ts       # runnable Fake demo of historical facts vs current blockage
├── topology-facts.ts               # runnable Fake demo of explicit topology facts vs current blockage
├── historical-topology-query.ts    # runnable Fake demo of bounded historical graph queries
├── historical-anchor-query.ts      # runnable Fake demo of bounded historical anchor queries
└── history-checkpoint.ts           # runnable demo of the SQLite checkpoint lifecycle
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
npx tsx examples/historical-topology-query.ts # run the Fake bounded-query demo
npx tsx examples/historical-anchor-query.ts   # run the Fake bounded-anchor-query demo
npx tsx examples/history-checkpoint.ts        # run the SQLite checkpoint-lifecycle demo
```

> `examples/fragment-store-history.ts`, `examples/topology-facts.ts`, `examples/historical-topology-query.ts`, `examples/historical-anchor-query.ts`, and `examples/history-checkpoint.ts` import the built package by its public name (`curio-minecraft-3d-memory`, with `history-checkpoint.ts` using the `curio-minecraft-3d-memory/storage/sqlite` subpath) rather than the source path, so they exercise the package `exports` entry — run `npm run build` first.

> The persistence entry (`curio-minecraft-3d-memory/storage/sqlite`) uses `better-sqlite3` (an optional peer dependency) inside a single worker thread. The core entry (`curio-minecraft-3d-memory`) has no native dependency and never starts a worker.

## License

UNLICENSED (private).
