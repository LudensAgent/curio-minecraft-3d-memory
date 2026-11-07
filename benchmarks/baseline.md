# M8.1 baseline and comparison thresholds

Baseline snapshot for plan §M8.1. This file records **measured data and
comparison thresholds only**. It is not an acceptance result: the thresholds
below are comparison targets for M8.2+ before/after work, not a pass/fail gate.

## Environment

| item | value |
|---|---|
| repository | `curio-minecraft-3d-memory` |
| base commit / branch | `21a2f76` on `integration/memory-host-20261107`, worktree branch `wf/L-M8-1` |
| date / time | 2026-11-07, ~20:08–21:00 local (UTC+08:00) = 2026-11-07T12:08Z–13:00Z |
| OS | Windows 11 Pro 10.0.22631, MINGW64 (Git Bash) |
| CPU | Intel Core i9-14900KF (32 logical processors) |
| Node.js / npm / tsx | v24.14.1 / 10.9.0 / 4.23.15 |
| Bun | not installed; all benchmarks run with `tsx` under Node |
| SQLite driver | `better-sqlite3` from `node_modules` (devDependency) |

**Recorded passes: two full passes of all six files on the final scripts.**
Both passes built the same `scale` column for every scenario (verified by
comparing the tables), so the fixture is reproducible in this environment.
Earlier exploratory passes ran against draft scripts and are **discarded** —
none of their numbers appears below. Wall-clock varies pass to pass; the worst
observed p95 across the two recorded passes drives the targets.

## Commands

From the worktree root (`D:/Repos/curio-minecraft-3d-memory/.claude/worktrees/L-M8-1`):

```bash
npm run build   # only checkpoint.bench.ts imports dist/storage/sqlite/index.js

npx tsx benchmarks/walk-search.bench.ts
npx tsx benchmarks/route-plan.bench.ts
npx tsx benchmarks/route-execution.bench.ts
npx tsx benchmarks/checkpoint.bench.ts
npx tsx benchmarks/fragmentation.bench.ts
npx tsx benchmarks/paging-query.bench.ts
```

Each prints one markdown table to stdout (redirect to a log to keep a pass).
Every row is the median of 5 timed rounds after one discarded warm-up round;
min and p95 of those rounds are in the same table.

## Actual scale

Requested (§M8.1) vs the scale the scripts actually build. Each benchmark also
prints its live scale in the table's `scale` column.

| class | requested | built (measured) |
|---|---|---|
| walk search | 10 000 Sections, 1024-point route | **10 000 sparse Sections + 1024-cell corridor = 10 128 resident Sections**; route **1024 points / 1023 edges** (search `edgesEvaluated=3068`); `evaluatedSections=134` (the route plus support Sections; the 128-Section control map gives the same 134) |
| route plan | 1024-point route | 1024-point route over 128 corridor Sections; history plan over a recorded 1024-point fragment; `maxRoutePoints=1024` |
| route execution | 1024-point route | **1024 points / 1023 steps** over the same corridor; scripted fake body |
| checkpoint (history) | 20 000 nodes/edges, 1000 fragments | **20 000 nodes, 20 000 edges, 1000 fragments, 20 000 traversals** (every edge evidence-backed) |
| checkpoint (voxel) | 10 000 Sections | **10 000 Sections**, 10 000 observed cells (1 per Section) |
| fragmentation | 1000 fragments | **1000 fragments, 20 000 traversal links**; union-find found 9 869 points / 1 250 components |
| paging query | 20 000 nodes/edges, 1000 fragments | **20 000 nodes, 20 000 edges, 1000 fragments, 20 000 traversals** |

Honest limits:

- **The 10 000 sparse Sections are constructed and resident but are not
  evaluated by the corridor search.** They are single-observed-cell Sections
  in a 100×100 Section grid at `z >= 1600`; the searched corridor is at
  `z = 0` and its 1024-point route needs 134 Sections. The `corridor only`
  control (128 Sections, worst p95 59.4 ms) runs the same route at
  essentially the same cost as the 10 128-Section map (worst p95 65.0 ms),
  which isolates the corridor cost from the resident sparse map. A separate
  `sparse region boundary` row starts **beside** the grid's first observed
  stone column (block (0, -1, 1600); support observed, feet above unobserved)
  and targets the neighbouring column: 4 edges are UNKNOWN `unobserved`
  (INSUFFICIENT_EVIDENCE) and 6 Sections are evaluated (the start Section plus
  the unobserved cells' Sections). A start *inside* the stone cell instead
  stops with 4 BLOCKED `collision` edges (self-collision) and 1 evaluated
  Section; that degenerate case is not the reported row.
- Option (a) (a route crossing 10 000 Sections) is not reachable at the
  requested scale: a 1024-point walk route moves one block per step, so it can
  touch at most ~1024/16 = 64 Sections on a line (≤128 including the support
  row). Crossing 10 000 Sections needs a ≥160 000-block route — far beyond
  `maxRoutePoints=1024` and the search `maxNodes`/`maxEdges` budgets. The
  sparse grid also lies outside the corridor's reachable region and holds only
  one observed stone cell per Section. Option (b) is therefore used.
- The 10 000 Sections are **sparse** (one observed cell per Section), not
  10 000 fully observed 16³ Sections. Full observation would be 40.96 M cells
  and ~30 M observations (minutes of setup, hundreds of MB). The live count
  (10 128 incl. the corridor) is what every table reports.
- `FragmentStore`'s default traversal capacity is 10 000. The fragmentation,
  checkpoint and paging fixtures raise it to 20 000 (`maxTraversals`) because
  the requested edge scale needs 20 000 real evidence records.
- `TopologyStore` has two independent 10 000-node quotas (agent/program). The
  fixture splits 20 000 nodes 10 000/10 000 so nothing is evicted and every
  edge endpoint exists.
- Checkpoint scope (verified in `src/storage/sqlite`): there is **no
  voxel-only checkpoint entry point**. `openHistorySession` covers
  history+topology; `openSpatialSession.checkpoint()` covers
  voxel+history+topology. An all-domain session exists, but at the requested
  combined scale it is rejected by the default snapshot byte limit: the
  capability probe prints `rejected capacity: maxBytes exceeds limit 67108864
  (81354186)`. There is therefore **no single timed all-domain "全量" row**;
  the two domain-separated rows are the full first-baseline commits per
  domain. The arithmetic sum of their medians (~418 + ~979 = **~1397 ms**) is
  context only — it is not one transaction and was not measured together.
- Checkpoint "分域" rows: history and voxel are separate sessions over separate
  `mkdtemp` databases. **Both domains' population — including the voxel
  `beginSession` + 10 000-observation `observeBatch` — runs in
  `benchmarkStaged`'s prepare step**, so only `checkpoint()` is inside the
  measured window. The earlier draft timed the voxel replay inside the round;
  its numbers are discarded and are not comparable to these.

## Measured baseline

Values are from the two recorded final passes. `median` is the midpoint of the
two pass medians (a conservative centre, not a single run); `worst p95` is the
larger p95 of the two passes. Memory is the peak RSS (MiB) of one round sampled
over `process.memoryUsage()` — a process-wide high-water estimate that includes
fixture and JIT, not an allocation count. For fast synchronous rounds the
sampler may only see the before/after values; for longer rounds it samples
interim peaks. Every scenario measures memory (none is "未测").

### walk search — `walk-search.bench.ts`

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate 10k Sections + corridor (setup) | 63.6 | 64.1 | 167.5 | 38.9 |
| populate 1024-point corridor, control (setup) | 1.6 | 1.6 | 168.4 | 44.9 |
| search full 1024-edge corridor (10 128 Sections) | 63.2 | 65.0 | 412.4 | 175.6 |
| search maxNodes=64 (frontier path) | 3.1 | 3.4 | 411.8 | 135.8 |
| corridor only (control, 128 Sections) | 57.9 | 59.4 | 451.3 | 231.6 |
| sparse region boundary (start beside grid column) | 0.070 | 0.079 | 409.1 | 132.6 |

Scale rows: full = `sections=10128 sparseSections=10000 corridorCells=1024
routePoints=1024 routeEdges=1023 edgesEvaluated=3068 evaluatedSections=134`;
sparse boundary = `state=INSUFFICIENT_EVIDENCE edgesUnknown=4 evaluatedSections=6`.

### route plan / re-verify — `route-plan.bench.ts`

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate 1024-point corridor (setup) | 5.4 | 5.5 | 64.5 | 18.2 |
| planRoute search backend, 1024 points | 82.2 | 83.7 | 229.8 | 89.1 |
| planRoute history backend, 1024 points | 21.6 | 23.2 | 253.9 | 100.8 |
| RouteVerifier full 1024-point route | 21.1 | 21.6 | 260.8 | 49.3 |

### route execution — `route-execution.bench.ts`

Scripted fake `MoveExecutor`; **not a real server and not mineflayer**.

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate 1024-point corridor (setup) | 5.7 | 6.0 | 64.6 | 18.2 |
| execute 1023 steps of a 1024-point route | 1672.0 | 1689.1 | 214.8 | 97.1 |

### checkpoint — `checkpoint.bench.ts`

Temp `mkdtemp` SQLite per round, removed after close. Population in prepare;
only `checkpoint()` timed.

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate topology fixture (setup) | 588.6 | 603.1 | 204.9 | 93.1 |
| history+topology checkpoint (20k nodes/edges, 1000 frags, 20k traversals) | 418.4 | 426.7 | 710.3 | 406.4 |
| populate 10k Sections (setup) | 60.1 | 63.2 | 714.9 | 406.4 |
| voxel checkpoint (10k Sections) | 978.8 | 1207.1 | 995.9 | 237.2 |

Pre-flight size estimates printed in the `scale` column: topology
`checkpointMeasure()` 22 023 070 B (~21 MiB) and voxel `checkpointMeasure()`
49 000 000 B (~46.7 MiB). These are conservative escaped-byte estimates, not
exact serialized bytes or DB file sizes. Each round only checks that the temp
database file exists and is non-empty (> 0 bytes); the byte size is not printed.

Capability probe output (not a timed row):
`voxel-only checkpoint entry point: none (history-only = openHistorySession;
all-domain = openSpatialSession). combined requested scale (10000 Sections +
20000 nodes / 20000 edges): rejected capacity: maxBytes exceeds limit
67108864 (81354186)`.

### fragmentation — `fragmentation.bench.ts`

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate 1000 fragments + 20k links (setup) | 17.8 | 17.8 | 76.0 | 24.8 |
| fragmentation over 1000 fragments / 20k links | 231.3 | 231.9 | 301.9 | 177.6 |

Scale: `fragments=1000 traversalLinks=20000 points=9869 components=1250`.

### paging / read-only query — `paging-query.bench.ts`

| scenario | median ms | worst p95 ms | worst RSS peak MiB | worst heapUsed peak MiB |
|---|---:|---:|---:|---:|
| populate topology fixture (setup) | 580.7 | 582.5 | 174.4 | 86.3 |
| store page: first page nodes limit=100 | 0.90 | 0.92 | 177.8 | 91.7 |
| store pages: drain all nodes limit=100 | 199.7 | 206.1 | 292.1 | 158.5 |
| store pages: drain all edges limit=100 | 211.6 | 217.1 | 289.8 | 154.6 |
| store pages: drain all fragments limit=100 | 0.400 | 0.445 | 275.2 | 126.8 |
| store pages: drain all traversals limit=100 | 192.5 | 195.9 | 321.2 | 177.0 |
| query nodes limit=1000 (joined pages) | 9.2 | 9.6 | 316.1 | 167.9 |
| query edges limit=1000 (joined pages) | 10.7 | 11.0 | 330.1 | 200.5 |
| query fragments limit=1000 (joined pages) | 0.429 | 0.449 | 274.7 | 126.5 |
| query components (paged full recompute) | 948.2 | 996.1 | 556.1 | 393.9 |
| adjacency highest-degree node (degree 15) | 0.007 | 0.016 | 556.1 | 394.0 |
| nodes listing (dim filter) limit=100 | 1.23 | 1.27 | 559.4 | 399.1 |

## Comparison thresholds for M8.2+

Method: **worst observed p95 across the two recorded passes × 0.85**, rounded
down to two significant digits (sub-millisecond rows rounded to 2 decimals).
That factor is deliberately a target, not a ceiling: most rows moved only
~1-3 % between the two passes, but one row (voxel checkpoint) moved ~1.56×
(1207 vs 773 ms) on the shared machine, so the worst p95 already absorbs the
observed variation and the 0.85 factor sets the improvement bar. These are
comparison **targets**, **not** pass/fail gates: a row at or under its target
is a candidate M8.2+ optimization result, a row above it is a finding to
investigate; neither is acceptance.

| class / scenario | worst observed p95 (ms) | target (ms) |
|---|---:|---:|
| walk search, full 1024-edge corridor | 65.013 | **55** |
| walk search, bounded maxNodes=64 | 3.416 | **2.9** |
| walk search, corridor only control | 59.401 | **50** |
| walk search, sparse region boundary | 0.079 | **0.06** |
| planRoute search backend, 1024 points | 83.666 | **71** |
| planRoute history backend, 1024 points | 23.236 | **19** |
| RouteVerifier full 1024-point route | 21.646 | **18** |
| execute 1023 steps of a 1024-point route | 1689.130 | **1430** |
| history+topology checkpoint | 426.671 | **362** |
| voxel checkpoint (10k Sections) | 1207.102 | **1020** |
| fragmentation (1000 frags / 20k links) | 231.908 | **197** |
| store pages: drain all nodes | 206.069 | **175** |
| store pages: drain all edges | 217.132 | **184** |
| store pages: drain all traversals | 195.877 | **166** |
| store pages: drain all fragments | 0.445 | **0.37** |
| query nodes limit=1000 | 9.627 | **8.1** |
| query edges limit=1000 | 11.041 | **9.3** |
| query fragments limit=1000 | 0.449 | **0.38** |
| query components (paged full recompute) | 996.054 | **846** |
| adjacency (degree 15) | 0.016 | **0.0136** |
| nodes listing (dim filter) limit=100 | 1.265 | **1.0** |

Memory anchors (process-wide RSS peak; not targets — a guard against
accidental blow-ups, set at 1.5× the worst observed peak because the peak also
counts the process and fixture):

| class | worst RSS peak MiB | guard MiB |
|---|---:|---:|
| walk search | 451.3 | **680** |
| route plan | 260.8 | **390** |
| route execution | 214.8 | **325** |
| history checkpoint | 710.3 | **1070** |
| voxel checkpoint | 995.9 | **1495** |
| fragmentation | 301.9 | **455** |
| paging query | 559.4 | **840** |

Setup rows (context, normally not a comparison target; targets use the same
0.85 rule): topology population 603.1 → 512 ms, 10k-Section population
63.2 → 54 ms, corridor population 6.0 → 5.1 ms.

Scope note for M8.2+ comparisons: keep the fixture files and this table frozen
while measuring a change, and compare like for like (same scenario row, similar
machine state). Re-baseline only when the fixture intentionally changes; record
why here.
