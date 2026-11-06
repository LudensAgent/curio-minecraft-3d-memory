# Runtime `SpatialMemoryStore` composition

`SpatialMemoryStoreImpl` (exported from `src/store/index.ts`) is the runtime
composition described in design §9. It binds one immutable `worldId` and wires
three in-memory stores that the caller can inject:

| Part | Role |
|---|---|
| `VoxelMap` | recently observed block state and per-cell evidence |
| `FragmentStore` | historical path geometry and confirmed traversal records |
| `TopologyStore` | explicitly recorded places and directional connections |

Injected parts are optional; when omitted the store constructs
`new VoxelMap(worldId)`, `new FragmentStore(worldId)` and
`new TopologyStore(fragments)`. Every injected part's `worldId` is checked
against the store's `worldId` at construction, and every world-carrying input
is checked again at the method boundary. A mismatch raises
`SpatialMemoryScopeError`; nothing is silently redirected to another world.

The composition is framework-free, performs no I/O, starts no scan, loads no
Section, and keeps no second copy of the facts held by the composed stores.
It is the runtime work set only: a successful `observe`/`saveFragment` does not
mean the data is persisted.

```ts
const store = new SpatialMemoryStoreImpl({
  worldId: 'world-1',
  map: voxelMap,
  fragments: fragmentStore,
  topology: topologyStore,
  // Optional and required only for frontier candidates:
  frontierSource: (dim, here) => walkSearchByDim.get(dim)?.status() ?? null,
});
```

## Method behaviour

### Voxel state

- `observe` / `observeBatch` delegate to `VoxelMap` after checking `worldId` and
  `dim`. `observeBatch` validates the whole batch before any cell is written;
  a rejected batch leaves no partial cells.
- `sectionAt` returns a deep copy of a resident Section, or `null` when the
  Section is not resident / was never allocated. `null` is **not** empty air,
  and an unobserved cell inside a resident Section remains `observed: false` in
  the map.
- `markTraversed` / `markModified` are available only when the injected
  `VoxelMap` actually exposes those methods. This branch does not, so they
  raise `SpatialMemoryUnsupportedError` with the method name instead of
  pretending to record anything. `markModified` also requires a non-empty
  `actionId`; it never infers action attribution.
- Reads never refresh evidence time, change freshness, pin or unpin Sections,
  or advance a revision.

### Historical paths

- `saveFragment` / `forgetFragment` / `fragments` delegate to `FragmentStore`.
  `fragments(dim?)` follows the store's bounded pages and returns all matches as
  fresh copies.
- Deleting a fragment removes its owned traversal records through
  `FragmentStore` semantics. It never affects topology edges as a side effect.

### Topology

- `recordNode` creates an `agent`-source `place` node with an exact location and
  a deterministic, collision-free id (`agent:<slug>[:n]`). `label` is opaque and
  only stored when non-empty. `tag` is stored when supplied.
- `upsertNode` inserts or accepts an idempotent re-delivery. The same id with
  different content throws; it never overwrites a recorded node silently. Use
  `TopologyStore.updateNode` directly for intentional edits.
- `upsertEdge` records the relation accepted by `TopologyStore`. `basis` is used
  when supplied. Evidence ids can only belong to a `traversed` edge, so their
  presence without a basis implies `traversed`; otherwise the edge is a
  `candidate`. A candidate edge is placement of a relation to verify, never
  proof that a traversal happened.
- `dropEdge(from, to)` deletes matching directional edge records only. Fragments
  and traversal evidence remain; a later observation can re-establish the edge.
- `graph(dim)` returns recorded nodes plus a lossy `SpatialEdge` projection (see
  “Known truth gaps”). `edgesDetailed(dim)` returns the `TopologyStore`
  `EdgeView` records, including `basis` and per-evidence resolution, which is the
  truthful detail read.
- `portalEdges` delegates to the separate portal graph in `TopologyStore`. Portal
  edges never mix into `graph()`/`route()`/adjacency; each keeps its raw
  outbound/return traversal evidence, and `returnVerified` is derived on read.

### Routing and anchors (historical geometry only)

These methods answer “what was recorded”, not “what can I walk now”. Results
never start movement and carry no current-passability claim.

- `route(dim, from, to, { near })` snaps each endpoint to the nearest recorded
  exact node within `near` (default 5) and runs `TopologyStore.route`, which
  follows only `traversed` edges whose evidence still resolves. It returns the
  ordered recorded node positions, or `null`. A bounded search that hit evidence
  gaps or exhausted its budget is also `null` here.
- `routeInspection` returns the detailed outcome: `FOUND`,
  `NO_RECORDED_ROUTE`, `INSUFFICIENT_EVIDENCE`, `BUDGET_EXHAUSTED`, or the
  composition-specific `ENDPOINT_NOT_RECORDED`, plus the message, gaps, stats,
  diagnostics, and the literal flags `historicalGeometry: true`,
  `executable: false`, `currentPassability: 'UNKNOWN'`.
- `route`'s legacy `hop`/`link` options select geometric polyline inference,
  which this composition does not perform. Passing either raises
  `SpatialMemoryUnsupportedError` rather than silently ignoring it.
- `surfaceAnchor` returns the highest reachable recorded exact node by `y`;
  `deepestAnchor` returns the lowest. Both require a recorded node within
  `near` of `here` (default 6). `deepestAnchor` returns `null` when `here` is
  absent or too far from the network: there is no whole-network fallback,
  because that fallback did not establish connection evidence. Neither method
  proves a surface opening or current reachability.
- `fragmentation(dim)` is geometric, computed over `FragmentStore` polylines.
  It uses recorded `links` when present and consecutive-polyline inference
  otherwise, plus cross-record proximity (legacy thresholds
  `FRAGMENTATION_LINK_DISTANCE = 3.5`, `FRAGMENTATION_HOP_DISTANCE = 7`).
  It counts connected components; it does not prove current passability or
  merge fragments or edges.

### Frontier candidates

`frontierCandidates(dim, here)` requires an injected `frontierSource` — a pure
function returning an already-computed `WalkSearchSnapshot` (or `null`). The
store does not run a walk search, read the map, or start exploration.

- At least one candidate is projected from the snapshot's bounded `frontiers`
  via `frontierCandidates` in `src/navigation/route-inspection.ts`.
- `reachability: 'OPEN'` refers to the validated stance next to the boundary,
  never to `pos` or the gap beyond it.
- The `Frontier` interface has only a boolean `historicalConnection`.
  `frontierInspection` preserves the view's explicit `'unknown'`; the
  `Frontier[]` projection reports `false`, which means “not established” and
  never “disproved”.
- Without a provider, or when the provider returns `null` for that dim/here,
  `frontierCandidates` raises `SpatialMemoryUnsupportedError` and
  `frontierInspection` returns `{ status: 'unavailable', reason }`. Neither is
  ever an empty result that could be read as “no frontier exists”.
- A snapshot whose `worldId`/`dim` does not match the request raises
  `SpatialMemoryScopeError`, never a cross-world read.
- `inspectRoute(snapshot)` is a read-only wrapper of the navigation layer's
  `inspectRoute`; it reports `arrivalConfirmed: false` and
  `executionStarted: false` by construction.

### Capability and runtime snapshot

`describeCapabilities()` returns one entry per `SpatialMemoryStore` method:

```ts
{ available: boolean; reason?: string }
```

`reason` explains why a method is unavailable, or states the limitation of an
available method. `snapshot()` returns read-only counts and revisions:

```ts
{
  worldId,
  voxel: { saveRevision, residentSections, residentBytes, pinLeases, pinnedSections },
  fragments: { revision, total },
  topology: { revision, nodes, edges },
  capabilities,
}
```

Counts and revisions are runtime state, not persistence confirmation; a higher
`saveRevision` does not mean the data is on disk.

### Read-only query port

`query(request)` is the contract §5 projection over the same composed stores.
It is synchronous and read-only: it never moves, turns, scans the world, loads
a Section, refreshes evidence, saves, pins, or executes. Results carry
`contract: 'memory-host-contract/1'`, `worldId`, the active observation session
(when one exists), `computedAt`, `readOnly: true` and `executable: false`.

- `cells` reads `VoxelMap.cellAt` plus section residency. `observed: false`
  never means air; `no_record`/resident-but-unobserved return no gap, while
  `not_resident`/`loading`/`load_failed` return `gap.reason: 'unloaded'` and
  `status: 'partial'`. Historical `ObservationGap`s are not persisted, so the
  projection can only report current residency gaps.
- List kinds (`fragments`, `traversals`, `nodes`, `edges`, `portals`,
  `resourceAnchors`, `containerAnchors`) default to 100 items, accept
  `1..1000`, use a stable exclusive `after` cursor, and return the true match
  `total`. The query layer joins store pages when the requested limit exceeds
  the store's `maxQueryBatch`; it does not silently truncate.
- `historyRoute`/`anchor`/`components`/`segments` are historical projections.
  They are never executable and never prove current passability. An unknown
  `segments.fragmentId` returns `not_found`, not an empty segment list.
- `containerAnchors` requires a host-injected `isContainer` classifier; without
  it the query is `unsupported` and the capability is `false`. It pages through
  the node store (bounded by the store's node capacity) so the exclusive cursor
  and `total` stay correct; only exact node locations are returned.
  `containerContents` always returns a structured `host_ledger` problem and
  never an empty list: inventory belongs to the host ledger.
- The capability query reports the same nested booleans as
  `MemoryHostCapabilities` (contract §2.3); domains not implemented at this
  milestone stay `false`.

## Read-only guarantee

`sectionAt`, `fragments`, `graph`, `edgesDetailed`, `route`, `routeInspection`,
`surfaceAnchor`, `deepestAnchor`, `fragmentation`, `frontierCandidates`,
`frontierInspection`, `inspectRoute`, `query`, `describeCapabilities` and
`snapshot` are read-only with respect to the composed stores. The test suite captures the
voxel `saveRevision`, pin state and residency, fragment/topology revisions,
cell evidence and anchor results before and after all of them and requires an
exact match.

## Known truth gaps requiring a later interface change

These are gaps between the `SpatialMemoryStore` interface / `SpatialEdge`
design type and the current `TopologyStore` model. They are surfaced, not
papered over.

1. **`markTraversed` / `markModified` are not on `VoxelMap` in this branch.**
   The facade detects them at runtime. When a later `VoxelMap` build adds them,
   the same facade forwards to them without another interface change; until
   then the methods are explicitly unsupported.
2. **`SpatialEdge` cannot be stored faithfully.** `TopologyStore` keeps
   `id/from/to/type/basis/evidenceIds`, not `directed/modes/verifications`.
   `graph()` projects `directed: true` (each record supports `from → to` only;
   no reverse relation is implied) and returns `modes: []` /
   `verifications: []`. Empty means “not represented in this composition”, not
   “unsupported”. Callers who need current verification must read
   `edgesDetailed` and apply their own delegation context. A future interface
   should either extend the topology edge model or split `SpatialEdge` into an
   input/presentation type.
3. **Evidence-backed edges need an extension field.** Adding `basis` /
   `evidenceIds` to `SpatialEdge` (or changing `upsertEdge` to accept
   `TopologyEdge`) would let the interface express a traversed edge directly.
   Today `SpatialEdgeRecord` accepts those optional fields, but
   `SpatialMemoryStore.upsertEdge` does not declare them.
4. **Portal edges are separate from the walk graph.** `portalEdges()` returns
   only the portal graph; walk routing never sees those edges. The checkpoint
   persists portal edges and evidence-backed fragment merges in the low-frequency
   `topology_extras` checkpoint column.
5. **`Frontier.historicalConnection: boolean` cannot express unknown**, and
   `frontierCandidates` cannot express `unavailable` in its `Frontier[]` return
   type. Use `frontierInspection` for the explicit form. A future interface
   should use a tri-state and a discriminated availability result.
6. **Endpoint-addressed methods have no `dim`.** `forgetFragment(id)` and
   `dropEdge(from, to)` cannot take a dimension under the current signatures;
   they rely on the composed stores' single-world, id/nodes-addressed scope.
   `graph(dim)` and all coordinate queries do take an explicit dimension.
7. **Not yet re-exported from `src/index.ts`.** This work package only owns
   `src/store/**`; the package root entry must re-export the class and its
   types when the store interface is integrated with the rest of the public
   surface.

## Boundaries

This store is a fact provider. It does not choose destinations, plan routes,
scan for frontiers, retry, rescue, dig, place, or persist. Historical results
are not executable routes; unknown and stale evidence are never treated as
`OPEN`; and no query rewrites the observation times of the evidence it reads.
