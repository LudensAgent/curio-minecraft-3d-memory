# Benchmarks

Current, runnable measurement tools for the voxel + facts runtime. Historical
result files (`baseline.md`, `m8-*.md`, `b7-cold-storage.md`, `v0.11-first-batch.md`)
are retained as records of the runs they describe; they are not re-run by the
current command list.

## Running

No `package.json` script is added on purpose. From the repository root:

```bash
node benchmarks/observation-ingest.bench.mjs
node --max-old-space-size=8192 benchmarks/b7-cold-storage-scale.mjs --cells=50000
npx tsx benchmarks/checkpoint.bench.ts
npx tsx benchmarks/paging-query.bench.ts
```

- `tsx` runs the `.ts` files directly with Node; type-checking is separate.
- `benchmarks/*.ts` is **not** in `tsconfig.json`'s `include` (`src`, `tests`),
  so `npm run typecheck` does not cover it. Type-check it explicitly with the
  same strict flags if you change it:

  ```bash
  npx tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
    --noFallthroughCasesInSwitch --verbatimModuleSyntax --isolatedModules \
    --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022 \
    --types node --skipLibCheck --esModuleInterop benchmarks/*.ts
  ```

- `checkpoint.bench.ts` imports `dist/storage/sqlite/index.js`, so run
  `npm run build` first.
- Each file prints one markdown table (or structured record) to stdout. Redirect
  it if you want to keep a run.

## What is measured

| file | surface |
|---|---|
| `observation-ingest.bench.mjs` | observation intake and local evidence updates |
| `b7-cold-storage-scale.mjs` | cold storage/working-set scale probe; heavy opt-in runs use larger `--cells` values |
| `checkpoint.bench.ts` | real SQLite worker checkpoint for the voxel domain (10k Sections) and the facts domain (20k places/resources/containers each); populate is unmeasured |
| `paging-query.bench.ts` | bounded facts paging (`places`, `nodes`, `resourceAnchors`, `containerAnchors`) and a bounded cell query through `createVoxelFactsQueryPort` |

All fixtures live in [`fixtures.ts`](./fixtures.ts) and are deterministic. Fake
shape rules are only used where a search/validation benchmark needs them; they
are not Minecraft 1.20.1 collision or prismarine-physics. Nothing connects to a
Minecraft server or uses mineflayer. `checkpoint.bench.ts` uses the real SQLite
worker only on `mkdtemp` databases and removes each round's directory.

Wall time is the median of 5 rounds after one discarded warm-up round; min and
p95 are also printed. Setup is timed once and printed as its own row. Memory is
the peak `process.memoryUsage()` sampled by a 5 ms timer, a process-wide
high-water estimate rather than an allocation count.

The retired history/topology, fragment, route-plan, walk-search and walk-route
execution benchmarks were removed with their implementations. Their historical
result markdown remains in this directory only as a record and must not be read
as a description of the current runtime.
