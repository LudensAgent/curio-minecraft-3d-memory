# M8.1 benchmarks

Wall-clock and (best-effort) memory baselines for the plan §M8.1 scales:
10 000 Sections, 20 000 nodes/edges, 1000 fragments, 1024-point routes.
The measured data and the thresholds derived from it live in
[`baseline.md`](./baseline.md). This directory does only measurement — no
`src/*` optimization is part of M8.1.

## Running

No `package.json` script is added on purpose. From the repository root:

```bash
npx tsx benchmarks/walk-search.bench.ts
npx tsx benchmarks/route-plan.bench.ts
npx tsx benchmarks/route-execution.bench.ts
npx tsx benchmarks/checkpoint.bench.ts
npx tsx benchmarks/fragmentation.bench.ts
npx tsx benchmarks/paging-query.bench.ts
```

- `tsx` runs the `.ts` files directly with Node (type-checking is a separate
  step, the runtime ignores types). `node --import tsx <file>` works the same.
- `benchmarks/*.ts` is **not** in `tsconfig.json`'s `include` (`src`, `tests`),
  so `npm run typecheck` does not cover it. Type-check it explicitly with the
  same strict flags:

  ```bash
  npx tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
    --noFallthroughCasesInSwitch --verbatimModuleSyntax --isolatedModules \
    --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022 \
    --types node --skipLibCheck --esModuleInterop benchmarks/*.ts
  ```

- `checkpoint.bench.ts` imports `dist/storage/sqlite/index.js`, so run
  `npm run build` first (its `pretest`/`pretypecheck` hooks do this, but a
  standalone benchmark run does not).
- Each file prints one markdown table to stdout. Redirect it if you want to
  keep a run (`npx tsx benchmarks/walk-search.bench.ts > run.log 2>&1`).

## Measuring the same thing twice

All fixtures live in [`fixtures.ts`](./fixtures.ts) and are deterministic:
fixed seeded PRNG (`mulberry32`), fixed clock (`NOW = 100 000`), fixed ids and
coordinates, fixed insertion order. Every run on the same machine builds the
same stores, so the `scale` column of every table must be identical across
runs; only the timings and memory numbers move. A scale column that changes is
a fixture bug, not noise.

## What is measured, and what is faked

- Everything is in-memory (`VoxelMap`, `FragmentStore`, `TopologyStore`,
  `SpatialMemoryStoreImpl`). Nothing connects to a Minecraft server, and
  nothing uses mineflayer.
- Collision shapes come from `benchShapeProvider` (`fixtures.ts`), a fake rule
  set: `bench:air` has no boxes, `bench:stone` is a full cube with a full top
  face. It is **not** Minecraft 1.20.1 collision and not prismarine-physics.
- `route-execution.bench.ts` drives `WalkRouteExecutor` with a scripted fake
  `MoveExecutor` whose "body" always lands exactly on the requested point. This
  is a **scripted `WalkBodyPort`-style fake, not a real body**: it measures the
  executor + verifier loop, not physics, network or world I/O.
- `checkpoint.bench.ts` uses the real SQLite persistence worker, but only on
  `mkdtemp` databases under the OS temp directory. Every round closes its
  session and removes its directory (Windows WAL/SHM locks get 10 retries at
  50 ms). It never touches a user database.
- Wall time is the median of 5 rounds after one discarded warm-up round; min
  and p95 are also printed. Setup (populating stores) is timed once and printed
  as its own row so it is not hidden inside the measured operation.
  `checkpoint.bench.ts` is stricter: both domains' population (including the
  voxel `beginSession` + 10 000-observation batch) runs in `benchmarkStaged`'s
  **prepare** step, so only `checkpoint()` is inside the measured window.
- Memory is the peak `process.memoryUsage()` (RSS and heapUsed) sampled by a
  5 ms timer during a round. For fast synchronous rounds the timer may not run
  at all, so the reported peak degrades to the max of the before/after samples;
  for longer rounds it samples real interim peaks. It is a process-wide
  high-water estimate that also includes the JIT and the fixture, not an
  allocation count. Every scenario measures memory.

## Scale construction (what the numbers mean)

| file | scale built | how |
|---|---|---|
| `walk-search` | 10 000 sparse Sections + 1024-cell corridor (10 128 resident Sections), route 1024 points / 1023 edges (3068 edges evaluated); plus a control map with only the corridor (128 Sections) and a start-beside-the-sparse-grid-column boundary scenario | one observed stone cell per Section in a 100×100 Section-index grid (`sy = -1`), plus a floor corridor whose route is 1024 points. The sparse Sections are resident but **not evaluated** by the corridor search; `evaluatedSections` in the table reports the Sections the route/diagnostics actually need |
| `route-plan` | 1 024 points / 128 corridor Sections + 1 recorded 1 024-point fragment | `planRoute` search backend, history backend, and a direct full `RouteVerifier` pass |
| `route-execution` | 1 024-point route, 1 023 steps | `WalkRouteExecutor` + scripted fake `MoveExecutor` |
| `checkpoint` | history: 20 000 nodes / 20 000 edges / 1000 fragments / 20 000 traversals; voxel: 10 000 Sections | history and voxel are separate sessions over separate temp DBs |
| `fragmentation` | 1000 fragments, 20 000 traversal links | `FragmentStore` (default 1000-fragment cap) with `maxTraversals: 20 000` (default cap is 10 000) |
| `paging-query` | 20 000 nodes / 20 000 edges / 1000 fragments / 20 000 traversals | store pages at clamp 100, query port at limit 1000, `components`, `adjacency` |

The 10 000-Section target is not built as 10 000 *fully observed* Sections:
that would be 40.96 M cells and 30 M observations (minutes of setup, hundreds
of MB), while these benchmarks only need Section *count* for residency and
lookup costs. The sparse construction (Section count = 10 000, one observed
cell per Section, plus the local corridor) is the honest proxy; `baseline.md`
records the exact live counts, not the requested ones.

## Known noise

- Baseline data is reproducible in structure (same scale column, same shape of
  results) but not bit-identical in time: repeated recorded runs in
  `baseline.md` differ by up to ~2× on the worst row (`query components`). Take
  the p95 observed across runs as the comparison anchor, not a single median.
- The vault is not quiet: other agents share this machine. Run benchmarks on an
  otherwise idle machine when comparing to the thresholds.
- The first round of a fresh file pays type-erased module loading and JIT; the
  warm-up round absorbs most of it, not all.
