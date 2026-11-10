# Offline land-search adapter

Uses the repository's actual `searchLandRoute` and `VoxelMap.restoreSnapshot`, inside a disposable Web Worker. No database is opened or written here. Original saved observation metadata is passed through unchanged. Missing cells are unknown; cells missing original snapshot metadata are skipped and counted.

`strict` applies the library's normal restored-evidence semantics: imported observations are stale and belong to previous sessions. They cannot establish current traversability. `remembered` explicitly assumes saved geometry still applies, using the library's historical geometry evaluator without refreshing or rewriting observations. Neither mode asserts physical arrival.

Supports cardinal walking, the library's lift-then-translate step corridor (up to one block), and drops up to the selected 0–4 blocks. Body dimensions are 0.6 × 1.8. No swimming, horizontal gap jumping, ladders, digging, placing or portal transitions are advertised. The dry-land policy rejects fluid-contact edges; shapes exceeding the core's cell-local contract (such as fences) return unsupported.

The first 6,000 actual A* expansion events are retained in order for process replay; total expansions remain available in `route.stats.nodesExpanded`. This is a replay after worker computation, not a fabricated progressive search. Search is bounded to 20,000 nodes, 100,000 edges, 400,000 surface reads and 1,500 ms, with a separate measured region reconstruction phase. A region may contain at most 300,000 cells / 1,200 sections.

## Collision data

`collision-data.json` is generated from **minecraft-data 3.117.0**, specifically its **Java 1.20.1** blockstate definitions and collision shapes. Package metadata declares **MIT**. Upstream: https://github.com/PrismarineJS/node-minecraft-data and its data repository https://github.com/PrismarineJS/minecraft-data.

License references: the [3.117.0 package metadata](https://raw.githubusercontent.com/PrismarineJS/node-minecraft-data/3.117.0/package.json) declares MIT and lists Romain Beaumont as author; the underlying [minecraft-data README license section](https://github.com/PrismarineJS/minecraft-data/blob/master/README.md#license) also specifies MIT. Neither repository publishes a root LICENSE file, so no copyright year or alternative license text is invented here.

Regenerate using an installed minecraft-data package:

```sh
node demo/voxel-atlas/src/pathfinding/generate-collision-data.mjs /path/to/consumer/package.json
```

The package.json argument only locates the installed dependency; no consumer source is imported. Runtime builds consume only the generated table. Properties are matched exactly and use the source data's state ordering, including boolean `true,false`. Slabs, stairs and doors use their complete state-specific boxes. Missing/extra/invalid properties and unknown shapes return unsupported instead of defaulting to full cubes or air.
