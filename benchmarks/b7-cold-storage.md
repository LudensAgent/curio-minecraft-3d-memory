# B7 cold-storage scale acceptance (2026-11-10)

Synthetic library/storage probe, not a Minecraft or host-runtime measurement.

Command:

```sh
node --max-old-space-size=8192 benchmarks/b7-cold-storage-scale.mjs --cells=4000000
```

Environment: Node `v24.14.1`, Windows x64.

Configuration: 4,000,000 distinct observed cells in 977 dense 16×16×16 Sections;
`voxelBatchMaxBytes = 16 MiB`; manual residency with 128 MiB / 64-section resident
bounds; snapshot `maxBytes = 3 GiB`; 16 MiB batch bytes.

Result: `ok: true`.

| Metric | Result |
|---|---|
| Write + save | 50.44 s |
| Checkpoints | 93 |
| Checkpoint total / max | 46.88 s / 853.8 ms |
| Reopen verify | 436 ms |
| Incremental save / restart | 771 ms / 432 ms |
| Peak RSS / heap used | 684.7 MiB / 295.7 MiB |
| Committed payload | 530.1 MiB (531.8 MiB database) |
| Committed sections / cells | 977 / 4,000,000 |

Cold-read assertions:

- Earliest cell `(0,0,0)` read back as `minecraft:stone` with original
  `observedAt=1700000000000`, freshness `STALE`.
- Latest cell `(15,63,216)` read back with original `observedAt=1700003999999`.
- One incremental overwrite at `(0,0,0)` became `minecraft:dirt` with
  `observedAt=1700005000000`; after restart it and older cells are readable.
- Restart evidence is `STALE`, never silently `FRESH`.

This probe proves bounded dirty-batch save/restart at 4M cells and >64 MiB payload.
It does not prove real Minecraft physics, host event-loop/ACK latency, 8-hour
throughput, or a real host session's 4M-cell runtime.

## Limits and caveats

- `voxelBatchMaxBytes` is a soft cap for a single oversized Section: the first dirty
  Section is always included so a batch can make progress. Callers must not assume
  the cap is a hard per-Section bound.
- `snapshotLimits.maxBytes` is the full committed-set quota checked by the worker,
  not a per-batch quota. The measured 4M payload was 505.6–530.1 MiB; the probe
  defaults to 3 GiB for frame/history/state-property headroom. A too-small total
  quota can accept earlier batches and then reject a later one with `capacity`;
  the earlier committed batches stay readable and the remaining dirty is reported.
- `voxelBatchMaxBytes` must not exceed `snapshotLimits.maxBytes`; the library
  rejects that configuration at open instead of silently clamping it.
